#!/usr/bin/env node
// 后台管理（/api/admin/*）验收脚本。
//
// 用法：
//   node verify-admin.mjs                     # 验本地 server.mjs
//   node verify-admin.mjs --server <路径>      # 验指定文件（反向校验用：指向旧版必须报红）
//
// 设计原则（本项目的铁律）：
//   ① 全部是**真跑 HTTP**，不扫源码、不正则匹配；
//   ② 关键结论必须有**反例**（无口令/错口令/用户令牌 → 401）；
//   ③ 反向校验：同一套断言指向旧版 server.mjs 必须变红，否则说明断言是空的。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const SERVER = path.resolve(__dirname, argOf('--server', 'server.mjs'))
// 人机验证的答案只在**测试模式**下由 /api/captcha 一并返回（生产 unit 不设这个变量）。
// 本脚本第 [11] 节要打的是"公网形态"的请求（用 x-real-ip 伪造来源，所以服务端会要求验证码），
// 不打开这个开关就没法把"错密码 → 401 / 账号被锁 → 429"这条链走通。
process.env.DSH_WEB_CAPTCHA_TEST = '1'

let pass = 0
const fails = []
function chk(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fails.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-admin-'))
const PORT = 18300 + Math.floor(Math.random() * 400)
const BASE = `http://127.0.0.1:${PORT}`

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, DSH_WEB_DATA: DATA, DSH_WEB_PORT: String(PORT), DSH_WEB_HOST: '127.0.0.1', DSH_WEB_ROOT: path.join(__dirname, 'public') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
child.stdout.on('data', (b) => { logs += b.toString() })
child.stderr.on('data', (b) => { logs += b.toString() })

const done = (code) => { try { child.kill('SIGKILL') } catch {} process.exit(code) }
process.on('uncaughtException', (e) => { console.error('崩了：', e); done(2) })

// ── 极简 HTTP 客户端（手工管 cookie，不引依赖）──────────────────────────────
function makeClient() {
  let cookie = ''
  return async function req(method, p, { body, headers = {}, token, admin } = {}) {
    const h = { Accept: 'application/json', ...headers }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    if (cookie) h.Cookie = cookie
    if (token) h.Authorization = `Bearer ${token}`
    if (admin) h['x-admin-token'] = admin
    const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : []
    for (const c of setCookie) if (c.startsWith('dsw_session=')) cookie = c.split(';')[0]
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, json, text, headers: r.headers }
  }
}
const anon = makeClient()

/** 领一张验证码并解出来。
 *  ⚠️ 两条讲究：
 *    ① 领题的 IP 必须与随后那次登录**一致** —— 服务端把题绑在来源 IP 上，不一致会被判失效；
 *    ② 需要计时的断言必须把这一步放在计时**之外**，否则量到的是"领题"的耗时，不是"比对密码"的耗时。 */
async function solveCaptcha(ip) {
  const r = await anon('GET', '/api/captcha', ip ? { headers: { 'x-real-ip': ip } } : {})
  if (r.status !== 200 || !r.json || !r.json.id) throw new Error(`领验证码失败：HTTP ${r.status} ${JSON.stringify(r.json)}`)
  return { captchaId: r.json.id, captchaText: r.json.answer }
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + '/health')
      if (r.ok) return true
    } catch {}
    await new Promise((s) => setTimeout(s, 100))
  }
  return false
}

const stamp = Date.now().toString(36).slice(-5)
const U1 = `vatest${stamp}`
const P1 = 'admin-pass-123'
const P2 = 'admin-pass-456'
const SECRET_BODY = 'SUPER_SECRET_BODY_绝不外泄_' + stamp

async function main() {
  if (!(await waitReady())) { console.error('服务没起来\n' + logs); done(2) }
  // 老版本根本不生成这个文件 —— 不能直接崩掉，那只会得到一句 ENOENT，
  // 看不出"后台功能整个不存在"。这里退化成一句明确的失败 + 一个肯定不对的口令，
  // 后面的每一条断言都会自己报红。
  const TOKEN_FILE = path.join(DATA, 'admin-token')
  const ADMIN_TOKEN = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : 'NO-ADMIN-TOKEN-FILE-ON-THIS-BUILD'
  chk('admin-token 文件已生成且非空', ADMIN_TOKEN.length >= 20 && ADMIN_TOKEN !== 'NO-ADMIN-TOKEN-FILE-ON-THIS-BUILD', `len=${ADMIN_TOKEN.length}`)

  // ── 一、门禁 ──────────────────────────────────────────────────────────────
  console.log('\n[1] 门禁：没有口令就一步也走不动')
  const rHealth = await anon('GET', '/health')
  chk('/health 免鉴权', rHealth.status === 200 && rHealth.json.ok === true)
  // 2026-10-04 安全审计 H5：以前 /health **免鉴权**就报 {records, users}（实测线上
  // {"ok":true,"records":16,"users":2}）—— 那是把"我们有多少用户"白送给任何人。
  // 现在数字挪到 /health/detail，且要后台凭证。
  chk('★ /health 不再报账号数/记录数', !('users' in rHealth.json) && !('records' in rHealth.json), JSON.stringify(rHealth.json))
  chk('★ /health/detail 无凭证 → 401', (await anon('GET', '/health/detail')).status === 401)
  const rHealthDetail = await anon('GET', '/health/detail', { admin: ADMIN_TOKEN })
  // ⚠️ 这里必须防 null：反向校验时（指向旧版）`/health/detail` 不存在、返回的不是 JSON，
  //    不加防护就会 `null.users` 崩溃，把整轮断言**中途掐死** —— 那样只会看到前两行红，
  //    后面的红全被藏掉（比"没断言"更坏：看着像"就这两个问题"）。
  chk('★ /health/detail 带后台口令 → 200 且给数字', rHealthDetail.status === 200 && !!(rHealthDetail.json && typeof rHealthDetail.json.users === 'number'), JSON.stringify(rHealthDetail.json))
  const rNo = await anon('GET', '/api/admin/overview')
  chk('不带口令 → 401', rNo.status === 401, `status=${rNo.status}`)
  const rWrong = await anon('GET', '/api/admin/overview', { admin: 'wrong-token-aaaaaa' })
  chk('错口令 → 401', rWrong.status === 401, `status=${rWrong.status}`)
  const rOk = await anon('GET', '/api/admin/overview', { admin: ADMIN_TOKEN })
  chk('对口令 → 200', rOk.status === 200 && rOk.json.ok === true, `status=${rOk.status}`)

  // 建一个普通用户，拿它的**发布令牌**去当后台口令 —— 必须被拒（隐私边界）
  const c1 = makeClient()
  const rReg = await c1('POST', '/api/register', { body: { username: U1, password: P1 } })
  chk('注册测试账号', rReg.status === 200 && rReg.json.me.username === U1, `status=${rReg.status}`)
  const rTok = await c1('POST', '/api/tokens', { body: { label: 'verify-admin' } })
  chk('账号能建发布令牌', rTok.status === 200 && typeof rTok.json.token === 'string')
  const userToken = rTok.json.token
  const rIsolation = await anon('GET', '/api/admin/overview', { admin: userToken })
  chk('★ 普通用户令牌在后台 → 401（不是 403，是不认）', rIsolation.status === 401, `status=${rIsolation.status}`)
  const rBearer = await anon('GET', '/api/admin/overview', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })
  chk('Authorization: Bearer 形式的后台口令也能用', rBearer.status === 200, `status=${rBearer.status}`)

  // ── 二、概览 ──────────────────────────────────────────────────────────────
  console.log('\n[2] 概览：数字来自 db，不来自任何缓存副本')
  const ov = (await anon('GET', '/api/admin/overview', { admin: ADMIN_TOKEN })).json
  chk('概览 config 回显两档额度 100/1000', ov.config.freeDaily === 100 && ov.config.proDaily === 1000)
  chk('概览 config 回显保留期 5 小时 / 48 小时', ov.config.retentionText === '5 小时' && ov.config.proRetentionText === '48 小时')
  chk('概览 config 回显单价 2.99', ov.config.priceCny === '2.99')
  chk('概览 config 给出 admin-token 路径', String(ov.config.adminFile).endsWith('admin-token'))
  chk('概览 totals.users 与 /health 一致', ov.totals.users === 1, `users=${ov.totals.users}`)
  chk('概览 trend 是 14 天', Array.isArray(ov.trend) && ov.trend.length === 14, `len=${ov.trend && ov.trend.length}`)
  chk('trend 每行有 day/views/newUsers/records', ov.trend.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && typeof d.views === 'number' && typeof d.newUsers === 'number' && typeof d.records === 'number'))
  chk('trend 最后一行就是今天', ov.trend[13].day === new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10))
  chk('trend 今天 newUsers >= 1（刚注册的那个）', ov.trend[13].newUsers >= 1, `newUsers=${ov.trend[13].newUsers}`)
  chk('概览有内存/运行时长', typeof ov.memoryMB === 'number' && typeof ov.uptimeSec === 'number')

  // ── 三、建号 / 改档 / 改密 / 清额度 ───────────────────────────────────────
  console.log('\n[3] 建号、给 Pro、收回、改密、清今日额度')
  const rBad1 = await anon('POST', '/api/admin/user/create', { admin: ADMIN_TOKEN, body: { username: 'x', password: '123456' } })
  chk('用户名太短 → 400', rBad1.status === 400, `status=${rBad1.status}`)
  const rBad2 = await anon('POST', '/api/admin/user/create', { admin: ADMIN_TOKEN, body: { username: 'vaokname1', password: '123' } })
  chk('密码太短 → 400', rBad2.status === 400, `status=${rBad2.status}`)
  const rDup = await anon('POST', '/api/admin/user/create', { admin: ADMIN_TOKEN, body: { username: U1, password: 'whatever9' } })
  chk('重名 → 409', rDup.status === 409, `status=${rDup.status}`)

  const U2 = `vap${stamp}`
  const rNew = await anon('POST', '/api/admin/user/create', { admin: ADMIN_TOKEN, body: { username: U2, password: P1, days: 30 } })
  chk('后台建号（顺便给 30 天）→ 200', rNew.status === 200 && rNew.json.ok === true, `status=${rNew.status}`)
  chk('新建出来就是 pro 档', rNew.json.user.plan === 'pro', `plan=${rNew.json.user.plan}`)
  chk('pro 档额度 1000', rNew.json.user.limit === 1000, `limit=${rNew.json.user.limit}`)
  chk('pro 档剩余天数 30', rNew.json.user.proDaysLeft === 30, `daysLeft=${rNew.json.user.proDaysLeft}`)
  chk('pro 档保留期文案 48 小时', rNew.json.user.retentionText === '48 小时', rNew.json.user.retentionText)

  const rRev = await anon('POST', '/api/admin/user/grant', { admin: ADMIN_TOKEN, body: { username: U2, revoke: true } })
  chk('收回 → free 档', rRev.json.user.plan === 'free' && rRev.json.user.limit === 100, JSON.stringify(rRev.json.user.plan))
  chk('收回后保留期回到 5 小时', rRev.json.user.retentionText === '5 小时')

  const rG1 = await anon('POST', '/api/admin/user/grant', { admin: ADMIN_TOKEN, body: { username: U2, days: 30 } })
  chk('给 30 天 → action=grant / days=30', rG1.json.action === 'grant' && rG1.json.days === 30, JSON.stringify(rG1.json.action))
  chk('第一次给不是叠加', rG1.json.stacked === false)
  const rG2 = await anon('POST', '/api/admin/user/grant', { admin: ADMIN_TOKEN, body: { username: U2, days: 30 } })
  chk('★ 再给 30 天是叠加（stacked=true，共 60 天）', rG2.json.stacked === true && rG2.json.user.proDaysLeft >= 59, `daysLeft=${rG2.json.user.proDaysLeft}`)
  const rGF = await anon('POST', '/api/admin/user/grant', { admin: ADMIN_TOKEN, body: { username: U2, forever: true } })
  chk('永久 → proForever=true', rGF.json.user.proForever === true && rGF.json.forever === undefined ? rGF.json.user.proForever === true : rGF.json.user.proForever === true)
  chk('永久档的 proUntil 是 9999-12-31', new Date(rGF.json.user.proUntil + 8 * 3600 * 1000).toISOString().slice(0, 10) === '9999-12-31', new Date(rGF.json.user.proUntil).toISOString())

  const rMiss = await anon('POST', '/api/admin/user/grant', { admin: ADMIN_TOKEN, body: { username: 'nobody-here', days: 30 } })
  chk('给不存在的账号 → 404', rMiss.status === 404, `status=${rMiss.status}`)

  // 让 U2 产生一次真实用量，再让后台清掉
  const c2 = makeClient()
  await c2('POST', '/api/login', { body: { username: U2, password: P1 } })
  const rTok2 = await c2('POST', '/api/tokens', { body: { label: 'u2' } })
  const rPub2 = await c2('POST', '/api/publish', { token: rTok2.json.token, body: { title: '用量测试', text: 'hello', mode: 'note-link' } })
  chk('U2 用令牌发布一条记录', rPub2.status === 200 && !!rPub2.json.id, `status=${rPub2.status}`)
  const rView2 = await c2('POST', `/api/records/${rPub2.json.id}/view`)
  // ⚠️ 查看接口把额度放在 `quota` 里（`remaining` 不是顶层字段）—— 这条断言第一版写错了，
  //    是它自己报的 undefined 把它抓出来的。
  chk('U2 查看一次（消耗 1 次）', rView2.status === 200 && rView2.json.quota.remaining === 999, `status=${rView2.status} remaining=${rView2.json.quota && rView2.json.quota.remaining}`)
  const u2Before = (await anon('GET', `/api/admin/users/${U2}`, { admin: ADMIN_TOKEN })).json
  chk('后台看到 U2 今日用量 1', u2Before.user.usedToday === 1, `usedToday=${u2Before.user.usedToday}`)
  const rQ = await anon('POST', '/api/admin/user/quota', { admin: ADMIN_TOKEN, body: { username: U2 } })
  chk('清今日额度 → usedToday 0', rQ.json.user.usedToday === 0, `usedToday=${rQ.json.user.usedToday}`)
  chk('★ 清额度不动累计用量（累计是单调的，清不掉）', rQ.json.user.viewsTotal >= 1, `viewsTotal=${rQ.json.user.viewsTotal}`)
  const c2b = makeClient()
  const rView2b = await (async () => { await c2b('POST', '/api/login', { body: { username: U2, password: P1 } }); return c2b('POST', `/api/records/${rPub2.json.id}/view`) })()
  chk('清完还能接着用（remaining 仍是 999）', rView2b.status === 200 && rView2b.json.quota.remaining === 999, `status=${rView2b.status}`)
  const afterSecond = (await anon('GET', `/api/admin/users/${U2}`, { admin: ADMIN_TOKEN })).json
  chk('★ 清零后再看一次，累计变成 2（不是 1）', afterSecond.user.viewsTotal === 2, `viewsTotal=${afterSecond.user.viewsTotal}`)

  const rPw = await anon('POST', '/api/admin/user/password', { admin: ADMIN_TOKEN, body: { username: U2, password: P2 } })
  chk('重置密码 → 200', rPw.status === 200, `status=${rPw.status}`)
  const c2c = makeClient()
  const rOld = await c2c('POST', '/api/login', { body: { username: U2, password: P1 } })
  chk('旧密码登录 → 401', rOld.status === 401, `status=${rOld.status}`)
  const c2d = makeClient()
  const rNewPw = await c2d('POST', '/api/login', { body: { username: U2, password: P2 } })
  chk('新密码登录 → 200', rNewPw.status === 200, `status=${rNewPw.status}`)
  // ★ 2026-10-04 安全审计 H3：改密码必须作废**已经发出去的**会话。
  //   改前实测：旧 cookie 仍能读 /api/me → 200，也就是"改密码踢不掉已经进来的攻击者"。
  //   c2 是**改密码之前**用旧密码登录的客户端（它在上面成功看过记录，是有效的会话）。
  //   ⚠️ 判据不能只看状态码：`/api/me` 对未登录者是**故意**回 200 + `me:null` 的
  //   （前端拿它问"我登录了吗"）。所以真正的判据是：① 身份没了（me=null）；
  //   ② 需要登录的接口一律 401。两个都断言，否则容易假绿。
  const rOldSession = await c2('GET', '/api/me')
  chk('★ 改密前拿到的 cookie 身份已消失（me=null）', rOldSession.status === 200 && rOldSession.json.me === null, `status=${rOldSession.status} me=${JSON.stringify(rOldSession.json && rOldSession.json.me)}`)
  const rOldSessionTokens = await c2('GET', '/api/tokens')
  chk('★ 改密前拿到的 cookie 再也拿不到需登录的数据 → 401', rOldSessionTokens.status === 401, `status=${rOldSessionTokens.status}`)
  // 同一端点上的阳性对照：用新密码登录的 cookie 必须拿得到 —— 证明上面那条红不是"接口本来就坏"
  chk('★ 阳性对照：新密码登录后的 cookie 拿得到同一端点 → 200', (await c2d('GET', '/api/tokens')).status === 200)

  // ── 四、兑换码 ────────────────────────────────────────────────────────────
  console.log('\n[4] 兑换码：生成、列表、使用、删除')
  const rCodes = await anon('POST', '/api/admin/codes', { admin: ADMIN_TOKEN, body: { count: 2, days: 7 } })
  chk('生成 2 个 7 天兑换码', rCodes.status === 200 && rCodes.json.codes.length === 2 && rCodes.json.days === 7)
  const [codeA, codeB] = rCodes.json.codes
  chk('兑换码形态 DSH-XXXX-XXXX', /^DSH-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codeA), codeA)
  const rList = await anon('GET', '/api/admin/codes', { admin: ADMIN_TOKEN })
  chk('列表里有刚生成的两个', rList.json.items.filter((c) => c.code === codeA || c.code === codeB).length === 2)
  chk('列表 unused 计数正确', rList.json.unused === 2, `unused=${rList.json.unused}`)
  const rRedeem = await c2d('POST', '/api/redeem', { body: { code: codeA } })
  chk('用户兑换成功', rRedeem.status === 200 && rRedeem.json.days === 7, `status=${rRedeem.status}`)
  chk('★ 兑换是叠加（在永久档上再 +7 天，proUntil 不倒退）', rRedeem.json.stacked === true, `stacked=${rRedeem.json.stacked}`)
  // ★ 2026-10-04 安全审计 P0-2：一张码**一生只能兑一次**。
  //   改前判定是 `rec.usedBy && rec.usedBy !== who` —— 只挡"别人用过"，不挡"自己再用一次"，
  //   于是同一张 ¥2.99 的码可以反复叠加天数（审计实测 30 天码连兑 3 次全 200、叠成 60 天）。
  const meBeforeRepeat = (await c2d('GET', '/api/me')).json
  chk('（前置）/api/me 拿得到 proUntil', typeof meBeforeRepeat.me.proUntil === 'number', JSON.stringify(meBeforeRepeat.me && meBeforeRepeat.me.proUntil))
  const rRedeemAgain = await c2d('POST', '/api/redeem', { body: { code: codeA } })
  chk('★ 同一个码再兑一次 → 409（不许重复叠加）', rRedeemAgain.status === 409, `status=${rRedeemAgain.status} ${JSON.stringify(rRedeemAgain.json)}`)
  const meAfterRepeat = (await c2d('GET', '/api/me')).json
  chk('★ 被拒后 proUntil 一个字没变', meAfterRepeat.me.proUntil === meBeforeRepeat.me.proUntil, `${meBeforeRepeat.me.proUntil} → ${meAfterRepeat.me.proUntil}`)
  const rList2 = await anon('GET', '/api/admin/codes', { admin: ADMIN_TOKEN })
  const used = rList2.json.items.find((c) => c.code === codeA)
  chk('后台能看到这个码被谁用了', used && used.usedBy === U2 && used.usedAt > 0, JSON.stringify(used))
  const rDelUsed = await anon('POST', '/api/admin/codes/delete', { admin: ADMIN_TOKEN, body: { code: codeA } })
  chk('已使用的码不许删 → 409', rDelUsed.status === 409, `status=${rDelUsed.status}`)
  const rDelUnused = await anon('POST', '/api/admin/codes/delete', { admin: ADMIN_TOKEN, body: { code: codeB } })
  chk('未使用的码可以删 → 200', rDelUnused.status === 200, `status=${rDelUnused.status}`)
  const rDelAgain = await anon('POST', '/api/admin/codes/delete', { admin: ADMIN_TOKEN, body: { code: codeB } })
  chk('删两次 → 404', rDelAgain.status === 404, `status=${rDelAgain.status}`)

  // ── 五、记录：只给元信息，绝不给正文 ──────────────────────────────────────
  console.log('\n[5] 记录列表：看得见"谁发了多少"，看不见"写了什么"')
  const rPubSecret = await c2d('POST', '/api/publish', { token: rTok2.json.token, body: { title: '机密', text: SECRET_BODY, mode: 'note-link' } })
  // 上面那次登录把 cookie 换成 c2d；令牌不变，但 publish 需要用令牌（cookie 也认）——这里用令牌最直接
  const rPubSecret2 = rPubSecret.status === 200 ? rPubSecret : await anon('POST', '/api/publish', { token: rTok2.json.token, body: { title: '机密', text: SECRET_BODY, mode: 'note-link' } })
  chk('U2 发布一条带机密正文的记录', rPubSecret2.status === 200, `status=${rPubSecret2.status}`)
  const rRecs = await anon('GET', '/api/admin/records?limit=50', { admin: ADMIN_TOKEN })
  chk('记录列表 200 且有多条', rRecs.status === 200 && rRecs.json.items.length >= 2, `n=${rRecs.json.items.length}`)
  chk('★ 列表里没有任何 text 字段', rRecs.json.items.every((r) => !('text' in r)), JSON.stringify(Object.keys(rRecs.json.items[0] || {})))
  chk('★ 整个响应体里搜不到机密正文', !rRecs.text.includes(SECRET_BODY), '正文泄露了')
  chk('列表带 user 归属', rRecs.json.items.every((r) => typeof r.user === 'string'))
  chk('列表带 expiresAt 与保留期文案', rRecs.json.items.every((r) => typeof r.expiresAt === 'number' && typeof r.retentionText === 'string'))
  const rRecsUser = await anon('GET', `/api/admin/records?user=${U2}`, { admin: ADMIN_TOKEN })
  chk('按 user 过滤生效', rRecsUser.json.items.length >= 2 && rRecsUser.json.items.every((r) => r.user === U2))

  const detail = (await anon('GET', `/api/admin/users/${U2}`, { admin: ADMIN_TOKEN })).json
  chk('详情里的记录同样没有正文', detail.records.every((r) => !('text' in r)))
  chk('详情里的 usage 是按天数组', Array.isArray(detail.usage) && detail.usage.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && typeof d.views === 'number'))
  chk('详情里的 tokens 不泄露明文（只有前缀）', detail.tokens.length >= 1 && detail.tokens.every((t) => t.id === t.prefix && t.prefix.length === 12 && !('token' in t) && !('hash' in t)), JSON.stringify(detail.tokens[0]))
  chk('★ 详情里连 sha256 全量都不给（只到前缀）', detail.tokens.every((t) => t.id.length === 12) && !/[0-9a-f]{64}/.test(JSON.stringify(detail.tokens)), JSON.stringify(detail.tokens[0]))
  const rTokRevoke = await anon('POST', '/api/admin/token/revoke', { admin: ADMIN_TOKEN, body: { username: U2, id: detail.tokens[0].prefix } })
  chk('后台吊销令牌（按前缀）→ 200', rTokRevoke.status === 200 && rTokRevoke.json.revoked === detail.tokens[0].prefix, JSON.stringify(rTokRevoke.json))
  // ⚠️ 必须用一个**没有登录 cookie** 的客户端：`/api/me` 里 cookie 优先于 Bearer，
  //    带着 cookie 只会验到登录态，验不出"令牌被吊销"。
  const rTokGone = await anon('GET', '/api/me', { token: rTok2.json.token })
  chk('★ 被吊销的令牌立刻失效（无 cookie 的 /api/me → 401）', rTokGone.status === 401, `status=${rTokGone.status}`)
  const rTokRevoke2 = await anon('POST', '/api/admin/token/revoke', { admin: ADMIN_TOKEN, body: { username: U2, id: detail.tokens[0].prefix } })
  chk('再吊销同一个 → 404', rTokRevoke2.status === 404, `status=${rTokRevoke2.status}`)
  chk('前缀太短 → 400', (await anon('POST', '/api/admin/token/revoke', { admin: ADMIN_TOKEN, body: { username: U2, id: 'ab' } })).status === 400)
  chk('详情里 lastSeenAt >= 发布时间', detail.user.lastSeenAt >= detail.records[0].createdAt, `${detail.user.lastSeenAt} vs ${detail.records[0] && detail.records[0].createdAt}`)

  const rDelRec = await anon('POST', '/api/admin/records/delete', { admin: ADMIN_TOKEN, body: { id: rPubSecret2.json.id } })
  chk('删记录 → 200', rDelRec.status === 200, `status=${rDelRec.status}`)
  const rDelRec2 = await anon('POST', '/api/admin/records/delete', { admin: ADMIN_TOKEN, body: { id: rPubSecret2.json.id } })
  chk('删同一条两次 → 404', rDelRec2.status === 404, `status=${rDelRec2.status}`)

  // ── 六、排序 / 搜索 ───────────────────────────────────────────────────────
  console.log('\n[6] 用户列表：搜索与排序真的作用在结果上')
  const byName = (await anon('GET', '/api/admin/users?sort=name', { admin: ADMIN_TOKEN })).json
  const names = byName.items.map((r) => r.username)
  chk('sort=name 结果有序', JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), JSON.stringify(names))
  const byUsage = (await anon('GET', '/api/admin/users?sort=usage', { admin: ADMIN_TOKEN })).json
  chk('sort=usage 按累计用量倒序', byUsage.items[0].viewsTotal >= byUsage.items[byUsage.items.length - 1].viewsTotal)
  const searched = (await anon('GET', `/api/admin/users?q=${U2.slice(0, 5)}`, { admin: ADMIN_TOKEN })).json
  chk('搜索命中且只返回命中的', searched.items.length >= 1 && searched.items.every((r) => r.username.includes(U2.slice(0, 5))))
  chk('搜索时 total 仍是全量', searched.total === 2, `total=${searched.total}`)
  const searchedNone = (await anon('GET', '/api/admin/users?q=zzz-not-exist-zzz', { admin: ADMIN_TOKEN })).json
  chk('搜不到就是空数组', searchedNone.items.length === 0)

  // ── 七、设备码 ────────────────────────────────────────────────────────────
  console.log('\n[7] 设备码：后台看得见"有人在绑"，看不见长码')
  const rDevStart = await anon('POST', '/api/device/start')
  chk('设备码 start 成功', rDevStart.status === 200 && !!rDevStart.json.userCode, `status=${rDevStart.status}`)
  const rDevs = await anon('GET', '/api/admin/devices', { admin: ADMIN_TOKEN })
  chk('后台能看到这条待批准', rDevs.status === 200 && rDevs.json.items.length === 1, `n=${rDevs.json.items.length}`)
  chk('设备条目带短码与状态', rDevs.json.items[0].userCode === rDevStart.json.userCode && rDevs.json.items[0].status === 'pending', JSON.stringify(rDevs.json.items[0]))
  const devCode = rDevStart.json.deviceCode || ''
  chk('★ 后台不返回长码（deviceCode）', devCode.length > 0 && !rDevs.text.includes(devCode), '长码泄露了')
  chk('设备条目的 hash 只给前 12 位', rDevs.json.items[0].hash.length === 12)

  // ── 八、删号 ──────────────────────────────────────────────────────────────
  console.log('\n[8] 删号：连记录一起清干净')
  // 2026-10-04 起 /health 只回 {ok:true}（审计 H5），要数字走 /health/detail（后台凭证）。
  const beforeHealth = (await anon('GET', '/health/detail', { admin: ADMIN_TOKEN })).json || {}
  const rDelUser = await anon('POST', '/api/admin/user/delete', { admin: ADMIN_TOKEN, body: { username: U2 } })
  chk('删号 → 200 且报出连带删了几条记录', rDelUser.status === 200 && rDelUser.json.recordsDeleted >= 1, JSON.stringify(rDelUser.json))
  const afterHealth = (await anon('GET', '/health/detail', { admin: ADMIN_TOKEN })).json || {}
  chk('删完 /health/detail 里用户数 -1', afterHealth.users === beforeHealth.users - 1, `${beforeHealth.users} → ${afterHealth.users}`)
  chk('删完记录数也少了', afterHealth.records < beforeHealth.records, `${beforeHealth.records} → ${afterHealth.records}`)
  const c2e = makeClient()
  const rGone = await c2e('POST', '/api/login', { body: { username: U2, password: P2 } })
  chk('被删的账号登不上了', rGone.status === 401, `status=${rGone.status}`)
  const rDelUser2 = await anon('POST', '/api/admin/user/delete', { admin: ADMIN_TOKEN, body: { username: U2 } })
  chk('删同一个账号两次 → 404', rDelUser2.status === 404, `status=${rDelUser2.status}`)

  // ── 九、磁盘上没有后台口令明文（除了 admin-token 自己那个文件）───────────
  console.log('\n[9] 落盘：data.json 里绝不能出现后台口令')
  const dataRaw = fs.existsSync(path.join(DATA, 'data.json')) ? fs.readFileSync(path.join(DATA, 'data.json'), 'utf8') : ''
  chk('data.json 存在', dataRaw.length > 0)
  chk('★ data.json 不含后台口令', !dataRaw.includes(ADMIN_TOKEN))
  chk('data.json 不含用户发布令牌明文', !dataRaw.includes(userToken))
  const adminMode = fs.existsSync(path.join(DATA, 'admin-token')) ? (fs.statSync(path.join(DATA, 'admin-token')).mode & 0o777) : 0
  chk('admin-token 权限 0600（Windows 上此断言无意义，仅记录）', process.platform === 'win32' ? true : adminMode === 0o600, `mode=${adminMode.toString(8)}`)

  // ── 十、限流（放最后：锁了之后本进程就再也调不进后台了）───────────────────
  console.log('\n[10] 口令爆破：连续失败 10 次锁 10 分钟')
  const rUnknown = await anon('GET', '/api/admin/nope', { admin: ADMIN_TOKEN })
  chk('口令对但路径不存在 → 404', rUnknown.status === 404, `status=${rUnknown.status}`)
  const rUnknownNoAuth = await anon('GET', '/api/admin/nope')
  chk('路径不存在也要先过门槛（无口令 → 401）', rUnknownNoAuth.status === 401, `status=${rUnknownNoAuth.status}`)
  // ⚠️ 必须**连续**打错：上面那次"口令对"会把计数清零（这是有意的），
  //    所以不能拿前面零散的失败次数来凑。第一版就是在这里算错的。
  //    另外「第 N 次失败返回什么」不该写死 —— 触发上限的那一次仍返回 401，
  //    下一次（无论口令对错）才 429。这里断言的是**机制**：先放行一阵、再锁死。
  const codes = []
  for (let i = 0; i < 12; i++) codes.push((await anon('GET', '/api/admin/overview', { admin: 'wrong-' + i })).status)
  const firstLock = codes.indexOf(429)
  chk('连打错口令会被锁（12 次里出现 429）', firstLock >= 0, JSON.stringify(codes))
  chk('不是一上来就锁（前 5 次都只是 401）', codes.slice(0, 5).every((c) => c === 401), JSON.stringify(codes.slice(0, 5)))
  chk('锁定发生在上限附近（第 8~11 次之间）', firstLock >= 7 && firstLock <= 11, `firstLock=${firstLock} codes=${JSON.stringify(codes)}`)
  const rLocked = await anon('GET', '/api/admin/overview', { admin: ADMIN_TOKEN })
  chk('★ 锁上之后**正确口令也进不来** → 429', rLocked.status === 429, `status=${rLocked.status}`)
  chk('429 的文案说了要等几分钟', /分钟/.test(String(rLocked.json && rLocked.json.error)), JSON.stringify(rLocked.json))
  chk('日志里记了这次锁定', /锁 10 分钟/.test(logs) || /口令连续/.test(logs), '日志没记')

  // ── 十一、2026-10-04 安全审计新增的几道闸 ─────────────────────────────────
  //    这一段用 `x-real-ip` 伪造一个**别的来源 IP**：clientIp() 先看这个头，
  //    而线上 nginx 会把它覆盖成真实 IP（`proxy_set_header X-Real-IP $remote_addr`），
  //    8795 又只监听 127.0.0.1，所以这里只影响本测试，不会污染本机 IP 的计数。
  console.log('\n[11] 审计补的闸：令牌空 id、cookie Secure、登录限速')
  const rEmptyId = await c1('POST', '/api/tokens/revoke', { body: { id: '' } })
  chk('★ /api/tokens/revoke {id:""} → 400（以前会匹配全部令牌）', rEmptyId.status === 400, `status=${rEmptyId.status} ${JSON.stringify(rEmptyId.json)}`)
  chk('★ 空 id 不再误删令牌（列表还在）', Array.isArray((await c1('GET', '/api/tokens')).json.items))

  // cookie 的 Secure：只由 x-forwarded-proto 决定，走 TLS 就必须带
  const regTls = await anon('POST', '/api/register', { headers: { 'x-forwarded-proto': 'https' }, body: { username: 'vsecure' + Math.floor(Math.random() * 900 + 100), password: 'secure-pass-1234' } })
  const tlsCookie = (regTls.headers.getSetCookie ? regTls.headers.getSetCookie() : []).join(' ')
  chk('★ https 请求下的会话 cookie 带 Secure', /;\s*Secure/i.test(tlsCookie), tlsCookie.replace(/dsw_session=[^;]+/, 'dsw_session=<省略>'))
  const regPlain = await anon('POST', '/api/register', { body: { username: 'vplain' + Math.floor(Math.random() * 900 + 100), password: 'plain-pass-1234' } })
  const plainCookie = (regPlain.headers.getSetCookie ? regPlain.headers.getSetCookie() : []).join(' ')
  chk('http 请求下不带 Secure（本地直连/内网调试要能登录）', !/;\s*Secure/i.test(plainCookie), plainCookie.replace(/dsw_session=[^;]+/, 'dsw_session=<省略>'))
  chk('两种情况下 HttpOnly / SameSite 都在', /HttpOnly/i.test(tlsCookie) && /SameSite/i.test(tlsCookie) && /HttpOnly/i.test(plainCookie))

  // 登录限速：① 针对**同一个账号**的定向爆破 ② 针对**同一个 IP** 的撞库
  const spoofIp = '203.0.113.' + (Math.floor(Math.random() * 200) + 1)
  const fakeUser = 'vnouser' + Math.floor(Math.random() * 90000 + 10000)
  const acctCodes = []
  for (let i = 0; i < 12; i++) {
    const cap = await solveCaptcha(spoofIp)
    acctCodes.push((await anon('POST', '/api/login', { headers: { 'x-real-ip': spoofIp }, body: { username: fakeUser, password: 'wrong-' + i, ...cap } })).status)
  }
  const firstAcctLock = acctCodes.indexOf(429)
  chk('★ 同一账号错密码会被锁（12 次里出现 429）', firstAcctLock >= 0, JSON.stringify(acctCodes))
  chk('★ 不是一上来就锁（前 5 次只是 401）', acctCodes.slice(0, 5).every((c) => c === 401), JSON.stringify(acctCodes.slice(0, 5)))
  chk('★ 锁定发生在上限附近（第 8~11 次）', firstAcctLock >= 7 && firstAcctLock <= 11, `firstLock=${firstAcctLock} codes=${JSON.stringify(acctCodes)}`)
  // 账号被锁后**换一个 IP 也进不来**（按账号记的锁与 IP 无关）
  // ⚠️ 仍要带一张**有效**验证码：服务端是在人机验证之后才回答"这个账号被锁了"的
  //    （否则任何人不用过验证码就能问出"某个账号是不是存在/被锁"）。
  const othIp = '203.0.113.250'
  const rOtherIp = await anon('POST', '/api/login', { headers: { 'x-real-ip': othIp }, body: { username: fakeUser, password: 'wrong-again', ...(await solveCaptcha(othIp)) } })
  chk('★ 账号锁与 IP 无关（换 IP 仍是 429）', rOtherIp.status === 429, `status=${rOtherIp.status}`)
  // 同一 IP 继续用**不同**账号撞库 → 撞到 IP 闸
  // （前 30 次各带一张验证码，之后的请求会在**限流这一层**就被 429 挡下，压根轮不到验证码）
  const ipCodes = []
  for (let i = 0; i < 40 && !ipCodes.includes(429); i++) {
    const cap = await solveCaptcha(spoofIp)
    ipCodes.push((await anon('POST', '/api/login', { headers: { 'x-real-ip': spoofIp }, body: { username: 'vspray' + i, password: 'x', ...cap } })).status)
  }
  chk('★ 换账号继续撞库会撞到每 IP 的闸（40 次内出现 429）', ipCodes.includes(429), `n=${ipCodes.length} 末几次=${JSON.stringify(ipCodes.slice(-6))}`)
  const rRegLocked = await anon('POST', '/api/register', { headers: { 'x-real-ip': spoofIp }, body: { username: 'vlocked' + Math.floor(Math.random() * 900 + 100), password: 'locked-pass-1234' } })
  chk('★ 注册与登录共用同一把 IP 闸（被锁后注册也 429）', rRegLocked.status === 429, `status=${rRegLocked.status}`)
  chk('限流文案说清了要等几分钟', /分钟/.test(String(rRegLocked.json && rRegLocked.json.error)), JSON.stringify(rRegLocked.json))
  // ★ 限速不能把正常用户一起锁死：正确密码仍然能登录（U1 的密码是 P1）
  chk('★ 限速不影响正常登录（正确密码仍 200）', (await makeClient()('POST', '/api/login', { body: { username: U1, password: P1 } })).status === 200)
  // 反枚举：存在的账号与不存在的账号，耗时不应该差出量级（审计实测改前 22.5 倍）
  const tExist = []
  const tMiss = []
  const timingCodes = []
  for (let i = 0; i < 5; i++) {
    // 领题放在计时之外（见 solveCaptcha 的注释）；带对验证码之后才轮得到 scrypt 那一步
    const ipE = '198.51.100.' + (i + 1)
    const capE = await solveCaptcha(ipE)
    const t0 = Date.now()
    const rE = await anon('POST', '/api/login', { headers: { 'x-real-ip': ipE }, body: { username: U1, password: 'nope-' + i, ...capE } })
    tExist.push(Date.now() - t0)
    timingCodes.push(rE.status)
    const ipM = '198.51.100.' + (i + 11)
    const capM = await solveCaptcha(ipM)
    const t1 = Date.now()
    const rM = await anon('POST', '/api/login', { headers: { 'x-real-ip': ipM }, body: { username: 'vghost' + i, password: 'nope-' + i, ...capM } })
    tMiss.push(Date.now() - t1)
    timingCodes.push(rM.status)
  }
  // 🔴 先证明"这几次真的走到了密码比对"：否则两次量到的都是被验证码拦下的 400，
  //    比值照样好看，而反枚举这件事**根本没被验到**（量具骗人的经典形状）。
  chk('★ 计时的那 10 次确实走到密码比对（全是 401，不是被验证码拦下的 400）',
    timingCodes.length === 10 && timingCodes.every((c) => c === 401), JSON.stringify(timingCodes))
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  const ratio = med(tExist) / Math.max(1, med(tMiss))
  chk('★ 存在/不存在账号的登录耗时同量级（< 3 倍，反枚举）', ratio < 3, `存在中位 ${med(tExist)}ms vs 不存在中位 ${med(tMiss)}ms = ${ratio.toFixed(2)}x`)

  console.log(`\n>>> 通过 ${pass} / 失败 ${fails.length}`)
  if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  ❌ ' + f) }
  done(fails.length ? 1 : 0)
}

// 旧版（没有后台功能）上，某条断言会踩到 `undefined.xxx` —— 那是**崩溃**，不是"通过"。
// 这里把崩溃也翻成一次明确的红：既打印已经收集到的失败，也保证退出码非 0。
main().catch((e) => {
  console.log(`\n>>> 脚本中途崩溃（旧版/坏版上会出现）：${e && e.message}`)
  console.log(`>>> 通过 ${pass} / 失败 ${fails.length}`)
  if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  ❌ ' + f) }
  done(fails.length ? 1 : 2)
})
