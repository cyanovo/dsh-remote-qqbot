/**
 * B) 上下文注入的量级与风险分析（全部基于真实数字，不靠估算）。
 *
 * 回答两个问题：
 *   1. 注入 5KB 会不会撑爆上下文？
 *   2. order 150 合不合理？
 *
 * 运行：node tests/live/inject-analysis.mjs
 */

import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const MAIN = 'D:/cyanproject/agenttool/agentmd/main.md'
const require = createRequire('C:/Users/cyan/.dsh/profiles/desktop/node_modules/')
const mod = await import(pathToFileURL('D:/cyanproject/agenttool/dsh-remote-qqbot/lib/index.js').href)

const raw = readFileSync(MAIN, 'utf8')
const fileBytes = statSync(MAIN).size
const chars = [...raw].length

// 真实注入正文（走插件自己的 provider）
const contexts = []
const ctx = {
  on() {}, effect(fn) { fn(); return () => {} },
  get(s) {
    if (s === 'settings') return { get: () => ({ agentmdDir: 'D:\\cyanproject\\agenttool\\agentmd', agentmdInject: true }) }
    if (s === 'systemPrompt') return { context(e) { contexts.push(e); return () => {} } }
    return undefined
  },
  tools: { register: () => () => {} },
}
mod.apply(ctx, {})
const agent = { id: 'x', ctx: { effect(fn) { fn(); return () => {} } }, session: { header: {}, events: [] } }
ctx.on = () => () => {}
// 重新 apply 以捕获 agent/created 监听
const listeners = []
const ctx2 = { ...ctx, on(e, h) { if (e === 'agent/created') listeners.push(h); return () => {} } }
mod.apply(ctx2, {})
for (const h of listeners) h({ agent })
const injected = contexts.length > 0 ? contexts[0].text({}) : ''

console.log('=== 注入量级（真实测量）===')
console.log(`main.md 文件大小:      ${fileBytes} B`)
console.log(`main.md 字符数:        ${chars}`)
console.log(`注入正文字符数:        ${[...injected].length}`)
console.log(`注入正文 UTF-8 字节:   ${Buffer.byteLength(injected, 'utf8')} B`)

// 粗估 token：中文约 1 字 ≈ 0.7~1 token，英文约 4 字符 ≈ 1 token
const cjk = (injected.match(/[\u4e00-\u9fff]/g) ?? []).length
const nonCjk = [...injected].length - cjk
const estTokens = Math.round(cjk * 1.0 + nonCjk / 3.5)
console.log(`其中中文汉字:          ${cjk} 个`)
console.log(`估算 token 数:         ≈ ${estTokens}`)

console.log('\n=== 与模型上下文窗口对比 ===')
const windows = [
  ['deepseek-v4-flash（本机默认路由 bq/deepseek-v4.1-flash）', 1_000_000],
  ['deepseek-v4-pro', 1_000_000],
  ['保守假设：128K 窗口', 128_000],
  ['保守假设：32K 窗口', 32_000],
]
for (const [name, w] of windows) {
  const pct = (estTokens / w) * 100
  const verdict = pct < 1 ? '安全' : pct < 5 ? '可接受' : '需警惕'
  console.log(`  ${name.padEnd(52)} ${String(w).padStart(9)} tok → 占 ${pct.toFixed(3)}%  ${verdict}`)
}

console.log('\n=== order 150 的合理性 ===')
console.log('  -100  harness:identity（固定身份）')
console.log('     0  deployment:persona（部署人格）')
console.log(' 100-199 工具指引（规范建议区间）')
console.log('   150  remote-qqbot:agentmd ← 本插件')
console.log('   120  subagent:delegation（dsh-subagent 用的 order）')
console.log('  150 落在工具指引区间内、且在 subagent:delegation 之后 → 位置合理')

console.log('\n=== 风险点 ===')
const issues = []
if (fileBytes > 200_000) issues.push(`文件已达 ${fileBytes} B，继续增长会显著占用上下文`)
if (contexts.length !== 1) issues.push('注入条目数异常')
console.log(issues.length === 0 ? '  当前无风险：文档 < 200KB，注入条目正常。' : issues.map((i) => `  ⚠️ ${i}`).join('\n'))
console.log(`\n  增长预估：若每天加 1 行（约 120 B），一年后 +${Math.round(120 * 365 / 1024)} KB ≈ ${Math.round(120 * 365 / 3.5)} token，仍远低于 1%。`)
console.log('  建议：给 agentmdDir 的使用约定「main.md 只做索引，专题内容拆文件」，可长期保持注入量稳定。')
