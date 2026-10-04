#!/usr/bin/env node
/**
 * verify-render.mjs —— **真浏览器**验收（headless Edge + CDP）。
 *
 * 为什么必须有这一层（2026-10-03 事故教训）：
 *   在这之前，网页端的验收只有两种量具 ——
 *     ① 逐字节比对（verify-landing.mjs）：证明"送出去的 HTML 是对的"；
 *     ② 无头 DOM 桩（verify-account-ui.mjs / verify-deeplink.mjs）：证明"代码路径走得通"。
 *   两种都**看不见 CSS**。于是 `.reader { display: flex }` 压过浏览器默认的
 *   `[hidden] { display: none }`，让「完整回答」阅读器（position:fixed; inset:0; z-index:30）
 *   **一直盖在整个页面上**，用户只看到 4 个字 —— 而上面两把尺子全绿。
 *   ⇒ 这一层量的是「**用户实际看得见什么**」：computedStyle + body.innerText。
 *
 * 用法：
 *   node verify-render.mjs                 # 打线上 http://cyanovo.top/
 *   node verify-render.mjs --dir public    # 起本地静态服务，量磁盘上这份文件
 *   node verify-render.mjs --url https://cyanovo.top/
 *   node verify-render.mjs --dir .tmp-broken   # 反向校验：证明这把尺子抓得住那个 bug
 *
 * 零依赖：静态服务用 node:http，CDP 用 node 22 内置的全局 WebSocket。
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve } from 'node:path'

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const argvPlain = () => argv.find((a) => a.startsWith('http'))
const DIR = argOf('--dir', null)
const LIVE = argOf('--url', argvPlain() ?? 'http://cyanovo.top/')
const DEBUG_PORT = Number(argOf('--port', '9333'))

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 本地静态服务（只在 --dir 时启用）────────────────────────────────────────
async function serveDir(dir) {
  const root = resolve(dir)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
  // /api/* 依赖线上真实响应（形状必须真，否则 app.js 会抛异常、把结论污染成假红）
  const apiCache = new Map()
  const srv = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (path.startsWith('/api/')) {
      try {
        if (!apiCache.has(path)) {
          const r = await fetch(new URL(path, 'http://cyanovo.top'), { headers: { accept: 'application/json' } })
          apiCache.set(path, { status: r.status, body: await r.text() })
        }
        const hit = apiCache.get(path)
        res.writeHead(hit.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
        return res.end(hit.body)
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"ok":false}')
      }
    }
    const file = path === '/' ? 'index.html' : path.slice(1)
    try {
      const buf = await readFile(join(root, file))
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
      res.end(buf)
    } catch {
      const html = await readFile(join(root, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(html)
    }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, url: `http://127.0.0.1:${srv.address().port}/` }
}

// ── CDP 极简客户端 ────────────────────────────────────────────────────────
async function connect(url) {
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

// ⚠️ 探针里踩过三个坑（第一版自己就中招了，记在这里免得下次重犯）：
//   ① `[data-view]` 同时匹配**导航按钮**和 `<section>` —— 第一版把 4 个导航按钮也算成"可见的 view"，
//      于是"只有一个 section 可见"这条断言永远为假 ⇒ 必须用 `section[data-view]`。
//   ② `document.querySelector('h1')` 命中的是顶栏 `#viewTitle`（永远是「首页」），
//      不是落地页大标题 ⇒ 必须限定在 overview 这个 section 内取。
//   ③ 必须再问一句"屏幕正中**最上层**是谁"（elementFromPoint）。被遮罩盖住时，
//      里面的文字照样留在 `innerText` 里 —— 光看文字会漏掉"看得见但被压住"这一类事故。
const PROBE = `(() => {
  const disp = (el) => (el ? getComputedStyle(el).display : 'no-element');
  const sections = [...document.querySelectorAll('section[data-view]')];
  const hero = document.querySelector('section[data-view="overview"]');
  const readerEl = document.getElementById('reader');
  const r = readerEl ? readerEl.getBoundingClientRect() : null;
  const hit = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
  const hitWhere = hit
    ? (hit.closest('#reader') ? '#reader' : ((hit.closest('section[data-view]') || {}).dataset || {}).view || hit.tagName)
    : 'none';
  return {
    reader: disp(readerEl),
    readerCovers: !!(r && r.width >= innerWidth - 1 && r.height >= innerHeight - 1),
    scrim: disp(document.getElementById('scrim')),
    toast: disp(document.getElementById('toast')),
    visibleSections: sections.filter((s) => disp(s) !== 'none').map((s) => s.dataset.view),
    sectionCount: sections.length,
    hitWhere,
    heroH1: hero && hero.querySelector('h1') ? hero.querySelector('h1').textContent.trim() : '',
    // 教程文档（2026-10-04 新增的第五个视图）：这三项用来证明它真的渲染了内容，
    // 而不是只剩一个空壳 section。
    docsFigs: document.querySelectorAll('#docsBody .doc-fig').length,
    docsSvg: document.querySelectorAll('#docsBody svg').length,
    docsChapters: document.querySelectorAll('.docs-nav-item').length,
    text: document.body.innerText.replace(/\\n{2,}/g, '\\n').trim(),
  };
})()`

async function main() {
  console.log('真浏览器验收（headless Edge + CDP）')
  console.log(`Edge: ${EDGE ?? '未找到！'}`)
  if (!EDGE) { console.log('无法继续：找不到 msedge.exe'); process.exit(2) }

  let local = null
  let target = LIVE
  if (DIR) {
    local = await serveDir(DIR)
    target = local.url
    console.log(`静态服务: ${target}  ← ${resolve(DIR)}`)
  } else {
    console.log(`目标: ${target}`)
  }

  const profile = await mkdtemp(join(tmpdir(), 'dsh-render-'))
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--window-size=390,844',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, target,
  ], { stdio: 'ignore' })

  let cdp = null
  try {
    cdp = await connect(target)
    const { send, events } = cdp
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Log.enable')

    // 等页面真的就绪（不能只等"连上了"）
    for (let i = 0; i < 80; i++) {
      const ready = await evaluate(send, 'document.readyState').catch(() => 'loading')
      if (ready === 'complete') break
      await sleep(250)
    }
    await sleep(1200) // 让 app.js 的 fetch 回来、render() 跑完

    console.log('\n【一】首屏到底看得见什么')
    const a = await evaluate(send, PROBE)
    ok('#reader 的 computed display 是 none（2026-10-03 事故点）', a.reader === 'none', `实测 display=${a.reader}`)
    ok('#reader 没有铺满整个视口', a.readerCovers === false, `实测铺满=${a.readerCovers}`)
    ok('屏幕正中**最上层**不是 #reader（被盖住的字也算"看不见"）', a.hitWhere !== '#reader', `实测最上层=${a.hitWhere}`)
    ok('#scrim（手机抽屉遮罩）是藏着的', a.scrim === 'none', `实测 display=${a.scrim}`)
    ok('#toast 是藏着的', a.toast === 'none', `实测 display=${a.toast}`)
    ok('页面里真有 5 个 section（探针没取错选择器）', a.sectionCount === 5, `实测 ${a.sectionCount} 个`)

    const shown = a.visibleSections
    ok('可见的 section 恰好只有 overview（首页）', shown.length === 1 && shown[0] === 'overview', `实测可见=[${shown.join(', ')}]`)

    ok('落地页大标题是品牌名，不是「完整回答」', a.heroH1.includes('DSH') && !a.heroH1.includes('完整回答'), `实测 hero h1="${a.heroH1}"`)

    const lines = a.text.split('\n').filter((l) => l.trim())
    ok('可见文字有实质内容（≥10 行）', lines.length >= 10, `实测 ${lines.length} 行`)
    ok('可见文字里有「每天 100 次」的额度承诺', a.text.includes('100 次'), '')
    ok('可见文字里有 ¥2.99 的赞助档', a.text.includes('2.99'), '')

    const onlyReader = a.text.replace(/\s+/g, '') === '完整回答'
    ok('可见文字**不是**只有「完整回答」四个字', !onlyReader, onlyReader ? '命中事故现象！' : `首行="${lines[0] ?? ''}"`)

    console.log('\n【二】导航真的能切（真点击、真 JS）')
    await evaluate(send, `document.querySelector('[data-view="account"]').click(); true`)
    await sleep(400)
    const b = await evaluate(send, PROBE)
    const shown2 = b.visibleSections
    ok('点「账号」后可见 section 是 account', shown2.length === 1 && shown2[0] === 'account', `实测可见=[${shown2.join(', ')}]`)
    ok('切到账号页后 #reader 仍是 none', b.reader === 'none', `实测 display=${b.reader}`)
    ok('切到账号页后屏幕正中也不是 #reader', b.hitWhere !== '#reader', `实测最上层=${b.hitWhere}`)
    // 说明：这个脚本用的是**全新临时浏览器 profile**（没有 cookie），所以对线上也是"未登录访客"。
    // 未登录时账号页应当渲染登录表单；绑定区与令牌区只在已登录时出现（app.js:220-238 那个分支）。
    // 下面第二条顺带是一条**安全断言**：未登录绝不能看到「绑定 DSH 插件」和「我的令牌」。
    ok('未登录访客在账号页看得见登录表单', b.text.includes('登录') && b.text.includes('注册'), '')
    ok('未登录访客看不到「绑定 DSH 插件」/「我的令牌」这些登录后才有的区块',
      !b.text.includes('绑定 DSH 插件') && !b.text.includes('我的令牌'),
      `实测含绑定区=${b.text.includes('绑定 DSH 插件')} 含令牌区=${b.text.includes('我的令牌')}`)
    ok('账号页看得见额度卡（每天 100 次 / 2.99）', b.text.includes('100 次') && b.text.includes('2.99'), '')

    console.log('\n【二之二】教程文档这一栏也能切（2026-10-04 新增的第五个视图）')
    await evaluate(send, `document.querySelector('.nav-item[data-view="docs"]').click(); true`)
    await sleep(700)
    const d = await evaluate(send, PROBE)
    ok('点「教程文档」后可见 section 恰好是 docs', d.visibleSections.length === 1 && d.visibleSections[0] === 'docs', `实测可见=[${d.visibleSections.join(', ')}]`)
    ok('教程页真的渲染了内容（章节按钮 ≥ 8 个）', d.docsChapters >= 8, `实测 ${d.docsChapters} 个章节按钮`)
    ok('教程页真的有插图（内联 SVG ≥ 1 且 figure ≥ 2）', d.docsSvg >= 1 && d.docsFigs >= 2, `实测 svg=${d.docsSvg} figure=${d.docsFigs}`)
    ok('教程页看得见人话（可见文字含「教程」/「插件」）', d.text.includes('教程') || d.text.includes('插件'), '')
    ok('教程页里 #reader 仍是 none（没有把阅读器顶上来）', d.reader === 'none', `实测 display=${d.reader}`)

    await evaluate(send, `document.querySelector('[data-view="overview"]').click(); true`)
    await sleep(400)
    const c = await evaluate(send, PROBE)
    const shown3 = c.visibleSections
    ok('点回「首页」能回到 overview', shown3.length === 1 && shown3[0] === 'overview', `实测可见=[${shown3.join(', ')}]`)

    console.log('\n【三】不能有 JS 报错（报错会把页面卡在半截）')
    const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))
    ok('没有未捕获异常 / console error', errors.length === 0, errors.length ? `实测 ${errors.length} 条：${JSON.stringify(errors[0]).slice(0, 200)}` : '0 条')

    console.log(`\n真浏览器验收：${pass} 通过 / ${fail} 失败`)
    console.log(fail === 0 ? '>>> 用户在真浏览器里看到的就是落地页 ✅' : '>>> 有问题 ❌')
  } finally {
    try { cdp?.ws.close() } catch {}
    edge.kill()
    await sleep(300)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
    local?.srv.close()
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => { console.error('验收脚本自己崩了：', err); process.exit(2) })
