// 渲染服务的断言检查（本地自测用，不部署到服务器）
const BASE = process.env.BASE ?? 'http://127.0.0.1:8791'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

const r = await fetch(`${BASE}/dsh/sample.md`)
const html = await r.text()

console.log('=== 基本响应 ===')
ok('状态 200', r.status === 200, `实际 ${r.status}`)
ok('Content-Type 是 HTML', /text\/html/.test(r.headers.get('content-type') ?? ''), r.headers.get('content-type'))
ok('声明 utf-8', /charset=utf-8/i.test(r.headers.get('content-type') ?? ''))

console.log('\n=== 结构渲染 ===')
ok('h1 标题', /<h1[^>]*>/.test(html))
ok('h2 标题', /<h2[^>]*>/.test(html))
ok('表格', /<table>/.test(html) && /<thead>/.test(html) && /<tbody>/.test(html))
ok('表头单元格', /<th[^>]*>项<\/th>/.test(html))
ok('代码块', /<pre><code>/.test(html))
ok('代码块语言标记', /data-lang="js"/.test(html))
ok('代码块内容保留', /export function pickPromptMode/.test(html))
ok('行内 code', /<code>inline code<\/code>/.test(html))
ok('有序列表', /<ol>/.test(html))
ok('无序列表（嵌套）', /<ul>/.test(html))
ok('引用块', /<blockquote>/.test(html))
ok('分隔线', /<hr>/.test(html))
ok('粗体', /<strong>/.test(html))
ok('斜体', /<em>/.test(html))
ok('删除线', /<del>/.test(html))
ok('markdown 链接', /<a href="https:\/\/example\.com"[^>]*>链接<\/a>/.test(html))
ok('裸链接自动链接', /<a href="https:\/\/cyanovo\.top:8444\/dsh\/7zyjx\.md"/.test(html))
ok('中文正常', /跑完了/.test(html))

console.log('\n=== 安全性 ===')
ok('script 标签被转义', html.includes('&lt;script&gt;alert'), '未找到转义后的 script')
ok('没有可执行的 script 注入', !/<script>alert\('xss/.test(html))
ok('有 nosniff 头', r.headers.get('x-content-type-options') === 'nosniff')
ok('<sub> 白名单放行（插件结尾那行不再显示成字面量）', /<sub>由 dsh-notify-memory 自动记录/.test(html))
ok('未放行的标签照旧转义（没有开通用逃生口）', !/<iframe|<img onerror|<div onclick/i.test(html))

console.log('\n=== 页面外壳 ===')
ok('viewport（手机适配）', /name="viewport"/.test(html))
ok('深色模式自适应', /prefers-color-scheme:dark/.test(html))
ok('无外部资源引用', !/https?:\/\/(?!cyanovo|example)[^"']*\.(css|js|woff)/.test(html))
ok('标题取自 h1', /<title>✅ main 跑完了<\/title>/.test(html), (/<title>([^<]*)<\/title>/.exec(html) ?? [])[1])
ok('原文链接存在', /href="\/dsh\/raw\/sample\.md"/.test(html))

console.log('\n=== 边界情况 ===')
const r404 = await fetch(`${BASE}/dsh/nosuch.md`)
ok('不存在的 id → 404', r404.status === 404, `实际 ${r404.status}`)
const h404 = await r404.text()
ok('404 也是漂亮页面', /找不到这份回答/.test(h404))

const rBad = await fetch(`${BASE}/dsh/..%2f..%2fetc%2fpasswd.md`)
ok('路径穿越被拒', rBad.status === 404, `实际 ${rBad.status}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
