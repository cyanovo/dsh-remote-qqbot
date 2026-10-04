#!/usr/bin/env node
/**
 * _docs-shots.mjs —— 给**教程文档页**拍图（真浏览器 headless Edge + CDP）。
 *
 * 为什么要有它：教程文档必须「有图」，而模型读不了图 ⇒ 图只能靠真跑出来。
 * 这个脚本自己起一个**本地临时实例**（temp 数据目录），所以：
 *   · 不碰线上 data.json，不留测试账号（拍完自动 purge + 删数据目录）
 *   · 想拍几张拍几张，随便造记录
 *
 * 产物（默认写进 public/docs-img/）：
 *   home-desktop.png   首页（桌面 1440x900，第一屏）
 *   home-mobile.png    首页（手机 390x844 @2x，第一屏）
 *   docs-desktop.png   本教程页（桌面 1440x900）—— 三栏布局 + 一张示意图
 *   account-bind.png   账号页：绑定插件区块 + 我的令牌
 *   records.png        我的记录页（2 条真记录）
 *   reader.png         点开一条记录后的阅读器（排好版的原文）
 *
 * 用法：
 *   node _docs-shots.mjs [--dir public] [--out public/docs-img] [--port 18800]
 * 零依赖：CDP 走 node 22 自带的全局 WebSocket。
 *
 * ⚠️ 顺序上有两处不能反：
 *   ① 教程页那张图必须在**第 1 章**拍（第 2 章里嵌着 docs-desktop.png 自己，
 *      先拍自己会拍到一张坏图）；
 *   ② 账号页/记录页必须在**注册并 reload 之后**拍 —— 注册是页面里 fetch 的，
 *      不 reload 的话 app.js 的 state.me 还是 null，账号页只会显示登录表单。
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
const ROOT = path.resolve(__dirname, argOf('--dir', 'public'))
const OUT = path.resolve(__dirname, argOf('--out', 'public/docs-img'))
const SERVER = path.resolve(__dirname, argOf('--server', 'server.mjs'))
const PORT = Number(argOf('--port', String(18800 + Math.floor(Math.random() * 300))))
const BASE = `http://127.0.0.1:${PORT}`
const DEBUG_PORT = 9600 + Math.floor(Math.random() * 300)

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p))
if (!EDGE) { console.error('找不到 msedge.exe'); process.exit(2) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-docsshots-'))
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-docsedge-'))
const STAMP = Date.now().toString(36).slice(-6)
const USER = `vfdocs${STAMP}`
const PASS = `docs-shot-${STAMP}`

let edge = null
let cdp = null
let child = null
let pass = 0
const fails = []
function chk(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else {
    fails.push(name + (extra ? ` — ${extra}` : ''))
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}
const cleanup = async () => {
  try { cdp?.ws.close() } catch {}
  try { edge?.kill() } catch {}
  try { child?.kill('SIGKILL') } catch {}
  await sleep(300)
  await fs.promises.rm(PROFILE, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rm(DATA, { recursive: true, force: true }).catch(() => {})
}
const done = async (code) => { await cleanup(); process.exit(code) }
process.on('uncaughtException', (e) => { console.error('崩了：', e); cleanup().then(() => process.exit(2)) })

/* ── 造两份「完整回答」的样张 ───────────────────────────────────────────── */
const SAMPLE_1 = [
  '## 这一轮做了什么',
  '',
  '把教程文档页补上了：三栏布局（章节 / 正文 / 本页目录），8 章正文，',
  '配了 **6 张真截图 + 6 张示意图 + 3 张界面模拟图**。',
  '',
  '### 改了哪些文件',
  '',
  '| 文件 | 改动 |',
  '| --- | --- |',
  '| public/docs.js | 新增：章节内容 + 渲染 + 目录跟随 |',
  '| public/docs-figs.js | 新增：插图库（内联 SVG + DOM 模拟图） |',
  '| public/docs.css | 新增：三栏样式，跟随深浅色主题 |',
  '',
  '### 怎么读这段代码',
  '',
  '```js',
  "// 只负责切视图，内容仍由 docs.js 渲染",
  "if (location.hash.indexOf('#docs') === 0) goto('docs')",
  '```',
  '',
  '> 一条硬约束：现有 URL 一个都不能变，80 端口继续服务、不加 HSTS。',
  '',
  '- 四个既有视图原样保留',
  '- 新增的第五个视图是**加法**，不是替换',
  '- 图片全部本地，无 CDN、无外链字体',
  '',
  '最后一步：跑一遍验收脚本，确认控制台 0 报错。',
].join('\n')

const SAMPLE_2 = [
  '## 结论',
  '',
  '手机端那个「看着发虚」的问题，根因不是排版，是**布局视口被撑宽了**。',
  '',
  '1. 长 URL 撑破正文，最多超出 84px',
  '2. Chrome 移动端不会给你横向滚动条，而是**把整页按更宽的画布排版**',
  '3. 于是 16.5px 的字被等比缩小，看着就"发虚"',
  '',
  '修法是给正文加 `overflow-wrap: anywhere` —— 一条声明解决了 90% 的问题。',
].join('\n')

/* ── CDP ───────────────────────────────────────────────────────────────── */
async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('ws 连不上')) })
        let id = 0
        const pending = new Map()
        sock.onmessage = (ev) => {
          const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
          if (!m.id) return
          const p = pending.get(m.id)
          pending.delete(m.id)
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
        }
        const send = (method, params = {}) => new Promise((res, rej) => {
          const i = ++id
          pending.set(i, { res, rej })
          sock.send(JSON.stringify({ id: i, method, params }))
        })
        return { ws: sock, send }
      }
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error(`Edge 调试端口 ${DEBUG_PORT} 连不上`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  console.log(`教程拍图：本地实例 ${BASE}`)
  console.log(`输出目录：${OUT}`)

  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DSH_WEB_DATA: DATA, DSH_WEB_PORT: String(PORT), DSH_WEB_HOST: '127.0.0.1', DSH_WEB_ROOT: ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (b) => { logs += b.toString() })
  child.stderr.on('data', (b) => { logs += b.toString() })
  let up = false
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/health')).ok) { up = true; break } } catch {}
    await sleep(100)
  }
  if (!up) { console.error('本地实例起不来：\n' + logs); return done(2) }
  chk('本地临时实例已就绪', true)

  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`, BASE + '/',
  ], { stdio: 'ignore' })
  const { ws, send } = await connect()
  cdp = { ws }
  await send('Runtime.enable')
  await send('Page.enable')

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || ''))
    return r.result.value
  }
  const ready = async (ms = 900) => {
    for (let i = 0; i < 80; i++) {
      const s = await evaluate('document.readyState').catch(() => 'loading')
      if (s === 'complete') break
      await sleep(150)
    }
    await sleep(ms)
  }
  const viewport = async (width, height, dsf, mobile) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: dsf, mobile: !!mobile,
      screenWidth: width, screenHeight: height,
    })
  }
  /** 强制加载所有 <img> 并等它们真有像素；返回至今没加载成功的 src */
  const imagesReady = async (timeout = 8000) => {
    const expr = `(async () => {
      const imgs = Array.from(document.images).filter((i) => i.src && !/^data:/.test(i.src));
      imgs.forEach((i) => { i.loading = 'eager'; });
      await Promise.all(imgs.map((i) => (i.complete && i.naturalWidth > 0)
        ? Promise.resolve() : i.decode().catch(() => {})));
      return JSON.stringify(imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute('src')));
    })()`
    const deadline = Date.now() + timeout
    let bad = []
    do {
      bad = JSON.parse(await evaluate(expr))
      if (!bad.length) return []
      await sleep(300)
    } while (Date.now() < deadline)
    return bad
  }
  const shot = async (name, note) => {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const buf = Buffer.from(r.data, 'base64')
    const file = path.join(OUT, name + '.png')
    fs.writeFileSync(file, buf)
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    chk(`${name}.png 写出且是合法 PNG（${buf.length} B）${note ? ' · ' + note : ''}`, isPng && buf.length > 3000)
    return buf.length
  }

  /* ── 1) 首页（桌面第一屏）──────────────────────────────────────────── */
  await viewport(1440, 900, 1, false)
  await send('Page.reload', {})
  await ready(1400)
  const homeH1 = await evaluate(`(document.querySelector('section[data-view="overview"] h1') || {}).textContent || ''`)
  chk('首页渲染出来了（h1 非空）', homeH1.trim().length > 4, homeH1.trim().slice(0, 40))
  await shot('home-desktop', '1440x900')

  /* ── 2) 首页（手机第一屏）──────────────────────────────────────────── */
  await viewport(390, 844, 2, true)
  await sleep(600)
  await shot('home-mobile', '390x844 @2x')

  /* ── 3) 建号 + 发两条记录（都在浏览器里 fetch，cookie 自然落在浏览器）── */
  const made = await evaluate(`(async () => {
    const j = (u, o, h) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...(h || {}) }, body: JSON.stringify(o) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const a = await j('/api/register', { username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} });
    if (a.status !== 200) return { ok: false, step: 'register', status: a.status, body: a.body };
    const b = await j('/api/tokens', { label: 'docs-shot' });
    if (b.status !== 200 || !b.body.token) return { ok: false, step: 'token', status: b.status, body: b.body };
    const auth = { authorization: 'Bearer ' + b.body.token };
    const c = await j('/api/publish', { title: '教程文档页做完了', mode: 'note-link', text: ${JSON.stringify(SAMPLE_1)} }, auth);
    if (c.status !== 200 || !c.body.id) return { ok: false, step: 'publish1', status: c.status, body: c.body };
    const d = await j('/api/publish', { title: '手机端排版根因定位', mode: 'note', text: ${JSON.stringify(SAMPLE_2)} }, auth);
    if (d.status !== 200 || !d.body.id) return { ok: false, step: 'publish2', status: d.status, body: d.body };
    return { ok: true, id: c.body.id, id2: d.body.id };
  })()`)
  chk('临时账号 + 2 条记录已造好', made && made.ok === true, made ? JSON.stringify(made).slice(0, 160) : 'null')
  if (!made || !made.ok) { console.log('服务端日志：\n' + logs); return done(1) }
  // 必须 reload：注册是页面里 fetch 的，boot 早就跑完了，state.me 还是 null
  await viewport(1440, 900, 1, false)
  await evaluate(`location.reload(); true`)
  await ready(1600)
  const who = await evaluate(`(document.querySelector('#topRight') || {}).innerText || ''`)
  chk('reload 后 SPA 认出了登录态', who.indexOf(USER) >= 0, who.replace(/\n/g, ' ｜ ').slice(0, 60))

  /* ── 4) 教程页（桌面三栏）——必须在第 1 章拍 ───────────────────────── */
  await evaluate(`location.hash = '#docs/what'; true`)
  await sleep(1300)
  const bad = await imagesReady()
  chk('教程页第 1 章里的图片全部加载成功（0 张坏图）', bad.length === 0, bad.join(', '))
  const docsShape = await evaluate(`(() => {
    const v = document.querySelector('section[data-view="docs"]');
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height), vis: b.width > 0 && b.height > 0 }; };
    return JSON.stringify({ hidden: v ? v.hidden : null, nav: r('#docsNav'), body: r('#docsBody'), toc: r('#docsToc'),
      figs: document.querySelectorAll('#docsBody .doc-fig').length, svgs: document.querySelectorAll('#docsBody svg').length,
      imgs: document.querySelectorAll('#docsBody img').length, title: (document.querySelector('#viewTitle') || {}).textContent,
      cols: getComputedStyle(document.querySelector('.docs')).gridTemplateColumns });
  })()`)
  console.log('  教程页几何：' + docsShape)
  const ds = JSON.parse(docsShape)
  chk('第五个视图存在且已显示（docs.hidden === false）', ds.hidden === false)
  chk('左栏与中栏都可见（宽度 > 0）', !!(ds.nav && ds.nav.vis && ds.body && ds.body.vis))
  chk('桌面 1440 下右栏目录也可见（三栏）', !!(ds.toc && ds.toc.vis), ds.cols)
  chk('中栏正文宽度 ≥ 640px（1440 屏下不该被挤扁）', !!(ds.body && ds.body.w >= 640), ds.body && String(ds.body.w))
  chk('教程页确实有图（内联 SVG ≥ 1 且截图 img ≥ 1）', ds.svgs >= 1 && ds.imgs >= 1, `svg=${ds.svgs} img=${ds.imgs}`)
  chk('页头标题是「教程文档」', (ds.title || '').indexOf('教程文档') >= 0, String(ds.title))
  await shot('docs-desktop', '教程页 · 三栏')

  /* ── 5) 账号页（绑定区块）──────────────────────────────────────────── */
  await evaluate(`document.querySelector('.nav-item[data-view="account"]').click(); true`)
  await sleep(1200)
  const bindInfo = await evaluate(`(() => {
    const hs = Array.from(document.querySelectorAll('#accountCard h2'));
    const t = hs.find((e) => /绑定/.test(e.textContent || '')) || null;
    const sc = document.querySelector('#scroll');
    if (t && sc) { const top = t.getBoundingClientRect().top - sc.getBoundingClientRect().top; sc.scrollTop = Math.max(0, sc.scrollTop + top - 76); }
    return t ? (t.textContent || '').replace(/\\s+/g, ' ').slice(0, 60) : '';
  })()`)
  chk('账号页找到了「绑定 DSH 插件」标题并滚到它', bindInfo.length > 0, bindInfo)
  await sleep(700)
  await shot('account-bind', '账号页 · 绑定插件 + 我的令牌')

  /* ── 6) 我的记录 ───────────────────────────────────────────────────── */
  await evaluate(`document.querySelector('.nav-item[data-view="records"]').click(); true`)
  await sleep(900)
  const recInfo = await evaluate(`(() => { const s = document.querySelector('#scroll'); if (s) s.scrollTop = 0;
    const n = document.querySelectorAll('#recordsCard .rec').length; const t = (document.querySelector('#recordsCard') || {}).innerText || '';
    return JSON.stringify({ n, first: t.split('\\n').slice(0, 3).join(' ｜ ').slice(0, 90) }); })()`)
  console.log('  记录页：' + recInfo)
  chk('记录页有 2 条记录且都看得见', JSON.parse(recInfo).n === 2, recInfo)
  await shot('records', '我的记录')

  /* ── 7) 阅读器（深链 /n/<id>）─────────────────────────────────────── */
  await evaluate(`location.hash = ''; location.pathname = '/n/${made.id}'; true`)
  await ready(1800)
  const rd = await evaluate(`(() => {
    const r = document.getElementById('reader');
    const body = document.getElementById('readerBody');
    return JSON.stringify({ open: r ? !r.hidden : null, h: body ? body.querySelectorAll('h2,h3,h4').length : -1,
      table: body ? body.querySelectorAll('table').length : -1, pre: body ? body.querySelectorAll('pre').length : -1,
      li: body ? body.querySelectorAll('li').length : -1, bq: body ? body.querySelectorAll('blockquote').length : -1,
      ws: body ? getComputedStyle(body).whiteSpace : null });
  })()`)
  console.log('  阅读器：' + rd)
  const rj = JSON.parse(rd)
  chk('深链 /n/<id> 真的打开了阅读器', rj.open === true)
  // 注意：阅读器刻意不产出 h1，且把 markdown 的 # 映射成 h2、## 成 h3（有断言钉着），
  //       所以这里数 h2/h3/h4 的总数，而不是只数 h2。
  chk('阅读器把 markdown 渲染成块级元素（标题/表格/代码块/列表/引用都在）',
    rj.h >= 3 && rj.table >= 1 && rj.pre >= 1 && rj.li >= 3 && rj.bq >= 1, rd)
  chk('阅读器不是 pre-wrap 纯文本（white-space=normal）', rj.ws === 'normal', String(rj.ws))
  await shot('reader', '阅读器 · 排好版的原文')

  /* ── 8) 全量复扫：8 章都走一遍，断言每张图真的加载 + 每章都有插图 ──── */
  await evaluate(`location.pathname = '/'; location.hash = '#docs'; true`)
  await ready(1600)
  const ids = JSON.parse(await evaluate(`JSON.stringify((window.DOCS && window.DOCS.chapters || []).map((c) => c.id))`))
  chk('window.DOCS 暴露了 8 个章节', ids.length === 8, ids.join(','))
  let totalFigs = 0, totalSvgs = 0, totalImgs = 0
  const badAll = []
  for (const id of ids) {
    await evaluate(`window.DOCS.open(${JSON.stringify(id)}); true`)
    await sleep(450)
    const bads = await imagesReady(5000)
    if (bads.length) badAll.push(id + ': ' + bads.join(','))
    const c = JSON.parse(await evaluate(`JSON.stringify({
      figs: document.querySelectorAll('#docsBody .doc-fig').length,
      svgs: document.querySelectorAll('#docsBody svg').length,
      imgs: document.querySelectorAll('#docsBody img').length,
      toc: document.querySelectorAll('#docsToc .docs-toc-link').length,
      hs: document.querySelectorAll('#docsBody h2, #docsBody h3').length,
      navOn: (document.querySelector('.docs-nav-item.on') || {}).getAttribute ? document.querySelector('.docs-nav-item.on').getAttribute('data-ch') : null
    })`))
    totalFigs += c.figs; totalSvgs += c.svgs; totalImgs += c.imgs
    chk(`第「${id}」章：有插图、有目录锚点、导航高亮正确`,
      c.figs >= 1 && c.hs >= 2 && c.toc >= 2 && c.navOn === id,
      JSON.stringify(c))
  }
  chk('8 章里没有一张坏图', badAll.length === 0, badAll.join(' ｜ '))
  chk('全站插图总量够多（图 ≥ 15 张：SVG + 截图）', totalFigs >= 15, `figs=${totalFigs} svg=${totalSvgs} img=${totalImgs}`)
  console.log(`  全量：${totalFigs} 张插图（其中内联 SVG ${totalSvgs}、真截图 ${totalImgs}）`)

  /* ── 9) 手机端教程页：不许横向滚动 ───────────────────────────────── */
  await viewport(390, 844, 2, true)
  await sleep(600)
  const mob = await evaluate(`(() => {
    const v = document.querySelector('section[data-view="docs"]');
    const sc = document.querySelector('#scroll');
    const wide = Array.from(document.querySelectorAll('#docsBody *')).filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && (b.right > document.documentElement.clientWidth + 1 || b.left < -1);
    }).map((e) => e.tagName + '.' + (e.className || ''));
    return JSON.stringify({ scrollW: sc.scrollWidth, clientW: sc.clientWidth,
      docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth,
      toc: getComputedStyle(document.querySelector('#docsToc')).display,
      navDisplay: getComputedStyle(document.querySelector('#docsNav')).display,
      overflowing: wide.slice(0, 6) });
  })()`)
  console.log('  手机端：' + mob)
  const mj = JSON.parse(mob)
  chk('手机端不产生横向滚动（scrollWidth == clientWidth）', mj.docScrollW <= mj.docClientW + 1, mob)
  chk('手机端没有元素伸出屏幕外', mj.overflowing.length === 0, JSON.stringify(mj.overflowing))
  chk('手机端右栏目录已收起、章节条改成横向滚动', mj.toc === 'none' && mj.navDisplay === 'flex', mob)

  /* ── 10) 清场：注销这个临时账号（连记录一起）──────────────────────── */
  await viewport(1440, 900, 1, false)
  await evaluate(`location.pathname = '/'; true`)
  await ready(1400)
  const purged = await evaluate(`(async () => {
    const r = await fetch('/api/me/purge', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'all', password: ${JSON.stringify(PASS)} }) });
    return JSON.stringify({ status: r.status, body: await r.json().catch(() => ({})) });
  })()`)
  console.log('  清场：' + purged)
  const pj = JSON.parse(purged)
  chk('临时账号已注销（记录一并删掉）', pj.status === 200 && pj.body && pj.body.deletedAccount === true, purged)
  // 2026-10-04 审计 H5：/health 只回 {ok:true}，数字在 /health/detail（要后台口令）。
  // 本地实例的 admin-token 就在自己的临时 DATA 目录里。
  const localAdmin = fs.readFileSync(path.join(DATA, 'admin-token'), 'utf8').trim()
  const health = await (await fetch(BASE + '/health/detail', { headers: { 'x-admin-token': localAdmin } })).json()
  chk('本地实例回到「0 账号 / 0 记录」', health.users === 0 && health.records === 0, JSON.stringify(health))

  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.png'))
  console.log(`\n  ${OUT} 里现有 ${files.length} 张：${files.join(', ')}`)
  console.log(`\n${fails.length ? '❌' : '✅'} 拍图完成：通过 ${pass} / 失败 ${fails.length}`)
  if (fails.length) console.log('失败项：\n  - ' + fails.join('\n  - '))
  return done(fails.length ? 1 : 0)
}

main().catch(async (e) => { console.error('崩了：', e && e.message); await cleanup(); process.exit(2) })
