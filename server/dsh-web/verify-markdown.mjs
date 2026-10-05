#!/usr/bin/env node
/**
 * verify-markdown.mjs —— 「完整回答」的 Markdown 渲染验收（两层尺子）。
 *
 * 为什么有这个脚本（2026-10-03 事故）：
 *   QQ 里的链接是 `/n/<id>`，落在 SPA 客户端渲染；`openRecord()` 原来写的是
 *   `$('readerBody').textContent = r.record.text` ⇒ **正文里的 Markdown 记号原样显示**
 *   （`##`、`|---|`、三反引号全裸）。所以这把尺子的核心断言是：
 *   **正文里不许再出现裸记号，且必须真的渲染成块级标签。**
 *
 * 两层，互相独立：
 *   ① 无头 DOM 桩：直接调 `renderMarkdown()`，量"产出的 HTML 对不对 + 安全性"。
 *      它证明**字符串层面**是对的，但**看不见 CSS**；
 *   ② 真浏览器（headless Edge + CDP）：**走真实代码路径** `refresh()` → `openRecord(id)`，
 *      再量 DOM 与 `getComputedStyle`。只有这一层能发现"渲染了但排成两倍行距 / 不换行"。
 *      ⇒ 本项目已有过教训：`[hidden]` 被 `display:flex` 干掉那次，前两种尺子全绿。
 *
 * 用法：
 *   node verify-markdown.mjs                    # 本地 public/（静态服务 + /api 代理到线上）
 *   node verify-markdown.mjs --dir .tmp-x       # 反向校验：证明这把尺子抓得住旧代码
 *   node verify-markdown.mjs --url http://cyanovo.top/   # 直接量线上
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve } from 'node:path'
import vm from 'node:vm'

const HERE = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const DIR = argOf('--dir', existsSync(join(HERE, 'public', 'app.js')) ? join(HERE, 'public') : null)
const LIVE = argOf('--url', null)
const DEBUG_PORT = Number(argOf('--port', '9334'))

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 样张：把"能渲染的东西"和"能攻击的东西"都放进去 ─────────────────────────
const SAMPLE = [
  '# 一级标题（阅读器里不许产出 h1）',
  '',
  '正文第一行，带 **粗体**、*斜体*、~~删除线~~、`行内代码`、[站内](/records) 与 [外链](https://example.com/a_b?c=1&d=2)。',
  '正文第二行（上一行结尾没有空行，应合成同一段并用 <br> 断行）。',
  '',
  '## 二级标题',
  '### 三级标题',
  '',
  '- 无序一',
  '- 无序二',
  '  - 嵌套项',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '> 引用第一行',
  '> 引用第二行',
  '',
  '| 列A | 列B |',
  '| --- | ---: |',
  '| a1 | b1 |',
  '| a2 | b2 |',
  '',
  '```js',
  'const a = 1 < 2 && "x";',
  'console.log(a);',
  '```',
  '',
  '---',
  '',
  '结尾一行。',
  '',
  '安全：<img src=x onerror="window.__XSS=1"> <script>window.__XSS=2</script> <b>不许加粗</b>',
  '[危险](javascript:window.__XSS=3)',
  '',
].join('\n')

// ── 一、无头 DOM 桩：直接量 renderMarkdown 的产出 ──────────────────────────
function layerStub() {
  const SRC = readFileSync(join(DIR ?? join(HERE, 'public'), 'app.js'), 'utf8')
  const els = new Map()
  const el = (id) => ({
    id, innerHTML: '', textContent: '', hidden: false, value: '', className: '', style: {}, dataset: {}, onclick: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener() {}, appendChild() {}, querySelectorAll() { return [] },
    // 验证码那张图要用到真浏览器有的这几个方法（src 赋值、removeAttribute/setAttribute）：
    // 桩里少了它，loadCaptcha 会 TypeError，整份脚本连第一条断言都跑不到 —— 那不是产品坏了，是尺子缺件。
    src: '', setAttribute() {}, removeAttribute() {}, getAttribute() { return null },
  })
  const ctx = {
    console,
    setTimeout: () => 0, clearTimeout: () => {},
    JSON, Math, Date, String, Number, Object, Array, Error, Promise, RegExp, isNaN, parseInt,
    encodeURIComponent, decodeURIComponent,
    innerWidth: 1280,
    document: {
      getElementById(id) { if (!els.has(id)) els.set(id, el(id)); return els.get(id) },
      querySelectorAll() { return [] }, addEventListener() {}, body: { style: {} },
    },
    window: { addEventListener() {} },
    location: { pathname: '/', hash: '', href: 'http://x/' },
    fetch: async () => ({ ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ ok: true, items: [] }), text: async () => '{}' }),
  }
  vm.createContext(ctx)
  vm.runInContext(SRC, ctx, { filename: 'app.js' })
  // top-level 函数声明在 vm 里是可用的（app.js 是经典脚本，不是 module）
  const call = (expr) => vm.runInContext(expr, ctx)
  const render = (text) => call(`renderMarkdown(${JSON.stringify(text)})`)
  const escOnly = (text) => call(`esc(${JSON.stringify(text)})`)

  console.log('\n【一】renderMarkdown 的产出（无头 DOM 桩，直接跑函数）')

  // 量具有牙：样张本身必须真的含裸记号，否则"输出里没有记号"是废话
  const raw = escOnly(SAMPLE)
  ok('量具有牙：样张经 esc 后仍含裸 Markdown 记号（`##` / 表格分隔行 / 围栏）',
    raw.includes('##') && /\|\s*-{3,}\s*\|/.test(raw) && raw.includes('```'),
    `含##=${raw.includes('##')} 含分隔行=${/\|\s*-{3,}\s*\|/.test(raw)} 含围栏=${raw.includes('```')}`)

  const out = render(SAMPLE)

  ok('★ 正文不再出现裸 `##`（原来是原样显示）', !out.includes('##'), `出现次数=${(out.match(/##/g) || []).length}`)
  ok('★ 正文不再出现裸表格分隔行', !/^\s*\|/m.test(out) && !out.includes('---|'), '')
  ok('★ 正文不再出现裸围栏 ```', !out.includes('```'), '')
  ok('★ 正文不再出现裸 `**` / `~~`', !out.includes('**') && !out.includes('~~'), '')

  ok('标题：# → h2、## → h3、### → h4', out.includes('<h2>一级标题（阅读器里不许产出 h1）</h2>')
    && out.includes('<h3>二级标题</h3>') && out.includes('<h4>三级标题</h4>'), '')
  ok('★ 阅读器里绝不产出 h1（全站唯一 h1 是落地页品牌名）', !out.includes('<h1'), '')

  ok('围栏代码块 → <pre class="md-pre" data-lang="js"><code>', out.includes('<pre class="md-pre" data-lang="js"><code>'), '')
  // ⚠️ esc() 连 `"` 一起转义（&quot;），所以按"尖括号与 & 不许还原成标签"来断言；
  //    再单独确认多行代码块的换行被 <pre> 保住了（这是"结构没被压平"的直接证据）。
  const preHtml = (out.match(/<pre class="md-pre"[\s\S]*?<\/pre>/) || [''])[0]
  ok('代码块里的 HTML 被转义（不许变成真标签）',
    preHtml.includes('const a = 1 &lt; 2 &amp;&amp;') && preHtml.includes('&quot;x&quot;;') && !preHtml.includes('<code><'),
    JSON.stringify(preHtml.slice(0, 220)))
  ok('代码块保住多行结构（两行都在同一个 pre 里）',
    preHtml.includes('const a = 1') && preHtml.includes('console.log(a);'), JSON.stringify(preHtml.slice(0, 220)))
  ok('表格 → <table> + <th>', out.includes('<table>') && out.includes('<th>列A</th>'), '')
  ok('表格对齐：`---:` → text-align:right', out.includes('style="text-align:right"'), '')
  ok('列表 → ul / ol（嵌套项嵌在父项 li 里）',
    out.includes('<ul><li>无序一</li><li>无序二<ul><li>嵌套项</li></ul></li></ul>') && out.includes('<ol><li>有序一</li>'), '')
  ok('引用 → blockquote + 两个 p', out.includes('<blockquote><p>引用第一行</p><p>引用第二行</p></blockquote>'), '')
  ok('`---` → <hr>', out.includes('<hr>'), '')
  ok('行内：strong / em / del / code', out.includes('<strong>粗体</strong>') && out.includes('<em>斜体</em>')
    && out.includes('<del>删除线</del>') && out.includes('<code>行内代码</code>'), '')
  ok('段落内的单换行 → <br>（同一段，不拆成两个 p）',
    out.includes('<p>正文第一行') && out.includes('<br>正文第二行'), '')
  ok('站内链接放行并加 rel/target', out.includes('<a href="/records" target="_blank" rel="noopener noreferrer">站内</a>'), '')
  ok('外链里的 & 被转义（没把属性截断）', out.includes('href="https://example.com/a_b?c=1&amp;d=2"'), '')

  console.log('  ── 安全（先 esc 再解析，这是唯一的 XSS 防线）──')
  ok('★ 原始 HTML 不许变成真标签（img / script / b）',
    !out.includes('<img') && !out.includes('<script') && !out.includes('<b>') && out.includes('&lt;img') && out.includes('&lt;script&gt;'), '')
  ok('★ javascript: 链接不许被渲染成 <a>', !out.includes('javascript:window.__XSS=3"') && !/href="javascript/i.test(out), '')
  ok('危险链接原样保留（宁可少渲染，也不吞字符）', out.includes('[危险](javascript:window.__XSS=3)'), '')

  console.log('  ── 健壮性 ──')
  ok('空值不炸：undefined / null / 空串 → 空字符串',
    render(undefined) === '' && render(null) === '' && render('') === '', '')
  const noClose = render('```js\nconst a = 1\n')
  ok('没有收尾围栏也不死循环（照样产出代码块）', noClose.includes('<pre class="md-pre" data-lang="js"><code>const a = 1'), JSON.stringify(noClose))
  ok('纯文本原样保留（含中文与标点）', render('一句话，什么都没有。').includes('<p>一句话，什么都没有。</p>'), '')
}

// ── 二、真浏览器：走 refresh() → openRecord() 真实路径 ─────────────────────
async function serveDir(dir) {
  const root = resolve(dir)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
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

/** ⚠️ 走的是**真实代码路径**：refresh() 拿身份 → openRecord() 打开记录。
 *  不是"直接把 HTML 塞进去" —— 那样子的话，把调用点改回 textContent 也照样能通过。 */
/* ⚠️ Runtime.evaluate 里**没有顶层 await**（`await is not defined`），
   所以整段必须包在最外层 async IIFE 里，并靠 evaluate 的 awaitPromise:true 等它落定。 */
const RUN = (sampleJson) => '(async () => JSON.stringify(await (async () => {' +
  '  const sample = ' + sampleJson + ';' +
  '  const J = (o) => ({ ok: true, status: 200, json: async () => o });' +
  '  window.__viewCalls = 0;' +
  '  window.fetch = async (p) => {' +
  '    const path = String(p);' +
  '    if (path.includes("/view")) { window.__viewCalls++; return J({ ok: true,' +
  '      quota: { plan: "free", limit: 100, used: 1, remaining: 99, retentionText: "5 小时" },' +
  '      record: { id: "mdcheck", title: "渲染验收", chars: sample.length, createdAt: Date.now(), retentionText: "5 小时", text: sample } }); }' +
  '    if (path.indexOf("/api/me") === 0) return J({ ok: true, me: { username: "验收", plan: "free", proUntil: null,' +
  '      mode: "note-link", createdAt: Date.now(), quota: { plan: "free", limit: 100, used: 1, remaining: 99, retentionText: "5 小时" } } });' +
  '    if (path.indexOf("/api/records") === 0) return J({ ok: true, items: [] });' +
  '    return J({ ok: true });' +
  '  };' +
  '  await refresh();' +
  '  await openRecord("mdcheck");' +
  '  const body = document.getElementById("readerBody");' +
  '  const cs = (e) => getComputedStyle(e);' +
  '  const n = (sel) => body.querySelectorAll(sel).length;' +
  '  const ps = [...body.children].filter((e) => e.tagName === "P");' +
  '  const pre = body.querySelector("pre.md-pre");' +
  '  const code = pre ? pre.querySelector("code") : null;' +
  '  const th = body.querySelector("th");' +
  '  const bq = body.querySelector("blockquote");' +
  '  const wrap = body.querySelector(".md-table");' +
  '  const first = body.firstElementChild;' +
  '  const last = body.lastElementChild;' +
  '  const kids = [...body.children];' +
  '  const rect = (e) => e.getBoundingClientRect();' +
  /* 段间距必须量"相邻的两个 <p> 兄弟"：children 里的第 0、1 个 <p> 中间可能隔着整篇内容
     （实测隔着 h3/h4/列表/引用/表格/代码/hr，量出 720px —— 那是排版总长，不是间距）。 */
  '  const pPairs = [];' +
  '  for (let i = 1; i < kids.length; i++) {' +
  '    if (kids[i].tagName === "P" && kids[i - 1].tagName === "P") pPairs.push([kids[i - 1], kids[i]]);' +
  '  }' +
  '  const gap = pPairs.length ? rect(pPairs[0][1]).top - rect(pPairs[0][0]).bottom : -1;' +
  /* :first-child 的 margin-top 被 `.reader-body > :first-child` 归零（下一条断言专门守它），
     所以量间距 token 必须挑一个**非首个子元素**的标题。 */
  '  const head = kids.find((e) => /^H[2-4]$/.test(e.tagName) && e !== first) || null;' +
  '  return {' +
  '    viewCalls: window.__viewCalls,' +
  '    readerHidden: document.getElementById("reader").hidden,' +
  '    toast: (document.getElementById("toast") || {}).textContent || "",' +
  '    counts: { h1: n("h1"), h2: n("h2"), h3: n("h3"), h4: n("h4"), p: n("p"), ul: n("ul"), ol: n("ol"), li: n("li"),' +
  '      blockquote: n("blockquote"), hr: n("hr"), pre: n("pre"), table: n("table"), th: n("th"), td: n("td"),' +
  '      strong: n("strong"), em: n("em"), del: n("del"), code: n("code"), img: n("img"), script: n("script"), a: n("a") },' +
  '    text: body.innerText,' +
  '    bodyWhiteSpace: cs(body).whiteSpace,' +
  '    bodyFontSize: cs(body).fontSize,' +
  '    bodyLineHeight: cs(body).lineHeight,' +
  '    codeWhiteSpace: code ? cs(code).whiteSpace : "",' +
  '    codeFont: code ? cs(code).fontFamily : "",' +
  '    codeFontSize: code ? cs(code).fontSize : "",' +
  '    tableOverflow: wrap ? cs(wrap).overflowX : "",' +
  '    thBg: th ? cs(th).backgroundColor : "",' +
  '    bqBorder: bq ? cs(bq).borderLeftWidth + " " + cs(bq).borderLeftStyle : "",' +
  '    headTag: head ? head.tagName : "",' +
  '    headTop: head ? parseFloat(cs(head).marginTop) : -1,' +
  '    headBottom: head ? parseFloat(cs(head).marginBottom) : -1,' +
  '    pMargin: ps.length ? parseFloat(cs(ps[0]).marginBottom) : -1,' +
  '    pPairs: pPairs.length,' +
  '    gap: gap,' +
  '    firstTop: first ? parseFloat(cs(first).marginTop) : -1,' +
  '    lastBottom: last ? parseFloat(cs(last).marginBottom) : -1,' +
  '    xss: typeof window.__XSS === "undefined" ? "undefined" : String(window.__XSS),' +
  '    bodyScroll: body.scrollWidth, bodyClient: body.clientWidth,' +
  '    docScroll: document.documentElement.scrollWidth, innerWidth: innerWidth,' +
  '  };' +
  '})()))()'

async function layerBrowser(target, dir) {
  console.log('\n【二】真浏览器（headless Edge + CDP，走 openRecord 真实路径）')
  if (!EDGE) { console.log('  ✗ 找不到 msedge.exe'); fail++; return }
  let local = null
  let url = target
  if (dir) {
    local = await serveDir(dir)
    url = local.url
    console.log(`  静态服务 ${url}  ← ${resolve(dir)}`)
  } else {
    console.log(`  目标 ${url}`)
  }
  const profile = await mkdtemp(join(tmpdir(), 'dsh-md-'))
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--window-size=1280,900',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, url,
  ], { stdio: 'ignore' })
  let cdp = null
  try {
    cdp = await connect()
    const { send, events } = cdp
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Log.enable')
    for (let i = 0; i < 80; i++) {
      const ready = await evaluate(send, 'document.readyState').catch(() => 'loading')
      if (ready === 'complete') break
      await sleep(250)
    }
    await sleep(1000)
    const raw = await evaluate(send, RUN(JSON.stringify(SAMPLE)))
    const r = JSON.parse(raw)
    const c = r.counts
    const t = r.text || ''

    ok('★ 真实路径走通了：openRecord 真的 POST 了 view 且阅读器打开了',
      r.viewCalls === 1 && r.readerHidden === false, `viewCalls=${r.viewCalls} readerHidden=${r.readerHidden}`)
    ok('没有报错 toast（渲染过程没抛异常）', r.toast === '', `实测 toast="${r.toast}"`)

    console.log('  ── 看得见的内容 ──')
    /* `[危险](javascript:…)` 是产品**故意原样保留**的（上一条 `危险链接没有被渲染成可点链接` 用 a===2 守着它），
       所以扫描裸记号前必须先把这段原样保留的文本摘掉 —— 否则量具会把产品明确承诺的行为
       误判成"裸记号泄漏"。下面紧跟着一条"有牙"断言，证明这次摘除不是空操作。 */
    const PASSTHROUGH = '[危险](javascript:window.__XSS=3)'
    const tPlain = t.split(PASSTHROUGH).join('')
    ok('量具有牙：被摘掉的「原样保留」片段确实出现在正文里（否则摘除是空操作）',
      t.includes(PASSTHROUGH) && tPlain.length < t.length,
      `含原文=${t.includes(PASSTHROUGH)} 摘除前 ${t.length} → 摘除后 ${tPlain.length} 字符`)
    ok('★ 正文里不含裸记号（## / |---| / 围栏 / ** / ~~ / ](）',
      !tPlain.includes('##') && !tPlain.includes('---|') && !tPlain.includes('```') && !tPlain.includes('**') && !tPlain.includes('~~') && !tPlain.includes(']('),
      `（已摘除故意保留的那条危险链接）${JSON.stringify(tPlain.slice(0, 120))}`)
    ok('标题文字看得见', t.includes('二级标题') && t.includes('三级标题'), '')
    ok('代码块内容看得见且 < 是字符不是标签', t.includes('const a = 1 < 2'), '')
    ok('表格内容看得见', t.includes('列A') && t.includes('a2'), '')
    ok('嵌套列表文字看得见', t.includes('嵌套项'), '')
    ok('块级元素数量对：h2=1 h3=1 h4=1 p≥4',
      c.h2 === 1 && c.h3 === 1 && c.h4 === 1 && c.p >= 4, JSON.stringify(c))
    ok('代码块/表格/引用/hr 都真的成了元素',
      c.pre === 1 && c.table === 1 && c.th === 2 && c.blockquote === 1 && c.hr === 1, JSON.stringify(c))
    ok('列表是 ul+ol（含一层嵌套）', c.ul === 2 && c.ol === 1 && c.li >= 5, JSON.stringify(c))
    ok('★ 阅读器里 0 个 h1', c.h1 === 0, `h1=${c.h1}`)

    console.log('  ── 真浏览器量的排版（只有这一层看得见 CSS）──')
    ok('★ .reader-body 不再是 pre-wrap（否则块之间会双倍行距）',
      r.bodyWhiteSpace === 'normal', `实测 white-space=${r.bodyWhiteSpace}`)
    ok('正文字号 16px', r.bodyFontSize === '16px', `实测 ${r.bodyFontSize}`)
    ok('代码块内保留 pre（源码换行不被压掉）', r.codeWhiteSpace === 'pre', `实测 ${r.codeWhiteSpace}`)
    ok('代码是等宽字体', /Consolas|Menlo|ui-monospace|monospace/i.test(r.codeFont), r.codeFont.slice(0, 60))
    ok('代码块字号比正文小（13.5px）', r.codeFontSize === '13.5px', `实测 ${r.codeFontSize}`)
    ok('表格容器可横向滚动（窄屏不撑破布局）', r.tableOverflow === 'auto', `实测 ${r.tableOverflow}`)
    ok('表头有底色（层级可辨）', r.thBg !== 'rgba(0, 0, 0, 0)' && r.thBg !== 'transparent', r.thBg)
    ok('引用左侧有 3px 竖线', r.bqBorder === '3px solid', `实测 ${r.bqBorder}`)
    /* 段间距必须量「相邻的两个 <p> 兄弟」的间距 —— 若拿非相邻的两段量，中间夹着标题，
       量到的是"标题那一段的高度"，会得到 720 这种荒唐值（第一版量具就这么骗过我）。 */
    ok('★ 段间距 = 一个 margin，不是两倍（16px）',
      r.pPairs >= 1 && Math.abs(r.gap - r.pMargin) <= 2 && r.pMargin === 16,
      `实测 相邻段落对数=${r.pPairs} gap=${r.gap} p.marginBottom=${r.pMargin}`)
    /* `.reader-body > :first-child { margin-top: 0 }` 会把**第一个**子元素的 margin-top 归零，
       所以必须挑一个非首个子元素的标题来量 token —— 用 h2（= body.firstElementChild）量必然得到 0。 */
    ok('标题上下留白用了间距 token（32 / 12）', r.headTop === 32 && r.headBottom === 12,
      `实测 <${(r.headTag || '?').toLowerCase()}> ${r.headTop} / ${r.headBottom}`)
    ok('首尾不留多余空白（:first-child / :last-child 归零）', r.firstTop === 0 && r.lastBottom === 0,
      `实测 first=${r.firstTop} last=${r.lastBottom}`)

    console.log('  ── 真 DOM 里的安全与溢出 ──')
    ok('★ 真 DOM 里没有注入的 img / script，且 onerror 没执行',
      c.img === 0 && c.script === 0 && r.xss === 'undefined', `img=${c.img} script=${c.script} __XSS=${r.xss}`)
    ok('危险链接没有被渲染成可点链接', c.a === 2, `a=${c.a}（应为站内+外链两条）`)
    ok('正文没有横向撑破容器', r.bodyScroll <= r.bodyClient + 1 && r.docScroll <= r.innerWidth + 1,
      `body ${r.bodyScroll}/${r.bodyClient} doc ${r.docScroll}/${r.innerWidth}`)

    const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))
    ok('没有未捕获异常 / console error', errors.length === 0,
      errors.length ? `实测 ${errors.length} 条：${JSON.stringify(errors[0]).slice(0, 200)}` : '0 条')
  } finally {
    try { cdp?.ws.close() } catch {}
    edge.kill()
    await sleep(300)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
    local?.srv.close()
  }
}

console.log('「完整回答」Markdown 渲染验收（两层尺子）')
layerStub()
await layerBrowser(LIVE, LIVE ? null : DIR)

console.log(`\nMarkdown 渲染：${pass} 通过 / ${fail} 失败`)
console.log('（提醒：第二层是 headless Edge + CDP，真机浏览器观感仍未验证）')
process.exit(fail === 0 ? 0 : 1)
