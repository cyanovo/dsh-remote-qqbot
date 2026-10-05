/**
 * 「账号」页新增两块（设备码确认 / 我的令牌）的**代码路径**验证：
 * 用无头 DOM 桩把 `public/app.js` 真跑一遍，看它到底发了什么请求、界面上写了什么。
 *
 * ⚠️ 这是**桩**，不是浏览器：证明"点确认会 POST /api/device/approve、服务端原话会显示出来、
 *    新建的明文令牌真的落在输入框里、点吊销会带对 id"，**不证明**排版/颜色/在手机上好看。
 *    浏览器渲染仍然属于"未验证"。
 *
 * 用法：node verify-account-ui.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// APP_JS 只为**反向校验**存在：指向一份故意改坏的 app.js，验收必须变红。
const SRC = fs.readFileSync(process.env.APP_JS || path.join(HERE, 'public', 'app.js'), 'utf8')
const INDEX_HTML = fs.readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8')

let pass = 0
let fail = 0
const check = (name, okk, detail = '') => {
  if (okk) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `　${detail}` : ''}`) }
}

/**
 * 造一个元素。
 *
 * ⚠️ `innerHTML` 特意做成**写入时通知**：真实浏览器里 `card.innerHTML = html`
 *    会把原来的子节点**全部丢弃、按新 HTML 重建**，所以"先注入明文再 render()"
 *    这种顺序错误在浏览器里就是"明文一闪而过甚至根本没出现"。
 *    第一版的桩用普通属性，元素一直留着 ⇒ 这个 bug 抓不到（反向校验时实测全绿）。
 *    于是这里复刻：模板里还存在的 id 换成**全新的空节点**，不在的删掉。
 */
function el(id, onReplace) {
  const o = {
    id, textContent: '', hidden: false, value: '', className: '', src: '',
    style: {}, dataset: {}, onclick: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener() {}, appendChild() {}, querySelectorAll() { return [] },
    // 真浏览器每个元素都有这两个方法；桩里漏掉过一次就会把「代码路径」误判成抛异常
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null },
  }
  let html = ''
  Object.defineProperty(o, 'innerHTML', {
    get: () => html,
    set(v) { html = String(v); if (onReplace) onReplace(id, html) },
  })
  return o
}

/** 跑一次 app.js，返回请求记录与元素读取器。
 *
 * `strictDom: true`（默认）复刻**真浏览器**的另一条语义：HTML 里没声明的 id，
 * `getElementById` 返回 `null`（而不是"凭空造一个"）。第一版桩对任何 id 都给元素，
 * 所以「app.js 找了一个 HTML 里不存在的元素」这种错它永远看不见 —— 而真实浏览器里
 * `$('hamb').onclick = …` 会直接抛异常 ⇒ `boot()` 整个不执行 ⇒ 用户看到的是一页
 * 静态文字 + 空卡片（2026-10-03 主人报的"页面错了"就是这个形状）。
 */
async function run({ pathname = '/', responses = {}, strictDom = true } = {}) {
  const els = new Map()
  /** 谁是谁的子节点（只在"某容器的 innerHTML 里出现过"时才记录）。 */
  const parentOf = new Map()
  const calls = []
  /** index.html 里静态声明的 id（真浏览器一开始就存在的那些）。 */
  const declared = new Set()
  if (strictDom) {
    for (const m of INDEX_HTML.matchAll(/id="([A-Za-z0-9_-]+)"/g)) declared.add(m[1])
  }
  const onReplace = (id, html) => {
    // 这次渲染出来的 HTML 里有哪些 id（包括以前从没被取过的）
    const inNew = new Set([...String(html).matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))
    // 出现在新 HTML 里的：旧节点一律丢弃、换成全新的空节点（浏览器就是这么重建的）
    for (const key of inNew) {
      if (key === id) continue
      els.set(key, el(key, onReplace))
      parentOf.set(key, id)
    }
    // 原来挂在这个容器下、新 HTML 里却没有的：这个节点真的被删了
    for (const key of [...els.keys()]) {
      if (key === id || inNew.has(key)) continue
      if (parentOf.get(key) === id) { els.delete(key); parentOf.delete(key) }
    }
    // 既不在新 HTML 里、也不是这个容器的子节点 ⇒ 不归这次替换管，别动它
  }
  /** 真实浏览器：找不存在的 id 就是 null。 */
  const missing = new Set()
  const ctx = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    JSON, Math, Date, String, Number, Object, Array, Error, Promise, encodeURIComponent, decodeURIComponent, RegExp, isNaN, parseInt,
    innerWidth: 1280,
    document: {
      getElementById(id) {
        if (!els.has(id)) {
          if (strictDom && !declared.has(id)) { missing.add(id); return null }
          els.set(id, el(id, onReplace))
        }
        return els.get(id)
      },
      querySelectorAll() { return [] },
      addEventListener() {},
      body: { style: {} },
    },
    window: { addEventListener() {} },
    location: { pathname, hash: '', href: `http://x${pathname}` },
    fetch: async (p, opt = {}) => {
      const key = String(p)
      calls.push({ path: key, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : undefined })
      const dflt = { status: 200, data: { ok: true, items: [], modes: [], plans: {}, priceCny: '2.99', freeDaily: 100 } }
      const r = responses[key] || dflt
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { getSetCookie: () => [] },
        json: async () => r.data,
        text: async () => JSON.stringify(r.data),
      }
    },
  }
  vm.createContext(ctx)
  // 真浏览器里「取了不存在的元素」≈ 抛异常。这里把异常/未处理的 Promise 拒绝都记下来。
  let bootError = null
  const onRej = (e) => { if (!bootError) bootError = e }
  process.on('unhandledRejection', onRej)
  try {
    vm.runInContext(SRC, ctx, { filename: 'app.js' })
  } catch (e) {
    bootError = e
  }
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
  for (let i = 0; i < 60; i++) await Promise.resolve()
  process.off('unhandledRejection', onRej)
  return { calls, getEl: (id) => ctx.document.getElementById(id), missing: [...missing], bootError, ctx }
}

const quota = { plan: 'free', limit: 100, used: 3, remaining: 97, retentionText: '5 小时', proUntil: null, upgraded: false }
const ME = { ok: true, me: { username: 'someone', plan: 'free', proUntil: null, mode: 'note-link', createdAt: Date.now(), quota } }
const TOKENS = {
  ok: true,
  items: [
    { id: 'ab12cd34ef56', prefix: 'ab12cd34ef56', createdAt: Date.now() - 3600e3, lastUsedAt: Date.now() - 60e3, label: 'dsh-desktop' },
    { id: 'ff00aa11bb22', prefix: 'ff00aa11bb22', createdAt: Date.now() - 86400e3, lastUsedAt: null, label: 'manual' },
  ],
}
const base = {
  '/api/meta': { status: 200, data: { ok: true, modes: [], plans: {}, priceCny: '2.99', freeDaily: 100 } },
  '/api/me': { status: 200, data: ME },
  '/api/tokens': { status: 200, data: TOKENS },
}

console.log('── 零、首页（未登录）必须真的渲染出来，不许只剩静态文字 ──')
{
  // 语义与真浏览器一致：HTML 里没声明的 id 取到 null。app.js 一旦 $('不存在的id')，
  // 在浏览器里就是 boot() 整个不执行 ⇒ 用户看到静态文字 + 空卡片。
  const { getEl, calls, missing, bootError } = await run({ responses: { '/api/meta': base['/api/meta'] } })
  check('★ boot() 全程没抛异常（抛了就是"整页 JS 不执行、只剩静态文字"）',
    !bootError, bootError ? String(bootError && bootError.message) : '')
  const overview = String(getEl('quotaCard').innerHTML)
  check('★ 账号页的额度卡真的被渲染了（不是空的）', overview.length > 40,
    `实际长度 ${overview.length}`)
  check('额度卡里说明了免费额度', /100/.test(overview))
  const modes = String(getEl('modesCard').innerHTML)
  check('★ 账号页的三档模式卡也渲染了', modes.length > 40, `实际长度 ${modes.length}`)
  check('首页确实请求了 /api/meta', calls.some((c) => c.path === '/api/meta'))
  // 未登录时 app.js 会按 id 找登录后才有的那几块（用 on() 包着、取到 null 就跳过，属于正常）
  if (missing.length) console.log(`  ℹ️  未登录时按 id 找过、但当前页面没有的元素（有 if 守卫，无害）：${missing.join(', ')}`)
}

console.log('── 零之二、首页是"官网落地页"：不靠 JS 也读得全（主人 2026-10-03 报的问题）──')
{
  const ov = (INDEX_HTML.match(/<section class="view" data-view="overview"[\s\S]*?<\/section>/) || [''])[0]
  const noComment = ov.replace(/<!--[\s\S]*?-->/g, '')
  check('首页有品牌级标题（h1 写着插件名字）', /<h1[^>]*>[\s\S]*DSH 通知插件/.test(noComment))
  check('★ 首页正文是**静态**的：没靠 JS 填充的空容器', !/id="(quotaCard|modesCard|payCard)"/.test(noComment))
  check('首页讲清了三档给法', /直接发到 QQ/.test(noComment) && /只存服务器/.test(noComment) && /存服务器 \+ 链接/.test(noComment))
  check('首页写了额度与保留（100 次 / 5 小时 / 1000 次 / 48 小时）',
    /100 次/.test(noComment) && /5 小时/.test(noComment) && /1000 次/.test(noComment) && /48 小时/.test(noComment))
  check('首页写了付费版价格 ¥2.99', /¥2\.99/.test(noComment))
  check('首页有登录/注册入口（未登录时不至于无路可走）', /data-go="account"/.test(noComment) && /登录/.test(noComment))
  check('首页写明了"默认不上传"这件事', /不经过服务器|不上传/.test(noComment))
  // 额度/模式/兑换挪到「账号」页 —— 别两处都放，重复会不一致
  const acc = (INDEX_HTML.match(/<section class="view" data-view="account"[\s\S]*?<\/section>/) || [''])[0]
  check('额度和模式卡在「账号」页里', /id="quotaCard"/.test(acc) && /id="modesCard"/.test(acc))
  check('兑换码卡片也在「账号」页里', /id="payCard"/.test(acc))
  check('导航第一项叫「首页」而不是「概览」', /data-view="overview"[^>]*><span>首页<\/span>/.test(INDEX_HTML))
}

console.log('── 一、已登录：绑定块与令牌列表必须出现在页面上 ──')
{
  const { getEl, calls } = await run({ responses: base })
  const html = String(getEl('accountCard').innerHTML)
  check('页面里有设备码输入框', html.includes('id="deviceCode"'))
  check('页面里有「确认绑定」按钮', html.includes('id="bindDeviceBtn"'))
  check('说明文案点明了「回 DSH 再调一次 cloud_bind」', /再(调|调用)一次\s*<code>cloud_bind<\/code>|再调用?一次 cloud_bind/.test(html))
  check('★ 登录后会去拉 /api/tokens', calls.some((c) => c.path === '/api/tokens' && c.method === 'GET'))
  check('★ 令牌列表渲染出来了（两个前缀都在）', html.includes('ab12cd34ef56') && html.includes('ff00aa11bb22'))
  check('每行都带 data-revoke，且值就是令牌 id', html.includes('data-revoke="ab12cd34ef56"') && html.includes('data-revoke="ff00aa11bb22"'))
  check('没用过的令牌显示「还没用过」而不是空白', html.includes('还没用过'))
  check('页面写清了令牌的权限边界（读不到正文）', html.includes('读不到'))
}

console.log('\n── 二、确认设备码 ──')
{
  const { getEl, calls } = await run({
    responses: { ...base, '/api/device/approve': { status: 200, data: { ok: true, userCode: 'ABCD-EFGH' } } },
  })
  getEl('deviceCode').value = 'abcd-efgh'
  await getEl('bindDeviceBtn').onclick()
  const call = calls.find((c) => c.path === '/api/device/approve')
  check('★ 点确认真的 POST 了 /api/device/approve', !!call && call.method === 'POST')
  check('带上了那组码（原样，交给服务端归一化）', call && call.body && call.body.userCode === 'abcd-efgh')
  const msg = String(getEl('bindMsg').textContent)
  check('★ 回话说清了「这还没绑完，要回 DSH 再调一次」', /再调用?一次/.test(msg) && msg.includes('cloud_bind'), JSON.stringify(msg))
  check('成功时用的是 ok 样式（不是红的）', String(getEl('bindMsg').className).includes('ok'))
}

console.log('\n── 三、码不对/过期：必须把服务端原话照出来 ──')
{
  const { getEl } = await run({
    responses: { ...base, '/api/device/approve': { status: 404, data: { ok: false, error: '这个码不对、已经用过、或者已经过期了' } } },
  })
  getEl('deviceCode').value = 'ZZZZ-ZZZZ'
  await getEl('bindDeviceBtn').onclick()
  const msg = String(getEl('bindMsg').textContent)
  check('★ 服务端原话被完整显示（不是被换成"失败"）', msg.includes('这个码不对、已经用过、或者已经过期了'), JSON.stringify(msg))
  check('失败时用 err 样式（红）', String(getEl('bindMsg').className).includes('err'))
}

console.log('\n── 四、空码：本地就拦住，不发请求 ──')
{
  const { getEl, calls } = await run({ responses: base })
  getEl('deviceCode').value = '   '
  await getEl('bindDeviceBtn').onclick()
  check('★ 空码不发请求（省一次白跑，也避免把空值当"码不对"）', !calls.some((c) => c.path === '/api/device/approve'))
  check('并且说清了要干什么', String(getEl('bindMsg').textContent).includes('8 位'))
}

console.log('\n── 五、新建令牌：明文只显示这一次，而且**真的留在框里** ──')
{
  const h = await run({ responses: base })
  // POST 与 GET 是同一个路径，按方法给不同响应
  const orig = h.ctx.fetch
  h.ctx.fetch = async (p, opt = {}) => {
    if (String(p) === '/api/tokens' && (opt.method || 'GET') === 'POST') {
      h.calls.push({ path: '/api/tokens', method: 'POST', body: opt.body ? JSON.parse(opt.body) : undefined })
      return {
        ok: true, status: 200, headers: { getSetCookie: () => [] },
        json: async () => ({ ok: true, token: 'dsh_live_plaintext_ABC123' }), text: async () => '{}',
      }
    }
    return orig(p, opt)
  }
  await h.getEl('newTokenBtn').onclick()
  const box = String(h.getEl('newTokenBox').innerHTML)
  // ⚠️ 桩不做 HTML 解析，所以 `$('newTokenValue').value` 永远是空的 —— 这里只能查
  //    innerHTML 里的**只读输入框带没带 value 属性**（真实浏览器会把它变成 input.value）。
  check('★ 明文令牌进了只读输入框的 value 属性（不是混在段落里）',
    /<input[^>]*readonly[^>]*value="dsh_live_plaintext_ABC123"/.test(box), box.slice(0, 200))
  check('★ 明文框在 render() 之后**仍然存在**（顺序反了就会被清掉——第一版就是这么写的）', box.includes('dsh_live_plaintext_ABC123'))
  check('提醒了"只显示这一次"', box.includes('只显示一次'))
  check('真的 POST 了 /api/tokens', h.calls.some((c) => c.path === '/api/tokens' && c.method === 'POST'))
}

console.log('\n── 六、吊销：带上正确的 id ──')
{
  const h = await run({
    responses: { ...base, '/api/tokens/revoke': { status: 200, data: { ok: true, revoked: 'ff00aa11bb22' } } },
  })
  const card = h.getEl('accountCard')
  check('账号卡片上有委托绑定（onclick 是函数）', typeof card.onclick === 'function')
  // 模拟点在第二行那颗「吊销」上：真实浏览器里 closest('[data-revoke]') 会返回那个按钮
  const fakeBtn = { dataset: { revoke: 'ff00aa11bb22' } }
  await card.onclick({ target: { closest: (sel) => (sel === '[data-revoke]' ? fakeBtn : null) } })
  const call = h.calls.find((c) => c.path === '/api/tokens/revoke')
  check('★ 点吊销会 POST /api/tokens/revoke', !!call && call.method === 'POST')
  check('带的是那一行的 id（不是别的）', call && call.body && call.body.id === 'ff00aa11bb22', JSON.stringify(call && call.body))
}

console.log('\n── 七、没登录时不显示这些（别误导） ──')
{
  const { getEl } = await run({
    responses: { ...base, '/api/me': { status: 200, data: { ok: true, me: null } } },
  })
  const html = String(getEl('accountCard').innerHTML)
  check('未登录时是登录表单', html.includes('id="loginBtn"'))
  check('未登录时不出现设备码确认区', !html.includes('id="bindDeviceBtn"'))
  check('未登录时不出现令牌列表', !html.includes('data-revoke'))
}

console.log('\n── 八、人机验证：图要出来、提交要带答案、失败要换一张 ──')
{
  // 每次签发回一个**不同的 id**：这样才能分辨"到底换没换"（回同一个 id 的话断言是假的）
  let issued = 0
  // ⚠️ 第一张必须走 responses 传进去：render() 在 run() 里就发生了，
  //    等 run() 返回再换 fetch，那一刻的取图已经用默认响应（没有 image）跑完了。
  const FIRST = { status: 200, data: { ok: true, id: 'cap-static-1', image: 'data:image/svg+xml;base64,PHN2Zy8+', chars: 4, ttlMs: 180000 } }
  const h = await run({ responses: { ...base, '/api/me': { status: 200, data: { ok: true, me: null } }, '/api/captcha': FIRST } })
  const orig = h.ctx.fetch
  h.ctx.fetch = async (p, opt = {}) => {
    if (String(p) === '/api/captcha') {
      issued++
      h.calls.push({ path: '/api/captcha', method: 'GET', body: undefined })
      return {
        ok: true, status: 200, headers: { getSetCookie: () => [] },
        json: async () => ({ ok: true, id: 'cap-' + issued, image: 'data:image/svg+xml;base64,PHN2Zy8+', chars: 4, ttlMs: 180000 }),
        text: async () => '{}',
      }
    }
    if (String(p) === '/api/login') {
      h.calls.push({ path: '/api/login', method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : undefined })
      return {
        ok: false, status: 400, headers: { getSetCookie: () => [] },
        json: async () => ({ ok: false, captcha: true, error: '验证码不对（还能试 2 次）' }),
        text: async () => '{}',
      }
    }
    return orig(p, opt)
  }
  const html = String(h.getEl('accountCard').innerHTML)
  check('登录框里有验证码图与输入框', html.includes('id="capImg_login"') && html.includes('id="capText_login"'))
  check('注册框里也各有一张（同一页两个表单）', html.includes('id="capImg_reg"') && html.includes('id="capText_reg"'))
  check('两个表单都有「换一张」按钮', html.includes('id="capNew_login"') && html.includes('id="capNew_reg"'))
  await new Promise((r) => setImmediate(r))
  check('★ 进页面就真的去领了验证码', h.calls.filter((c) => c.path === '/api/captcha').length >= 1, `实际 ${issued} 次`)
  check('★ 取回来的图被贴到 <img> 上（不是空白框）',
    String(h.getEl('capImg_login').src).startsWith('data:image/svg+xml'))
  // 点「换一张」必须换到**新的一张**
  const before = issued
  await h.getEl('capNew_login').onclick()
  await new Promise((r) => setImmediate(r))
  check('★ 点「换一张」会重新领一张（id 变了，不是把旧图再贴一遍）', issued > before, `换前 ${before} / 换后 ${issued}`)

  h.getEl('loginName').value = 'someone'
  h.getEl('loginPass').value = 'pw-123456'
  h.getEl('capText_login').value = 'AB12'
  const issuedBeforeLogin = issued
  await h.getEl('loginBtn').onclick()
  await new Promise((r) => setImmediate(r))
  const call = h.calls.find((c) => c.path === '/api/login')
  check('★ 点登录把 captchaId 与 captchaText 一起提交了',
    !!call && typeof call.body.captchaId === 'string' && call.body.captchaId.startsWith('cap-') && call.body.captchaText === 'AB12',
    JSON.stringify(call && call.body))
  check('★ 服务端的失败原话被照出来（不换成"失败"两个字）',
    String(h.getEl('loginMsg').textContent).includes('验证码不对'), JSON.stringify(String(h.getEl('loginMsg').textContent)))
  check('★ 提交失败后自动换了一张（旧的那张已经作废，留着只会让人反复撞它）', issued > issuedBeforeLogin)
  check('没登录时不会把验证码塞进设备码/令牌那些块', !html.includes('id="bindDeviceBtn"') && !html.includes('data-revoke'))
}

console.log('\n── 九、服务端说「不用验证码」时，前端不该要（本机直连 / 带后台口令那条路）──')
{
  // 反向极性：meta 里 captcha.required=false ⇒ 表单里根本不该出现那张图，
  // 也不该白领一张。少了这一条，前端"永远要验证码"也能全绿 —— 而本机验收会因此全红。
  const h = await run({
    responses: {
      ...base,
      '/api/me': { status: 200, data: { ok: true, me: null } },
      '/api/meta': { status: 200, data: { ...base['/api/meta'].data, captcha: { required: false, chars: 4, ttlMs: 180000 } } },
    },
  })
  const html = String(h.getEl('accountCard').innerHTML)
  check('★ meta 说 required=false 时登录框里没有验证码图', !html.includes('id="capImg_login"'))
  check('注册框里也没有', !html.includes('id="capImg_reg"'))
  check('★ 而且不会白领一张（不发 /api/captcha）', !h.calls.some((c) => c.path === '/api/captcha'),
    JSON.stringify(h.calls.map((c) => c.method + ' ' + c.path)))
  let body = null
  const orig = h.ctx.fetch
  h.ctx.fetch = async (p, opt = {}) => {
    if (String(p) === '/api/login') {
      body = opt.body ? JSON.parse(opt.body) : null
      return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ ok: true, me: ME.me }), text: async () => '{}' }
    }
    return orig(p, opt)
  }
  h.getEl('loginName').value = 'someone'
  h.getEl('loginPass').value = 'pw-123456'
  await h.getEl('loginBtn').onclick()
  await new Promise((r) => setImmediate(r))
  check('★ 提交时 body 里不带 captchaId/captchaText（带空值反而会被服务端记成"验证码不对"）',
    !!body && body.username === 'someone' && !('captchaId' in body) && !('captchaText' in body), JSON.stringify(body))
}

console.log(`\n账号页（设备码 + 令牌）桩验收：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
