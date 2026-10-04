/**
 * 深链 `/n/<id>` 的**代码路径**验证：用无头 DOM 桩把 `public/app.js` 真跑一遍。
 *
 * ⚠️ 这是**桩**，不是浏览器：它证明"点了链接之后前端会去 POST /api/records/<id>/view、
 *    没登录时会停住并把人送去登录、登录后接着自动打开"，**不证明**排版/样式/滚动在真机上好看。
 *    浏览器渲染仍然属于"未验证"，别把这两件事混为一谈。
 *
 * 用法：node verify-deeplink.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, 'public', 'app.js'), 'utf8')

let pass = 0
let fail = 0
const check = (name, okk, detail = '') => {
  if (okk) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `　${detail}` : ''}`) }
}

/** 造一个元素：只要能被读写就行 */
function el(id) {
  return {
    id, innerHTML: '', textContent: '', hidden: false, value: '', className: '',
    style: {}, dataset: {}, onclick: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener() {}, appendChild() {}, querySelectorAll() { return [] },
  }
}

/**
 * 跑一次 app.js。
 * @param {object} opt
 * @param {string} opt.pathname       浏览器地址栏路径
 * @param {object} opt.responses      path → {status, data}（不存在则 {status:200,data:{ok:true}}）
 */
async function run({ pathname, responses = {} }) {
  const els = new Map()
  const calls = []
  const ctx = {
    console,
    setTimeout: (fn) => { return 0 },   // toast 的自动消失计时器：不需要真跑
    clearTimeout: () => {},
    JSON, Math, Date, String, Number, Object, Array, Error, Promise, encodeURIComponent, decodeURIComponent, RegExp, isNaN, parseInt,
    innerWidth: 1280,
    document: {
      getElementById(id) { if (!els.has(id)) els.set(id, el(id)); return els.get(id) },
      querySelectorAll() { return [] },
      addEventListener() {},
      body: { style: {} },
    },
    window: { addEventListener() {} },
    location: { pathname, hash: '', href: `http://x${pathname}` },
    fetch: async (p, opt = {}) => {
      calls.push({ path: String(p), method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : undefined })
      const key = String(p)
      // 默认响应也要是**形状正确**的：列表接口必须给 items，
      // 否则 state.records 变成 undefined，render() 会在真实代码里炸掉（这个坑我先踩了一次）。
      const dflt = (key === '/api/records' || key.startsWith('/api/records?') || key === '/api/meta')
        ? { status: 200, data: { ok: true, items: [], modes: [], plans: {}, priceCny: '2.99', freeDaily: 100 } }
        : { status: 200, data: { ok: true } }
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
  vm.runInContext(SRC, ctx, { filename: 'app.js' })
  // boot() 是 async 且带 await：等几轮微任务让它跑完
  for (let i = 0; i < 40; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
  for (let i = 0; i < 40; i++) await Promise.resolve()
  // 用**同一个** getElementById**：app.js 是按需取元素的，
  // 直接读 els.get('loginName') 会拿到 undefined（那个元素还没被谁问过）。
  return { calls, els, getEl: (id) => ctx.document.getElementById(id), ctx }
}

const ME = { ok: true, me: { username: 'someone', plan: 'free', proUntil: null, mode: 'note-link', createdAt: Date.now(), quota: { plan: 'free', limit: 100, used: 1, remaining: 99, retentionText: '5 小时', proUntil: null, upgraded: false } } }
const REC = { ok: true, record: { id: 'abc123', title: '验收标题', chars: 12, createdAt: Date.now(), retentionText: '5 小时', text: '正文第一行\n正文第二行' }, quota: { plan: 'free', limit: 100, used: 2, remaining: 98, retentionText: '5 小时', upgraded: false } }

console.log('── 一、已登录 + 深链 ──')
{
  const { calls, els } = await run({
    pathname: '/n/abc123',
    responses: { '/api/meta': { status: 200, data: { ok: true, modes: [], plans: { free: { daily: 100, retentionText: '5 小时' }, pro: { daily: 1000, days: 30, retentionText: '48 小时' } }, priceCny: '2.99', freeDaily: 100 } },
      '/api/me': { status: 200, data: ME }, '/api/records/abc123/view': { status: 200, data: REC } },
  })
  const view = calls.filter((c) => c.path === '/api/records/abc123/view')
  check('★ 深链会去打开这条记录（POST .../view）', view.length === 1 && view[0].method === 'POST', JSON.stringify(calls.map((c) => c.path)))
  const rb = els.get('readerBody')
  const rbHtml = String(rb ? rb.innerHTML : '')
  // 正文现在走 renderMarkdown → innerHTML（原来是 textContent，Markdown 记号会原样显示）。
  // 所以这把尺子也改成读 innerHTML，并且多要一条"确实渲染成了块级标签"的证据。
  check('★ 正文进了阅读器（渲染进 innerHTML）', rbHtml.includes('正文第一行'), JSON.stringify(rbHtml.slice(0, 160)))
  check('★ 正文是被渲染过的 HTML，不是原样文本', rbHtml.includes('<p>'), JSON.stringify(rbHtml.slice(0, 160)))
  check('阅读器被显示出来（hidden=false）', els.get('reader') && els.get('reader').hidden === false)
  check('标题是记录标题', els.get('readerTitle') && els.get('readerTitle').textContent === '验收标题', JSON.stringify(els.get('readerTitle') && els.get('readerTitle').textContent))
  check('元信息里带上保留期', String(els.get('readerMeta') && els.get('readerMeta').innerHTML).includes('5 小时'))
}

console.log('\n── 二、未登录 + 深链（不能白扣额度，也不能白屏）──')
{
  const { calls, els } = await run({
    pathname: '/n/abc123',
    responses: {
      '/api/meta': { status: 200, data: { ok: true, modes: [], plans: {}, priceCny: '2.99', freeDaily: 100 } },
      '/api/me': { status: 200, data: { ok: true, me: null } },
    },
  })
  check('★ 没有去 POST view（未登录不该消耗任何东西）', calls.filter((c) => c.path.includes('/view')).length === 0,
    JSON.stringify(calls.map((c) => c.path)))
  check('★ 停在了登录页（登录框被渲染出来）', String(els.get('accountCard') && els.get('accountCard').innerHTML).includes('loginName'),
    String(els.get('accountCard') && els.get('accountCard').innerHTML).slice(0, 120))
  check('提示说清"登录后自动打开"', String(els.get('toast') && els.get('toast').textContent).includes('登录'),
    JSON.stringify(els.get('toast') && els.get('toast').textContent))
}

console.log('\n── 三、登录成功后接着自动打开 ──')
{
  // 先按"未登录"启动，再点登录按钮
  const { calls, getEl } = await run({
    pathname: '/n/abc123',
    responses: {
      '/api/meta': { status: 200, data: { ok: true, modes: [], plans: {}, priceCny: '2.99', freeDaily: 100 } },
      '/api/me': { status: 200, data: { ok: true, me: null } },
      '/api/login': { status: 200, data: { ok: true, me: ME.me } },
      '/api/records/abc123/view': { status: 200, data: REC },
    },
  })
  const btn = getEl('loginBtn')
  check('登录按钮被挂上了处理函数', typeof btn.onclick === 'function')
  if (typeof btn.onclick === 'function') {
    getEl('loginName').value = 'someone'
    getEl('loginPass').value = 'pw'
    await btn.onclick()
    for (let i = 0; i < 40; i++) await Promise.resolve()
    await new Promise((r) => setImmediate(r))
    const view = calls.filter((c) => c.path === '/api/records/abc123/view')
    check('★ 登录后自动打开了那条记录（不用再点一次链接）', view.length === 1, JSON.stringify(calls.map((c) => `${c.method} ${c.path}`)))
    check('正文确实进了阅读器', String(getEl('readerBody').innerHTML).includes('正文第二行'))
  }
}

console.log('\n── 四、额度用完（429）时说的话是人话 ──')
{
  const { els } = await run({
    pathname: '/n/abc123',
    responses: {
      '/api/meta': { status: 200, data: { ok: true, modes: [], plans: {}, priceCny: '2.99', freeDaily: 100 } },
      '/api/me': { status: 200, data: ME },
      '/api/records/abc123/view': { status: 429, data: { ok: false, error: '今天的 100 次已经用完了', quota: { limit: 100, remaining: 0, used: 100 } } },
    },
  })
  const msg = String(els.get('toast') && els.get('toast').textContent)
  check('★ 429 时提示里点明次数与出路', msg.includes('100') && msg.includes('付费版'), msg)
  check('没有把阅读器打开（没内容可给）', !els.get('reader') || els.get('reader').hidden === true)
}

console.log('\n── 五、非深链路径不受影响 ──')
{
  const { calls } = await run({
    pathname: '/',
    responses: { '/api/meta': { status: 200, data: { ok: true, modes: [], plans: {}, priceCny: '2.99', freeDaily: 100 } }, '/api/me': { status: 200, data: ME } },
  })
  check('首页不会去打开任何记录', calls.filter((c) => c.path.includes('/view')).length === 0, JSON.stringify(calls.map((c) => c.path)))
}

console.log(`\n深链代码路径：${pass} 通过 / ${fail} 失败`)
console.log('（提醒：这是无头 DOM 桩，浏览器里的观感仍未验证）')
process.exit(fail ? 1 : 0)
