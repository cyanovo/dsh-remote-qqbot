/**
 * 协作模式（collab.js）单测。
 *
 * 全程**纯逻辑、不需要 DSH**：collab.js 只用 node: 内置模块，
 * defineTool / ctx 都由测试注入 —— 所以这些用例跑得飞快，也不受桌面版影响。
 *
 * 重点锁死三类"静默失效"（本项目吃过太多亏）：
 *   1. 单人环境下**不能往上下文里塞任何东西**（注入必须返回空串）；
 *   2. 面板自动区块**不能吃掉人工写的内容**（合并必须逐字保留标记之外的文字）；
 *   3. 冲突时**不能覆盖别人的占用登记**（否则丢掉的正是冲突证据本身）。
 *
 * 运行：node tests/collab.test.mjs（需先 node scripts/build.mjs）
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const M = await import('../lib/collab.js')

let passed = 0
let failed = 0

/**
 * 极简断言包装。
 * @param {string} name - 用例名。
 * @param {() => void | Promise<void>} fn - 用例体。
 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${name}\n      ${err?.stack ?? err}`)
  }
}

/** 造一个最小 mock ctx（事件 / systemPrompt / tools 三件套）。 */
function makeCtx() {
  const listeners = new Map()
  const registry = new Map()
  const contexts = []
  return {
    listeners,
    contexts,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    get(name) {
      if (name !== 'systemPrompt') return undefined
      return { context: (entry) => { contexts.push(entry); return () => {} } }
    },
    // ⚠️ registry 与 ctx.tools 必须分开：早先两者同名，ctx.tools 退化成只有 register 的
    //    对象，callTool 里的 get() 永远 undefined（写 mock 时踩过这个坑）。
    tools: {
      register(tool) { registry.set(tool.name, tool); return () => {} },
      get(name) { return registry.get(name) },
      has(name) { return registry.has(name) },
      keys() { return registry.keys() },
      get size() { return registry.size },
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
}

/** 造一个 mock Agent。 */
function makeAgent({ id, cwd = 'D:\\proj', title = '', origin, depth, parentSession } = {}) {
  const header = { cwd }
  if (title) header.title = title
  if (origin) header.origin = origin
  if (depth !== undefined) header.delegationDepth = depth
  if (parentSession) header.parentSession = parentSession
  return { id, session: { header }, ctx: { effect: (fn) => { fn(); return () => {} } } }
}

/** 触发某个事件的所有监听器。 */
function emit(ctx, event, ...args) {
  for (const fn of ctx.listeners.get(event) ?? []) fn(...args)
}

/** 模拟一次工具调用：先 pre-execute（记下调用者），再执行工具。 */
async function callTool(ctx, toolName, args, agent) {
  emit(ctx, 'tools/pre-execute', { name: toolName, arguments: args, agent }, () => {})
  const tool = ctx.tools.get(toolName)
  assert.ok(tool, `工具 ${toolName} 未注册`)
  return tool.execute(args)
}

console.log('\n[1] 路径与工具识别')

await test('normalizePath 统一分隔符 / 去尾斜杠 / 大小写', () => {
  assert.equal(M.normalizePath('D:\\a\\B\\'), 'd:/a/b')
  assert.equal(M.normalizePath('d:/a/b/'), 'd:/a/b')
  assert.equal(M.normalizePath(''), '')
})

await test('workspaceKey：同一个目录的不同写法得到同一个 key', () => {
  assert.equal(M.workspaceKey('D:\\proj\\x'), M.workspaceKey('d:/proj/x/'))
  assert.notEqual(M.workspaceKey('D:/proj/x'), M.workspaceKey('D:/proj/y'))
})

await test('isWriteTool：只有会改文件的工具才算', () => {
  for (const n of ['write', 'edit', 'multi_edit', 'apply_patch', 'create_file', 'move_file', 'delete_file']) {
    assert.equal(M.isWriteTool(n), true, `${n} 应算写操作`)
  }
  for (const n of ['read', 'grep', 'glob', 'pwsh', 'shell', 'ask_user_question', 'collab_status', 'memory_read']) {
    assert.equal(M.isWriteTool(n), false, `${n} 不该算写操作`)
  }
})

await test('extractPaths：从写工具参数里挖出路径，读工具一律返回空', () => {
  assert.deepEqual(M.extractPaths('edit', { file_path: 'D:\\p\\a.js', old_string: 'x' }), ['D:\\p\\a.js'])
  assert.deepEqual(M.extractPaths('write', { file_path: 'a.js', content: 'hi' }), ['a.js'])
  assert.deepEqual(M.extractPaths('read', { file_path: 'a.js' }), [], '读文件不该被登记为占用')
  assert.deepEqual(M.extractPaths('grep', { path: 'src' }), [], 'grep 的 path 不是写目标')
  assert.deepEqual(M.extractPaths('multi_edit', { files: ['a.js', 'b.js'] }), ['a.js', 'b.js'])
  assert.deepEqual(M.extractPaths('apply_patch', { patch: { path: 'nested.js' } }), ['nested.js'])
})

console.log('\n[2] 子智能体判定（回归：fork 不能被误判）')

await test('origin=subagent / delegationDepth>=1 判定为子智能体', () => {
  assert.equal(M.isSubagentAgent(makeAgent({ id: 's1', origin: 'subagent' })), true)
  assert.equal(M.isSubagentAgent(makeAgent({ id: 's2', depth: 2 })), true)
})

await test('★ 只有 parentSession（用户自己 fork 的会话）不算子智能体', () => {
  const forked = makeAgent({ id: 'f1', parentSession: 'sess-parent' })
  assert.equal(M.isSubagentAgent(forked), false,
    'fork 出来的会话带 parentSession，但它是主人自己的会话，必须照常参与协作')
})

await test('describeAgent 从 header 里取 cwd / 标题，标题缺失时回退到 id', () => {
  const a = makeAgent({ id: 'session-abcdef123456', cwd: 'D:\\p', title: 'UI 会话' })
  assert.deepEqual(M.describeAgent(a), { id: 'session-abcdef123456', cwd: 'D:\\p', title: 'UI 会话', isSubagent: false })
  const b = M.describeAgent(makeAgent({ id: 'session-abcdef123456' }))
  assert.equal(b.title, '会话 session-')
})

console.log('\n[3] 会话注册表')

await test('upsert 幂等：同一会话重复注册不会变成两条', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.upsert(makeAgent({ id: 'a', title: 'A' }))
  s.upsert(makeAgent({ id: 'a', title: 'A2' }))
  assert.equal(s.sessions.size, 1)
  assert.equal(s.get('a').title, 'A2')
})

await test('peers 只返回同工作区的会话，且排除自己', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.upsert(makeAgent({ id: 'a', cwd: 'D:\\p1', title: 'A' }))
  s.upsert(makeAgent({ id: 'b', cwd: 'D:\\p1', title: 'B' }))
  s.upsert(makeAgent({ id: 'c', cwd: 'D:\\p2', title: 'C' }))
  const peers = s.peers('D:\\p1', { excludeId: 'a' })
  assert.deepEqual(peers.map((x) => x.id), ['b'])
  assert.equal(s.peers('D:\\p1', { scope: 'global', excludeId: 'a' }).length, 2, 'global 范围应带上 c')
})

await test('peers 按 TTL 过滤掉太久没动静的会话，running 排前面', () => {
  let t = 1000
  const s = new M.CollabState({ now: () => t })
  s.upsert(makeAgent({ id: 'old', cwd: 'D:\\p', title: 'old' }))
  t = 1000 + M.SESSION_TTL_MS + 1
  s.upsert(makeAgent({ id: 'fresh', cwd: 'D:\\p', title: 'fresh' }))
  s.touch('fresh', 'idle')
  const peers = s.peers('D:\\p', { excludeId: 'me' })
  assert.deepEqual(peers.map((x) => x.id), ['fresh'], '过期的 old 应被排除')
})

console.log('\n[4] 文件占用')

await test('claim 后 conflict 能查到占用者，release 后查不到', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.claim('D:\\p\\a.js', 'sess-1', { title: '甲' })
  assert.equal(s.conflict('D:\\p\\a.js', 'sess-2').length, 1)
  assert.equal(s.conflict('D:\\p\\a.js', 'sess-1').length, 0, '自己占的不算冲突')
  assert.equal(s.release('D:\\p\\a.js', 'sess-1'), true)
  assert.equal(s.conflict('D:\\p\\a.js', 'sess-2').length, 0)
})

await test('★ 两个会话都登记同一文件时互不覆盖（否则丢的是冲突证据）', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.claim('a.js', 'sess-1', { title: '甲' })
  s.claim('a.js', 'sess-2', { title: '乙' })
  const holders = s.conflict('a.js', 'sess-3')
  assert.equal(holders.length, 2, '两个占用者都要在')
  assert.equal(s.conflict('a.js', 'sess-1').length, 1, '甲仍能看到乙占着')
  assert.equal(s.claimedBy('sess-1').length, 1)
})

await test('路径大小写 / 斜杠不同也视为同一个文件', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.claim('D:\\Proj\\A.js', 'sess-1')
  assert.equal(s.conflict('d:/proj/a.js', 'sess-2').length, 1)
})

await test('releaseAll 释放该会话全部占用；sweepClaims 清掉过期登记', () => {
  let t = 1000
  const s = new M.CollabState({ now: () => t })
  s.claim('a.js', 'sess-1')
  s.claim('b.js', 'sess-1')
  s.claim('c.js', 'sess-2')
  assert.equal(s.releaseAll('sess-1'), 2)
  assert.equal(s.claims.size, 1)
  t = 1000 + M.CLAIM_TTL_MS + 1
  s.sweepClaims()
  assert.equal(s.claims.size, 0)
  assert.equal(s.conflict('c.js', 'sess-9').length, 0, '过期占用不算冲突')
})

console.log('\n[5] 留言与提醒')

await test('post 的留言别人能读到、自己读不到；markRead 后清空', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.upsert(makeAgent({ id: 'a', title: '甲' }))
  s.upsert(makeAgent({ id: 'b', title: '乙' }))
  s.post('a', '这个文件我在改', { title: '甲' })
  assert.equal(s.unread('b').length, 1)
  assert.equal(s.unread('a').length, 0, '自己发的不该出现在自己的未读里')
  s.markRead('b')
  assert.equal(s.unread('b').length, 0)
})

await test('★ notes 只读：连续取两次都还在（注入每个 step 都会调用）', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.upsert(makeAgent({ id: 'a' }))
  s.note('a', '别写 a.js')
  assert.equal(s.snapshotNotes('a').length, 1)
  assert.equal(s.snapshotNotes('a').length, 1, '只读，不能被第一次调用清空')
  s.clearNotes('a')
  assert.equal(s.snapshotNotes('a').length, 0)
})

await test('留言超出上限时保留最近的', () => {
  const s = new M.CollabState({ now: () => 1000 })
  for (let i = 0; i < M.MAX_MESSAGES + 10; i += 1) s.post('a', `msg-${i}`)
  assert.equal(s.messages.length, M.MAX_MESSAGES)
  assert.equal(s.messages.at(-1).text, `msg-${M.MAX_MESSAGES + 9}`)
})

console.log('\n[6] 注入渲染（关键：单人环境必须闭嘴）')

await test('★ 没有其他会话、没有留言、没有提醒 → 注入空串', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.upsert(makeAgent({ id: 'a', cwd: 'D:\\p', title: 'A' }))
  assert.equal(M.renderInjection(s, { cwd: 'D:\\p', sessionId: 'a' }), '',
    '单人环境往上下文里塞任何字都是噪音')
})

await test('有别的会话时给出会话清单 + 占用 + 规则', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.upsert(makeAgent({ id: 'me', cwd: 'D:\\p', title: '我' }))
  s.upsert(makeAgent({ id: 'you', cwd: 'D:\\p', title: 'UI 会话' }))
  s.claim('D:\\p\\src\\index.js', 'you', { title: 'UI 会话' })
  const text = M.renderInjection(s, { cwd: 'D:\\p', sessionId: 'me' })
  assert.match(text, /协作模式/)
  assert.match(text, /UI 会话/)
  assert.match(text, /index\.js/)
  assert.match(text, /collab_claim/, '必须告诉它怎么认领')
})

await test('他人的留言会出现在注入里', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.upsert(makeAgent({ id: 'me', cwd: 'D:\\p', title: '我' }))
  s.upsert(makeAgent({ id: 'you', cwd: 'D:\\p', title: 'UI 会话' }))
  s.post('you', 'src/index.js 归我，你别动', { title: 'UI 会话' })
  const text = M.renderInjection(s, { cwd: 'D:\\p', sessionId: 'me' })
  assert.match(text, /归我/)
})

await test('注入长度超上限时截断，并指向 collab_status', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.upsert(makeAgent({ id: 'me', cwd: 'D:\\p', title: '我' }))
  for (let i = 0; i < 20; i += 1) {
    s.upsert(makeAgent({ id: `p${i}`, cwd: 'D:\\p', title: `很长的会话标题-${i}-${'x'.repeat(30)}` }))
    s.post(`p${i}`, 'y'.repeat(200), { title: `很长的会话标题-${i}` })
  }
  const text = M.renderInjection(s, { cwd: 'D:\\p', sessionId: 'me' })
  assert.ok(text.length <= M.MAX_INJECT_CHARS + 60, `实际 ${text.length}`)
  assert.match(text, /已截断/)
})

console.log('\n[7] 面板合并（关键：不能吃掉人工内容）')

await test('★ 合并只替换标记之间的内容，标记外的人工文字逐字保留', () => {
  const human = '# 协作板\n\n## 一、五条铁律\n\n1. 写前登记\n\n这是我的手工笔记。\n'
  const withBlock = M.mergePanel(human, `${M.AUTO_BEGIN}\nOLD\n${M.AUTO_END}`)
  const merged = M.mergePanel(withBlock, `${M.AUTO_BEGIN}\nNEW\n${M.AUTO_END}`)
  assert.ok(merged.includes('## 一、五条铁律'), '人工标题必须还在')
  assert.ok(merged.includes('这是我的手工笔记。'), '人工正文必须逐字还在')
  assert.ok(merged.includes('NEW') && !merged.includes('OLD'), '自动区块要被替换')
  assert.ok(merged.startsWith('# 协作板'), '人工内容仍在最前面')
})

await test('文件里没有标记时，自动区块追加到末尾', () => {
  const merged = M.mergePanel('人工内容\n', `${M.AUTO_BEGIN}\nX\n${M.AUTO_END}`)
  assert.ok(merged.startsWith('人工内容'), '人工内容不能被顶掉')
  assert.ok(merged.includes(M.AUTO_BEGIN) && merged.includes(M.AUTO_END))
})

await test('renderAutoBlock 输出会话 / 占用 / 留言三张表', () => {
  const s = new M.CollabState({ now: () => 1000 })
  s.upsert(makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' }))
  s.upsert(makeAgent({ id: 'b', cwd: 'D:\\p', title: '乙', origin: 'subagent' }))
  s.claim('D:\\p\\a.js', 'a', { title: '甲' })
  s.post('a', '留言内容', { title: '甲' })
  const block = M.renderAutoBlock(s, { cwd: 'D:\\p', now: 1000 })
  assert.match(block, /活跃会话/)
  assert.match(block, /文件占用/)
  assert.match(block, /会话留言/)
  assert.match(block, /甲/)
  assert.match(block, /子智能体/, '子智能体应被标出来')
  assert.match(block, /留言内容/)
})

await test('★ 留言里出现标记字面量时不会被当成区块（加固：必须独占一行）', () => {
  const body = `# 板子\n\n有人在这里讨论格式：写作 ${M.AUTO_BEGIN} 和 ${M.AUTO_END} 即可。\n`
  const merged = M.mergePanel(body, `${M.AUTO_BEGIN}\nAUTO\n${M.AUTO_END}`)
  assert.ok(merged.startsWith(body), '原内容必须逐字保留在最前面')
  assert.ok(merged.trimEnd().endsWith(M.AUTO_END), '自动区块应追加在末尾')
  assert.equal(merged.split('有人在这里讨论格式').length - 1, 1, '留言不能被劈成两半')
})

await test('标记独占一行时才替换，且 end 标记不会重复、标记后的人工内容仍在', () => {
  const body = `# 板子\n\n${M.AUTO_BEGIN}\nOLD\n${M.AUTO_END}\n\n结尾的人工留言\n`
  const merged = M.mergePanel(body, `${M.AUTO_BEGIN}\nNEW\n${M.AUTO_END}`)
  assert.ok(merged.includes('NEW') && !merged.includes('OLD'), '自动区块要被替换')
  assert.ok(merged.includes('结尾的人工留言'), '标记之后的人工内容必须保留')
  assert.ok(merged.includes('# 板子'), '标记之前的人工内容必须保留')
  assert.equal(merged.split(M.AUTO_END).length - 1, 1, 'end 标记只能有一个')
})

console.log('\n[8] installCollab 集成（mock ctx）')

/** 造一个装好协作模式的 ctx + 配置。 */
function setup({ dir = '', extra = {}, log = () => {} } = {}) {
  const ctx = makeCtx()
  const config = {
    collabEnabled: true,
    agentmdDir: dir,
    ...extra,
  }
  const state = M.installCollab(ctx, {
    defineTool: (spec) => spec,
    getConfig: () => config,
    log,
  })
  return { ctx, state, config }
}

await test('注册 4 个协作工具', () => {
  const { ctx } = setup()
  assert.deepEqual([...ctx.tools.keys()].sort(),
    ['collab_claim', 'collab_post', 'collab_release', 'collab_status'])
})

await test('agent/created → 会话入表，并在 systemPrompt 上注册协作上下文', () => {
  const { ctx, state } = setup()
  emit(ctx, 'agent/created', { agent: makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' }) })
  assert.equal(state.get('a').title, '甲')
  assert.equal(ctx.contexts.length, 1)
  assert.equal(ctx.contexts[0].name, 'remote-qqbot:collab')
  assert.equal(ctx.contexts[0].order, 160)
})

await test('子智能体默认不入表、不注入上下文', () => {
  const { ctx, state } = setup()
  emit(ctx, 'agent/created', { agent: makeAgent({ id: 'sub', cwd: 'D:\\p', origin: 'subagent' }) })
  assert.equal(state.get('sub'), null)
  assert.equal(ctx.contexts.length, 0)
})

await test('collabIncludeSubagents=true 时子智能体也参与', () => {
  const { ctx, state } = setup({ extra: { collabIncludeSubagents: true } })
  emit(ctx, 'agent/created', { agent: makeAgent({ id: 'sub', cwd: 'D:\\p', origin: 'subagent' }) })
  assert.ok(state.get('sub'))
  assert.equal(ctx.contexts.length, 1)
})

await test('agent/status idle → 自动释放该会话占用的文件', () => {
  const { ctx, state } = setup()
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  emit(ctx, 'agent/created', { agent: a })
  emit(ctx, 'tools/pre-execute', { name: 'edit', arguments: { file_path: 'a.js' }, agent: a }, () => {})
  assert.equal(state.claimedBy('a').length, 1)
  emit(ctx, 'agent/status', { agent: a, status: 'idle' })
  assert.equal(state.claimedBy('a').length, 0, '不自动释放就会留下死锁')
})

await test('写文件自动登记占用（不需要模型主动 claim）', () => {
  const { ctx, state } = setup()
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  emit(ctx, 'agent/created', { agent: a })
  emit(ctx, 'tools/pre-execute', { name: 'write', arguments: { file_path: 'x.js' }, agent: a }, () => {})
  assert.deepEqual(state.claimedBy('a'), ['x.js'])
})

await test('★ 撞车时 warn 策略不拦工具，但把警告记给那个会话', () => {
  const { ctx, state } = setup()
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  const b = makeAgent({ id: 'b', cwd: 'D:\\p', title: '乙' })
  emit(ctx, 'agent/created', { agent: a })
  emit(ctx, 'agent/created', { agent: b })
  emit(ctx, 'tools/pre-execute', { name: 'edit', arguments: { file_path: 'x.js' }, agent: a }, () => {})

  let nextCalled = false
  emit(ctx, 'tools/pre-execute', { name: 'edit', arguments: { file_path: 'x.js' }, agent: b }, () => { nextCalled = true })
  assert.equal(nextCalled, true, 'warn 策略下必须放行（next 被调用）')
  assert.ok(state.snapshotNotes('b').length >= 1, '必须把冲突提醒记给乙')
  assert.equal(state.conflict('x.js', 'c').length, 2, '两个会话的占用都要留证据')
})

await test('★ 撞车时 block 策略直接抛错拦住工具', () => {
  const { ctx } = setup({ extra: { collabClaimGuard: 'block' } })
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  const b = makeAgent({ id: 'b', cwd: 'D:\\p', title: '乙' })
  emit(ctx, 'agent/created', { agent: a })
  emit(ctx, 'agent/created', { agent: b })
  emit(ctx, 'tools/pre-execute', { name: 'edit', arguments: { file_path: 'x.js' }, agent: a }, () => {})
  assert.throws(
    () => emit(ctx, 'tools/pre-execute', { name: 'edit', arguments: { file_path: 'x.js' }, agent: b }, () => {}),
    /协作模式/,
  )
})

await test('collabClaimGuard=off 时完全不介入', () => {
  const { ctx, state } = setup({ extra: { collabClaimGuard: 'off' } })
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  emit(ctx, 'agent/created', { agent: a })
  emit(ctx, 'tools/pre-execute', { name: 'edit', arguments: { file_path: 'x.js' }, agent: a }, () => {})
  assert.equal(state.claimedBy('a').length, 0)
})

await test('collabEnabled=false 时事件全部不处理', () => {
  const { ctx, state } = setup({ extra: { collabEnabled: false } })
  emit(ctx, 'agent/created', { agent: makeAgent({ id: 'a', cwd: 'D:\\p' }) })
  assert.equal(state.get('a'), null)
  assert.equal(state.claimedBy('a').length, 0)
})

await test('collab_post 工具：留言写进状态，别人读得到', async () => {
  const { ctx, state } = setup()
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  const b = makeAgent({ id: 'b', cwd: 'D:\\p', title: '乙' })
  emit(ctx, 'agent/created', { agent: a })
  emit(ctx, 'agent/created', { agent: b })
  const out = await callTool(ctx, 'collab_post', { text: '这个文件我在改' }, a)
  assert.match(out, /已留言/)
  assert.equal(state.unread('b').length, 1)
  assert.equal(state.unread('b')[0].title, '甲', '留言要带上是谁说的')
})

await test('collab_claim / collab_release 工具能读能写', async () => {
  const { ctx, state } = setup()
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  emit(ctx, 'agent/created', { agent: a })
  const claimOut = await callTool(ctx, 'collab_claim', { paths: 'a.js, b.js' }, a)
  assert.match(claimOut, /2 个文件/)
  assert.equal(state.claimedBy('a').length, 2)
  const releaseOut = await callTool(ctx, 'collab_release', { paths: 'a.js' }, a)
  assert.match(releaseOut, /1 \/ 1/)
  assert.deepEqual(state.claimedBy('a'), ['b.js'])
  const allOut = await callTool(ctx, 'collab_release', {}, a)
  assert.match(allOut, /全部 1 个/)
  assert.equal(state.claimedBy('a').length, 0)
})

await test('collab_status 工具列出同工作区会话与留言', async () => {
  const { ctx } = setup()
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  const b = makeAgent({ id: 'b', cwd: 'D:\\p', title: '乙' })
  emit(ctx, 'agent/created', { agent: a })
  emit(ctx, 'agent/created', { agent: b })
  await callTool(ctx, 'collab_post', { text: '你先做 A' }, b)
  const out = await callTool(ctx, 'collab_status', {}, a)
  assert.match(out, /乙/)
  assert.match(out, /你先做 A/)
  assert.match(out, /（你）/, '要标出哪一行是自己')
})

await test('★ 落盘：面板里自动区块正确，且人工写的内容一字不丢', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-test-'))
  try {
    const human = '# 协作板（人工写的）\n\n铁律：写前登记。\n'
    await writeFile(join(dir, M.DEFAULT_PANEL_FILE), human, 'utf8')
    const { ctx, state } = setup({ dir })
    const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
    emit(ctx, 'agent/created', { agent: a })
    emit(ctx, 'tools/pre-execute', { name: 'edit', arguments: { file_path: 'D:\\p\\a.js' }, agent: a }, () => {})
    await state.flushNow()

    const text = await readFile(join(dir, M.DEFAULT_PANEL_FILE), 'utf8')
    assert.ok(text.includes('铁律：写前登记。'), '人工内容必须还在')
    assert.ok(text.includes(M.AUTO_BEGIN) && text.includes(M.AUTO_END), '自动区块必须在')
    assert.ok(text.includes('甲'), '会话应出现在自动区块里')
    assert.ok(text.includes('a.js'), '占用应出现在自动区块里')

    // 第二次落盘：人工内容仍不丢，且自动区块被替换而不是追加。
    await state.flushNow()
    const again = await readFile(join(dir, M.DEFAULT_PANEL_FILE), 'utf8')
    assert.ok(again.includes('铁律：写前登记。'))
    assert.equal(again.split(M.AUTO_BEGIN).length - 1, 1, '自动区块不能被追加成两份')

    // 状态文件里应保留留言（跨重启）。
    await callTool(ctx, 'collab_post', { text: '留一句给重启后' }, a)
    await state.flushNow()
    const saved = JSON.parse(await readFile(join(dir, M.DEFAULT_STATE_FILE), 'utf8'))
    assert.equal(saved.messages.at(-1).text, '留一句给重启后')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('agentmdDir 未配置时只做内存协作，不抛错', async () => {
  const { ctx, state } = setup({ dir: '' })
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  emit(ctx, 'agent/created', { agent: a })
  emit(ctx, 'tools/pre-execute', { name: 'edit', arguments: { file_path: 'a.js' }, agent: a }, () => {})
  await state.flushNow()
  assert.equal(state.claimedBy('a').length, 1, '不落盘也要照样登记占用')
})

console.log('\n[9] 协作开关（输入框下方那个开关）的护栏')

await test('★ 关掉协作后 4 个工具都不再协作，而是回一句「已关闭」', async () => {
  const { ctx, state, config } = setup()
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  emit(ctx, 'agent/created', { agent: a })
  config.collabEnabled = false
  for (const name of ['collab_status', 'collab_post', 'collab_claim', 'collab_release']) {
    const out = await callTool(ctx, name, { text: '一句话', paths: 'x.js' }, a)
    assert.match(out, /已关闭/, `${name} 在协作关掉之后仍然照常干活`)
  }
  assert.equal(state.unread('a').length, 0, '关掉后不许再写留言')
  assert.equal(state.claimedBy('a').length, 0, '关掉后不许再登记占用')
})

await test('★ 开关立刻生效：关掉再打开，工具马上恢复', async () => {
  const { ctx, state, config } = setup()
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  emit(ctx, 'agent/created', { agent: a })
  config.collabEnabled = false
  assert.match(await callTool(ctx, 'collab_claim', { paths: 'x.js' }, a), /已关闭/)
  config.collabEnabled = true
  assert.match(await callTool(ctx, 'collab_claim', { paths: 'x.js' }, a), /已登记占用/)
  assert.deepEqual(state.claimedBy('a'), ['x.js'], '重新打开后必须恢复登记能力（不需要重启）')
})

await test('关掉后，已注入的会话上下文也变成空（不再提示协作现状）', () => {
  const { ctx, config } = setup()
  const a = makeAgent({ id: 'a', cwd: 'D:\\p', title: '甲' })
  emit(ctx, 'agent/created', { agent: a })
  assert.equal(ctx.contexts.length, 1)
  assert.equal(typeof ctx.contexts[0].text, 'function')
  config.collabEnabled = false
  assert.equal(ctx.contexts[0].text(), '', '关掉协作后，注入的上下文必须是空串')
})

console.log(`\n通过 ${passed} / 失败 ${failed}`)
if (failed > 0) process.exitCode = 1
