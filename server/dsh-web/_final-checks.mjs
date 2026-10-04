#!/usr/bin/env node
// 只读收尾检查：走 80 端口公网入口（Host: cyanovo.top），验证 SPA / meta / 笔记渲染 / 8443 未被影响。
// 用法（在服务器上）： node /tmp/dsh-web-checks.mjs [笔记文件名，如 56tbj.html]
// 为什么用 node:http 而不是 fetch：需要显式覆盖 Host 头，fetch 对此有限制。
import http from 'node:http'
import https from 'node:https'

const NOTE = (process.argv[2] || '').trim()
const HOST = 'cyanovo.top'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

function get(url, host) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Host: host || u.host },
      rejectUnauthorized: false,
      timeout: 10000,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.end()
  })
}

console.log(`\n== 公网路由检查 @ http://${HOST}/（生产入口，80 端口）==\n`)

console.log('[1] 前端页面（SPA）')
try {
  const r = await get(`http://127.0.0.1/`, HOST)
  ok('GET / → 200', r.status === 200, String(r.status))
  ok('返回 HTML', String(r.headers['content-type'] || '').includes('text/html'), String(r.headers['content-type']))
  ok('首页含备案号 豫ICP备2026030622号', r.body.includes('豫ICP备2026030622号'))
  ok('首页引用了 app.js 与 style.css', r.body.includes('app.js') && r.body.includes('style.css'))
  const js = await get(`http://127.0.0.1/app.js`, HOST)
  ok('GET /app.js → 200', js.status === 200, String(js.status))
  const css = await get(`http://127.0.0.1/style.css`, HOST)
  ok('GET /style.css → 200', css.status === 200, String(css.status))
  const spa = await get(`http://127.0.0.1/records`, HOST)
  ok('SPA 兜底：/records 也返回页面', spa.status === 200 && spa.body.includes('豫ICP备2026030622号'), String(spa.status))
} catch (e) {
  ok('前端页面可访问', false, e.message)
}

console.log('\n[2] 公开接口')
try {
  const r = await get(`http://127.0.0.1/api/meta`, HOST)
  ok('GET /api/meta → 200', r.status === 200, String(r.status))
  let m = null
  try { m = JSON.parse(r.body) } catch { /* 保持 null */ }
  ok('三档模式 id 正确', !!m && JSON.stringify((m.modes || []).map((x) => x.id)) === '["chat","note","note-link"]')
  ok('免费额度 100 / 保留 5 小时 / 价格 2.99',
    !!m && m.freeDaily === 100 && m.retentionMs === 5 * 3600 * 1000 && m.priceCny === '2.99')
  const h = await get(`http://127.0.0.1/health`, HOST)
  ok('GET /health → 200 且 ok=true', h.status === 200 && JSON.parse(h.body).ok === true, h.body)
  const rec = await get(`http://127.0.0.1/api/records`, HOST)
  ok('未登录访问 /api/records → 401', rec.status === 401, String(rec.status))
} catch (e) {
  ok('公开接口可访问', false, e.message)
}

console.log('\n[3] 笔记渲染（/dsh/<id>.html，QQ 链接用的就是这条）')
if (!NOTE) {
  console.log('  （没有可抽查的笔记，跳过）')
} else {
  try {
    const r = await get(`http://127.0.0.1/dsh/${NOTE}`, HOST)
    ok(`GET /dsh/${NOTE} → 200`, r.status === 200, String(r.status))
    ok('是渲染后的 HTML（text/html）', String(r.headers['content-type'] || '').includes('text/html'), String(r.headers['content-type']))
    ok('含 <html> 与 viewport（手机友好）', r.body.includes('<html') && r.body.includes('viewport'))
    ok('不含未渲染的裸露标题记号', !/(^|\n)##\s/.test(r.body.replace(/<[^>]+>/g, '')))
    const raw = await get(`http://127.0.0.1/dsh/raw/${NOTE.replace(/\.html$/, '.md')}`, HOST)
    console.log(`  · 「原文」路由 /dsh/raw/${NOTE.replace(/\.html$/, '.md')} → ${raw.status} ${raw.headers['content-type']}`)
  } catch (e) {
    ok('笔记渲染可访问', false, e.message)
  }
}

console.log('\n[4] 不该被 dsh-web 吞掉的路径')
try {
  const wk = await get(`http://127.0.0.1/.well-known/security.txt`, HOST)
  ok('/.well-known/security.txt 不是 200（没被 SPA 兜底吞掉）', wk.status !== 200, `实际 ${wk.status}`)
  const nf = await get(`http://127.0.0.1/api/nope`, HOST)
  ok('未知 /api/* → 404', nf.status === 404, String(nf.status))
  const bad = await get(`http://127.0.0.1/..%2f..%2fetc%2fpasswd`, HOST)
  ok('路径穿越被拦（非 200）', bad.status !== 200, `实际 ${bad.status}`)
} catch (e) {
  ok('路径类检查', false, e.message)
}

console.log('\n[5] 8443 老面板未被影响')
try {
  const r = await get(`https://127.0.0.1:8443/`, HOST)
  ok('https://127.0.0.1:8443/ 仍是 200', r.status === 200, String(r.status))
} catch (e) {
  ok('8443 可访问', false, e.message)
}

console.log(`\n== 公网路由：通过 ${pass} / 失败 ${fail} ==\n`)
process.exit(fail === 0 ? 0 : 1)
