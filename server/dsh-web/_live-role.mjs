// 线上「管理员角色」验收：打真实部署（默认 https://cyanovo.top）
// 只建一个 vf* 临时账号，跑完删掉；主人的 cyanovo 账号只做「只读检查 + 三个必须被拒的操作」。
// 用法：$env:ADMIN_TOKEN='<后台令牌>'; $env:OWNER_PASS='<主人账号口令>'; node Temp\_live-role.mjs
const BASE = process.env.BASE_URL || 'https://cyanovo.top'
const ADMIN = process.env.ADMIN_TOKEN || ''
if (!ADMIN) { console.error('缺少 ADMIN_TOKEN'); process.exit(2) }
const OWNER_PASS = process.env.OWNER_PASS || ''
if (!OWNER_PASS) { console.error('缺少 OWNER_PASS'); process.exit(2) }

const STAMP = Date.now().toString(36).slice(-6)
const U = `vf${STAMP}${Math.random().toString(36).slice(2, 6)}`
const P = 'live-role-pass-1234'
const BAN_REASON = `线上验收封禁-${STAMP}`
const OWNER = 'cyanovo'

let pass = 0, fail = 0
const ok = (t, c, extra = '') => { if (c) { pass++; console.log(`  ✅ ${t}`) } else { fail++; console.log(`  ❌ ${t}${extra ? ' ｜ ' + extra : ''}`) } }
const info = (s) => console.log(`  ℹ ${s}`)

async function call(path, { method = 'GET', body, cookie, token, bearer } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers['Cookie'] = cookie
  if (token) headers['x-admin-token'] = token
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : [])
  const cookieOut = sc.length ? sc[0].split(';')[0] : ''
  return { status: r.status, json, text, cookie: cookieOut }
}
const uname = (s) => String(s == null ? '' : s).trim()

console.log(`\n=== 线上管理员角色验收 @ ${BASE} ｜ 临时账号 ${U} ===`)

// ── 0. 口令通道 ────────────────────────────────────────────────────────────
console.log('\n[0] 后台口令通道（原有通道，一个字节都没削弱）')
const ov0 = await call('/api/admin/overview', { token: ADMIN })
ok('带后台口令读 overview → 200', ov0.status === 200, `status=${ov0.status}`)
ok('totals 里有 adminUsers / bannedUsers', ov0.json && ov0.json.totals && 'adminUsers' in ov0.json.totals && 'bannedUsers' in ov0.json.totals, JSON.stringify(ov0.json && ov0.json.totals))
// 🔴 基线用**跑之前实测到的数量**，不写死 1：
//    这是个公开站点，随时可能有人真的注册（2026-10-04 就撞上了：库里多出一个 user1）。
//    写死 1 会让"多了个真人账号"看起来像我的探针没清干净 —— 那是量具在骗人。
const USERS0 = ov0.json?.totals?.users
console.log(`    基线：跑之前库里 ${USERS0} 个账号（收尾要回到这个数）`)
const users0 = await call('/api/admin/users', { token: ADMIN })
const ownerRow = (users0.json?.items || []).find((r) => r.username === OWNER)
ok('cyanovo 出现在账号列表里', !!ownerRow)
ok('cyanovo 的 admin === true（自举生效）', ownerRow?.admin === true, JSON.stringify(ownerRow && { admin: ownerRow.admin, plan: ownerRow.plan }))
ok('cyanovo 仍是支持者档（pro，额度 1000）', ownerRow?.plan === 'pro' && ownerRow?.limit === 1000, JSON.stringify(ownerRow && { plan: ownerRow.plan, limit: ownerRow.limit }))
ok('cyanovo 的保留期是 48 小时', ownerRow?.retentionText === '48 小时', String(ownerRow?.retentionText))
ok('每一行都带用量字段（状态 + 使用情况都看得到）',
  ['usedToday', 'viewsTotal', 'records', 'tokens', 'limit', 'plan', 'retentionText'].every((k) => ownerRow && k in ownerRow), Object.keys(ownerRow || {}).join(','))

// ── 1. 账号身份通道（登录态即管理员） ────────────────────────────────────────
console.log('\n[1] 账号身份通道：用 cyanovo 自己登录，不带任何后台口令也能进后台')
const lg = await call('/api/login', { method: 'POST', body: { username: OWNER, password: OWNER_PASS } })
ok('cyanovo 登录 → 200', lg.status === 200, `status=${lg.status}`)
const ownerCookie = lg.cookie
ok('拿到登录 cookie', !!ownerCookie)
const ovS = await call('/api/admin/overview', { cookie: ownerCookie })
ok('★ 只用登录 cookie（不带 x-admin-token）读 overview → 200', ovS.status === 200, `status=${ovS.status}`)
const usersS = await call('/api/admin/users', { cookie: ownerCookie })
ok('★ 登录 cookie 也能读账号列表 → 200', usersS.status === 200, `status=${usersS.status}`)
const meS = await call('/api/me', { cookie: ownerCookie })
ok('/api/me 里用户名是 cyanovo', meS.json?.me?.username === OWNER, JSON.stringify(meS.json?.me?.username))

// ── 2. 口令错 → 401（不是「当成没登录」） ────────────────────────────────────
console.log('\n[2] 口令错 → 401（明确拒绝，不是静默当游客）')
const bad = await call('/api/admin/overview', { token: 'definitely-not-the-token-' + STAMP })
ok('错口令 → 401', bad.status === 401, `status=${bad.status}`)
ok('错口令的报文里说清了原因', /口令|token/i.test(bad.json?.error || ''), String(bad.json?.error))
const stillOk = await call('/api/admin/overview', { token: ADMIN })
ok('紧接着用对口令仍然 200（错口令没把自己锁死）', stillOk.status === 200, `status=${stillOk.status}`)

// ── 3. 普通账号 → 403 且不记失败 ────────────────────────────────────────────
console.log('\n[3] 普通账号（非管理员）→ 403，且不消耗口令失败次数')
const rg = await call('/api/register', { method: 'POST', body: { username: U, password: P } })
ok(`临时账号 ${U} 注册成功`, rg.status === 200, `status=${rg.status} ${rg.json?.error || ''}`)
const uCookie = rg.cookie || (await call('/api/login', { method: 'POST', body: { username: U, password: P } })).cookie
ok('临时账号拿到登录 cookie', !!uCookie)
const ovU = await call('/api/admin/overview', { cookie: uCookie })
ok('★ 普通账号读 overview → 403', ovU.status === 403, `status=${ovU.status}`)
const usersU = await call('/api/admin/users', { cookie: uCookie })
ok('普通账号读账号列表 → 403', usersU.status === 403, `status=${usersU.status}`)
const ovBack = await call('/api/admin/overview', { token: ADMIN })
ok('两次 403 之后口令通道仍然 200（403 不计失败次数）', ovBack.status === 200, `status=${ovBack.status}`)
const meU = await call('/api/me', { cookie: uCookie })
ok('普通账号自己的 /api/me 正常（没被牵连）', meU.status === 200 && meU.json?.me?.username === U)

// ── 4. 支持者身份：给 → 取消 ────────────────────────────────────────────────
console.log('\n[4] 支持者身份：给指定账号加上、再取消')
const g1 = await call('/api/admin/user/grant', { method: 'POST', token: ADMIN, body: { username: U, days: 1 } })
ok('给临时账号加 1 天支持者 → 200', g1.status === 200, `status=${g1.status} ${g1.json?.error || ''}`)
const mePro = await call('/api/me', { cookie: uCookie })
ok('★ 该账号立刻变成支持者档（plan=pro，额度 1000）', mePro.json?.me?.plan === 'pro' && mePro.json?.me?.quota?.limit === 1000, JSON.stringify(mePro.json?.me?.quota))
ok('支持者保留期变成 48 小时', mePro.json?.me?.quota?.retentionText === '48 小时', String(mePro.json?.me?.quota?.retentionText))
const g2 = await call('/api/admin/user/grant', { method: 'POST', token: ADMIN, body: { username: U, revoke: true } })
ok('取消支持者身份 → 200 且 action=revoke', g2.status === 200 && g2.json?.action === 'revoke', JSON.stringify(g2.json && { ok: g2.json.ok, action: g2.json.action }))
const meFree = await call('/api/me', { cookie: uCookie })
ok('★ 立刻回落免费档（额度 100 / 保留 5 小时）', meFree.json?.me?.plan === 'free' && meFree.json?.me?.quota?.limit === 100 && meFree.json?.me?.quota?.retentionText === '5 小时', JSON.stringify(meFree.json?.me?.quota))
ok('额度回落后 proUntil 归零', !meFree.json?.me?.proUntil, String(meFree.json?.me?.proUntil))

// ── 5. 封禁：四种入口都要挡住，且不删数据 ────────────────────────────────────
console.log('\n[5] 封禁：登录 / 通用接口 / 发布令牌全部挡住，数据一条不删')
const tokRes = await call('/api/tokens', { method: 'POST', cookie: uCookie, body: { label: 'live-role-check' } })
const userTok = tokRes.json?.token
ok('临时账号建了一个发布令牌', typeof userTok === 'string' && userTok.length > 20)
const pub1 = await call('/api/publish', { method: 'POST', bearer: userTok, body: { text: `线上验收用的记录 ${STAMP}\n\n第二行` } })
ok('封禁前发布一条记录 → 200', pub1.status === 200, `status=${pub1.status} ${pub1.json?.error || ''}`)
const recId = pub1.json?.id
const ban = await call('/api/admin/user/ban', { method: 'POST', token: ADMIN, body: { username: U, reason: BAN_REASON } })
ok('封禁 → 200 banned=true', ban.status === 200 && ban.json?.banned === true, JSON.stringify(ban.json && { ok: ban.json.ok, banned: ban.json.banned }))
ok('操作人记成「（服务器口令）」', ban.json?.user?.bannedBy === '（服务器口令）', String(ban.json?.user?.bannedBy))
ok('封禁原因原样记下', ban.json?.user?.banReason === BAN_REASON, String(ban.json?.user?.banReason))
const lgBan = await call('/api/login', { method: 'POST', body: { username: U, password: P } })
ok('★ 被封账号登录 → 403（不是 401「密码错」）', lgBan.status === 403, `status=${lgBan.status}`)
ok('★ 登录报文里带上了封禁原因', String(lgBan.json?.error || '').includes(BAN_REASON), String(lgBan.json?.error))
const meBan = await call('/api/me', { cookie: uCookie })
ok('★ /api/me 返回 200 且 banned=true（让界面能解释，不是假装没登录）', meBan.status === 200 && meBan.json?.me?.banned === true, `status=${meBan.status} banned=${meBan.json?.me?.banned}`)
const pubBan = await call('/api/publish', { method: 'POST', bearer: userTok, body: { text: '不该发出去' } })
ok('★ 被封账号的发布令牌 → 403 且带 banned 标记', pubBan.status === 403 && pubBan.json?.banned === true, `status=${pubBan.status}`)
const recBan = await call('/api/records', { cookie: uCookie })
ok('★ 封禁期间读自己的记录 → 403（明确说被封，不是假装没数据）', recBan.status === 403 && /封禁/.test(recBan.json?.error || ''), `status=${recBan.status} err=${recBan.json?.error || ''}`)
const banAdmin = await call('/api/admin/user/admin', { method: 'POST', token: ADMIN, body: { username: U, admin: true } })
ok('给「正被封着」的账号加管理员 → 409', banAdmin.status === 409, `status=${banAdmin.status} ${banAdmin.json?.error || ''}`)
const uRowBan = (await call('/api/admin/users', { token: ADMIN, body: undefined })).json?.items?.find((r) => r.username === U)
ok('后台列表里该账号标成已封禁（banned=true）', uRowBan?.banned === true, JSON.stringify(uRowBan && { banned: uRowBan.banned, admin: uRowBan.admin }))

// ── 6. 「最后一个管理员」不许自断后路 ──────────────────────────────────────
console.log('\n[6] 最后一个管理员：封 / 降 / 删三条路都必须 409')
const tryBanOwner = await call('/api/admin/user/ban', { method: 'POST', token: ADMIN, body: { username: OWNER, reason: '不该成功' } })
ok('封禁最后一个管理员 → 409', tryBanOwner.status === 409, `status=${tryBanOwner.status} ${tryBanOwner.json?.error || ''}`)
const tryDemote = await call('/api/admin/user/admin', { method: 'POST', token: ADMIN, body: { username: OWNER, admin: false } })
ok('取消最后一个管理员 → 409', tryDemote.status === 409, `status=${tryDemote.status} ${tryDemote.json?.error || ''}`)
const tryDel = await call('/api/admin/user/delete', { method: 'POST', token: ADMIN, body: { username: OWNER } })
ok('删除最后一个管理员 → 409', tryDel.status === 409, `status=${tryDel.status} ${tryDel.json?.error || ''}`)
const ownerStill = (await call('/api/admin/users', { token: ADMIN })).json?.items?.find((r) => r.username === OWNER)
ok('★ 三次拒绝之后 cyanovo 仍然是管理员且没被封', ownerStill?.admin === true && ownerStill?.banned === false, JSON.stringify(ownerStill && { admin: ownerStill.admin, banned: ownerStill.banned }))
const ovAfter = await call('/api/admin/overview', { token: ADMIN })
ok('后台总数里 adminUsers ≥ 1', (ovAfter.json?.totals?.adminUsers || 0) >= 1, JSON.stringify(ovAfter.json?.totals))

// ── 7. 解封：一切原样回来 ──────────────────────────────────────────────────
console.log('\n[7] 解封：记录 / 令牌 / 档位原样回来')
const unban = await call('/api/admin/user/ban', { method: 'POST', token: ADMIN, body: { username: U, banned: false } })
ok('解封 → 200 banned=false', unban.status === 200 && unban.json?.banned === false, `status=${unban.status}`)
const lg2 = await call('/api/login', { method: 'POST', body: { username: U, password: P } })
ok('★ 解封后能正常登录', lg2.status === 200, `status=${lg2.status}`)
const u2Cookie = lg2.cookie
const me2 = await call('/api/me', { cookie: u2Cookie })
ok('解封后 /api/me 没有 banned 标记', me2.status === 200 && me2.json?.me?.banned === false, JSON.stringify(me2.json?.me?.banned))
const rec2 = await call('/api/records', { cookie: u2Cookie })
ok('★ 解封后那条记录还在（封禁没删数据）', (rec2.json?.items || []).some((r) => r.id === recId), `records=${(rec2.json?.items || []).length}`)
const tokList2 = await call('/api/tokens', { cookie: u2Cookie })
ok('解封后令牌也还在', (tokList2.json?.items || []).length === 1, `tokens=${(tokList2.json?.items || []).length}`)
const pub2 = await call('/api/publish', { method: 'POST', bearer: userTok, body: { text: '解封之后应该能发' } })
ok('解封后发布令牌恢复可用 → 200', pub2.status === 200, `status=${pub2.status} ${pub2.json?.error || ''}`)

// ── 8. 收尾：删掉临时账号 ──────────────────────────────────────────────────
console.log('\n[8] 收尾：删掉临时账号，现场不留垃圾')
const del = await call('/api/admin/user/delete', { method: 'POST', token: ADMIN, body: { username: U } })
ok('删除临时账号 → 200', del.status === 200, `status=${del.status} ${del.json?.error || ''}`)
const lgDead = await call('/api/login', { method: 'POST', body: { username: U, password: P } })
ok('删掉的账号登录 → 401', lgDead.status === 401, `status=${lgDead.status}`)
const ovEnd = await call('/api/admin/overview', { token: ADMIN })
ok(`账号总数回到跑之前的样子（${USERS0} 个）`, ovEnd.json?.totals?.users === USERS0, JSON.stringify(ovEnd.json?.totals))
const leftover = (await call('/api/admin/users', { token: ADMIN })).json?.items?.filter((r) => r.username.startsWith('vf')) || []
ok('列表里没有 vf* 残留', leftover.length === 0, leftover.map((r) => r.username).join(','))

// ── 9. 管理员身份可以给别的账号（这是"角色挂在账号上"的一般情形） ──────────────
console.log('\n[9] 给另一个账号管理员身份 → 它自己就能进后台；取消后立刻失效')
const U2 = `vf${STAMP}a${Math.random().toString(36).slice(2, 5)}`
const rg2 = await call('/api/register', { method: 'POST', body: { username: U2, password: P } })
ok(`第二临时账号 ${U2} 注册`, rg2.status === 200, `status=${rg2.status}`)
const c2 = rg2.cookie
ok('加管理员之前：它进不去后台（403）', (await call('/api/admin/overview', { cookie: c2 })).status === 403)
const ga = await call('/api/admin/user/admin', { method: 'POST', token: ADMIN, body: { username: U2, admin: true } })
ok('后台把该账号设为管理员 → 200 admin=true', ga.status === 200 && ga.json?.admin === true, JSON.stringify(ga.json && { ok: ga.json.ok, admin: ga.json.admin }))
const ovC2 = await call('/api/admin/overview', { cookie: c2 })
ok('★ 它自己的登录 cookie 立刻能读后台概览（不需要后台口令）', ovC2.status === 200, `status=${ovC2.status}`)
const listC2 = await call('/api/admin/users', { cookie: c2 })
ok('★ 它也能查看所有账号的状态与用量', listC2.status === 200 && Array.isArray(listC2.json?.items) && listC2.json.items.length >= 2, `status=${listC2.status} items=${(listC2.json?.items || []).length}`)
const da = await call('/api/admin/user/admin', { method: 'POST', token: ADMIN, body: { username: U2, admin: false } })
ok('取消管理员身份 → 200 admin=false', da.status === 200 && da.json?.admin === false, JSON.stringify(da.json && { ok: da.json.ok, admin: da.json.admin }))
ok('★ 取消之后它立刻又进不去（403）', (await call('/api/admin/overview', { cookie: c2 })).status === 403)
const del2 = await call('/api/admin/user/delete', { method: 'POST', token: ADMIN, body: { username: U2 } })
ok('删掉第二个临时账号 → 200', del2.status === 200, `status=${del2.status}`)
const ovFinal = await call('/api/admin/overview', { token: ADMIN })
ok(`账号总数回到跑之前的样子（${USERS0} 个，现场干净）`, ovFinal.json?.totals?.users === USERS0, JSON.stringify(ovFinal.json?.totals))

console.log(`\n>>> 通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)