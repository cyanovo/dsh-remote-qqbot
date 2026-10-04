/**
 * 端到端验证（严格版）：真实 settings.yaml → 插件 → 真实中枢 HTTP → 真实 agentmd 追加。
 *
 * 与 e2e-settings.mjs 的区别：这里只 apply 一次，且**不替换 fetch**，
 * 真的把事件发到中枢，再读回来确认落库。
 *
 * 运行：node tests/live/e2e-real.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const PROFILE = 'C:/Users/cyan/.dsh/profiles/desktop/node_modules/'
const require = createRequire(PROFILE)
const yamlPath = require.resolve('yaml', { paths: [PROFILE] })
const YAML = await import(`file:///${yamlPath.replace(/\\/g, '/')}`)

const settings = YAML.parse(readFileSync('C:/Users/cyan/.dsh/settings.yaml', 'utf8'))['dsh-remote-qqbot']
const HUB = settings.hubUrl
const TOKEN = settings.token
console.log('settings.hubUrl =', HUB)
console.log('settings.agentmdDir =', settings.agentmdDir)

const SESSION_ID = `e2e-real-${Date.now()}`
const MARK = `真实链路验证 ${SESSION_ID}`

// ── 组装 mock ctx（只 apply 一次）────────────────────────────────────────
const listeners = new Map()
const registeredTools = []
const contexts = []
const ctx = {
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(handler)
    return () => {}
  },
  effect(fn) { fn(); return () => {} },
  get(service) {
    if (service === 'settings') return { get: () => settings }
    if (service === 'systemPrompt') return { context(e) { contexts.push(e); return () => {} }, section() { return () => {} } }
    return undefined
  },
  tools: { register(def) { registeredTools.push(def.name); return () => {} } },
}

const mod = await import(`file:///${PROFILE}dsh-remote-qqbot/lib/index.js`)
mod.apply(ctx, {})
console.log('\n工具:', registeredTools.sort().join(', '))

// ── 上下文注入验证（agentmdInject: true）────────────────────────────────
const agent = {
  id: SESSION_ID,
  ctx: { effect(fn) { fn(); return () => {} } },
  session: {
    header: { id: SESSION_ID, cwd: 'D:\\cyanproject\\agenttool' },
    events: [
      { type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: MARK }] } },
      { type: 'assistant/message', data: { message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'bq', model: 'x' }, content: [{ type: 'text', text: '链路验证完成' }] } } },
    ],
  },
}
const emit = (event, payload) => { for (const h of listeners.get(event) ?? []) h(payload) }

emit('agent/created', { agent })
console.log('注入的上下文条数:', contexts.length)
if (contexts.length === 1) {
  const text = contexts[0].text({})
  console.log('  名称:', contexts[0].name, '| order:', contexts[0].order)
  console.log('  注入正文长度:', [...text].length, '字符')
  console.log('  包含真实 main.md 标题:', text.includes('# Agent 操作记录（main）'))
  console.log('  包含操作日志表头:', text.includes('| 时间 | 操作 | 结果 |'))
}

// ── 真实推送 + 真实追加 ────────────────────────────────────────────────
const mainMd = 'D:/cyanproject/agenttool/agentmd/main.md'
const beforeRows = readFileSync(mainMd, 'utf8').split('\n').filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}/.test(l.trim())).length

emit('agent/status', { agent, status: 'running' })
emit('agent/status', { agent, status: 'idle' })
await new Promise((r) => setTimeout(r, 1500))

const afterRows = readFileSync(mainMd, 'utf8').split('\n').filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}/.test(l.trim())).length
const newLine = readFileSync(mainMd, 'utf8').split('\n').find((l) => l.includes(MARK))

// ── 从真实中枢读回 ─────────────────────────────────────────────────────
const res = await fetch(`${HUB}/api/events`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
  signal: AbortSignal.timeout(20000),
})
const data = await res.json()
const mine = (data.items ?? []).find((e) => e.sessionId === SESSION_ID)

console.log('\n=== 结论 ===')
console.log(`1) settings.yaml 被插件读到:      ${settings.hubUrl === HUB ? '通过' : '失败'}`)
console.log(`2) 上下文注入注册成功:            ${contexts.length === 1 ? '通过' : '失败'}`)
console.log(`3) 真实 agentmd 追加:             ${afterRows === beforeRows + 1 ? '通过' : '失败'}（${beforeRows} → ${afterRows}）`)
console.log(`   新增行: ${newLine}`)
console.log(`4) 真实中枢落库（GET /api/events）: ${mine ? '通过' : '失败'}`)
if (mine) console.log(`   ${JSON.stringify(mine)}`)

if (afterRows !== beforeRows + 1 || !mine) process.exitCode = 1
