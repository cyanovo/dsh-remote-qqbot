/**
 * 中枢真实连通性联调（不打桩，真发 HTTP）。
 *
 * 1. POST /event 推一条事件
 * 2. GET /api/events 读回并确认刚才那条在里面
 * 3. GET /memory 顺便探一下记忆接口
 *
 * 运行：node tests/live/hub-connectivity.mjs
 */

import { resolveHub } from './_hub-config.mjs'

const cfg = resolveHub()
if (!cfg) process.exit(0) // 未配置则跳过，不是失败

const HUB = cfg.hubUrl
const TOKEN = cfg.token
console.log(`（凭据来源：${cfg.source}）`)

/** 带鉴权的请求封装。 */
async function call(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'
  const url = `${HUB}${path}`
  const started = Date.now()
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text.slice(0, 400) }
  }
  return { url, method, status: res.status, ok: res.ok, ms: Date.now() - started, data }
}

const stamp = new Date().toISOString()
const summary = `插件联调：agentmd 自动日志与上下文注入已完成（${stamp}）`

console.log('中枢真实连通性联调\n')

console.log('1) POST /event 推送一条测试事件')
const posted = await call('/event', {
  method: 'POST',
  body: { kind: 'turn-complete', summary, project: 'agenttool', sessionId: 'plugin-dev-connectivity-check' },
})
console.log(`   ${posted.method} ${posted.url}`)
console.log(`   HTTP ${posted.status}（${posted.ms}ms）`)
console.log(`   响应: ${JSON.stringify(posted.data)}`)

console.log('\n2) GET /api/events 读回')
const listed = await call('/api/events')
console.log(`   ${listed.method} ${listed.url}`)
console.log(`   HTTP ${listed.status}（${listed.ms}ms）`)
const events = Array.isArray(listed.data?.items ?? listed.data?.events ?? listed.data)
  ? (listed.data.items ?? listed.data.events ?? listed.data)
  : []
console.log(`   共读回 ${events.length} 条事件`)
const hit = events.find((e) => JSON.stringify(e).includes(summary.slice(0, 30)))
console.log(`   刚才推送的那条: ${hit ? '✓ 已在列表中' : '✗ 未找到'}`)
if (hit) console.log(`   原始记录: ${JSON.stringify(hit)}`)
else if (events.length > 0) console.log(`   最新一条: ${JSON.stringify(events[events.length - 1])}`)

console.log('\n3) GET /memory 探测记忆接口')
const mem = await call('/memory')
console.log(`   HTTP ${mem.status}（${mem.ms}ms） → ${JSON.stringify(mem.data).slice(0, 200)}`)

console.log('\n=== 结论 ===')
const postOk = posted.status >= 200 && posted.status < 300
const getOk = listed.status >= 200 && listed.status < 300
console.log(`POST /event: ${postOk ? '通过' : '失败'}`)
console.log(`GET /api/events: ${getOk ? '通过' : '失败'}`)
console.log(`读回确认: ${hit ? '通过' : '失败'}`)

if (!postOk || !getOk || !hit) process.exitCode = 1
