/**
 * dsh-web（作者的云端网页端）客户端 —— 账号绑定与「完整回答」上传。
 *
 * ## 与 src/notes.js 的区别（两个不同的服务器，别混）
 *
 * - `notes.js` → **中枢**（`hubUrl`）的 `/api/notes`：把 markdown 存成一份**公开可读**的
 *   `.md`，谁拿到链接谁能看。单租户、一把共享令牌。
 * - 本模块 → **dsh-web**（`cloudUrl`）的 `/api/publish`：记录挂在**你自己的账号**下，
 *   看的时候要登录，配额按账号算（免费版 100 次/天、记录留 5 小时；付费版 1000 次/天、留 48 小时）。
 *
 * 所以这里刻意**不**复用 notes.js：payload 形状、鉴权方式、失败语义都不一样，
 * 硬塞进一个函数只会让"到底传给了谁"变得更难看清。
 *
 * ## 为什么不抛异常
 *
 * 调用方是"一轮对话刚结束就推通知"的路径。服务器抽风时**绝不能**把通知弄丢，
 * 所以：网络/超时/坏 JSON → 一律返回 `{ok:false, error}` 或 `null`，由调用方记日志。
 * 唯一的例外是参数明显不对（没配 cloudUrl）—— 那属于配置错误，用返回值说清楚。
 *
 * 依赖：只用全局 `fetch` / `AbortController`，**不 import 任何裸包**（可独立单测）。
 */

/** 上传/查询超时。宁可少一个链接，也不能让通知迟到。 */
export const CLOUD_TIMEOUT_MS = 6000
/** 设备码轮询间隔（秒）—— 与服务器 `/api/meta` 的 `device.interval` 一致。 */
export const CLOUD_POLL_INTERVAL_S = 3
/** 设备码有效期（毫秒）—— 服务器 `DEVICE_TTL_MS`，前端只用来提示"还剩多久"。 */
export const CLOUD_DEVICE_TTL_MS = 10 * 60 * 1000

/**
 * 规整云端地址。
 *
 * 只接受 http/https：一个 `file://` 或 `ftp://` 的"云端地址"会让 fetch 抛出难懂的错误，
 * 不如在这里就判定为未配置。
 *
 * @param {unknown} raw - 用户填的地址。
 * @returns {string} 规整后的地址；不可用时返回 `''`。
 */
export function normalizeCloudUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  let u
  try {
    u = new URL(s)
  } catch {
    return ''
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
  // 去掉末尾斜杠与查询串（云端地址就是站点根）
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/**
 * 一条记录在网页端的可点开地址。
 *
 * ⚠️ 这个形状必须与 dsh-web 前端 `public/app.js` 里的深链正则
 * `/^\/n\/([a-z0-9]{4,32})\/?$/i` 对得上 —— 对不上就是"链接点开是首页"，
 * 这种错在 QQ 里看起来像"服务器坏了"，很难查。tests/cloud.test.mjs 会钉住它。
 *
 * @param {string} cloudUrl - 云端地址。
 * @param {string} id - 记录 id。
 * @returns {string} 形如 `http://cyanovo.top/n/k3f9a`；参数不全则返回 `''`。
 */
export function cloudRecordUrl(cloudUrl, id) {
  const base = normalizeCloudUrl(cloudUrl)
  const rec = String(id ?? '').trim()
  if (!base || !/^[a-z0-9]{4,32}$/i.test(rec)) return ''
  return `${base}/n/${rec}`
}

/** 统一的请求封装：超时、JSON 解析、错误信息都在这里收口。 */
async function call({ cloudUrl, path, method = 'GET', token, body, fetchImpl, timeoutMs, log }) {
  const base = normalizeCloudUrl(cloudUrl)
  if (!base) return { ok: false, error: '未配置云端地址（cloudUrl）' }
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: '当前环境没有 fetch' }

  const controller = new AbortController()
  const ms = Math.max(500, Number(timeoutMs) || CLOUD_TIMEOUT_MS)
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
    const data = await res.json().catch(() => null)
    if (!data) return { ok: false, status: res.status, error: `服务器返回了非 JSON（HTTP ${res.status}）` }
    if (!res.ok || data.ok === false) {
      return { ok: false, status: res.status, error: data.error || `HTTP ${res.status}`, data }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `超时（${ms}ms）` : (err?.message ?? String(err))
    log?.(`云端请求失败 ${path}：${reason}`)
    return { ok: false, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 设备码绑定第一步：申请一组码。
 *
 * 返回的两串东西用途**完全不同**，别搞混：
 * - `userCode`（8 位短码，如 `ABCD-EFGH`）：念给用户、让他在网页端输入确认。
 * - `deviceCode`（长码）：**只留在插件这边**，用来轮询换令牌；它换不出任何权限，
 *   必须有人在网页端登录后确认过才行。
 *
 * @returns {Promise<{ok: true, userCode: string, deviceCode: string, interval: number, expiresIn: number}|{ok: false, error: string}>}
 */
export async function cloudDeviceStart({ cloudUrl, fetchImpl, timeoutMs, log } = {}) {
  const r = await call({ cloudUrl, path: '/api/device/start', method: 'POST', body: {}, fetchImpl, timeoutMs, log })
  if (!r.ok) return { ok: false, error: r.error }
  const { userCode, deviceCode, interval, expiresIn } = r.data
  if (!userCode || !deviceCode) return { ok: false, error: '服务器没有返回设备码' }
  return {
    ok: true,
    userCode,
    deviceCode,
    interval: Number(interval) > 0 ? Number(interval) : CLOUD_POLL_INTERVAL_S,
    expiresIn: Number(expiresIn) > 0 ? Number(expiresIn) : CLOUD_DEVICE_TTL_MS,
  }
}

/**
 * 设备码绑定第二步：轮询换令牌。
 *
 * `status` 的取值与服务器一致：
 * - `pending`：还没人在网页端确认。
 * - `approved`：确认了，**这一次**能拿到 `token`（再问一次就变 `used`）。
 * - `used`：令牌已经交付过了（比如你上次拿到了但没存上）。
 * - `expired`：码过期了（10 分钟），要重新申请。
 *
 * @returns {Promise<{ok: true, status: string, token?: string, username?: string, me?: object}|{ok: false, error: string}>}
 */
export async function cloudDevicePoll({ cloudUrl, deviceCode, fetchImpl, timeoutMs, log } = {}) {
  const code = String(deviceCode ?? '').trim()
  if (!code) return { ok: false, error: '缺少 deviceCode' }
  const r = await call({ cloudUrl, path: '/api/device/poll', method: 'POST', body: { deviceCode: code }, fetchImpl, timeoutMs, log })
  if (!r.ok) {
    // 服务器用 404/410 表达"这组码不存在或过期了"，那不是网络故障，得分开说
    return { ok: false, error: r.error, status: r.data?.status }
  }
  return { ok: true, status: r.data.status, token: r.data.token, username: r.data.username, me: r.data.me }
}

/**
 * 用绑定的令牌换**上传记录**。
 *
 * @param {object} p - 各字段。
 * @param {string} p.cloudUrl - 云端地址。
 * @param {string} p.token - 账号令牌（设备码绑定拿到的）。
 * @param {string} p.text - 正文（完整回答原文）。
 * @param {string} [p.title] - 标题（网页端记录列表里显示的那一行）。
 * @param {string} [p.mode] - 记录档位标记，默认 `note`。
 * @returns {Promise<{ok: true, id: string, url: string, plan?: string, retentionText?: string}|{ok: false, error: string}>}
 */
export async function cloudPublishNote({ cloudUrl, token, text, title = '', mode = 'note', fetchImpl, timeoutMs, log } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: '正文是空的' }
  if (!String(token ?? '').trim()) return { ok: false, error: '还没绑定账号（缺少 cloudToken）' }
  const r = await call({
    cloudUrl,
    path: '/api/publish',
    method: 'POST',
    token: String(token).trim(),
    body: { text: body, title: String(title ?? '').trim() || undefined, mode },
    fetchImpl,
    timeoutMs,
    log,
  })
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  const id = r.data.id || r.data.record?.id
  if (!id) return { ok: false, error: '服务器没返回记录 id' }
  return {
    ok: true,
    id,
    // 服务器给了 url 就用它的（可能配了对外域名），否则按 cloudUrl 自己拼
    url: r.data.url || cloudRecordUrl(cloudUrl, id),
    plan: r.data.plan,
    retentionText: r.data.retentionText,
  }
}

/**
 * 查当前绑定账号的档位与配额。
 *
 * @returns {Promise<{ok: true, me: object|null}|{ok: false, error: string}>}
 */
export async function cloudMe({ cloudUrl, token, fetchImpl, timeoutMs, log } = {}) {
  const r = await call({ cloudUrl, path: '/api/me', method: 'GET', token: String(token ?? '').trim(), fetchImpl, timeoutMs, log })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, me: r.data.me ?? null }
}

/**
 * 把服务器返回的配额说成一句人话（工具输出与日志共用）。
 *
 * @param {object|null} me - `/api/me` 的 `me`。
 * @returns {string} 一句话；没有账号时返回空串。
 */
export function describeAccount(me) {
  if (!me) return ''
  const q = me.quota ?? {}
  const plan = q.upgraded ? '付费版' : '免费版'
  const parts = [
    `账号 ${me.username}`,
    plan,
    `今天还剩 ${q.remaining ?? '?'} / ${q.limit ?? '?'} 次`,
  ]
  if (q.retentionText) parts.push(`记录留 ${q.retentionText}`)
  if (q.proUntil) parts.push(`有效期到 ${new Date(q.proUntil).toISOString().slice(0, 10)}`)
  return parts.join(' · ')
}

/** 睡眠（轮询用）；测试可注入 `sleepImpl` 免得真等。 */
export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 云端地址在 **QQ 里** 会不会变成点不开的链接 / 该提醒什么。
 *
 * 背景（P0 实测，见 src/qqbridge.js 的 `qqPreviewUrl`）：QQ 会拦截外链，
 * 唯一实测能点开的形式是 `http://<大写域名>/路径`（不带端口）。
 * 所以推送进 QQ 之前，链接一律被改写成那个样子 —— 于是：
 *
 * - `http://example.com:8444` → **端口被丢掉**，链接必然打不开 ⇒ 必须明确警告；
 * - `https://example.com` → 被改写成 `http://EXAMPLE.COM/…`：
 *   **API 走 https 是好事**（令牌不再明文过网络），只要该域名的 **80 端口也在服务**
 *   就完全没问题。只有"https 独占、80 没人听"的服务器才会点不开 —— 这一点插件
 *   没法从本地判断，所以给一条明确的提示让人自己确认，而不是含糊地说"可能点不开"。
 *
 * （2026-10-03：cyanovo.top 补上了 443，80 与 443 同时在服务，两种写法都能用。）
 *
 * @param {unknown} cloudUrl - 用户配的云端地址。
 * @returns {string} 没问题时返回 `''`，需要提醒时返回一句中文。
 */
export function qqLinkWarning(cloudUrl) {
  const base = normalizeCloudUrl(cloudUrl)
  if (!base) return ''
  let u
  try {
    u = new URL(base)
  } catch {
    return ''
  }
  // 端口会被 QQ 链接的改写丢掉 —— 这个一定坏，必须直说。
  if (u.port && u.port !== '80') {
    return `⚠️ cloudUrl 带了端口 :${u.port}，而 QQ 推送里的链接只会用「http://大写域名/路径」`
      + '这一种实测能点开的形式（见 src/qqbridge.js），**端口会被丢掉** ⇒ 链接点不开。'
      + '建议把云端配在 80 端口上（例如 http://cyanovo.top）。'
  }
  if (u.protocol === 'https:') {
    return '提示：cloudUrl 是 https（API 会走加密，这是好事）。QQ 推送里的链接仍然会是 '
      + `http://${u.hostname.toUpperCase()}/… —— 请确认这个域名在 80 端口也能访问`
      + '（本机可以试：curl -I http://你的域名），否则 QQ 里点开会是空白。'
  }
  return ''
}
