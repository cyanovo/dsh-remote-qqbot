/**
 * 回归测试：界面开关**真的能存下来**（「点了没有用、永远保持开启」的护栏）。
 *
 * 真实故障（2026-10-02，主人报「点击 QQ 提醒或者协作模式这两个按钮，点了没有用，
 * 它们永远保持开启」）。两条根因，缺一不可：
 *
 * 1. **桌面版拒绝第三方命名空间写入**。`config.set` 里的 `settings.update(ns, patch)`
 *    在桌面版抛 `No configurable plugin entry "dsh-remote-qqbot"`
 *    （`SettingsService.write()` 只认 profile 里 id 等于 ns 的条目，而我们的条目 id 是 `remote-qqbot`）。
 * 2. **路由把这次失败报成了成功**。失败分支写成 `{ ok: false, error, ...configView(...) }`，
 *    展开在后面，`configView` 返回的 `ok: true` 把 `ok: false` 覆盖掉 ⇒
 *    浏览器以为存成功、把开关重置回服务端旧值 ⇒ **弹回原位，一个字的提示都没有**。
 *
 * 所以护栏有三层，缺一不可：
 *   - [A] 覆盖文件本身：读/写/白名单/半截 JSON 不崩、`false` 不被当成空值丢掉；
 *   - [B] `persistConfigPatch`：原生失败必须落覆盖文件，原生成功**不许**写文件；
 *   - [C] **整条路由真跑一遍**（mock ctx → 抓 handler → 造 req/res）：
 *       原生抛错时 `ok` 必须仍是 `false`（不许被 configView 覆盖），
 *       或者走覆盖文件后真的存住 —— 两条路都不能再出现"界面假装成功"。
 *
 * 注意 [C] 用的是**真的** `mountConfigApi` + **真的** handler + **真的** 覆盖文件，
 * mock 的只有 DSH 的 settings 服务与 HTTP 对象 —— 因为被掩盖的正是这条路径。
 *
 * 运行：node tests/ui-persist.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  OVERRIDE_FILE_NAME,
  applyPatch,
  filterPatch,
  overrideFilePath,
  persistConfigPatch,
  readOverrides,
  writeOverrides,
} = await import('../lib/overrides.js')

const { mountConfigApi } = await import('../lib/config-api.js')

const NS = 'dsh-remote-qqbot'
// 镜像 `src/index.js` 的 `configKeys = new Set(Object.keys(DEFAULTS))`：
// 这份白名单决定「哪些键允许落进覆盖文件」，漏掉键 = 该键点了永远存不住。
const KEYS = new Set(['qqEnabled', 'qqNotifyEnabled', 'collabEnabled', 'hubUrl', 'qqClientSecret'])

/** 桌面版实测报错原文（本文件的存在理由）。 */
const DESKTOP_REJECTION = 'No configurable plugin entry "dsh-remote-qqbot"'

let passed = 0
let failed = 0
const roots = []

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

/** 一次性临时目录（用真实文件系统，因为要验的正是"有没有落盘"）。 */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-qqbot-overrides-'))
  roots.push(dir)
  return dir
}

// ── [A] 覆盖文件本身 ───────────────────────────────────────────────────────

console.log('\n[A] 覆盖文件：读 / 写 / 白名单')

await test('overrideFilePath：优先 DSH_HOME，缺省 ~/.dsh，并去掉首尾空格', () => {
  assert.equal(overrideFilePath('D:\\dshhome'), join('D:\\dshhome', OVERRIDE_FILE_NAME))
  assert.equal(overrideFilePath('  D:\\dshhome  '), join('D:\\dshhome', OVERRIDE_FILE_NAME))
  assert.equal(overrideFilePath(''), join('.dsh', OVERRIDE_FILE_NAME))
  assert.equal(overrideFilePath(undefined), join('.dsh', OVERRIDE_FILE_NAME))
})

await test('filterPatch：白名单外的键被丢弃，白名单内的原样保留', () => {
  const out = filterPatch({ collabEnabled: false, __proto__hack: 1, whatever: 'x' }, KEYS)
  assert.deepEqual(out, { collabEnabled: false })
})

await test('filterPatch：false / 0 / 空串**必须保留**（它们是有效值，不是"没填"）', () => {
  // ⚠️ 这条是本次事故的核心：要关掉提醒就是 `qqNotifyEnabled: false`。
  // 如果哪个实现图省事写成 `if (!value) continue`，关开关会静默无效 —— 正是主人遇到的现象。
  const out = filterPatch({ qqNotifyEnabled: false, qqEnabled: 0, hubUrl: '' }, KEYS)
  assert.equal(Object.hasOwn(out, 'qqNotifyEnabled'), true)
  assert.equal(out.qqNotifyEnabled, false)
  assert.equal(out.qqEnabled, 0)
  assert.equal(out.hubUrl, '')
})

await test('filterPatch：undefined 必须丢掉（否则会在内存里盖掉真实值）', () => {
  const out = filterPatch({ collabEnabled: undefined, qqEnabled: true }, KEYS)
  assert.deepEqual(Object.keys(out), ['qqEnabled'])
})

await test('readOverrides：文件不存在是**正常状态**，不算错误', () => {
  const file = join(tempDir(), 'nope.json')
  assert.deepEqual(readOverrides(file, KEYS), { values: {}, error: '' })
})

await test('readOverrides：半截 / 非法 JSON 不抛，报错并给空值', () => {
  const file = join(tempDir(), 'broken.json')
  writeFileSync(file, '{"collabEnabled": false', 'utf8')
  const out = readOverrides(file, KEYS)
  assert.deepEqual(out.values, {})
  assert.match(out.error, /JSON/)
})

await test('readOverrides：顶层不是对象（数组 / 数字）也不抛', () => {
  const dir = tempDir()
  const arr = join(dir, 'arr.json')
  writeFileSync(arr, '[1,2,3]', 'utf8')
  assert.deepEqual(readOverrides(arr, KEYS).values, {})
  assert.notEqual(readOverrides(arr, KEYS).error, '')
  const num = join(dir, 'num.json')
  writeFileSync(num, '42', 'utf8')
  assert.notEqual(readOverrides(num, KEYS).error, '')
})

await test('readOverrides：手工塞进白名单外的键会被过滤掉', () => {
  const file = join(tempDir(), 'extra.json')
  writeFileSync(file, JSON.stringify({ qqEnabled: true, token: 'leak', junk: [1] }), 'utf8')
  assert.deepEqual(readOverrides(file, KEYS).values, { qqEnabled: true })
})

await test('写 → 读 往返：中文与 false 都能原样回来', () => {
  const file = join(tempDir(), 'rt.json')
  writeOverrides(file, { qqNotifyEnabled: false, hubUrl: 'https://例子.测试/中枢' })
  const out = readOverrides(file, KEYS)
  assert.equal(out.error, '')
  assert.deepEqual(out.values, { qqNotifyEnabled: false, hubUrl: 'https://例子.测试/中枢' })
})

await test('原子写：不留 .tmp 残留，父目录不存在会自动建', () => {
  const file = join(tempDir(), 'deep', 'nested', OVERRIDE_FILE_NAME)
  writeOverrides(file, { collabEnabled: false })
  assert.equal(existsSync(file), true)
  assert.equal(existsSync(`${file}.tmp`), false)
})

await test('写失败**必须抛**（调用方要如实报错，不能静默）', () => {
  const dir = tempDir()
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory', 'utf8')
  assert.throws(() => writeOverrides(join(blocker, 'x.json'), { qqEnabled: true }), /写入覆盖文件失败/)
})

await test('applyPatch：返回新对象，不改原对象', () => {
  const base = { a: 1, b: 2 }
  const next = applyPatch(base, { b: 3 })
  assert.deepEqual(next, { a: 1, b: 3 })
  assert.deepEqual(base, { a: 1, b: 2 })
})

// ── [B] persistConfigPatch ─────────────────────────────────────────────────

console.log('\n[B] persistConfigPatch：原生失败 → 落覆盖文件；原生成功 → 不许写文件')

await test('原生抛桌面版那句错 → via=override-file，且文件里**真的有**新值', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  const errors = []
  const result = await persistConfigPatch({
    patch: { qqNotifyEnabled: false },
    expectedRevision: undefined,
    nativeUpdate: async () => { throw new Error(DESKTOP_REJECTION) },
    file,
    current: {},
    onNativeError: (msg) => errors.push(msg),
  })
  assert.equal(result.via, 'override-file')
  assert.equal(result.nativeError, DESKTOP_REJECTION)
  assert.deepEqual(errors, [DESKTOP_REJECTION], 'onNativeError 应收到原始报错')
  assert.deepEqual(result.applied, ['qqNotifyEnabled'])
  // 关键：不是"返回了个对象就算成功"，文件必须真的写下去
  assert.equal(existsSync(file), true)
  assert.equal(readOverrides(file, KEYS).values.qqNotifyEnabled, false)
})

await test('原生成功 → via=dsh-settings，且**不**创建覆盖文件（免得两条路打架）', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  let called = 0
  const result = await persistConfigPatch({
    patch: { collabEnabled: false },
    expectedRevision: 3,
    nativeUpdate: async (patch, rev) => {
      called += 1
      assert.deepEqual(patch, { collabEnabled: false })
      assert.equal(rev, 3, 'expectedRevision 必须原样透传')
    },
    file,
    current: {},
    onNativeError: () => { throw new Error('不该被调用') },
  })
  assert.equal(called, 1)
  assert.equal(result.via, 'dsh-settings')
  assert.equal(result.nativeError, '')
  assert.equal(existsSync(file), false, '原生成功时不许留覆盖文件')
})

await test('没有 nativeUpdate（web/CLI 兜底）→ 直接走覆盖文件', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  const result = await persistConfigPatch({ patch: { collabEnabled: false }, file, current: {} })
  assert.equal(result.via, 'override-file')
  assert.equal(result.nativeError, '')
  assert.equal(readOverrides(file, KEYS).values.collabEnabled, false)
})

await test('多次改动**累积**（点两次开关不能只剩最后一次）', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  let current = {}
  const run = (patch) => persistConfigPatch({
    patch,
    nativeUpdate: async () => { throw new Error(DESKTOP_REJECTION) },
    file,
    current,
  }).then((r) => { current = r.values })
  await run({ qqNotifyEnabled: false })
  await run({ collabEnabled: false })
  assert.deepEqual(readOverrides(file, KEYS).values, { qqNotifyEnabled: false, collabEnabled: false })
})

await test('onNativeError 自己抛异常也不许影响保存', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  const result = await persistConfigPatch({
    patch: { collabEnabled: false },
    nativeUpdate: async () => { throw new Error(DESKTOP_REJECTION) },
    file,
    current: {},
    onNativeError: () => { throw new Error('日志通道炸了') },
  })
  assert.equal(result.via, 'override-file')
  assert.equal(readOverrides(file, KEYS).values.collabEnabled, false)
})

await test('写文件失败时**必须**向上抛（路由要能报 ok:false）', async () => {
  const dir = tempDir()
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x', 'utf8')
  await assert.rejects(
    persistConfigPatch({
      patch: { collabEnabled: false },
      nativeUpdate: async () => { throw new Error(DESKTOP_REJECTION) },
      file: join(blocker, 'sub', 'o.json'),
      current: {},
    }),
    /写入覆盖文件失败/,
  )
})

// ── [C] 整条路由真跑一遍 ───────────────────────────────────────────────────

console.log('\n[C] 真实路由：config.set 的 ok / values / 落盘（防"假装成功"）')

/**
 * 起一个真的 `mountConfigApi`，把 handler 抓出来。
 * mock 的只有 DSH 的 settings 服务与 node 的 req/res —— 被掩盖的正是这条链路。
 */
function bootRoute({ update, file, live = {} }) {
  let handler
  const nativeErrors = []
  const logs = []
  let uiOverrides = readOverrides(file, KEYS).values
  const settings = {
    describe: () => [], // 桌面版实测：我们的 namespace 根本不在 describe 结果里
    update,
  }
  const ctx = {
    inject(deps, cb) {
      cb({
        // ⚠️ 真实 cordis 里 `sctx` 就是 ctx 本身，`mountConfigApi` 靠 `sctx.get('settings')`
        //    拿 settings 服务。mock 少了 `get` 就会得到 "sctx.get is not a function"。
        get: (name) => (name === 'settings' ? settings : undefined),
        webServer: { register: (opts) => { handler = opts.handler } },
        webRuntime: { trustedHosts: [] },
      })
    },
    effect: (fn) => fn(),
  }
  // 与 src/index.js 的 persistUiPatch 同形（那边不导出，这里按同一条链拼出来）
  const persist = async (patch, expectedRevision) => {
    const filtered = filterPatch(patch, KEYS)
    const result = await persistConfigPatch({
      patch: filtered,
      expectedRevision,
      nativeUpdate: typeof settings.update === 'function'
        ? (next, revision) => settings.update(NS, next, revision)
        : undefined,
      file,
      current: uiOverrides,
      onNativeError: (msg) => nativeErrors.push(msg),
    })
    if (result.via === 'override-file') uiOverrides = result.values
    return result
  }
  const mounted = mountConfigApi(ctx, {
    ns: NS,
    log: (msg) => logs.push(msg),
    getLiveConfig: () => ({ ...live, ...uiOverrides }),
    persist,
  })
  assert.equal(mounted, true, 'mountConfigApi 应返回 true')
  return { handler, nativeErrors, logs, overrides: () => uiOverrides }
}

/** 造一个能过 isTrustedApiRequest 的请求（loopback host）。 */
function makeReq(method, path, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: path,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text, 'utf8')
    },
  }
}

function makeRes() {
  const res = {
    status: 0,
    body: undefined,
    writeHead(status) { res.status = status },
    end(text) { res.body = JSON.parse(text) },
  }
  return res
}

async function call(handler, method, path, body) {
  const res = makeRes()
  await handler(makeReq(method, path, body), res)
  return res
}

await test('GET config.get：host 真值覆盖 describe 的空结果（复刻「QQ 未连接」那一课）', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  const { handler } = bootRoute({ update: async () => {}, file, live: { qqEnabled: true, collabEnabled: true } })
  const res = await call(handler, 'GET', '/remote-qqbot/api/config.get')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.values.qqEnabled, true)
  assert.equal(res.body.values.collabEnabled, true)
})

await test('桌面版路径：config.set 之后**开关真的变成关**，且文件里存住了', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  const { handler, nativeErrors } = bootRoute({
    update: async () => { throw new Error(DESKTOP_REJECTION) },
    file,
    live: { qqEnabled: true, qqNotifyEnabled: true, collabEnabled: true },
  })
  const res = await call(handler, 'POST', '/remote-qqbot/api/config.set', {
    patch: { collabEnabled: false, qqNotifyEnabled: false },
    expectedRevision: undefined,
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true, '走覆盖文件这条合法路径应当如实报成功')
  assert.equal(res.body.via, 'override-file')
  assert.equal(res.body.values.collabEnabled, false, '返回的视图必须是关掉的 —— 否则开关会弹回原位')
  assert.equal(res.body.values.qqNotifyEnabled, false)
  assert.deepEqual(new Set(res.body.applied), new Set(['collabEnabled', 'qqNotifyEnabled']))
  // 落盘：下一次启动/下一次 GET 还得是关的
  assert.deepEqual(readOverrides(file, KEYS).values, { collabEnabled: false, qqNotifyEnabled: false })
  const again = await call(handler, 'GET', '/remote-qqbot/api/config.get')
  assert.equal(again.body.values.collabEnabled, false)
  assert.deepEqual(nativeErrors, [DESKTOP_REJECTION])
})

await test('★ 不接管写入时（旧行为）：失败必须是 ok:false，**不许**被 configView 的 ok:true 覆盖', async () => {
  // 这条是"点了没用且毫无提示"的直接护栏：任何时刻把 ok:false 写回展开之前，立刻报红。
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  let handler
  const settings = { describe: () => [], update: async () => { throw new Error(DESKTOP_REJECTION) } }
  const ctx = {
    inject(deps, cb) {
      cb({
        get: (name) => (name === 'settings' ? settings : undefined),
        webServer: { register: (o) => { handler = o.handler } },
        webRuntime: { trustedHosts: [] },
      })
    },
    effect: (fn) => fn(),
  }
  mountConfigApi(ctx, {
    ns: NS,
    log: () => {},
    getLiveConfig: () => ({ collabEnabled: true }),
    // 故意不传 persist：模拟"只靠 DSH 原生写入"的旧行为
  })
  const res = await call(handler, 'POST', '/remote-qqbot/api/config.set', {
    patch: { collabEnabled: false },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, false, '原生写入失败却报 ok:true ⇒ 界面会假装成功（这就是原文 bug）')
  assert.equal(res.body.error.code, 'settings-rejected')
  assert.match(res.body.error.message, /No configurable plugin entry/)
  assert.deepEqual(res.body.applied, [])
})

await test('走覆盖文件时写盘失败 → ok:false，且带上原因（失败绝不能被吞）', async () => {
  const dir = tempDir()
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x', 'utf8')
  const { handler } = bootRoute({
    update: async () => { throw new Error(DESKTOP_REJECTION) },
    file: join(blocker, 'sub', OVERRIDE_FILE_NAME),
    live: { collabEnabled: true },
  })
  const res = await call(handler, 'POST', '/remote-qqbot/api/config.set', { patch: { collabEnabled: false } })
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'settings-rejected')
  assert.match(res.body.error.message, /写入覆盖文件失败/)
})

await test('白名单外的键被丢弃；全被丢弃时直接返回未改动视图（不报错）', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  const { handler } = bootRoute({ update: async () => { throw new Error(DESKTOP_REJECTION) }, file, live: { collabEnabled: true } })
  const res = await call(handler, 'POST', '/remote-qqbot/api/config.set', { patch: { notAKey: 'x' } })
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.applied, [])
  assert.equal(existsSync(file), false, '空补丁不该产生覆盖文件')
})

await test('secret 走这条路也不回显明文（只报 secretsSet）', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  const { handler } = bootRoute({ update: async () => { throw new Error(DESKTOP_REJECTION) }, file, live: {} })
  await call(handler, 'POST', '/remote-qqbot/api/config.set', { patch: { qqClientSecret: 'super-secret' } })
  const res = await call(handler, 'GET', '/remote-qqbot/api/config.get')
  // 契约：secret 字段一律回报空串（不是 undefined），「设过没有」走 secretsSet。
  assert.equal(res.body.values.qqClientSecret, '')
  assert.equal(res.body.secretsSet.qqClientSecret, true)
  assert.equal(JSON.stringify(res.body).includes('super-secret'), false)
})

await test('跨站请求被挡（sec-fetch-site: cross-site）', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  const { handler } = bootRoute({ update: async () => {}, file })
  const req = makeReq('GET', '/remote-qqbot/api/config.get')
  req.headers['sec-fetch-site'] = 'cross-site'
  const res = makeRes()
  await handler(req, res)
  assert.equal(res.status, 403)
})

// ── [C2] 安全护栏：三个「决定数据去哪 / 装哪份代码」的键，不许从这个无认证面写 ──
//
// 2026-10-07 安全审查的结论：`isTrustedApiRequest` 只挡浏览器跨站与 DNS-rebinding，
// **不是身份认证** —— 任何能连 127.0.0.1:19387 的本机进程、或页面里的同源脚本，
// 都能带一个合法的 Host 打进来。于是三个键必须「只能手改配置文件」：
//   cloudUrl（正文发去哪台服务器）、hubUrl（摘要去哪台）、qqUpdateSource（装哪份代码 ⇒ RCE）。
// 这一组就是那条边界的护栏：**改回去就必须报红**。

console.log('\n[C2] 安全护栏：只能手改配置文件的三个键，网页路由写不动')

await test('★ cloudUrl / hubUrl / qqUpdateSource 被硬拒，且如实回报 rejected', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  const { handler } = bootRoute({
    update: async () => { throw new Error(DESKTOP_REJECTION) },
    file,
    live: { collabEnabled: true },
  })
  const res = await call(handler, 'POST', '/remote-qqbot/api/config.set', {
    patch: {
      cloudUrl: 'https://attacker.example',
      hubUrl: 'https://attacker.example/dsh-hub',
      qqUpdateSource: 'https://attacker.example/update.json',
      collabEnabled: false, // 同一批里的合法键必须照旧生效，别因为有人混进来就整批丢
    },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.applied, ['collabEnabled'], '合法键要照旧写入')
  const rejectedKeys = new Set((res.body.rejected ?? []).map((row) => row.key))
  for (const key of ['cloudUrl', 'hubUrl', 'qqUpdateSource']) {
    assert.ok(rejectedKeys.has(key), `${key} 必须出现在 rejected 里（不能静默丢弃）`)
  }
  // 落盘面：三个键一个都不许进覆盖文件
  const onDisk = existsSync(file) ? readOverrides(file, KEYS).values : {}
  for (const key of ['cloudUrl', 'hubUrl', 'qqUpdateSource']) {
    assert.equal(key in onDisk, false, `${key} 竟然落进了覆盖文件 —— 安全边界被绕过`)
  }
  assert.equal(onDisk.collabEnabled, false, '合法键该存住的还得存住')
})

await test('★ 只发这三个键：一个都不写，也不会产生覆盖文件', async () => {
  const file = join(tempDir(), OVERRIDE_FILE_NAME)
  const { handler } = bootRoute({ update: async () => { throw new Error(DESKTOP_REJECTION) }, file, live: {} })
  const res = await call(handler, 'POST', '/remote-qqbot/api/config.set', {
    patch: { cloudUrl: 'https://attacker.example', hubUrl: 'https://attacker.example', qqUpdateSource: 'npm:evil' },
  })
  assert.deepEqual(res.body.applied, [])
  assert.equal((res.body.rejected ?? []).length, 3)
  assert.equal(existsSync(file), false, '空补丁不该产生覆盖文件')
})

await test('★ 字段表里的三个键必须真的标了 manualOnly（漏标一个 = 边界破一个口）', async () => {
  const { FIELD_SPECS, MANUAL_ONLY_KEYS } = await import('../lib/config-api.js')
  for (const key of ['cloudUrl', 'hubUrl', 'qqUpdateSource']) {
    const spec = FIELD_SPECS.find((row) => row.key === key)
    assert.ok(spec, `FIELD_SPECS 里缺 ${key}`)
    assert.equal(spec.manualOnly, true, `${key} 没标 manualOnly —— 又会变回可写`)
    assert.ok(MANUAL_ONLY_KEYS.has(key), `${key} 不在 MANUAL_ONLY_KEYS 里`)
  }
})

await test('★ 前端也必须只读渲染这些字段（后端拒了、界面还让人改 = 骗用户）', () => {
  const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(client, /readOnly:\s*field\.manualOnly === true/, 'manualOnly 的输入框必须是只读')
  assert.match(client, /只能手改配置文件/, '要让用户知道去哪儿改，而不是给一个改不动的框')
})

await test('★ 保存回执里的 rejected 要显示给用户（被拒了却一声不吭 = 另一种骗）', () => {
  const client = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(client, /result\?\.rejected/, '保存结果里的 rejected 必须被界面消费')
})

// ── [D] 接线护栏 ──────────────────────────────────────────────────────────

console.log('\n[D] 接线：忘了传 persist / 忘了叠加覆盖层，就等于没修')

await test('src/index.js 必须把 persist 传进 mountConfigApi', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(src, /persist:\s*persistUiPatch/, 'mountConfigApi 少传 persist ⇒ 开关又会静默弹回原位')
})

await test('liveConfig 的叠加顺序：覆盖文件必须排在 settings scope 与补丁键**之后**', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  // 这是唯一一处能钉住优先级的地方：liveConfig 在工厂闭包里、对外不导出。
  // 退而求其次守源码：顺序错了 ⇒ 从界面关掉的开关会被 patch 层重新打开。
  const at = src.indexOf('...(fromScope ?? {})')
  const overridesAt = src.indexOf('...overrides,')
  const uiAt = src.indexOf('...uiOverrides }')
  assert.notEqual(at, -1, '找不到 liveConfig 的合并表达式')
  assert.notEqual(overridesAt, -1)
  assert.notEqual(uiAt, -1)
  assert.ok(at < overridesAt, 'overrides 应在 fromScope 之后（否则关不掉）')
  assert.ok(overridesAt < uiAt, 'uiOverrides 应是最后一层（界面改动优先级最高）')
})

await test('覆盖文件的读取必须发生在插件启动时（否则界面显示的还是旧值）', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(src, /readOverrides\(overrideFile,\s*configKeys\)/)
  assert.match(src, /remote-qqbot-overrides\.json|overrideFilePath\(dshHomeDir\(\)\)/)
})

await test('config-api 里 persist 生效时向外报 via，便于事后排障', () => {
  const src = readFileSync(new URL('../src/config-api.js', import.meta.url), 'utf8')
  assert.match(src, /via/)
  assert.match(src, /typeof persist === 'function'/)
})

// ── 收尾 ───────────────────────────────────────────────────────────────────

for (const dir of roots) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 项通过 / ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
