/**
 * 人机验证（验证码）验收：把 server.mjs 真的跑起来（进程内 import，真 listen），再用**真 HTTP** 打它。
 *
 * 为什么不用假函数：这一轮改的是「登录 / 注册入口的鉴权边界」——
 * 一次性、过期、绑 IP、限流、豁免通道，全是**只有真跑才会暴露**的东西。
 *
 * ⚠️ 三处刻意的取舍，都写在这里而不是藏起来：
 *   1. 验证码 TTL 用环境变量调短（4 秒），否则要等 3 分钟才能验一条过期。
 *   2. 领取上限也调小（6 次/分钟），否则要打 60 次才能撞到限流。
 *      —— 两个都只验**机制**；线上默认值（3 分钟 / 60 次）由 `/api/meta` 与常量各自钉着。
 *   3. 数据目录是临时目录，跑完即删，绝不碰线上 data.json。
 *
 * ⚠️ 公网请求怎么模拟：nginx 反代时 socket 对端也是 127.0.0.1，但它会带上
 *    `x-real-ip` = 真实公网 IP。所以「带 x-real-ip」= 公网请求（要验证码），
 *    「不带」= 本机直连（免验证码）。这条区别本身就是被验的对象之一。
 *
 * 用法：
 *   node verify-captcha.mjs                       # 退出码 0 = 全绿
 *   node verify-captcha.mjs --server <副本路径>    # 反向校验：拿"去掉校验"的副本跑，必须报红
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-captcha-'))
const DATA = path.join(TMP, 'data')
const PORT = 18796
const BASE = `http://127.0.0.1:${PORT}`
const TTL = 4000            // 见文件头：只为让"过期"能被如实测出来
const IP_LIMIT = 6          // 见文件头：只为让"领取限流"能被如实测出来

process.env.DSH_WEB_DATA = DATA
process.env.DSH_WEB_PORT = String(PORT)
process.env.DSH_WEB_HOST = '127.0.0.1'
process.env.DSH_WEB_ROOT = path.join(HERE, 'public')
process.env.DSH_WEB_CAPTCHA_TEST = '1'      // 让 /api/captcha 把答案一并回给我们
process.env.DSH_WEB_CAPTCHA_TTL_MS = String(TTL)
process.env.DSH_WEB_CAPTCHA_IP_LIMIT = String(IP_LIMIT)

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const SERVER = path.resolve(argOf('--server', process.env.CAPTCHA_SERVER || path.join(HERE, 'server.mjs')))

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

/** 极简客户端：cookie 只记会话 cookie；`ip` 用来模拟"经 nginx 来的公网请求"。 */
function client(ip = '') {
  let cookie = ''
  return async (p, { method = 'GET', body, headers = {}, noIp = false } = {}) => {
    const h = { ...headers }
    if (ip && !noIp) h['x-real-ip'] = ip
    if (cookie) h.cookie = cookie
    let payload
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(`${BASE}${p}`, { method, headers: h, body: payload })
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : []
    for (const c of sc) {
      const kv = c.split(';')[0]
      if (kv.startsWith('dsw_session=')) cookie = kv.endsWith('=') ? '' : kv
    }
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 160) } }
    return { status: res.status, data, setCookie: sc, cacheControl: res.headers.get('cache-control') }
  }
}
/** 领一张验证码（返回 {id, answer, image, 以及解码后的 svg 文本}） */
async function issue(c) {
  const r = await c('/api/captcha')
  eq(r.status, 200, '签发状态码')
  const image = String(r.data.image || '')
  ok(image.startsWith('data:image/svg+xml;base64,'), '图片应是 SVG 的 data URL')
  return { ...r.data, svg: Buffer.from(image.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8') }
}
const PW = 'captcha-pass-1234'

fs.mkdirSync(DATA, { recursive: true })
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

const ADMIN_TOKEN = fs.readFileSync(path.join(DATA, 'admin-token'), 'utf8').trim()
// 每个逻辑分组用一个独立 IP：免得测试之间互相把限流表踩满（限流是**按 IP** 记的）
const IP = {
  meta: '198.51.100.11',
  issue: '198.51.100.12',
  force: '198.51.100.13',
  once: '198.51.100.14',
  tries: '198.51.100.15',
  ttl: '198.51.100.16',
  bindIp: '198.51.100.17',
  bindIp2: '198.51.100.18',
  case: '198.51.100.19',
  limiter: '198.51.100.20',
  exempt: '198.51.100.21',
  adminOk: '198.51.100.22',
  adminBad: '198.51.100.23',
  noStore: '198.51.100.24',
  use: '198.51.100.25',
}

// ── 一、签发：图是什么样、答案在不在响应里 ─────────────────────────────────
console.log('── 一、签发 ──')
await t('/api/meta：公网请求 required=true，本机直连 required=false', async () => {
  const pub = await client(IP.meta)('/api/meta')
  eq(pub.data.captcha.required, true, '公网请求要验证码')
  eq(pub.data.captcha.chars, 4, '位数')
  eq(pub.data.captcha.ttlMs, TTL, 'TTL 跟随环境变量')
  const local = await client()('/api/meta', { noIp: true })
  eq(local.data.captcha.required, false, '本机直连免验证码')
})
await t('/api/captcha：回 id + SVG data URL，且**答案与图里的字一致**', async () => {
  const c = await issue(client(IP.issue))
  ok(/^[A-Za-z0-9_-]{10,}$/.test(c.id), `id 应是一个随机串，实测 ${JSON.stringify(c.id)}`)
  ok(c.svg.startsWith('<svg'), '解出来应是 svg')
  ok(c.svg.includes('feDisplacementMap'), '应有湍流位移滤镜（提高自动识别成本）')
  eq((c.svg.match(/<text /g) || []).length, 4, '图里应有 4 个字')
  eq(String(c.answer).length, 4, 'TEST 模式下答案应一并返回')
  for (const ch of c.answer) ok(c.svg.includes(`>${ch}</text>`), `图里应能找到字 ${ch}`)
})
await t('/api/captcha：响应不可缓存（no-store）', async () => {
  const r = await client(IP.noStore)('/api/captcha')
  eq(r.status, 200, '状态码')
  eq(String(r.cacheControl || '').toLowerCase(), 'no-store', 'Cache-Control')
})

// ── 二、强制：公网请求拿不到验证码就登不进来 ───────────────────────────────
console.log('── 二、强制 ──')
await t('不带验证码注册 → 400（而不是先建号再报错）', async () => {
  const c = client(IP.force)
  const r = await c('/api/register', { method: 'POST', body: { username: 'capuser1', password: PW } })
  eq(r.status, 400, '状态码')
  eq(r.data.captcha, true, '要标明这是验证码的问题')
  ok(/验证码/.test(String(r.data.error)), `错误文案该提验证码，实测 ${JSON.stringify(r.data.error)}`)
})
await t('不带验证码登录 → 400，且**没有任何 cookie**', async () => {
  const c = client(IP.force)
  const r = await c('/api/login', { method: 'POST', body: { username: 'capuser1', password: PW } })
  eq(r.status, 400, '状态码')
  eq(r.setCookie.filter((x) => x.startsWith('dsw_session=')).length, 0, '不该发会话 cookie')
})
await t('★ 密码对但验证码错 → 400 且登不进去（这才是这道闸的意义）', async () => {
  const c = client(IP.force)
  const good = await issue(c)
  // 先正经注册一个账号（本机直连免验证码那条通道另有用例，这里借它把账号准备好）
  eq((await client()('/api/register', { method: 'POST', body: { username: 'capuser2', password: PW } })).status, 200, '准备账号')
  const wrong = good.answer === 'AAAA' ? 'BBBB' : 'AAAA'
  const r = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: good.id, captchaText: wrong } })
  eq(r.status, 400, '状态码')
  eq(r.setCookie.filter((x) => x.startsWith('dsw_session=')).length, 0, '不该发会话 cookie')
  ok(/验证码/.test(String(r.data.error)), '错误文案该提验证码')
})
await t('验证码对了才轮到密码：密码错 → 401（不是 400）', async () => {
  const c = client(IP.force)
  const cap = await issue(c)
  const r = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: 'wrong-' + PW, captchaId: cap.id, captchaText: cap.answer } })
  eq(r.status, 401, '状态码')
  ok(!/验证码/.test(String(r.data.error)), `这时不该再提验证码，实测 ${JSON.stringify(r.data.error)}`)
})
await t('验证码全对 + 密码对 → 200 且种下 cookie', async () => {
  const c = client(IP.use)
  const cap = await issue(c)
  const r = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: cap.id, captchaText: cap.answer } })
  eq(r.status, 200, '状态码')
  ok(r.setCookie.some((x) => x.startsWith('dsw_session=')), '应种下会话 cookie')
  eq((await c('/api/me')).data.me.username, 'capuser2', '/api/me 应是本人')
})

// ── 三、一次性 / 次数 / 过期 / 绑 IP ────────────────────────────────────────
console.log('── 三、一次性 / 次数 / 过期 / 绑 IP ──')
await t('★ 一次性：同一个 id 用第二次 → 400', async () => {
  const c = client(IP.once)
  const cap = await issue(c)
  const first = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: cap.id, captchaText: cap.answer } })
  eq(first.status, 200, '第一次应当通过')
  const second = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: cap.id, captchaText: cap.answer } })
  eq(second.status, 400, '第二次必须被拒')
  ok(/验证码/.test(String(second.data.error)), '错误文案该提验证码')
})
await t('错满 3 次即作废：第 4 次就算填对也不认', async () => {
  const c = client(IP.tries)
  const cap = await issue(c)
  const wrong = (i) => 'ZZZZ'.slice(0, 4 - String(i).length) + i
  for (let i = 1; i <= 3; i++) {
    const r = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: cap.id, captchaText: wrong(i) } })
    eq(r.status, 400, `第 ${i} 次错答案`)
  }
  const after = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: cap.id, captchaText: cap.answer } })
  eq(after.status, 400, '作废后即使填对也必须被拒')
})
await t(`过期（>${TTL}ms）后用 → 400，文案说清是过期`, async () => {
  const c = client(IP.ttl)
  const cap = await issue(c)
  await sleep(TTL + 300)
  const r = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: cap.id, captchaText: cap.answer } })
  eq(r.status, 400, '状态码')
  ok(/过期|失效/.test(String(r.data.error)), `文案该说过期/失效，实测 ${JSON.stringify(r.data.error)}`)
})
await t('★ 绑来源 IP：A 领的题，B 拿着正确答案也用不了', async () => {
  const a = client(IP.bindIp)
  const cap = await issue(a)
  const b = client(IP.bindIp2)
  const r = await b('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: cap.id, captchaText: cap.answer } })
  eq(r.status, 400, '状态码')
  ok(/失效|过期/.test(String(r.data.error)), `文案该说失效，实测 ${JSON.stringify(r.data.error)}`)
})
await t('大小写、空格、全角空格都认（体验，不是安全）', async () => {
  const c = client(IP.case)
  const cap = await issue(c)
  const messy = [...cap.answer].join(' ').toLowerCase() + ' '
  const r = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: cap.id, captchaText: messy } })
  eq(r.status, 200, `输入 ${JSON.stringify(messy)} 应当通过`)
})
await t('空着不填给的是"照图填写"，不烧次数', async () => {
  const c = client(IP.tries)
  const cap = await issue(c)
  const empty = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: cap.id, captchaText: '   ' } })
  eq(empty.status, 400, '空输入')
  ok(/位字母数字/.test(String(empty.data.error)), `文案该说位数，实测 ${JSON.stringify(empty.data.error)}`)
  const right = await c('/api/login', { method: 'POST', body: { username: 'capuser2', password: PW, captchaId: cap.id, captchaText: cap.answer } })
  eq(right.status, 200, '空输入不该消耗次数，正确答案仍该通过')
})

// ── 四、领取限流与两条豁免通道 ──────────────────────────────────────────────
console.log('── 四、限流与豁免 ──')
await t(`同一 IP 一分钟内领超过 ${IP_LIMIT} 张 → 429`, async () => {
  const c = client(IP.limiter)
  let last = 0
  for (let i = 0; i <= IP_LIMIT; i++) last = (await c('/api/captcha')).status
  eq(last, 429, `第 ${IP_LIMIT + 1} 次`)
})
await t('本机直连（socket 127.0.0.1、无 x-real-ip）免验证码：注册 + 登录都能过', async () => {
  const c = client()
  const reg = await c('/api/register', { method: 'POST', body: { username: 'localuser', password: PW } })
  eq(reg.status, 200, '本机注册')
  const lg = await c('/api/login', { method: 'POST', body: { username: 'localuser', password: PW } })
  eq(lg.status, 200, '本机登录')
})
await t('带对 x-admin-token 的请求免验证码（口令本身就是全权凭证）', async () => {
  const c = client(IP.adminOk)
  const reg = await c('/api/register', { method: 'POST', body: { username: 'adminbypass', password: PW }, headers: { 'x-admin-token': ADMIN_TOKEN } })
  eq(reg.status, 200, '带对口令注册')
  const lg = await c('/api/login', { method: 'POST', body: { username: 'adminbypass', password: PW }, headers: { 'x-admin-token': ADMIN_TOKEN } })
  eq(lg.status, 200, '带对口令登录')
})
await t('口令**不对**时照样要验证码（不是"带个头就免"）', async () => {
  const c = client(IP.adminBad)
  const meta = await c('/api/meta', { headers: { 'x-admin-token': 'definitely-not-the-token' } })
  eq(meta.data.captcha.required, true, '错误口令不该获得豁免')
  const r = await c('/api/login', { method: 'POST', body: { username: 'adminbypass', password: PW }, headers: { 'x-admin-token': 'definitely-not-the-token' } })
  eq(r.status, 400, '错误口令 + 无验证码应被拒')
})
await t('验证码答案不落盘（data.json 里找不到任何一张的答案）', async () => {
  const raw = fs.readFileSync(path.join(DATA, 'data.json'), 'utf8')
  const c = client(IP.noStore)
  const rows = []
  for (let i = 0; i < 3; i++) rows.push(await issue(c))
  for (const row of rows) ok(!raw.includes(row.answer), `data.json 里不该出现答案 ${row.answer}`)
  ok(!raw.includes('captcha'), 'data.json 里不该有验证码字段')
})

// ── 收尾 ────────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓ 全绿' : '✗ 有红'}：${pass} 通过 / ${fail} 失败`)
if (reds.length) console.log('\n失败清单：\n' + reds.map((r) => '  · ' + r).join('\n'))
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响结论 */ }
process.exit(fail === 0 ? 0 : 1)
