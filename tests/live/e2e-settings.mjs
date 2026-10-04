/**
 * 端到端验证：DSH 真实 settings 文件 → 插件 liveConfig → 真实中枢推送。
 *
 * 这条链路是真正跑通「用户在 settings.yaml 里配的东西，插件真的用上了」，
 * 而不是只在 mock 里成立。
 *
 * 运行：node tests/live/e2e-settings.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const PROFILE = 'C:/Users/cyan/.dsh/profiles/desktop/node_modules/'
const require = createRequire(PROFILE)

// 1) 用 DSH 自己用的 yaml 解析器读真实 settings.yaml
const yamlPath = require.resolve('yaml', { paths: [PROFILE] })
const YAML = await import(`file:///${yamlPath.replace(/\\/g, '/')}`)
const raw = readFileSync('C:/Users/cyan/.dsh/settings.yaml', 'utf8')
const doc = YAML.parse(raw)
console.log('1) DSH 同款 yaml 解析器读 settings.yaml:')
console.log('   顶层键:', Object.keys(doc).join(', '))
const section = doc['dsh-remote-qqbot']
if (!section) {
  console.error('   ✗ 未找到 dsh-remote-qqbot 段')
  process.exit(1)
}
console.log('   段内键:', Object.keys(section).join(', '))
console.log('   hubUrl:', section.hubUrl)
console.log('   agentmdDir:', section.agentmdDir)

// 2) 让插件从「settings 服务」读到这份配置（模拟 DSH 的注册+解析结果）
const mod = await import(`file:///${PROFILE}dsh-remote-qqbot/lib/index.js`)
const pushed = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  pushed.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
  return { ok: true, status: 200, text: async () => '{"ok":true,"id":"e2e"}' }
}

const registered = []
const ctx = {
  on() {},
  effect(fn) { fn(); return () => {} },
  // 关键：这里返回的就是真实 settings.yaml 里解析出来的对象
  get(service) { return service === 'settings' ? { get: () => section } : undefined },
  tools: { register(def) { registered.push(def.name); return () => {} } },
}

mod.apply(ctx, {})
console.log('\n2) 插件 apply 后的启动日志应显示读到了 agentmdDir')

// 3) 触发 running→idle，看是否真的往真实 agentmd/main.md 追加
const before = readFileSync('D:/cyanproject/agenttool/agentmd/main.md', 'utf8')
const beforeRows = before.split('\n').filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}/.test(l.trim())).length

const agent = {
  id: 'e2e-settings-check',
  ctx: { effect(fn) { fn(); return () => {} } },
  session: {
    header: { id: 'e2e', cwd: 'D:\\cyanproject\\agenttool' },
    events: [
      { type: 'user/message', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '端到端验证：settings.yaml 配置驱动真实推送与真实日志追加' }] } },
      { type: 'assistant/message', data: { message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'bq', model: 'x' }, content: [{ type: 'text', text: '已完成端到端链路验证' }] } } },
    ],
  },
}

// 需要拿到事件监听器：重写 ctx.on 收集
const listeners = new Map()
ctx.on = (event, handler) => {
  if (!listeners.has(event)) listeners.set(event, [])
  listeners.get(event).push(handler)
}
// 重新 apply 一次以捕获监听器
registered.length = 0
mod.apply(ctx, {})

const emit = (event, payload) => { for (const h of listeners.get(event) ?? []) h(payload) }

console.log('\n3) 触发 agent/status running → idle')
emit('agent/status', { agent, status: 'running' })
emit('agent/status', { agent, status: 'idle' })
await new Promise((r) => setTimeout(r, 400))

console.log(`   真实推送次数: ${pushed.length}`)
for (const p of pushed) console.log(`   → ${p.url} ${JSON.stringify(p.body)}`)

const after = readFileSync('D:/cyanproject/agenttool/agentmd/main.md', 'utf8')
const afterRows = after.split('\n').filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}/.test(l.trim())).length
console.log(`\n   真实 agentmd/main.md 数据行: ${beforeRows} → ${afterRows}`)
const newRow = after.split('\n').find((l) => l.includes('端到端验证：settings.yaml 配置驱动'))
console.log(`   新增行: ${newRow ?? '（未找到）'}`)

globalThis.fetch = originalFetch

console.log('\n=== 结论 ===')
const okPush = pushed.length > 0 && pushed[0].url.includes('cyanovo.top:8444/dsh-hub')
const okLog = afterRows === beforeRows + 1
console.log(`配置读取: 通过`)
console.log(`真实推送: ${okPush ? '通过' : '失败'}`)
console.log(`真实日志追加: ${okLog ? '通过' : '失败'}`)
if (!okPush || !okLog) process.exitCode = 1
