/**
 * P1 公网端到端验收：**打真实线上入口**（默认 http://cyanovo.top/），走完整链路：
 *   注册 → 设备码 start → 登录后 approve → poll 取令牌 → 用令牌发布 → 我的记录里能看到
 *   → 一键注销（连同记录）→ 账号真的消失。
 *
 * 为什么值得单独跑一遍：本地 43 条断言证明的是**代码**；这一遍证明的是
 * **nginx / systemd / 真域名 / 真数据目录**这一串没把功能吃掉（本地全绿、线上 404 的事故是有的）。
 *
 * 用完即销：临时账号跑完就被 `/api/me/purge scope=all` 删掉，不留垃圾数据。
 * 用法：node verify-live.mjs [http://cyanovo.top]
 */
const BASE = (process.argv[2] || 'http://cyanovo.top').replace(/\/$/, '')
const USER = `p1live${Math.random().toString(36).slice(2, 8)}`
const PASS = 'p1live-pass-1234'

let pass = 0
let fail = 0
let skipped = 0
const check = (name, okk, detail = '') => {
  if (okk) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `　${detail}` : ''}`) }
}
// 「跳过」必须显式说出来，而且**不计入通过** —— 否则断言退化成
// `undefined === undefined` 就成了假绿（本项目踩过好几次这类坑）。
const skip = (name, why) => { skipped++; console.log(`  · 跳过 ${name} —— ${why}`) }

function client() {
  let cookie = ''
  return async (p, { method = 'GET', body, headers = {} } = {}) => {
    const h = { ...headers }
    if (cookie) h.cookie = cookie
    let payload
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(`${BASE}${p}`, { method, headers: h, body: payload })
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const kv = c.split(';')[0]
      if (kv.startsWith('dsw_session=')) cookie = kv.endsWith('=') ? '' : kv
    }
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 200) } }
    return { status: res.status, data, len: text.length }
  }
}
const me = client()
const anon = client()

/**
 * 崩了也要把临时账号清掉，别在生产 data.json 里留垃圾。
 *
 * 2026-10-03 实测踩到：脚本自己的断言写错（`tokList2.data` 是 undefined）直接 TypeError，
 * 走到注销那步之前就退出了 ⇒ 线上多出一个 `p1live*` 账号和一条记录。
 * 验收脚本"跑完自清"不能只覆盖 happy path。
 */
async function emergencyPurge() {
  try { await me('/api/me/purge', { method: 'POST', body: { scope: 'all' } }) } catch { /* 尽力而为 */ }
}
process.on('uncaughtException', async (err) => {
  console.error(`\n⛔ 验收脚本崩了：${err?.stack ?? err}\n   已尽力清掉临时账号。`)
  await emergencyPurge()
  process.exit(4)
})
process.on('unhandledRejection', async (err) => {
  console.error(`\n⛔ 验收脚本有未处理的失败：${err?.stack ?? err}\n   已尽力清掉临时账号。`)
  await emergencyPurge()
  process.exit(4)
})

console.log(`线上入口：${BASE}\n临时账号：${USER}（跑完自删）\n`)

// ⚠️ 别断言"跑完数据库必须是 0 账号 0 记录"——那只在**空库**上成立。
//    2026-10-03 实测踩到：主人自己的账号建好之后，这条断言永远红（错的是尺子，不是服务）。
//    正确做法是**自己跟自己比**：跑完必须回到开跑前的计数（多出来的就是没清干净）。
// 2026-10-04 安全审计 H5：/health 不再免鉴权报 counts，数字挪到 /health/detail（要后台口令）。
// 所以基线要么带 ADMIN_TOKEN 去拿，要么**明确跳过** —— 不能让 "undefined === undefined" 混过去。
const ADMIN = process.env.ADMIN_TOKEN || ''
const base0 = ADMIN ? await anon('/health/detail', { headers: { 'x-admin-token': ADMIN } }) : null
const healthShape = await anon('/health')
check('★ /health 只回 {ok:true}，不再泄露账号数/记录数',
  healthShape.status === 200 && healthShape.data.ok === true && !('users' in healthShape.data) && !('records' in healthShape.data),
  `HTTP ${healthShape.status} ${JSON.stringify(healthShape.data)}`)

const home = await anon('/')
check('落地页 200 且是 HTML', home.status === 200 && String(home.data.raw || '').includes('<!doctype'), `HTTP ${home.status}`)
const meta = await anon('/api/meta')
check('meta 里有两档（免费版 100/5h，付费版 1000/48h/30 天/2.99）',
  meta.data.plans && meta.data.plans.free.daily === 100 && meta.data.plans.pro.daily === 1000
  && meta.data.plans.pro.retentionText === '48 小时' && meta.data.plans.pro.days === 30,
  JSON.stringify(meta.data.plans))
check('meta 里有设备码参数（10 分钟 / 轮询 3 秒）',
  meta.data.device && meta.data.device.ttlMs === 600000 && meta.data.device.interval === 3,
  JSON.stringify(meta.data.device))

const reg = await me('/api/register', { method: 'POST', body: { username: USER, password: PASS } })
check('注册成功且是免费版', reg.status === 200 && reg.data.me.plan === 'free' && reg.data.me.quota.limit === 100,
  `HTTP ${reg.status} ${JSON.stringify(reg.data).slice(0, 160)}`)

const start = await anon('/api/device/start', { method: 'POST', body: {} })
// 🔴 设备码是**唯一**没有鉴权的写入口，所以服务端对它做了 10 次/分钟 → 锁 10 分钟的限流。
//    这个验收脚本每跑一次都要 start/poll，**连跑两次就会踩到自己的限流**。
//    踩到时必须**立刻说清并退出**：否则后面每条断言都会因为"没有令牌"而级联变红，
//    看上去像产品坏了，实际是量具的足迹（2026-10-03 实测：一次 429 导致 10 条红）。
if (start.status === 429) {
  console.log('\n⛔ 设备码被限流了 —— 这是服务端的正常行为，是验收脚本自己踩到的。')
  console.log(`   服务端原话：${start.data && start.data.error}`)
  console.log('   怎么办：等 10 分钟再跑；或者重启 dsh-web.service（限流计数在内存里，重启即清空）。')
  await emergencyPurge()
  process.exit(3)
}
check('设备码 start 拿到短码+长码', start.status === 200 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(start.data.userCode) && String(start.data.deviceCode).length >= 32,
  `HTTP ${start.status} ${JSON.stringify(start.data).slice(0, 160)}`)

const pend = await anon('/api/device/poll', { method: 'POST', body: { deviceCode: start.data.deviceCode } })
check('★ 未批准时 poll 只回 pending、不给令牌', pend.data.status === 'pending' && pend.data.token === undefined, JSON.stringify(pend.data))

const apr = await me('/api/device/approve', { method: 'POST', body: { userCode: start.data.userCode } })
check('登录态 approve 成功', apr.status === 200 && apr.data.ok === true, `HTTP ${apr.status} ${JSON.stringify(apr.data).slice(0, 160)}`)

const poll = await anon('/api/device/poll', { method: 'POST', body: { deviceCode: start.data.deviceCode } })
const token = poll.data.token
check('★ poll 取到令牌且归属正确', poll.data.status === 'approved' && poll.data.username === USER && String(token).length >= 32,
  JSON.stringify({ ...poll.data, token: token ? '有' : '无' }).slice(0, 160))

const again = await anon('/api/device/poll', { method: 'POST', body: { deviceCode: start.data.deviceCode } })
check('★ 令牌只交付一次（重放变成 used）', again.data.status === 'used' && again.data.token === undefined, JSON.stringify(again.data))

const pub = await anon('/api/publish', {
  method: 'POST', headers: { authorization: `Bearer ${token}` },
  body: { text: '线上端到端验收正文\n第二行', title: '线上验收', mode: 'note' },
})
check('用设备码令牌发布成功（免费版 = 5 小时）',
  pub.status === 200 && pub.data.plan === 'free' && pub.data.retentionText === '5 小时',
  `HTTP ${pub.status} ${JSON.stringify(pub.data).slice(0, 200)}`)

const bogus = await anon('/api/publish', {
  method: 'POST', headers: { authorization: `Bearer ${token}x` }, body: { text: 'x' },
})
check('坏令牌 401', bogus.status === 401, `HTTP ${bogus.status}`)

// ── 发布令牌的权限边界（插件 cloud_status 要用它读配额）──
const tokMe = await anon('/api/me', { headers: { authorization: `Bearer ${token}` } })
check('★ 发布令牌能读账号配额（插件 cloud_status 靠它显示"还剩几次"）',
  tokMe.status === 200 && tokMe.data.me && tokMe.data.me.username === USER && tokMe.data.me.quota.limit === 100,
  `HTTP ${tokMe.status} ${JSON.stringify(tokMe.data).slice(0, 160)}`)
const tokRecs = await anon('/api/records', { headers: { authorization: `Bearer ${token}` } })
check('★★ 但发布令牌**读不到**记录列表（那条路只认登录 cookie）',
  tokRecs.status === 401 && !(tokRecs.data && tokRecs.data.items),
  `HTTP ${tokRecs.status} ${JSON.stringify(tokRecs.data).slice(0, 160)}`)
const tokBad = await anon('/api/me', { headers: { authorization: 'Bearer totally-not-a-real-token-000' } })
check('假令牌读 /api/me → 401（不是"当成未登录"悄悄返回 me:null）', tokBad.status === 401, `HTTP ${tokBad.status}`)

// ── 「我的令牌」界面背后的两个接口（账号页新增，靠的就是它们）──
const tokList = await anon('/api/tokens')
check('★ 没登录读令牌列表 → 401（别人的令牌列表不能裸奔）', tokList.status === 401, `HTTP ${tokList.status}`)
const tokList2 = await me('/api/tokens')
check('★ 登录后能看到自己的令牌列表（设备码绑出来的那把在里面）',
  tokList2.status === 200 && Array.isArray(tokList2.data.items) && tokList2.data.items.some((t) => t.prefix),
  JSON.stringify(tokList2.data).slice(0, 160))
check('列表里只有前缀，绝不含明文令牌', !JSON.stringify(tokList2.data).includes(token), '响应里出现了明文令牌！')

const list = await me('/api/records')
check('我的记录里能看到刚发布的那条', list.status === 200 && list.data.items.some((i) => i.id === pub.data.id),
  `HTTP ${list.status} ${JSON.stringify(list.data).slice(0, 200)}`)

const view = await me(`/api/records/${pub.data.id}/view`, { method: 'POST', body: {} })
check('打开记录：拿到正文、次数 +1',
  view.status === 200 && String(view.data.record.text).includes('线上端到端验收正文') && view.data.quota.used === 1,
  `HTTP ${view.status} ${JSON.stringify(view.data).slice(0, 200)}`)

// ── 深链 /n/<id>：QQ 里那个可点链接的落点 ──
const page = await anon(`/n/${pub.data.id}`)
check('★ 深链页返回 HTML（SPA 回退）', page.status === 200 && String(page.data.raw || '').includes('<!doctype'),
  `HTTP ${page.status} ${String(page.data.raw || '').slice(0, 80)}`)
const anonView = await anon(`/api/records/${pub.data.id}/view`, { method: 'POST', body: {} })
check('★ 未登录直接打记录 API → 401（前端据此把人送去登录，而不是白屏）', anonView.status === 401, `HTTP ${anonView.status}`)
check('401 文案是给人看的', String(anonView.data && anonView.data.error).includes('登录'), String(anonView.data && anonView.data.error))
const miss = await me('/api/records/zzzzzz/view', { method: 'POST', body: {} })
check('不存在的记录 id → 404 且文案说清"会过期/只留多久"', miss.status === 404 && /保留|过期/.test(String(miss.data.error)),
  `HTTP ${miss.status} ${JSON.stringify(miss.data).slice(0, 160)}`)

const cross = await anon('/api/publish', {
  method: 'POST', headers: { authorization: `Bearer ${token}` },
  body: { username: 'someone-else', text: '冒充' },
})
check('★★ 冒名给别的账号发 → 403', cross.status === 403, `HTTP ${cross.status} ${JSON.stringify(cross.data).slice(0, 160)}`)

const badpass = await me('/api/me/purge', { method: 'POST', body: { scope: 'all', password: 'not-my-password' } })
check('注销时密码不对 → 401（记录已删）', badpass.status === 401 && badpass.data.recordsDeleted >= 1,
  `HTTP ${badpass.status} ${JSON.stringify(badpass.data).slice(0, 160)}`)

const gone = await me('/api/me/purge', { method: 'POST', body: { scope: 'all', password: PASS } })
check('密码对了 → 账号注销', gone.status === 200 && gone.data.deletedAccount === true, JSON.stringify(gone.data))
const relogin = await anon('/api/login', { method: 'POST', body: { username: USER, password: PASS } })
check('注销后不能再登录（临时数据真的清干净了）', relogin.status === 401, `HTTP ${relogin.status}`)

if (!ADMIN) {
  skip('跑完自净：账号数与记录数都回到开跑前', '未提供 ADMIN_TOKEN；/health 已不再免鉴权报数字（临时账号登不上已在上面验过）')
} else {
  const health = await anon('/health/detail', { headers: { 'x-admin-token': ADMIN } })
  check('跑完自净：账号数与记录数都回到开跑前',
    health.data.users === base0.data.users && health.data.records === base0.data.records,
    `开跑前 ${JSON.stringify(base0.data)} → 现在 ${JSON.stringify(health.data)}`)
}

console.log(`\n线上验收：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''}`)
process.exit(fail ? 1 : 0)
