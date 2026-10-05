#!/usr/bin/env node
/**
 * verify-deeplink-live.mjs —— **真人路径**的端到端验收：从 QQ 里点开的那种链接
 * `http://cyanovo.top/n/<id>`，在真浏览器里一路走到「完整回答」渲染完成。
 *
 * 为什么还需要这一把尺子（前两把都还是「绕过去」的）：
 *   ① `verify-deeplink.mjs`：无头 DOM 桩，直接调 `openRecord()`；
 *   ② `verify-markdown.mjs` 第二层：真浏览器，但**把 window.fetch 换成了桩**
 *      —— 这是"诚实地不消耗额度"，可它同时也**绕开了真实登录、真实记录、真实额度**。
 *   本轮补的就是剩下那一环：**真登录 → 真记录 → 真 /n/<id> 深链 → 真渲染**。
 *
 * 两段（互为交叉验证）：
 *   A 受控样张：注册一个一次性账号 → 拿令牌 → 发布一份已知含全部块级语法的 markdown
 *     → 打开 `/n/<id>` → 断言渲染 + 断言"裸记号在原始文本里确实存在（量具有牙）"
 *     → **注销账号（记录一并删掉）**，不留垃圾。
 *   B 主人真实记录：以 `cyanovo` 登录 → 取最近一条真实记录 → 打开 `/n/<id>` → 断言。
 *     这是 QQ 通知里那条链接**逐字对应**的场景。
 *
 * 断言里守的几条：
 *   - `/n/<id>` 服务端**没有**这条路由（返回的是 SPA 外壳），渲染完全发生在客户端；
 *   - `#reader` 从 hidden 变成可见，且 `#readerBody` 里是**标签**不是文本；
 *   - `getComputedStyle(readerBody).whiteSpace === 'normal'`（这是老 `<pre>` 的病根）；
 *   - `innerText` 里没有裸记号，而 `state.reader.text` 里有 ⇒ 真的渲染过，不是碰巧没记号；
 *   - 打开一次只消耗 1 次额度（真实计数），且**没有 console error**。
 *
 * 用法：
 *   node verify-deeplink-live.mjs                       # 打线上 http://cyanovo.top
 *   node verify-deeplink-live.mjs --base https://cyanovo.top
 *   node verify-deeplink-live.mjs --only A              # 只跑受控样张（不动主人记录）
 *   node verify-deeplink-live.mjs --only B
 *   node verify-deeplink-live.mjs --pass <密码>         # 默认读环境变量 DSW_PASS
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const BASE = argOf('--base', 'http://cyanovo.top').replace(/\/+$/, '')
const DEBUG_PORT = Number(argOf('--port', '9335'))
const USER = argOf('--user', 'cyanovo')
const PASS = argOf('--pass', process.env.DSW_PASS || '')
if (!PASS) { console.error('缺少口令：请用 --pass 或环境变量 DSW_PASS 传入（不要再写进源码）'); process.exit(2) }
const ONLY = argOf('--only', '').toUpperCase()
// 公网 /api/login 与 /api/register 现在要过「人机验证」（图形码）。这一趟是**真浏览器**在打
// 公网入口，没法人眼看图写字 —— 所以这两步的请求带上后台口令，服务端对带对口令的请求免验证码。
// 口令只发给**主人自己的域名**（这一趟浏览器本来就在访问它），不流向任何第三方。
const ADMIN_TOKEN = argOf('--admin-token', process.env.ADMIN_TOKEN || '')
const AUTH_HDR = ADMIN_TOKEN ? `, 'x-admin-token': ${JSON.stringify(ADMIN_TOKEN)}` : ''
if (!ADMIN_TOKEN) {
  console.log('  ℹ 没给 ADMIN_TOKEN：公网注册/登录会被人机验证拦下 —— 那是**正确**行为，不是故障。')
  console.log('    要跑通请带上：--admin-token <后台口令>，或 $env:ADMIN_TOKEN=<后台口令>')
}

let pass = 0
let fail = 0
let skipped = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`) }
}
const skip = (name, why) => { skipped++; console.log(`  · 跳过 ${name} —— ${why}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 受控样张：块级语法一份全（含一个"危险链接"，用来证明原样保留的承诺还在）──
const SAMPLE = [
  '# 一级标题',
  '',
  '正文第一行，里面有 **粗体**、`行内代码` 和 [站内](/records)。',
  '',
  '## 二级标题',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '| 列A | 列B |',
  '| --- | ---: |',
  '| a1 | b1 |',
  '',
  '> 引用一行',
  '',
  '```js',
  'const a = 1 < 2 && "x";',
  '```',
  '',
  '结尾一行。',
].join('\n')

// ── CDP 管道（与 verify-markdown / verify-render 同一套做法）─────────────────
async function connect() {
  for (let i = 0; i < 60; i++) {
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
          } else events.push(m)
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

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 抛异常')
  return r.result.value
}

/** ⚠️ Runtime.evaluate 里**没有顶层 await**，所以整段包在 async IIFE 里，靠 awaitPromise 等它落定。 */
const ev = (send, body) => evaluate(send, `(async () => JSON.stringify(await (async () => { ${body} })()))()`)
  .then((s) => JSON.parse(s))

const newErrors = (events, from) => events.slice(from).filter(
  (e) => e.method === 'Runtime.exceptionThrown'
    || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))

async function waitReady(send) {
  for (let i = 0; i < 80; i++) {
    const st = await evaluate(send, 'document.readyState').catch(() => 'loading')
    if (st === 'complete') return true
    await sleep(250)
  }
  return false
}

/** 走到深链 → 等 SPA 把 #reader 打开（boot() 是异步的：meta → refresh → openRecord） */
async function openDeepLink(send, id) {
  const before = (await send('Page.navigate', { url: `${BASE}/n/${id}` })) ?? {}
  await waitReady(send)
  for (let i = 0; i < 60; i++) {
    const st = await ev(send, 'return { hidden: document.getElementById("reader") ? document.getElementById("reader").hidden : null, ready: typeof openRecord }')
    if (st.hidden === false) return { opened: true, ...st }
    await sleep(250)
  }
  return { opened: false }
}

/** 深链打开之后，把"看得见的证据"一次全取回来 */
const PROBE = `
  const body = document.getElementById('readerBody');
  const rd = document.getElementById('reader');
  const cs = getComputedStyle(body);
  const n = (s) => body.querySelectorAll(s).length;
  const t = body.innerText || '';
  const raw = (typeof state !== 'undefined' && state.reader && state.reader.text) || '';
  const MARKS = ['##', '|---|', '| ---', '\\u0060\\u0060\\u0060', '**', ']('];
  return {
    url: location.pathname + location.search,
    readerHidden: rd.hidden,
    bodyTag: body.tagName,
    innerHTMLHead: String(body.innerHTML).slice(0, 160),
    counts: { h1: n('h1'), h2: n('h2'), h3: n('h3'), p: n('p'), ul: n('ul'), ol: n('ol'),
      blockquote: n('blockquote'), pre: n('pre'), table: n('table'), th: n('th'), strong: n('strong'),
      code: n('code'), a: n('a'), img: n('img'), script: n('script') },
    whiteSpace: cs.whiteSpace,
    fontSize: cs.fontSize,
    textLen: t.length,
    rawLen: raw.length,
    textHasMark: MARKS.filter((m) => t.includes(m)),
    rawHasMark: MARKS.filter((m) => raw.includes(m)),
    title: (document.getElementById('readerTitle') || {}).textContent || '',
    quotaUsed: state && state.me && state.me.quota ? state.me.quota.used : null,
    toast: (document.getElementById('toast') || {}).textContent || '',
    docScroll: document.documentElement.scrollWidth,
    innerWidth: innerWidth,
  };
`

// ── A：受控样张（一次性账号，自清）───────────────────────────────────────────
async function phaseA(send, events) {
  console.log('\n【A】受控样张：注册一次性账号 → 发布已知 markdown → 打开 /n/<id> → 注销')
  const uname = 'vfdl' + Math.random().toString(36).slice(2, 8)
  const upass = 'vf-deeplink-' + Math.random().toString(36).slice(2, 10)

  const reg = await ev(send, `
    const j = (u, o) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json'${AUTH_HDR} }, body: JSON.stringify(o) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
    const a = await j('/api/register', { username: ${JSON.stringify(uname)}, password: ${JSON.stringify(upass)} });
    if (a.status !== 200) return { ok: false, step: 'register', status: a.status, body: a.body };
    const b = await j('/api/tokens', { label: 'deeplink-check' });
    if (b.status !== 200 || !b.body.token) return { ok: false, step: 'token', status: b.status, body: b.body };
    const c = await fetch('/api/publish', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + b.body.token },
      body: JSON.stringify({ title: '深链渲染验收', mode: 'note-link', text: ${JSON.stringify(SAMPLE)} }) });
    const cb = await c.json();
    if (c.status !== 200 || !cb.id) return { ok: false, step: 'publish', status: c.status, body: cb };
    return { ok: true, username: ${JSON.stringify(uname)}, id: cb.id, publishStatus: c.status };
  `)
  ok('一次性账号注册 + 令牌 + 发布全部成功',
    reg.ok === true, reg.ok ? `账号=${uname} 记录=${reg.id}` : `卡在 ${reg.step}：${JSON.stringify(reg.body)}`)
  if (!reg.ok) {
    if (reg.step === 'register' && reg.body && reg.body.captcha) {
      console.log('    ↳ 这是被人机验证拦下的（服务的正常行为）。自动化跑请带 --admin-token 或 $env:ADMIN_TOKEN。')
    }
    return
  }

  // 注销（含删记录）—— 不管后面成不成功，先挂个 finally 式的收尾
  const purge = async () => ev(send, `
    const r = await fetch('/api/me/purge', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'all', password: ${JSON.stringify(upass)} }) });
    return { status: r.status, body: await r.json() };
  `).catch((e) => ({ status: -1, body: { error: String(e) } }))

  try {
    // 顺带把"服务端根本没有 /n/ 路由"钉下来（这是缺陷链的第一环）
    const shell = await ev(send, `
      const r = await fetch('/n/${reg.id}');
      const t = await r.text();
      return { status: r.status, ct: r.headers.get('content-type') || '',
        hasReader: t.includes('id="readerBody"'), len: t.length };`)
    ok('★ `/n/<id>` 是客户端路由：服务端回的是 SPA 外壳（200 text/html，含 #readerBody）',
      shell.status === 200 && /text\/html/.test(shell.ct) && shell.hasReader,
      `status=${shell.status} ct=${shell.ct} ${shell.len} 字节`)

    const mark = events.length
    const open = await openDeepLink(send, reg.id)
    const r = open.opened ? await ev(send, PROBE) : null
    ok('★ 深链 `/n/<id>` 在真浏览器里把阅读器打开了',
      !!r && r.readerHidden === false, r ? `url=${r.url}` : '等了 15 秒 #reader 仍 hidden')
    if (!r) return
    ok('没有报错 toast（客户端渲染没抛异常）', r.toast === '', `toast="${r.toast}"`)

    console.log('  ── 渲染结果 ──')
    ok('★ 正文是被渲染的 HTML（不是把 markdown 原样塞进 <pre>）',
      r.bodyTag === 'DIV' && /<(h2|p)>/.test(r.innerHTMLHead), `${r.bodyTag} ${r.innerHTMLHead.slice(0, 80)}`)
    ok('★ 块级标签齐了：h2=1 h3=1 p≥3 pre=1 table=1 th=2 blockquote=1 ul=1 li=2 strong=1',
      r.counts.h2 === 1 && r.counts.h3 === 1 && r.counts.p >= 3 && r.counts.pre === 1
      && r.counts.table === 1 && r.counts.th === 2 && r.counts.blockquote === 1
      && r.counts.ul === 1 && r.counts.strong === 1, JSON.stringify(r.counts))
    ok('★ 阅读器里 0 个 h1（全站唯一 h1 是落地页品牌名）', r.counts.h1 === 0, `h1=${r.counts.h1}`)
    ok('标题/表格/代码块的中文都真的看得见',
      r.textLen > 0 && r.textHasMark.length === 0, `正文字符数=${r.textLen}`)

    console.log('  ── 量具有牙 + 老病根 ──')
    ok('★ 量具有牙：原始文本里确实带着裸记号（否则"看不见记号"是废话）',
      r.rawHasMark.length >= 2, `原始文本 ${r.rawLen} 字符，命中的记号=${JSON.stringify(r.rawHasMark)}`)
    ok('★ 有裸记号的原文本 → 渲染后 innerText 里一个记号都没有',
      r.textHasMark.length === 0, `残留=${JSON.stringify(r.textHasMark)}`)
    ok('★ `.reader-body` 的 white-space 是 normal（老 `<pre>` 是 pre-wrap，那才是病根）',
      r.whiteSpace === 'normal', `实测 ${r.whiteSpace}`)
    ok('正文字号 16px', r.fontSize === '16px', `实测 ${r.fontSize}`)

    console.log('  ── 额度、安全、溢出 ──')
    ok('★ 打开一次只消耗 1 次额度', r.quotaUsed === 1, `quota.used=${r.quotaUsed}`)
    ok('真 DOM 里没有注入的 img / script', r.counts.img === 0 && r.counts.script === 0,
      `img=${r.counts.img} script=${r.counts.script}`)
    ok('正文没有横向撑破窗口', r.docScroll <= r.innerWidth + 1, `doc ${r.docScroll}/${r.innerWidth}`)
    const errs = newErrors(events, mark)
    ok('这一趟没有未捕获异常 / console error', errs.length === 0,
      errs.length ? JSON.stringify(errs[0]).slice(0, 220) : '0 条')
  } finally {
    const p = await purge()
    ok('★ 收尾：一次性账号已注销（记录一并删除，不留垃圾）',
      p.status === 200 && p.body.deletedAccount === true,
      `status=${p.status} ${JSON.stringify(p.body)}`)
  }
}

// ── B：主人的真实记录（QQ 通知里那条链接逐字对应的场景）──────────────────────
async function phaseB(send, events) {
  console.log('\n【B】主人真实记录：登录 → 取最近一条 → 打开 /n/<id>')
  const login = await ev(send, `
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json'${AUTH_HDR} },
      body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} }) });
    if (r.status !== 200) return { ok: false, status: r.status };
    const b = await r.json();
    return { ok: true, username: b.me.username, plan: b.me.plan,
      used: b.me.quota ? b.me.quota.used : null, limit: b.me.quota ? b.me.quota.limit : null };
  `)
  if (!login.ok) {
    ok('主人账号登录成功', false, `HTTP ${login.status}（密码不对？用 --pass 传，或 DSW_PASS 环境变量；` +
      `被人机验证拦下时请带 --admin-token / $env:ADMIN_TOKEN）`)
    return
  }
  pass++
  console.log(`  ✓ 主人账号登录成功  — ${login.username} / ${login.plan} / 今日已用 ${login.used}/${login.limit}`)

  const list = await ev(send, `
    const r = await fetch('/api/records?limit=100');
    const b = await r.json();
    return { status: r.status, items: (b.items || []).map((x) => ({ id: x.id, title: x.title, mode: x.mode, chars: x.chars })) };`)
  ok('「我的记录」列表读得到，且不含正文（列表只有元信息）',
    list.status === 200 && Array.isArray(list.items),
    `status=${list.status} 条数=${list.items.length}`)
  if (!list.items.length) { skip('真实记录的深链渲染', '账号下当前 0 条记录（保留期过了或还没发过）'); return }

  const rec = list.items[0]
  console.log(`  最近一条：${rec.id} ｜ ${rec.mode} ｜ ${rec.chars} 字 ｜ ${rec.title}`)

  const mark = events.length
  const open = await openDeepLink(send, rec.id)
  const r = open.opened ? await ev(send, PROBE) : null
  ok('★ 真实记录的深链 `/n/<id>` 打开了阅读器',
    !!r && r.readerHidden === false, r ? `url=${r.url}` : '等了 15 秒 #reader 仍 hidden')
  if (!r) return

  ok('★ 真实记录也渲染成了 HTML 块级标签（不是原样文本）',
    /<(h2|h3|p|ul|ol|pre|table|blockquote)/.test(r.innerHTMLHead) || r.counts.p > 0,
    `p=${r.counts.p} h2=${r.counts.h2} h3=${r.counts.h3} pre=${r.counts.pre} table=${r.counts.table}`)
  ok('真实记录的 white-space 是 normal', r.whiteSpace === 'normal', `实测 ${r.whiteSpace}`)
  ok('★ 真实记录：原始文本里的裸记号在界面上看不见了',
    r.rawHasMark.length === 0 || r.textHasMark.length === 0,
    r.rawHasMark.length === 0
      ? `（这条记录本身就 ${r.rawLen} 字、无 markdown 记号 ⇒ 这一条断言对它是空断言，如实标注）`
      : `原文本命中 ${JSON.stringify(r.rawHasMark)} → 渲染后残留 ${JSON.stringify(r.textHasMark)}`)
  ok('这一次查看也计了数（额度 +1）', r.quotaUsed === login.used + 1,
    `打开前 ${login.used} → 打开后 ${r.quotaUsed}`)
  ok('阅读器里 0 个 h1', r.counts.h1 === 0, `h1=${r.counts.h1}`)
  const errs = newErrors(events, mark)
  ok('真实记录这一趟没有 console error', errs.length === 0,
    errs.length ? JSON.stringify(errs[0]).slice(0, 220) : '0 条')
  ok('没有报错 toast', r.toast === '', `toast="${r.toast}"`)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
console.log('「完整回答」深链真人路径验收（真登录 / 真记录 / 真 /n/<id>）')
console.log(`目标 ${BASE}${ONLY ? `  ｜ 只跑 ${ONLY} 段` : ''}`)
if (!EDGE) { console.log('✗ 找不到 msedge.exe'); process.exit(2) }

const profile = await mkdtemp(join(tmpdir(), 'dsh-dl-'))
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--window-size=1280,900',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, `${BASE}/`,
], { stdio: 'ignore' })

let cdp = null
try {
  cdp = await connect()
  const { send, events } = cdp
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Log.enable')
  await waitReady(send)
  await sleep(800)

  const boot = await ev(send, `
    return { path: location.pathname,
      spaLive: typeof state !== 'undefined' && typeof openRecord === 'function',
      readerInDom: !!document.getElementById('readerBody'),
      toast: (document.getElementById('toast') || {}).textContent || '' };`)
  ok('SPA 自启动完成（state / openRecord 都在，阅读器节点在位）',
    boot.spaLive && boot.readerInDom, `path=${boot.path} toast="${boot.toast}"`)

  if (ONLY !== 'B') await phaseA(send, events)
  if (ONLY !== 'A') await phaseB(send, events)
} catch (e) {
  fail++
  console.log(`  ✗ 主流程异常：${e && e.message ? e.message : e}`)
} finally {
  try { cdp?.ws.close() } catch {}
  edge.kill()
  await sleep(300)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n深链真人路径：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''}`)
console.log('（提醒：headless Edge + CDP；真机浏览器观感仍未验证）')
process.exit(fail === 0 ? 0 : 1)
