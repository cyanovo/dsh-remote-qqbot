// 线上后台验收：静态页 + 鉴权三态 + 概览接口
//   node _live-admin.mjs <admin-token>
const TOKEN = process.argv[2]
if (!TOKEN) { console.error('用法: node _live-admin.mjs <admin-token>'); process.exit(2) }

const BASES = ['http://cyanovo.top', 'https://cyanovo.top']
let pass = 0, fail = 0
function chk(name, ok, extra = '') {
  if (ok) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')) }
}
async function req(base, path, opts = {}) {
  const r = await fetch(base + path, { redirect: 'manual', ...opts })
  const text = await r.text()
  return { status: r.status, text, headers: r.headers, type: r.headers.get('content-type') || '' }
}

for (const base of BASES) {
  console.log(`\n=== ${base} ===`)
  try {
    const page = await req(base, '/admin.html')
    chk('后台页面 200', page.status === 200, String(page.status))
    chk('后台页面是 HTML', page.type.includes('text/html'), page.type)
    chk('页面标题是后台管理', page.text.includes('后台管理'))
    chk('页面带 noindex', page.text.includes('noindex'))
    chk('页面引了 admin.js', page.text.includes('/admin.js'))
    for (const f of ['/admin.css', '/admin.js', '/style.css']) {
      const a = await req(base, f)
      chk(`静态资源 ${f} 200`, a.status === 200, String(a.status))
    }

    const noTok = await req(base, '/api/admin/overview')
    chk('不带口令 → 401', noTok.status === 401, String(noTok.status))
    chk('401 不回任何数据', !noTok.text.includes('"users"'))
    const bad = await req(base, '/api/admin/overview', { headers: { 'x-admin-token': 'wrong-token-aaaaaaaa' } })
    chk('错口令 → 401', bad.status === 401, String(bad.status))
    const good = await req(base, '/api/admin/overview', { headers: { 'x-admin-token': TOKEN } })
    chk('对口令 → 200', good.status === 200, String(good.status) + ' ' + good.text.slice(0, 200))
    let j = null
    try { j = JSON.parse(good.text) } catch { /* ignore */ }
    chk('概览是合法 JSON', !!j)
    if (j) {
      chk('概览含 totals.users/records', !!j.totals && typeof j.totals.users === 'number' && typeof j.totals.records === 'number', JSON.stringify(j.totals))
      chk('概览含 14 天趋势', Array.isArray(j.trend) && j.trend.length === 14, String(j.trend && j.trend.length))
      chk('概览报了内存与运行时长', typeof j.memoryMB === 'number' && typeof j.uptimeSec === 'number')
      chk('概览报了口令文件位置', typeof j.config?.adminFile === 'string')
      chk('口令绝不回显', !good.text.includes(TOKEN))
    }
    const bearer = await req(base, '/api/admin/overview', { headers: { authorization: 'Bearer ' + TOKEN } })
    chk('Bearer 形式也能进', bearer.status === 200, String(bearer.status))
    const pubTok = await req(base, '/api/admin/users')
    chk('用户列表不带口令 → 401', pubTok.status === 401, String(pubTok.status))
  } catch (e) {
    fail++
    console.log('  ❌ 本段异常 — ' + e.message)
  }
}

console.log(`\n>>> 通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
