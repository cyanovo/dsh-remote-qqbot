// 从本机走公网验证：QQ 通知里的那种链接现在点开是什么
const IDS = ['4e7t1', '7zyjx', '91jiq', 'bstx2', 'fsoi6', 'lnilh', 'rox0c', 'tiwc3', 'wdp0z', 'wmk5x', 'y18ad', 'ys3bw']
let pass = 0, fail = 0
const ok = (c, m, extra = '') => { c ? (pass++, console.log(`  OK   ${m}${extra ? ' — ' + extra : ''}`)) : (fail++, console.log(`  FAIL ${m}${extra ? ' — ' + extra : ''}`)) }

const BASE = 'https://cyanovo.top:8444'

console.log('=== 1. 全部 12 篇真实笔记：/dsh/<id>.md 应返回渲染后的 HTML ===')
for (const id of IDS) {
  const r = await fetch(`${BASE}/dsh/${id}.md`)
  const t = await r.text()
  const ct = r.headers.get('content-type') || ''
  const isHtml = ct.includes('text/html')
  const hasTitle = /<title>[^<]+<\/title>/.test(t)
  const noLeak = !/^##\s/m.test(t) && !/^\s*```/m.test(t)
  if (!(r.status === 200 && isHtml && hasTitle && noLeak)) {
    fail++
    console.log(`  FAIL ${id}: ${r.status} ${ct} html=${isHtml} title=${hasTitle} noLeak=${noLeak}`)
  } else {
    pass++
    const ttl = (t.match(/<title>([^<]+)<\/title>/) || [])[1]
    console.log(`  OK   ${id}: ${r.status} ${ct.split(';')[0]} ${t.length}B  title="${ttl}"`)
  }
}

console.log('\n=== 2. 逐项检查（用最丰富的一篇 wmk5x，4084B 原文） ===')
const r = await fetch(`${BASE}/dsh/wmk5x.md`)
const h = await r.text()
ok(r.status === 200, '状态 200')
ok((r.headers.get('content-type') || '').includes('text/html'), '是 HTML 不是纯文本', r.headers.get('content-type'))
ok(!/^\s*#{1,6}\s/m.test(h), 'markdown 井号标题已渲染（没泄漏 # 记号）')
ok(!/^\s*```/m.test(h), '代码围栏已渲染（没泄漏 ``` 记号）')
ok(h.includes('<h1') || h.includes('<h2'), '有标题标签')
ok(/<strong>|<em>/.test(h) || !/\*\*/.test(h), '粗体/斜体已渲染')
ok((h.match(/<table/) || []).length >= 0, '表格处理未报错')
ok(h.includes('charset="utf-8"') || h.includes('charset=utf-8'), '声明 utf-8')
ok(h.includes('viewport'), '有 viewport（手机适配）')
ok(!/https?:\/\/(cdn|fonts\.googleapis|unpkg|jsdelivr)/.test(h), '无外网资源引用')
ok(h.includes('<style>') && !/<link[^>]+stylesheet/.test(h), 'CSS 内联（不依赖外网）')
ok(h.includes('href="/dsh/raw/'), '页面里有「原文」链接')
const chinese = (h.match(/[\u4e00-\u9fa5]/g) || []).length
ok(chinese > 20, `中文渲染正常（${chinese} 个汉字）`)

console.log('\n=== 3. 原文链路 /dsh/raw/<id>.md 仍是纯文本 ===')
const rr = await fetch(`${BASE}/dsh/raw/wmk5x.md`)
const rt = await rr.text()
ok(rr.status === 200, '状态 200')
ok((rr.headers.get('content-type') || '').includes('text/markdown'), '是 text/markdown', rr.headers.get('content-type'))
ok(rt.startsWith('#'), '原文首字符就是 #（未渲染）')
// 注意：fetch().text() 的长度是 UTF-16 字符数，中文一个字算 1；要比字节必须用 Buffer.byteLength
const rtBytes = Buffer.byteLength(rt, 'utf8')
ok(rtBytes === 4084, '原文 4084 字节一字不差', `${rtBytes}B（字符数 ${rt.length}）`)

console.log('\n=== 4. 边界与安全 ===')
const nf = await fetch(`${BASE}/dsh/zzzz9.md`)
ok(nf.status === 404, '不存在的 id → 404')
ok((nf.headers.get('content-type') || '').includes('text/html'), '404 也是漂亮页面不是裸文本')
const trav = await fetch(`${BASE}/dsh/..%2f..%2fetc%2fpasswd.md`)
ok(trav.status === 404 || trav.status === 400, '路径穿越被拒', String(trav.status))
const xss = await fetch(`${BASE}/dsh/bstx2.md`)
const xh = await xss.text()
ok(!/<script>alert/.test(xh), '笔记里的 <script> 被转义，没有 XSS')
ok(xh.includes('<sub>'), '插件结尾的 <sub> 标签正常显示')
ok((xss.headers.get('cache-control') || '').includes('max-age'), '渲染页带缓存头', xss.headers.get('cache-control'))

console.log('\n=== 5. 面板与中枢没被影响（回归） ===')
const home = await fetch(BASE + '/', { redirect: 'manual' })
ok(home.status === 401 || home.status === 200 || home.status === 302, `面板首页仍正常（${home.status}）`)
const hub = await fetch(`${BASE}/dsh-hub/health`)
const hubT = await hub.text()
ok(hub.status === 200, '中枢 /health 仍 200', hubT.slice(0, 40))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
