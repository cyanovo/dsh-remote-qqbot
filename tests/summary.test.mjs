/**
 * 本轮摘要提取（src/summary.js）的自测。
 *
 * 🔴 这一组是为 2026-10-07 的事故立的回归：
 *    主人发新消息把正在跑的一轮打断时，会话事件末尾是
 *      [ …, 上一轮的 assistant/message, 本轮新来的 user/message ]
 *    —— 本轮没有任何 assistant/message。旧实现倒着扫、各取"第一条找到的"，
 *    配出「本轮问题 → 上一轮回复」；而上一轮回复一直不变，于是每打断一次，
 *    就把同一段旧文字往 QQ 再推一次（主人实测连收三条一模一样的信息）。
 *
 * 断言口径：回复**必须晚于**本轮那条真人 user/message，否则算本轮没产出。
 *
 * 运行：node tests/summary.test.mjs
 */

import assert from 'node:assert/strict'
import {
  blocksToText, composeChatAnswer, composeChatSummary, composeSummary,
  extractTurnSummary, inferResult,
} from '../src/summary.js'

let passed = 0
let failed = 0

/**
 * 极简断言包装。
 * @param {string} name - 用例名。
 * @param {() => void} fn - 用例体。
 */
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${name}\n      ${err?.stack ?? err}`)
  }
}

/** 造一条真人 user/message 事件。 */
function userMsg(text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { source, content: [{ type: 'text', text }] } }
}

/** 造一条 assistant/message 事件。 */
function assistantMsg(text) {
  return {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

/** 用事件数组拼一个 agent。 */
const agentWith = (events) => ({ id: 'session-x', session: { header: { id: 'session-x' }, events } })

console.log('本轮摘要提取（src/summary.js）\n')

console.log('[1] 按轮次配对：回复必须晚于本轮用户消息')

test('正常完成的一轮：用户消息 + 其后的回复', () => {
  const parts = extractTurnSummary(agentWith([
    userMsg('帮我把插件重构成多文件结构'),
    assistantMsg('已完成拆分：src/index.js、src/summary.js'),
  ]))
  assert.equal(parts.userText, '帮我把插件重构成多文件结构')
  assert.equal(parts.assistantText, '已完成拆分：src/index.js、src/summary.js')
  assert.equal(parts.source, 'session.events')
})

test('★ 回归：被打断的那一轮 —— 只有上一轮的回复，绝不能当成本轮结果', () => {
  // 事故现场的真实形状：Q1/A1 是上一轮，Q2 是本轮新来的消息，本轮没有回复。
  const parts = extractTurnSummary(agentWith([
    userMsg('可以把我的人机验证换成 Cloudflare 的吗？'),
    assistantMsg('可以，技术上没有障碍。我实测了三件事…'),
    userMsg('帮我优化一下网页的前端页面吧，你先分析一下有哪些改进的地方。'),
  ]))
  assert.equal(parts.userText, '帮我优化一下网页的前端页面吧，你先分析一下有哪些改进的地方。')
  assert.equal(parts.assistantText, '',
    '本轮没有回复时必须为空串 —— 返回上一轮的文字正是"三条一样的信息"的根因')
  // 顺带证明下游不会再把旧回答顶上来（调用方靠 assistantText 为空来跳过通知）。
  assert.equal(composeChatAnswer(parts, 1500), parts.userText)
})

test('连续打断两次：只认本轮用户消息，回复仍为空', () => {
  const parts = extractTurnSummary(agentWith([
    userMsg('Q1'), assistantMsg('A1'),
    userMsg('Q2'), assistantMsg('A2'),
    userMsg('Q3'),
  ]))
  assert.equal(parts.userText, 'Q3')
  assert.equal(parts.assistantText, '')
})

test('多轮都完整：取最新那一轮的回复，不串轮', () => {
  const parts = extractTurnSummary(agentWith([
    userMsg('Q1'), assistantMsg('A1'),
    userMsg('Q2'), assistantMsg('A2'),
  ]))
  assert.equal(parts.userText, 'Q2')
  assert.equal(parts.assistantText, 'A2')
})

test('一轮里有多次助手消息（流式分片）：取最新的那条，且仍在用户消息之后', () => {
  const parts = extractTurnSummary(agentWith([
    userMsg('Q1'), assistantMsg('A1-第一段'), assistantMsg('A1-第二段'),
  ]))
  assert.equal(parts.userText, 'Q1')
  assert.equal(parts.assistantText, 'A1-第二段')
})

test('★ 最新回复正文为空（只调工具、没说话）：不许往前捞旧回复', () => {
  const parts = extractTurnSummary(agentWith([
    userMsg('Q1'), assistantMsg('A1'),
    userMsg('Q2'), assistantMsg(''),
  ]))
  assert.equal(parts.userText, 'Q2')
  assert.equal(parts.assistantText, '', '空正文的回复算这一轮的产出，不能退回去用 A1')
})

test('只有用户消息（历史上"跑一半只有提问"的情形）：回复为空', () => {
  const parts = extractTurnSummary(agentWith([userMsg('跑个任务')]))
  assert.equal(parts.userText, '跑个任务')
  assert.equal(parts.assistantText, '')
})

test('只有助手消息（没有真人输入）：回复照常取出', () => {
  const parts = extractTurnSummary(agentWith([assistantMsg('A1')]))
  assert.equal(parts.userText, '')
  assert.equal(parts.assistantText, 'A1')
})

console.log('\n[2] 防御性：陌生结构与插件注入')

test('没有 events：两边都空、不抛错', () => {
  // 结构化读取一无所获 ⇒ 会走去 agent 对象上深搜的兜底路径，所以 source 是 fallback:deep。
  assert.deepEqual(extractTurnSummary({ id: 'x', session: { header: {} } }),
    { userText: '', assistantText: '', source: 'fallback:deep' })
  assert.deepEqual(extractTurnSummary({ id: 'x' }),
    { userText: '', assistantText: '', source: 'fallback:deep' })
  assert.deepEqual(extractTurnSummary(undefined),
    { userText: '', assistantText: '', source: 'fallback:deep' })
})

test('session.log 也能读（备用字段名）', () => {
  const parts = extractTurnSummary({ id: 'x', session: { log: [userMsg('Q1'), assistantMsg('A1')] } })
  assert.equal(parts.userText, 'Q1')
  assert.equal(parts.assistantText, 'A1')
})

test('agent.inject() 注入的 user/message 不算真人输入', () => {
  // 注入排在最后：它不该被当成本轮的用户消息，于是上一轮的 Q1/A1 依然自洽。
  const parts = extractTurnSummary(agentWith([
    userMsg('Q1'), assistantMsg('A1'),
    userMsg('（插件注入的上下文）', { kind: 'plugin' }),
  ]))
  assert.equal(parts.userText, 'Q1')
  assert.equal(parts.assistantText, 'A1')
})

test('事件数组里混入 null / 字符串 / 数字也不抛错', () => {
  const parts = extractTurnSummary(agentWith([
    null, 'junk', 42, undefined, userMsg('Q1'), assistantMsg('A1'),
  ]))
  assert.equal(parts.userText, 'Q1')
  assert.equal(parts.assistantText, 'A1')
})

console.log('\n[3] 结果列：中断不是完成')

test('有回复 → 完成', () => {
  assert.equal(inferResult({}, false, true), '完成')
  assert.equal(inferResult({}, false), '完成', '不传 hasReply 时保持老行为')
})

test('只有用户消息、没有回复 → 已中断（无回复）', () => {
  assert.equal(inferResult({}, false, false), '已中断（无回复）')
})

test('出错优先于"没回复"（错因信息量更大）', () => {
  assert.equal(inferResult({}, true, false), '出错（详见日志）')
  assert.equal(inferResult({}, true, true), '出错（详见日志）')
})

console.log('\n[4] 摘要文案（下游怎么用这两个字段）')

test('assistantText 为空时 composeChatSummary 退回用户消息（不是旧回复）', () => {
  const parts = extractTurnSummary(agentWith([userMsg('Q1'), assistantMsg('A1'), userMsg('Q2')]))
  assert.equal(composeChatSummary(parts, 150), 'Q2')
})

test('日志行在中断时只留用户消息，不出现旧回复', () => {
  const parts = extractTurnSummary(agentWith([userMsg('Q1'), assistantMsg('旧回答字面量'), userMsg('Q2')]))
  const row = composeSummary(parts, 200)
  assert.equal(row, 'Q2')
  assert.ok(!row.includes('旧回答字面量'))
})

test('blocksToText 保住换行（回归：曾把整篇回答压成一行）', () => {
  assert.equal(blocksToText([{ type: 'text', text: '第一行\n\n## 标题' }]), '第一行\n\n## 标题')
})

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
