/**
 * 回归测试：UI 配置路由的**读数来源**（「QQ 未连接」误报的护栏）。
 *
 * 真实故障（2026-10-02，骗过两轮修复）：
 *   - 桌面版启动时把 `~/.dsh/settings.yaml` **无条件改名**为 `settings.yaml.imported`
 *     （见 app.asar 的 `SettingsForms.importLegacyDocument()`），用户层因此长期为空。
 *   - 而 `settings.describe().value` 只合成「schema 默认 → registrant base → 用户层」三层
 *     （packages/settings/settings/src/index.ts:696 `resolve()`），
 *     **不含 profile 补丁层**（cordis.patch.yml 的 `config:`）。
 *   两者叠加：host 侧（liveConfig）配置齐全、QQ 推送一切正常，
 *   但这个 UI 路由读到**全 null** → 聊天框下方显示「QQ 未连接」、设置面板一片空白。
 *
 * 所以护栏有两条，缺一不可：
 *   1. `configView` 必须能用 **host 侧真值**兜底 —— UI 显示的必须与插件实际在用的一致。
 *   2. secret（qqClientSecret / token）**绝不回显**，只回报「已设置」。
 *
 * 注意 mock 复刻真实契约：`describe()` 返回**数组**（未注册的 namespace 根本不在里面），
 * 而不是「返回一个对象、字段为空」——后者会让这个 bug 躲过测试。
 *
 * 运行：node tests/config-view.test.mjs
 */

import assert from 'node:assert/strict'

const { configView } = await import('../lib/config-api.js')

const NS = 'dsh-remote-qqbot'

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

/** 复刻真实 settings 服务里被 describe 用到的部分。 */
function makeSettings({ descriptors = [], throwOnDescribe = false } = {}) {
  return {
    describe() {
      if (throwOnDescribe) throw new Error('describe exploded')
      return descriptors
    },
  }
}

/** 一个「桌面版现状」的 describe：namespace 根本不在列表里。 */
const noNamespace = () => makeSettings({ descriptors: [] })

/** 一个「namespace 在、但用户层为空」的 describe —— 值全是 schema 默认/空。 */
const emptyNamespace = () => makeSettings({
  descriptors: [{
    ns: NS,
    revision: 7,
    value: { qqEnabled: null, qqNotifyEnabled: null, hubUrl: '', agentmdDir: '' },
  }],
})

/** host 侧真值（≈ 插件 liveConfig() 的产物）。 */
const hostConfig = () => ({
  qqEnabled: true,
  qqNotifyEnabled: true,
  qqAppId: '102000001',
  qqClientSecret: 'SUPER-SECRET-DO-NOT-LEAK',
  qqCwd: 'D:\\cyanproject\\agenttool',
  hubUrl: 'https://cyanovo.top:8444/dsh-hub',
  token: 'HUB-TOKEN-DO-NOT-LEAK',
  timeoutMs: 8000,
  agentmdDir: 'D:\\cyanproject\\agenttool\\agentmd',
  agentmdMainFile: 'main.md',
  agentmdInject: true,
  agentmdAppendLog: true,
  agentmdSummaryChars: 480,
  qqSummaryChars: 300,
  notifySubagents: false,
  notifyChatSession: false,
  onTurnComplete: true,
  onQuestion: true,
  onError: true,
})

console.log('配置视图（configView）读数来源 —— 「QQ 未连接」误报的护栏')

await test('★ 核心护栏：describe 里没有该 namespace（桌面版现状）时，用 host 真值兜底，qqEnabled 必须为 true', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  assert.equal(
    view.values.qqEnabled, true,
    'qqEnabled 必须是 true，否则输入框下方会误报「QQ 未连接」——这正是本次要修的 bug',
  )
  assert.equal(view.values.hubUrl, 'https://cyanovo.top:8444/dsh-hub')
  assert.equal(view.values.agentmdDir, 'D:\\cyanproject\\agenttool\\agentmd')
  assert.equal(view.values.agentmdInject, true)
  assert.equal(view.diag.source, 'host')
  assert.equal(view.diag.settingsNamespaceFound, false)
  assert.ok(view.diag.hostConfigKeys > 0)
})

await test('describe 里 namespace 在、但值全是空（用户层被改名走了）时，同样必须兜底', () => {
  const view = configView(emptyNamespace(), NS, hostConfig)
  assert.equal(view.values.qqEnabled, true)
  assert.equal(view.values.hubUrl, 'https://cyanovo.top:8444/dsh-hub')
  assert.equal(view.revision, 7, 'revision 仍应透传（写入时的乐观并发靠它）')
  assert.equal(view.diag.source, 'settings+host')
})

await test('host 侧有值时以 host 为准（UI 必须反映插件实际在用的配置）', () => {
  const settings = makeSettings({
    descriptors: [{ ns: NS, value: { qqEnabled: false, hubUrl: 'https://old.example' } }],
  })
  const view = configView(settings, NS, hostConfig)
  assert.equal(view.values.qqEnabled, true, 'host 说开着，就不能显示成关着')
  assert.equal(view.values.hubUrl, 'https://cyanovo.top:8444/dsh-hub')
})

await test('没有 host 读取函数时，退回纯 describe（不破坏旧行为）', () => {
  const settings = makeSettings({
    descriptors: [{ ns: NS, revision: 3, value: { qqEnabled: true, hubUrl: 'https://x' } }],
  })
  const view = configView(settings, NS)
  assert.equal(view.values.qqEnabled, true)
  assert.equal(view.values.hubUrl, 'https://x')
  assert.equal(view.diag.source, 'settings')
})

await test('describe 抛异常也不能崩，仍靠 host 兜底', () => {
  const view = configView(makeSettings({ throwOnDescribe: true }), NS, hostConfig)
  assert.equal(view.ok, true)
  assert.equal(view.values.qqEnabled, true)
  assert.equal(view.diag.source, 'host')
})

await test('host 读取函数自己抛异常也不能崩', () => {
  const view = configView(emptyNamespace(), NS, () => { throw new Error('liveConfig exploded') })
  assert.equal(view.ok, true)
  assert.equal(view.values.qqEnabled, null)
  assert.equal(view.diag.source, 'settings')
})

await test('★ 安全护栏：secret 绝不回显明文，只回报「已设置」', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  const dumped = JSON.stringify(view)
  assert.ok(!dumped.includes('SUPER-SECRET-DO-NOT-LEAK'), 'qqClientSecret 明文泄漏到了响应里')
  assert.ok(!dumped.includes('HUB-TOKEN-DO-NOT-LEAK'), 'token 明文泄漏到了响应里')
  assert.equal(view.values.qqClientSecret, '')
  assert.equal(view.values.token, '')
  assert.equal(view.secretsSet.qqClientSecret, true, '必须告诉前端「已经设过值」')
  assert.equal(view.secretsSet.token, true)
})

await test('secret 未设置时 secretsSet 为 false（前端才不会误显示「已配置」）', () => {
  const view = configView(noNamespace(), NS, { qqEnabled: true, qqClientSecret: '', token: '' })
  assert.equal(view.secretsSet.qqClientSecret, false)
  assert.equal(view.secretsSet.token, false)
})

await test('既没有 describe 也没有 host 时，返回 null 而不是抛错', () => {
  const view = configView(noNamespace(), NS, {})
  assert.equal(view.ok, true)
  assert.equal(view.values.qqEnabled, null)
  assert.equal(view.diag.source, 'none')
})

await test('fields / groups 始终随响应返回（客户端表单靠它渲染）', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  assert.ok(Array.isArray(view.fields) && view.fields.length > 0)
  assert.ok(Array.isArray(view.groups) && view.groups.length > 0)
  assert.ok(view.fields.some((f) => f.key === 'qqEnabled'))
})

// ── 协作模式的开关（2026-10-02）：以前这些键只在 Config schema 里，界面上既看不到也改不了 ──

await test('★ 设置面板必须能看见「协作模式」这一组', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  const group = view.groups.find((g) => g.id === 'collab')
  assert.ok(group, 'FIELD_GROUPS 里缺 collab 分组 —— 用户在设置里就找不到协作开关')
  assert.match(group.title, /协作/)
})

await test('★ 协作总开关必须是可写字段（白名单从 FIELD_SPECS 派生，字段在 = 能写）', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  const spec = view.fields.find((f) => f.key === 'collabEnabled')
  assert.ok(spec, 'FIELD_SPECS 里缺 collabEnabled —— 输入框下方那个开关会保存失败（被白名单丢弃）')
  assert.equal(spec.type, 'boolean')
  assert.equal(spec.group, 'collab')
})

await test('协作的其余开关也在字段表里（范围 / 冲突策略 / 注入 / 子智能体）', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  const keys = new Set(view.fields.map((f) => f.key))
  for (const key of ['collabScope', 'collabClaimGuard', 'collabInject', 'collabIncludeSubagents']) {
    assert.ok(keys.has(key), `缺字段 ${key}`)
  }
  const scope = view.fields.find((f) => f.key === 'collabScope')
  assert.deepEqual(scope.options, ['workspace', 'global'], '范围只有这两个取值')
})

await test('★ host 说协作关着，UI 就必须显示关着（不能写死成开）', () => {
  const view = configView(noNamespace(), NS, { ...hostConfig(), collabEnabled: false })
  assert.equal(view.values.collabEnabled, false)
})

// ── 截图的开关（2026-10-02）：关掉截图后的提示让用户"去设置里打开「允许截图」"，
//    可当时字段表里根本没有这一项 —— 提示指向一个不存在的字段。这组就是那次的自洽性护栏。

await test('★ 设置面板必须能看见「允许截图」（否则那句话指向一个不存在的字段）', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  const spec = view.fields.find((f) => f.key === 'qqScreenEnabled')
  assert.ok(spec, 'FIELD_SPECS 里缺 qqScreenEnabled —— 用户想关截图时在设置里找不到')
  assert.equal(spec.type, 'boolean')
  assert.equal(spec.group, 'qq')
  assert.match(spec.label, /允许截图/, '界面标签必须与提示里说的名字逐字一致')
})

await test('★ 关掉截图后那句提示里说的字段名，必须真的能在设置面板里找到', async () => {
  const runtimesSrc = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../src/qqruntime.js', import.meta.url), 'utf8',
  ))
  const quoted = /设置 → QQ 提醒与记忆 → 把「([^」]+)」打开/.exec(runtimesSrc)
  assert.ok(quoted, 'qqruntime 里应当有一句"去哪儿打开截图"的提示')
  const view = configView(noNamespace(), NS, hostConfig)
  const labels = view.fields.map((f) => f.label)
  assert.ok(labels.includes(quoted[1]),
    `提示让用户去找「${quoted[1]}」，但设置面板的标签里没有它（现有：${labels.join(' / ')}）`)
})

await test('截图限宽也在字段表里，且 0 是合法值（= 不缩放）', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  const spec = view.fields.find((f) => f.key === 'qqScreenMaxWidth')
  assert.ok(spec, 'FIELD_SPECS 里缺 qqScreenMaxWidth')
  assert.equal(spec.type, 'number')
  assert.equal(spec.min, 0, '0 表示不缩放，不能被最小值挡住')
})

await test('★ 已删除的 qqScreenQuality 不许出现在字段表里（会写入一个 schema 不认识的键）', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  assert.ok(!view.fields.some((f) => f.key === 'qqScreenQuality'))
})

await test('★ 云端账号的两个键必须能在设置面板里改（0.8.8 新加，最容易"后端认、界面不显示"）', () => {
  const view = configView(noNamespace(), NS, () => ({ cloudUrl: 'http://cyanovo.top', cloudToken: 'x' }))
  const url = view.fields.find((f) => f.key === 'cloudUrl')
  const tok = view.fields.find((f) => f.key === 'cloudToken')
  assert.ok(url, 'FIELD_SPECS 里缺 cloudUrl —— 那就没法在界面上填云端地址')
  assert.equal(url.group, 'cloud')
  assert.ok(tok, 'FIELD_SPECS 里缺 cloudToken —— 那就没法在界面上管理账号令牌')
  assert.equal(tok.type, 'secret', 'cloudToken 必须按 secret 处理（输入框不回显）')
  assert.ok(view.groups.some((g) => g.id === 'cloud'), '缺 cloud 分组标题（字段会没有归属）')
})

await test('★ secret 的值绝不回显：只报"有没有设"', () => {
  const view = configView(noNamespace(), NS, () => ({ cloudToken: 'super-secret-token' }))
  assert.equal(view.secretsSet.cloudToken, true)
  assert.ok(!JSON.stringify(view.values ?? {}).includes('super-secret-token'),
    'secret 明文出现在视图里了 —— 前端会把它渲染进 input.value')
})

// ── 接收 QQ 推送这一个开关（1.0.20）────────────────────────────────────────
// 主人 2026-10-07：「我希望在 DSH 的设置里面，也有插件是否接收推送功能的开关」。
// 这个开关本来就存在（键 `qqNotifyEnabled`，标签叫「远程提醒」），但它排在
// `qqEnabled` 后面、混在二十多个字段中间 —— 主人翻不到。所以这一组守两件事：
// ①字段表里它必须是**显眼的那个名字**并且说明白"关掉会怎样"；②设置页把它单独提到最上面一张卡。

await test('★ 设置字段表里有「接收 QQ 推送」这个开关（不是让人去猜「远程提醒」是它）', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  const spec = view.fields.find((f) => f.key === 'qqNotifyEnabled')
  assert.ok(spec, 'FIELD_SPECS 里缺 qqNotifyEnabled —— 设置页就没有这个开关')
  assert.equal(spec.type, 'boolean', '必须是个开关，不是输入框')
  assert.equal(spec.group, 'qq')
  assert.equal(spec.label, '接收 QQ 推送')
  assert.match(spec.description, /新版本/, '光说"任务完成/提问/出错"不够 —— 新版本提醒也归这个开关管')
  assert.match(spec.description, /长连接|反向对话/, '要说清关掉之后什么还照旧（否则人会怕关了收不到自己的话）')
  assert.match(spec.description, /输入框旁边|小开关/, '要说明它和输入框旁边那个小开关是同一个东西')
})

await test('★ host 说推送关着 → 视图里就是关着（界面据此显示"关"，不能自己猜成开）', async () => {
  const off = configView(noNamespace(), NS, () => ({ qqEnabled: true, qqNotifyEnabled: false }))
  assert.equal(off.values.qqNotifyEnabled, false)
  const on = configView(noNamespace(), NS, () => ({ qqEnabled: true, qqNotifyEnabled: true }))
  assert.equal(on.values.qqNotifyEnabled, true)
  // host 侧连这个键都没给时，configView 只能回 null（字段表没有 default 一说）。
  // 那种情况下界面**必须**按插件真正的判据 "=== false 才关" 显示 —— 否则会显示成"关"、
  // 而插件其实在推（运行状态那一行用的也是 `=== false`）。所以钉住 client 的写法。
  const missing = configView(noNamespace(), NS, () => ({ qqEnabled: true }))
  assert.equal(missing.values.qqNotifyEnabled, null)
  const client = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../src/client.js', import.meta.url), 'utf8',
  ))
  assert.match(client, /const pushOn = valueOf\('qqNotifyEnabled'\) !== false/,
    '缺省视为开 —— 与 runtime / 运行状态同一判据')
  assert.match(client, /checked: pushOn/, '开关的显示要跟行为用同一条判据，不能写成 === true')
})

await test('★ 设置页把「接收 QQ 推送」提到最上面那张卡，且分组表里不重复渲染同一个键', async () => {
  const client = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../src/client.js', import.meta.url), 'utf8',
  ))
  assert.match(client, /field\.key === 'qqNotifyEnabled'/, '要按这个键把卡片挑出来')
  assert.match(client, /key: 'push-switch'/, '卡片本体（排在最前面的那一块）')
  assert.match(client, /field\.key !== 'qqNotifyEnabled'/, '🔴 分组表里必须排掉它 —— 同一个开关一屏出现两次，最容易让人以为"改了没生效"')
  // 卡片必须是"有字段才渲染"：字段表里删了它，卡片不能还硬写着一份自己的文案。
  assert.match(client, /pushField\s*\n?\s*\? h\('section', \{ key: 'push-switch'/, '缺字段时整块不渲染')
  assert.match(client, /pushField\.label/, '标题取字段表里的标签（单一真源），不另写一份')
  assert.match(client, /pushField\.description/, '说明也取字段表里的（单一真源）')
})

// ── 运行状态（2026-10-03）：启动日志只留两行，其余挪到设置面板 ──────────────

await test('★ 「运行状态」会出现在配置视图里（启动日志不再刷的那些）', () => {
  const rows = [
    { label: '配置来源', value: 'settings.yaml 的 "dsh-remote-qqbot" 段' },
    { label: '通知中枢', value: 'https://hub.test/dsh-hub' },
    { label: '云端网页端', value: 'http://cyanovo.top（已绑定账号令牌）' },
  ]
  const view = configView(noNamespace(), NS, hostConfig, rows)
  assert.equal(view.status.length, 3, '状态条数应与 host 给的一致')
  assert.equal(view.status[1].label, '通知中枢')
  assert.match(view.status[1].value, /hub\.test/)
  assert.equal(view.status[0].warn, false, '没标 warn 的必须规整成 false（前端才好判断）')
})

await test('★ 状态里的告警位要传下去（界面用警示色，不再靠肉眼看日志）', () => {
  const view = configView(noNamespace(), NS, hostConfig, () => [
    { label: '配置来源', value: '内置默认值', warn: true },
  ])
  assert.equal(view.status[0].warn, true)
})

await test('★ host 的状态函数炸了也不能拖垮整个配置视图', () => {
  const view = configView(noNamespace(), NS, hostConfig, () => { throw new Error('status exploded') })
  assert.equal(view.ok, true, '配置视图仍必须是可用的')
  assert.deepEqual(view.status, [], '状态取不到就空着，界面不显示这一块')
})

await test('不传状态时（老调用方）也只是空数组，不报错', () => {
  const view = configView(noNamespace(), NS, hostConfig)
  assert.deepEqual(view.status, [])
})

console.log('')
console.log(`通过 ${passed} / 失败 ${failed}`)
if (failed > 0) process.exit(1)
