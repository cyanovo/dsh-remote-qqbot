/**
 * 回归测试：settings 读取路径（第三个致命 bug 的护栏）。
 *
 * 核心回归点：settings 服务的 `get(ns)` **只返回已注册 namespace 的值**，
 * 未注册一律 undefined。原实现直接 get → 静默拿到 {} → 所有用户配置失效。
 *
 * 这里的 mock 严格复刻真实语义：
 *   - registrations 是 Map，get(ns) 查不到就返回 undefined
 *   - register 重复调用会 throw
 *   - register 的 resolved = schema(base 与 user 合并)  ← 与真实 resolve() 同构
 *
 * 运行：node tests/settings.test.mjs
 */

import assert from 'node:assert/strict'

const MOD = await import('../lib/index.js')

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed += 1
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`      ${err.message}`)
    failed += 1
  }
}

/** 复刻真实的 settings 服务语义。 */
function makeSettingsService(userSection = {}) {
  const registrations = new Map()
  return {
    registrations,
    register(ns, schema, options) {
      if (registrations.has(ns)) {
        throw new Error(`settings namespace "${ns}" is already registered`)
      }
      // 真实实现：schema(mergeLayers(base, section))
      const merged = { ...(options?.base ?? {}), ...userSection }
      const resolved = Object.freeze(schema(merged))
      registrations.set(ns, { ns, resolved, watchers: new Set() })
      return {
        get: () => resolved,
        watch: (cb) => {
          registrations.get(ns).watchers.add(cb)
          return () => registrations.get(ns).watchers.delete(cb)
        },
        update: () => {},
        replace: () => {},
      }
    },
    // 关键：未注册 → undefined（与真实实现一致）
    get(ns) {
      return registrations.get(ns)?.resolved
    },
    describe: () => [],
  }
}

/** 构造一个最小 ctx，支持 inject(['settings']) 与 get()。 */
function makeCtx(settingsService, config = {}) {
  const tools = new Map()
  const effects = []
  const injected = {}
  const ctx = {
    settings: undefined,
    get(name) {
      if (name === 'settings') return ctx.settings
      if (name === 'tools') return { register: (d) => { tools.set(d.name, d); return () => {} } }
      if (name === 'systemPrompt') return { context: () => () => {} }
      return undefined
    },
    on() { return () => {} },
    effect(fn) { effects.push(fn); return () => {} },
    inject(names, cb) {
      injected[names.join(',')] = cb
      if (names.includes('settings') && settingsService) {
        ctx.settings = settingsService
        cb(ctx)
      }
      return () => {}
    },
    tools,
    effects,
  }
  ctx.tools = { register: (d) => { tools.set(d.name, d); return () => {} } }
  return ctx
}

console.log('settings 读取路径回归测试（第三个致命 bug 护栏）\n')

await test('Config 同时满足两套契约：cordis 的 ~standard 与 settings.register 的调用式', () => {
  assert.equal(typeof MOD.Config, 'function', 'Config 必须可调用（settings.register 内部会 schema(value)）')
  assert.ok(MOD.Config['~standard'], 'Config 必须带 ~standard（cordis resolveConfig 需要）')
  const v = MOD.Config({})
  assert.equal(v.agentmdMainFile, 'main.md')
})

await test('register 被真正调用（未注册是原 bug 的根源）', () => {
  const svc = makeSettingsService({ hubUrl: 'https://hub.example', agentmdDir: 'D:\\x\\agentmd' })
  const ctx = makeCtx(svc)
  MOD.apply(ctx, {})
  assert.ok(svc.registrations.has('dsh-remote-qqbot'), '必须注册 dsh-remote-qqbot namespace')
})

await test('settings.yaml 里的值被真正读到（回归：曾经恒为 undefined）', () => {
  const svc = makeSettingsService({
    hubUrl: 'https://cyanovo.top:8444/dsh-hub',
    token: 'tok-from-settings',
    agentmdDir: 'D:\\cyanproject\\agenttool\\agentmd',
    agentmdMainFile: 'main.md',
    agentmdInject: true,
    agentmdAppendLog: true,
    agentmdSummaryChars: 200,
  })
  const logs = []
  const orig = console.log
  console.log = (...a) => { logs.push(a.join(' ')); orig(...a) }
  try {
    const ctx = makeCtx(svc)
    MOD.apply(ctx, {})
  } finally {
    console.log = orig
  }
  const joined = logs.join('\n')
  // 「运行状态」快照 = 设置面板里显示的那一份（启动日志只留 QQ 提醒 / 协作两行）
  const st = (label) => (MOD.lastStatusLines().find((r) => r.label === label) || {}).value || ''
  assert.equal(st('配置来源'), 'settings.yaml 的 "dsh-remote-qqbot" 段', '应声明配置来自 settings.yaml')
  assert.match(st('通知中枢'), /https:\/\/cyanovo\.top:8444\/dsh-hub/, 'hubUrl 应被读出')
  assert.ok(st('agentmd').includes('D:\\cyanproject\\agenttool\\agentmd'), 'agentmdDir 应被读出')
  assert.match(st('agentmd'), /上下文注入 开/, 'agentmdInject=true 应生效')
  // 启动日志本身要**安静**：只留那两行（+ 故障警告）
  assert.match(joined, /^\[remote-qqbot\] QQ 提醒：/m, '启动日志要有 QQ 提醒一行')
  assert.match(joined, /^\[remote-qqbot\] 协作：/m, '启动日志要有协作一行')
  assert.ok(!/中枢：/.test(joined), 'hubUrl 不该再刷在启动日志里（已挪进设置面板）')
})

await test('settings 服务不可用 → 回退默认值并打印明确中文警告（不再静默）', () => {
  const logs = []
  const orig = console.log
  console.log = (...a) => { logs.push(a.join(' ')); orig(...a) }
  try {
    const ctx = makeCtx(null) // 没有 settings 服务
    MOD.apply(ctx, {})
  } finally {
    console.log = orig
  }
  const joined = logs.join('\n')
  assert.match(joined, /⚠️ 配置来源：内置默认值/, '必须明确警告，不能静默')
  assert.match(joined, /不会生效/, '要告诉用户配置不会生效')
  const st = (label) => (MOD.lastStatusLines().find((r) => r.label === label) || {}).value || ''
  assert.match(st('配置来源'), /内置默认值/, '设置面板里的状态也要说实话')
  assert.equal(st('配置来源').length > 0 && MOD.lastStatusLines().find((r) => r.label === '配置来源').warn, true,
    '这条状态要标成告警（warn），界面才会用警示色')
})

await test('重复 register 不会崩（同一 ns 二次装配）', () => {
  const svc = makeSettingsService({ hubUrl: 'https://a' })
  const ctx1 = makeCtx(svc)
  MOD.apply(ctx1, {})
  // 第二次 apply 复用同一个 service → register 会 throw，插件必须捕获而不是崩
  const logs = []
  const orig = console.log
  console.log = () => {}
  let threw = false
  try {
    const ctx2 = makeCtx(svc)
    MOD.apply(ctx2, {})
  } catch {
    threw = true
  } finally {
    console.log = orig
  }
  assert.equal(threw, false, '重复注册应被捕获，不能让插件崩')
})

await test('rawConfig 与 settings 同时存在时，两者都能被消费（不互相破坏）', () => {
  const svc = makeSettingsService({ hubUrl: 'https://from-settings', agentmdDir: 'D:\\from-settings' })
  const ctx = makeCtx(svc)
  MOD.apply(ctx, { hubUrl: 'https://from-raw' })
  const scope = svc.registrations.get('dsh-remote-qqbot')
  assert.equal(scope.resolved.hubUrl, 'https://from-settings', 'scope 本身反映 settings 层')
  // rawConfig 作为装配期显式覆盖，优先级最高（liveConfig 里最后展开）
  assert.equal(scope.resolved.agentmdDir, 'D:\\from-settings', 'settings 层不被 rawConfig 破坏')
})

await test('启动自检的状态必须自洽（回归：曾出现「配置来源=settings」但「hubUrl 未配置」）', () => {
  const svc = makeSettingsService({ hubUrl: 'https://hub.consistency', agentmdDir: 'D:\\consistency' })
  const logs = []
  const orig = console.log
  console.log = (...a) => { logs.push(a.join(' ')); orig(...a) }
  try {
    MOD.apply(makeCtx(svc), {})
  } finally {
    console.log = orig
  }
  const joined = logs.join('\n')
  const st = (label) => (MOD.lastStatusLines().find((r) => r.label === label) || {}).value || ''
  // 声明来源是 settings 时，状态行必须也反映 settings 里的值
  if (/settings\.yaml/.test(st('配置来源'))) {
    assert.match(st('通知中枢'), /https:\/\/hub\.consistency/, '来源说 settings，状态就必须显示 settings 里的 hubUrl')
    assert.ok(st('agentmd').includes('D:\\consistency'), 'agentmdDir 同样必须出现')
    assert.ok(!/未配置/.test(st('通知中枢')), '不得同时出现"未配置"')
  }
  // 不得出现内部不一致告警
  assert.ok(!/内部不一致/.test(joined), '不应触发内部不一致告警')
})

await test('ctx.inject 兜底路径会重新打印状态（不再停留在旧的"未生效"结论）', () => {
  // 模拟：主路径拿不到服务，靠 inject 异步补上
  const svc = makeSettingsService({ hubUrl: 'https://late-service', agentmdDir: 'D:\\late' })
  const logs = []
  const orig = console.log
  console.log = (...a) => { logs.push(a.join(' ')); orig(...a) }
  try {
    const tools = new Map()
    let ctxRef
    const ctx = {
      get(n) {
        if (n === 'settings') return ctxRef.settingsReady ? svc : undefined
        if (n === 'tools') return { register: (d) => { tools.set(d.name, d); return () => {} } }
        return undefined
      },
      on: () => () => {},
      effect: (fn) => { fn(); return () => {} },
      inject: (names, cb) => {
        if (names.includes('settings')) {
          ctxRef.settingsReady = true
          ctxRef.settings = svc
          cb(ctxRef)
        }
        return () => {}
      },
      settingsReady: false,
      settings: undefined,
      tools,
    }
    // 插件用 ctx.tools.register(...) 访问（cordis 会把注入的服务挂在 ctx 上）
    ctx.tools = { register: (d) => { tools.set(d.name, d); return () => {} } }
    ctxRef = ctx
    MOD.apply(ctx, {})
  } finally {
    console.log = orig
  }
  const joined = logs.join('\n')
  // 兜底成功后应再次自检，且**最后一次**状态快照必须是"读到配置"
  const st = (label) => (MOD.lastStatusLines().find((r) => r.label === label) || {}).value || ''
  assert.match(st('通知中枢'), /https:\/\/late-service/, '兜底路径应重新算出正确状态')
  assert.equal(st('配置来源'), 'settings.yaml 的 "dsh-remote-qqbot" 段', '最后一次报告必须是 settings 来源')
  assert.match(st('agentmd'), /D:\\late/, 'agentmdDir 也要跟上')
})

await test('回归：Cordis 传入的「已填满默认值的 config」不得覆盖 settings 里的真实值', () => {
  // 精确复刻 cordis 行为：resolveConfig() 返回 schema 校验后的对象（vendor/cordis/lib/index.js
  // 里 `return result.value`），每个键都被默认值填满。
  // 原实现 {...scope, ...rawConfig} 会被这堆空串覆盖，导致 scope 有值却读出空。
  const cordisPassedConfig = MOD.Config({})
  assert.equal(cordisPassedConfig.hubUrl, '', '前置：cordis 传进来的 hubUrl 确实是空串')

  const svc = makeSettingsService({
    hubUrl: 'https://cyanovo.top:8444/dsh-hub',
    agentmdDir: 'D:\\cyanproject\\agenttool\\agentmd',
    agentmdInject: true,
  })
  const logs = []
  const orig = console.log
  console.log = (...a) => { logs.push(a.join(' ')); orig(...a) }
  try {
    MOD.apply(makeCtx(svc), cordisPassedConfig) // ← 关键：传的就是 cordis 会给的东西
  } finally {
    console.log = orig
  }
  const joined = logs.join('\n')
  const st = (label) => (MOD.lastStatusLines().find((r) => r.label === label) || {}).value || ''
  assert.match(st('通知中枢'), /https:\/\/cyanovo\.top:8444\/dsh-hub/, 'settings 的 hubUrl 必须存活')
  assert.ok(st('agentmd').includes('D:\\cyanproject\\agenttool\\agentmd'), 'agentmdDir 必须存活')
  assert.match(st('agentmd'), /上下文注入 开/, 'agentmdInject=true 必须存活')
  assert.ok(!/内部不一致/.test(joined), '不应触发内部不一致告警')
})

await test('★ 运行状态里能看到「跑的是 / 装的是」（"装完没重启"是个看不见的坑）', () => {
  // 为什么钉这一行：DSH 没有插件热重载 —— `pnpm add` 换的只是磁盘文件。
  // 主人 2026-10-07 被它卡了一整天（手机那头跑的是 1.0.18、磁盘上已是 1.0.20、
  // `/update` 还说"已经是最新版"，新功能一个也看不到）。界面上唯一能看见这个差异的地方就是这一行。
  const svc = makeSettingsService({ hubUrl: 'https://hub.example' })
  MOD.apply(makeCtx(svc), {})
  const row = MOD.lastStatusLines().find((r) => r.label === '插件版本')
  assert.ok(row, '状态里必须有「插件版本」这一行')
  assert.match(row.value, /跑的是 \d+\.\d+\.\d+/, '要说清内存里跑的是哪一版')
  assert.match(row.value, /装的是 \d+\.\d+\.\d+/, '也要说清磁盘上装的是哪一版')
  assert.notEqual(row.warn, true, '两边一致时不该报警')
})

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
