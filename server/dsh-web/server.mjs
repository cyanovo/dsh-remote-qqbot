#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// DSH 通知插件 · 网页端服务（零依赖 Node）
//
// 监听 127.0.0.1:8795，由 nginx 的 80 端口站点反代到根路径 /
//   http://cyanovo.top/            → 这个服务（静态页 + /api）
//
// 契约（给插件/其他会话用）：
//   GET  /api/meta                     公开：三档模式定义、配额、保留时长、价格
//   GET  /api/captcha                  人机验证图片（一次性，3 分钟过期，绑来源 IP）
//   POST /api/register  {username,password,captchaId,captchaText}
//   POST /api/login     {username,password,captchaId,captchaText}   → 种下 dsw_session cookie
//                                      ↑ 这两个接口对**公网请求**强制要验证码；
//                                        本机直连（验收脚本）与带对 x-admin-token 的请求免验证（见「人机验证」一节）
//   POST /api/logout
//   GET  /api/me                       → 账号、配额、保留策略
//   POST /api/prefs     {mode}         → 保存默认全文模式
//   GET  /api/records?limit=50         → 自己最近 5 小时内的记录（元数据，不含正文）
//   POST /api/records/:id/view         → ★ 取全文，消耗 1 次配额
//   POST /api/publish   {username,title,text,mode}  需头 X-Publish-Token
//   POST /api/redeem    {code}         → 兑换码，解除每日上限
//   GET  /health
//
// 后台（/api/admin/*）—— 两种身份**并列**，任一种通过即可：
//   ① 请求头 x-admin-token: <服务器上 /var/lib/dsh-web/admin-token 的内容>
//      应急/bootstrap 通道：不依赖任何账号，数据文件被清空也照样能进。
//   ② 登录 cookie，且该账号 user.admin === true（日常通道）
//      谁是主人由环境变量 DSH_WEB_OWNER 声明（systemd 单元里设成 cyanovo）。
//   普通账号登录 → 403（**不计入口令失败次数**，免得访客随手一点就把主人的 IP 锁 10 分钟）
//
// 封禁（user.bannedAt）：被禁账号的登录、cookie、每账号发布令牌、发布接口**全线拦下**，
//   只留 /api/logout 与 /api/me（本人要能看见"我被封了"）与后台通道（否则解不开）。
//   **封禁绝不删数据**：解封后记录、令牌、档位一切如初。
//
// 设计约束（延续本项目一贯的取舍）：
//   · 账号/配额/记录全部落在单个 JSON 文件，原子写（tmp + rename）
//   · 密码用 scrypt 加盐，cookie 用 HMAC 签名；两者都不落明文
//   · 记录保留 5 小时（读写两侧都会 prune，不依赖定时器）
//   · 每日 100 次按 Asia/Shanghai 自然日计算（UTC+8 固定，无夏令时）
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WEB_ROOT || path.join(__dirname, 'public')
const DATA_DIR = process.env.DSH_WEB_DATA || '/var/lib/dsh-web'
const PORT = Number(process.env.DSH_WEB_PORT || 8795)
const HOST = process.env.DSH_WEB_HOST || '127.0.0.1'

const DAY_MS = 24 * 3600 * 1000
// 保留期：免费版 5 小时 / 付费版 48 小时。
// 两个都可用环境变量覆盖 —— **只为让 TTL 能被如实测出来**（否则要等 5 小时才能验一条记录过期）。
// 生产环境的 unit 里不设这两个变量，所以线上跑的就是默认值；`/api/meta` 会把实际生效值回显出来。
const RETENTION_MS = Number(process.env.DSH_WEB_RETENTION_MS || 5 * 3600 * 1000)      // 免费：5 小时
const PRO_RETENTION_MS = Number(process.env.DSH_WEB_PRO_RETENTION_MS || 48 * 3600 * 1000) // 付费版：48 小时
const FREE_DAILY = 100                       // 免费：每天 100 次完整查看
const PRO_DAILY = 1000                       // 付费版：每天 1000 次完整查看
const PRO_DAYS = 30                          // 一次支持 = 30 天
const PRICE_CNY = '2.99'
const TZ_OFFSET = 8 * 3600 * 1000            // Asia/Shanghai，固定 UTC+8
const COOKIE = 'dsw_session'
const SESSION_TTL = 30 * 24 * 3600 * 1000
const BODY_MAX = 512 * 1024
const RECORD_TEXT_MAX = 256 * 1024
// 设备码绑定（插件不用浏览器也能拿到自己的发布令牌）
const DEVICE_TTL_MS = 10 * 60 * 1000         // 短码 10 分钟有效，一次性
const DEVICE_POLL_INTERVAL = 3               // 插件轮询间隔（秒）
const DEVICE_IP_LIMIT = 10                   // 每 IP 每分钟最多 10 次 device 请求
const DEVICE_IP_WINDOW_MS = 60 * 1000
const DEVICE_IP_LOCK_MS = 10 * 60 * 1000     // 超限锁 10 分钟
// 登录 / 注册限流（2026-10-04 安全审计补的闸）：
// 这两个接口是**唯二不需要任何凭证**的猜密码 / 刷号入口，而此前只有 device 有闸 ——
// 审计实测「25 次错密码全部 401（2070 ms）后，正确密码仍能登录」。
const AUTH_IP_LIMIT = 30                     // 每 IP 每分钟最多 30 次登录 + 注册
                                             // （30 而不是更低：验收脚本一轮要跑十几次登录/注册，
                                             //   定太低会让"自己把自己锁上"变成假红。定向爆破另有按账号的锁兜底。）
const AUTH_IP_WINDOW_MS = 60 * 1000
const AUTH_IP_LOCK_MS = 10 * 60 * 1000
const LOGIN_FAIL_LIMIT = 10                  // 同一账号 10 分钟内最多 10 次失败
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000
const LOGIN_LOCK_MS = 10 * 60 * 1000
// 人机验证（登录 / 注册）。细节与取舍见下面「人机验证」那一节。
const CAPTCHA_LEN = 4                        // 字符数
const CAPTCHA_MAX_TRIES = 3                  // 同一个 id 最多猜 3 次，第 3 次错就作废
const CAPTCHA_TTL_MS = Number(process.env.DSH_WEB_CAPTCHA_TTL_MS || 3 * 60 * 1000)
                                             // ↑ 可用环境变量调短：**只为让「过期」能被如实测出来**，
                                             //   生产 unit 不设它，线上就是 3 分钟。
const CAPTCHA_IP_LIMIT = Number(process.env.DSH_WEB_CAPTCHA_IP_LIMIT || 60)  // 每 IP 每分钟最多领 60 张
const CAPTCHA_IP_WINDOW_MS = 60 * 1000
const CAPTCHA_IP_LOCK_MS = 10 * 60 * 1000
// 去掉 0/O/1/I/L：验证码要能一眼看清，认错了不是安全问题，是白挨一次失败
const CAPTCHA_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
// 🔴 只给验收脚本用：把答案一并回给调用方。生产 unit 里**不设**这个变量，
//    所以线上 `/api/captcha` 的响应里根本没有 answer 字段（verify-captcha.mjs 对此有断言）。
const CAPTCHA_TEST = process.env.DSH_WEB_CAPTCHA_TEST === '1'
// 用户码字母表：去掉 0/O/1/I/L 这些看错的字符
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
// 对外地址（只用于给人看的提示文字；nginx 那边才是权威）
const PUBLIC_BASE = process.env.DSH_WEB_PUBLIC_BASE || ''

const MODES = [
  {
    id: 'chat',
    name: '直接发到 QQ',
    short: '全文出现在 QQ 消息里',
    detail: '完整回答直接发到 QQ 聊天窗口，长文自动分段（每段带 (i/n) 序号）。不占用服务器次数。',
    cost: 0,
    link: false,
  },
  {
    id: 'note',
    name: '只看网页（不带链接）',
    short: 'QQ 只给摘要，正文在网页',
    detail: 'QQ 里只发一句摘要，完整回答存到服务器，在「我的记录」里打开。每次打开消耗 1 次。',
    cost: 1,
    link: false,
  },
  {
    id: 'note-link',
    name: '网页 + 可点链接',
    short: '摘要里带一个能点开的链接',
    detail: '与上一档相同，摘要末尾多一个链接，手机 QQ 里可以直接点开。每次打开消耗 1 次。',
    cost: 1,
    link: true,
  },
]
const MODE_IDS = MODES.map((m) => m.id)

// ── 小工具 ───────────────────────────────────────────────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64url')
const nowMs = () => Date.now()

/** 北京时间当天键 YYYY-MM-DD */
function dayKey(ts = nowMs()) {
  return new Date(ts + TZ_OFFSET).toISOString().slice(0, 10)
}
/** 下一次配额重置的时刻（北京时间次日 0 点） */
function nextResetAt(ts = nowMs()) {
  const sh = new Date(ts + TZ_OFFSET)
  return Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() + 1) - TZ_OFFSET
}
function newId(n = 6) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789'
  let s = ''
  const r = crypto.randomBytes(n)
  for (let i = 0; i < n; i++) s += a[r[i] % a.length]
  return s
}
/** 8 位用户码，形如 `ABCD-EFGH`（短码只用于**浏览器里点确认**，本身永远换不出令牌） */
function newUserCode() {
  const r = crypto.randomBytes(8)
  let s = ''
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[r[i] % USER_CODE_ALPHABET.length]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}
/** 长令牌/设备码：只存 sha256，明文只在生成的那一次返回 */
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex')
const newSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
/** 用户码比较：统一去掉连字符与空格，再比大写 */
const normCode = (v) => String(v || '').toUpperCase().replace(/[\s-]/g, '')

// ── 存储 ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 })
const DB_FILE = path.join(DATA_DIR, 'data.json')
const SECRET_FILE = path.join(DATA_DIR, 'secret')
const PUBLISH_FILE = path.join(DATA_DIR, 'publish-token')

function readOrCreate(file, gen, mode = 0o600) {
  try {
    const v = fs.readFileSync(file, 'utf8').trim()
    if (v) return v
  } catch { /* 不存在就生成 */ }
  const v = gen()
  fs.writeFileSync(file, v + '\n', { mode })
  return v
}
const SECRET = readOrCreate(SECRET_FILE, () => crypto.randomBytes(32).toString('base64url'))
const PUBLISH_TOKEN = readOrCreate(PUBLISH_FILE, () => crypto.randomBytes(24).toString('base64url'))

// ── 后台管理口令 ─────────────────────────────────────────────────────────────
// 为什么是**单独一把**、而不是复用 PUBLISH_TOKEN：三把钥匙的作用域差一个数量级
// （用户令牌 < 全局发布令牌 < 后台口令），共用一把等于把最贵的那把挂在最外面。
// 文件权限 0600，只落在服务器上；换口令 = 改这个文件 + `systemctl restart dsh-web`。
const ADMIN_FILE = path.join(DATA_DIR, 'admin-token')
const ADMIN_TOKEN = readOrCreate(ADMIN_FILE, () => crypto.randomBytes(24).toString('base64url'))
// 后台口令是**唯一一把不需要登录就能调的高权凭证**，必须限流：连续失败 10 次锁 10 分钟。
const ADMIN_FAIL_LIMIT = 10
const ADMIN_WINDOW_MS = 10 * 60 * 1000
const ADMIN_LOCK_MS = 10 * 60 * 1000
/** 「永久」付费版：一个明确的到期时刻（9999-12-31），比 "无限期" 这种状态好推理得多。 */
const FOREVER_MS = Date.UTC(9999, 11, 31)

// ── 账号级「管理员」身份 ─────────────────────────────────────────────────────
// 与上面的后台口令是**两条并列**的通道，不是替代关系：
//   · 口令（ADMIN_TOKEN）：服务器上读得到 /var/lib/dsh-web/admin-token 就能进 ——
//     应急/bootstrap 通道，不依赖任何账号（data.json 被清空也照样能进）。这次改动**没有削弱它**。
//   · 账号（user.admin === true）：登录后即可进后台，换机器/换浏览器不用抄口令 —— 日常用这条。
// 谁是主人由环境变量 DSH_WEB_OWNER 声明（systemd 单元里设成 cyanovo），启动时若该账号已存在就补管理员位。
// 🔴 为什么不是「第一个注册的人就是管理员」：注册接口是**公开的**，那等于把后台送给第一个访客。
//    名字写在单元里，攻击者改不了；DB 万一被清空，重启一次就自动恢复。
const OWNER_USERNAME = String(process.env.DSH_WEB_OWNER || '').trim()
function isAdminUser(name) {
  return !!(name && db.users[name] && db.users[name].admin === true)
}
/** 还能用后台的管理员账号（没被封、还在）。「不能把最后一个管理员锁在门外」这条规则靠它。 */
function activeAdmins() {
  return Object.entries(db.users).filter(([, u]) => u.admin === true && !u.bannedAt).map(([n]) => n)
}
/**
 * 这一下会不会让**最后一个还能用的管理员**失去后台权限？
 * 封禁 / 降级 / 删号三种操作共用。返回 true 时必须拒绝（否则谁也进不去，只能登服务器改 JSON）。
 */
function losesLastAdmin(name, kind) {
  const u = db.users[name]
  if (!u || u.admin !== true || u.bannedAt) return false   // 本来就不是"在用的管理员"，随便动
  if (activeAdmins().filter((n) => n !== name).length > 0) return false
  return kind === 'ban' || kind === 'demote' || kind === 'delete'
}

function emptyDB() {
  return { version: 2, users: {}, records: [], codes: {}, devices: {} }
}
let db = emptyDB()
try {
  const raw = fs.readFileSync(DB_FILE, 'utf8')
  const parsed = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && parsed.users) db = parsed
} catch (err) {
  if (err && err.code !== 'ENOENT') log(`数据文件读取失败（已按空库启动）：${err.message}`)
}
// 老库（version 1）没有 devices；用户也可能只有布尔 upgraded、没有期限
db.devices = db.devices || {}
// ⚠️ 这个标志必须在循环**之前**声明：`let` 是 TDZ 的，先赋值后声明会直接 ReferenceError。
let saveDBNeeded = false
for (const [name, u] of Object.entries(db.users)) {
  if (!u.tokens) u.tokens = {}
  // 累计查看次数必须**自己存一份**：`usage` 是"按天"的，后台一清今日额度（或那天过去了）
  // 就再也算不出历史累计。缺这个字段的老库按当时的 usage 之和补一次。
  if (typeof u.viewsTotal !== 'number') {
    u.viewsTotal = Object.values(u.usage || {}).reduce((s, n) => s + (Number(n) || 0), 0)
    saveDBNeeded = true
  }
  if (u.upgraded === true && !u.proUntil) {
    // 老语义是「永久升级」。这里把它换成一个**明确的到期时刻**，而不是继续无限期：
    // 从当下起补 30 天（宁可多给，不可把已经付过的人一刀砍掉）。
    u.proUntil = nowMs() + PRO_DAYS * DAY_MS
    log(`迁移老账号 ${name}：upgraded=true → proUntil=+${PRO_DAYS} 天`)
    saveDBNeeded = true
  }
}

let writeChain = Promise.resolve()
function saveDB() {
  // 串行化写入，避免并发请求互相覆盖；原子替换，避免半截文件
  writeChain = writeChain.then(async () => {
    const tmp = `${DB_FILE}.${process.pid}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(db), { mode: 0o600 })
    await fs.promises.rename(tmp, DB_FILE)
  }).catch((err) => log(`落盘失败：${err.message}`))
  return writeChain
}
// 主人账号的管理员位：由 DSH_WEB_OWNER 声明，启动时补一次（补完就持久化在 data.json 里）
if (OWNER_USERNAME && db.users[OWNER_USERNAME] && db.users[OWNER_USERNAME].admin !== true) {
  db.users[OWNER_USERNAME].admin = true
  console.log(`[dsh-web] 已把 ${OWNER_USERNAME} 设为管理员（来自环境变量 DSH_WEB_OWNER）`)
  saveDBNeeded = true
}

// 迁移结果必须落盘（否则每次重启都重新补一次 30 天）
if (saveDBNeeded) saveDB()

function log(...args) {
  process.stdout.write(`[dsh-web] ${args.join(' ')}\n`)
}

/**
 * 过期清理：**按每条记录自己的 expiresAt**，不再用一个全局窗口。
 * 免费版 5 小时、付费版 48 小时 —— 两者混在同一个数组里，所以必须逐条判。
 */
function pruneRecords(ts = nowMs()) {
  const before = db.records.length
  db.records = db.records.filter((r) => {
    const expiresAt = Number(r.expiresAt) || r.createdAt + RETENTION_MS
    return ts < expiresAt
  })
  return before - db.records.length
}
/** 顺手清掉过期的设备码（它们和记录一样有 TTL） */
function pruneDevices(ts = nowMs()) {
  let dropped = 0
  for (const [k, d] of Object.entries(db.devices)) {
    if (ts >= Number(d.expiresAt || 0)) { delete db.devices[k]; dropped++ }
  }
  return dropped
}

// ── 密码与会话 ───────────────────────────────────────────────────────────────
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex')
  return { salt, hash }
}
function checkPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false
  const got = crypto.scryptSync(String(password), user.salt, 32)
  const want = Buffer.from(user.hash, 'hex')
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}
function signSession(payload) {
  const body = b64u(JSON.stringify(payload))
  const sig = b64u(crypto.createHmac('sha256', SECRET).update(body).digest())
  return `${body}.${sig}`
}
function readSession(cookieHeader) {
  const raw = (cookieHeader || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`))
  if (!raw) return null
  const value = decodeURIComponent(raw.slice(COOKIE.length + 1))
  const [body, sig] = value.split('.')
  if (!body || !sig) return null
  const want = b64u(crypto.createHmac('sha256', SECRET).update(body).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(want)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let payload
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
  if (!payload || payload.exp < nowMs()) return null
  return payload
}
// ── 会话的「世代号」────────────────────────────────────────────────────────────
// 无状态 HMAC 会话**没有**服务端吊销列表，所以"改密码"以前踢不掉已经登录的人
// （审计实测：改密后旧 cookie 仍能读 /api/me 200）。世代号是补它的最小代价办法：
// 改密码时 epoch +1，所有旧 cookie 立刻作废。
// 兼容老 cookie：没有 e 字段按 0 处理；用户 epoch 默认也是 0 ⇒
// 部署本身不会把任何人踢下线，只有**真的改了密码**才作废。
function epochOf(user) { return Number(user && user.epoch) || 0 }
function sessionEpochOk(session, user) {
  return (Number.isInteger(session.e) ? session.e : 0) === epochOf(user)
}
/** 从 cookie 解析出「这次是谁」，并把过期/被吊销（改过密码）的会话一并判死。 */
function sessionUser(cookieHeader) {
  const s = readSession(cookieHeader)
  if (!s || !s.u) return null
  const u = db.users[s.u]
  if (!u || !sessionEpochOk(s, u)) return null
  return s.u
}

// ── HTTP 小工具 ──────────────────────────────────────────────────────────────
function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(code, {
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(buf)
}
function json(res, code, obj, headers = {}) {
  send(res, code, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_MAX) { reject(new Error('body-too-large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('bad-json')) }
    })
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath)
  if (rel === '/' || rel === '') rel = '/index.html'
  const full = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''))
  if (!full.startsWith(ROOT + path.sep) && full !== path.join(ROOT, 'index.html')) {
    return send(res, 400, 'bad path')
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      if (urlPath !== '/' && !path.extname(urlPath)) {
        // 前端是单页，未知路径一律回首页（但明显是资源请求的返回 404）
        return fs.readFile(path.join(ROOT, 'index.html'), (e2, idx) => {
          if (e2) return send(res, 404, 'not found')
          send(res, 200, idx, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
        })
      }
      return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    const ext = path.extname(full).toLowerCase()
    send(res, 200, buf, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    })
  })
}

// ── 账号视图 ─────────────────────────────────────────────────────────────────
// ── 档位：一切「多少钱、多少额度、保留多久」都从 proUntil 派生 ────────────────
// 🔴 以前这里只有一个布尔 `upgraded`，而升级后 `limit = null`（= 不限次数）且**永不过期**。
//    那既不符合「2.99 元 = 一个月」，也把「一天 1000 次」这条承诺作废了。
//    现在唯一的事实来源是 **proUntil（到期时刻）**，额度与保留期都是它的函数。
function proActive(user, ts = nowMs()) {
  return !!user && Number(user.proUntil || 0) > ts
}
function planOf(user, ts = nowMs()) {
  return proActive(user, ts) ? 'pro' : 'free'
}
function dailyLimitOf(user, ts = nowMs()) {
  return proActive(user, ts) ? PRO_DAILY : FREE_DAILY
}
function retentionOf(user, ts = nowMs()) {
  return proActive(user, ts) ? PRO_RETENTION_MS : RETENTION_MS
}
/** 给人看的中文时长：5 小时 / 48 小时；不足一小时就说秒（验收时会把 TTL 调短，别显示成「0.0 小时」） */
function hoursText(ms) {
  if (ms < 3600000) return `${Math.round(ms / 1000)} 秒`
  const h = ms / 3600000
  return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`
}
function quotaOf(user) {
  const key = dayKey()
  const used = (user.usage && user.usage[key]) || 0
  const limit = dailyLimitOf(user)
  const active = proActive(user)
  return {
    plan: active ? 'pro' : 'free',
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetAt: nextResetAt(),
    upgraded: active,                       // 向后兼容：老前端读这个字段
    proUntil: active ? Number(user.proUntil) : null,
    retentionMs: retentionOf(user),
    retentionText: hoursText(retentionOf(user)),
  }
}
function meView(username) {
  const user = db.users[username]
  if (!user) return null
  return {
    username,
    upgraded: proActive(user),              // 向后兼容
    plan: planOf(user),
    proUntil: proActive(user) ? Number(user.proUntil) : null,
    mode: user.mode || 'note-link',
    createdAt: user.createdAt,
    quota: quotaOf(user),
    // 前端据此决定要不要显示「管理」入口 —— **这不是权限本身**，服务端每次请求都现查 db。
    admin: user.admin === true,
    banned: !!user.bannedAt,
    banReason: user.banReason || '',
  }
}
function recordMeta(r) {
  // 每条记录自己带着到期时刻（发布时就按发布者当时的档位算好了），
  // 所以「有人在 48 小时里升级/掉档」都不会篡改已经存下的记录。
  const expiresAt = Number(r.expiresAt) || r.createdAt + RETENTION_MS
  return {
    id: r.id,
    title: r.title,
    mode: r.mode,
    chars: r.chars,
    createdAt: r.createdAt,
    expiresAt,
    retentionText: hoursText(expiresAt - r.createdAt),
  }
}

// ── 路由 ─────────────────────────────────────────────────────────────────────
function validName(v) { return typeof v === 'string' && /^[A-Za-z0-9_\u4e00-\u9fa5-]{2,24}$/.test(v) }
function validPass(v) { return typeof v === 'string' && v.length >= 6 && v.length <= 128 }

/**
 * 发布鉴权 —— 两条路，**按身份的强弱分开**：
 *   1. `Authorization: Bearer <每账号令牌>`：只能以自己的身份发布。这是插件用的路。
 *      🔴 以前只有一条全局 `x-publish-token`，谁拿到它就能以**任意用户名**发记录 —— 多租户下
 *         这是最严重的隔离缺口（冒充、污染别人「我的记录」）。所以现在每账号一把，
 *         且令牌只存 sha256，库里翻不出明文。
 *   2. `x-publish-token: <全局令牌>`：**管理员**通道（主人给自己用），必须显式带 username。
 * 另外：用户令牌**不许**在 body 里指定别人 —— 指定了就直接 403，不做"忽略"处理，
 * 免得出现"以为发出去了、其实发到别处"这种最难查的错。
 */
function resolvePublish(req) {
  const auth = String(req.headers.authorization || '')
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (bearer) {
    const hit = findTokenUser(bearer)
    if (hit) {
      // 账号被封 → 令牌同时失效。单独给一个 kind：好让调用方回一句"账号被封了"，
      // 而不是含糊的"令牌无效"（那种提示会让人以为是自己抄错了令牌）。
      const owner = db.users[hit.username]
      if (owner && owner.bannedAt) return { kind: 'banned-user-token', username: hit.username }
      return { kind: 'user', username: hit.username, tokenHash: hit.hash, token: hit.token }
    }
    return { kind: 'bad-user-token' }
  }
  const admin = req.headers['x-publish-token']
  if (admin && admin === PUBLISH_TOKEN) return { kind: 'admin' }
  return { kind: 'none' }
}

/**
 * 在 `db.users[*].tokens` 里按 sha256 找这把令牌属于谁。
 * 库里只存哈希，所以**必须逐个账号比对**（规模小，够用；真要大了再上索引）。
 *
 * @returns {{username: string, hash: string, token: object}|null}
 */
function findTokenUser(plain) {
  if (!plain) return null
  const h = sha256(plain)
  for (const [username, u] of Object.entries(db.users)) {
    const t = u.tokens && u.tokens[h]
    if (t) return { username, hash: h, token: t }
  }
  return null
}
function issueUserToken(username, label = '') {
  const plain = newSecret(32)
  const h = sha256(plain)
  const user = db.users[username]
  user.tokens = user.tokens || {}
  user.tokens[h] = { createdAt: nowMs(), lastUsedAt: null, label: String(label || '').slice(0, 40) }
  return plain
}

// ── device 接口的每 IP 限流（10 次/分钟，超了锁 10 分钟）────────────────────────
// 为什么单给 device 限流：它是**唯一不需要登录**就能创建数据库条目的写接口，
// 不限流就等于给了一个「随手刷爆 data.json」的入口。
const deviceHits = new Map()   // ip -> { hits: number[], lockedUntil: number }
function clientIp(req) {
  const real = req.headers['x-real-ip']
  if (real) return String(real).trim()
  const xff = String(req.headers['x-forwarded-for'] || '')
  if (xff) return xff.split(',')[0].trim()
  return (req.socket && req.socket.remoteAddress) || 'unknown'
}
function deviceRateLimit(ip, ts = nowMs()) {
  let rec = deviceHits.get(ip)
  if (!rec) { rec = { hits: [], lockedUntil: 0 }; deviceHits.set(ip, rec) }
  if (rec.lockedUntil > ts) return { ok: false, retryAfterMs: rec.lockedUntil - ts }
  rec.hits = rec.hits.filter((t) => ts - t < DEVICE_IP_WINDOW_MS)
  if (rec.hits.length >= DEVICE_IP_LIMIT) {
    rec.lockedUntil = ts + DEVICE_IP_LOCK_MS
    log(`device 接口限流：${ip} 一分钟内 ${rec.hits.length} 次，锁 ${DEVICE_IP_LOCK_MS / 60000} 分钟`)
    return { ok: false, retryAfterMs: DEVICE_IP_LOCK_MS }
  }
  rec.hits.push(ts)
  if (deviceHits.size > 5000) {   // 别让这个表自己变成内存泄漏
    for (const [k, v] of deviceHits) if (v.lockedUntil < ts && !v.hits.some((t) => ts - t < DEVICE_IP_WINDOW_MS)) deviceHits.delete(k)
  }
  return { ok: true }
}

// ── 登录 / 注册限流（每 IP + 每账号，两把闸都要）────────────────────────────
// 按 IP：挡「一个来源狂试一堆账号」（撞库）。
// 按账号：挡「换 IP 狂试同一个账号」（定向爆破）—— 只按 IP 记，换代理就绕过去了。
const authHits = new Map()     // ip -> { hits: number[], lockedUntil: number }
const loginFails = new Map()   // 小写用户名 -> { n, at, lockedUntil }
function authRateLimit(ip, ts = nowMs()) {
  let rec = authHits.get(ip)
  if (!rec) { rec = { hits: [], lockedUntil: 0 }; authHits.set(ip, rec) }
  if (rec.lockedUntil > ts) return { ok: false, retryAfterMs: rec.lockedUntil - ts }
  rec.hits = rec.hits.filter((t) => ts - t < AUTH_IP_WINDOW_MS)
  if (rec.hits.length >= AUTH_IP_LIMIT) {
    rec.lockedUntil = ts + AUTH_IP_LOCK_MS
    log(`⚠️ 登录/注册限流：${ip} 一分钟内 ${rec.hits.length} 次，锁 ${AUTH_IP_LOCK_MS / 60000} 分钟`)
    return { ok: false, retryAfterMs: AUTH_IP_LOCK_MS }
  }
  rec.hits.push(ts)
  if (authHits.size > 5000) {   // 别让这张表自己变成内存泄漏
    for (const [k, v] of authHits) if (v.lockedUntil < ts && !v.hits.some((t) => ts - t < AUTH_IP_WINDOW_MS)) authHits.delete(k)
  }
  return { ok: true }
}
function loginLockLeft(name, ts = nowMs()) {
  const rec = loginFails.get(String(name || '').toLowerCase())
  return rec && rec.lockedUntil > ts ? rec.lockedUntil - ts : 0
}
function loginFail(name, ts = nowMs()) {
  const key = String(name || '').toLowerCase()
  let rec = loginFails.get(key)
  if (!rec || ts - rec.at > LOGIN_FAIL_WINDOW_MS) rec = { n: 0, at: ts, lockedUntil: 0 }
  rec.n += 1
  rec.at = ts
  if (rec.n >= LOGIN_FAIL_LIMIT) {
    rec.lockedUntil = ts + LOGIN_LOCK_MS
    log(`⚠️ 账号 ${key} 连续 ${rec.n} 次密码不对，锁 ${LOGIN_LOCK_MS / 60000} 分钟`)
  }
  loginFails.set(key, rec)
  if (loginFails.size > 5000) {
    for (const [k, v] of loginFails) if (v.lockedUntil < ts && ts - v.at > LOGIN_FAIL_WINDOW_MS) loginFails.delete(k)
  }
  return rec
}
function loginSucceed(name) { loginFails.delete(String(name || '').toLowerCase()) }
/** 反枚举：账号不存在时也要付**同样的** scrypt 代价，否则响应时间本身就在回答"这账号存不存在"。
 *  审计实测（本地、同一台机）：存在的用户名中位 45 ms vs 不存在 2 ms = 22.5 倍。 */
const DUMMY_PW = hashPassword('timing-equalization-dummy')
function checkPasswordOrDummy(password, user) {
  if (user) return checkPassword(password, user)
  checkPassword(password, DUMMY_PW)
  return false
}

// ── 人机验证（登录 / 注册）──────────────────────────────────────────────────
// 为什么自研图形码，而不接 reCAPTCHA / hCaptcha / Turnstile：
//   本站用户几乎全是在**手机 QQ 内置浏览器**里点开 http://cyanovo.top（80 端口是故意留的，
//   不做跳转也不加 HSTS），而这几个第三方挑战脚本的域名在国内网络里经常拉不下来。
//   一旦拉不下来，「人机验证」就变成「谁都登不进来」——这是把可用性押在别人身上。
//   自研的只依赖本站一个 GET：图片是服务端现画的 SVG，跟 JSON 一起回来，断网/被墙都不影响。
//
// 三条硬约束（都有断言钉着）：
//   1. **一次性** —— 校验通过立刻从内存删掉，同一个 id 拿不到第二次；
//   2. **短命** —— 3 分钟过期；同一个 id 最多猜 3 次，第 3 次错就作废（防"慢慢试"）；
//   3. **绑来源 IP** —— 签发与使用必须同一个 IP，防"这边领题、那边刷"。
// 答案既不落盘也不进日志，内存里只留 sha256(SECRET + 答案)。
//
// 两种**不收验证码**的请求，都不是给外人留的门：
//   · 本机直连：socket 对端是回环地址、且没有经 nginx 来的 x-real-ip。
//     8795 只监听 127.0.0.1，公网根本连不到这条路；验收脚本（verify-*.mjs）走的就是它。
//   · 带对了 x-admin-token：后台口令本身就是全权凭证，用它跳过验证码不会多给出任何权限。
const captchas = new Map()       // id -> { h, ip, exp, tries }
const captchaHits = new Map()    // ip -> { hits: number[], lockedUntil: number }
const isLoopbackAddr = (a) => {
  const s = String(a || '')
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1'
}
function captchaExempt(req) {
  const socketIp = (req.socket && req.socket.remoteAddress) || ''
  const real = String(req.headers['x-real-ip'] || '').trim()
  // 两个条件都要：nginx 反代公网请求时，socket 对端也是 127.0.0.1（nginx 在本机），
  // 但那时一定带着 x-real-ip = 真实公网 IP。只看 socket 会把所有人放进来。
  if (isLoopbackAddr(socketIp) && (!real || isLoopbackAddr(real))) return true
  const given = adminTokenFrom(req)
  return !!given && tokenEq(given, ADMIN_TOKEN)
}
function captchaRateLimit(ip, ts = nowMs()) {
  let rec = captchaHits.get(ip)
  if (!rec) { rec = { hits: [], lockedUntil: 0 }; captchaHits.set(ip, rec) }
  if (rec.lockedUntil > ts) return { ok: false, retryAfterMs: rec.lockedUntil - ts }
  rec.hits = rec.hits.filter((t) => ts - t < CAPTCHA_IP_WINDOW_MS)
  if (rec.hits.length >= CAPTCHA_IP_LIMIT) {
    rec.lockedUntil = ts + CAPTCHA_IP_LOCK_MS
    log(`⚠️ 验证码领取限流：${ip} 一分钟内 ${rec.hits.length} 次，锁 ${CAPTCHA_IP_LOCK_MS / 60000} 分钟`)
    return { ok: false, retryAfterMs: CAPTCHA_IP_LOCK_MS }
  }
  rec.hits.push(ts)
  if (captchaHits.size > 5000) {   // 别让这张表自己变成内存泄漏
    for (const [k, v] of captchaHits) if (v.lockedUntil < ts && !v.hits.some((t) => ts - t < CAPTCHA_IP_WINDOW_MS)) captchaHits.delete(k)
  }
  return { ok: true }
}
const captchaNormalize = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^0-9A-Z]/g, '')
const captchaHash = (answer) => crypto.createHash('sha256').update(`${SECRET}:captcha:${answer}`).digest('hex')
/**
 * 画一张验证码。刻意做成**图片**而不是"算术题文字"：算术题的答案能直接被正则抓走
 * （页面上明摆着 3+5=?），图形码至少要走一遍识别。
 * 每个字随机字号/旋转/上下偏移，再叠三道干扰曲线、十几个噪点，最后过一遍湍流位移滤镜。
 * 滤镜不被支持时（老浏览器）图照样能看 —— 只是没被扭曲，不会变成"看不见题目"。
 */
function captchaSvg(code) {
  const W = 132
  const H = 44
  const rand = (a, b) => a + Math.random() * (b - a)
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
  const inks = ['#1e63c8', '#b3261e', '#1d7a4d', '#7a4dbb', '#a15c00', '#0f6f8c']
  const parts = [`<rect width="${W}" height="${H}" fill="#f5f7fa"/>`]
  for (let i = 0; i < 3; i++) {
    const y = Math.round(rand(6, H - 6))
    parts.push(`<path d="M0 ${y} Q ${(W * 0.35).toFixed(0)} ${(y + rand(-9, 9)).toFixed(0)} ${(W * 0.7).toFixed(0)} ${(y + rand(-6, 6)).toFixed(0)} T ${W} ${(y + rand(-8, 8)).toFixed(0)}" fill="none" stroke="${pick(inks)}" stroke-opacity="0.45" stroke-width="${rand(0.7, 1.5).toFixed(1)}"/>`)
  }
  for (let i = 0; i < 18; i++) {
    parts.push(`<circle cx="${rand(2, W - 2).toFixed(1)}" cy="${rand(2, H - 2).toFixed(1)}" r="${rand(0.4, 1.1).toFixed(1)}" fill="${pick(inks)}" fill-opacity="0.35"/>`)
  }
  const step = W / (code.length + 1)
  for (let i = 0; i < code.length; i++) {
    const x = step * (i + 0.5) + rand(-3, 3)
    const y = H / 2 + rand(-3, 3)
    parts.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${pick(inks)}" font-size="${rand(21, 27).toFixed(1)}"`
      + ` font-family="Verdana, DejaVu Sans, Arial, sans-serif" font-weight="700" text-anchor="middle"`
      + ` dominant-baseline="central" transform="rotate(${rand(-26, 26).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${code[i]}</text>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="人机验证图片">`
    + `<defs><filter id="w"><feTurbulence type="turbulence" baseFrequency="0.035 0.09" numOctaves="2" seed="${Math.floor(rand(1, 999))}" result="t"/>`
    + '<feDisplacementMap in="SourceGraphic" in2="t" scale="2.4" xChannelSelector="R" yChannelSelector="G"/></filter></defs>'
    + `<g filter="url(#w)">${parts.join('')}</g></svg>`
}
function newCaptcha(ip) {
  const ts = nowMs()
  if (captchas.size > 200) {   // 顺手清过期的，别让表越滚越大
    for (const [k, v] of captchas) if (v.exp < ts) captchas.delete(k)
  }
  if (captchas.size > 5000) captchas.clear()   // 极端情况兜底：宁可让大家重领一张，也不拖垮内存
  let code = ''
  for (let i = 0; i < CAPTCHA_LEN; i++) code += CAPTCHA_ALPHABET[Math.floor(Math.random() * CAPTCHA_ALPHABET.length)]
  const id = crypto.randomBytes(12).toString('base64url')
  captchas.set(id, { h: captchaHash(code), ip, exp: ts + CAPTCHA_TTL_MS, tries: 0 })
  return { id, svg: captchaSvg(code), answer: code }
}
/**
 * 校验一张验证码。返回 `{ok:true}` / `{ok:false, error}`。
 * ⚠️ 失败**不计**入「账号密码失败次数」：否则脚本狂刷错验证码就能把别人的账号锁 10 分钟
 *    （那是拿验证码当武器打人）。验证码自己那 3 次上限已经够用了。
 */
function checkCaptcha(req, id, text) {
  if (captchaExempt(req)) return { ok: true, skipped: true }
  const key = String(id || '').trim()
  const ts = nowMs()
  if (!key) return { ok: false, error: '请先填写图片里的验证码' }
  const rec = captchas.get(key)
  if (!rec || rec.exp < ts) {
    if (rec) captchas.delete(key)
    return { ok: false, error: '验证码已过期，请点「换一张」重新获取' }
  }
  const ip = clientIp(req)
  if (rec.ip !== ip) {
    captchas.delete(key)   // 换了来源：作废，别让它被搬到别处用
    log(`⚠️ 验证码来源 IP 变了（${rec.ip} → ${ip}），作废`)
    return { ok: false, error: '验证码已失效，请点「换一张」重新获取' }
  }
  const ans = captchaNormalize(text)
  if (ans.length < CAPTCHA_LEN) return { ok: false, error: `验证码是 ${CAPTCHA_LEN} 位字母数字，请照图填写` }
  if (tokenEq(captchaHash(ans), rec.h)) {
    captchas.delete(key)   // 一次性：用过即废，同一个 id 不能再换一次登录
    return { ok: true }
  }
  rec.tries += 1
  if (rec.tries >= CAPTCHA_MAX_TRIES) {
    captchas.delete(key)
    return { ok: false, error: '验证码错了 3 次，已作废，请点「换一张」重填' }
  }
  return { ok: false, error: `验证码不对（还能试 ${CAPTCHA_MAX_TRIES - rec.tries} 次）` }
}

// ── 会话 cookie 的属性 ──────────────────────────────────────────────────────
// 走 TLS 时**必须**带 Secure：否则同一个 cookie 会在任何 http 请求里被明文发出去。
// 本站 80 端口是**故意**开着的（QQ 里的链接全是 http 大写域名），所以这不是理论问题 ——
// 审计实测改前「HttpOnly ✅ SameSite=Lax ✅ Secure ❌」。
// 用 x-forwarded-proto 判断：8795 只监听 127.0.0.1，两台 nginx（80 用 $scheme、443 写死 https）
// 都覆盖了这个头，所以它和 x-real-ip 一样无法被外部伪造。**换反代时必须重看这一条。**
function isTls(req) { return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' }
function sessionCookie(req, token) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${isTls(req) ? '; Secure' : ''}; Max-Age=${SESSION_TTL / 1000}`
}
function clearSessionCookie(req) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax${isTls(req) ? '; Secure' : ''}; Max-Age=0`
}

// ── 后台管理（只有主人用）─────────────────────────────────────────────────────
// 口令是**单独一把**（DATA_DIR/admin-token），与登录 cookie、用户发布令牌、全局发布令牌
// 三者完全分立。这是唯一一把「不需要登录就能调」的高权凭证，所以：
//   ① 连续失败 10 次锁 10 分钟；
//   ② 比对走 sha256 + timingSafeEqual（长度恒定，不泄露前缀）；
//   ③ **普通用户令牌在这里一律 401** —— 这是隐私边界，有断言守着。
// 另外一条刻意的克制：后台**看不到任何人的正文**（记录列表只给元信息）。
// 主人要的是「管用户、看使用情况」，不是「翻别人的回答」；不给这个能力，
// 口令万一泄露也不会连带泄露用户内容。
// （ADMIN_FILE / ADMIN_TOKEN / ADMIN_FAIL_LIMIT / ADMIN_WINDOW_MS / ADMIN_LOCK_MS / FOREVER_MS
//   都声明在文件上半部分「后台管理口令」那一节，这里不再重复声明。）
const adminHits = new Map()   // ip -> { n, at, lockedUntil }
function tokenEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}
function adminTokenFrom(req) {
  const direct = String(req.headers['x-admin-token'] || '').trim()
  if (direct) return direct
  const auth = String(req.headers.authorization || '')
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}
function adminLockLeft(ip, ts = nowMs()) {
  const rec = adminHits.get(ip)
  return rec && rec.lockedUntil > ts ? rec.lockedUntil - ts : 0
}
function adminFail(ip, ts = nowMs()) {
  let rec = adminHits.get(ip)
  if (!rec || ts - rec.at > ADMIN_WINDOW_MS) rec = { n: 0, at: ts, lockedUntil: 0 }
  rec.n += 1
  rec.at = ts
  if (rec.n >= ADMIN_FAIL_LIMIT) {
    rec.lockedUntil = ts + ADMIN_LOCK_MS
    log(`⚠️ 后台口令连续 ${rec.n} 次不对（${ip}），锁 ${ADMIN_LOCK_MS / 60000} 分钟`)
  }
  adminHits.set(ip, rec)
  if (adminHits.size > 2000) {   // 别让这张表自己变成内存泄漏
    for (const [k, v] of adminHits) if (v.lockedUntil < ts && ts - v.at > ADMIN_WINDOW_MS) adminHits.delete(k)
  }
  return rec
}
/**
 * 这次请求是**以什么身份**进的 `/api/admin/*`？三种结果：
 *   'token'         —— 带了 x-admin-token（或 Bearer）且**与服务器上的口令一致**。应急通道，永远有效。
 *   'admin-session' —— 已登录、且该账号 `admin === true`、且**没被封**。日常通道。
 *   'bad-token'     —— 带了口令但不对（要计一次失败，防爆破）。
 *   'none'          —— 没带口令，登录账号也不是管理员（**不计失败次数**）。
 * 🔴 为什么 'none' 不计失败：一个好奇的普通用户点进 /admin.html 随手试两下，
 *    不该把**主人的 IP** 锁上 10 分钟（口令失败是按 IP 记的）。爆破防护留给 'bad-token' 那条路。
 */
function adminAuthKind(req, session) {
  const given = adminTokenFrom(req)
  if (given) return tokenEq(given, ADMIN_TOKEN) ? 'token' : 'bad-token'
  if (session && session.u && isAdminUser(session.u) && !db.users[session.u].bannedAt) return 'admin-session'
  return 'none'
}

// ── 派生视图（全部从 db 现算，不额外存一份"统计" —— 那种副本一定会和事实漂移）
//   唯一的例外是 `viewsTotal`：它是**单调累计**，取「存下来的值」与「按天之和」的较大者，
//   这样清今日额度不会让历史累计凭空缩水，老库（只有 usage）也仍然算得出来。
function viewsTotalOf(user) {
  const perDay = Object.values((user && user.usage) || {}).reduce((s, n) => s + (Number(n) || 0), 0)
  return Math.max(Number((user && user.viewsTotal) || 0), perDay)
}
/** 「最近活跃」= 记下的时间戳、发过的记录、用过的令牌，三者取最大。缺字段的老库也能算。 */
function lastSeenOf(name, user) {
  let t = Number(user.lastSeenAt || 0)
  for (const r of db.records) if (r.user === name && Number(r.createdAt) > t) t = Number(r.createdAt)
  for (const tk of Object.values(user.tokens || {})) {
    t = Math.max(t, Number(tk.createdAt || 0), Number(tk.lastUsedAt || 0))
  }
  return t || Number(user.createdAt || 0)
}
function adminUserRow(name, user) {
  const q = quotaOf(user)
  const proUntil = Number(user.proUntil || 0)
  const pro = q.plan === 'pro'
  return {
    username: name,
    createdAt: Number(user.createdAt || 0),
    lastSeenAt: lastSeenOf(name, user),
    plan: q.plan,
    proUntil: pro ? proUntil : 0,
    proDaysLeft: pro ? Math.max(0, Math.ceil((proUntil - nowMs()) / DAY_MS)) : 0,
    proForever: pro && proUntil >= FOREVER_MS,
    mode: user.mode || 'note-link',
    limit: q.limit,
    usedToday: q.used,
    remainingToday: q.remaining,
    viewsTotal: viewsTotalOf(user),
    retentionText: q.retentionText,
    tokens: Object.keys(user.tokens || {}).length,
    records: db.records.filter((r) => r.user === name).length,
    // 封禁与管理员身份（封禁**不删数据**，解封后记录/令牌/档位一切如初）
    admin: user.admin === true,
    banned: !!user.bannedAt,
    bannedAt: Number(user.bannedAt || 0) || null,
    banReason: user.banReason || '',
    bannedBy: user.bannedBy || '',
  }
}
function adminTrend(days) {
  const users = Object.entries(db.users)
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(nowMs() - i * DAY_MS)
    let views = 0
    for (const [, u] of users) views += Number((u.usage || {})[key] || 0)
    out.push({
      day: key,
      views,
      newUsers: users.filter(([, u]) => dayKey(Number(u.createdAt) || 0) === key).length,
      records: db.records.filter((r) => dayKey(Number(r.createdAt) || 0) === key).length,
    })
  }
  return out
}
function grantPro(user, { forever, days }) {
  const now = nowMs()
  const before = Number(user.proUntil || 0)
  if (forever === true) {
    user.proUntil = FOREVER_MS
    user.upgraded = true
    return { action: 'forever', days: 0, stacked: false }
  }
  const d = Math.min(36500, Math.max(1, Math.floor(Number(days) || PRO_DAYS)))
  // 与兑换码同一条语义：**叠加**，不是覆盖。
  user.proUntil = Math.max(now, before) + d * DAY_MS
  user.upgraded = true
  return { action: 'grant', days: d, stacked: before > now }
}

async function handleAdmin(req, res, url, p) {
  const ip = clientIp(req)
  // 改过密码的会话立刻失效 —— 连「管理员身份」这条通道也一样（否则改密踢不掉后台）
  const rawSess = readSession(req.headers.cookie)
  const sess = rawSess && rawSess.u && db.users[rawSess.u] && sessionEpochOk(rawSess, db.users[rawSess.u]) ? rawSess : null
  const lock = adminLockLeft(ip)
  if (lock > 0) {
    return json(res, 429, { ok: false, error: `口令连续错太多次，请 ${Math.ceil(lock / 60000)} 分钟后再试` })
  }
  const kind = adminAuthKind(req, sess)
  if (kind === 'bad-token') {
    const rec = adminFail(ip)
    log(`后台口令不对（${ip}，第 ${rec.n} 次）`)
    return json(res, 401, { ok: false, error: '后台口令不对' })
  }
  if (kind === 'none') {
    // 分清"没凭证"和"有凭证但不够格"：前者 401（你还没说明你是谁），后者 403（说清了，但你不是管理员）。
    // 两条都**不计失败次数** —— 免得普通用户随手一试就把主人的 IP 锁掉。
    if (sess && sess.u) return json(res, 403, { ok: false, error: '这个账号不是管理员' })
    return json(res, 401, { ok: false, error: '需要管理员身份：登录管理员账号，或带上 x-admin-token' })
  }
  adminHits.delete(ip)

  const body = req.method === 'POST' ? await readBody(req) : {}
  const q = url.searchParams
  const uname = (v) => String(v == null ? '' : v).trim()

  if (p === '/api/admin/overview') {
    pruneRecords(); pruneDevices()
    const users = Object.entries(db.users)
    const day = dayKey()
    let viewsToday = 0
    for (const [, u] of users) viewsToday += Number((u.usage || {})[day] || 0)
    const trend = adminTrend(14)
    const codes = Object.values(db.codes)
    return json(res, 200, {
      ok: true,
      now: nowMs(),
      uptimeSec: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      config: {
        freeDaily: FREE_DAILY, proDaily: PRO_DAILY, proDays: PRO_DAYS, priceCny: PRICE_CNY,
        retentionText: hoursText(RETENTION_MS), proRetentionText: hoursText(PRO_RETENTION_MS),
        deviceTtlMin: DEVICE_TTL_MS / 60000,
        adminFile: ADMIN_FILE,
      },
      totals: {
        users: users.length,
        proUsers: users.filter(([, u]) => proActive(u)).length,
        adminUsers: users.filter(([, u]) => u.admin === true).length,
        bannedUsers: users.filter(([, u]) => !!u.bannedAt).length,
        records: db.records.length,
        records24h: db.records.filter((r) => Number(r.createdAt) >= nowMs() - DAY_MS).length,
        viewsToday,
        views7d: trend.slice(-7).reduce((s, d) => s + d.views, 0),
        codes: { total: codes.length, unused: codes.filter((c) => !c.usedBy).length },
        devices: Object.keys(db.devices).length,
      },
      trend,
    })
  }

  if (p === '/api/admin/users') {
    pruneRecords()
    const kw = uname(q.get('q')).toLowerCase()
    let rows = Object.entries(db.users).map(([name, u]) => adminUserRow(name, u))
    if (kw) rows = rows.filter((r) => r.username.toLowerCase().includes(kw))
    const cmp = {
      recent: (a, b) => b.lastSeenAt - a.lastSeenAt,
      created: (a, b) => b.createdAt - a.createdAt,
      usage: (a, b) => b.viewsTotal - a.viewsTotal,
      today: (a, b) => b.usedToday - a.usedToday,
      name: (a, b) => a.username.localeCompare(b.username),
    }[uname(q.get('sort'))] || ((a, b) => b.lastSeenAt - a.lastSeenAt)
    rows.sort(cmp)
    return json(res, 200, { ok: true, items: rows, total: Object.keys(db.users).length, now: nowMs() })
  }

  if (p === '/api/admin/user/create' && req.method === 'POST') {
    const name = uname(body.username)
    if (!validName(name)) return json(res, 400, { ok: false, error: '用户名：2–24 位，中文/字母/数字/_/-' })
    if (!validPass(body.password)) return json(res, 400, { ok: false, error: '密码至少 6 位' })
    if (db.users[name]) return json(res, 409, { ok: false, error: '这个用户名已经注册了' })
    const { salt, hash } = hashPassword(body.password)
    const user = {
      salt, hash, createdAt: nowMs(), upgraded: false, proUntil: 0,
      tokens: {}, mode: 'note-link', usage: {}, lastSeenAt: nowMs(),
    }
    db.users[name] = user
    let pro = null
    if (body.forever === true || Number(body.days) > 0) pro = grantPro(user, body)
    await saveDB()
    log(`后台：建号 ${name}（${planOf(user) === 'pro' ? '付费版' : '免费版'}）`)
    return json(res, 200, { ok: true, user: adminUserRow(name, user), pro })
  }

  if (p === '/api/admin/user/password' && req.method === 'POST') {
    const name = uname(body.username)
    const user = db.users[name]
    if (!user) return json(res, 404, { ok: false, error: `账号不存在：${name}` })
    if (!validPass(body.password)) return json(res, 400, { ok: false, error: '密码至少 6 位' })
    const { salt, hash } = hashPassword(body.password)
    user.salt = salt
    user.hash = hash
    // 改密码 ⇒ 世代号 +1 ⇒ 该账号**所有**已发出的 cookie 立刻作废。
    // 没有这一步，"改密码"就踢不掉已经进来的攻击者（审计实测：旧 cookie 仍能读 /api/me 200）。
    user.epoch = epochOf(user) + 1
    await saveDB()
    log(`后台：重置了 ${name} 的密码（已作废其全部旧会话）`)
    return json(res, 200, { ok: true, username: name })
  }

  if (p === '/api/admin/user/quota' && req.method === 'POST') {
    const name = uname(body.username)
    const user = db.users[name]
    if (!user) return json(res, 404, { ok: false, error: `账号不存在：${name}` })
    // 只清**今天**这一次的计数（给人解围），累计 usage 一个字不动。
    if (user.usage) delete user.usage[dayKey()]
    await saveDB()
    log(`后台：清零 ${name} 今日额度`)
    return json(res, 200, { ok: true, user: adminUserRow(name, user) })
  }

  if (p === '/api/admin/user/grant' && req.method === 'POST') {
    const name = uname(body.username)
    const user = db.users[name]
    if (!user) return json(res, 404, { ok: false, error: `账号不存在：${name}` })
    if (body.revoke === true || body.plan === 'free') {
      user.proUntil = 0
      user.upgraded = false
      await saveDB()
      log(`后台：把 ${name} 改回免费版`)
      return json(res, 200, { ok: true, action: 'revoke', user: adminUserRow(name, user) })
    }
    const pro = grantPro(user, body)
    await saveDB()
    log(pro.action === 'forever'
      ? `后台：${name} 设为永久付费版`
      : `后台：${name} +${pro.days} 天（到期 ${new Date(user.proUntil + TZ_OFFSET).toISOString().slice(0, 10)}）`)
    return json(res, 200, { ok: true, ...pro, user: adminUserRow(name, user) })
  }

  // 封禁 / 解封。**只标记，不删任何东西** —— 解封后记录、令牌、档位、额度全部原样回来。
  if (p === '/api/admin/user/ban' && req.method === 'POST') {
    const name = uname(body.username)
    const user = db.users[name]
    if (!user) return json(res, 404, { ok: false, error: `账号不存在：${name}` })
    const want = body.banned !== false                  // 默认是"封"；显式 {banned:false} 才解封
    if (want) {
      if (losesLastAdmin(name, 'ban')) {
        return json(res, 409, { ok: false, error: '这是最后一个还能用的管理员，封了谁也进不了后台' })
      }
      if (user.bannedAt) return json(res, 200, { ok: true, banned: true, already: true, user: adminUserRow(name, user) })
      user.bannedAt = nowMs()
      user.banReason = String(body.reason || '').slice(0, 200)
      user.bannedBy = kind === 'token' ? '（服务器口令）' : sess.u
      await saveDB()
      log(`后台：封禁 ${name}${user.banReason ? `（原因：${user.banReason}）` : ''}`)
      return json(res, 200, { ok: true, banned: true, user: adminUserRow(name, user) })
    }
    if (!user.bannedAt) return json(res, 200, { ok: true, banned: false, already: true, user: adminUserRow(name, user) })
    user.bannedAt = 0
    user.banReason = ''
    user.bannedBy = ''
    await saveDB()
    log(`后台：解封 ${name}`)
    return json(res, 200, { ok: true, banned: false, user: adminUserRow(name, user) })
  }

  // 授予 / 取消管理员身份（**这就是给 cyanovo 加管理员位的那条路**，日常也可以用它加第二个管理员）
  if (p === '/api/admin/user/admin' && req.method === 'POST') {
    const name = uname(body.username)
    const user = db.users[name]
    if (!user) return json(res, 404, { ok: false, error: `账号不存在：${name}` })
    const want = body.admin !== false
    if (want) {
      if (user.admin === true) return json(res, 200, { ok: true, admin: true, already: true, user: adminUserRow(name, user) })
      if (user.bannedAt) return json(res, 409, { ok: false, error: '这个账号正被封着，先解封再给管理员' })
      user.admin = true
      await saveDB()
      log(`后台：把 ${name} 设为管理员`)
      return json(res, 200, { ok: true, admin: true, user: adminUserRow(name, user) })
    }
    if (user.admin !== true) return json(res, 200, { ok: true, admin: false, already: true, user: adminUserRow(name, user) })
    if (losesLastAdmin(name, 'demote')) {
      return json(res, 409, { ok: false, error: '这是最后一个还能用的管理员，取消后谁也进不了后台' })
    }
    user.admin = false
    await saveDB()
    log(`后台：取消 ${name} 的管理员身份`)
    return json(res, 200, { ok: true, admin: false, user: adminUserRow(name, user) })
  }

  if (p === '/api/admin/user/delete' && req.method === 'POST') {
    const name = uname(body.username)
    const user = db.users[name]
    if (!user) return json(res, 404, { ok: false, error: `账号不存在：${name}` })
    if (losesLastAdmin(name, 'delete')) {
      return json(res, 409, { ok: false, error: '这是最后一个还能用的管理员，删了谁也进不了后台' })
    }
    const before = db.records.length
    db.records = db.records.filter((r) => r.user !== name)
    for (const [k, d] of Object.entries(db.devices)) if (d.username === name) delete db.devices[k]
    delete db.users[name]
    await saveDB()
    log(`后台：删除账号 ${name}（连记录 ${before - db.records.length} 条）`)
    return json(res, 200, { ok: true, deleted: name, recordsDeleted: before - db.records.length })
  }

  // 账号详情：放在 users 列表之后、users/:name 之前不需要特别顺序，但必须避开
  // /api/admin/user/* 那几条（它们前缀是 user 单数，不会撞）。
  const um = p.match(/^\/api\/admin\/users\/(.+)$/)
  if (um) {
    const name = decodeURIComponent(um[1])
    const user = db.users[name]
    if (!user) return json(res, 404, { ok: false, error: `账号不存在：${name}` })
    pruneRecords()
    const records = db.records
      .filter((r) => r.user === name)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(recordMeta)
    const usage = Object.entries(user.usage || {})
      .filter(([, n]) => Number(n) > 0)
      .map(([day, n]) => ({ day, views: Number(n) }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))
    // ⚠️ 只给**前缀**：完整 id 是令牌的 sha256，虽然反推不出明文，但没必要让后台持有它。
    //    吊销按前缀匹配（前缀在多账号下足够区分，用户自己那页也是这么做的）。
    const tokens = Object.entries(user.tokens || {})
      .map(([id, t]) => ({ id: id.slice(0, 12), prefix: id.slice(0, 12), label: t.label || '', createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null }))
      .sort((a, b) => b.createdAt - a.createdAt)
    return json(res, 200, { ok: true, user: adminUserRow(name, user), usage, tokens, records })
  }

  // 令牌泄露时，后台能替用户砍掉一把（不然只能等用户自己发现）
  if (p === '/api/admin/token/revoke' && req.method === 'POST') {
    const name = uname(body.username)
    const user = db.users[name]
    if (!user) return json(res, 404, { ok: false, error: `账号不存在：${name}` })
    const id = String(body.id || '')
    if (id.length < 6) return json(res, 400, { ok: false, error: '给个令牌前缀（至少 6 位）' })
    const hit = Object.keys(user.tokens || {}).filter((k) => k.startsWith(id))
    if (hit.length !== 1) return json(res, 404, { ok: false, error: hit.length ? '这个前缀不唯一，请多给几位' : '找不到这个令牌（可能已被吊销）' })
    delete user.tokens[hit[0]]
    await saveDB()
    log(`后台：吊销了 ${name} 的一个发布令牌（${hit[0].slice(0, 12)}）`)
    return json(res, 200, { ok: true, username: name, revoked: hit[0].slice(0, 12), tokens: Object.keys(user.tokens).length })
  }

  if (p === '/api/admin/codes' && req.method === 'GET') {
    const items = Object.entries(db.codes)
      .map(([code, v]) => ({
        code, createdAt: v.createdAt, days: v.days || PRO_DAYS,
        usedBy: v.usedBy || null, usedAt: v.usedAt || null, note: v.note || '',
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
    return json(res, 200, { ok: true, items, unused: items.filter((c) => !c.usedBy).length })
  }

  if (p === '/api/admin/codes' && req.method === 'POST') {
    const count = Math.min(50, Math.max(1, Number(body.count) || 1))
    const days = Number(body.days) > 0 ? Math.min(3650, Math.floor(Number(body.days))) : PRO_DAYS
    const out = []
    for (let i = 0; i < count; i++) {
      const code = `DSH-${newId(4).toUpperCase()}-${newId(4).toUpperCase()}`
      db.codes[code] = { createdAt: nowMs(), days, note: String(body.note || '').slice(0, 60) }
      out.push(code)
    }
    await saveDB()
    log(`后台：生成 ${count} 个兑换码（每个 ${days} 天）`)
    return json(res, 200, { ok: true, codes: out, days })
  }

  if (p === '/api/admin/codes/delete' && req.method === 'POST') {
    const code = uname(body.code).toUpperCase()
    if (!db.codes[code]) return json(res, 404, { ok: false, error: '没有这个兑换码' })
    if (db.codes[code].usedBy) return json(res, 409, { ok: false, error: `这个码已经被 ${db.codes[code].usedBy} 用过了，删了也退不回天数` })
    delete db.codes[code]
    await saveDB()
    log(`后台：删掉未使用的兑换码 ${code}`)
    return json(res, 200, { ok: true, code })
  }

  if (p === '/api/admin/records') {
    pruneRecords()
    const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50))
    const user = uname(q.get('user'))
    let list = db.records.slice()
    if (user) list = list.filter((r) => r.user === user)
    list.sort((a, b) => b.createdAt - a.createdAt)
    // 🔴 只给元信息，**不给 text** —— 后台没有读别人正文的能力（见本段顶部说明）。
    return json(res, 200, {
      ok: true,
      items: list.slice(0, limit).map((r) => ({ ...recordMeta(r), user: r.user })),
      total: list.length,
    })
  }

  if (p === '/api/admin/records/delete' && req.method === 'POST') {
    const id = uname(body.id)
    const before = db.records.length
    db.records = db.records.filter((r) => r.id !== id)
    if (db.records.length === before) return json(res, 404, { ok: false, error: '没有这条记录（可能已经过期了）' })
    await saveDB()
    log(`后台：删除记录 ${id}`)
    return json(res, 200, { ok: true, id })
  }

  if (p === '/api/admin/devices' && req.method === 'GET') {
    pruneDevices()
    const items = Object.entries(db.devices).map(([hash, d]) => ({
      hash: hash.slice(0, 12), userCode: d.userCode, status: d.status,
      username: d.username || null, createdAt: d.createdAt, expiresAt: d.expiresAt,
    })).sort((a, b) => b.createdAt - a.createdAt)
    return json(res, 200, { ok: true, items })
  }

  return json(res, 404, { ok: false, error: 'no such admin api' })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`)
  const p = url.pathname
  const session = readSession(req.headers.cookie)
  const who = sessionUser(req.headers.cookie)
  const isJson = (req.headers['content-type'] || '').includes('application/json')
  // 被封禁账号的集中闸门：cookie 通道全线拦下，只留三条路 ——
  //   · /api/logout      本人要能退出
  //   · /api/me          本人要能看见"我被封了"（以及为什么），否则只会以为网站坏了
  //   · /api/admin/*     否则谁也解不开（管理员本人被封时的唯一出路）
  // **不删任何数据**，解封即完整恢复。
  if (who && db.users[who].bannedAt) {
    const allow = p === '/api/logout' || p === '/api/me' || p.startsWith('/api/admin/')
    if (!allow) {
      return json(res, 403, { ok: false, banned: true, error: '这个账号已被封禁，暂时不能使用' })
    }
  }

  try {
    // /health 只回答"你还活着吗"。以前它顺带报了账号数与记录数，而它是**免鉴权**的
    // （审计 H5 实测：GET /health → {"ok":true,"records":16,"users":2}）。
    // 要数字请走 /health/detail（后台凭证），顺带多给设备码数与运行时长。
    if (p === '/health') return json(res, 200, { ok: true })

    if (p === '/health/detail') {
      const kind = adminAuthKind(req, who ? { u: who } : null)
      if (kind === 'bad-token') { adminFail(clientIp(req)); return json(res, 401, { ok: false, error: 'unauthorized' }) }
      if (kind !== 'token' && kind !== 'admin-session') return json(res, 401, { ok: false, error: 'unauthorized' })
      return json(res, 200, {
        ok: true,
        records: db.records.length,
        users: Object.keys(db.users).length,
        devices: Object.keys(db.devices).length,
        uptimeMs: Math.round(process.uptime() * 1000),
      })
    }

    // 后台管理：**只有主人**，口令与登录态/发布令牌完全分立（说明见 ADMIN_TOKEN 与 handleAdmin）。
    if (p.startsWith('/api/admin/')) return await handleAdmin(req, res, url, p)

    if (p === '/api/meta') {
      return json(res, 200, {
        ok: true,
        modes: MODES,
        freeDaily: FREE_DAILY,
        retentionMs: RETENTION_MS,
        retentionText: hoursText(RETENTION_MS),
        priceCny: PRICE_CNY,
        plans: {
          free: { id: 'free', name: '免费版', daily: FREE_DAILY, retentionMs: RETENTION_MS, retentionText: hoursText(RETENTION_MS) },
          pro: {
            id: 'pro', name: '付费版', daily: PRO_DAILY, retentionMs: PRO_RETENTION_MS,
            retentionText: hoursText(PRO_RETENTION_MS), days: PRO_DAYS, priceCny: PRICE_CNY,
          },
        },
        device: { ttlMs: DEVICE_TTL_MS, interval: DEVICE_POLL_INTERVAL },
        // required 是**按这次请求**算的：经 nginx 来的公网请求为 true，本机直连（验收脚本）为 false。
        captcha: { required: !captchaExempt(req), chars: CAPTCHA_LEN, ttlMs: CAPTCHA_TTL_MS },
        timezone: 'Asia/Shanghai',
        now: nowMs(),
      })
    }

    // 人机验证图片：一次性，答案只在内存里（取舍见上面「人机验证」那一节）。
    if (p === '/api/captcha') {
      const ip = clientIp(req)
      const rl = captchaRateLimit(ip)
      if (!rl.ok) return json(res, 429, { ok: false, error: `验证码领太频繁，请 ${Math.ceil(rl.retryAfterMs / 60000)} 分钟后再试` })
      const c = newCaptcha(ip)
      const body = {
        ok: true,
        id: c.id,
        // 回 data URL 而不是让前端 innerHTML 插一段 SVG：前端只需要 img.src = ...，
        // 既不碰 innerHTML（本项目对它的纪律），也省掉一个 XSS 面。
        image: `data:image/svg+xml;base64,${Buffer.from(c.svg).toString('base64')}`,
        chars: CAPTCHA_LEN,
        ttlMs: CAPTCHA_TTL_MS,
      }
      // 🔴 答案只在验收脚本显式打开 DSH_WEB_CAPTCHA_TEST=1 时才回；生产 unit 不设这个变量，
      //    所以线上这份响应里没有 answer 字段（verify-captcha.mjs 对此有断言）。
      if (CAPTCHA_TEST) body.answer = c.answer
      return json(res, 200, body, { 'Cache-Control': 'no-store' })
    }

    if (p === '/api/register' && req.method === 'POST') {
      if (!isJson) return json(res, 415, { ok: false, error: '需要 application/json' })
      const rl = authRateLimit(clientIp(req))
      if (!rl.ok) return json(res, 429, { ok: false, error: `操作太频繁，请 ${Math.ceil(rl.retryAfterMs / 60000)} 分钟后再试` })
      const { username, password, captchaId, captchaText } = await readBody(req)
      // 人机验证必须在**花 scrypt 之前**：否则脚本拿这个接口当算力靶子照样烧得动。
      const cap = checkCaptcha(req, captchaId, captchaText)
      if (!cap.ok) {
        log(`⚠️ 注册被人机验证拦下（${clientIp(req)}）：${cap.error}`)
        return json(res, 400, { ok: false, captcha: true, error: cap.error })
      }
      if (!validName(username)) return json(res, 400, { ok: false, error: '用户名：2–24 位，中文/字母/数字/_/-' })
      if (!validPass(password)) return json(res, 400, { ok: false, error: '密码至少 6 位' })
      if (db.users[username]) return json(res, 409, { ok: false, error: '这个用户名已经被注册了' })
      const { salt, hash } = hashPassword(password)
      db.users[username] = { salt, hash, createdAt: nowMs(), upgraded: false, proUntil: 0, tokens: {}, mode: 'note-link', usage: {}, lastSeenAt: nowMs() }
      await saveDB()
      log(`新账号 ${username}`)
      const token = signSession({ u: username, iat: nowMs(), exp: nowMs() + SESSION_TTL, e: epochOf(db.users[username]) })
      return json(res, 200, { ok: true, me: meView(username) }, { 'Set-Cookie': sessionCookie(req, token) })
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (!isJson) return json(res, 415, { ok: false, error: '需要 application/json' })
      const rl = authRateLimit(clientIp(req))
      if (!rl.ok) return json(res, 429, { ok: false, error: `操作太频繁，请 ${Math.ceil(rl.retryAfterMs / 60000)} 分钟后再试` })
      const { username, password, captchaId, captchaText } = await readBody(req)
      // 人机验证在**比对密码之前**，而且失败**不算密码失败**（见 checkCaptcha 注释：
      // 否则脚本刷错验证码就能把别人的账号锁上 10 分钟 —— 那是拿验证码当武器打人）。
      const cap = checkCaptcha(req, captchaId, captchaText)
      if (!cap.ok) {
        log(`⚠️ 登录被人机验证拦下（${clientIp(req)}）：${cap.error}`)
        return json(res, 400, { ok: false, captcha: true, error: cap.error })
      }
      const user = db.users[username]
      // 先看这个账号是否已被锁：锁了就**不比对密码**（也比对不出结果，白烧 CPU）
      const locked = loginLockLeft(username)
      if (locked > 0) {
        return json(res, 429, { ok: false, error: `密码错太多次，请 ${Math.ceil(locked / 60000)} 分钟后再试` })
      }
      // checkPasswordOrDummy：账号不存在时也跑一次同样代价的 scrypt，抹掉时间差（反枚举）
      if (!checkPasswordOrDummy(password, user)) {
        loginFail(username)
        return json(res, 401, { ok: false, error: '用户名或密码不对' })
      }
      // 封禁必须**明确可见**：不能和"密码错了"长得一样，也**绝不发 cookie**
      // （发了 cookie 就等于放他进来了，只是别的接口再拦 —— 那是给自己埋雷）。
      if (user.bannedAt) {
        return json(res, 403, {
          ok: false, banned: true,
          error: user.banReason ? `这个账号已被封禁：${user.banReason}` : '这个账号已被封禁',
        })
      }
      loginSucceed(username)
      // 「最近活跃」不去存 IP（那是隐私，后台也不需要），只记时间戳 + 顺带在
      // 记录/令牌上做兜底（见 adminUserRow 的 lastSeenOf）。
      user.lastSeenAt = nowMs()
      await saveDB()
      const token = signSession({ u: username, iat: nowMs(), exp: nowMs() + SESSION_TTL, e: epochOf(user) })
      return json(res, 200, { ok: true, me: meView(username) }, { 'Set-Cookie': sessionCookie(req, token) })
    }

    if (p === '/api/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(req) })
    }

    if (p === '/api/me') {
      // 除了登录 cookie，**发布令牌**也能读「账号元信息」（插件 cloud_status 要用它显示
      // 「还剩几次、留多久」）。
      //
      // 🔴 只放开这一条：令牌能读**配额与档位**，但**读不到任何记录内容**
      //    （`/api/records*` 仍然只认登录 cookie）。令牌是给"发布"用的，
      //    不该顺带变成一把能翻你所有正文的钥匙。
      const auth = String(req.headers.authorization || '')
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
      const asUser = who || (bearer ? (findTokenUser(bearer) || {}).username : '')
      if (!who && bearer && !asUser) {
        return json(res, 401, { ok: false, error: '发布令牌无效或已被吊销' })
      }
      if (!asUser) return json(res, 200, { ok: true, me: null, meta: { freeDaily: FREE_DAILY, retentionMs: RETENTION_MS } })
      const hit = bearer && !who ? findTokenUser(bearer) : null
      if (hit) { hit.token.lastUsedAt = nowMs(); await saveDB() }
      pruneRecords(); await saveDB()
      // 被封禁的账号在这里**照样 200** —— `/api/me` 回答的是"我是谁"，那就该如实说"你被封了"，
      // 而不是把它变成一个错误（那样前端只能显示"网络错误"，本人永远看不懂发生了什么）。
      // 真正拦人走的是上面那道集中闸门（cookie 通道）与 /api/publish 的 403。
      const target = db.users[asUser]
      return json(res, 200, {
        ok: true,
        me: meView(asUser),
        banned: !!(target && target.bannedAt),
        banReason: (target && target.banReason) || '',
      })
    }

    if (p === '/api/prefs' && req.method === 'POST') {
      if (!who) return json(res, 401, { ok: false, error: '先登录' })
      const { mode } = await readBody(req)
      if (!MODE_IDS.includes(mode)) return json(res, 400, { ok: false, error: '未知的模式' })
      db.users[who].mode = mode
      await saveDB()
      return json(res, 200, { ok: true, me: meView(who) })
    }

    if (p === '/api/records' && req.method === 'GET') {
      if (!who) return json(res, 401, { ok: false, error: '先登录' })
      pruneRecords(); await saveDB()
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
      const items = db.records
        .filter((r) => r.user === who)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(recordMeta)
      return json(res, 200, { ok: true, items, retentionMs: retentionOf(db.users[who]), retentionText: hoursText(retentionOf(db.users[who])) })
    }

    const viewMatch = p.match(/^\/api\/records\/([a-z0-9]{4,32})\/view$/)
    if (viewMatch && req.method === 'POST') {
      if (!who) return json(res, 401, { ok: false, error: '先登录' })
      pruneRecords()
      const rec = db.records.find((r) => r.id === viewMatch[1] && r.user === who)
      if (!rec) return json(res, 404, { ok: false, error: `这条记录已过期（当前档位保留 ${hoursText(retentionOf(db.users[who]))}）` })
      const user = db.users[who]
      const key = dayKey()
      const used = (user.usage && user.usage[key]) || 0
      const limit = dailyLimitOf(user)
      // ⚠️ 付费版也**要计数** —— 承诺是「一天 1000 次」，不是「不限次数」。
      if (used >= limit) {
        await saveDB()
        return json(res, 429, {
          ok: false,
          error: planOf(user) === 'pro'
            ? `今天的 ${limit} 次已用完（付费版每天 ${PRO_DAILY} 次）`
            : `今天的 ${limit} 次已用完`,
          quota: quotaOf(user),
        })
      }
      user.usage = user.usage || {}
      // 先算累计（此刻 usage 还没 +1），再分别落两份计数：
      //   usage[今天] = 当天额度（后台可以清） ／ viewsTotal = 历史累计（清不掉）
      user.viewsTotal = viewsTotalOf(user) + 1
      user.usage[key] = used + 1
      user.lastSeenAt = nowMs()
      await saveDB()
      return json(res, 200, {
        ok: true,
        record: { ...recordMeta(rec), text: rec.text },
        quota: quotaOf(user),
      })
    }

    if (p === '/api/publish' && req.method === 'POST') {
      const who = resolvePublish(req)
      if (who.kind === 'bad-user-token') return json(res, 401, { ok: false, error: '发布令牌不对（这串令牌不属于任何账号，可能已被吊销）' })
      if (who.kind === 'banned-user-token') {
        return json(res, 403, { ok: false, banned: true, error: `账号 ${who.username} 已被封禁，发布令牌暂时不能用` })
      }
      if (who.kind === 'none') {
        return json(res, 401, {
          ok: false,
          error: '缺少发布令牌。插件请用 Authorization: Bearer <我的令牌>（在「我的账号」里生成或设备码绑定）',
        })
      }
      if (!isJson) return json(res, 415, { ok: false, error: '需要 application/json' })
      const body = await readBody(req)
      let username
      if (who.kind === 'user') {
        if (body.username && body.username !== who.username) {
          return json(res, 403, { ok: false, error: `令牌属于 ${who.username}，不能用它给 ${body.username} 发记录` })
        }
        username = who.username
        if (who.token) who.token.lastUsedAt = nowMs()
      } else {
        username = body.username
        if (!db.users[username]) return json(res, 404, { ok: false, error: `账号不存在：${username}` })
      }
      const text = typeof body.text === 'string' ? body.text : ''
      if (!text) return json(res, 400, { ok: false, error: 'text 不能为空' })
      if (Buffer.byteLength(text, 'utf8') > RECORD_TEXT_MAX) return json(res, 413, { ok: false, error: '正文太大' })
      pruneRecords()
      const createdAt = nowMs()
      // 保留期按**发布者当下的档位**定下来，写进记录本身
      const retentionMs = retentionOf(db.users[username])
      const rec = {
        id: newId(6),
        user: username,
        title: String(body.title || '').slice(0, 120) || '未命名回答',
        mode: MODE_IDS.includes(body.mode) ? body.mode : 'note-link',
        chars: text.length,
        createdAt,
        expiresAt: createdAt + retentionMs,
        retentionMs,
        text,
      }
      db.records.push(rec)
      db.users[username].lastSeenAt = createdAt
      await saveDB()
      log(`收到记录 ${rec.id} ← ${username}（${rec.chars} 字，保留 ${hoursText(retentionMs)}）`)
      return json(res, 200, {
        ok: true, id: rec.id, expiresAt: rec.expiresAt,
        retentionText: hoursText(retentionMs), plan: planOf(db.users[username]),
      })
    }

    // 生成兑换码（只有持有发布令牌的人能调 —— 也就是主人自己）
    if (p === '/api/codes' && req.method === 'POST') {
      const token = req.headers['x-publish-token']
      if (!token || token !== PUBLISH_TOKEN) return json(res, 401, { ok: false, error: '发布令牌不对' })
      const body = await readBody(req)
      const count = Math.min(50, Math.max(1, Number(body.count) || 1))
      const days = Number(body.days) > 0 ? Math.min(3650, Math.floor(Number(body.days))) : PRO_DAYS
      const out = []
      for (let i = 0; i < count; i++) {
        const code = `DSH-${newId(4).toUpperCase()}-${newId(4).toUpperCase()}`
        db.codes[code] = { createdAt: nowMs(), days, note: String(body.note || '').slice(0, 60) }
        out.push(code)
      }
      await saveDB()
      log(`生成了 ${count} 个兑换码（每个 ${days} 天）`)
      return json(res, 200, { ok: true, codes: out, days })
    }

    if (p === '/api/codes' && req.method === 'GET') {
      const token = req.headers['x-publish-token']
      if (!token || token !== PUBLISH_TOKEN) return json(res, 401, { ok: false, error: '发布令牌不对' })
      const items = Object.entries(db.codes).map(([code, v]) => ({
        code, createdAt: v.createdAt, days: v.days || PRO_DAYS,
        usedBy: v.usedBy || null, usedAt: v.usedAt || null, note: v.note || '',
      }))
      return json(res, 200, { ok: true, items, unused: items.filter((c) => !c.usedBy).length })
    }

    if (p === '/api/redeem' && req.method === 'POST') {
      if (!who) return json(res, 401, { ok: false, error: '先登录' })
      const { code } = await readBody(req)
      const key = String(code || '').trim().toUpperCase()
      if (!key) return json(res, 400, { ok: false, error: '请填兑换码' })
      const rec = db.codes[key]
      if (!rec) return json(res, 404, { ok: false, error: '这个兑换码不存在' })
      // 🔴 这里曾经写的是 `if (rec.usedBy && rec.usedBy !== who)` —— 只挡"别人用过"，
      //    不挡"自己再用一次"，于是同一张码可以反复提交、反复叠加天数
      //    （审计实测：30 天码连兑 3 次全部 200，`proUntil` 叠成 60 天 ⇒ 一张 ¥2.99 = 永久 Pro）。
      //    一张码**一生只能兑一次**，谁兑的都不行。
      if (rec.usedBy) return json(res, 409, { ok: false, error: '这个兑换码已经被用过了' })
      const days = Number(rec.days) > 0 ? Number(rec.days) : PRO_DAYS
      const user = db.users[who]
      const before = Number(user.proUntil || 0)
      // 🔴 这里是「叠加」而不是「覆盖」：`max(now, proUntil) + 天数`。
      //    覆盖式写法会让"续费"变成"重新开始"，用两次 30 天反而只有 30 天。
      const base = Math.max(nowMs(), before)
      user.proUntil = base + days * DAY_MS
      user.upgraded = true                   // 兼容老字段
      db.codes[key].usedBy = who
      db.codes[key].usedAt = nowMs()
      db.codes[key].days = days
      await saveDB()
      const added = user.proUntil - base
      log(`兑换成功 ${key} → ${who}（+${days} 天，到期 ${new Date(user.proUntil + TZ_OFFSET).toISOString().slice(0, 10)}）`)
      return json(res, 200, {
        ok: true, me: meView(who), days,
        addedMs: added, stacked: before > nowMs(),
      })
    }

    // ── 设备码绑定：插件不用浏览器也能拿到「自己的」发布令牌 ──────────────────
    // 三段式，谁也不多拿一点权限：
    //   start   插件生成一对 (userCode 短码, deviceCode 长码)，把**短码**显示给人；
    //   approve 人在浏览器里（已登录）用短码点确认 —— **只有登录态能批准**；
    //   poll    插件拿**长码**轮询，批准后一次性取回令牌。
    // 🔴 短码本身换不出任何东西：没有登录态就没法批准，没长码也没法取回。
    if (p === '/api/device/start' && req.method === 'POST') {
      const rl = deviceRateLimit(clientIp(req))
      if (!rl.ok) return json(res, 429, { ok: false, error: `请求太频繁，请 ${Math.ceil(rl.retryAfterMs / 60000)} 分钟后再试` })
      pruneDevices()
      const deviceCode = newSecret(32)
      let userCode = newUserCode()
      for (let i = 0; i < 5; i++) {
        const clash = Object.values(db.devices).some((d) => d.userCode === userCode)
        if (!clash) break
        userCode = newUserCode()
      }
      const createdAt = nowMs()
      db.devices[sha256(deviceCode)] = {
        userCode, createdAt, expiresAt: createdAt + DEVICE_TTL_MS,
        status: 'pending', username: null, token: null, label: '',
      }
      await saveDB()
      log(`设备码会话开始：${userCode}（${DEVICE_TTL_MS / 60000} 分钟内有效）`)
      return json(res, 200, {
        ok: true,
        userCode,
        deviceCode,
        expiresIn: DEVICE_TTL_MS,
        interval: DEVICE_POLL_INTERVAL,
        approveHint: `在 ${PUBLIC_BASE || '网页'} 登录后输入 ${userCode} 并确认`,
      })
    }

    if (p === '/api/device/poll' && req.method === 'POST') {
      const rl = deviceRateLimit(clientIp(req))
      if (!rl.ok) return json(res, 429, { ok: false, error: `请求太频繁，请 ${Math.ceil(rl.retryAfterMs / 60000)} 分钟后再试` })
      const body = await readBody(req)
      const d = db.devices[sha256(String(body.deviceCode || ''))]
      if (!d) return json(res, 200, { ok: true, status: 'expired' })
      if (nowMs() >= Number(d.expiresAt || 0)) {
        delete db.devices[sha256(String(body.deviceCode || ''))]
        await saveDB()
        return json(res, 200, { ok: true, status: 'expired' })
      }
      if (d.status === 'pending') return json(res, 200, { ok: true, status: 'pending', interval: DEVICE_POLL_INTERVAL })
      if (d.status === 'approved') {
        // 令牌**在这里才现签发**（批准时只登记"谁批的"）——
        // 🔴 这样它的明文**永远不会落到 data.json 上**：库里只有 users.tokens 里的 sha256。
        //    第一版是 approve 时就生成、存在 devices 里等插件来取，于是明文会躺在磁盘上
        //    最长 10 分钟（插件要是没来轮询就一直躺着）。是验收脚本里那条
        //    「data.json 不该含令牌明文」把它抓出来的。
        const token = issueUserToken(d.username, 'device')
        d.status = 'delivered'
        d.deliveredAt = nowMs()
        await saveDB()
        log(`设备码 ${d.userCode} 已交付令牌 → ${d.username}`)
        return json(res, 200, { ok: true, status: 'approved', token, username: d.username, me: meView(d.username) })
      }
      return json(res, 200, { ok: true, status: 'used' })
    }

    if (p === '/api/device/approve' && req.method === 'POST') {
      if (!who) return json(res, 401, { ok: false, error: '先登录再确认这组码' })
      const body = await readBody(req)
      const want = normCode(body.userCode)
      if (want.length !== 8) return json(res, 400, { ok: false, error: '这组码是 8 位，形如 ABCD-EFGH' })
      pruneDevices()
      const entry = Object.entries(db.devices).find(([, d]) => normCode(d.userCode) === want && d.status === 'pending')
      if (!entry) return json(res, 404, { ok: false, error: '这个码不对、已经用过、或者已经过期了' })
      const [key, d] = entry
      // 🔴 批准只登记"谁批的"，**不在这里生成令牌** —— 明文令牌绝不落盘（见 poll 里的说明）
      db.devices[key] = { ...d, status: 'approved', username: who, approvedAt: nowMs() }
      await saveDB()
      log(`设备码 ${d.userCode} 已由 ${who} 确认`)
      return json(res, 200, { ok: true, me: meView(who), userCode: d.userCode })
    }

    // ── 我自己的发布令牌（插件用；明文只在创建/绑定时返回一次）────────────────
    if (p === '/api/tokens' && req.method === 'GET') {
      if (!who) return json(res, 401, { ok: false, error: '先登录' })
      const u = db.users[who]
      const items = Object.entries(u.tokens || {}).map(([id, t]) => ({
        id, prefix: id.slice(0, 12), createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null, label: t.label || '',
      })).sort((a, b) => b.createdAt - a.createdAt)
      return json(res, 200, { ok: true, items })
    }

    if (p === '/api/tokens' && req.method === 'POST') {
      if (!who) return json(res, 401, { ok: false, error: '先登录' })
      const body = await readBody(req)
      const token = issueUserToken(who, body.label || 'manual')
      await saveDB()
      log(`${who} 新建了一个发布令牌`)
      return json(res, 200, { ok: true, token, hint: '这串令牌只显示这一次，请立刻填进插件配置' })
    }

    if (p === '/api/tokens/revoke' && req.method === 'POST') {
      if (!who) return json(res, 401, { ok: false, error: '先登录' })
      const body = await readBody(req)
      const id = String(body.id || '').trim()
      // 空 id 以前会走 `k.startsWith('')` ⇒ 匹配**全部**令牌：
      //   · 恰好 1 个令牌时 → 200 并把它吊销（审计实测 revoked:05facc7ef000）
      //   · 有 2 个时 → hit.length !== 1 → 404，一个都不吊销
      // 作用域只在调用者自己的令牌里（跨账号实测无法越权），但语义是错的，改成明确拒绝。
      if (!id) return json(res, 400, { ok: false, error: '要吊销哪个令牌？id 不能为空' })
      const u = db.users[who]
      const hit = Object.keys(u.tokens || {}).filter((k) => k === id || k.startsWith(id))
      if (hit.length !== 1) return json(res, 404, { ok: false, error: '找不到这个令牌（或它不属于你）' })
      delete u.tokens[hit[0]]
      await saveDB()
      log(`${who} 吊销了一个发布令牌`)
      return json(res, 200, { ok: true, revoked: hit[0].slice(0, 12) })
    }

    // ── 一键删除我的数据（P1 的隐私承诺：删得掉，而且立刻）─────────────────────
    if (p === '/api/me/purge' && req.method === 'POST') {
      if (!who) return json(res, 401, { ok: false, error: '先登录' })
      const body = await readBody(req)
      const scope = body.scope === 'all' ? 'all' : 'records'
      const mine = db.records.length
      db.records = db.records.filter((r) => r.user !== who)
      const removed = mine - db.records.length
      if (scope === 'all') {
        if (!checkPassword(body.password, db.users[who])) {
          await saveDB()   // 记录已经删了，如实落盘
          return json(res, 401, { ok: false, error: `记录已删除 ${removed} 条；注销账号需要再填一次密码`, recordsDeleted: removed })
        }
        // 设备码里还挂着的待批准项也一并清掉
        for (const [k, d] of Object.entries(db.devices)) if (d.username === who) delete db.devices[k]
        delete db.users[who]
        await saveDB()
        log(`账号注销 ${who}（删记录 ${removed} 条）`)
        return json(res, 200, { ok: true, deletedAccount: true, recordsDeleted: removed }, {
          'Set-Cookie': clearSessionCookie(req),
        })
      }
      await saveDB()
      log(`${who} 删除了自己的 ${removed} 条记录`)
      return json(res, 200, { ok: true, recordsDeleted: removed, me: meView(who) })
    }

    if (p.startsWith('/api/')) return json(res, 404, { ok: false, error: 'no such api' })

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed')
    }
    return serveStatic(req, res, p)
  } catch (err) {
    const msg = err && err.message === 'body-too-large' ? '请求体太大'
      : err && err.message === 'bad-json' ? 'JSON 格式不对'
      : '服务器内部错误'
    log(`请求失败 ${p}：${err && err.message}`)
    return json(res, 400, { ok: false, error: msg })
  }
})

// ── 保留期清理 ───────────────────────────────────────────────────────────────
// 读写两侧都会 prune，但「只在有人访问时才清」不够：零流量的夜里，过期记录会一直留在
// data.json 里（明文），而对外承诺的是「保存 5 小时」。所以再加两道：启动清一次，之后每
// SWEEP_MS 扫一次。
// ⚠️ 关键：只 prune 不 saveDB，只会让内存干净、文件照旧 —— 这正是本次修掉的缺陷。
const SWEEP_MS = 10 * 60 * 1000
function sweepRecords(why) {
  const dropped = pruneRecords()
  const droppedDevices = pruneDevices()
  // 验证码只活在内存里，过期的顺手删掉（不值得为它单开一个定时器）
  const ts = nowMs()
  for (const [k, v] of captchas) if (v.exp < ts) captchas.delete(k)
  if (!dropped && !droppedDevices) return 0
  log(`${why}：清掉 ${dropped} 条过期记录${droppedDevices ? `、${droppedDevices} 个过期设备码` : ''}`)
  saveDB()   // 落盘失败会由 saveDB 自己记一条「落盘失败」，不静默
  return dropped
}

const droppedAtBoot = sweepRecords('启动清理')
setInterval(() => sweepRecords('定期清理'), SWEEP_MS).unref()

server.listen(PORT, HOST, () => {
  log(`已就绪 http://${HOST}:${PORT}（静态 ${ROOT}，数据 ${DATA_DIR}）`)
  log(`账号 ${Object.keys(db.users).length} 个 ｜ 记录 ${db.records.length} 条`
    + `（免费 ${FREE_DAILY} 次/天 · 留 ${hoursText(RETENTION_MS)}`
    + ` ｜ 付费版 ${PRO_DAILY} 次/天 · 留 ${hoursText(PRO_RETENTION_MS)}`
    + `${droppedAtBoot ? `，启动时已清 ${droppedAtBoot} 条过期` : ''}）`)
})
