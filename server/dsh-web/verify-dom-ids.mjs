/**
 * 前端「元素 id」一致性检查 —— 补无头桩的盲区。
 *
 * 为什么需要它：`verify-deeplink.mjs` / `verify-account-ui.mjs` 用的桩是
 * **按需造元素**（`getElementById(id)` 要什么给什么），所以「HTML 里根本没有这个 id」
 * 这种错它永远发现不了。而真实浏览器里 `$('hamb').onclick = …` 撞上不存在的元素
 * 会直接抛异常 → `boot()` 整个不执行 → 用户看到的是一页**静态文字 + 空卡片**，
 * 也就是"页面错了，只有那几个字"。
 *
 * 这个脚本干两件事：
 *   1. app.js（以及教程页的 docs.js）里 `$('x')` / `getElementById('x')` 用到的每个 id，
 *      必须在 index.html 里存在，或由脚本自己用 innerHTML 渲染出来；
 *   2. index.html 里每个带 id 的元素，如果没人取过，列出来（只提醒，不算失败）。
 *
 * 用法：node verify-dom-ids.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const JS_FILES = ['app.js', 'docs.js', 'docs-figs.js']
const html = fs.readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8')

let pass = 0
let fail = 0
const check = (name, okk, detail = '') => {
  if (okk) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `　${detail}` : ''}`) }
}

const used = new Set()
const rendered = new Set()
for (const f of JS_FILES) {
  const js = fs.readFileSync(path.join(HERE, 'public', f), 'utf8')
  for (const m of js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1])
  for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1])
  // 脚本自己用 innerHTML 渲染出来的元素（登录框、令牌框、教程分页…）：
  // 它们在 HTML 里当然不存在，是脚本自己造的 —— 也算"有人提供"。
  for (const m of js.matchAll(/id="([A-Za-z0-9_-]+)"/g)) rendered.add(m[1])
}

const have = new Set()
for (const m of html.matchAll(/id="([A-Za-z0-9_-]+)"/g)) have.add(m[1])

const missing = [...used].filter((x) => !have.has(x) && !rendered.has(x)).sort()
const unusedIds = [...have].filter((x) => !used.has(x)).sort()

console.log(`${JS_FILES.join(' + ')} 取用 id ${used.size} 个；index.html 声明 ${have.size} 个；脚本自己渲染出 ${rendered.size} 个\n`)

check('★ 脚本要用的每个 id 都有人提供（HTML 里，或它自己渲染）', missing.length === 0,
  `没人提供的：${missing.join(', ')}（浏览器里会直接抛异常 ⇒ 整页 JS 不执行）`)
// boot() 里第一句就点名的几个：它们一旦缺失，boot 会在第一行就炸
for (const id of ['hamb', 'scrim', 'readerClose', 'reader', 'toast']) {
  check(`boot 的关键元素 ${id} 在 HTML 里`, have.has(id))
}
// 教程文档页的三块容器：docs.js 一上来就抓它们，缺一个教程页就是白屏
for (const id of ['docsNav', 'docsBody', 'docsToc']) {
  check(`教程页的容器 ${id} 在 HTML 里`, have.has(id))
}
if (unusedIds.length) console.log(`  ℹ️  HTML 里有、脚本没直接取的 id：${unusedIds.join(', ')}`)

console.log(`\n前端 id 一致性：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
