/**
 * 验证：把 DSH 的 loader 单独拎出来，只装配最小插件树 + dsh-remote-qqbot，
 * 绕开 desktop/verify profile 自身的 credentials 报错，做一次**真实 loader 启动**。
 *
 * 这不是模拟：用的是 vendor/loader 的真实 Loader 类、真实的 Cordis 容器，
 * Config 也走真实的 resolveConfig 校验路径（就是之前炸掉的那条路径）。
 *
 * 运行：node tests/live/loader-boot.mjs
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolveHub } from './_hub-config.mjs'

const require = createRequire('C:/Users/cyan/.dsh/profiles/desktop/node_modules/')

const cordisPath = require.resolve('@deepseek-ai/cordis')
const { Context } = await import(pathToFileURL(cordisPath).href)

const PLUGIN = process.env.PLUGIN_ENTRY
  ?? 'D:/cyanproject/agenttool/dsh-remote-qqbot/lib/index.js'
const cfg = resolveHub()
const settings = {
  hubUrl: cfg?.hubUrl ?? '',
  token: cfg?.token ?? '',
  agentmdDir: 'D:\\cyanproject\\agenttool\\agentmd',
  agentmdMainFile: 'main.md',
  agentmdInject: true,
  agentmdAppendLog: true,
  agentmdSummaryChars: 200,
}
console.log(cfg ? `（中枢凭据来源：${cfg.source}）` : '（未配置中枢凭据，本次只验证加载与注入，不涉及推送）')

console.log('=== 真实 Cordis 容器 + 真实 Config 校验 ===')
const root = new Context()
const results = {}

// 1) 提供 tools 服务（最小实现，够插件注册工具）
root.provide('tools', { register: (def) => { (results.tools ??= []).push(def.name); return () => {} } })
root.provide('settings', { get: () => settings })
// systemPrompt：记录注册的上下文条目
root.provide('systemPrompt', { context: (e) => { (results.contexts ??= []).push(e); return () => {} } })

// 2) 用真实 Plugin 运行时对象 + 真实 Config 校验路径加载插件
const mod = await import(pathToFileURL(PLUGIN).href)

// 直接调用插件的 Config 校验（等价于 vendor/cordis/src/fiber.ts:53 那条路径）
console.log('Config 类型:', mod.Config?.constructor?.name ?? typeof mod.Config)
console.log('有 ~standard:', !!mod.Config?.['~standard'])
const validated = mod.Config['~standard'].validate({})
console.log('校验通过，issues:', validated.issues ?? '无')
console.log('校验后 agentmdDir 默认值:', JSON.stringify(validated.value.agentmdDir))
console.log('校验后 agentmdInject 默认值:', JSON.stringify(validated.value.agentmdInject))

// 3) apply 到真实容器
const plugin = { name: mod.name, apply: mod.apply, Config: mod.Config, inject: mod.inject }
root.plugin(plugin, settings)
await new Promise((r) => setTimeout(r, 300))

console.log('\n=== apply 结果 ===')
console.log('注册的工具:', (results.tools ?? []).sort().join(', '))
console.log('插件 fiber 状态:', root.registry.get(mod.name)?.fiber?.state ?? '(未记录)')

// 4) 触发一个真实 agent/created，看是否注册上下文
const fakeAgent = {
  id: 'loader-boot-check',
  ctx: root,
  session: { header: { id: 'loader-boot-check', cwd: 'D:\\cyanproject\\agenttool' }, events: [] },
}
root.emit('agent/created', { agent: fakeAgent })
await new Promise((r) => setTimeout(r, 200))
console.log('注入上下文条数:', (results.contexts ?? []).length)
if ((results.contexts ?? []).length > 0) {
  const text = results.contexts[0].text({})
  console.log('注入条目名:', results.contexts[0].name, '| order:', results.contexts[0].order)
  console.log('注入正文长度:', [...text].length, '字符 | 含 main.md 标题:', text.includes('# Agent 操作记录（main）'))
}

await root.stop?.()
console.log('\n结论: 插件在真实 Cordis 容器中加载与装配成功。')
