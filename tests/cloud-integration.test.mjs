/**
 * 端到端：**真实的 src/cloud.js** 对 **真实的 dsh-web/server.mjs**（进程内起服务 + 真 HTTP）。
 *
 * 为什么非要这么跑：单测里的假 fetch 只能证明"我发出去的请求是我以为的样子"，
 * 证明不了"对面认这个请求"。两边各自的字段名（text/title/mode、deviceCode、Bearer…）
 * 只要有一处对不上，线上表现就是"上传失败"或"绑定不上"，而两边各自的测试都是绿的。
 *
 * 覆盖链路：注册 → cloud.js 申请设备码 → 登录后确认 → cloud.js 轮询拿到令牌
 *          → cloud.js 上传正文 → 网页端打开这条记录（次数 +1）→ cloud.js 查配额。
 *
 * 用法：node tests/cloud-integration.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cloudDevicePoll, cloudDeviceStart, cloudMe, cloudPublishNote, describeAccount } from '../src/cloud.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', '..', 'dsh-web', 'server.mjs')
if (!fs.existsSync(SERVER)) {
  console.log(`⚠️ 工作区里没有 dsh-web/server.mjs（${SERVER}）—— 端到端测试跳过`)
  process.exit(0)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cloud-e2e-'))
const PORT = 18798
const BASE = `http://127.0.0.1:${PORT}`
process.env.DSH_WEB_DATA = path.join(TMP, 'data')
process.env.DSH_WEB_PORT = String(PORT)
process.env.DSH_WEB_HOST = '127.0.0.1'
process.env.DSH_WEB_ROOT = path.join(HERE, '..', '..', 'dsh-web', 'public')
// 保留期调到 10 分钟：本测试验的是"能不能存进去、能不能读出来"，不是 TTL
process.env.DSH_WEB_RETENTION_MS = String(600_000)
process.env.DSH_WEB_PRO_RETENTION_MS = String(600_000)

let pass = 0
let fail = 0
const check = (name, okk, detail = '') => {
  if (okk) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `　${detail}` : ''}`) }
}
const logs = []
const log = (m) => { logs.push(String(m)) }

// 起服务（进程内 import，避开 Windows 沙箱下 spawn+管道 stdio 的 EPERM）
await import(pathToFileURL(SERVER).href)
let up = false
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break } } catch { /* 等 */ }
  await new Promise((r) => setTimeout(r, 100))
}
if (!up) { console.log('✗ 测试用的 dsh-web 起不来'); process.exit(1) }

/** 带 cookie 的浏览器侧客户端（模拟"你登录网页端确认设备码"那一步）。 */
function browser() {
  let cookie = ''
  return async (p, { method = 'GET', body } = {}) => {
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const kv = c.split(';')[0]
      if (kv.startsWith('dsw_session=')) cookie = kv
    }
    const data = await res.json().catch(() => null)
    return { status: res.status, data }
  }
}

const USER = 'e2euser'
const PASS = 'e2e-pass-1234'
const browserA = browser()

console.log(`临时数据目录：${process.env.DSH_WEB_DATA}\n`)

// ── 1. 网页端注册（模拟用户先在浏览器里有个账号）──
const reg = await browserA('/api/register', { method: 'POST', body: { username: USER, password: PASS } })
check('网页端注册成功', reg.status === 200 && reg.data.me.username === USER, `HTTP ${reg.status}`)

// ── 2. 插件侧申请设备码（真 cloud.js）──
const start = await cloudDeviceStart({ cloudUrl: BASE, log })
check('★ cloud.js 申请设备码成功', start.ok === true && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(start.userCode || ''), JSON.stringify(start))
check('短码与长码是两串不同的东西', start.userCode !== start.deviceCode && String(start.deviceCode).length >= 32)

// ── 3. 没确认时轮询：不该拿到令牌 ──
const before = await cloudDevicePoll({ cloudUrl: BASE, deviceCode: start.deviceCode, log })
check('★ 没人确认时 poll 只回 pending、不给令牌', before.ok === true && before.status === 'pending' && before.token === undefined, JSON.stringify(before))

// ── 4. 网页端登录后确认（这一步必须已登录）──
const anonApprove = await fetch(`${BASE}/api/device/approve`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userCode: start.userCode }),
})
check('★ 未登录时确认被拒绝（短码单独存在换不出权限）', anonApprove.status === 401, `HTTP ${anonApprove.status}`)
const approve = await browserA('/api/device/approve', { method: 'POST', body: { userCode: start.userCode } })
check('登录后确认成功', approve.status === 200 && approve.data.ok === true, `HTTP ${approve.status} ${JSON.stringify(approve.data)}`)

// ── 5. 插件侧轮询兑现令牌 ──
const poll = await cloudDevicePoll({ cloudUrl: BASE, deviceCode: start.deviceCode, log })
check('★ cloud.js 拿到令牌且归属正确', poll.ok === true && poll.status === 'approved' && poll.username === USER && typeof poll.token === 'string' && poll.token.length >= 32,
  JSON.stringify({ ...poll, token: poll.token ? '有' : '无' }))
check('令牌是给这个账号的，配额也一起来了', poll.me?.username === USER && poll.me?.quota?.limit === 100, JSON.stringify(poll.me?.quota))

// ── 6. 插件侧上传正文 ──
const TEXT = '这是插件端到端验收的正文。\n第二行：中文与 emoji ✅'
const pub = await cloudPublishNote({ cloudUrl: BASE, token: poll.token, text: TEXT, title: 'E2E 验收', mode: 'note-link', log })
check('★ cloud.js 上传成功并拿回可点链接', pub.ok === true && pub.url === `${BASE}/n/${pub.id}`, JSON.stringify(pub))
check('链接路径是 /n/<id>（QQ 里点开就是这个）', new URL(pub.url).pathname === `/n/${pub.id}`)

// ── 7. 网页端打开这条记录：正文一致，且次数 +1 ──
const list = await browserA('/api/records')
check('记录出现在该账号的「我的记录」里', list.data.items.some((i) => i.id === pub.id), JSON.stringify(list.data.items?.map((i) => i.id)))
const view = await browserA(`/api/records/${pub.id}/view`, { method: 'POST', body: {} })
check('★ 打开后正文与上传的一字不差', view.status === 200 && view.data.record.text === TEXT,
  `HTTP ${view.status} ${JSON.stringify(view.data.record?.text)}`)
check('★ 打开计 1 次（配额真的在动）', view.data.quota.used === 1 && view.data.quota.remaining === 99, JSON.stringify(view.data.quota))

// ── 8. 另一个账号看不到这条记录（多租户隔离）──
const other = browser()
await other('/api/register', { method: 'POST', body: { username: 'e2eother', password: 'other-pass-1234' } })
const otherView = await other(`/api/records/${pub.id}/view`, { method: 'POST', body: {} })
check('★★ 别人打这条记录 → 404（不是 403/200，就是"不存在"）', otherView.status === 404, `HTTP ${otherView.status} ${JSON.stringify(otherView.data)}`)
const otherList = await other('/api/records')
check('别人的列表里也没有它', otherList.data.items.length === 0, JSON.stringify(otherList.data.items))

// ── 9. 插件侧查配额 ──
const me = await cloudMe({ cloudUrl: BASE, token: poll.token, log })
check('★ cloud.js 查到账号与配额', me.ok === true && me.me.username === USER, JSON.stringify(me))
check('配额里能看到"已经用了 1 次"', me.me.quota.used === 1, JSON.stringify(me.me.quota))
check('describeAccount 输出是人话', /账号 e2euser · 免费版 · 今天还剩 99 \/ 100 次/.test(describeAccount(me.me)), describeAccount(me.me))

// ── 10. 令牌被吊销之后：插件侧下一次上传要失败得明白 ──
const tokens = await browserA('/api/tokens')
const tokId = tokens.data.items?.[0]?.id
const rev = await browserA('/api/tokens/revoke', { method: 'POST', body: { id: tokId } })
check('网页端能吊销这把令牌', rev.status === 200 && rev.data.ok === true, JSON.stringify(rev.data))
const after = await cloudPublishNote({ cloudUrl: BASE, token: poll.token, text: '吊销之后不该还能传', log })
check('★ 吊销后再上传 → 明确失败（不是静默成功）', after.ok === false && after.status === 401, JSON.stringify(after))

// ── 11. 失败原因是不是"能看懂的原话" ──
// 注意：cloud.js **刻意不在 HTTP 错误时自己记日志**（记日志是调用方的活，见 index.js 的
// publishTurnNote）——所以这里断言的是"服务端原话被完整带回来了"，那才是用户能看到的东西。
check('★ 服务端的原话被完整带回（不是被换成"上传失败"）', /令牌/.test(String(after.error)), JSON.stringify(after))
check('失败里带上了 HTTP 状态码（好判断是"令牌废了"还是"服务器炸了"）', after.status === 401, String(after.status))

console.log(`\n插件 × 云端 端到端：${pass} 通过 / ${fail} 失败`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
