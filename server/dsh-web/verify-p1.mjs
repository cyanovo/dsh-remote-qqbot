/**
 * P1 验收：把 server.mjs **真的跑起来**（进程内 import，真 listen），再用**真 HTTP** 打它。
 *
 * 为什么不用假函数/不 mock：这一轮改的全是「鉴权边界 / 配额 / 保留期」这类
 * **只有真跑才会暴露问题** 的东西（TDZ、cookie 传递、JSON 落盘、prune 时机）。
 *
 * ⚠️ 两处刻意的取舍，都写在这里而不是藏起来：
 *   1. 保留期用环境变量调短（2s / 5s），否则要等 5 小时才能验一条记录过期。
 *      —— 验的是**机制**；**默认值**另有一组断言直接读 `/api/meta`（1000 次/天、30 天、2.99 元、5h/48h）。
 *   2. 数据目录是临时目录，跑完即删，绝不碰线上 `data.json`。
 *
 * 用法：node verify-p1.mjs        （退出码 0 = 全绿）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-p1-'))
const DATA = path.join(TMP, 'data')
const PORT = 18795
const BASE = `http://127.0.0.1:${PORT}`
const FREE_TTL = 2000
const PRO_TTL = 5000

process.env.DSH_WEB_DATA = DATA
process.env.DSH_WEB_PORT = String(PORT)
process.env.DSH_WEB_HOST = '127.0.0.1'
process.env.DSH_WEB_ROOT = path.join(HERE, 'public')
process.env.DSH_WEB_RETENTION_MS = String(FREE_TTL)
process.env.DSH_WEB_PRO_RETENTION_MS = String(PRO_TTL)

let pass = 0
let fail = 0
const reds = []
async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail++
    reds.push(`${name} —— ${err && err.message}`)
    console.log(`  ✗ ${name}\n      ${err && err.message}`)
  }
}
function eq(got, want, what = '') {
  if (got !== want) throw new Error(`${what} 期望 ${JSON.stringify(want)}，实测 ${JSON.stringify(got)}`)
}
function ok(v, what = '') {
  if (!v) throw new Error(`${what} 期望为真，实测 ${JSON.stringify(v)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 极简 cookie jar：只记会话 cookie，够用且看得见 */
function client() {
  let cookie = ''
  return async (p, { method = 'GET', body, headers = {}, raw } = {}) => {
    const h = { ...headers }
    if (cookie) h.cookie = cookie
    let payload = raw
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(`${BASE}${p}`, { method, headers: h, body: payload })
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : []
    for (const c of sc) {
      const kv = c.split(';')[0]
      if (kv.startsWith('dsw_session=')) cookie = kv.endsWith('=') ? '' : kv
    }
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 120) } }
    return { status: res.status, data }
  }
}

// ── 启动服务（进程内 import；不 spawn 子进程，避开 Windows 下管道 stdout 的 EPERM）──
// 反向校验用：`P1_SERVER` 可指向任意一份 server.mjs（默认本地这份）。
// 拿"回退了新语义"的副本跑同一套断言应当**报红** —— 这才证明这些断言不是空断言。
const SERVER = process.env.P1_SERVER ? path.resolve(process.env.P1_SERVER) : path.join(HERE, 'server.mjs')
// ⚠️ 先**预置一个「proUntil 已过期」的老账号**：这是唯一能如实测出
//    「到期后自动掉回免费档」的办法 —— 服务把 db 放在内存里，改 data.json 骗不了它。
{
  const { scryptSync, randomBytes } = await import('node:crypto')
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync('dave1234', salt, 32).toString('hex')
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(path.join(DATA, 'data.json'), JSON.stringify({
    version: 2,
    users: {
      dave: {
        salt, hash, createdAt: Date.now() - 90 * 86400000,
        upgraded: true,                 // 老字段：说好是"永久"
        proUntil: Date.now() - 1000,    // 但明确写了到期时刻，且已经过去
        tokens: {}, mode: 'note-link', usage: {},
      },
    },
    records: [], codes: {}, devices: {},
  }), { mode: 0o600 })
}
await import(pathToFileURL(SERVER).href)
console.log(`被验的服务文件：${SERVER}`)
let up = false
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${BASE}/health`); if (r.ok) { up = true; break } } catch { /* 还没起来 */ }
  await sleep(100)
}
if (!up) {
  console.log('✗ 服务没起来（端口被占或启动报错）')
  process.exit(1)
}
console.log(`\n服务已就绪 ${BASE}（数据目录 ${DATA}）\n`)

const anon = client()
const alice = client()
const bob = client()
const carol = client()

// ── 一、档位与默认值 ─────────────────────────────────────────────────────────
// ⚠️ 本进程把 TTL 调短了（见文件头），所以这里断言的是**调短后的生效值** ——
//    它同时证明「环境变量真的能改保留期」。
//    **生产默认值（5h / 48h / 100 / 1000 / 30 天 / 2.99 元）另有一份 verify-p1-defaults.mjs 专门核对。**
console.log('── 一、档位与生效值 ──')
const meta = (await anon('/api/meta')).data
await t('免费档：每天 100 次；保留期跟随环境变量（本进程 = 2 秒）', () => {
  eq(meta.plans.free.daily, 100, '免费次数')
  eq(meta.plans.free.retentionMs, FREE_TTL, '免费保留期')
  eq(meta.plans.free.retentionText, '2 秒', '免费保留文案')
})
await t('支持者档：每天 1000 次、30 天、2.99 元；保留期跟随环境变量（本进程 = 5 秒）', () => {
  eq(meta.plans.pro.daily, 1000, '支持者次数')
  eq(meta.plans.pro.retentionMs, PRO_TTL, '支持者保留期')
  eq(meta.plans.pro.retentionText, '5 秒', '支持者保留文案')
  eq(meta.plans.pro.days, 30, '天数')
  eq(meta.plans.pro.priceCny, '2.99', '价格')
})
await t('三档全文模式仍在（P0 的东西没被这轮改坏）', () => {
  eq(meta.modes.length, 3, '模式数')
  eq(meta.modes[0].id, 'chat', '第一档')
  eq(meta.modes[2].id, 'note-link', '第三档')
})

// ── 二、账号与免费档 ─────────────────────────────────────────────────────────
console.log('\n── 二、账号 ──')
await t('注册 alice → free 档、100 次、无到期时间', async () => {
  const r = await alice('/api/register', { method: 'POST', body: { username: 'alice', password: 'alice123' } })
  eq(r.status, 200, 'HTTP')
  eq(r.data.me.plan, 'free', '档位')
  eq(r.data.me.quota.limit, 100, '额度')
  eq(r.data.me.quota.remaining, 100, '剩余')
  eq(r.data.me.proUntil, null, '到期时间')
})
await t('注册 bob / carol', async () => {
  eq((await bob('/api/register', { method: 'POST', body: { username: 'bob', password: 'bob12345' } })).status, 200, 'bob')
  eq((await carol('/api/register', { method: 'POST', body: { username: 'carol', password: 'carol123' } })).status, 200, 'carol')
})
await t('重名注册被拒（409）', async () => {
  eq((await anon('/api/register', { method: 'POST', body: { username: 'alice', password: 'whatever1' } })).status, 409, 'HTTP')
})
await t('★★ 到期就是到期：proUntil 已过去的老账号自动掉回免费档', async () => {
  const dave = client()
  const r = await dave('/api/login', { method: 'POST', body: { username: 'dave', password: 'dave1234' } })
  eq(r.status, 200, '登录 HTTP')
  eq(r.data.me.plan, 'free', '过期后必须是 free')
  eq(r.data.me.quota.limit, 100, '额度要回到 100')
  eq(r.data.me.upgraded, false, '向后兼容字段也要是 false')
  eq(r.data.me.quota.retentionText, '2 秒', '保留期按免费档（本轮 TTL 调短过）')
})

// ── 三、设备码绑定 ───────────────────────────────────────────────────────────
console.log('\n── 三、设备码绑定（插件不经浏览器拿令牌）──')
const start = (await anon('/api/device/start', { method: 'POST', body: {} })).data
await t('start 返回 8 位短码 + 长设备码 + 轮询间隔', () => {
  ok(start.ok, 'ok')
  eq(start.userCode.replace('-', '').length, 8, '短码长度')
  ok(start.deviceCode.length >= 32, '长码长度')
  eq(start.interval, 3, '轮询间隔（秒）')
})
await t('★ 只有短码时 poll 拿不到令牌（还没人批准）', async () => {
  const r = await anon('/api/device/poll', { method: 'POST', body: { deviceCode: start.deviceCode } })
  eq(r.data.status, 'pending', '状态')
  eq(r.data.token, undefined, '绝不能给 token')
})
await t('★ 未登录不能批准（短码本身换不出权限）', async () => {
  eq((await anon('/api/device/approve', { method: 'POST', body: { userCode: start.userCode } })).status, 401, 'HTTP')
})
await t('乱填短码 → 404', async () => {
  eq((await alice('/api/device/approve', { method: 'POST', body: { userCode: 'ZZZZ-ZZZZ' } })).status, 404, 'HTTP')
})
await t('登录后批准 → 状态变 approved', async () => {
  const r = await alice('/api/device/approve', { method: 'POST', body: { userCode: start.userCode.toLowerCase() } })
  eq(r.status, 200, 'HTTP')
  ok(r.data.ok, 'ok')
})
let deviceToken = ''
await t('poll 拿到令牌 + 归属正确', async () => {
  const r = await anon('/api/device/poll', { method: 'POST', body: { deviceCode: start.deviceCode } })
  eq(r.data.status, 'approved', '状态')
  eq(r.data.username, 'alice', '归属')
  ok(String(r.data.token).length >= 32, '令牌长度')
  deviceToken = r.data.token
})
await t('★ 令牌只交付一次（重放同一个 deviceCode 拿不到第二份）', async () => {
  const r = await anon('/api/device/poll', { method: 'POST', body: { deviceCode: start.deviceCode } })
  eq(r.data.status, 'used', '状态')
  eq(r.data.token, undefined, '不能再给 token')
})
await t('★ 该令牌真能发布，且记录归 alice', async () => {
  const r = await anon('/api/publish', {
    method: 'POST', headers: { authorization: `Bearer ${deviceToken}` },
    body: { text: 'alice 通过设备码令牌发布的记录', title: '设备码记录', mode: 'note' },
  })
  eq(r.status, 200, 'HTTP')
  eq(r.data.plan, 'free', '按免费档')
  const list = await alice('/api/records')
  ok(list.data.items.some((i) => i.id === r.data.id), 'alice 能看见自己的记录')
})
await t('★ 库里存的是哈希：data.json 里找不到令牌明文', () => {
  const raw = fs.readFileSync(path.join(DATA, 'data.json'), 'utf8')
  ok(!raw.includes(deviceToken), 'data.json 不该含令牌明文')
  ok(raw.includes('"tokens"'), '应当有 tokens 表')
})

// ── 四、隔离与冒充 ───────────────────────────────────────────────────────────
console.log('\n── 四、多租户隔离 ──')
let bobToken = ''
await t('bob 自己建一个令牌并发布', async () => {
  const tk = await bob('/api/tokens', { method: 'POST', body: { label: 'bob-manual' } })
  eq(tk.status, 200, 'HTTP')
  bobToken = tk.data.token
  const r = await anon('/api/publish', {
    method: 'POST', headers: { authorization: `Bearer ${bobToken}` },
    body: { text: 'bob 的私有记录', title: 'bob', mode: 'note' },
  })
  eq(r.status, 200, 'HTTP')
})
await t('★ alice 看不到 bob 的记录，bob 也看不到 alice 的', async () => {
  const a = (await alice('/api/records')).data.items.map((i) => i.title)
  const b = (await bob('/api/records')).data.items.map((i) => i.title)
  ok(!a.includes('bob'), `alice 不该看到 bob：${JSON.stringify(a)}`)
  ok(!b.includes('设备码记录'), `bob 不该看到 alice：${JSON.stringify(b)}`)
})
await t('★★ 用 alice 的令牌冒名给 bob 发记录 → 403（不是"忽略"，是明确拒绝）', async () => {
  const before = (await bob('/api/records')).data.items.length
  const r = await anon('/api/publish', {
    method: 'POST', headers: { authorization: `Bearer ${deviceToken}` },
    body: { username: 'bob', text: '冒充写入', title: '冒充' },
  })
  eq(r.status, 403, 'HTTP')
  const after = (await bob('/api/records')).data.items.length
  eq(after, before, 'bob 的记录数不该变')
})
await t('伪造令牌 → 401，且错误文案教人怎么填对', async () => {
  // ⚠️ 第一版这里写的是中文令牌，结果 fetch 直接抛
  //    「Cannot convert argument to a ByteString」—— HTTP 头只能是 ASCII。测的是鉴权，别让编码问题冒充它。
  const r = await anon('/api/publish', {
    method: 'POST', headers: { authorization: 'Bearer forged-token-not-in-db' },
    body: { text: 'x' },
  })
  eq(r.status, 401, 'HTTP')
  ok(String(r.data.error).includes('不属于任何账号'), `文案要说清原因：${r.data.error}`)
})
await t('★ 连 Authorization 都忘了 → 401，并提示正确格式', async () => {
  const r = await anon('/api/publish', { method: 'POST', body: { text: 'x' } })
  eq(r.status, 401, 'HTTP')
  ok(String(r.data.error).includes('Bearer'), `文案要给出正确格式：${r.data.error}`)
})
await t('吊销令牌后立刻失效，且只能吊销自己的', async () => {
  const list = (await bob('/api/tokens')).data.items
  eq(list.length, 1, 'bob 令牌数')
  const r = await bob('/api/tokens/revoke', { method: 'POST', body: { id: list[0].id } })
  eq(r.status, 200, '吊销 HTTP')
  const after = await anon('/api/publish', {
    method: 'POST', headers: { authorization: `Bearer ${bobToken}` }, body: { text: 'y' },
  })
  eq(after.status, 401, '吊销后必须 401')
  const cross = await bob('/api/tokens/revoke', { method: 'POST', body: { id: list[0].id } })
  eq(cross.status, 404, '已吊销的再吊销 → 404')
})

// ── 五、配额 ─────────────────────────────────────────────────────────────────
console.log('\n── 五、配额（carol 真用满 100 次）──')
await t('发一条记录，然后用 carol 连看 100 次', async () => {
  const tk = await carol('/api/tokens', { method: 'POST', body: { label: 'quota' } })
  // 🔴 第一版这里漏了 `Bearer ` 前缀 ⇒ 服务端按"没带令牌"处理，401。
  const pub = await anon('/api/publish', {
    method: 'POST', headers: { authorization: `Bearer ${tk.data.token}` },
    body: { text: 'carol 的记录', title: 'carol', mode: 'note' },
  })
  eq(pub.status, 200, '发布 HTTP')
  const id = pub.data.id
  let last = null
  for (let i = 0; i < 100; i++) {
    const r = await carol(`/api/records/${id}/view`, { method: 'POST', body: {} })
    if (r.status !== 200) throw new Error(`第 ${i + 1} 次查看就失败了：HTTP ${r.status} ${JSON.stringify(r.data)}`)
    last = r.data
  }
  eq(last.quota.used, 100, '已用次数')
  eq(last.quota.remaining, 0, '剩余')
})
await t('★ 第 101 次 → 429，并给出中文原因与配额对象', async () => {
  const id = (await carol('/api/records')).data.items[0].id
  const r = await carol(`/api/records/${id}/view`, { method: 'POST', body: {} })
  eq(r.status, 429, 'HTTP')
  ok(String(r.data.error).includes('100'), `错误文案要提次数：${r.data.error}`)
  eq(r.data.quota.remaining, 0, '配额对象')
})

// ── 六、兑换码：叠加而不是覆盖 ───────────────────────────────────────────────
console.log('\n── 六、兑换码（30 天，且能叠加）──')
await t('未登录不能兑换', async () => {
  eq((await anon('/api/redeem', { method: 'POST', body: { code: 'DSH-AAAA-BBBB' } })).status, 401, 'HTTP')
})
let code1 = ''
let code2 = ''
await t('管理员生成 2 个码', async () => {
  const token = fs.readFileSync(path.join(DATA, 'publish-token'), 'utf8').trim()
  const r = await anon('/api/codes', { method: 'POST', headers: { 'x-publish-token': token }, body: { count: 2 } })
  eq(r.status, 200, 'HTTP')
  eq(r.data.days, 30, '天数')
  code1 = r.data.codes[0]
  code2 = r.data.codes[1]
})
await t('不是管理员就生成不了码', async () => {
  eq((await anon('/api/codes', { method: 'POST', body: { count: 1 } })).status, 401, 'HTTP')
})
await t('★ carol 兑换 1 个码 → pro 档：1000 次/天（保留期跟随环境变量 = 5 秒）', async () => {
  const usedBefore = (await carol('/api/me')).data.me.quota.used
  const r = await carol('/api/redeem', { method: 'POST', body: { code: code1 } })
  eq(r.status, 200, 'HTTP')
  eq(r.data.me.plan, 'pro', '档位')
  eq(r.data.me.quota.limit, 1000, '额度')
  // 诚实写清：升级**不清零**当天已用次数（前面已经用了 100 次）
  eq(r.data.me.quota.used, usedBefore, '已用次数不该被升级清掉')
  eq(r.data.me.quota.remaining, 1000 - usedBefore, '剩余 = 新额度 − 已用')
  eq(r.data.me.quota.retentionText, '5 秒', '保留期按支持者档（本轮 TTL 调短过）')
  eq(r.data.me.upgraded, true, '向后兼容字段')
  const days = (r.data.me.proUntil - Date.now()) / 86400000
  ok(days > 29.9 && days < 30.1, `到期时间应≈30 天后，实测 ${days.toFixed(3)} 天`)
})
let firstUntil = 0
await t('★★ 再兑换一个码 → 日期**叠加**（不是重置成 30 天）', async () => {
  const before = (await carol('/api/me')).data.me.proUntil
  firstUntil = before
  const r = await carol('/api/redeem', { method: 'POST', body: { code: code2 } })
  eq(r.status, 200, 'HTTP')
  const after = r.data.me.proUntil
  const delta = (after - before) / 86400000
  ok(delta > 29.9 && delta < 30.1, `应再 +30 天，实测 +${delta.toFixed(3)} 天`)
  eq(r.data.stacked, true, '应标记为叠加')
})
await t('同一个码换别人 → 409（一次性）', async () => {
  eq((await bob('/api/redeem', { method: 'POST', body: { code: code1 } })).status, 409, 'HTTP')
})
await t('不存在的码 → 404', async () => {
  eq((await bob('/api/redeem', { method: 'POST', body: { code: 'DSH-XXXX-YYYY' } })).status, 404, 'HTTP')
})
// ── 七、保留期：免费 1.5s / 支持者 4s（机制验证，生产默认值见第一节）─────────
console.log('\n── 七、保留期（TTL 已调短，验机制）──')
let freeRec = ''
let proRec = ''
await t('alice（免费档）发一条 → 按 2 秒算', async () => {
  const a = await anon('/api/publish', {
    method: 'POST', headers: { authorization: `Bearer ${deviceToken}` },
    body: { text: '免费档的记录', title: 'free-ttl', mode: 'note' },
  })
  eq(a.status, 200, 'HTTP')
  eq(a.data.plan, 'free', '档位')
  eq(a.data.retentionText, '2 秒', '保留文案')
  freeRec = a.data.id
})
await t('carol（支持者档）发一条 → 按 5 秒算', async () => {
  const tk = (await carol('/api/tokens', { method: 'POST', body: { label: 'ttl' } })).data.token
  const c = await anon('/api/publish', {
    method: 'POST', headers: { authorization: `Bearer ${tk}` },
    body: { text: '支持者档的记录', title: 'pro-ttl', mode: 'note' },
  })
  eq(c.status, 200, 'HTTP')
  eq(c.data.plan, 'pro', '档位')
  eq(c.data.retentionText, '5 秒', '保留文案')
  proRec = c.data.id
})
await t('★★ 支持者档**也计数**（不是"不限次数"）', async () => {
  // 🔴 这条是补上的：第一版反向校验里我把「支持者不计数」回退掉，结果**没有一条断言变红** ——
  //    说明"1000 次/天"当时只有 /api/meta 的文案撑着，没人验它真的会数、真的会用完。
  const before = (await carol('/api/me')).data.me.quota
  eq(before.limit, 1000, '额度应是 1000')
  const id = (await carol('/api/records')).data.items[0].id
  const r = await carol(`/api/records/${id}/view`, { method: 'POST', body: {} })
  eq(r.status, 200, '查看 HTTP')
  eq(r.data.quota.used, before.used + 1, '支持者看一次也要 +1')
  eq(r.data.quota.remaining, before.remaining - 1, '剩余要 -1（不是永远 1000）')
})
await t('★ 等 2.2 秒：免费记录已消失', async () => {
  await sleep(2200)
  const items = (await alice('/api/records')).data.items.map((i) => i.id)
  ok(!items.includes(freeRec), `免费记录应已过期，实测还在：${JSON.stringify(items)}`)
})
await t('★ 同一时刻：支持者记录仍在（两档真的不一样）', async () => {
  const items = (await carol('/api/records')).data.items
  ok(items.some((i) => i.id === proRec), `支持者记录不该这么早过期：${JSON.stringify(items.map((i) => i.id))}`)
  eq(items.find((i) => i.id === proRec).retentionText, '5 秒', '每条记录带着自己的保留期')
})
await t('★ 再等 3.2 秒：支持者记录也到期了', async () => {
  await sleep(3200)
  const items = (await carol('/api/records')).data.items.map((i) => i.id)
  ok(!items.includes(proRec), `支持者记录也该过期了：${JSON.stringify(items)}`)
})
await t('磁盘上也不留尸体（过期即从 data.json 删掉，不是只从列表里过滤）', () => {
  const db = JSON.parse(fs.readFileSync(path.join(DATA, 'data.json'), 'utf8'))
  ok(!db.records.some((r) => r.id === freeRec || r.id === proRec), 'data.json 里不该还有这两条')
})

// ── 八、限流 ─────────────────────────────────────────────────────────────────
console.log('\n── 八、device 接口每 IP 限流 ──')
await t('★ 一分钟内第 11 次 start → 429', async () => {
  let blocked = 0
  let lastMsg = ''
  for (let i = 0; i < 12; i++) {
    const r = await anon('/api/device/start', { method: 'POST', body: {} })
    if (r.status === 429) { blocked++; lastMsg = String(r.data.error || '') }
  }
  ok(blocked >= 1, '应当出现 429')
  ok(lastMsg.includes('频繁'), `文案要说人话：${lastMsg}`)
})

// ── 九、一键删除 ─────────────────────────────────────────────────────────────
console.log('\n── 九、删除我的数据 ──')
await t('未登录不能删', async () => {
  eq((await anon('/api/me/purge', { method: 'POST', body: { scope: 'records' } })).status, 401, 'HTTP')
})
await t('alice 删掉自己的记录 → 自己的没了', async () => {
  const before = (await alice('/api/records')).data.items.length
  const r = await alice('/api/me/purge', { method: 'POST', body: { scope: 'records' } })
  eq(r.status, 200, 'HTTP')
  eq(r.data.recordsDeleted, before, '删除条数应等于删前条数')
  eq((await alice('/api/records')).data.items.length, 0, '删后应为 0')
})
await t('注销账号：密码不对 → 401，但记录已删；密码对了 → 账号消失', async () => {
  const bad = await alice('/api/me/purge', { method: 'POST', body: { scope: 'all', password: '错的密码' } })
  eq(bad.status, 401, '密码不对')
  const good = await alice('/api/me/purge', { method: 'POST', body: { scope: 'all', password: 'alice123' } })
  eq(good.status, 200, '注销 HTTP')
  eq(good.data.deletedAccount, true, 'deletedAccount')
  const relogin = await anon('/api/login', { method: 'POST', body: { username: 'alice', password: 'alice123' } })
  eq(relogin.status, 401, '注销后不能登录')
})
await t('bob 的数据不受影响（删的是自己那份）', async () => {
  const r = await bob('/api/me')
  eq(r.status, 200, 'HTTP')
  eq(r.data.me.username, 'bob', '还是 bob')
})

// ── 收尾 ─────────────────────────────────────────────────────────────────────
console.log(`\nP1 验收结果：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('\n红项：')
  for (const r of reds) console.log(`  - ${r}`)
}
console.log(`（临时数据目录：${TMP}）`)
process.exit(fail ? 1 : 0)
