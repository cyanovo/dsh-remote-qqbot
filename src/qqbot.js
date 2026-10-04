/**
 * QQ 官方机器人客户端。
 *
 * 为什么用官方平台而不是 NapCat / Lagrange：
 *   那些需要**真实 QQ 账号登录**（扫码/小号），违反协议、有封号风险。
 *   官方机器人是平台分配的独立机器人身份，只需要 AppID + ClientSecret，
 *   你自己用 QQ 把它加为好友即可。
 *
 * 为什么不需要内网穿透 / 公网回调：
 *   官方同时提供 Webhook 和 **WebSocket** 两种收事件方式。这里用 WebSocket ——
 *   它是**纯出站长连接**，不需要公网 IP、不需要回调地址、不需要 frp。
 *
 * 依赖：只用 Node 内置（node:crypto）与 Node 22 自带的全局 fetch / WebSocket。
 *      不引入任何裸包（插件加载期不允许 import 非白名单包）。
 *
 * 协议要点（官方文档 2026-07 版）：
 *   1. POST https://api.bot.qq.com/app/getAppAccessToken {appId, clientSecret}
 *      ⚠️ **失败时 HTTP 仍是 200**，必须看响应体的 code 字段判断成败。
 *   2. GET  {apiBase}/gateway/bot  → {url, shards, session_start_limit}
 *   3. 连上后收 op10 HELLO {heartbeat_interval}
 *   4. 发 op2 IDENTIFY {token:"QQBot <at>", intents, shard:[0,1], properties}
 *   5. 收 op0 READY {session_id, user}
 *   6. 按 heartbeat_interval 发 op1 {d: 最新 s}，收 op11 ACK
 *   7. 断线重连优先发 op6 RESUME {token, session_id, seq}，可补发遗漏事件
 */

import crypto from 'node:crypto'

/** 事件订阅 intents 位。 */
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  /** 群聊 + 单聊（C2C）消息事件 —— 我们只要这个。 */
  GROUP_AND_C2C_EVENT: 1 << 25,
}

/** 单聊消息事件需要的 intents。 */
export const C2C_INTENTS = INTENTS.GROUP_AND_C2C_EVENT

const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken'
const DEFAULT_API_BASE = 'https://api.bot.qq.com'

/**
 * markdown 消息（msg_type=2）的正文长度上限。
 *
 * 官方对 markdown 的限制比纯文本严得多，超了是**整条消息失败**（摘要和链接一起丢），
 * 所以在客户端就拦一道；宁可退回纯文本（链接不折叠），也不能让通知发不出去。
 */
const MARKDOWN_MAX_CHARS = 900

export function b64u(buf) {
  return Buffer.from(buf).toString('base64url')
}

export function logSafe(s) {
  return String(s ?? '').replace(/\s+/g, ' ').slice(0, 300)
}

/**
 * 生成 DSH `/api` 需要的浏览器会话 cookie。
 *
 * 算法来自已经跑通的手机端实现（`mobile/lib/dsh_protocol.dart`）：
 *   name  = dsh-auth-<base64url(sha256(authority))>
 *   value = v1.<base64url(json)>.<base64url(hmac-sha256(secret, body))>
 *   json  = {version:1, authority, issuedAt, expiresAt}
 *
 * [clockSkewToleranceMs]：issuedAt 回拨一段时间。DSH 校验 `issuedAt <= now`
 * （不接受未来时间戳），而本机与 DSH 时钟未必同步，回拨是必要的保守策略。
 */
export function dshSessionCookie(secret, authority, { maxAgeDays = 30, clockSkewMs = 5 * 60 * 1000 } = {}) {
  const name = 'dsh-auth-' + b64u(crypto.createHash('sha256').update(authority, 'utf8').digest())
  const issuedAt = Date.now() - clockSkewMs
  const body = b64u(JSON.stringify({
    version: 1,
    authority,
    issuedAt,
    expiresAt: issuedAt + maxAgeDays * 86400000,
  }))
  const sig = b64u(crypto.createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest())
  return `${name}=v1.${body}.${sig}`
}

/**
 * QQ 机器人客户端。
 *
 * 生命周期：`start()` 起一个自愈循环（取 token → 取网关 → 连接 → 鉴权 → 心跳），
 * 断线按退避重连并优先 RESUME。`stop()` 干净退出，不再自动重连。
 */
export class QqBotClient {
  /**
   * @param {object} opts
   * @param {string} opts.appId
   * @param {string} opts.clientSecret
   * @param {number} [opts.intents]
   * @param {(name: string, data: object) => void} [opts.onEvent] 事件回调
   * @param {(level: string, msg: string) => void} [opts.log]
   * @param {string} [opts.apiBase]
   * @param {typeof fetch} [opts.fetchImpl] 便于离线自测注入
   * @param {Function} [opts.wsFactory] 便于离线自测注入
   */
  constructor({
    appId, clientSecret,
    intents = C2C_INTENTS,
    onEvent = () => {},
    log = () => {},
    apiBase = DEFAULT_API_BASE,
    fetchImpl = globalThis.fetch,
    wsFactory = (url) => new globalThis.WebSocket(url),
  }) {
    this.appId = appId
    this.clientSecret = clientSecret
    this.intents = intents
    this.onEvent = onEvent
    this.log = log
    this.apiBase = apiBase.replace(/\/+$/, '')
    this.fetch = fetchImpl
    this.wsFactory = wsFactory

    this._token = null
    this._tokenExpireAt = 0
    this._tokenPromise = null

    this._ws = null
    this._running = false
    this._sessionId = null
    this._lastSeq = null
    this._heartbeat = null
    this._heartbeatInterval = 45000
    this._ackTimer = null
    this._retry = 0
    this._retryTimer = null
    /** READY 之后才有；供上层判断"机器人已连上"。 */
    this.ready = false
  }

  // ---------- access_token ----------

  /** 取 access_token（内存缓存，提前 60 秒刷新）。 */
  async getAccessToken({ force = false } = {}) {
    const now = Date.now()
    if (!force && this._token && now < this._tokenExpireAt) return this._token
    if (this._tokenPromise) return this._tokenPromise

    this._tokenPromise = (async () => {
      const res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
      })
      const data = await res.json().catch(() => ({}))
      // ⚠️ 这里**不能看 HTTP 状态码**：官方失败时也返回 200，必须看 code
      if (data.code) {
        throw new Error(`getAppAccessToken 失败 code=${data.code}: ${data.message ?? ''}`)
      }
      if (!data.access_token) {
        throw new Error(`getAppAccessToken 未返回 access_token: ${logSafe(JSON.stringify(data))}`)
      }
      this._token = data.access_token
      const ttl = Number(data.expires_in) || 7200
      this._tokenExpireAt = Date.now() + Math.max(60, ttl - 60) * 1000
      return this._token
    })().finally(() => { this._tokenPromise = null })

    return this._tokenPromise
  }

  /** 统一带上 `Authorization: QQBot <token>` 调 REST。 */
  async api(path, { method = 'POST', body, signal } = {}) {
    const token = await this.getAccessToken()
    const res = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { /* 非 JSON */ }
    if (res.status === 401) {
      // token 失效 —— 清掉缓存，下次调用会重新取
      this._token = null
      this._tokenExpireAt = 0
    }
    return { status: res.status, data, text }
  }

  // ---------- 发送消息 ----------

  /**
   * 发送单聊消息。
   *
   * 不传 [msgId] 即**主动消息**（官方文档：主动消息「无任何条件」），
   * 但前提是用户已把机器人加为好友、且没在客户端关掉「允许主动发送」。
   * 传 [msgId]（来自 C2C_MESSAGE_CREATE 的 d.id）即被动回复，
   * 有效期 60 分钟、同一条消息最多回复 4 次。
   *
   * [markdown] 为 true 时改用 markdown 消息（msg_type=2）—— 只有这种消息能把
   * `[文字](链接)` 渲染成一句可点的文字而不是把长 URL 铺满屏幕。但 markdown 在
   * 客户端/平台侧可能不被接受（权限、内容、长度），所以**失败会自动退回纯文本重发**：
   * 通知必须送到，折叠只是锦上添花。
   *
   * @returns {Promise<{id: string, timestamp: string}>}
   */
  async sendC2C(openId, content, { msgId, msgSeq, isWakeup, markdown } = {}) {
    const extra = {}
    if (msgId) {
      extra.msg_id = msgId
      extra.msg_seq = msgSeq ?? 1
    } else if (isWakeup) {
      extra.is_wakeup = true
    }

    if (markdown === true && String(content).length <= MARKDOWN_MAX_CHARS) {
      try {
        return await this.postC2C(openId, { msg_type: 2, markdown: { content }, ...extra })
      } catch (err) {
        this.log('info', `markdown 消息发送失败（${logSafe(err?.message ?? err)}），改用纯文本重发`)
      }
    }
    return this.postC2C(openId, { content, msg_type: 0, ...extra })
  }

  /** 真正发出这一条单聊消息；失败抛带 code 的 Error（供上层翻译成中文提示）。 */
  async postC2C(openId, body) {
    const { status, data, text } = await this.api(`/v2/users/${encodeURIComponent(openId)}/messages`, { body })
    if (status < 200 || status >= 300 || !data?.id) {
      const code = data?.code ?? status
      const msg = data?.message ?? text.slice(0, 200)
      const e = new Error(`发送单聊消息失败 code=${code}: ${msg}`)
      e.code = code
      throw e
    }
    return data
  }

  // ---------- 富媒体（图片）----------

  /**
   * 上传一张图片，拿到之后发消息要用的 `file_info`。
   *
   * 官方 C2C 富媒体接口（2026-10-02 本机实测打通）：
   *   POST /v2/users/{open_id}/files
   *   body: { file_type: 1, srv_send_msg: false, file_data: '<base64>' }
   *   → { file_uuid, file_info, ttl }
   *
   * 两个刻意的选择：
   *   - `srv_send_msg: false` —— **只上传，不发送**。发送单独走 messages 接口，
   *     这样才能带上 `msg_id` 做**被动回复**（被动回复 60 分钟内有效，
   *     且发送响应里会带 `ext_info.ref_idx`，主人引用这张图继续说话时能反查到）。
   *     若让上传接口直接发（`srv_send_msg: true`）就无从引用、也无从发现失败原因。
   *   - 图片走 `file_data` 的 **base64**，体积膨胀 4/3，所以调用方必须先压缩（见 `screenshot.js`）。
   *
   * @param {string} openId
   * @param {string} fileData - base64 字符串（**不含** `data:` 前缀）。
   * @param {{fileType?: number}} [opts] - file_type：1=图片，2=视频，3=语音，4=文件。
   * @returns {Promise<{file_uuid: string, file_info: string}>}
   */
  async uploadC2CFile(openId, fileData, { fileType = 1 } = {}) {
    const { status, data, text } = await this.api(`/v2/users/${encodeURIComponent(openId)}/files`, {
      body: { file_type: fileType, srv_send_msg: false, file_data: fileData },
    })
    if (status < 200 || status >= 300 || !data?.file_info) {
      const code = data?.code ?? status
      const msg = data?.message ?? String(text ?? '').slice(0, 200)
      const e = new Error(`上传图片失败 code=${code}: ${msg}`)
      e.code = code
      throw e
    }
    return data
  }

  /**
   * 把**已上传**的图片作为单聊消息发出去（`msg_type: 7`）。
   *
   * ⚠️ `content` 必须是**一个空格**而不是空串：官方对富媒体消息要求 content 非空，
   * 传 `''` 会被判参数错误（实测踩过）。那个空格不会显示出来。
   *
   * @param {string} openId
   * @param {string} fileInfo - `uploadC2CFile()` 返回的 `file_info`。
   * @param {{msgId?: string, msgSeq?: number, isWakeup?: boolean}} [opts]
   * @returns {Promise<{id: string, timestamp: string, ext_info?: {ref_idx?: string}}>}
   */
  async sendC2CImage(openId, fileInfo, { msgId, msgSeq, isWakeup } = {}) {
    const extra = {}
    if (msgId) {
      extra.msg_id = msgId
      extra.msg_seq = msgSeq ?? 1
    } else if (isWakeup) {
      extra.is_wakeup = true
    }
    return this.postC2C(openId, { msg_type: 7, content: ' ', media: { file_info: fileInfo }, ...extra })
  }

  /** 把官方的错误码翻译成能直接指导排查的中文。 */
  static explainError(code) {
    switch (Number(code)) {
      case 40054004: return '无好友关系：需要先用你的 QQ 把机器人加为好友'
      case 40054013: return '用户拒收消息：你的 QQ 客户端里关掉了「允许主动发送」'
      case 40034105: return '主动消息无权限：机器人权限设置里没开单聊主动消息'
      case 40034100: return '主动消息超频控：单关系 20 条/分钟、每用户每天 1000 条'
      case 40054005: return '消息被去重：同一条被动回复的 msg_seq 重复了'
      case 40034005: return '被动回复的 msg_id 已过期：超过 60 分钟或回复超过 4 次'
      case 40054007: return '消息长度超限：请缩短内容'
      case 100016: return 'AppID 或 ClientSecret 不正确'
      case 100007: return 'AppID 无效，或机器人状态不正常（被封禁/已删除）'
      default: return null
    }
  }

  // ---------- 网关 ----------

  async getGatewayUrl() {
    const { status, data, text } = await this.api('/gateway/bot', { method: 'GET' })
    if (status < 200 || status >= 300 || !data?.url) {
      throw new Error(`获取网关失败 HTTP ${status}: ${logSafe(data?.message ?? text)}`)
    }
    return { url: data.url, shards: data.shards ?? 1 }
  }

  // ---------- 连接生命周期 ----------

  /** 启动自愈连接循环（幂等）。 */
  start() {
    if (this._running) return
    this._running = true
    void this._connectLoop()
  }

  stop() {
    this._running = false
    this.ready = false
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    this._clearHeartbeat()
    try { this._ws?.close() } catch { /* 忽略 */ }
    this._ws = null
  }

  _clearHeartbeat() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null }
    if (this._ackTimer) { clearTimeout(this._ackTimer); this._ackTimer = null }
  }

  async _connectLoop() {
    while (this._running) {
      try {
        await this._connectOnce()
        // _connectOnce 正常返回 = 连接被关闭，走退避重连
      } catch (err) {
        this.log('error', `QQ 机器人连接失败: ${logSafe(err?.message ?? err)}`)
      }
      if (!this._running) break

      // 指数退避，上限 60 秒。4014(intent 无权限)/4914/4915 等致命错误在 _onClose 里会停掉运行。
      if (!this._running) break
      const delay = Math.min(60000, 1000 * 2 ** Math.min(this._retry, 6))
      this._retry += 1
      this.log('info', `QQ 机器人 ${Math.round(delay / 1000)} 秒后重连（第 ${this._retry} 次）`)
      await new Promise((r) => { this._retryTimer = setTimeout(r, delay) })
    }
  }

  /** 建立一次连接，返回的 Promise 在连接关闭时兑现。 */
  _connectOnce() {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        this._clearHeartbeat()
        resolve()
      }

      this.getGatewayUrl()
        .then(({ url }) => {
          if (!this._running) return done()
          const ws = this.wsFactory(url)
          this._ws = ws
          ws.onopen = () => this.log('info', `QQ 网关已连接: ${url}`)
          ws.onmessage = (ev) => this._onPayload(ev.data, ws)
          ws.onerror = (e) => this.log('error', `QQ 网关错误: ${logSafe(e?.message ?? e?.type ?? 'unknown')}`)
          ws.onclose = (ev) => {
            this.ready = false
            const code = ev?.code
            const reason = logSafe(ev?.reason ?? '')
            this.log('info', `QQ 网关已断开 code=${code ?? '-'} ${reason}`)
            this._handleCloseCode(code)
            done()
          }
        })
        .catch((err) => {
          if (!settled) { settled = true; reject(err) }
        })
    })
  }

  /**
   * 按官方「WebSocket 错误码」表决定下一步。
   *
   * 关键点：官方文档「恢复登录态」明确说，断线后短时间重连**应优先 RESUME**
   * 以补发遗漏事件。所以只有**明确禁止 resume** 的错误码才清掉 session；
   * 普通网络断开（1006/1001 等不在表里）必须保留 session 走 RESUME，
   * 否则每次抖动都会丢事件。
   */
  _handleCloseCode(code) {
    if (code === 4914 || code === 4915) {
      // 4914 机器人已下架只允许沙箱；4915 已封禁。都不该无限重连。
      this.log('error', code === 4914
        ? 'QQ 机器人已下架：只允许连接沙箱环境，请检查开放平台里的机器人状态'
        : 'QQ 机器人已被封禁：请到开放平台申请解封')
      this._running = false
      return
    }
    // 这些码官方要求重新 IDENTIFY（不允许 resume）：
    //   4001 无效 opcode / 4002 无效 payload / 4006 无效 session / 4007 seq 错误
    //   4010 shard 无效 / 4011~4014 / 4900~4913 内部错误
    const mustIdentify = code === 4001 || code === 4002 || code === 4006 || code === 4007
      || (code >= 4010 && code <= 4014)
      || (code >= 4900 && code <= 4913)
    if (mustIdentify) {
      this._sessionId = null
      this._lastSeq = null
    }
    // 4008 / 4009 以及任何未列出的码（含 1006 异常断开）→ 保留 session，重连走 RESUME
  }

  _onPayload(raw, ws) {
    let msg
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) } catch {
      this.log('error', 'QQ 网关返回了非 JSON 数据')
      return
    }
    const { op, d, s, t } = msg
    if (typeof s === 'number') this._lastSeq = s

    switch (op) {
      case 10: {
        // HELLO → 鉴权（有 session 就 RESUME，否则 IDENTIFY）
        this._heartbeatInterval = Number(d?.heartbeat_interval) || 45000
        if (this._sessionId && this._lastSeq !== null) {
          this._send(ws, {
            op: 6,
            d: { token: `QQBot ${this._token}`, session_id: this._sessionId, seq: this._lastSeq },
          })
        } else {
          this._send(ws, {
            op: 2,
            d: {
              token: `QQBot ${this._token}`,
              intents: this.intents,
              shard: [0, 1],
              properties: { $os: process.platform, $browser: 'dsh-remote-qqbot', $device: 'dsh-remote-qqbot' },
            },
          })
        }
        this._startHeartbeat(ws)
        break
      }
      case 11:
        // 心跳 ACK
        if (this._ackTimer) { clearTimeout(this._ackTimer); this._ackTimer = null }
        break
      case 0: {
        if (t === 'READY') {
          this._sessionId = d?.session_id ?? null
          this._retry = 0
          this.ready = true
          this.log('info', `QQ 机器人已就绪：${d?.user?.username ?? '?'}（session=${this._sessionId ?? '-'}）`)
        } else if (t === 'RESUMED') {
          this._retry = 0
          this.ready = true
          this.log('info', 'QQ 机器人已恢复连接（RESUMED）')
        } else if (t) {
          try {
            this.onEvent(t, d)
          } catch (err) {
            this.log('error', `处理 QQ 事件 ${t} 失败: ${logSafe(err?.message ?? err)}`)
          }
        }
        break
      }
      default:
        // op 7 RECONNECT / op 9 无效 session 等：交给 onclose 的退避循环
        break
    }
  }

  _send(ws, obj) {
    try { ws.send(JSON.stringify(obj)) } catch (err) {
      this.log('error', `QQ 网关发送失败: ${logSafe(err?.message ?? err)}`)
    }
  }

  _startHeartbeat(ws) {
    this._clearHeartbeat()
    this._heartbeat = setInterval(() => {
      this._send(ws, { op: 1, d: this._lastSeq })
      // 一个周期内没收到 ACK 就主动断开，让外层退避重连
      if (this._ackTimer) clearTimeout(this._ackTimer)
      this._ackTimer = setTimeout(() => {
        this.log('error', 'QQ 网关心跳超时，主动重连')
        try { ws.close() } catch { /* 忽略 */ }
      }, this._heartbeatInterval * 2)
    }, this._heartbeatInterval)
    if (this._heartbeat.unref) this._heartbeat.unref()
  }
}
