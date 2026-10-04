// 线上后台页面「账号身份通道」真浏览器验收（headless Edge + CDP，只读，不改任何数据）
// 用法：$env:ADMIN_PASS='<主人账号口令>'; node Temp\_live-admin-ui.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const BASE = process.env.BASE_URL || 'https://cyanovo.top'
const USER = process.env.ADMIN_USER || 'cyanovo'
const PASS = process.env.ADMIN_PASS || ''
if (!PASS) { console.error('缺少 ADMIN_PASS'); process.exit(2) }
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p))
if (!EDGE) { console.error('找不到 msedge.exe'); process.exit(2) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-liveui-'))
const DEBUG_PORT = 9600 + Math.floor(Math.random() * 300)

let pass = 0, fail = 0
const ok = (t, c, extra = '') => { if (c) { pass++; console.log(`  ✅ ${t}`) } else { fail++; console.log(`  ❌ ${t}${extra ? ' ｜ ' + extra : ''}`) } }

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1326,900', `${BASE}/admin.html`,
], { stdio: 'ignore' })

const cleanup = async () => {
  try { await cdp?.ws.close() } catch { /* ignore */ }
  try { edge.kill() } catch { /* ignore */ }
  await sleep(200)
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.on('uncaughtException', async (e) => { console.error('崩了：', e); await cleanup(); process.exit(2) })

let cdp = null
async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连不上')) })
        let id = 0
        const pending = new Map()
        const events = []
        ws.onmessage = (ev) => {
          const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
          if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
          else {
            events.push(m)
            if (m.method === 'Page.javascriptDialogOpening') { try { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}) } catch { /* */ } }
          }
        }
        const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
        return { ws, send, events }
      }
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('Edge 调试端口连不上')
}

const evaluate = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || ''))
  return r.result.value
}
const disp = (sel) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?getComputedStyle(e).display:null})()`)
const text = (sel) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:null})()`)
const click = (sel) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`)
const type = (sel, v) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
async function waitFor(expr, ms = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await evaluate(`(()=>{try{return !!(${expr})}catch{return false}})()`)) return true; await sleep(200) }
  return false
}

try {
  console.log(`\n=== 线上后台页面·账号通道验收 @ ${BASE}/admin.html ===`)
  cdp = await connect()
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Network.enable')
  ok('页面加载完成', await waitFor(`document.readyState==='complete'`))
  await sleep(600)

  // ── 闸门初始态：两个页签，默认在「账号」那一栏 ─────────────────────────────
  ok('★ 初始状态：闸门可见、后台收起', (await disp('#gate')) !== 'none' && (await disp('#app')) === 'none', `gate=${await disp('#gate')} app=${await disp('#app')}`)
  ok('★ 默认停在「登录账号」那一栏（不是口令栏）', (await disp('#gatePaneAccount')) !== 'none' && (await disp('#gatePaneToken')) === 'none', `account=${await disp('#gatePaneAccount')} token=${await disp('#gatePaneToken')}`)
  ok('口令那一栏的输入框此时不可见（父栏收起 ⇒ 没有可点区域）', (await evaluate(`document.querySelector('#gateToken').getClientRects().length`)) === 0)
  await click('#gateTabToken'); await sleep(200)
  ok('点「后台口令」页签 → 换到口令栏', (await disp('#gatePaneToken')) !== 'none' && (await disp('#gatePaneAccount')) === 'none')
  await click('#gateTabAccount'); await sleep(200)
  ok('点回「登录账号」页签 → 回到账号栏', (await disp('#gatePaneAccount')) !== 'none')

  // ── 真登录 ───────────────────────────────────────────────────────────────
  await type('#gateUser', USER)
  await type('#gatePass', PASS)
  ok('用户名字段已填', (await evaluate(`document.querySelector('#gateUser').value`)) === USER)
  await click('#gateLoginBtn')
  const entered = await waitFor(`getComputedStyle(document.querySelector('#app')).display!=='none'`, 15000)
  ok('★ 用 cyanovo 账号密码登录后，后台真的打开了', entered, `msg="${await text('#gateMsg')}"`)
  ok('★ 后台打开后闸门收起', (await disp('#gate')) === 'none')
  ok('★ 账号模式没有把任何后台口令塞进 sessionStorage', (await evaluate(`sessionStorage.getItem('dsw_admin_token')`)) === null)
  ok('密码框被清空（不留在输入框里）', (await evaluate(`document.querySelector('#gatePass').value`)) === '')
  const who = await text('#sideWho')
  ok('★ 侧栏写清「谁在操作」= cyanovo', String(who || '').includes(USER), `who="${who}"`)

  // ── 账号列表：能看到身份与用量 ─────────────────────────────────────────────
  await click('.admin-nav button[data-aview="users"]'); await sleep(400)
  ok('切到「用户」页后只有它可见', await evaluate(`document.querySelectorAll('section[data-aview]:not([hidden])').length===1`),
    `visible=${await evaluate(`document.querySelectorAll('section[data-aview]:not([hidden])').length`)}`)
  await type('#uSearch', USER); await click('#uReload')
  await waitFor(`document.querySelector('#uList') && document.querySelector('#uList').innerText.includes(${JSON.stringify(USER)})`)
  const list = String(await text('#uList') || '')
  ok('★ 列表里出现 cyanovo 这一行', list.includes(USER), list.slice(0, 120))
  ok('★ 这一行标着「管理员」身份标签', list.includes('管理员'), list.slice(0, 200))
  ok('★ 能看到使用情况（今日/累计等用量字段在表头或行里）', /今日|累计|用量|额度|记录/.test(list), list.slice(0, 300))
  // ── 可发现性（2026-10-04 补）──────────────────────────────────────────────
  // 主人原话「没有看到真正的用户管理」。所以"线上这一版到底有没有写明入口"必须现场量，
  // 不能只看本地文件对不对。
  const hint = String(await text('#uHint') || '')
  ok('★ 页面顶部写明了这页能干什么（管理 / 加 Pro / 取消 Pro / 封禁）',
    hint.includes('管理') && hint.includes('加 Pro') && hint.includes('取消 Pro') && hint.includes('封禁'), hint.replace(/\s+/g, ' ').slice(0, 90))
  const heads = await evaluate(`[...document.querySelectorAll('#uList thead th')].map((t) => t.textContent.trim())`)
  ok('★ 用户表最后一列表头是「操作」', heads[heads.length - 1] === '操作', `表头=${heads.join('|')}`)
  ok('★ 每一行都有一个「管理」按钮（不再只能靠"点用户名"）',
    (await evaluate(`[...document.querySelectorAll('#uList tbody tr')].every((tr) => [...tr.querySelectorAll('button')].some((b) => b.textContent.trim() === '管理'))`)) === true)
  const geo = await evaluate(`(() => {
    const w = document.querySelector('#uList').closest('.tbl-wrap');
    const b = document.querySelector('#uList tbody td.act button');
    if (!w || !b) return null;
    const W = w.getBoundingClientRect(), B = b.getBoundingClientRect();
    return { need: w.scrollWidth - w.clientWidth, inView: B.left >= W.left - 0.5 && B.right <= W.right + 0.5,
             right: getComputedStyle(document.querySelector('#uList tbody td.act')).right };
  })()`)
  ok('★ 「管理」按钮在可视区内、且「操作」列钉在右边（窄屏也不会跑到屏幕外）',
    !!geo && geo.inView === true && geo.right === '0px', JSON.stringify(geo))
  ok('点用户名打开详情（走 /api/admin/users/<name>）', await click('#uList button.btn.ghost'))
  ok('详情面板真的出现了内容', await waitFor(`document.querySelector('#uDetail') && document.querySelector('#uDetail').innerText.length>10`))
  const detail = String(await text('#uDetail') || '')
  ok('详情里能看到用量与身份', /今日|累计|额度|管理员|付费版/.test(detail), detail.slice(0, 160))
  ok('★ 点每行右侧的「管理」也能打开同一个详情面板', await click('#uList tbody td.act button'))
  ok('★ 详情面板被拉到了视野里（此前它在表格上方，会"点了没反应"）',
    await waitFor(`document.querySelector('#uDetail') && document.querySelector('#uDetail').getBoundingClientRect().top < 60`),
    `top=${await evaluate(`Math.round(document.querySelector('#uDetail').getBoundingClientRect().top)`)}`)
  const detail2 = String(await text('#uDetail') || '')
  ok('★ 详情分成三组带标题：付费版（Pro）/ 封禁 / 账号管理',
    detail2.includes('付费版（Pro）') && detail2.includes('账号管理') && detail2.includes('封禁'), detail2.replace(/\s+/g, ' ').slice(0, 160))
  ok('★ 「取消 Pro」按钮名字说人话（不再挂着"退出该账号登录"的牌子）',
    detail2.includes('取消 Pro（改回免费版）') && !detail2.includes('退出该账号登录'))

  // ── 退出后回到闸门 ────────────────────────────────────────────────────────
  await click('#logoutBtn'); await sleep(400)
  ok('★ 点「退出」→ 闸门重新出现、后台收起', (await disp('#gate')) !== 'none' && (await disp('#app')) === 'none')

  // ── 控制台 ───────────────────────────────────────────────────────────────
  // ⚠️ 引导时会**故意**匿名打一次 /api/admin/overview（用来判断"浏览器里有没有登录 cookie"），
  //    那一条 401 是设计如此，不是报错。真正的红线是"未捕获异常"和"非网络的 console.error"。
  const allErr = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))
  const net401 = allErr.filter((e) => /status of (401|403)/.test(e.params?.entry?.text || ''))
  const others = allErr.filter((e) => !net401.includes(e))
  ok('★ 0 条未捕获异常 / 非网络错误', others.length === 0, others.slice(0, 3).map((e) => JSON.stringify(e.params).slice(0, 200)).join(' | '))
  ok('★ 网络层只有"引导探测"那几条 401（全是故意打的）', net401.length >= 1 && net401.length <= 3, `count=${net401.length} ${net401.slice(0, 3).map((e) => e.params?.entry?.url || e.params?.entry?.text).join(' | ')}`)
  const failed = cdp.events.filter((e) => e.method === 'Network.loadingFailed')
  ok('没有资源加载失败', failed.length === 0, failed.slice(0, 2).map((e) => e.params?.errorText).join(' | '))
  // 这一轮根本没给口令 ⇒ 只检查"不该出现的东西"：口令值、密码、令牌输入框内容
  const html = await evaluate(`document.documentElement.outerHTML`)
  ok('★ 页面里搜不到登录密码明文', !html.includes(PASS))
  ok('★ 口令输入框始终是空的（账号模式没塞过口令）', (await evaluate(`document.querySelector('#gateToken').value`)) === '')
  ok('★ 退出后仍是账号栏、且 sessionStorage 里没有口令', (await disp('#gatePaneAccount')) !== 'none' && (await evaluate(`sessionStorage.getItem('dsw_admin_token')`)) === null)
} catch (e) {
  console.error('探针异常：', e.message)
  fail++
}

console.log(`\n>>> 通过 ${pass} / 失败 ${fail}`)
await cleanup()
process.exit(fail ? 1 : 0)
