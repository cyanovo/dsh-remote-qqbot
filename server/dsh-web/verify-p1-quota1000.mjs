/**
 * 支持者档「一天 1000 次」**上限本身**的验收：真打 1000 次，第 1001 次必须 429。
 *
 * 为什么单独一个脚本、而且把保留期调到 10 分钟：
 *   · 验的是配额不是 TTL，但被打的那条记录必须活到第 1001 次请求；
 *   · 每次查看都会原子落盘（usage 计数），1000 次请求的耗时不可控 —— 用 5 秒保留期会
 *     在半路过期，于是拿到的是 404 而不是 429，测试会假红。
 * 反向校验：`P1_SERVER` 指向回退了「支持者不计数」的副本时，这条必须报红。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-q1000-'))
const DATA = path.join(TMP, 'data')
const PORT = 18797
const BASE = `http://127.0.0.1:${PORT}`
const SERVER = process.env.P1_SERVER ? path.resolve(process.env.P1_SERVER) : path.join(HERE, 'server.mjs')

process.env.DSH_WEB_DATA = DATA
process.env.DSH_WEB_PORT = String(PORT)
process.env.DSH_WEB_HOST = '127.0.0.1'
process.env.DSH_WEB_ROOT = path.join(HERE, 'public')
process.env.DSH_WEB_RETENTION_MS = String(600_000)
process.env.DSH_WEB_PRO_RETENTION_MS = String(600_000)

function client() {
  let cookie = ''
  return async (p, { method = 'GET', body, headers = {} } = {}) => {
    const h = { ...headers }
    if (cookie) h.cookie = cookie
    let payload
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(`${BASE}${p}`, { method, headers: h, body: payload })
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const kv = c.split(';')[0]
      if (kv.startsWith('dsw_session=')) cookie = kv.endsWith('=') ? '' : kv
    }
    const text = await res.text()
    try { return { status: res.status, data: JSON.parse(text) } } catch { return { status: res.status, data: { raw: text.slice(0, 100) } } }
  }
}

await import(pathToFileURL(SERVER).href)
let up = false
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${BASE}/health`); if (r.ok) { up = true; break } } catch { /* 等 */ }
  await new Promise((r) => setTimeout(r, 100))
}
if (!up) { console.log('✗ 服务没起来'); process.exit(1) }

const erin = client()
const anon = client()
let fail = 0
let total = 0
const check = (name, okk, detail = '') => {
  total++
  if (!okk) fail++
  console.log(`${okk ? '  ✓' : '  ✗'} ${name}${okk ? '' : `　${detail}`}`)
}

await erin('/api/register', { method: 'POST', body: { username: 'erin', password: 'erin1234' } })
const adminTok = fs.readFileSync(path.join(DATA, 'publish-token'), 'utf8').trim()
const code = (await anon('/api/codes', { method: 'POST', headers: { 'x-publish-token': adminTok }, body: { count: 1 } })).data.codes[0]
const red = await erin('/api/redeem', { method: 'POST', body: { code } })
check('erin 兑换后是支持者档、额度 1000', red.data.me.plan === 'pro' && red.data.me.quota.limit === 1000,
  `plan=${red.data.me.plan} limit=${red.data.me.quota.limit}`)

const tk = (await erin('/api/tokens', { method: 'POST', body: { label: 'q1000' } })).data.token
const rec = await anon('/api/publish', {
  method: 'POST', headers: { authorization: `Bearer ${tk}` },
  body: { text: '支持者配额测试', title: 'q1000', mode: 'note' },
})
check('支持者记录的保留期按支持者档（本进程调到 10 分钟）', rec.data.retentionText === '600 秒', `实测 ${rec.data.retentionText}`)
const id = rec.data.id

const t0 = Date.now()
let bad = 0
let lastUsed = -1
for (let i = 0; i < 1000; i++) {
  const r = await erin(`/api/records/${id}/view`, { method: 'POST', body: {} })
  if (r.status !== 200) { bad++; if (bad === 1) console.log(`      第 ${i + 1} 次就失败了：HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`) ; break }
  lastUsed = r.data.quota.used
}
const elapsed = Date.now() - t0
check('1000 次查看全部成功', bad === 0, `失败 ${bad} 次`)
check('计数真的走到 1000', lastUsed === 1000, `实测 used=${lastUsed}`)

const over = await erin(`/api/records/${id}/view`, { method: 'POST', body: {} })
check('★ 第 1001 次 → 429', over.status === 429, `实测 HTTP ${over.status} ${JSON.stringify(over.data).slice(0, 120)}`)
check('429 文案说明是 1000 次用完了', String(over.data && over.data.error).includes('1000'), `实测 ${over.data && over.data.error}`)
check('429 带上配额对象（前端能显示剩余）', !!(over.data && over.data.quota) && over.data.quota.remaining === 0,
  JSON.stringify(over.data && over.data.quota))

console.log(`\n1000 次耗时 ${elapsed} ms（平均 ${(elapsed / 1000).toFixed(2)} ms/次，每次都原子落盘）`)
console.log(`支持者配额验收：${total - fail} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
