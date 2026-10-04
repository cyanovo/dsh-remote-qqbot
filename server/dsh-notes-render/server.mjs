// dsh-notes-render —— 把中枢落盘的 .md「完整回答」渲染成排版精美的网页
//
// 为什么需要它：QQ 里的「查看完整回答」链接原本直出 text/markdown，
// 浏览器只会给一坨等宽纯文本，中文长文几乎没法读。这个服务把同一个
// URL（/dsh/<id>.md，URL 不变！）变成渲染好的 HTML 页面。
//
// 零依赖、纯 Node 内置模块：服务器 1.6G 内存、无 swap，不装任何 npm 包；
// 也不引用任何 CDN —— 离线/被墙都不影响渲染。
//
// 监听 127.0.0.1:8790，由 nginx 反代；不直接暴露公网。

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 8790)
const HOST = process.env.HOST ?? '127.0.0.1'
const NOTES_DIR = process.env.NOTES_DIR ?? '/var/www/dsh-notes'
const MAX_BYTES = 4 * 1024 * 1024

const ID_RE = /^[A-Za-z0-9_-]{3,32}$/
// .md 与 .html 都接受：
//   .html 是**给 QQ 用的**——QQ 客户端看到 .md 会当成"文件"，弹「如需预览请用浏览器打开」，
//         换成 .html 才走内置浏览器渲染；
//   .md 保留是为了兼容 04:40 那一版已经发出去的旧链接。
const PATH_RE = /^\/dsh\/([A-Za-z0-9_-]{3,32})\.(?:md|html)$/

// ─────────────────────────────────────────────────────────────
// 一、Markdown → HTML（够用且安全的子集，先转义后处理）
// ─────────────────────────────────────────────────────────────

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])

// 行内元素：行内码先用哨兵占位，避免里面的 * _ [ ] 被当成语法
function inline(src) {
  const codes = []
  let s = String(src).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c)
    return `\u0000${codes.length - 1}\u0000`
  })

  // 插件生成的 md 结尾用了 <sub>…</sub>。这几个纯排版标签走白名单放行，
  // 其余 HTML（<script>、事件属性等）一律照旧转义 —— 白名单之外没有任何逃生口。
  const tags = []
  s = s.replace(/<\/?(?:sub|sup|b|i|u|s|mark|kbd|small|br|del|ins)\s*\/?>/gi, (t) => {
    tags.push(t.toLowerCase().replace(/\s+>/, '>'))
    return `\u0001${tags.length - 1}\u0001`
  })

  s = esc(s)

  // 图片 → 链接（顺序不能反）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, alt, url, title) => `<img src="${url}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, text, url, title) =>
      `<a href="${url}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`)
  // 裸链接
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g,
    (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)

  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^\w_])___(.+?)___(?=[^\w_]|$)/g, '$1<strong><em>$2</em></strong>')
  s = s.replace(/(^|[^\w_])__(.+?)__(?=[^\w_]|$)/g, '$1<strong>$2</strong>')
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>')

  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`)
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => tags[Number(i)])
  return s
}

// 表格：返回 [html, 消耗行数] 或 null
function tryTable(lines, start) {
  const head = lines[start]
  if (!head.includes('|')) return null
  const sep = lines[start + 1]
  if (sep === undefined) return null
  if (!/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(sep)) return null
  if (!sep.includes('-')) return null

  const cells = (row) => {
    let r = row.trim()
    if (r.startsWith('|')) r = r.slice(1)
    if (r.endsWith('|')) r = r.slice(0, -1)
    return r.split('|').map((c) => c.trim())
  }
  const aligns = cells(sep).map((c) => {
    const l = c.startsWith(':')
    const r = c.endsWith(':')
    if (l && r) return 'center'
    if (r) return 'right'
    if (l) return 'left'
    return ''
  })
  const th = cells(head)
  const rows = []
  let i = start + 2
  while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
    rows.push(cells(lines[i]))
    i++
  }

  const style = (n) => (aligns[n] ? ` style="text-align:${aligns[n]}"` : '')
  let html = '<div class="table-wrap"><table><thead><tr>'
  th.forEach((c, n) => { html += `<th${style(n)}>${inline(c)}</th>` })
  html += '</tr></thead><tbody>'
  for (const row of rows) {
    html += '<tr>'
    for (let n = 0; n < th.length; n++) html += `<td${style(n)}>${inline(row[n] ?? '')}</td>`
    html += '</tr>'
  }
  html += '</tbody></table></div>'
  return [html, i - start]
}

function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      const mark = fence[1][0].repeat(3)
      const lang = fence[2] ?? ''
      const buf = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*${mark === '```' ? '`{3,}' : '~{3,}'}`).test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // 吃掉闭合行（可能不存在）
      out.push(
        `<div class="code-block"${lang ? ` data-lang="${esc(lang)}"` : ''}>` +
        `<button class="copy-code" type="button" aria-label="复制代码">复制</button>` +
        `<pre><code>${esc(buf.join('\n'))}</code></pre></div>`,
      )
      continue
    }

    // 表格
    const table = tryTable(lines, i)
    if (table) {
      out.push(table[0])
      i += table[1]
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const text = heading[2]
      const id = slug(text)
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`)
      i++
      continue
    }

    // 分隔线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    // 引用（可多行、可嵌套列表）
    if (/^\s*>/.test(line)) {
      const buf = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`)
      continue
    }

    // 列表
    if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)) {
      const [html, used] = renderList(lines, i)
      out.push(html)
      i += used
      continue
    }

    // 空行
    if (line.trim() === '') {
      i++
      continue
    }

    // 段落（连续非空行合并，行尾两个空格 = 硬换行）
    const buf = []
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines, i)) {
      buf.push(lines[i])
      i++
    }
    out.push(`<p>${inline(buf.join('\n')).replace(/ {2,}\n/g, '<br>\n').replace(/\n/g, ' ')}</p>`)
  }

  return out.join('\n')
}

function isBlockStart(lines, i) {
  const line = lines[i]
  if (/^\s*(`{3,}|~{3,})/.test(line)) return true
  if (/^(#{1,6})\s+/.test(line)) return true
  if (/^\s*>/.test(line)) return true
  if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)) return true
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return true
  if (tryTable(lines, i)) return true
  return false
}

// 缩进感知的列表解析：支持嵌套、有序/无序混排、列表项内的续行
function renderList(lines, start) {
  const baseIndent = lines[start].match(/^\s*/)[0].length
  const ordered = /^\s*\d{1,9}[.)]\s+/.test(lines[start])
  const items = []
  let i = start
  let cur = null

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      // 空行后若仍是同层列表则继续，否则结束
      const next = lines[i + 1]
      if (next === undefined) { i++; break }
      const ind = next.match(/^\s*/)[0].length
      if (!/^\s*([-*+]|\d{1,9}[.)])\s+/.test(next) || ind < baseIndent) break
      i++
      continue
    }
    const indent = line.match(/^\s*/)[0].length
    const bullet = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
    if (bullet && indent <= baseIndent + 1) {
      if (cur !== null) items.push(cur)
      cur = [bullet[2], []]
      i++
      continue
    }
    if (indent > baseIndent && cur !== null) {
      // 同层续行 或 子列表
      cur[1].push(line.slice(Math.min(baseIndent + 2, indent)))
      i++
      continue
    }
    break
  }
  if (cur !== null) items.push(cur)

  const tag = ordered ? 'ol' : 'ul'
  let html = `<${tag}>`
  for (const [first, rest] of items) {
    let body = inline(first)
    if (rest.length) {
      // 任务列表勾选框
      const sub = rest.join('\n')
      if (isBlockStart(sub.split('\n'), 0) || /^\s*([-*+]|\d)/.test(rest[0])) {
        body += renderMarkdown(sub)
      } else if (sub.trim()) {
        body += ` ${inline(sub)}`
      }
    }
    body = body.replace(/^\[( |x|X)\]\s*/, (_, c) =>
      `<input type="checkbox" disabled${c.toLowerCase() === 'x' ? ' checked' : ''}> `)
    html += `<li>${body}</li>`
  }
  html += `</${tag}>`
  return [html, i - start]
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section'
}

// ─────────────────────────────────────────────────────────────
// 二、页面外壳（全部内联，零外部请求；浅色/深色自适应）
// ─────────────────────────────────────────────────────────────

const CSS = `
:root{
  --bg:#fff; --fg:#1f2328; --muted:#656d76; --line:#d8dee4; --soft:#f6f8fa;
  --link:#0969da; --quote:#d0d7de; --codebg:#f6f8fa; --codefg:#1f2328;
  --shadow:none;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --line:#30363d; --soft:#161b22;
    --link:#4d9eff; --quote:#3d444d; --codebg:#161b22; --codefg:#e6edf3;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--fg);
  font:16.5px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  font-feature-settings:"kern" 1; text-rendering:optimizeLegibility;
}
.bar{
  position:sticky; top:0; z-index:10; background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:saturate(180%) blur(12px); border-bottom:1px solid var(--line);
}
.bar-in{max-width:760px; margin:0 auto; padding:10px 22px; display:flex; align-items:center; gap:10px}
.brand{font-size:13px; color:var(--muted); font-weight:600; letter-spacing:.01em; margin-right:auto}
.btn{
  font:inherit; font-size:12.5px; line-height:1; color:var(--muted); background:transparent;
  border:1px solid var(--line); border-radius:999px; padding:7px 13px; cursor:pointer;
  text-decoration:none; white-space:nowrap; transition:color .15s,border-color .15s;
}
.btn:hover{color:var(--fg); border-color:var(--muted)}
main{max-width:760px; margin:0 auto; padding:44px 22px 96px}
h1,h2,h3,h4,h5,h6{line-height:1.3; font-weight:650; margin:1.9em 0 .7em; letter-spacing:-.011em}
h1{font-size:1.95em; margin-top:0}
h2{font-size:1.45em; padding-bottom:.32em; border-bottom:1px solid var(--line)}
h3{font-size:1.2em}
h4{font-size:1.05em}
h5,h6{font-size:.95em; color:var(--muted)}
p{margin:0 0 1.05em}
a{color:var(--link); text-decoration:none}
a:hover{text-decoration:underline}
strong{font-weight:650}
hr{border:0; border-top:1px solid var(--line); margin:2.2em 0}
ul,ol{margin:0 0 1.05em; padding-left:1.5em}
li{margin:.3em 0}
li>ul,li>ol{margin:.3em 0 .1em}
li::marker{color:var(--muted)}
blockquote{margin:0 0 1.05em; padding:.1em 0 .1em 1.1em; border-left:3px solid var(--quote); color:var(--muted)}
blockquote>:last-child{margin-bottom:0}
code{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  font-size:.875em; background:var(--codebg); padding:.18em .38em; border-radius:5px;
}
.code-block{position:relative; margin:0 0 1.25em}
.code-block pre{
  margin:0; background:var(--codebg); border:1px solid var(--line); border-radius:10px;
  padding:16px 18px; overflow-x:auto; line-height:1.6;
}
.code-block pre code{background:none; padding:0; font-size:13.5px; color:var(--codefg); white-space:pre}
.code-block[data-lang]::before{
  content:attr(data-lang); position:absolute; top:9px; right:14px; font-size:11px;
  color:var(--muted); letter-spacing:.04em; text-transform:uppercase; pointer-events:none;
}
.copy-code{
  position:absolute; top:8px; right:8px; opacity:0; font:inherit; font-size:11.5px;
  color:var(--muted); background:var(--bg); border:1px solid var(--line); border-radius:6px;
  padding:4px 9px; cursor:pointer; transition:opacity .15s;
}
.code-block:hover .copy-code{opacity:1}
.table-wrap{overflow-x:auto; margin:0 0 1.35em; border:1px solid var(--line); border-radius:10px}
table{border-collapse:collapse; width:100%; font-size:14.5px}
th,td{padding:9px 14px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top}
thead th{background:var(--soft); font-weight:650; white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
img{max-width:100%; height:auto; border-radius:8px}
input[type=checkbox]{margin-right:.4em}
.empty{color:var(--muted); text-align:center; padding:80px 0}
.empty h1{font-size:1.4em; border:0}
@media (max-width:640px){
  main{padding:28px 16px 72px}
  .bar-in{padding:9px 16px}
  body{font-size:16px}
  h1{font-size:1.6em}
  h2{font-size:1.3em}
  th,td{padding:8px 11px}
}
@media print{
  .bar,.copy-code{display:none}
  main{max-width:none; padding:0}
  body{font-size:11pt}
  a{color:inherit}
}
`

const FAVICON =
  'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="7" fill="#0969da"/>' +
    '<path d="M9 22V10h6.2c2.6 0 4.2 1.5 4.2 3.8 0 2.4-1.7 3.9-4.4 3.9H12V22z" fill="#fff"/>' +
    '</svg>')

const CLIENT_JS = `
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-code'); if (!btn) return;
  const code = btn.parentElement.querySelector('code');
  try { await navigator.clipboard.writeText(code.innerText); }
  catch { const r = document.createRange(); r.selectNodeContents(code);
          const s = getSelection(); s.removeAllRanges(); s.addRange(r);
          document.execCommand('copy'); s.removeAllRanges(); }
  const old = btn.textContent; btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = old; }, 1200);
});
`

function page({ title, body, rawHref = null, subtitle = null }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<div class="bar"><div class="bar-in">
  <span class="brand">${esc(subtitle ?? '完整回答')}</span>
  ${rawHref ? `<a class="btn" href="${esc(rawHref)}">原文</a>` : ''}
</div></div>
<main>
${body}
</main>
<script>${CLIENT_JS}</script>
</body>
</html>`
}

function notFound(id) {
  return page({
    title: '找不到这份回答',
    subtitle: '完整回答',
    body: `<div class="empty"><h1>找不到这份回答</h1>
<p>链接里的编号 <code>${esc(id)}</code> 在服务器上不存在，可能已被清理。</p></div>`,
  })
}

// ─────────────────────────────────────────────────────────────
// 三、HTTP
// ─────────────────────────────────────────────────────────────

function send(res, status, body, type = 'text/html; charset=utf-8') {
  const buf = Buffer.from(body, 'utf8')
  res.writeHead(status, {
    'content-type': type,
    'content-length': buf.length,
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  })
  res.end(buf)
}

async function handle(req, res) {
  const m = PATH_RE.exec((req.url ?? '').split('?')[0])
  if (!m) {
    // 也接受 /render/<id> 与 /<id>（方便本地直连调试）
    const alt = /^\/(?:render\/)?([A-Za-z0-9_-]{3,32})(?:\.(?:md|html))?$/.exec((req.url ?? '').split('?')[0])
    if (!alt) return send(res, 404, notFound('—'))
    return serveNote(res, alt[1])
  }
  return serveNote(res, m[1])
}

async function serveNote(res, id) {
  if (!ID_RE.test(id)) return send(res, 404, notFound(id))
  const file = join(NOTES_DIR, `${id}.md`)
  let md
  try {
    const st = await stat(file)
    if (!st.isFile()) throw new Error('not a file')
    if (st.size > MAX_BYTES) return send(res, 413, page({
      title: '内容过大', body: '<div class="empty"><h1>内容过大</h1><p>这份回答超过了渲染上限。</p></div>',
    }))
    md = await readFile(file, 'utf8')
  } catch {
    return send(res, 404, notFound(id))
  }

  const body = renderMarkdown(md.replace(/^\uFEFF/, ''))
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(body)
  const title = h1 ? h1[1].replace(/<[^>]+>/g, '').trim() : `完整回答 ${id}`
  return send(res, 200, page({ title, body, rawHref: `/dsh/raw/${id}.md` }))
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[notes-render] 渲染失败:', err)
    send(res, 500, page({ title: '渲染出错', body: '<div class="empty"><h1>渲染出错</h1><p>请稍后重试。</p></div>' }))
  })
}).listen(PORT, HOST, () => {
  console.log(`[notes-render] 已启动 http://${HOST}:${PORT}，笔记目录 ${NOTES_DIR}`)
})
