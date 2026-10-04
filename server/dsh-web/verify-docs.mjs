#!/usr/bin/env node
/**
 * verify-docs.mjs —— 教程文档页的验收（真浏览器 headless Edge + CDP × 真 server.mjs）。
 *
 * 为什么单独一个脚本、而不是并进 verify-render.mjs：
 *   教程页是**新的一栏**，它有一堆别的视图没有的性质（三栏几何、8 章深链、右栏目录跟随、
 *   16 张插图、窄屏折成一栏）。混进首页那个脚本里，任何一条红都分不清是谁坏了。
 *
 * 全部断言都是**真量出来的**（getBoundingClientRect / getComputedStyle / naturalWidth /
 * 真点击 / 真 reload），没有一条是"正则扫源码看有没有出现过某个字符串"。
 * —— 本项目已经被"注释里出现的字面量"骗过三次。
 *
 * 用法：
 *   node verify-docs.mjs                    # 自己起一个本地临时实例（默认）
 *   node verify-docs.mjs --url https://cyanovo.top
 *   node verify-docs.mjs --dir <public 副本>   # 反向校验用
 * 退出码：0 全绿 / 1 有红 / 2 脚本自己崩了
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
const URL_ARG = argOf('--url', '')
const ROOT = path.resolve(__dirname, argOf('--dir', 'public'))
const SERVER = path.resolve(__dirname, argOf('--server', 'server.mjs'))
const PORT = Number(argOf('--port', String(18900 + Math.floor(Math.random() * 300))))
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 400)
const BASE = URL_ARG ? URL_ARG.replace(/\/$/, '') : `http://127.0.0.1:${PORT}`

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p))

let pass = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fails.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}
function group(title) { console.log(`\n【${title}】`) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-docs-'))
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-docsedge-'))
let child = null
let edge = null
let cdp = null

const cleanup = async () => {
  try { cdp?.ws.close() } catch {}
  try { edge?.kill() } catch {}
  try { child?.kill('SIGKILL') } catch {}
  await sleep(300)
  await fs.promises.rm(PROFILE, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rm(DATA, { recursive: true, force: true }).catch(() => {})
}
const done = async (code) => { await cleanup(); process.exit(code) }
process.on('uncaughtException', (e) => { console.error('验收脚本自己崩了：', e); cleanup().then(() => process.exit(2)) })
process.on('unhandledRejection', (e) => { console.error('验收脚本自己有未处理的 rejection：', e); cleanup().then(() => process.exit(2)) })

async function connect() {
  for (let i = 0; i < 100; i++) {
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
            if (m.method === 'Page.javascriptDialogOpening') {
              try { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}) } catch { /* noop */ }
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
  console.log('教程文档页验收：真浏览器（headless Edge + CDP）× ' + BASE)
  console.log(`public: ${ROOT}`)
  if (!EDGE) { console.log('无法继续：找不到 msedge.exe'); return done(2) }

  if (!URL_ARG) {
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
  }

  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--window-size=1440,900',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`, BASE + '/',
  ], { stdio: 'ignore' })

  const { ws, send, events } = await connect()
  cdp = { ws }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Log.enable')

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 抛异常')
    return r.result.value
  }
  const j = async (expr) => JSON.parse(await evaluate(expr))
  const ready = async (ms = 900) => {
    for (let i = 0; i < 90; i++) {
      const s = await evaluate('document.readyState').catch(() => 'loading')
      if (s === 'complete') break
      await sleep(150)
    }
    await sleep(ms)
  }
  const viewport = async (width, height, dsf = 1, mobile = false) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile, screenWidth: width, screenHeight: height })
    await sleep(350)
  }
  const scheme = async (dark) => {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
    await sleep(300)
  }
  /* ⚠️ 必须能容忍「docs.js 根本没加载」这种情况（比如脚本标签被删了）：
     那种时候 window.DOCS 是 undefined —— 探针要**如实报红**，不能自己崩掉。
     （第一版反向校验里，删掉 <script src="/docs.js"> 会让本脚本 exit 2"自己崩了"，
      看着像尺子坏了，其实是探针太脆。） */
  const gotoCh = async (id) => {
    await evaluate(`if (window.DOCS) window.DOCS.open(${JSON.stringify(id)}); true`)
    await sleep(450)
  }

  // 页内小工具：对比度（真值，不是估的）
  const CONTRAST = `(() => {
    const parse = (c) => { const m = String(c).match(/[\\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };
    const lum = (rgb) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
    const bgOf = (el) => { let n = el; while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor; const a = parse(c);
      if (a && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return a; n = n.parentElement; }
      return parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255]; };
    const ratio = (el) => { const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
      if (!fg) return -1; const L1 = lum(fg), L2 = lum(bg); const a = Math.max(L1, L2), b = Math.min(L1, L2);
      return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100; };
    const r = (s) => { const e = document.querySelector(s); return e ? ratio(e) : -1; };
    return JSON.stringify({
      lead: r('.docs-lead'), body: r('.docs-body p'), nav: r('.docs-nav-item'), toc: r('.docs-toc-link'),
      cap: r('.doc-fig figcaption'), code: r('.doc-code'), th: r('.doc-table th'), td: r('.doc-table td'),
      step: r('.doc-step span'), dts: r('.doc-faq dt'),
      pageBg: getComputedStyle(document.body).backgroundColor });
  })()`

  await ready(1400)

  /* ── 一、存在性与路由 ─────────────────────────────────────────────── */
  group('一、存在性与路由（新增的第五个视图，前四个一个字没动）')
  const shape = await j(`(() => {
    const secs = [...document.querySelectorAll('section[data-view]')];
    const disp = (el) => (el ? getComputedStyle(el).display : 'no-element');
    const docs = document.querySelector('section[data-view="docs"]');
    return JSON.stringify({
      count: secs.length, views: secs.map((s) => s.dataset.view),
      visible: secs.filter((s) => disp(s) !== 'none').map((s) => s.dataset.view),
      docsPresent: !!docs, navItems: document.querySelectorAll('.nav-item').length,
      navHasDocs: !!document.querySelector('.nav-item[data-view="docs"]'),
      heroH1: (document.querySelector('section[data-view="overview"] h1') || {}).textContent || '',
      reader: disp(document.getElementById('reader')),
    });
  })()`)
  ok('页面里有 5 个 section[data-view]（前四个 + 教程文档）', shape.count === 5, `实测 ${shape.count}：${shape.views.join(',')}`)
  ok('教程文档这个 section 存在', shape.docsPresent === true)
  ok('导航里有「教程文档」这一项（共 5 项）', shape.navHasDocs === true && shape.navItems === 5, `nav-item=${shape.navItems}`)
  ok('初始只显示首页（docs 是 hidden，不是"漏在外面"）', shape.visible.length === 1 && shape.visible[0] === 'overview', `可见=[${shape.visible.join(',')}]`)

  await evaluate(`document.querySelector('.nav-item[data-view="docs"]').click(); true`)
  await sleep(800)
  const afterClick = await j(`(() => {
    const secs = [...document.querySelectorAll('section[data-view]')];
    const disp = (el) => (el ? getComputedStyle(el).display : 'no-element');
    return JSON.stringify({
      visible: secs.filter((s) => disp(s) !== 'none').map((s) => s.dataset.view),
      title: (document.getElementById('viewTitle') || {}).textContent,
      chapters: document.querySelectorAll('.docs-nav-item').length,
      toc: document.querySelectorAll('#docsToc .docs-toc-link').length,
      h2: document.querySelectorAll('#docsBody h2').length,
      hash: location.hash,
    });
  })()`)
  ok('点「教程文档」后可见的恰好只有 docs', afterClick.visible.length === 1 && afterClick.visible[0] === 'docs', `可见=[${afterClick.visible.join(',')}]`)
  ok('页头标题变成「教程文档」', afterClick.title === '教程文档', String(afterClick.title))
  ok('★ 左栏列出 8 个章节（点进来不能是一块空壳）', afterClick.chapters === 8, `实测 ${afterClick.chapters}`)
  ok('★ 右栏目录有锚点（≥2 条）', afterClick.toc >= 2, `实测 ${afterClick.toc}`)
  ok('★ 正文真的渲染了（h2 ≥ 2 个）', afterClick.h2 >= 2, `实测 ${afterClick.h2}`)
  /* 点顶部导航**不该**改地址栏：goto() 对另外四个视图都不动 URL，教程页也不能例外
     （否则「点一下导航就多出 #docs/what」是新行为）。深链只由点章节/翻页产生。 */
  ok('点顶部导航不改地址栏（与其它四个导航项行为一致）', afterClick.hash === '', `实测 hash="${afterClick.hash}"`)

  const chip = await j(`(async () => {
    const items = document.querySelectorAll('.docs-nav-item');
    const item = items[2];
    if (!item) return JSON.stringify({ want: null, hash: location.hash, on: null, why: '左栏一个章节按钮都没有（docs.js 没渲染？）' });
    const want = item.getAttribute('data-ch');
    item.click();
    await new Promise((r) => setTimeout(r, 400));
    const on = document.querySelector('.docs-nav-item.on');
    return JSON.stringify({ want, hash: location.hash, on: on ? on.getAttribute('data-ch') : null });
  })()`)
  ok('点左栏章节才会写下 #docs/<章节>（可分享、可收藏、可刷新）',
    chip.hash === '#docs/' + chip.want && chip.on === chip.want, JSON.stringify(chip))
  await evaluate(`if (window.DOCS) window.DOCS.open('what'); true`)
  await sleep(400)

  /* ── 二、深链：8 章逐个「重新打开链接」───────────────────────────── */
  group('二、深链（每个章节都能用一个 URL 直达，刷新后还在那一章）')
  const ids = await j(`JSON.stringify((window.DOCS && window.DOCS.chapters || []).map((c) => c.id))`)
  ok('window.DOCS 暴露了 8 章', ids.length === 8, ids.join(','))
  for (const id of ids) {
    await evaluate(`location.hash = '#docs/${id}'; true`)
    await send('Page.reload', {})
    await ready(1300)
    const r = await j(`(() => {
      const secs = [...document.querySelectorAll('section[data-view]')];
      const disp = (el) => (el ? getComputedStyle(el).display : 'no-element');
      const on = document.querySelector('.docs-nav-item.on');
      return JSON.stringify({ visible: secs.filter((s) => disp(s) !== 'none').map((s) => s.dataset.view),
        on: on ? on.getAttribute('data-ch') : null, h: document.querySelectorAll('#docsBody h2, #docsBody h3').length,
        title: (document.getElementById('viewTitle') || {}).textContent });
    })()`)
    ok(`#docs/${id} 刷新后直接落在这一章（可见=docs、导航高亮=该章、正文有标题）`,
      r.visible.length === 1 && r.visible[0] === 'docs' && r.on === id && r.h >= 2 && r.title === '教程文档',
      JSON.stringify(r))
  }

  /* ── 三、三栏几何（真矩形，不是"看着像"）────────────────────────── */
  group('三、三栏几何（1440 三栏 / 1280 收掉右栏 / 390 一栏）')
  await viewport(1440, 900)
  await gotoCh('install')
  const g1440 = await j(`(() => {
    const rect = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect();
      return { x: Math.round(b.x), w: Math.round(b.width), vis: b.width > 0 && b.height > 0 }; };
    const t = document.querySelector('#docsToc');
    return JSON.stringify({ cols: getComputedStyle(document.querySelector('.docs')).gridTemplateColumns,
      nav: rect('#docsNav'), body: rect('#docsBody'), toc: rect('#docsToc'), tocDisplay: t ? getComputedStyle(t).display : 'none' });
  })()`)
  console.log('   1440：' + JSON.stringify(g1440))
  ok('1440 下左/中/右三栏都可见', g1440.nav.vis && g1440.body.vis && g1440.toc.vis)
  ok('1440 下中栏正文 ≥ 640px（不是被挤成一条）', g1440.body.w >= 640, `实测 ${g1440.body.w}px`)
  ok('1440 下三栏从左到右排列（nav.x < body.x < toc.x）', g1440.nav.x < g1440.body.x && g1440.body.x < g1440.toc.x)
  ok('1440 下整体不超出视口右边界', g1440.toc.x + g1440.toc.w <= 1440 + 1, `右边界 ${g1440.toc.x + g1440.toc.w}`)

  await viewport(1280, 900)
  const g1280 = await j(`(() => {
    const e = document.querySelector('#docsToc');
    const b = document.querySelector('#docsBody').getBoundingClientRect();
    return JSON.stringify({ tocDisplay: getComputedStyle(e).display, bodyW: Math.round(b.width),
      cols: getComputedStyle(document.querySelector('.docs')).gridTemplateColumns,
      docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth });
  })()`)
  console.log('   1280：' + JSON.stringify(g1280))
  ok('1280 下右栏目录收起（display:none）', g1280.tocDisplay === 'none')
  ok('1280 下正文拿回 ≥ 700px（把收掉右栏的位置还给正文）', g1280.bodyW >= 700, `实测 ${g1280.bodyW}px`)

  await viewport(390, 844, 2, true)
  await gotoCh('install')
  const g390 = await j(`(() => {
    /* "伸出屏幕外"要分两种：①**没人管**的溢出（真缺陷，会把布局视口撑宽）
       ②被横向滚动容器（pre / 表格包裹层）收住的溢出（正常，不该报红）。
       判据：往上找有没有 overflow-x 是 auto/scroll 的祖先。 */
    const contained = (e) => {
      let n = e.parentElement;
      while (n && n !== document.body) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
        n = n.parentElement;
      }
      return false;
    };
    const all = [...document.querySelectorAll('#docsBody *')].filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && (b.right > document.documentElement.clientWidth + 1 || b.left < -1);
    });
    const nav = document.querySelector('#docsNav'), toc = document.querySelector('#docsToc');
    const b = document.querySelector('#docsBody').getBoundingClientRect();
    return JSON.stringify({ navDisplay: getComputedStyle(nav).display, tocDisplay: getComputedStyle(toc).display,
      bodyW: Math.round(b.width), docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth,
      navScrollable: nav.scrollWidth > nav.clientWidth,
      overflowing: all.filter((e) => !contained(e)).map((e) => e.tagName + '.' + (e.className || '')),
      containedOverflow: all.filter(contained).map((e) => e.tagName + '.' + (e.className || '')) });
  })()`)
  console.log('   390：' + JSON.stringify(g390))
  ok('390 下右栏目录收起', g390.tocDisplay === 'none')
  ok('390 下章节列表变成横向滑动的胶囊条（display:flex）', g390.navDisplay === 'flex', g390.navDisplay)
  ok('390 下正文宽度 ≈ 视口宽度（一栏占满）', g390.bodyW >= 340 && g390.bodyW <= 390, `实测 ${g390.bodyW}px`)
  ok('390 下没有横向滚动（scrollWidth == clientWidth）', g390.docScrollW <= g390.docClientW + 1, `${g390.docScrollW} vs ${g390.docClientW}`)
  ok('390 下没有任何元素**没人管地**伸出屏幕外', g390.overflowing.length === 0, JSON.stringify(g390.overflowing))
  if (g390.containedOverflow.length) console.log(`   ℹ️ 被滚动容器收住的（正常）：${g390.containedOverflow.slice(0, 4).join(', ')}`)

  /* ── 四、右栏目录：锚点能对上、点了真的滚、跟随高亮 ────────────── */
  group('四、右栏目录（锚点解析 + 点击滚动 + 滚动跟随）')
  await viewport(1440, 900)
  await gotoCh('quota')
  const tocAudit = await j(`(() => {
    const links = [...document.querySelectorAll('#docsToc .docs-toc-link')];
    const broken = links.filter((l) => !document.getElementById(l.getAttribute('data-sec'))).map((l) => l.getAttribute('data-sec'));
    const heads = [...document.querySelectorAll('#docsBody h2[id], #docsBody h3[id]')].map((h) => h.id);
    return JSON.stringify({ links: links.length, heads: heads.length, broken, labels: links.map((l) => l.textContent.trim()).slice(0, 3) });
  })()`)
  console.log('   目录：' + JSON.stringify(tocAudit))
  ok('目录条数与正文里的标题数一致（一条标题一个锚点）', tocAudit.links === tocAudit.heads && tocAudit.links >= 3, JSON.stringify(tocAudit))
  ok('★ 每个目录锚点都能在正文里找到对应元素（0 个死链）', tocAudit.broken.length === 0, tocAudit.broken.join(','))

  /* ⚠️ 这两条探针必须用**真正在滚的那个容器**：教程页有 1700+px 高，
     撑破了 `.app{height:100dvh}` 的 grid 行 ⇒ 在 #scroll 上读写 scrollTop 恒为 0，
     会把「目录点不动」这个**真缺陷**误判成"探针没点对"。（2026-10-04 实测踩到） */
  const SCROLLER = `(() => {
    const sc = document.getElementById('scroll');
    if (sc && sc.scrollHeight > sc.clientHeight + 1) return { kind: '#scroll', el: sc, get: () => sc.scrollTop, base: () => sc.getBoundingClientRect().top, to: (y) => { sc.scrollTop = y; } };
    const de = document.scrollingElement || document.documentElement;
    return { kind: 'document', el: de, get: () => de.scrollTop, base: () => 0, to: (y) => window.scrollTo(0, y) };
  })()`

  const clicked = await j(`(async () => {
    const S = ${SCROLLER};
    S.to(0);
    await new Promise((r) => setTimeout(r, 250));
    const links = [...document.querySelectorAll('#docsToc .docs-toc-link')];
    if (!links.length) return JSON.stringify({ scroller: S.kind, sec: null, delta: null, on: [], moved: 0, vh: innerHeight, atBottom: false, why: '右栏目录是空的（docs.js 没渲染？）' });
    const last = links[links.length - 1];
    const sec = last.getAttribute('data-sec');
    last.click();
    await new Promise((r) => setTimeout(r, 500));
    const el = document.getElementById(sec);
    const delta = Math.round(el.getBoundingClientRect().top - S.base());
    const on = [...document.querySelectorAll('#docsToc .docs-toc-link.on')].map((l) => l.getAttribute('data-sec'));
    const maxY = S.el.scrollHeight - S.el.clientHeight;
    return JSON.stringify({ scroller: S.kind, sec, delta, on, moved: Math.round(S.get()),
      vh: innerHeight, atBottom: maxY - S.get() <= 2 });
  })()`)
  console.log('   点最后一条目录：' + JSON.stringify(clicked))
  /* 最后一条目录**永远顶不到视口最上面**（它下面已经没有内容可撑了），
     所以判据分两半：①真的滚进了视口上半部 ②能顶到顶时必须顶到顶（偏差 ≤ 40px）。 */
  ok('★ 点目录后目标标题真的滚进了视野（落在视口上半部）',
    clicked.delta >= -2 && clicked.delta <= Math.round(clicked.vh * 0.6), `偏差 ${clicked.delta}px / 视口高 ${clicked.vh}px`)
  ok('★ 没到页尾时必须精确顶到容器顶部附近（偏差 ≤ 40px）',
    clicked.atBottom || Math.abs(clicked.delta) <= 40,
    `偏差 ${clicked.delta}px（${clicked.atBottom ? '已到页尾，无法再往上滚 —— 这是预期' : '没到页尾'}）`)
  ok('点了之后那一条自己变成高亮', clicked.on.length === 1 && clicked.on[0] === clicked.sec, JSON.stringify(clicked.on))
  ok('滚动位置真的动了（scrollTop > 0）', clicked.moved > 0, String(clicked.moved))

  const spy = await j(`(async () => {
    const S = ${SCROLLER};
    S.to(1e7);                      // 滚到底
    await new Promise((r) => setTimeout(r, 700));
    const on = [...document.querySelectorAll('#docsToc .docs-toc-link.on')].map((l) => l.getAttribute('data-sec'));
    const heads = [...document.querySelectorAll('#docsBody h2[id], #docsBody h3[id]')];
    if (!heads.length) return JSON.stringify({ on, lastHead: null, moved: Math.round(S.get()), scroller: S.kind, why: '正文一个标题都没有' });
    return JSON.stringify({ on, lastHead: heads[heads.length - 1].id, moved: Math.round(S.get()), scroller: S.kind });
  })()`)
  console.log('   滚到底：' + JSON.stringify(spy))
  ok('滚到底后高亮的是最后一条（跟随生效）', spy.on.length === 1 && spy.on[0] === spy.lastHead, JSON.stringify(spy))

  /* ── 五、章节翻页 ──────────────────────────────────────────────────── */
  group('五、章节翻页（上一章 / 下一章）')
  await evaluate(`document.getElementById('scroll').scrollTop = 0; if (window.DOCS) window.DOCS.open('what'); true`)
  await sleep(500)
  const pager = await j(`(() => {
    const btns = [...document.querySelectorAll('.docs-pager-btn')];
    const nx = document.querySelector('.docs-pager-btn.next');
    return JSON.stringify({ n: btns.length, nextHref: nx ? nx.getAttribute('href') : null,
      firstIsOff: !!document.querySelector('.docs-pager-btn.is-off') });
  })()`)
  ok('第一章底部有翻页条，且「上一章」是禁用态（说明这是第一章）', pager.n === 2 && pager.firstIsOff === true && pager.nextHref === '#docs/install', JSON.stringify(pager))
  const nav2 = await j(`(async () => {
    const nx = document.querySelector('.docs-pager-btn.next');
    if (!nx) return JSON.stringify({ on: null, hash: location.hash, title: null, why: '没有「下一章」按钮' });
    nx.click();
    await new Promise((r) => setTimeout(r, 500));
    const on = document.querySelector('.docs-nav-item.on');
    return JSON.stringify({ on: on ? on.getAttribute('data-ch') : null, hash: location.hash,
      title: (document.querySelector('#docsBody h2') || {}).textContent });
  })()`)
  ok('点「下一章」真的切到第 2 章（导航高亮 + 地址栏 + 正文都跟着变）',
    nav2.on === 'install' && nav2.hash === '#docs/install' && !!nav2.title, JSON.stringify(nav2))
  const nav3 = await j(`(async () => {
    const btns = [...document.querySelectorAll('.docs-pager-btn')];
    if (!btns.length) return JSON.stringify({ on: null, why: '没有翻页条' });
    btns[0].click();
    await new Promise((r) => setTimeout(r, 500));
    const on = document.querySelector('.docs-nav-item.on');
    return JSON.stringify({ on: on ? on.getAttribute('data-ch') : null });
  })()`)
  ok('点「上一章」退回第 1 章', nav3.on === 'what', JSON.stringify(nav3))

  /* ── 六、插图：16 张，一张都不能是破图 ──────────────────────────── */
  group('六、插图（真加载 + 真像素 + HTTP 200）')
  let figs = 0, svgs = 0, imgs = 0
  const badImgs = []
  for (const id of ids) {
    await gotoCh(id)
    const c = await j(`(async () => {
      const im = [...document.querySelectorAll('#docsBody img')];
      im.forEach((i) => { i.loading = 'eager'; });
      await Promise.all(im.map((i) => (i.complete && i.naturalWidth > 0) ? Promise.resolve() : i.decode().catch(() => {})));
      return JSON.stringify({
        figs: document.querySelectorAll('#docsBody .doc-fig').length,
        svg: document.querySelectorAll('#docsBody svg').length,
        img: im.length,
        blank: im.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute('src')),
        cap: document.querySelectorAll('#docsBody figcaption').length,
      });
    })()`)
    figs += c.figs; svgs += c.svg; imgs += c.img
    if (!c.figs || c.cap !== c.figs) badImgs.push(`${id}: figs=${c.figs} 图注=${c.cap}`)
    if (c.blank.length) badImgs.push(`${id}: 破图 ${c.blank.join(',')}`)
    ok(`第「${id}」章：有插图（${c.figs} 张），且每张都配了图注（${c.cap} 条）`, c.figs >= 1 && c.cap === c.figs, JSON.stringify(c))
  }
  ok('★ 8 章里没有一张破图 / 没有一张缺图注', badImgs.length === 0, badImgs.join(' ｜ '))
  ok('★ 插图总量 ≥ 16 张（内联 SVG + 真截图 + DOM 模拟图）', figs >= 16, `实测 figs=${figs} svg=${svgs} img=${imgs}`)
  ok('内联 SVG 示意图 ≥ 6 张', svgs >= 6, `实测 ${svgs}`)
  ok('真截图 ≥ 6 张', imgs >= 6, `实测 ${imgs}`)
  console.log(`   合计：${figs} 张插图（SVG ${svgs} / 截图 ${imgs} / DOM 模拟图 ${figs - svgs - imgs}）`)

  const shotNames = [...fs.readFileSync(path.join(ROOT, 'docs.js'), 'utf8').matchAll(/shot\('([a-z0-9-]+)'/g)].map((m) => m[1])
  for (const n of shotNames) {
    const r = await fetch(`${BASE}/docs-img/${n}.png`)
    const buf = Buffer.from(await r.arrayBuffer())
    const png = buf.length > 3000 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    ok(`截图 /docs-img/${n}.png HTTP 200 且是真 PNG（${buf.length} B）`, r.status === 200 && png, `HTTP ${r.status}`)
  }

  /* ── 七、深浅色对比度（真算出来的比值）──────────────────────────── */
  group('七、对比度（8 章逐章量、取最低值；浅色 + 深色各一遍）')
  await viewport(1440, 900)
  /* ⚠️ 不能在单独一章上量：某一章天然没有代码块/表格/步骤条（第一版就因此在 quota 章上
     量出 5 个 -1，把"这章没有这种东西"误报成"对比度不达标"）。
     正确做法：8 章各量一遍，按选择器**取最低值**；只要有一章没有那个元素就跳过它。 */
  const CKEYS = ['lead', 'body', 'nav', 'toc', 'cap', 'code', 'th', 'td', 'step', 'dts']
  const contrastAll = async (label) => {
    const min = {}
    for (const id of ids) {
      await gotoCh(id)
      const r = await j(CONTRAST)
      for (const k of CKEYS) {
        const v = r[k]
        if (typeof v !== 'number' || v < 0) continue
        if (!(k in min) || v < min[k]) min[k] = v
      }
      if (r.pageBg) min.pageBg = r.pageBg
    }
    console.log(`   ${label}：` + JSON.stringify(min))
    return min
  }
  await scheme(false)
  const light = await contrastAll('浅色（8 章取最低）')
  await scheme(true)
  const dark = await contrastAll('深色（8 章取最低）')
  const pairs = [['lead', '导语'], ['body', '正文'], ['nav', '左栏章节'], ['toc', '右栏目录'], ['cap', '图注'], ['code', '代码块'], ['th', '表头'], ['td', '表格'], ['step', '步骤说明'], ['dts', '问答标题']]
  for (const [k, label] of pairs) {
    /* 先断言"这个元素真的被量到了" —— 否则元素一整类消失时（选择器写错 / CSS 删了），
       undefined >= 4.5 会静默为假，看着像"不达标"，其实是"没量到"。 */
    ok(`量到过·${label}（浅色 ${light[k]} / 深色 ${dark[k]}）`, typeof light[k] === 'number' && typeof dark[k] === 'number',
      `浅色=${light[k]} 深色=${dark[k]}`)
    ok(`浅色·${label} 对比度 ≥ 4.5（实测 ${light[k]}）`, light[k] >= 4.5, `实测 ${light[k]}`)
    ok(`深色·${label} 对比度 ≥ 4.5（实测 ${dark[k]}）`, dark[k] >= 4.5, `实测 ${dark[k]}`)
  }
  ok('深浅两种配色下页面底色真的不同（说明主题确实生效了）', light.pageBg !== dark.pageBg, `${light.pageBg} vs ${dark.pageBg}`)
  // 内联 SVG 的上色是 CSS 变量，必须真的变了色（否则深色下白底白图）
  await gotoCh('what')      // 第 1 章那张 arch 示意图有 box / box2 / accent 三种图元
  const svgFill = await j(`(() => {
    const pick = (sel) => { const e = document.querySelector('#docsBody .doc-fig svg ' + sel); return e ? getComputedStyle(e).fill : null; };
    return JSON.stringify({ t: pick('.df-t'), box: pick('.df-box') || pick('.df-box2'), accent: pick('.df-accent'),
      stroke: (() => { const e = document.querySelector('#docsBody .doc-fig svg .df-box'); return e ? getComputedStyle(e).stroke : null; })() });
  })()`)
  console.log('   深色下 SVG：' + JSON.stringify(svgFill))
  ok('★ 深色下示意图的文字与方块都拿到了真颜色（不是 none / null）',
    !!svgFill.t && svgFill.t !== 'none' && !!svgFill.box && svgFill.box !== 'none', JSON.stringify(svgFill))
  await scheme(false)

  /* ── 八、0 报错 ───────────────────────────────────────────────────── */
  group('八、控制台（报错会把教程页卡在半截）')
  const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown'
    || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))
  ok('全程没有未捕获异常 / console error', errors.length === 0,
    errors.length ? `实测 ${errors.length} 条：${JSON.stringify(errors[0]).slice(0, 240)}` : '0 条')

  /* ── 九、教程页的「文案口径」─────────────────────────────────────────
     2026-10-04 补：此前这一页全是几何与深链断言，**一句文案都没查** ——
     反向校验时把「登录即可」换回旧口水句，97 条断言全绿。
     这里只钉两件客观事实：三处额度/保留期的关键数字都出现过，且旧名字不再出现。
     不评判文风（文风无法用断言衡量），只防「改名字时漏了一处 / 数字写错」。 */
  group('九、教程页文案（关键数字没写错、旧名字清干净）')
  const allText = await j(`(() => {
    let seen = '';
    for (const id of (window.DOCS && window.DOCS.chapters || []).map((c) => c.id)) {
      window.DOCS.open(id);
      seen += (document.getElementById('docsBody') || {}).textContent || '';
    }
    return JSON.stringify(seen);
  })()`)
  ok('八章正文都能取到文字', allText.length > 3000, `实际 ${allText.length} 字`)
  for (const [what, s] of [['免费版每天 100 次', '100 次'], ['免费版保留 5 小时', '5 小时'],
    ['付费版每天 1000 次', '1000 次'], ['付费版保留 48 小时', '48 小时'], ['付费版价格 ¥2.99', '¥2.99']]) {
    ok(`教程里写到了「${what}」`, allText.includes(s))
  }
  ok('★ 教程里不再出现旧档位名（支持者 / 免费档）',
    !allText.includes('支持者') && !allText.includes('免费档'),
    `支持者=${allText.includes('支持者')} 免费档=${allText.includes('免费档')}`)

  /* ── 十、既有四个视图没被破坏 ─────────────────────────────────────── */
  group('十、回归：既有四个视图照旧')
  await viewport(1440, 900)
  for (const v of ['overview', 'records', 'account', 'about']) {
    await evaluate(`document.querySelector('.nav-item[data-view="${v}"]').click(); true`)
    await sleep(450)
    const r = await j(`(() => {
      const secs = [...document.querySelectorAll('section[data-view]')];
      const disp = (el) => (el ? getComputedStyle(el).display : 'no-element');
      return JSON.stringify({ visible: secs.filter((s) => disp(s) !== 'none').map((s) => s.dataset.view),
        title: document.getElementById('viewTitle').textContent,
        reader: disp(document.getElementById('reader')) });
    })()`)
    ok(`切到「${v}」时只有它可见，且 #reader 仍是 none`, r.visible.length === 1 && r.visible[0] === v && r.reader === 'none', JSON.stringify(r))
  }
  const h1s = await j(`JSON.stringify([...document.querySelectorAll('h1')].map((h) => h.textContent.trim()).filter(Boolean))`)
  ok('整站仍然只有一个 h1（品牌标题）', h1s.length === 1 && h1s[0].includes('DSH'), JSON.stringify(h1s))

  console.log(`\n教程文档页验收：${pass} 通过 / ${fails.length} 失败`)
  console.log(fails.length ? '>>> 有问题 ❌\n  - ' + fails.join('\n  - ') : '>>> 教程文档页在真浏览器里是对的 ✅')
  return done(fails.length ? 1 : 0)
}

main().catch(async (e) => { console.error('验收脚本自己崩了：', e); await cleanup(); process.exit(2) })
