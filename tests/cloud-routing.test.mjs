/**
 * **云端路由**测试：用 mock ctx 驱动真实的 `lib/index.js`，看一轮结束之后
 * 正文到底被 POST 去了哪个服务器。
 *
 * 为什么必须有这一层：`tests/cloud.test.mjs` 只证明"cloud.js 会按我说的样子发请求"，
 * `tests/cloud-integration.test.mjs` 只证明"cloud.js 与真服务器对得上"。
 * 但**插件到底会不会用它**、什么时候用、云端失败时会不会改发中枢 ——
 * 这三件事都在 index.js 的路由里，只有把插件真跑起来才看得到。
 *
 * 要钉死的三条：
 *   1. 配了云端就走云端（只发云端，不发中枢）；
 *   2. 云端失败**绝不**改发中枢（可见性不同，那等于偷偷转发）；
 *   3. `cloudEnabled=false` 时两边都不发（隐私默认值）。
 *
 * 用法：node tests/cloud-routing.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 整组测试跑在空的 DSH_HOME 上（同 plugin.test.mjs：覆盖文件优先级最高，
// 这台机器上真实存在的覆盖文件会把 mock 的 settings 压掉）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'notify-cloud-routing-'))
process.on('exit', () => { try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* 忽略 */ } })

const MOD = await import('../lib/index.js')

let pass = 0
let fail = 0
const test = async (name, fn) => {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail++
    console.log(`  ✗ ${name}\n      ${err?.message ?? err}`)
  }
}

/** 最小 mock ctx（与 tests/plugin.test.mjs 同一套语义，只留这里要用的部分）。 */
function makeCtx({ settings = {} } = {}) {
  const listeners = new Map()
  const logs = []
  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    get(service) {
      if (service === 'settings') {
        const regs = new Map()
        return {
          register(ns, schema, options) {
            const resolved = Object.freeze(schema({ ...(options?.base ?? {}), ...settings }))
            regs.set(ns, resolved)
            return {
              get: () => resolved,
              watch: () => () => {},
              update: async () => {},
              replace: async () => {},
            }
          },
          get: (ns) => regs.get(ns),
          describe: () => [],
        }
      }
      return undefined
    },
    inject(names, cb) { if (names.includes('settings')) cb(ctx); return () => {} },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    tools: { register: () => () => {} },
  }
  return {
    ctx,
    logs,
    emit(event, ...args) { for (const h of listeners.get(event) ?? []) h(...args) },
    makeAgent(id) {
      return {
        id,
        ctx: { effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } } },
        session: {
          header: { id: `sess-${id}`, cwd: 'D:\\cyanproject\\agenttool' },
          events: [
            { type: 'user/message', seq: 1, data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把协作模式写进插件了' }] } },
            { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', source: { kind: 'model', provider: 'bq', model: 'x' }, content: [{ type: 'text', text: ASSISTANT }] } } },
          ],
        },
        status: 'idle',
      }
    },
  }
}

const ASSISTANT = '这是完整回答的正文。\n第二行：包含中文与 ✅ emoji，长度足够触发上传。'

/** 一个"什么都能回"的假服务器，按 URL 记录并回不同的载荷。 */
function installFetch(script = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined })
    const responder = Object.entries(script).find(([frag]) => u.includes(frag))?.[1]
    const r = (typeof responder === 'function' ? responder(u, init) : responder) ?? { status: 200, data: { ok: true } }
    if (r === 'network-error') throw new Error('socket hang up')
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      json: async () => r.data,
      text: async () => JSON.stringify(r.data ?? {}),
    }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/**
 * 捕获插件打到控制台的日志。
 *
 * 为什么不能靠 mock ctx 收集：插件的 `log()` 是**直接写 console** 的（mock ctx 里没有
 * log 服务），所以想断言"日志里说清了原因"就只能拦 console —— 拦的是真实输出路径，
 * 比在夹具里假装一个 logs 数组更接近线上。
 */
async function captureLogs(fn) {
  const original = console.log
  const lines = []
  console.log = (...args) => { lines.push(args.map(String).join(' ')) }
  try {
    await fn()
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

const cloud = (over = {}) => ({
  cloudEnabled: true, qqFulltextMode: 'note-link', notesEnabled: true,
  cloudUrl: 'http://cloud.test', cloudToken: 'cloud-tok',
  hubUrl: 'https://hub.test', token: 'hub-tok',
  qqEnabled: false, agentmdDir: '', ...over,
})
const CLOUD_HIT = { status: 200, data: { ok: true, id: 'abc123', plan: 'free', retentionText: '5 小时' } }
const listOf = (calls, frag) => calls.filter((c) => c.url.includes(frag))
/** 推送请求（与"上传笔记/正文"的请求都打同一个中枢，靠 kind 区分）。 */
const pushesOf = (calls) => calls.filter((c) => c.body && c.body.kind === 'turn-complete')

console.log('云端路由（mock ctx 驱动 lib/index.js）\n')

await test('★ 配了云端 + note-link：正文只发云端，一个字节都不发中枢', async () => {
  const f = installFetch({ 'cloud.test/api/publish': CLOUD_HIT })
  try {
    const h = makeCtx({ settings: cloud() })
    MOD.apply(h.ctx, {})
    const agent = h.makeAgent('a1')
    h.emit('agent/status', { agent, status: 'running' })
    h.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 250))

    const pub = listOf(f.calls, 'cloud.test/api/publish')
    assert.equal(pub.length, 1, `应当只发一次云端上传，实际 ${pub.length}`)
    assert.equal(pub[0].method, 'POST')
    assert.equal(pub[0].headers.Authorization, 'Bearer cloud-tok')
    assert.match(pub[0].body.text, /完整回答的正文/)
    assert.equal('username' in pub[0].body, false, '不能带 username（那是冒名口子）')
    assert.equal(listOf(f.calls, '/api/notes').length, 0, '🔴 配了云端就不该再发中枢笔记')
  } finally { f.restore() }
})

await test('★ 云端的链接出现在推送文案里（note-link 档要能点开）', async () => {
  const f = installFetch({ 'cloud.test/api/publish': CLOUD_HIT })
  try {
    const h = makeCtx({ settings: cloud() })
    MOD.apply(h.ctx, {})
    const agent = h.makeAgent('a1')
    h.emit('agent/status', { agent, status: 'running' })
    h.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 250))
    const pushes = pushesOf(f.calls)
    assert.equal(pushes.length, 1, `应当推一条到中枢，实际 ${pushes.length}`)
    const summary = String(pushes[0].body.summary ?? '')
    // ⚠️ 域名是**大写**的：这是 P0 刻意的处理（QQ 的 markdown 链接里把域名大写，
    //    免得被当成可折叠预览卡片）。所以这里只断言形态，不写死大小写。
    assert.match(summary, /\[查看完整回答\]\(http:\/\/CLOUD\.TEST\/n\/abc123\)/i, summary)
    assert.match(summary, /\/n\/abc123\)$/, '链接的路径必须是 /n/<id>（点开就是那条记录）')
  } finally { f.restore() }
})

await test('★ 云端失败（401）：**不**改发中枢，推送照发但没有链接', async () => {
  const f = installFetch({
    'cloud.test/api/publish': { status: 401, data: { ok: false, error: '发布令牌不对（可能已被吊销）' } },
    'hub.test/api/notes': { status: 200, data: { ok: true, id: 'zzz', url: 'https://hub.test/dsh/zzz.md' } },
  })
  try {
    const h = makeCtx({ settings: cloud() })
    let said = ''
    await captureLogs(async () => {
      MOD.apply(h.ctx, {})
      const agent = h.makeAgent('a1')
      h.emit('agent/status', { agent, status: 'running' })
      h.emit('agent/status', { agent, status: 'idle' })
      await new Promise((r) => setTimeout(r, 250))
    })
    said = h.logs.join('\n')
    assert.equal(listOf(f.calls, '/api/notes').length, 0,
      '🔴 云端失败绝不能悄悄改发中枢 —— 两边的可见性完全不同（云端要登录，中枢是公开 markdown）')
    const pushes = pushesOf(f.calls)
    assert.equal(pushes.length, 1, '通知不能因为上传失败就丢')
    assert.ok(!/查看完整回答/.test(String(pushes[0].body.summary ?? '')), '没链接就不该在文案里留链接')
  } finally { f.restore() }
})

await test('★ 云端失败时日志说清了原因（不是静默少一个链接）', async () => {
  const f = installFetch({ 'cloud.test/api/publish': { status: 401, data: { ok: false, error: '发布令牌不对（可能已被吊销）' } } })
  try {
    const h = makeCtx({ settings: cloud() })
    const lines = []
    const original = console.log
    console.log = (...args) => { lines.push(args.map(String).join(' ')) }
    try {
      MOD.apply(h.ctx, {})
      const agent = h.makeAgent('a1')
      h.emit('agent/status', { agent, status: 'running' })
      h.emit('agent/status', { agent, status: 'idle' })
      await new Promise((r) => setTimeout(r, 250))
    } finally { console.log = original }
    const said = lines.join('\n')
    assert.match(said, /云端没存上/, `日志里要有"云端没存上"，实际：\n${said}`)
    assert.match(said, /发布令牌不对/, '要把服务端的原因带出来（否则用户只知道"没链接"）')
  } finally { f.restore() }
})

await test('★ 只配了中枢（没配云端）：仍走中枢（老行为不回归）', async () => {
  const f = installFetch({ 'hub.test/api/notes': { status: 200, data: { ok: true, id: 'zzz', url: 'https://hub.test/dsh/zzz.md' } } })
  try {
    const h = makeCtx({ settings: cloud({ cloudUrl: '', cloudToken: '' }) })
    MOD.apply(h.ctx, {})
    const agent = h.makeAgent('a1')
    h.emit('agent/status', { agent, status: 'running' })
    h.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(listOf(f.calls, '/api/notes').length, 1, '应当发一次中枢笔记')
    const pushes = pushesOf(f.calls)
    // ⚠️ 进 QQ 的链接会被 qqPreviewUrl 改写成「http://大写域名/路径」（不带端口）——
    //    这是 P0 实测过的形式，所以这里只断言"域名大写 + 路径一字不动"。
    assert.match(String(pushes[0].body.summary ?? ''), /\[查看完整回答\]\(http:\/\/HUB\.TEST\/dsh\/zzz\.md\)/,
      String(pushes[0].body.summary ?? ''))
  } finally { f.restore() }
})

await test('★★ 云上传总闸关着：云端与中枢都不发（隐私默认值）', async () => {
  const f = installFetch({ 'cloud.test/api/publish': CLOUD_HIT, 'hub.test/api/notes': { status: 200, data: { ok: true, id: 'z', url: 'u' } } })
  try {
    const h = makeCtx({ settings: cloud({ cloudEnabled: false }) })
    const lines = []
    const original = console.log
    console.log = (...args) => { lines.push(args.map(String).join(' ')) }
    try {
      MOD.apply(h.ctx, {})
      const agent = h.makeAgent('a1')
      h.emit('agent/status', { agent, status: 'running' })
      h.emit('agent/status', { agent, status: 'idle' })
      await new Promise((r) => setTimeout(r, 250))
    } finally { console.log = original }
    assert.equal(listOf(f.calls, '/api/publish').length + listOf(f.calls, '/api/notes').length, 0,
      '总闸关着时不该有任何正文上传')
    assert.equal(pushesOf(f.calls).length, 1, '通知还是要发的（只是没有正文上传）')
    assert.match(lines.join('\n'), /云上传总闸关着/, '必须在日志里说清"这次按直接发 QQ 处理"')
  } finally { f.restore() }
})

await test('★ 有云端令牌但云端地址不合法（ftp://）→ 当作没配，走中枢', async () => {
  const f = installFetch({ 'hub.test/api/notes': { status: 200, data: { ok: true, id: 'z', url: 'https://hub.test/dsh/z.md' } } })
  try {
    const h = makeCtx({ settings: cloud({ cloudUrl: 'ftp://bad.example', cloudToken: 'x' }) })
    MOD.apply(h.ctx, {})
    const agent = h.makeAgent('a1')
    h.emit('agent/status', { agent, status: 'running' })
    h.emit('agent/status', { agent, status: 'idle' })
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(listOf(f.calls, '/api/notes').length, 1, '非法地址要退化成"没配云端"，而不是发出去炸掉')
  } finally { f.restore() }
})

console.log(`\n云端路由：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
