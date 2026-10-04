#!/usr/bin/env node
/**
 * verify-admin-ui.mjs —— 后台管理**界面**验收：**真浏览器**（headless Edge + CDP）× **真 dsh-web**。
 *
 * 为什么要有这一层（本项目吃过的教训）：
 *   ① 逐字节比对 / DOM 桩都**看不见 CSS** —— 2026-10-03 那次「页面只剩 4 个字」，
 *      就是 `.reader{display:flex}` 压过 `[hidden]{display:none}`；
 *   ② 「接口全绿」不等于「界面能用」—— 按钮点下去走的是哪个 id、请求体带没带对字段，
 *      只有真 DOM 真事件才能验；
 *   ③ 所以关键状态改动**一律用另一条通道复核**（浏览器里点一下，Node 侧打 HTTP 看数据变没变）。
 *
 * 用法：
 *   node verify-admin-ui.mjs                    # 验 server.mjs + public/*
 *   node verify-admin-ui.mjs --server <路径>     # 指向别的 server.mjs
 *   node verify-admin-ui.mjs --dir <目录>        # 指向别的静态目录（反向校验用）
 *
 * 零依赖：静态服务/HTTP 客户端用 node 内置，浏览器控制用 Edge 的 CDP（node 22 自带全局 WebSocket）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const SERVER = path.resolve(__dirname, argOf('--server', 'server.mjs'))
const ROOT = path.resolve(__dirname, argOf('--dir', 'public'))

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p))

let pass = 0
const fails = []
function chk(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fails.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-adminui-'))
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-edge-'))
const PORT = 18700 + Math.floor(Math.random() * 400)
const BASE = `http://127.0.0.1:${PORT}`
const DEBUG_PORT = 9500 + Math.floor(Math.random() * 400)
const STAMP = Date.now().toString(36).slice(-5)
const SECRET_BODY = `SECRET_BODY_绝不外泄_adminui_${STAMP}`
const PASSWORD = 'admin-ui-pass-123'

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, DSH_WEB_DATA: DATA, DSH_WEB_PORT: String(PORT), DSH_WEB_HOST: '127.0.0.1', DSH_WEB_ROOT: ROOT },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
child.stdout.on('data', (b) => { logs += b.toString() })
child.stderr.on('data', (b) => { logs += b.toString() })

let edge = null
let cdp = null
const cleanup = async () => {
  try { cdp?.ws.close() } catch {}
  try { edge?.kill() } catch {}
  try { child.kill('SIGKILL') } catch {}
  await sleep(300)
  await fs.promises.rm(PROFILE, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rm(DATA, { recursive: true, force: true }).catch(() => {})
}
const done = async (code) => { await cleanup(); process.exit(code) }
process.on('uncaughtException', (e) => { console.error('崩了：', e); cleanup().then(() => process.exit(2)) })

// ── Node 侧 HTTP 客户端（复核通道：浏览器点了按钮，这里看数据真变没变）──────
function makeClient() {
  let cookie = ''
  return async function req(method, p, { body, headers = {}, token, admin } = {}) {
    const h = { Accept: 'application/json', ...headers }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    if (cookie) h.Cookie = cookie
    if (token) h.Authorization = `Bearer ${token}`
    if (admin) h['x-admin-token'] = admin
    const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) if (c.startsWith('dsw_session=')) cookie = c.split(';')[0]
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, json, text }
  }
}
const anon = makeClient()

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return true } catch {}
    await sleep(100)
  }
  return false
}

// ── CDP 极简客户端 ────────────────────────────────────────────────────────
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
          if (m.id) {
            const p = pending.get(m.id)
            pending.delete(m.id)
            m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
          } else {
            events.push(m)
            // 原生弹窗（confirm / prompt / alert）必须立刻应答，否则 headless 会**整页挂住**
            // —— 不是报错、是死等，看起来像"脚本卡死"。这里兜住它，标桩只作为显式记录用。
            if (m.method === 'Page.javascriptDialogOpening') {
              try { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}) } catch { /* send 还没就绪 */ }
            }
          }
        }
        const send = (method, params = {}) => new Promise((res, rej) => {
          const i = ++id
          pending.set(i, { res, rej })
          ws.send(JSON.stringify({ id: i, method, params }))
        })
        return { ws, send, events }
      }
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error(`Edge 调试端口 ${DEBUG_PORT} 连不上`)
}

async function main() {
  console.log('后台界面验收：真浏览器（headless Edge + CDP）× 真 dsh-web')
  console.log(`server: ${SERVER}`)
  console.log(`public: ${ROOT}`)
  if (!EDGE) { console.log('无法继续：找不到 msedge.exe'); return done(2) }
  if (!(await waitReady())) { console.error('服务没起来\n' + logs); return done(2) }

  const TOKEN_FILE = path.join(DATA, 'admin-token')
  const ADMIN_TOKEN = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : 'NO-ADMIN-TOKEN-FILE'
  chk('服务起来并生成了 admin-token', ADMIN_TOKEN.length >= 20, `len=${ADMIN_TOKEN.length}`)

  // ── Node 侧造数：两个账号、两条记录、一次查看、一个设备码 ────────────────
  const U1 = `uiu1${STAMP}`
  const U2 = `uiu2${STAMP}`
  const U3 = `uic${STAMP}`        // 由界面建号
  const U4 = `uid${STAMP}`        // 由界面建号 + 界面删号
  const c1 = makeClient()
  const c2 = makeClient()
  const r1 = await c1('POST', '/api/register', { body: { username: U1, password: PASSWORD } })
  const r2 = await c2('POST', '/api/register', { body: { username: U2, password: PASSWORD } })
  chk('造数：注册两个账号', r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`)
  const t1 = (await c1('POST', '/api/tokens', { body: { label: 'ui-1' } })).json.token
  const t2 = (await c2('POST', '/api/tokens', { body: { label: 'ui-2' } })).json.token
  const pub1 = await anon('POST', '/api/publish', { token: t1, body: { title: `界面验收记录A-${STAMP}`, text: SECRET_BODY, mode: 'note-link' } })
  const pub2 = await anon('POST', '/api/publish', { token: t2, body: { title: `界面验收记录B-${STAMP}`, text: SECRET_BODY + '_B', mode: 'note-link' } })
  chk('造数：两条记录发布成功', pub1.status === 200 && pub2.status === 200, `${pub1.status}/${pub2.status}`)
  await c1('POST', `/api/records/${pub1.json.id}/view`)
  const dev = await anon('POST', '/api/device/start')
  chk('造数：设备码 start 成功', dev.status === 200 && !!dev.json.userCode, `status=${dev.status}`)

  // ── 启动浏览器 ───────────────────────────────────────────────────────────
  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--window-size=1280,900',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`, `${BASE}/admin.html`,
  ], { stdio: 'ignore' })

  cdp = await connect()
  const { send, events } = cdp
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Log.enable')

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面里抛异常了')
    return r.result.value
  }
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`
  const disp = (sel) => evaluate(`getComputedStyle(${q(sel)}).display`)
  const inner = (sel) => evaluate(`(${q(sel)} && ${q(sel)}.innerText || '').trim()`)
  const click = (sel) => evaluate(`${q(sel)}.click(); true`)
  const type = (sel, v) => evaluate(`${q(sel)}.value = ${JSON.stringify(v)}; true`)
  const bodyText = () => evaluate(`document.body.innerText`)
  const clickByText = (parent, label) => evaluate(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(parent)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return 'not-found';
    b.click(); return 'clicked';
  })()`)

  for (let i = 0; i < 80; i++) {
    const ready = await evaluate('document.readyState').catch(() => 'loading')
    if (ready === 'complete') break
    await sleep(200)
  }
  await sleep(900)

  // 让所有 confirm 直接通过，并记下到底问了几次（不覆盖的话无头浏览器会卡在原生弹窗上）
  await evaluate(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return true; }; true`)

  // ── 一、口令闸门 ─────────────────────────────────────────────────────────
  console.log('\n[1] 口令闸门：没对口令之前，后台一点都看不见')
  chk('闸门可见', (await disp('#gate')) !== 'none', `display=${await disp('#gate')}`)
  // ★ 这条正是 2026-10-03 那次事故的同类：作者样式表的 display 压过 [hidden]
  chk('★ #app 的 computed display 是 none（[hidden] 没被样式表压掉）', (await disp('#app')) === 'none', `display=${await disp('#app')}`)
  chk('未进门时页面上没有「概览」数字卡', (await inner('#ovStats')) === '', `实测="${(await inner('#ovStats')).slice(0, 40)}"`)

  // ⚠️ 故意用 ASCII 错口令：HTTP 头只能放 ASCII，中文会在**发出请求之前**就让 fetch 抛
  //    TypeError（"String contains non ISO-8859-1 code point"），那样测到的是浏览器行为，
  //    不是"服务端说口令不对"。中文口令的路径由下一条断言单独覆盖。
  await type('#gateToken', 'wrong-token-aaaaaaaa')
  await click('#gateBtn')
  await sleep(600)
  const wrongMsg = await inner('#gateMsg')
  chk('错口令：闸门不放开', (await disp('#app')) === 'none' && (await disp('#gate')) !== 'none')
  chk('错口令：界面上明确说了一句错在哪', /口令/.test(wrongMsg), `msg="${wrongMsg}"`)
  chk('错口令：没有把错口令留在 sessionStorage 里', (await evaluate(`sessionStorage.getItem('dsw_admin_token')`)) === null)

  // 中文口令：fetch 发不出去，界面必须给一句人话，而不是把浏览器的英文原始报错甩出来
  await type('#gateToken', '中文口令不能当请求头')
  await click('#gateBtn')
  await sleep(400)
  const cjkMsg = await inner('#gateMsg')
  chk('中文/全角口令：本地就拦下并说清原因（不甩英文报错）',
    cjkMsg.includes('不能有中文') && !/ISO-8859-1/.test(cjkMsg), `msg="${cjkMsg}"`)
  chk('中文口令：同样不留在 sessionStorage 里', (await evaluate(`sessionStorage.getItem('dsw_admin_token')`)) === null)

  await type('#gateToken', ADMIN_TOKEN)
  await click('#gateBtn')
  await sleep(900)
  chk('对口令：闸门关掉、后台打开', (await disp('#gate')) === 'none' && (await disp('#app')) !== 'none', `gate=${await disp('#gate')} app=${await disp('#app')}`)
  chk('#app 是 flex 布局（admin.css 真的加载上了）', (await disp('#app')) === 'flex', `display=${await disp('#app')}`)
  chk('侧栏宽度 ≈ 208px（admin.css 生效）', (await evaluate(`document.querySelector('.admin-side').getBoundingClientRect().width`)) >= 200 && (await evaluate(`document.querySelector('.admin-side').getBoundingClientRect().width`)) <= 210, '')
  chk('口令存进了 sessionStorage（刷新后不用重输）', (await evaluate(`sessionStorage.getItem('dsw_admin_token')`)) === ADMIN_TOKEN)

  // ── 二、概览 ─────────────────────────────────────────────────────────────
  console.log('\n[2] 概览')
  const ovText = await inner('section[data-aview="overview"]')
  chk('概览有统计卡（至少 8 张）', (await evaluate(`document.querySelectorAll('#ovStats .stat').length`)) >= 8, '')
  chk('概览写了免费版/付费版两档额度', ovText.includes('每天 100 次') && ovText.includes('每天 1000 次'), '')
  chk('概览写了没有在线支付（不吹）', ovText.includes('没有在线支付'), '')
  chk('趋势图渲染了 14 行', (await evaluate(`document.querySelectorAll('#ovTrend .bar-row').length`)) === 14, '')
  chk('左侧导航的计数不再是占位符 -', (await inner('#nUsers')) !== '-', `nUsers=${await inner('#nUsers')}`)
  chk('概览里没有用户正文', !ovText.includes(SECRET_BODY))

  // ── 三、用户 ─────────────────────────────────────────────────────────────
  console.log('\n[3] 用户页：搜索 / 建号 / 详情 / 给 Pro / 清额度 / 吊销令牌')
  await click('.admin-nav button[data-aview="users"]')
  await sleep(700)
  chk('切到用户页后只有它可见（section 只有一个）',
    (await evaluate(`[...document.querySelectorAll('section[data-aview]')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.dataset.aview).join(',')`)) === 'users')
  const uText1 = await inner('section[data-aview="users"]')
  chk('用户表里有第一个账号', uText1.includes(U1), '')
  chk('用户表里有第二个账号', uText1.includes(U2), '')
  chk('用户表分页/计数在 #uMsg 里说清了', /共 \d+ 个账号/.test(await inner('#uMsg')), `msg="${await inner('#uMsg')}"`)

  // ── 三之一、可发现性（2026-10-04 补）──────────────────────────────────────
  // 主人原话：「没有看到真正的用户管理」。真根因不是功能缺失（功能一直在，接口也验过），
  // 而是**界面上没有任何东西说明这页能干什么**：
  //   ① 表格 9 列全是数字，一个操作按钮都没有；
  //   ② 唯一入口是"点用户名"，而它渲染成 btn ghost（无边框/无底色）——看着就是一行纯文字；
  //   ③ 「取消 Pro」当时挂着「退出该账号登录」的牌子。
  // 这一节把"看得见、够得着"钉成断言 —— 上一轮就是因为只验了"接口对不对"才漏掉。
  console.log('\n[3a] 可发现性：操作入口看得见、够得着')
  const hint = (await inner('#uHint')).replace(/\s+/g, ' ')
  chk('用户页顶部有一行说明，明确讲出这页能干什么',
    hint.includes('管理') && hint.includes('加 Pro') && hint.includes('取消 Pro') && hint.includes('封禁'),
    `hint="${hint.slice(0, 70)}"`)
  const heads = await evaluate(`[...document.querySelectorAll('#uList thead th')].map((t) => t.textContent.trim())`)
  chk('用户表最后一列表头是「操作」', heads[heads.length - 1] === '操作', `表头=${heads.join('|')}`)
  chk('★ 每一行都有一个写明了用途的「管理」按钮（不再只能靠"点用户名"）',
    (await evaluate(`[...document.querySelectorAll('#uList tbody tr')].every((tr) => [...tr.querySelectorAll('button')].some((b) => b.textContent.trim() === '管理'))`)) === true,
    `行数=${await evaluate(`document.querySelectorAll('#uList tbody tr').length`)}`)

  // ★ 够不够得着：贴住的列必须始终落在 .tbl-wrap 的可视区里。
  //   先在正常宽度下量一次（桌面不该需要横向滚动），再把容器**真的压窄**量一次
  //   （手机就是这个情形：10 列表格必然横向滚动，钉住的列能不能跟住）。
  const visibleInWrap = `(() => {
    const wrap = document.querySelector('#uList').closest('.tbl-wrap');
    const btn = document.querySelector('#uList tbody tr:last-child td.act button');
    if (!wrap || !btn) return { err: 'no-btn' };
    const w = wrap.getBoundingClientRect(), b = btn.getBoundingClientRect();
    return { need: wrap.scrollWidth - wrap.clientWidth, inView: b.left >= w.left - 0.5 && b.right <= w.right + 0.5,
             sticky: getComputedStyle(document.querySelector('#uList tbody td.act')).position, cssRight: getComputedStyle(document.querySelector('#uList tbody td.act')).right };
  })()`
  const g1 = await evaluate(visibleInWrap)
  chk('桌面宽度下，用户表不需要横向滚动', g1.need <= 1, `超出 ${g1.need}px`)
  chk('桌面宽度下，最后一行的「管理」按钮在可视区内', g1.inView === true, JSON.stringify(g1))
  chk('「操作」列是 position:sticky / right:0（窄屏时钉在右边）',
    g1.sticky === 'sticky' && g1.cssRight === '0px', `position=${g1.sticky} right=${g1.cssRight}`)
  const g2 = await evaluate(`(() => {
    const wrap = document.querySelector('#uList').closest('.tbl-wrap');
    wrap.style.width = '420px';
    const r = ${visibleInWrap};
    wrap.style.width = '';
    return r;
  })()`)
  chk('★ 把容器压到 420px（模拟手机）后确实要横向滚动了', g2.need > 40, `超出 ${g2.need}px`)
  chk('★ 压窄之后「管理」按钮**仍然**在可视区内（钉住的列真的跟住了）', g2.inView === true, JSON.stringify(g2))

  // 搜索（真输入 + 回车事件）
  await type('#uSearch', U1)
  await evaluate(`${q('#uSearch')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`)
  await sleep(700)
  const uSearchText = await inner('#uList')
  chk('搜索只留下命中的那一个', uSearchText.includes(U1) && !uSearchText.includes(U2), '')
  await type('#uSearch', '')
  await click('#uReload')
  await sleep(700)

  // 界面建号（带 7 天 Pro）+ 界面给 Pro（叠加）+ 界面上删号
  await type('#uCreateUser', U3)
  await type('#uCreatePass', PASSWORD)
  await type('#uCreateDays', '7')
  await click('#uCreateBtn')
  await sleep(900)
  const createMsg = await inner('#uMsg')
  const createCheck = await anon('GET', `/api/admin/users/${U3}`, { admin: ADMIN_TOKEN })
  chk('界面建号：服务端真的建出来了', createCheck.status === 200, `status=${createCheck.status}`)
  chk('界面建号：回执说明给它开了 Pro', /付费版/.test(createMsg), `msg="${createMsg}"`)
  chk('界面建号：档位 = 付费版 7 天', createCheck.json && createCheck.json.user.plan === 'pro' && createCheck.json.user.proDaysLeft === 7,
    `plan=${createCheck.json && createCheck.json.user.plan} 天数=${createCheck.json && createCheck.json.user.proDaysLeft}`)

  // 打开详情
  chk('在表里点到用户名能打开详情', (await clickByText('#uList tbody button', U3)) === 'clicked')
  await sleep(700)
  const dText = await inner('#uDetail')
  chk('详情面板显示了档位与天数', dText.includes('付费版') && dText.includes('7 天'), '')
  chk('详情面板列出了发布令牌区块', dText.includes('发布令牌'), '')
  chk('详情面板写明后台看不到正文', dText.includes('没有正文') || dText.includes('读不到任何人的正文'))

  // ── 三之二、详情面板：三组能力带标题 + 打开时能看见（2026-10-04 补）──────
  // 原来这里是一坨**没有标题**的按钮，主人扫一眼根本认不出"哪些是给 Pro、哪个是封禁"。
  // 而且 #uDetail 在 #uList **上方**：列表长起来以后，从下面点行会在视野外渲染 ——
  // 表现就是"点了没反应"。
  console.log('\n[3b] 详情面板：分了三组、打开时在视野里、正在看的那行有高亮')
  for (const h of ['付费版（Pro）', '封禁', '账号管理']) {
    chk(`详情里有分组标题「${h}」`, dText.includes(h), '')
  }
  chk('详情里有「取消 Pro（改回免费版）」（名字要说人话，不能叫"退出该账号登录"）',
    dText.includes('取消 Pro（改回免费版）') && !dText.includes('退出该账号登录'), '')
  chk('详情里三组各至少一个按钮、且分组标题是 h3（可被扫读）',
    (await evaluate(`[...document.querySelectorAll('#uDetail h3.act-h')].map((x) => x.textContent.trim()).join('|')`)) === '付费版（Pro）|封禁|账号管理',
    `实测=${await evaluate(`[...document.querySelectorAll('#uDetail h3.act-h')].map((x) => x.textContent.trim()).join('|')`)}`)
  const dtTop = await evaluate(`${q('#uDetail')}.getBoundingClientRect().top`)
  chk('★ 点开详情后它被拉到视野里（此前在表格上方，会"点了没反应"）',
    dtTop >= -2 && dtTop <= 40, `#uDetail top=${Math.round(dtTop)}`)
  chk('★ 正在看的那一行被标出来了（tr.on 正好是刚点开的那一个）',
    (await evaluate(`[...document.querySelectorAll('#uList tbody tr.on')].map((tr) => tr.dataset.user).join(',')`)) === U3,
    `实测=[${await evaluate(`[...document.querySelectorAll('#uList tbody tr.on')].map((tr) => tr.dataset.user).join(',')`)}]`)

  // 详情里「叠加 30 天」——点界面，Node 侧复核
  await type('#uDetail input[type="number"]', '30')
  chk('点「叠加这么多天」', (await clickByText('#uDetail button', '叠加这么多天')) === 'clicked')
  await sleep(900)
  const afterGrant = await anon('GET', `/api/admin/users/${U3}`, { admin: ADMIN_TOKEN })
  chk('★ 界面点一下真的叠加了 30 天（7 → 37）', afterGrant.json.user.proDaysLeft === 37, `实测 ${afterGrant.json.user.proDaysLeft} 天`)

  // 界面上「清空今日额度」：先让 U3 用一次，再清
  // ⚠️ /api/records/:id/view 会校验记录归属（`r.user === who`），拿别人的记录去看是 404，
  //    所以必须让 U3 用自己的令牌发一条自己的记录 —— 否则"用量"永远为 0，测的是空气。
  const c3 = makeClient()
  await c3('POST', '/api/login', { body: { username: U3, password: PASSWORD } })
  const t3 = (await c3('POST', '/api/tokens', { body: { label: 'ui-3' } })).json.token
  const pub3 = await anon('POST', '/api/publish', { token: t3, body: { title: `界面验收记录C-${STAMP}`, text: SECRET_BODY + '_U3', mode: 'note-link' } })
  chk('造数：U3 用自己的令牌发一条记录', pub3.status === 200, `status=${pub3.status} ${pub3.text.slice(0, 120)}`)
  const v3 = await c3('POST', `/api/records/${pub3.json.id}/view`)
  chk('U3 看了自己这条记录一次（200）', v3.status === 200, `status=${v3.status} ${v3.text.slice(0, 120)}`)
  const beforeQuota = await anon('GET', `/api/admin/users/${U3}`, { admin: ADMIN_TOKEN })
  chk('U3 用过一次（今日 1 次）', beforeQuota.json.user.usedToday === 1, `usedToday=${beforeQuota.json.user.usedToday}`)
  chk('点「清空今日额度」', (await clickByText('#uDetail button', '清空今日额度')) === 'clicked')
  await sleep(900)
  const afterQuota = await anon('GET', `/api/admin/users/${U3}`, { admin: ADMIN_TOKEN })
  chk('★ 今日额度真的清零了', afterQuota.json.user.usedToday === 0, `usedToday=${afterQuota.json.user.usedToday}`)
  chk('★ 累计查看没有被清掉（清额度不清历史）', afterQuota.json.user.viewsTotal === 1, `viewsTotal=${afterQuota.json.user.viewsTotal}`)

  // 界面上「取消 Pro（改回免费版）」= 撤掉 Pro
  // 🔴 这个按钮原来挂着「退出该账号登录」的牌子（实际跑的是 revoke）——
  //    主人要找「取消 Pro」永远找不到。2026-10-04 改名，断言跟着改。
  chk('点「取消 Pro（改回免费版）」', (await clickByText('#uDetail button', '取消 Pro（改回免费版）')) === 'clicked')
  await sleep(900)
  const afterRevokePlan = await anon('GET', `/api/admin/users/${U3}`, { admin: ADMIN_TOKEN })
  chk('★ 撤 Pro 后档位回到免费', afterRevokePlan.json.user.plan === 'free', `plan=${afterRevokePlan.json.user.plan}`)
  chk('撤 Pro 前弹出过确认框（危险操作有确认）', (await evaluate('window.__confirms.length')) >= 1, `已确认 ${await evaluate('window.__confirms.length')} 次`)

  // 打开 U1 的详情：令牌只给前缀，绝不显示明文
  chk('打开 U1 的详情', (await clickByText('#uList tbody button', U1)) === 'clicked')
  await sleep(800)
  const d1 = await inner('#uDetail')
  chk('U1 详情里显示了记录标题（元信息）', d1.includes(`界面验收记录A-${STAMP}`), '')
  // 后台存的是 sha256，所以界面上那个「前缀」是哈希前 12 位，**不是**令牌明文的前 12 位
  const u1detail = await anon('GET', `/api/admin/users/${U1}`, { admin: ADMIN_TOKEN })
  const t1prefix = (u1detail.json.tokens[0] || {}).prefix || ''
  chk('U1 详情里令牌区显示 12 位前缀', t1prefix.length === 12 && d1.includes(t1prefix), `prefix=${t1prefix}`)
  chk('★ 前缀不是令牌明文的前 12 位（服务端只存哈希，明文前缀也不外泄）', t1prefix !== t1.slice(0, 12), '')
  chk('★ U1 详情里**没有**令牌明文', !d1.includes(t1), '令牌明文出现在页面上了')
  chk('★ 详情里**没有**任何正文', !d1.includes(SECRET_BODY))
  chk('详情里有「按天用量」柱状图', (await evaluate(`document.querySelectorAll('#uDetail .bar-row').length`)) >= 1, '')

  // 界面吊销 U1 的令牌 → Node 侧复核令牌立刻失效
  chk('点详情里的「吊销」', (await clickByText('#uDetail button', '吊销')) === 'clicked')
  await sleep(1000)
  const t1After = await anon('GET', '/api/me', { token: t1 })
  chk('★ 界面吊销后，那个令牌真的不能用了（/api/me → 401）', t1After.status === 401, `status=${t1After.status}`)
  chk('吊销后页面上有一条回执', /已吊销/.test(await inner('#uMsg')), `msg="${await inner('#uMsg')}"`)

  // 界面删号
  await type('#uCreateUser', U4)
  await type('#uCreatePass', PASSWORD)
  await type('#uCreateDays', '0')
  await click('#uCreateBtn')
  await sleep(900)
  chk('界面再建一个免费版账号', (await (await anon('GET', `/api/admin/users/${U4}`, { admin: ADMIN_TOKEN })).status) === 200)
  chk('点开它的详情', (await clickByText('#uList tbody button', U4)) === 'clicked')
  await sleep(700)
  chk('点「删除账号」', (await clickByText('#uDetail button', '删除账号')) === 'clicked')
  await sleep(1000)
  const u4Gone = await anon('GET', `/api/admin/users/${U4}`, { admin: ADMIN_TOKEN })
  chk('★ 界面删号后服务端也没有它了（404）', u4Gone.status === 404, `status=${u4Gone.status}`)

  // ── 四、记录 ─────────────────────────────────────────────────────────────
  console.log('\n[4] 记录页：只看元信息、能按人过滤、能删')
  await click('.admin-nav button[data-aview="records"]')
  await sleep(800)
  const rText = await inner('section[data-aview="records"]')
  chk('记录表里有 U2 的记录标题', rText.includes(`界面验收记录B-${STAMP}`), '')
  chk('★ 记录页整页搜不到任何正文', !(await bodyText()).includes(SECRET_BODY), '正文泄露了')
  await type('#rUser', U2)
  await click('#rReload')
  await sleep(800)
  const rFiltered = await inner('#rList')
  chk('按用户过滤后只剩那一条', rFiltered.includes(`界面验收记录B-${STAMP}`) && !rFiltered.includes(`界面验收记录A-${STAMP}`), '')

  chk('点记录行的「删除」', (await clickByText('#rList tbody button', '删除')) === 'clicked')
  await sleep(1000)
  const recsAfter = await anon('GET', `/api/admin/records?limit=200`, { admin: ADMIN_TOKEN })
  chk('★ 界面删掉后这条记录真没了', !recsAfter.json.items.some((r) => r.id === pub2.json.id), '')
  chk('另一条记录没被误删', recsAfter.json.items.some((r) => r.id === pub1.json.id), '')

  // ── 五、兑换码 ───────────────────────────────────────────────────────────
  console.log('\n[5] 兑换码页：能生成、码能用、用过就标出来')
  await click('.admin-nav button[data-aview="codes"]')
  await sleep(700)
  await type('#cCount', '2')
  await type('#cDays', '45')
  await type('#cNote', `界面验收-${STAMP}`)
  await click('#cGen')
  await sleep(1000)
  const codes = await evaluate(`[...document.querySelectorAll('#cList tbody tr')].map((tr) => tr.children[0].textContent.trim())`)
  chk('界面上生成了 2 个兑换码', Array.isArray(codes) && codes.length === 2, `实测 ${JSON.stringify(codes)}`)
  chk('生成了 45 天的码（回执里写清了）', /45 天/.test(await inner('#cMsg')), `msg="${await inner('#cMsg')}"`)

  const c2b = makeClient()
  await c2b('POST', '/api/login', { body: { username: U2, password: PASSWORD } })
  const redeem = await c2b('POST', '/api/redeem', { body: { code: codes[0] } })
  chk('★ 界面上生成的码真的能兑换（200）', redeem.status === 200, `status=${redeem.status} ${redeem.text.slice(0, 120)}`)
  const me2 = await c2b('GET', '/api/me')
  const days2 = me2.json && me2.json.me.proUntil ? Math.round((me2.json.me.proUntil - Date.now()) / 86400000) : 0
  chk('★ 兑换后 U2 变成付费版，且是 45 天', me2.json && me2.json.me.plan === 'pro' && days2 >= 44 && days2 <= 45, `plan=${me2.json && me2.json.me.plan} 天数=${days2}`)

  // 重新切一次导航（= 重新拉列表），这时列表里应能看到刚被用掉的那个码
  await click('.admin-nav button[data-aview="codes"]')
  await sleep(900)
  const cTable = await inner('#cList')
  chk('用过的码在列表里标成「已使用」且没有删除按钮', cTable.includes('已使用'), '')

  // ── 六、设备码 ───────────────────────────────────────────────────────────
  console.log('\n[6] 设备码页：看得见"有人在绑"，看不见长码')
  await click('.admin-nav button[data-aview="devices"]')
  await sleep(800)
  const devText = await inner('section[data-aview="devices"]')
  const devAdmin = await anon('GET', '/api/admin/devices', { admin: ADMIN_TOKEN })
  const devHash = devAdmin.json && devAdmin.json.items[0] ? devAdmin.json.items[0].hash : ''
  chk('设备页显示了那条待批准的短码', devText.includes(dev.json.userCode), '')
  chk('设备页显示了 12 位长码指纹', devHash.length === 12 && devText.includes(devHash), `hash=${devHash}`)
  chk('★ 设备页没有泄露长码 deviceCode', !!dev.json.deviceCode && !devText.includes(dev.json.deviceCode), '长码泄露了')
  chk('设备页整页也没有长码', !(await bodyText()).includes(dev.json.deviceCode))

  // ── 七、口令失效 / 退出 / 零外部请求 ─────────────────────────────────────
  console.log('\n[7] 口令失效与会话：401 必须把界面推回闸门，且不装作成功')
  chk('点「换口令」回到闸门', (await click('#logoutBtn')) === true)
  await sleep(400)
  chk('换口令后闸门又出现、后台收起', (await disp('#gate')) !== 'none' && (await disp('#app')) === 'none')
  chk('换口令后 sessionStorage 里的口令被清掉', (await evaluate(`sessionStorage.getItem('dsw_admin_token')`)) === null)

  await evaluate(`sessionStorage.setItem('dsw_admin_token', 'garbage-token-deadbeef'); true`)
  await send('Page.reload', {})
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate('document.readyState').catch(() => 'loading')
    if (ready === 'complete') break
    await sleep(200)
  }
  await sleep(1200)
  chk('★ 带着失效口令刷新：界面自动退回闸门（不是停在空后台）', (await disp('#gate')) !== 'none' && (await disp('#app')) === 'none',
    `gate=${await disp('#gate')} app=${await disp('#app')}`)
  chk('失效口令被清掉了', (await evaluate(`sessionStorage.getItem('dsw_admin_token')`)) === null)
  chk('退回闸门时给了一句提示', (await inner('#gateMsg')).length > 0, `msg="${await inner('#gateMsg')}"`)

  await type('#gateToken', ADMIN_TOKEN)
  await click('#gateBtn')
  await sleep(1000)
  chk('再输对口令能立刻重新进来（失败不是不可恢复）', (await disp('#app')) !== 'none', '')

  // ── 八、账号通道 + 封禁 / 管理员身份 ─────────────────────────────────────
  console.log('\n[8] 账号通道 + 封禁 / 管理员身份（两条通道并列，封禁只标记不删数据）')
  // 🔴 必须在这里**重新**给 confirm 打桩：第 [7] 节末尾 reload 过一次，
  //    上面那个桩跟着页面一起没了。无头浏览器碰到原生 confirm 会**直接挂住**（不是报错），
  //    本轮就是先在「设为管理员」那一下卡死才发现的。
  await evaluate(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return true; }; true`)
  await send('Network.enable', {})
  const hdrOf = (headers, name) => {
    for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return v
    return undefined
  }
  const adminCalls = (from) => events.slice(from)
    .filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/admin/'))
    .map((e) => ({ url: e.params.request.url, token: hdrOf(e.params.request.headers, 'x-admin-token') }))
  const userRow = async (name) => (await anon('GET', `/api/admin/users/${encodeURIComponent(name)}`, { admin: ADMIN_TOKEN })).json.user
  // ⚠️ 必须**等界面真的换过来**再动手：openUser 是异步 fetch，点完立刻读 #uDetail
  //    读到的还是上一个人的面板 —— 本轮就因此把封禁打到了别的账号上（按钮点的是谁的详情就是谁）。
  //    所以这里等两件事：①列表里出现这个名字 ②详情面板的标题是这个名字。
  const openUserByName = async (name) => {
    await type('#uSearch', name)
    await evaluate(`${q('#uSearch')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`)
    let listed = false
    for (let i = 0; i < 25; i++) {
      await sleep(200)
      if ((await inner('#uList')).includes(name)) { listed = true; break }
    }
    if (!listed) return 'list-miss'
    await clickByText('#uList tbody button', name)
    for (let i = 0; i < 30; i++) {
      await sleep(200)
      const t = await evaluate(`(${q('#uDetail')} && ${q('#uDetail')}.innerText || '')`)
      if (t.includes(name)) return 'clicked'
    }
    return 'detail-stale'
  }
  const detailButtons = () => evaluate(`[...document.querySelectorAll('#uDetail button')].map((b) => b.textContent.trim()).join('|')`)
  const BAN_REASON = `界面验收封禁原因-${STAMP}`
  const U5 = `uiu5${STAMP}`          // 普通账号（不是管理员），用来测「账号通道拒普通人」
  const c5 = makeClient()
  await c5('POST', '/api/register', { body: { username: U5, password: PASSWORD } })
  const u3Before = await userRow(U3)

  // ① 界面点一下，U1 成为管理员
  chk('打开 U1 详情', (await openUserByName(U1)) === 'clicked')
  chk('详情里有「设为管理员」按钮', (await detailButtons()).includes('设为管理员'), await detailButtons())
  chk('点「设为管理员」', (await clickByText('#uDetail button', '设为管理员')) === 'clicked')
  await sleep(900)
  chk('★ 界面点一下就真的成了管理员（服务端复核）', (await userRow(U1)).admin === true, `msg="${await inner('#uMsg')}"`)
  chk('用户表里挂上了「管理员」徽标', (await inner('#uList')).includes('管理员'))

  // ② 唯一管理员不许自降 —— 服务端的护栏必须原样出现在界面上
  chk('再点「取消管理员」', (await clickByText('#uDetail button', '取消管理员')) === 'clicked')
  await sleep(900)
  const lastAdminMsg = await inner('#uMsg')
  chk('★ 最后一个管理员不许被取消（服务端原话透到界面）', lastAdminMsg.includes('最后一个还能用的管理员'), `msg="${lastAdminMsg}"`)
  chk('★ 被拒绝之后 U1 仍然是管理员（不是"拒绝了但状态已改"）', (await userRow(U1)).admin === true)

  // ③ 第二个管理员加得上 —— 证明上一条不是"一律拒绝"
  chk('打开 U2 详情', (await openUserByName(U2)) === 'clicked')
  chk('把 U2 也设成管理员', (await clickByText('#uDetail button', '设为管理员')) === 'clicked')
  await sleep(900)
  chk('★ 有第二个管理员时就能加上', (await userRow(U2)).admin === true, `msg="${await inner('#uMsg')}"`)
  const ovAdmin = (await anon('GET', '/api/admin/overview', { admin: ADMIN_TOKEN })).json
  chk('概览里「管理员」计数 = 2', ovAdmin.totals.adminUsers === 2, `adminUsers=${ovAdmin.totals.adminUsers}`)

  // ④ 封禁 U3：只标记、不删数据
  chk('打开 U3 详情', (await openUserByName(U3)) === 'clicked')
  await type('#uDetail input[placeholder*="薅羊毛"]', BAN_REASON)
  chk('点「封禁账号」', (await clickByText('#uDetail button', '封禁账号')) === 'clicked')
  await sleep(900)
  const u3Ban = await userRow(U3)
  chk('★ 账号真的被封了', u3Ban.banned === true && u3Ban.bannedAt > 0, JSON.stringify({ banned: u3Ban.banned, at: u3Ban.bannedAt }))
  chk('★ 封禁原因存下来了', u3Ban.banReason === BAN_REASON, `reason="${u3Ban.banReason}"`)
  chk('★ 口令通道操作时，操作人记成「（服务器口令）」', u3Ban.bannedBy === '（服务器口令）', `by="${u3Ban.bannedBy}"`)
  chk('★ 封禁不删数据：档位 / 记录 / 令牌 / 额度原样',
    u3Ban.plan === u3Before.plan && u3Ban.records === u3Before.records && u3Ban.tokens === u3Before.tokens && u3Ban.limit === u3Before.limit,
    JSON.stringify({ plan: [u3Before.plan, u3Ban.plan], records: [u3Before.records, u3Ban.records], tokens: [u3Before.tokens, u3Ban.tokens], limit: [u3Before.limit, u3Ban.limit] }))
  const d3 = await inner('#uDetail')
  chk('详情里写了「正在封禁中」+ 原因 + 操作人', d3.includes('正在封禁中') && d3.includes(BAN_REASON) && d3.includes('（服务器口令）'))
  chk('按钮从「封禁账号」变成「解封账号」', (await detailButtons()).includes('解封账号') && !(await detailButtons()).includes('封禁账号'), await detailButtons())
  chk('用户表里挂上了「已封禁」徽标', (await inner('#uList')).includes('已封禁'))
  const ovBan = (await anon('GET', '/api/admin/overview', { admin: ADMIN_TOKEN })).json
  chk('概览里「已封禁」计数 = 1', ovBan.totals.bannedUsers === 1, `bannedUsers=${ovBan.totals.bannedUsers}`)

  // ⑤ 被封之后的三条出口（Node 侧独立复核，不看界面脸色）
  const c3b = makeClient()
  const c3login = await c3b('POST', '/api/login', { body: { username: U3, password: PASSWORD } })
  chk('★ 被封账号登录 → 403，话里点名是被封', c3login.status === 403 && /封禁/.test(c3login.json.error), `${c3login.status} ${c3login.text.slice(0, 120)}`)
  const pub3banned = await anon('POST', '/api/publish', { token: t3, body: { title: '封禁期间', text: 'x' } })
  chk('★ 被封账号的发布令牌 → 403，也点名是被封', pub3banned.status === 403 && /封禁/.test(pub3banned.json.error), `${pub3banned.status} ${pub3banned.text.slice(0, 120)}`)

  // ⑥ 退出 → 闸门；两条通道并列，账号登录是默认那一栏
  //    先刷新一次，把状态清成"一个全新访客"（否则上一次是用口令进来的，闸门停在口令那一栏是对的）
  await evaluate(`sessionStorage.removeItem('dsw_admin_token'); true`)
  await send('Page.reload', {})
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate('document.readyState').catch(() => 'loading')
    if (ready === 'complete') break
    await sleep(200)
  }
  await sleep(1500)
  await evaluate(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return true; }; true`)
  chk('闸门又出现、后台收起', (await disp('#gate')) !== 'none' && (await disp('#app')) === 'none')
  chk('全新的访客默认停在「账号登录」那一栏', (await disp('#gatePaneAccount')) !== 'none' && (await disp('#gatePaneToken')) === 'none',
    `account=${await disp('#gatePaneAccount')} token=${await disp('#gatePaneToken')}`)
  chk('两个页签的 aria-current 恰好一真一假',
    (await evaluate(`[...document.querySelectorAll('.gate-tabs button')].map((b) => b.getAttribute('aria-current')).join(',')`)) === 'true,false',
    await evaluate(`[...document.querySelectorAll('.gate-tabs button')].map((b) => b.getAttribute('aria-current')).join(',')`))
  await click('#gateTabToken')
  chk('切到「后台口令」那一栏', (await disp('#gatePaneToken')) !== 'none' && (await disp('#gatePaneAccount')) === 'none')
  chk('切回「账号登录」', (await click('#gateTabAccount')) === true)
  chk('账号栏又回来了', (await disp('#gatePaneAccount')) !== 'none' && (await disp('#gatePaneToken')) === 'none')

  // ⑦ 普通账号：说清"你不是管理员"，并且**不留下登录态**
  await type('#gateUser', U5)
  await type('#gatePass', PASSWORD)
  chk('点「登录」', (await click('#gateLoginBtn')) === true)
  await sleep(1200)
  const notAdminMsg = await inner('#gateMsg')
  chk('★ 普通账号登录 → 明确说「这个账号不是管理员」', notAdminMsg.includes('不是管理员'), `msg="${notAdminMsg}"`)
  chk('★ 普通账号进不去后台', (await disp('#app')) === 'none' && (await disp('#gate')) !== 'none')
  chk('★ 普通账号登录用的密码没有被留在输入框里', (await evaluate(`${q('#gatePass')}.value`)) === '', `pass="${await evaluate(`${q('#gatePass')}.value`)}"`)
  const cookies1 = (await send('Network.getAllCookies')).cookies.filter((c) => c.name === 'dsw_session')
  chk('★ 被拒之后没留下登录态（刚建的那个会话已主动注销）', cookies1.length === 0, JSON.stringify(cookies1.map((c) => c.domain)))

  // ⑧ 被封账号登录：闸门要把封禁原因原样说出来
  await type('#gateUser', U3)
  await type('#gatePass', PASSWORD)
  await click('#gateLoginBtn')
  await sleep(1200)
  const bannedMsg = await inner('#gateMsg')
  chk('★ 被封账号登录 → 闸门把封禁原因原样说出来', bannedMsg.includes('封禁') && bannedMsg.includes(BAN_REASON), `msg="${bannedMsg}"`)
  chk('★ 被封账号同样进不去', (await disp('#app')) === 'none')

  // ⑨ 管理员账号登录成功：侧栏写清"谁在操作"，且**一个字节的口令都不带**
  const idxAcct = events.length
  await type('#gateUser', U1)
  await type('#gatePass', PASSWORD)
  await click('#gateLoginBtn')
  await sleep(1500)
  chk('★ 管理员账号登录成功、后台打开', (await disp('#app')) !== 'none' && (await disp('#gate')) === 'none',
    `gate=${await disp('#gate')} app=${await disp('#app')} msg="${await inner('#gateMsg')}"`)
  chk('★ 侧栏写清「现在是谁在操作」', (await inner('#sideWho')).includes(U1), `sideWho="${await inner('#sideWho')}"`)
  chk('★ 账号模式下 sessionStorage 里没有口令（没偷偷存口令）', (await evaluate(`sessionStorage.getItem('dsw_admin_token')`)) === null)
  chk('★ 账号模式登录密码框已清空', (await evaluate(`${q('#gatePass')}.value`)) === '')
  const acctCalls = adminCalls(idxAcct)
  chk('账号模式确实打过后台接口（这条尺子不是空的）', acctCalls.length >= 1, `共 ${acctCalls.length} 次`)
  chk('★ 账号模式所有 /api/admin/* 请求都没带 x-admin-token',
    acctCalls.every((c) => c.token === undefined),
    JSON.stringify(acctCalls.filter((c) => c.token !== undefined).map((c) => [c.url, c.token])))

  // ⑩ 账号模式下封禁：操作人必须是登录的那个账号（会话通道是真身份，不是摆设）
  chk('账号模式下打开 U5 详情', (await openUserByName(U5)) === 'clicked')
  await type('#uDetail input[placeholder*="薅羊毛"]', '账号通道封禁验收')
  chk('点「封禁账号」（这次是登录账号在操作）', (await clickByText('#uDetail button', '封禁账号')) === 'clicked')
  await sleep(900)
  const u5Ban = await userRow(U5)
  chk('★ 封禁记录里写清了是谁操作的（= 登录账号）', u5Ban.banned === true && u5Ban.bannedBy === U1, `banned=${u5Ban.banned} by="${u5Ban.bannedBy}"`)
  chk('点「解封账号」（U5）', (await clickByText('#uDetail button', '解封账号')) === 'clicked')
  await sleep(900)
  const u5Free = await userRow(U5)
  chk('★ 解封后 bannedAt / 原因 / 操作人全部归零', u5Free.banned === false && u5Free.banReason === '' && u5Free.bannedBy === '',
    JSON.stringify({ banned: u5Free.banned, reason: u5Free.banReason, by: u5Free.bannedBy }))
  const c5login = await (makeClient())('POST', '/api/login', { body: { username: U5, password: PASSWORD } })
  chk('★ 解封后立刻能登录（真的恢复了，不是只改了标记）', c5login.status === 200, `status=${c5login.status}`)

  // ⑪ 解封 U3，并复核它的发布令牌恢复了
  chk('账号模式下打开 U3 详情', (await openUserByName(U3)) === 'clicked')
  chk('点「解封账号」（U3）', (await clickByText('#uDetail button', '解封账号')) === 'clicked')
  await sleep(900)
  const u3Free = await userRow(U3)
  chk('★ U3 解封后 bannedAt = 0', u3Free.banned === false && u3Free.bannedAt === null, JSON.stringify({ banned: u3Free.banned, at: u3Free.bannedAt }))
  const c3after = await (makeClient())('POST', '/api/login', { body: { username: U3, password: PASSWORD } })
  chk('★ U3 解封后能登录', c3after.status === 200, `status=${c3after.status}`)
  const pub3after = await anon('POST', '/api/publish', { token: t3, body: { title: `解封后还能发-${STAMP}`, text: 'ok', mode: 'note-link' } })
  chk('★ U3 解封后发布令牌恢复', pub3after.status === 200, `status=${pub3after.status} ${pub3after.text.slice(0, 120)}`)
  chk('封禁与解封各弹过一次确认框', (await evaluate('window.__confirms.length')) >= 2, `已确认 ${await evaluate('window.__confirms.length')} 次`)

  // ⑫ 刷新页面：靠 cookie 静默进入（不用重新打字），侧栏仍然知道自己是谁
  await send('Page.reload', {})
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate('document.readyState').catch(() => 'loading')
    if (ready === 'complete') break
    await sleep(200)
  }
  await sleep(1500)
  await evaluate(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return true; }; true`)
  chk('★ 刷新后靠 cookie 静默进入（不用重新打字）', (await disp('#app')) !== 'none' && (await disp('#gate')) === 'none',
    `gate=${await disp('#gate')} app=${await disp('#app')}`)
  chk('★ 刷新后侧栏仍然知道自己是谁', (await inner('#sideWho')).includes(U1), `sideWho="${await inner('#sideWho')}"`)
  chk('刷新后 sessionStorage 里依然没有口令', (await evaluate(`sessionStorage.getItem('dsw_admin_token')`)) === null)

  // ⑬ 回到口令通道（后面几节接着用它），并做一次对照组：口令模式的请求**必须**带口令
  chk('点「退出」（账号模式）', (await click('#logoutBtn')) === true)
  await sleep(700)
  chk('退出后闸门又出现', (await disp('#gate')) !== 'none' && (await disp('#app')) === 'none')
  await click('#gateTabToken')
  const idxTok = events.length
  await type('#gateToken', ADMIN_TOKEN)
  await click('#gateBtn')
  await sleep(1200)
  chk('口令通道重新进入成功', (await disp('#app')) !== 'none', `msg="${await inner('#gateMsg')}"`)
  chk('口令存回了 sessionStorage', (await evaluate(`sessionStorage.getItem('dsw_admin_token')`)) === ADMIN_TOKEN)
  await click('#ovRefresh')
  await sleep(1000)
  const tokCalls = adminCalls(idxTok)
  chk('★ 对照组：口令模式的请求**确实**带上了 x-admin-token',
    tokCalls.some((c) => c.token === ADMIN_TOKEN),
    JSON.stringify(tokCalls.map((c) => [c.url, c.token === ADMIN_TOKEN ? '<ADMIN_TOKEN>' : String(c.token)]).slice(0, 6)))

  const resources = await evaluate(`performance.getEntriesByType('resource').map((e) => e.name)`)
  const external = resources.filter((u) => !u.startsWith(BASE))
  chk('★ 后台页零外部请求（不引第三方脚本/字体/图表）', external.length === 0, JSON.stringify(external).slice(0, 200))
  // 资源表里除了静态文件，还会有 /api/* 的 XHR（页面每切一页都会拉数据）⇒ 只挑非 API 的看。
  // 注意：admin.html 是**文档本身**，不会出现在 performance 的 resource 条目里；
  //       data: 的内联 favicon 也不算「外部资源」（上面那条零外部请求已经覆盖）。
  const staticRes = resources.filter((u) => !u.includes('/api/') && !u.startsWith('data:')).map((u) => u.split('?')[0])
  const WANT = ['style.css', 'admin.css', 'admin.js']
  chk('页面用到的静态资源就是那三个文件',
    WANT.every((f) => staticRes.some((u) => u.endsWith('/' + f))) &&
      staticRes.every((u) => WANT.some((f) => u.endsWith('/' + f))),
    JSON.stringify(staticRes))
  chk('页面的文档本身就是 /admin.html',
    (await evaluate('location.pathname')) === '/admin.html', await evaluate('location.pathname'))

  const htmlNow = await evaluate(`document.documentElement.innerHTML`)
  chk('★ 页面 HTML 里搜不到后台口令（口令只在 sessionStorage）', !htmlNow.includes(ADMIN_TOKEN), '口令出现在 DOM 里了')
  chk('★ 页面整页搜不到任何用户正文', !(await bodyText()).includes(SECRET_BODY))

  // ⚠️ 网络层的 401/403 是**故意**打出来的：错口令、失效口令、普通账号登录（/api/admin/* → 403）、
  //    被封账号登录（/api/login → 403）、以及被拒后主动注销（/api/logout）。
  //    Chrome 会把它们记成 source=network 的 error 日志 —— 不能把这算成「页面有 JS 错误」。
  //    但除此之外的网络错误（favicon 404、静态文件缺了、5xx）必须报出来。
  const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown')
  const logErrors = events.filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
  const pageErrors = logErrors.filter((e) => e.params.entry.source !== 'network')
  const netErrors = logErrors.filter((e) => e.params.entry.source === 'network')
  const netKey = (e) => `${e.params.entry.url || '(无 url)'} ｜ ${e.params.entry.text}`
  const deliberate = (e) => {
    const url = String(e.params.entry.url ?? '')
    const text = String(e.params.entry.text ?? '')
    return /\/api\/(admin|login|logout)\b/.test(url) || /status of (401|403)/.test(text)
  }
  const unexpectedNet = netErrors.filter((e) => !deliberate(e))
  chk('★ 全程没有未捕获异常（JS 没崩）', exceptions.length === 0, exceptions.length ? JSON.stringify(exceptions[0]).slice(0, 300) : '0 条')
  chk('★ 没有 JS/console 错误', pageErrors.length === 0, pageErrors.length ? JSON.stringify(pageErrors[0]).slice(0, 300) : '0 条')
  chk('★ 除了故意打的 401/403，没有别的网络错误（静态文件/favicon 都正常）', unexpectedNet.length === 0, JSON.stringify(unexpectedNet.map(netKey)).slice(0, 300))
  console.log(`  ℹ 网络层错误 ${netErrors.length} 条（全是故意打出来的鉴权拒绝），JS 异常 ${exceptions.length} 条`)
  if (netErrors.length) console.log(`     ${netErrors.slice(0, 8).map(netKey).join('\n     ')}`)

  console.log(`\n>>> 通过 ${pass} / 失败 ${fails.length}`)
  if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  ❌ ' + f) }
  return done(fails.length ? 1 : 0)
}

main().catch(async (e) => {
  console.log(`\n>>> 脚本中途崩溃：${e && e.message}`)
  console.log(`>>> 通过 ${pass} / 失败 ${fails.length}`)
  if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  ❌ ' + f) }
  await done(fails.length ? 1 : 2)
})
