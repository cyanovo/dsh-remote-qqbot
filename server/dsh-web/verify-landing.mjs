/**
 * 首页落地页的**线上**验收：直接打公网（或本地 server.mjs），核对
 * 「送出去的那份 HTML」确实是官网首页，而不是"空卡片 + 一句标题"。
 *
 * 为什么不能只看本地文件：本地对不等于线上对（部署漏拷、缓存、路径写错都见过）。
 * 这个脚本还顺带核对 HTML/CSS/JS 与本地**逐字节一致**（md5），把"部署漏了"钉死。
 *
 * 用法：
 *   node verify-landing.mjs                      # 默认打 http://cyanovo.top
 *   node verify-landing.mjs http://127.0.0.1:8795
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = (process.argv[2] || 'http://cyanovo.top').replace(/\/$/, '')

let pass = 0
let fail = 0
const check = (name, okk, detail = '') => {
  if (okk) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `　${detail}` : ''}`) }
}
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex')

console.log(`── 首页落地页验收（${BASE}）──\n`)

const home = await fetch(`${BASE}/`)
const html = await home.text()
check('首页 200 且是 HTML', home.status === 200 && html.includes('<!doctype'), `HTTP ${home.status}`)
check('标题是插件名字', /<title>DSH 通知插件 · 网页端<\/title>/.test(html))

// 把「首页」那一段单独切出来看 —— 整份 HTML 里还有账号页，混在一起会看串
const seg = (name) => (html.match(new RegExp(`<section class="view" data-view="${name}"[\\s\\S]*?</section>`)) || [''])[0]
const ov = seg('overview').replace(/<!--[\s\S]*?-->/g, '')
const acc = seg('account')

check('首页那一段切出来了', ov.length > 800, `实际 ${ov.length} 字`)
check('★ 首页有品牌级标题（h1）', /<h1[^>]*>[\s\S]*?DSH 通知插件/.test(ov))
check('★ 首页正文是静态的，没有靠 JS 填的空卡片', !/id="(quotaCard|modesCard|payCard)"/.test(ov))
for (const s of ['登录 / 注册', '直接发到 QQ', '只存服务器', '100 次', '5 小时', '1000 次', '48 小时', '¥2.99', '怎么装', '常见问题', '不经过服务器']) {
  check(`首页写了「${s}」`, ov.includes(s))
}
check('额度/模式/兑换卡都在账号页里', /id="quotaCard"/.test(acc) && /id="modesCard"/.test(acc) && /id="payCard"/.test(acc))

// 2026-10-04 新增：教程文档页（第五个视图）。线上必须有这一栏的骨架，
// 否则「教程文档」点下去就是空白 —— 这是它最低限度的存在性证明。
const docs = seg('docs')
check('★ 首页里多了「教程文档」导航项', /data-view="docs"/.test(html))
check('★ 教程文档那一段切出来了（左章节/中正文/右目录）',
  docs.length > 300 && /id="docsNav"/.test(docs) && /id="docsBody"/.test(docs) && /id="docsToc"/.test(docs),
  `实际 ${docs.length} 字`)
check('教程页的样式与脚本都挂上了', /href="\/docs\.css"/.test(html) && /src="\/docs\.js"/.test(html) && /src="\/docs-figs\.js"/.test(html))

// 静态资源：线上那份必须与本地**逐字节一致**
for (const [url, rel] of [
  ['/style.css', 'public/style.css'],
  ['/app.js', 'public/app.js'],
  ['/', 'public/index.html'],
  ['/docs.css', 'public/docs.css'],
  ['/docs.js', 'public/docs.js'],
  ['/docs-figs.js', 'public/docs-figs.js'],
]) {
  const r = await fetch(`${BASE}${url}`)
  const buf = Buffer.from(await r.arrayBuffer())
  const local = fs.readFileSync(path.join(HERE, rel))
  check(`${url} 送出的字节与本地 ${rel} 完全一致`, md5(buf) === md5(local),
    `线上 ${md5(buf).slice(0, 8)} ≠ 本地 ${md5(local).slice(0, 8)}`)
}

// 教程里引用的每一张截图都必须在线上真的取得到（否则教程页是一堆破图）
const imgNames = [...fs.readFileSync(path.join(HERE, 'public/docs.js'), 'utf8').matchAll(/shot\('([a-z0-9-]+)'/g)].map((m) => m[1])
check('docs.js 里引用的截图有 6 张', imgNames.length === 6, `实际 ${imgNames.join(', ')}`)
for (const n of imgNames) {
  const r = await fetch(`${BASE}/docs-img/${n}.png`)
  const buf = Buffer.from(await r.arrayBuffer())
  const png = buf.length > 3000 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  check(`截图 /docs-img/${n}.png 线上 200 且是真 PNG（${buf.length} B）`, r.status === 200 && png, `HTTP ${r.status}`)
}

console.log(`\n首页落地页验收：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
