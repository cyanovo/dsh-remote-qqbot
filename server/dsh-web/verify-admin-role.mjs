#!/usr/bin/env node
// 「账号级管理员身份 + 封禁」验收脚本。
//
// 用法：
//   node verify-admin-role.mjs                    # 验本地 server.mjs
//   node verify-admin-role.mjs --server <路径>     # 反向校验：指向旧版必须报红
//
// 覆盖四件事（都是真跑 HTTP，不扫源码、不正则匹配字面量）：
//   ① 账号级管理员：登录 cookie 即可进后台；普通账号 → 403（且**不计口令失败次数**）
//   ② 主人账号由 DSH_WEB_OWNER 在启动时补管理员位 —— **公开注册绝不自动给管理员**
//   ③ 封禁：登录 / cookie / 发布令牌 / 发布接口全线拦下，**且一个字节的数据都不删**
//   ④ 付费版授予与取消（沿用 proUntil 模型）＋「不能把最后一个管理员锁在门外」
//
// 取值一律走 J()/U() 这两层兜底：**反向校验时后台会全线 403**，
// 若写成 `res.json.user.records`，脚本会在第 3 节崩掉 ⇒ 第 4~8 节失去反向证据。
// 崩溃不是「报红」，它只是让尺子半截断掉。
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

const J = (res) => (res && res.json) || {}          // 回执 body
const U = (res) => J(res).user || {}                // 后台「账号详情」回执里的 user 块
const ME = (res) => J(res).me || {}                 // /api/me 与 /api/register 的 me 块

let pass = 0
const fails = []
function chk(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fails.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-role-'))
const PORT = 18700 + Math.floor(Math.random() * 300)
const BASE = `http://127.0.0.1:${PORT}`
const PUBLIC = path.join(__dirname, 'public')

const stamp = Date.now().toString(36).slice(-5)
const OWNER = `vrown${stamp}`       // 由 DSH_WEB_OWNER 声明的主人账号
const PLAIN = `vrpl${stamp}`        // 普通账号（后来被授予管理员）
const OTHER = `vrot${stamp}`        // 纯粹的普通账号
const PW = 'role-pass-123'

let child = null
let logs = ''
function boot(ownerName) {
  logs = ''
  const env = {
    ...process.env, DSH_WEB_DATA: DATA, DSH_WEB_PORT: String(PORT),
    DSH_WEB_HOST: '127.0.0.1', DSH_WEB_ROOT: PUBLIC,
  }
  if (ownerName) env.DSH_WEB_OWNER = ownerName
  else delete env.DSH_WEB_OWNER
  child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (b) => { logs += b.toString() })
  child.stderr.on('data', (b) => { logs += b.toString() })
}
function kill() { try { child && child.kill('SIGKILL') } catch {} child = null }
const done = (code) => { kill(); process.exit(code) }
process.on('uncaughtException', (e) => { console.error('崩了：', e); done(2) })
process.on('unhandledRejection', (e) => { console.error('崩了：', e); done(2) })

function makeClient() {
  let cookie = ''
  const fn = async function req(method, p, { body, headers = {}, token, admin } = {}) {
    const h = { Accept: 'application/json', ...headers }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    if (cookie) h.Cookie = cookie
    if (token) h.Authorization = `Bearer ${token}`
    if (admin) h['x-admin-token'] = admin
    const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : []
    for (const c of setCookie) {
      if (c.startsWith('dsw_session=')) cookie = c.split(';')[0]
    }
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, json, text, headers: r.headers, gotCookie: /dsw_session=[^;]/.test(setCookie.join(';')) }
  }
  fn.cookie = () => cookie
  return fn
}
const anon = makeClient()

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return true } catch {}
    await new Promise((s) => setTimeout(s, 100))
  }
  return false
}

async function main() {
  const owner = makeClient()
  const plain = makeClient()
  const other = makeClient()

  // ── 阶段一：主人账号**还不存在**时就带上 DSH_WEB_OWNER（不能崩） ────────────
  console.log('\n[0] DSH_WEB_OWNER 指向一个还不存在的账号：忽略，不崩')
  boot(OWNER)
  if (!(await waitReady())) { console.error('服务没起来\n' + logs); done(2) }
  const TOKEN_FILE = path.join(DATA, 'admin-token')
  const ADMIN_TOKEN = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : 'NO-ADMIN-TOKEN-FILE'
  chk('服务起来了（账号不存在不影响启动）', (await anon('GET', '/health')).status === 200)
  chk('admin-token 文件已生成', ADMIN_TOKEN.length >= 20 && ADMIN_TOKEN !== 'NO-ADMIN-TOKEN-FILE')

  // 三个账号全靠**公开注册**创建
  for (const [c, n] of [[owner, OWNER], [plain, PLAIN], [other, OTHER]]) {
    const r = await c('POST', '/api/register', { body: { username: n, password: PW } })
    chk(`注册 ${n}`, r.status === 200 && ME(r).username === n, `status=${r.status}`)
  }
  chk('★ 公开注册**不会**自动给管理员（owner 此刻 admin=false）',
    ME(await owner('GET', '/api/me')).admin === false || ME(await owner('GET', '/api/me')).admin === undefined,
    `admin=${JSON.stringify(ME(await owner('GET', '/api/me')).admin)}`)

  // ── 阶段二：重启 + DSH_WEB_OWNER 指向已存在的账号 ⇒ 启动时补管理员位 ────────
  console.log('\n[1] 重启后 DSH_WEB_OWNER 生效：账号拿到管理员位（持久化在 data.json）')
  kill()
  await new Promise((s) => setTimeout(s, 300))
  boot(OWNER)
  if (!(await waitReady())) { console.error('第二次没起来\n' + logs); done(2) }
  chk('启动日志里明确写了"设为管理员"', /设为管理员/.test(logs),
    logs.slice(0, 200).replace(/\n/g, ' | '))
  chk('★ 主人账号 admin=true（cookie 会话立刻生效）', ME(await owner('GET', '/api/me')).admin === true)

  // ── 阶段三：两种身份通道 ────────────────────────────────────────────────────
  console.log('\n[2] 后台身份：口令通道 + 账号通道，两条并列')
  const rNo = await anon('GET', '/api/admin/overview')
  chk('没凭证 → 401（你还没说明你是谁）', rNo.status === 401, `status=${rNo.status}`)
  const rBad = await anon('GET', '/api/admin/overview', { admin: 'wrong-token-aaaaaa' })
  chk('错口令 → 401', rBad.status === 401, `status=${rBad.status}`)
  const rTok = await anon('GET', '/api/admin/overview', { admin: ADMIN_TOKEN })
  chk('★ 口令通道照旧可用（没有被账号通道削弱）', rTok.status === 200 && J(rTok).ok === true, `status=${rTok.status}`)
  const rOwnerSess = await owner('GET', '/api/admin/overview')
  chk('★ 主人账号**只用 cookie** 就能进后台', rOwnerSess.status === 200 && J(rOwnerSess).ok === true, `status=${rOwnerSess.status}`)
  const rPlainSess = await plain('GET', '/api/admin/overview')
  chk('普通账号的 cookie → 403（说清了，但不够格）', rPlainSess.status === 403, `status=${rPlainSess.status}`)

  // 403 绝不能计入口令失败 —— 否则一个好奇的访客就能把主人的 IP 锁 10 分钟
  for (let i = 0; i < 12; i++) await plain('GET', '/api/admin/users')
  const rAfterSpam = await anon('GET', '/api/admin/overview', { admin: ADMIN_TOKEN })
  chk('★ 连打 12 次 403 之后，正确口令**仍然 200**（403 不计失败次数）',
    rAfterSpam.status === 200, `status=${rAfterSpam.status}`)

  // ── 阶段四：封禁 ────────────────────────────────────────────────────────────
  console.log('\n[3] 封禁：全线拦下，且不删任何数据')
  // 先让 OTHER 有"数据"：一条记录 + 一把发布令牌
  const rPubTok = await other('POST', '/api/tokens', { body: { label: 'role-test' } })
  chk('普通账号能建发布令牌', rPubTok.status === 200 && typeof J(rPubTok).token === 'string')
  const otherToken = J(rPubTok).token
  const rPub0 = await anon('POST', '/api/publish', { token: otherToken, body: { title: '封禁前', text: '封禁前发的正文内容', mode: 'note-link' } })
  chk('普通账号的令牌能发记录', rPub0.status === 200 && J(rPub0).ok === true, `status=${rPub0.status}`)
  const before = await owner('GET', `/api/admin/users/${OTHER}`)
  chk('封禁前：该账号有 1 条记录、1 把令牌', U(before).records === 1 && U(before).tokens === 1,
    `records=${U(before).records} tokens=${U(before).tokens}`)
  chk('封禁前：banned=false / admin=false', U(before).banned === false && U(before).admin === false)

  const rBan = await owner('POST', '/api/admin/user/ban', { body: { username: OTHER, reason: '验收脚本测试封禁' } })
  chk('管理员封禁账号 → 200', rBan.status === 200 && J(rBan).banned === true, `status=${rBan.status}`)
  chk('封禁回执里带 banned=true 与原因', U(rBan).banned === true && U(rBan).banReason === '验收脚本测试封禁')

  const rBan2 = await owner('POST', '/api/admin/user/ban', { body: { username: OTHER } })
  chk('重复封禁是幂等的（already=true，不报错）', rBan2.status === 200 && J(rBan2).already === true)

  // ① 登录被拒，且**不发 cookie**
  const fresh = makeClient()
  const rLoginBanned = await fresh('POST', '/api/login', { body: { username: OTHER, password: PW } })
  chk('★ 被封账号登录 → 403（不是含糊的 401）', rLoginBanned.status === 403 && J(rLoginBanned).banned === true,
    `status=${rLoginBanned.status}`)
  chk('★ 被封账号登录**不发 cookie**（没放他进来）', !rLoginBanned.gotCookie, `cookie=${fresh.cookie().slice(0, 20)}`)
  chk('登录失败的文案里说清了"已被封禁"', String(J(rLoginBanned).error || '').includes('封禁'), J(rLoginBanned).error)

  // ② 老 cookie（封禁前就登录着）也被拦
  const rRecBanned = await other('GET', '/api/records')
  chk('★ 旧 cookie 读记录 → 403', rRecBanned.status === 403, `status=${rRecBanned.status}`)
  chk('403 回执带 banned 标记', J(rRecBanned).banned === true)
  const rPrefsBanned = await other('POST', '/api/prefs', { body: { mode: 'note' } })
  chk('旧 cookie 改偏好 → 403', rPrefsBanned.status === 403, `status=${rPrefsBanned.status}`)

  // ③ 每账号发布令牌也失效，而且**说清是账号被封**（不是"令牌不对"）
  const rPubBanned = await anon('POST', '/api/publish', { token: otherToken, body: { title: 'x', text: '封禁后还想发', mode: 'note-link' } })
  chk('★ 被封账号的发布令牌发记录 → 403', rPubBanned.status === 403, `status=${rPubBanned.status}`)
  chk('403 文案点名是"账号被封禁"', String(J(rPubBanned).error || '').includes('封禁'), J(rPubBanned).error)
  const rMeBanned = await anon('GET', '/api/me', { token: otherToken })
  chk('/api/me 用令牌照常 200，但如实说 banned=true', rMeBanned.status === 200 && ME(rMeBanned).banned === true,
    `status=${rMeBanned.status} banned=${ME(rMeBanned).banned}`)

  // ④ 本人能看见"我被封了"（否则只会以为网站坏了）
  const rMeSelf = await other('GET', '/api/me')
  chk('★ 被封账号本人 /api/me → 200 且 banned=true', rMeSelf.status === 200 && ME(rMeSelf).banned === true,
    `status=${rMeSelf.status}`)
  chk('本人能看到封禁原因', ME(rMeSelf).banReason === '验收脚本测试封禁', JSON.stringify(ME(rMeSelf).banReason))
  // ⑤ 但后台通道对"被封的管理员"也关着
  chk('被封的账号 /api/admin/* → 403（封禁优先于管理员身份）',
    (await other('GET', '/api/admin/overview')).status === 403)

  // ⑥ 数据一个字节都没少
  const mid = await owner('GET', `/api/admin/users/${OTHER}`)
  chk('★ 封禁**不删数据**：记录 1 条、令牌 1 把仍在', U(mid).records === 1 && U(mid).tokens === 1,
    `records=${U(mid).records} tokens=${U(mid).tokens}`)
  chk('封禁不砍档位（proUntil 不变）', U(mid).proUntil === U(before).proUntil)
  chk('详情页仍能列出那条记录（后台照旧可看元信息）', (J(mid).records || []).length === 1)
  chk('后台概览的 bannedUsers 计入 1', (J(await owner('GET', '/api/admin/overview')).totals || {}).bannedUsers === 1)

  // ── 阶段五：解封必须完整恢复 ────────────────────────────────────────────────
  console.log('\n[4] 解封：一切原样回来')
  const rUnban = await owner('POST', '/api/admin/user/ban', { body: { username: OTHER, banned: false } })
  chk('解封 → 200 banned=false', rUnban.status === 200 && J(rUnban).banned === false, `status=${rUnban.status}`)
  const rUnban2 = await owner('POST', '/api/admin/user/ban', { body: { username: OTHER, banned: false } })
  chk('重复解封幂等', rUnban2.status === 200 && J(rUnban2).already === true)
  const rLoginBack = await fresh('POST', '/api/login', { body: { username: OTHER, password: PW } })
  chk('★ 解封后能正常登录（且重新发了 cookie）', rLoginBack.status === 200 && rLoginBack.gotCookie, `status=${rLoginBack.status}`)
  const rRecBack = await other('GET', '/api/records')
  chk('★ 解封后旧 cookie 能读记录，且那条记录还在',
    rRecBack.status === 200 && (J(rRecBack).items || []).length === 1,
    `status=${rRecBack.status} items=${(J(rRecBack).items || []).length}`)
  const rPubBack = await anon('POST', '/api/publish', { token: otherToken, body: { title: '解封后', text: '解封后又能发了', mode: 'note-link' } })
  chk('★ 解封后发布令牌又能用', rPubBack.status === 200 && J(rPubBack).ok === true, `status=${rPubBack.status}`)
  const after = await owner('GET', `/api/admin/users/${OTHER}`)
  chk('解封后记录 2 条（原来那条 + 新发的），一把令牌都没丢', U(after).records === 2 && U(after).tokens === 1,
    `records=${U(after).records} tokens=${U(after).tokens}`)
  chk('banReason 已清空', U(after).banReason === '', JSON.stringify(U(after).banReason))
  chk('后台概览的 bannedUsers 回到 0', (J(await owner('GET', '/api/admin/overview')).totals || {}).bannedUsers === 0)

  // ── 阶段六：管理员身份可以授予、也可以取消 ──────────────────────────────────
  console.log('\n[5] 管理员身份：授予 / 取消（这就是给主人账号加管理员位的那条路）')
  const rGrant = await owner('POST', '/api/admin/user/admin', { body: { username: PLAIN } })
  chk('授予 PLAIN 管理员 → 200 admin=true', rGrant.status === 200 && J(rGrant).admin === true, `status=${rGrant.status}`)
  chk('PLAIN 的 cookie 现在能进后台', (await plain('GET', '/api/admin/overview')).status === 200)
  chk('授予是幂等的', J(await owner('POST', '/api/admin/user/admin', { body: { username: PLAIN } })).already === true)
  chk('概览 adminUsers = 2（主人 + PLAIN）', (J(await owner('GET', '/api/admin/overview')).totals || {}).adminUsers === 2)

  const rDeny = await other('POST', '/api/admin/user/admin', { body: { username: OTHER } })
  chk('★ 普通账号**不能自己给自己**管理员（403）', rDeny.status === 403, `status=${rDeny.status}`)
  chk('★ 自助提权没有发生（OTHER 仍然 admin=false）', ME(await other('GET', '/api/me')).admin === false)
  const rNoSuch = await owner('POST', '/api/admin/user/admin', { body: { username: 'nobody-here-xyz' } })
  chk('给不存在的账号授管理员 → 404', rNoSuch.status === 404, `status=${rNoSuch.status}`)

  // ── 阶段七：不能把最后一个管理员锁在门外 ────────────────────────────────────
  console.log('\n[6] 最后一个管理员：封 / 降 / 删 三条路都必须被挡住')
  chk('先把 PLAIN 封掉', (await owner('POST', '/api/admin/user/ban', { body: { username: PLAIN } })).status === 200)
  const rBanLast = await owner('POST', '/api/admin/user/ban', { body: { username: OWNER } })
  chk('★ 封最后一个管理员 → 409', rBanLast.status === 409, `status=${rBanLast.status}`)
  chk('409 文案说清了原因', String(J(rBanLast).error || '').includes('最后一个'), J(rBanLast).error)
  const rDemoteLast = await owner('POST', '/api/admin/user/admin', { body: { username: OWNER, admin: false } })
  chk('★ 取消最后一个管理员 → 409', rDemoteLast.status === 409, `status=${rDemoteLast.status}`)
  const rDelLast = await owner('POST', '/api/admin/user/delete', { body: { username: OWNER } })
  chk('★ 删除最后一个管理员 → 409', rDelLast.status === 409, `status=${rDelLast.status}`)
  chk('★ 三次都被挡住之后，主人账号**依然进得去后台**', (await owner('GET', '/api/admin/overview')).status === 200)

  // 解封 PLAIN ⇒ 有 2 个活跃管理员 ⇒ 现在允许降级
  chk('解封 PLAIN', (await owner('POST', '/api/admin/user/ban', { body: { username: PLAIN, banned: false } })).status === 200)
  const rDemote = await owner('POST', '/api/admin/user/admin', { body: { username: OWNER, admin: false } })
  chk('有第二个管理员时，取消 OWNER 管理员 → 200', rDemote.status === 200 && J(rDemote).admin === false, `status=${rDemote.status}`)
  chk('OWNER 的 /api/me 立刻 admin=false', ME(await owner('GET', '/api/me')).admin === false)
  chk('OWNER 的 cookie 再进后台 → 403', (await owner('GET', '/api/admin/overview')).status === 403)
  const rReGrant = await plain('POST', '/api/admin/user/admin', { body: { username: OWNER } })
  chk('★ PLAIN（现在是管理员）能把 OWNER 加回来 → 200', rReGrant.status === 200 && J(rReGrant).admin === true, `status=${rReGrant.status}`)
  chk('★ OWNER 的 cookie 又能进后台', (await owner('GET', '/api/admin/overview')).status === 200)

  // ── 阶段八：付费版授予 / 取消（沿用 proUntil 模型）───────────────────────────
  console.log('\n[7] 付费版：授予（叠加）/ 取消，走的是同一套 proUntil')
  const rG1 = await owner('POST', '/api/admin/user/grant', { body: { username: OTHER, days: 30 } })
  chk('给 30 天付费版 → 200', rG1.status === 200 && U(rG1).plan === 'pro', `status=${rG1.status}`)
  chk('额度变成 1000、保留期变成 48 小时',
    U(rG1).limit === 1000 && U(rG1).retentionText === '48 小时',
    `limit=${U(rG1).limit} retention=${U(rG1).retentionText}`)
  const until1 = U(rG1).proUntil
  const rG2 = await owner('POST', '/api/admin/user/grant', { body: { username: OTHER, days: 30 } })
  chk('★ 再给 30 天是**叠加**（不是重置成 30 天）', U(rG2).proUntil > until1,
    `${until1} → ${U(rG2).proUntil}`)
  const rF = await owner('POST', '/api/admin/user/grant', { body: { username: OTHER, forever: true } })
  chk('永久付费版：proForever=true', rF.status === 200 && U(rF).proForever === true, `status=${rF.status}`)
  const rRv = await owner('POST', '/api/admin/user/grant', { body: { username: OTHER, revoke: true } })
  chk('★ 取消付费版 → 回到免费版（100 次 / 5 小时）',
    rRv.status === 200 && U(rRv).plan === 'free' && U(rRv).limit === 100 && U(rRv).retentionText === '5 小时',
    `plan=${U(rRv).plan} limit=${U(rRv).limit} retention=${U(rRv).retentionText}`)
  chk('取消后 proUntil 归零、proForever=false', U(rRv).proUntil === 0 && U(rRv).proForever === false)
  chk('★ 取消付费版**不影响**记录与令牌（数据与档位是两件事）',
    U(await owner('GET', `/api/admin/users/${OTHER}`)).records === 2)

  // ── 阶段九：列表字段齐全 ────────────────────────────────────────────────────
  console.log('\n[8] 后台看得到"所有账号的状态与使用情况"')
  const rUsers = await owner('GET', '/api/admin/users')
  const items = J(rUsers).items || []
  chk('用户列表 200 且能拿到全部账号', rUsers.status === 200 && items.length >= 3, `n=${items.length}`)
  const row = items.find((x) => x.username === OTHER)
  chk('每行都有 admin / banned 字段', !!row && 'admin' in row && 'banned' in row, JSON.stringify(row))
  chk('每行都有用量字段（今日/累计/记录/令牌/最近活跃）',
    !!row && typeof row.usedToday === 'number' && typeof row.viewsTotal === 'number' &&
    typeof row.records === 'number' && typeof row.tokens === 'number' && typeof row.lastSeenAt === 'number')
  const ov = J(await owner('GET', '/api/admin/overview')).totals || {}
  chk('概览 totals 有 adminUsers / bannedUsers', typeof ov.adminUsers === 'number' && typeof ov.bannedUsers === 'number')

  // 删掉一个**非管理员**账号：这条老路必须仍然通（别被"最后一个管理员"的守卫误伤）
  const tmp = makeClient()
  const TMPU = `vrtmp${stamp}`
  await tmp('POST', '/api/register', { body: { username: TMPU, password: PW } })
  const rDel = await owner('POST', '/api/admin/user/delete', { body: { username: TMPU } })
  chk('删除普通账号仍然可用（守卫没误伤）', rDel.status === 200 && J(rDel).deleted === TMPU, `status=${rDel.status}`)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`通过 ${pass} / 失败 ${fails.length}`)
  if (fails.length) { console.log('失败项：'); for (const f of fails) console.log('  · ' + f) }
  done(fails.length ? 1 : 0)
}

main().catch((e) => { console.error('崩了：', e); done(2) })
