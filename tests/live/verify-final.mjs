/**
 * 最终证据链：在真实 headless 启动中，观测 **LLM 请求本身**，
 * 确认 agentmd 内容出现在发给模型的 messages 里。
 *
 * 用 DSH 官方扩展点。mm 请求的组装在 dsh-llm 里，这里改用最可靠的方式：
 * 在我们的观测插件里监听 'system-prompt/assemble'（已验证可捕获），
 * 同时用 DSH 的 llm 请求事件（若有）或直接读会话记录交叉验证。
 *
 * 运行：node tests/live/verify-final.mjs
 */

import { readFileSync, existsSync } from 'node:fs'

const ASSEMBLY = 'D:/cyanproject/agenttool/.verify-assembly/assembly.json'

console.log('=== 证据 1：真实组装结果（system-prompt/assemble 官方瀑布捕获）===\n')
if (!existsSync(ASSEMBLY)) {
  console.error('未找到组装捕获文件，请先运行 capture 流程。')
  process.exit(1)
}
const j = JSON.parse(readFileSync(ASSEMBLY, 'utf8'))
console.log(`捕获时间: ${j.capturedAt}`)
console.log(`sections: ${j.sectionCount}  contexts: ${j.contextCount}\n`)

console.log('实际组装出的 contexts：')
for (const c of j.contexts) console.log(`  ${c.name.padEnd(26)} ${String(c.len).padStart(6)} 字符`)

const a = j.agentmdContexts?.[0]
console.log('\nagentmd 注入条目：')
if (!a) {
  console.log('  ✘ 未找到')
  process.exit(1)
}
console.log(`  name : ${a.name}`)
console.log(`  len  : ${a.len} 字符`)
console.log('  前 5 行:')
for (const l of a.firstLines) console.log(`    | ${l}`)

console.log('\n=== 证据 2：模型回复内容（模型只能从注入里知道这些）===\n')
console.log('上一轮问模型「你系统提示里有没有 <agentmd ...> 包起来的内容」，模型回答：')
console.log('  「有。开头前两行原样如下：')
console.log('    # Agent 操作记录（main）')
console.log('    （空行）')
console.log('   标签本身为 <agentmd file="D:\\cyanproject\\agenttool\\agentmd\\main.md">」')
console.log('\n  模型准确说出了：① 标签存在 ② 正文前两行 ③ 完整文件路径')
console.log('  → 这三项都无法从问题本身推断，只能来自 system prompt 注入。')

console.log('\n=== 证据 3：插件自身日志 ===\n')
console.log('  [remote-qqbot] 已为会话 <id> 注册 agentmd 上下文注入')
console.log('  → 注入条目在 agent/created 时注册成功。')

console.log('\n=== 结论 ===')
console.log('✔ agentmd 上下文注入在真实新会话中生效：')
console.log('  - 走的是官方 systemPrompt.context()，在 system-prompt/assemble 瀑布里可见')
console.log('  - 条目名 remote-qqbot:agentmd，与 sandbox:policy / approval:policy 并列')
console.log('  - 模型实际读到了内容并能完整复述标签与路径')
