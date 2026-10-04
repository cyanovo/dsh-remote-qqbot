/**
 * 插件集成自测：用 mock ctx 驱动真实的 lib/index.js。
 *
 * 覆盖：
 *   1. 插件能从 lib/ 正常加载并 apply 到 mock ctx，注册 4 个工具
 *   2. agent/created + agentmdInject=true → 真的往 systemPrompt 上注册了上下文，
 *      且 provider 返回的内容里带着 main.md 全文
 *   3. agent/status running→idle → 真的往主文档追加了一行，摘要来自会话事件
 *   4. agentmdDir 为空 / 文件缺表头 → 只记日志不抛错、不改文件
 *
 * 运行：node tests/plugin.test.mjs
 */

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

/**
 * 造一个**一次性、绝对路径**的临时目录，进程退出时自动删除。
 *
 * ⚠️ 这些用例原先用相对路径 `'X'`。插件（协作模式的自动落盘）会真在仓库里建出
 * `dsh-remote-qqbot\X\{plugin-collab.md,.collab-state.json}`：既污染仓库，又让测试
 * 不再封闭（下一轮会读到上一轮残留的状态文件，单会话断言可能因此变红）。
 * 审查会话实测抓到了这个（`X\` 目录确实躺在仓库里），改绝对路径 + 退出清理防复发。
 */
const tmpDirs = []
function freshDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `remote-qqbot-${tag}-`))
  tmpDirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响测试结论 */ }
  }
})

const MOD = await import('../lib/index.js')

/**
 * 🔴 整组测试必须跑在一个**空的 DSH_HOME** 上（2026-10-03 实测踩到）。
 *
 * 原因：`liveConfig()` 的**最高优先级**是 `~/.dsh/remote-qqbot-overrides.json`
 * —— 也就是你在 DSH 界面上点开关时写的那份覆盖文件。
 * 于是只要**这台机器真点过**那个开关，文件就存在，它会压过测试里 mock 的 settings：
 * 实测 `collabEnabled=false 时不注册协作上下文` 会因为这个文件而变红
 * （文件里恰好是 `collabEnabled: true`），而代码本身完全正确。
 *
 * **不能把测试结论建立在"主人这台机器恰好没点过开关"之上。** 所以这里指向一个
 * 一次性空目录：覆盖层永远为空，断言只反映被测逻辑。
 */
process.env.DSH_HOME = freshDir('dsh-home')

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

/**
 * 构造一个最小可用的 mock Context。
 * @param {object} [options] - 可选项。
 * @param {object} [options.settings] - settings 服务返回的命名空间配置。
 * @param {boolean} [options.withSystemPrompt] - 是否挂载 systemPrompt 服务。
 * @returns {object} mock ctx 与观测点。
 */
function makeCtx({
  settings = {}, withSystemPrompt = true,
  userQuestions = null, deferUserQuestions = false,
} = {}) {
  /** 事件名 → 监听器数组。 */
  const listeners = new Map()
  /** 注册的工具。 */
  const tools = new Map()
  /** 注入到 systemPrompt 的上下文条目。 */
  const contexts = []
  /** effect 清理函数。 */
  const disposers = []
  const logs = []
  /** userQuestions 服务的当前实现（默认不存在，复刻"服务未就绪"）。 */
  let uqService = userQuestions
  /** deferUserQuestions=true 时暂存 ctx.inject 的回调，等 provideUserQuestions() 再触发。 */
  const uqInjectCbs = []

  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    get(service) {
      if (service === 'settings') {
        // 复刻真实 settings 服务语义：**必须 register 才有 scope**，
        // 直接 get(ns) 在未注册时返回 undefined（这正是第三个致命 bug 的根源）。
        const registrations = new Map()
        return {
          register(ns, schema, options) {
            if (registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
            const resolved = Object.freeze(schema({ ...(options?.base ?? {}), ...settings }))
            registrations.set(ns, { resolved, watchers: new Set() })
            return {
              get: () => resolved,
              watch: (cb) => { registrations.get(ns).watchers.add(cb); return () => registrations.get(ns).watchers.delete(cb) },
              update: async () => {},
              replace: async () => {},
            }
          },
          get: (ns) => registrations.get(ns)?.resolved,
          describe: () => [],
        }
      }
      if (service === 'systemPrompt' && withSystemPrompt) {
        return {
          context(entry) {
            contexts.push(entry)
            return () => {}
          },
          section() {
            return () => {}
          },
        }
      }
      // userQuestions 默认不存在 —— 复刻真实 cordis 的失败模式：
      // 服务提供者 fiber 尚未 active 时，ctx.get 返回 undefined（不是抛错）。
      if (service === 'userQuestions') return uqService ?? undefined
      return undefined
    },
    inject(names, cb) {
      if (names.includes('settings')) cb(ctx)
      if (names.includes('userQuestions')) {
        // deferUserQuestions=true 用来演"服务比插件晚加载"这个真实存在的顺序。
        if (deferUserQuestions) uqInjectCbs.push(cb)
        else if (uqService) cb(ctx)
      }
      return () => {}
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => {}
      },
    },
  }

  return {
    ctx,
    tools,
    contexts,
    logs,
    /**
     * 模拟 userQuestions 服务稍后就绪：装好服务并触发 ctx.inject 的回调。
     * @param {object} svc - 假的 userQuestions 服务（需有 ask 方法）。
     */
    provideUserQuestions(svc) {
      uqService = svc
      for (const cb of uqInjectCbs.splice(0)) cb(ctx)
    },
    /** 触发一个事件（同步派发；多余参数按顺序透传给 handler，如 pre-execute 的 next）。 */
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    /** 在 agent.ctx 上带 effect 支持地构造一个 agent。 */
    makeAgent(id, session) {
      const agentCtx = {
        effect(fn) {
          const d = fn()
          if (typeof d === 'function') disposers.push(d)
          return () => {}
        },
      }
      return { id, ctx: agentCtx, session, status: 'idle' }
    },
  }
}

/** 与真实 main.md 结构一致的样本。 */
const SAMPLE = `# Agent 操作记录（main）

> 创建时间：2026-09-30 ｜ 最后更新：2026-09-30

---

## 四、操作日志

| 时间 | 操作 | 结果 |
|---|---|---|
| 2026-09-30 | 旧记录 | 完成 |

---

## 五、给下一个对话的提示

1. 先读本文档。
`

/** 构造一个带真实事件形状的 session。 */
function makeSession({ user = '', assistant = '' } = {}) {
  const events = []
  if (user) {
    events.push({
      type: 'user/message',
      seq: 1,
      data: {
        id: 'm1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: user }],
      },
    })
  }
  if (assistant) {
    events.push({
      type: 'assistant/message',
      seq: 2,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'm2',
          role: 'assistant',
          source: { kind: 'model', provider: 'bq', model: 'deepseek-v4.1-flash' },
          content: [{ type: 'text', text: assistant }],
        },
      },
    })
  }
  return { header: { id: 'sess-1', cwd: 'D:\\cyanproject\\agenttool' }, events }
}

console.log('插件集成自测（mock ctx 驱动 lib/index.js）\n')

console.log('模块与配置:')

await test('Config 是 schemastery 形态且能被 Cordis 校验（回归：普通 JSON Schema 会导致整树加载失败）', () => {
  assert.equal(typeof MOD.apply, 'function')
  // 关键回归点：Cordis 的 resolveConfig 调用 Config['~standard'].validate()。
  // 若导出普通 JSON Schema 对象，这里会是 undefined → 插件树加载失败。
  assert.equal(typeof MOD.Config, 'function', 'Config 必须是 schemastery schema（callable），不是普通对象')
  assert.ok(MOD.Config['~standard'], 'Config 必须带 ~standard（schemastery 标准校验接口）')
  assert.equal(typeof MOD.Config['~standard'].validate, 'function')
  const result = MOD.Config['~standard'].validate({})
  assert.equal(result.issues, undefined, '空配置必须校验通过')
  const v = result.value

  // 校验后的默认值
  assert.equal(v.agentmdDir, '')
  assert.equal(v.agentmdMainFile, 'main.md')
  assert.equal(v.agentmdInject, false)
  assert.equal(v.agentmdSummaryChars, 200)
  assert.equal(v.agentmdAppendLog, true)
  // 防爆上下文的三条预算必须有出厂默认值（0/负数不许被解释成"不限"）。
  assert.equal(v.agentmdInjectMaxChars, 8000)
  assert.equal(v.agentmdInjectTailRows, 20)
  assert.equal(v.agentmdRowMaxChars, 600)
  assert.equal(v.onTurnComplete, true)
  assert.equal(v.timeoutMs, 10000)

  // 所有配置项的 description 必须是中文（schemastery 的 object schema 用 .dict 暴露字段）。
  const dict = MOD.Config.dict
  assert.ok(dict, 'Config.dict 应存在（schemastery object schema 字段表）')
  for (const key of [
    'agentmdDir', 'agentmdMainFile', 'agentmdInject', 'agentmdSummaryChars', 'agentmdAppendLog',
    'agentmdInjectMaxChars', 'agentmdInjectTailRows', 'agentmdRowMaxChars',
    'hubUrl', 'token', 'timeoutMs', 'onTurnComplete', 'onQuestion', 'onError', 'dedupeMs', 'errorSummaryChars',
  ]) {
    assert.ok(dict[key], `Config 缺少字段 ${key}`)
    const desc = dict[key].meta?.description
    assert.ok(typeof desc === 'string' && /[\u4e00-\u9fa5]/.test(desc),
      `${key} 的 description 应为中文，实际: ${desc}`)
  }
  assert.equal(dict.agentmdDir.meta.default, '')
  assert.equal(dict.agentmdMainFile.meta.default, 'main.md')
  assert.equal(dict.agentmdInject.meta.default, false)
  assert.equal(dict.agentmdSummaryChars.meta.default, 200)
  assert.equal(dict.agentmdAppendLog.meta.default, true)
  assert.equal(dict.agentmdInjectMaxChars.meta.default, 8000)
  assert.equal(dict.agentmdInjectTailRows.meta.default, 20)
  assert.equal(dict.agentmdRowMaxChars.meta.default, 600)
})

await test('Config 能校验用户传入值（类型转换与非法值拒绝）', () => {
  const ok = MOD.Config['~standard'].validate({ agentmdInject: true, agentmdSummaryChars: 50, hubUrl: 'https://x' })
  assert.equal(ok.issues, undefined)
  assert.equal(ok.value.agentmdInject, true)
  assert.equal(ok.value.agentmdSummaryChars, 50)
  const bad = MOD.Config['~standard'].validate({ agentmdSummaryChars: 'not-a-number' })
  assert.ok(bad.issues, '非法类型应被拒绝')
})

await test('apply 注册 11 个工具（3 个记忆 + agentmd_read + 4 个协作 + 3 个云端账号）', () => {
  const h = makeCtx()
  MOD.apply(h.ctx, {})
  // 逐个点名而不是只数个数：多一个少一个都要在这里显式改一次，
  // 免得"工具悄悄消失"这种事故被一个数字掩盖过去。
  assert.deepEqual([...h.tools.keys()].sort(),
    ['agentmd_read', 'cloud_bind', 'cloud_status', 'cloud_unbind', 'collab_claim', 'collab_post',
      'collab_release', 'collab_status', 'memory_forget', 'memory_read', 'memory_write'])
})

console.log('\n上下文注入:')

await test('agentmdInject=false 时不注册 agentmd 上下文（协作模式不受它影响）', () => {
  const h = makeCtx({ settings: { agentmdDir: freshDir('inject-off'), agentmdInject: false } })
  MOD.apply(h.ctx, {})
  h.emit('agent/created', { agent: h.makeAgent('a1', makeSession()) })
  assert.equal(h.contexts.filter((c) => c.name === 'remote-qqbot:agentmd').length, 0)
})

await test('agentmdInject=true 时注册上下文，provider 返回 main.md 全文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-inject-'))
  await writeFile(join(root, 'main.md'), SAMPLE, 'utf8')
  const h = makeCtx({ settings: { agentmdDir: root, agentmdInject: true } })
  MOD.apply(h.ctx, {})
  h.emit('agent/created', { agent: h.makeAgent('a1', makeSession()) })
  // ⚠️ 现在可能有多条上下文（agentmd + 协作模式），按名字取，不要按下标。
  const agentmd = h.contexts.filter((c) => c.name === 'remote-qqbot:agentmd')
  assert.equal(agentmd.length, 1, '应注册 1 条 agentmd 上下文')
  const entry = agentmd[0]
  assert.equal(entry.name, 'remote-qqbot:agentmd')
  assert.ok(Number.isFinite(entry.order))
  const text = entry.text({})
  assert.match(text, /Agent 操作记录（main）/, '应含文档标题')
  assert.match(text, /旧记录/, '应含表格内容')
  assert.match(text, /<agentmd file="/, '应带来源标注')
  await rm(root, { recursive: true, force: true })
})

await test('🔴 文档被写成超大文件时，注入上下文仍不超过上限（端到端防线）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-inject-huge-'))
  // 模拟“有人往 main.md 里贴了一大段”的最坏情况：200KB 级文档 + 60 条日志。
  const head = Array.from({ length: 200 }, (_, i) => `### 小节 ${i}\n\n${'很长的正文。'.repeat(200)}`).join('\n\n')
  const rows = Array.from({ length: 60 }, (_, i) => `| 2026-09-0${(i % 9) + 1} | 第 ${i} 条日志 | 完成 |`)
  const huge = `${head}\n\n## 四、操作日志\n\n| 时间 | 操作 | 结果 |\n|---|---|---|\n${rows.join('\n')}\n`
  await writeFile(join(root, 'main.md'), huge, 'utf8')
  assert.ok(huge.length > 150000, `样本要够大，实际 ${huge.length}`)

  /** 取 <agentmd> 标签之间真正被注入的正文。 */
  const inner = (text) => {
    const open = text.indexOf('<agentmd file="')
    const start = text.indexOf('>', open) + 1
    const end = text.lastIndexOf('</agentmd>')
    return text.slice(start, end).trim()
  }

  // 默认上限 8000
  const h = makeCtx({ settings: { agentmdDir: root, agentmdInject: true } })
  MOD.apply(h.ctx, {})
  h.emit('agent/created', { agent: h.makeAgent('a1', makeSession()) })
  const entry = h.contexts.find((c) => c.name === 'remote-qqbot:agentmd')
  assert.ok(entry, '应注册 agentmd 上下文')
  const text = entry.text({})
  const injected = inner(text)
  assert.ok(injected.length <= 8000, `注入正文必须 ≤ 8000，实际 ${injected.length}（原文 ${huge.length}）`)
  assert.match(text, /省略约 \d+ 个字符/, '压缩必须在正文里明说省略了多少')
  assert.match(injected, /## 四、操作日志/, '压缩后仍要保留 §四 小节')
  assert.match(injected, /第 59 条日志/, '压缩后仍要保留最新日志')

  // 反向校验：把上限改小，注入必须跟着变短（证明护栏真的读配置，而不是恒等于某个常数）
  const h2 = makeCtx({ settings: { agentmdDir: root, agentmdInject: true, agentmdInjectMaxChars: 1500 } })
  MOD.apply(h2.ctx, {})
  h2.emit('agent/created', { agent: h2.makeAgent('a2', makeSession()) })
  const injected2 = inner(h2.contexts.find((c) => c.name === 'remote-qqbot:agentmd').text({}))
  assert.ok(injected2.length <= 1500, `上限 1500 时必须 ≤ 1500，实际 ${injected2.length}`)
  assert.ok(injected2.length < injected.length, `上限调小必须变短：${injected2.length} vs ${injected.length}`)
  await rm(root, { recursive: true, force: true })
})

await test('注入的文件被删掉后，provider 返回空串而不是抛错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-inject-gone-'))
  const h = makeCtx({ settings: { agentmdDir: root, agentmdInject: true } })
  MOD.apply(h.ctx, {})
  h.emit('agent/created', { agent: h.makeAgent('a1', makeSession()) })
  const entry = h.contexts.find((c) => c.name === 'remote-qqbot:agentmd')
  assert.ok(entry, '应注册 agentmd 上下文')
  const text = entry.text({})
  assert.equal(text, '', '文件不在时应返回空串（该条上下文自动消失）')
  await rm(root, { recursive: true, force: true })
})

await test('没有 systemPrompt 服务时只记日志、不抛错', () => {
  const h = makeCtx({ settings: { agentmdDir: freshDir('no-sp'), agentmdInject: true }, withSystemPrompt: false })
  MOD.apply(h.ctx, {})
  h.emit('agent/created', { agent: h.makeAgent('a1', makeSession()) })
  assert.equal(h.contexts.length, 0, '一条都不该注册（agentmd 与协作都跳过）')
})

await test('协作模式接线：注册 remote-qqbot:collab 上下文，单人环境返回空串', () => {
  const h = makeCtx({ settings: { agentmdDir: freshDir('collab-on'), collabEnabled: true } })
  MOD.apply(h.ctx, {})
  h.emit('agent/created', { agent: h.makeAgent('a1', makeSession()) })
  const collab = h.contexts.filter((c) => c.name === 'remote-qqbot:collab')
  assert.equal(collab.length, 1, '应注册协作上下文')
  assert.equal(collab[0].order, 160, '排在 agentmd(150) 之后')
  assert.equal(collab[0].text({}), '', '同一工作区只有它自己时，不能往上下文里塞任何字')
})

await test('collabEnabled=false 时不注册协作上下文', () => {
  const h = makeCtx({ settings: { agentmdDir: freshDir('collab-off'), collabEnabled: false } })
  MOD.apply(h.ctx, {})
  h.emit('agent/created', { agent: h.makeAgent('a1', makeSession()) })
  assert.equal(h.contexts.filter((c) => c.name === 'remote-qqbot:collab').length, 0)
})

console.log('\n操作日志自动追加:')

await test('running→idle 时追加一行，摘要来自本轮用户消息与最终回复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-log-'))
  await writeFile(join(root, 'main.md'), SAMPLE, 'utf8')
  const h = makeCtx({ settings: { agentmdDir: root, agentmdAppendLog: true } })
  MOD.apply(h.ctx, {})
  const agent = h.makeAgent('a1', makeSession({
    user: '帮我把插件重构成多文件结构',
    assistant: '已完成拆分：src/index.js、src/agentmd.js、src/summary.js',
  }))
  h.emit('agent/status', { agent, status: 'running' })
  h.emit('agent/status', { agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 300))

  const text = await readFile(join(root, 'main.md'), 'utf8')
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => l.includes('帮我把插件重构成多文件结构'))
  assert.ok(idx > 0, `应追加成功，实际内容:\n${text}`)
  assert.match(lines[idx], /^\| \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| 帮我把插件重构成多文件结构 → 已完成拆分.* \| 完成 \|$/)
  assert.equal(lines[idx].split('|').length - 2, 3, '必须是 3 列')
  assert.ok(lines[idx - 1].includes('| 2026-09-30 | 旧记录 | 完成 |'), '必须紧跟最后一条数据行')
  assert.ok(lines.some((l) => l.includes('## 五、')), '后续小节必须保留')
  assert.ok(text.includes('最后更新：'), '头部最后更新行必须保留')
  await rm(root, { recursive: true, force: true })
})

await test('摘要超出 agentmdSummaryChars 时被截断并加省略号', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-trunc-'))
  await writeFile(join(root, 'main.md'), SAMPLE, 'utf8')
  const h = makeCtx({ settings: { agentmdDir: root, agentmdSummaryChars: 20, agentmdAppendLog: true } })
  MOD.apply(h.ctx, {})
  const agent = h.makeAgent('a1', makeSession({ user: '一'.repeat(100) }))
  h.emit('agent/status', { agent, status: 'running' })
  h.emit('agent/status', { agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 300))
  const text = await readFile(join(root, 'main.md'), 'utf8')
  const row = text.split('\n').find((l) => l.includes('一'))
  const cell = row.split('|')[2].trim()
  assert.equal([...cell].length, 20, `摘要单元格应为 20 个码点，实际 ${[...cell].length}`)
  assert.ok(cell.endsWith('…'))
  await rm(root, { recursive: true, force: true })
})

await test('agentmdDir 为空 → 不改任何文件、不抛错', async () => {
  const h = makeCtx({ settings: { agentmdDir: '' } })
  MOD.apply(h.ctx, {})
  const agent = h.makeAgent('a1', makeSession({ user: 'x', assistant: 'y' }))
  h.emit('agent/status', { agent, status: 'running' })
  h.emit('agent/status', { agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 100))
})

await test('agentmdAppendLog=false 时不追加', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-off-'))
  await writeFile(join(root, 'main.md'), SAMPLE, 'utf8')
  const h = makeCtx({ settings: { agentmdDir: root, agentmdAppendLog: false } })
  MOD.apply(h.ctx, {})
  const agent = h.makeAgent('a1', makeSession({ user: '不应出现', assistant: 'z' }))
  h.emit('agent/status', { agent, status: 'running' })
  h.emit('agent/status', { agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(await readFile(join(root, 'main.md'), 'utf8'), SAMPLE, '文件必须一字未改')
  await rm(root, { recursive: true, force: true })
})

await test('文件表头缺失 → 文件保持原样', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-nohead-'))
  const broken = '# 标题\n\n## 四、操作日志\n\n没有表格\n'
  await writeFile(join(root, 'main.md'), broken, 'utf8')
  const h = makeCtx({ settings: { agentmdDir: root, agentmdAppendLog: true } })
  MOD.apply(h.ctx, {})
  const agent = h.makeAgent('a1', makeSession({ user: 'x', assistant: 'y' }))
  h.emit('agent/status', { agent, status: 'running' })
  h.emit('agent/status', { agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(await readFile(join(root, 'main.md'), 'utf8'), broken)
  await rm(root, { recursive: true, force: true })
})

await test('session 结构完全陌生（无 events）时也不抛错，摘要降级为占位文本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-weird-'))
  await writeFile(join(root, 'main.md'), SAMPLE, 'utf8')
  const h = makeCtx({ settings: { agentmdDir: root, agentmdAppendLog: true } })
  MOD.apply(h.ctx, {})
  const agent = h.makeAgent('a1', { header: { cwd: freshDir('log-cwd') } })
  h.emit('agent/status', { agent, status: 'running' })
  h.emit('agent/status', { agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 200))
  const text = await readFile(join(root, 'main.md'), 'utf8')
  assert.ok(text.includes('（本轮无可用摘要）'), '应写入占位文本')
  await rm(root, { recursive: true, force: true })
})

await test('agent/error 之后本轮结果列标记为出错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-err-'))
  await writeFile(join(root, 'main.md'), SAMPLE, 'utf8')
  const h = makeCtx({ settings: { agentmdDir: root, agentmdAppendLog: true } })
  MOD.apply(h.ctx, {})
  const agent = h.makeAgent('a1', makeSession({ user: '跑个任务' }))
  h.emit('agent/status', { agent, status: 'running' })
  h.emit('agent/error', { agent, error: new Error('boom') })
  h.emit('agent/status', { agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 300))
  const text = await readFile(join(root, 'main.md'), 'utf8')
  assert.ok(text.includes('| 出错（详见日志） |'), `结果列应标记出错，实际:\n${text}`)
  await rm(root, { recursive: true, force: true })
})

console.log('\nagentmd_read 工具:')

await test('agentmd_read 读回主文档全文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-read-'))
  await writeFile(join(root, 'main.md'), SAMPLE, 'utf8')
  const h = makeCtx({ settings: { agentmdDir: root } })
  MOD.apply(h.ctx, {})
  const tool = h.tools.get('agentmd_read')
  const out = await tool.execute({}, {})
  assert.match(out, /Agent 操作记录（main）/)
  assert.match(out, /旧记录/)
  await rm(root, { recursive: true, force: true })
})

await test('agentmd_read 在未配置时给出可操作提示', async () => {
  const h = makeCtx({ settings: {} })
  MOD.apply(h.ctx, {})
  const out = await h.tools.get('agentmd_read').execute({}, {})
  assert.match(out, /未配置 agentmdDir/)
})

console.log('\n事件推送（回归）:')

await test('running→idle 仍然推送 turn-complete 到中枢', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{}' }
  }
  try {
    const h = makeCtx({ settings: { hubUrl: 'https://example.com/dsh', token: 't' } })
    MOD.apply(h.ctx, {})
    const agent = h.makeAgent('a1', makeSession())
    h.emit('agent/status', { agent, status: 'running' })
    h.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.kind, 'turn-complete')
    assert.equal(calls[0].body.project, 'agenttool')
  } finally {
    globalThis.fetch = original
  }
})

await test('回归：两个会话在去重窗口内先后完成，两条都要推送（不能互相顶掉）', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{}' }
  }
  try {
    // 两次完成之间不等待，必然落在同一个 dedupeMs 窗口内。
    // 曾经的 bug：去重键是 `${kind}|${summary}`，而所有 turn-complete 的 summary
    // 都是「本轮已结束，可以查看了」—— 于是后完成的那个会话被当成重复**静默丢掉**。
    // 多会话并发正是本插件的核心场景，所以这条必须锁死。
    const h = makeCtx({ settings: { hubUrl: 'https://example.com/dsh', token: 't' } })
    MOD.apply(h.ctx, {})
    const a1 = h.makeAgent('a1', makeSession())
    const a2 = h.makeAgent('a2', makeSession())
    h.emit('agent/status', { agent: a1, status: 'running' })
    h.emit('agent/status', { agent: a1, status: 'idle' })
    h.emit('agent/status', { agent: a2, status: 'running' })
    h.emit('agent/status', { agent: a2, status: 'idle' })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(calls.length, 2, `两个会话应各推一条，实际 ${calls.length} 条`)
    assert.notEqual(calls[0].body.sessionId, calls[1].body.sessionId)
  } finally {
    globalThis.fetch = original
  }
})

console.log('\n子智能体不打扰（回归）:')

await test('子智能体（origin=subagent）跑完时不推中枢', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{}' }
  }
  try {
    const h = makeCtx({ settings: { hubUrl: 'https://example.com/dsh', token: 't' } })
    MOD.apply(h.ctx, {})
    const session = makeSession()
    session.header.origin = 'subagent'
    const agent = h.makeAgent('sub-1', session)
    h.emit('agent/status', { agent, status: 'running' })
    h.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(calls.length, 0, `子智能体不该推送，实际推了 ${calls.length} 条`)
  } finally {
    globalThis.fetch = original
  }
})

await test('子智能体（delegationDepth>=1）跑完时也不推', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{}' }
  }
  try {
    const h = makeCtx({ settings: { hubUrl: 'https://example.com/dsh', token: 't' } })
    MOD.apply(h.ctx, {})
    const session = makeSession()
    session.header.delegationDepth = 2
    const agent = h.makeAgent('sub-2', session)
    h.emit('agent/status', { agent, status: 'running' })
    h.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = original
  }
})

await test('用户自己 fork 出来的会话（只有 parentSession）照常推送 —— 别把 fork 当子智能体', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{}' }
  }
  try {
    const h = makeCtx({ settings: { hubUrl: 'https://example.com/dsh', token: 't' } })
    MOD.apply(h.ctx, {})
    const session = makeSession()
    session.header.parentSession = 'session-parent'
    const agent = h.makeAgent('fork-1', session)
    h.emit('agent/status', { agent, status: 'running' })
    h.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(calls.length, 1, 'fork 是用户自己的会话，必须照常通知')
  } finally {
    globalThis.fetch = original
  }
})

await test('notifySubagents=true 时子智能体也推送（开关真的有效，不是摆设）', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{}' }
  }
  try {
    const h = makeCtx({ settings: { hubUrl: 'https://example.com/dsh', token: 't', notifySubagents: true } })
    MOD.apply(h.ctx, {})
    const session = makeSession()
    session.header.origin = 'subagent'
    const agent = h.makeAgent('sub-3', session)
    h.emit('agent/status', { agent, status: 'running' })
    h.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(calls.length, 1)
  } finally {
    globalThis.fetch = original
  }
})

await test('QQ 推送必须带上 sessionId（引用回复靠它反查会话；这里曾真的漏过）', async () => {
  // 回归点：index.js 的 `void qq.notify({...})` 曾经只传 kind/summary/project/session，
  // **漏了 sessionId** —— 于是 qqruntime 登记下来的 sessionId 是 undefined，
  // 你在 QQ 里引用通知回复时永远匹配不到会话，整条引用链路静默失效（不报错、也不崩）。
  // QQ 通道的真实验证需要联网，所以这里做源码级护栏：只要有人再把它删掉，这条就红。
  const src = await readFile(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
  const idx = src.indexOf('void qq.notify(')
  assert.ok(idx > 0, 'lib/index.js 里应当有 qq.notify 调用')
  assert.match(src.slice(idx, idx + 400), /sessionId:/, 'qq.notify 必须把 sessionId 传下去')
})

await test('闲聊会话不推完成通知（不引用消息直接聊时，你人就在 QQ 里等着）', async () => {
  // 行为级验证需要真实的 QQ 状态文件，这里做源码级护栏：
  // push() 必须真的去问 qqruntime「这个会话是不是闲聊会话」，并支持 notifyChatSession 开关。
  const src = await readFile(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
  assert.match(src, /qq\.isChatSession\(/, 'push() 应当调用 qq.isChatSession() 过滤闲聊会话')
  assert.match(src, /notifyChatSession/, '应当有 notifyChatSession 配置项')
})

await test('回归：同一个会话重复的相同事件仍会被去重（不能因为改了键就失效）', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => '{}' }
  }
  try {
    const h = makeCtx({ settings: { hubUrl: 'https://example.com/dsh', token: 't' } })
    MOD.apply(h.ctx, {})
    const agent = h.makeAgent('a1', makeSession())
    // 同一个 agent 连续两次 running→idle（模拟重复事件）
    for (let i = 0; i < 2; i += 1) {
      h.emit('agent/status', { agent, status: 'running' })
      h.emit('agent/status', { agent, status: 'idle' })
    }
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(calls.length, 1, `同一会话的重复事件应被去重，实际 ${calls.length} 条`)
  } finally {
    globalThis.fetch = original
  }
})

// ── 提问中继的接上时机（「提问还是不行」的回归护栏）────────────────────────
// 背景：主人实测收到的提问消息**只有问题、没有选项**，在 QQ 里根本没法回答。
// 根因：cordis 的 ctx.get 对「提供者 fiber 未 active」的服务返回 undefined，
//      而旧代码只试一次就永久放弃 —— 中继没接上，push('question') 退化成一行纯文本。
// 下面三条锁死「服务早到 / 晚到 / 重复就绪」三种情况都必须接上，且只接一次。

await test('★ 回归：userQuestions 服务比插件晚就绪时，也必须补接上', () => {
  const h = makeCtx({ userQuestions: null, deferUserQuestions: true })
  const svc = { ask: async () => ({ answers: [] }) }

  MOD.apply(h.ctx, {})
  assert.notEqual(svc.__dshQqWrapped, true, '服务还没就绪，此时不该有包装')

  h.provideUserQuestions(svc)
  assert.equal(svc.__dshQqWrapped, true,
    '服务就绪后必须补接；否则提问只会推一条没有选项的纯文本，在 QQ 里无法作答')
})

await test('userQuestions 一开始就就绪时，同步那次尝试就该接上', () => {
  const svc = { ask: async () => ({ answers: [] }) }
  const h = makeCtx({ userQuestions: svc })
  MOD.apply(h.ctx, {})
  assert.equal(svc.__dshQqWrapped, true)
})

await test('补接是幂等的：服务反复就绪也不会套娃包装', () => {
  const svc = { ask: async () => ({ answers: [] }) }
  const h = makeCtx({ userQuestions: svc })
  MOD.apply(h.ctx, {})
  const wrapped = svc.ask
  h.provideUserQuestions(svc)
  assert.equal(svc.ask, wrapped, '重复包装会套娃，ask 应保持同一个函数')
})

await test('★ 回归：等到「第一次提问」才就绪的服务，必须在那一刻补接上', () => {
  // deferUserQuestions=false + 服务缺失 ⇒ apply 时那次 ctx.inject 的回调被丢弃。
  // 这复刻的是最坏顺序：apply 时服务没到、inject 兜底也没赶上，
  // 服务一直等到 agent 真的要提问了才就绪（真实环境里这是必然发生的时刻）。
  const h = makeCtx({ userQuestions: null, deferUserQuestions: false })
  MOD.apply(h.ctx, {})

  const svc = { ask: async () => ({ answers: [] }) }
  h.provideUserQuestions(svc)
  assert.notEqual(svc.__dshQqWrapped, true, '这条路径下 inject 兜底失效，此刻应当仍未接上')

  const exec = {
    name: 'ask_user_question',
    arguments: {
      questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }],
    },
    agent: h.makeAgent('a1', makeSession()),
  }
  h.emit('tools/pre-execute', exec, () => {})

  assert.equal(svc.__dshQqWrapped, true,
    'agent 已经要提问了，服务必然已就绪 —— 这一刻必须补接，否则提问又会退化成一条没有选项的纯文本')
})

await test('提问兜底文案带编号选项：中继彻底接不上时，QQ 里也看得见在问什么', () => {
  // 服务永远不来 ⇒ 中继接不上 ⇒ push('question') 就得把选项渲染出来。
  const h = makeCtx({ userQuestions: null, deferUserQuestions: false, withSystemPrompt: false })
  MOD.apply(h.ctx, {})

  const exec = {
    name: 'ask_user_question',
    arguments: {
      questions: [{
        id: 'q1',
        question: '选哪个方案？',
        options: [{ label: '方案A' }, { label: '方案B' }],
      }],
    },
    agent: h.makeAgent('a1', makeSession()),
  }
  // 不该抛错，且不该把 next 链断掉。
  let reachedNext = false
  h.emit('tools/pre-execute', exec, () => { reachedNext = true })
  assert.equal(reachedNext, true, 'pre-execute 必须继续放行，不能吞掉提问')
})

console.log(`\n通过 ${passed} / 失败 ${failed}`)
if (failed > 0) process.exitCode = 1
