/**
 * QQ ↔ DSH 桥接层（纯逻辑 + 本机 HTTP，无任何外部依赖）。
 *
 * 三件事：
 *   1. 事件 → 文案：任务完成 / 需要你回答 / 出错，转成能直接读的 QQ 消息
 *   2. 本机注入：用 HMAC cookie 调 DSH 的 `session/prompt`，往专属会话塞用户消息
 *   3. 回答提问：按 DSH 的**严格校验规则**把一句人话拼成合法的 answer
 *
 * 为什么走本机 HTTP 而不是插件内部服务：
 *   插件就跑在 DSH 进程里，`127.0.0.1:19387` 直连即可 —— 不需要 frp、
 *   不需要公网、不需要隧道。这条路已实测通过（session/create 与
 *   session/prompt 均返回 ok）。
 *
 * ⚠️ 关于回答提问：`userQuestions` 服务的 provider **只能注册一个**，
 *    桌面 UI 已经占住了（重复注册会抛 DUPLICATE_PROVIDER）。所以这里不抢
 *    provider，而是**包装 `ask()`**：同时让桌面 UI 收到问题、QQ 也能收到，
 *    谁先答就以谁为准（Promise.race）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { dshSessionCookie } from './qqbot.js'

// ── DSH -- 本机 HTTP 客户端 ─────────────────────────────────────────────────

/** 从 ~/.dsh/.credentials.yaml 里读出 browser-session secret。 */
export function readDshSecret(homeDir) {
  const file = path.join(homeDir, '.dsh', '.credentials.yaml')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`读不到 ${file}：${err.message}`)
  }
  const lines = raw.split(/\r?\n/)

  // 形态一：扁平的 `browser-session.secret: xxx`
  for (const line of lines) {
    const m = /^\s*browser-session\.secret\s*:\s*["']?([A-Za-z0-9_\-+/=]+)["']?\s*$/.exec(line)
    if (m) return m[1]
  }
  // 形态二：嵌套的
  //   browser-session:
  //     secret: xxx
  let inSection = false
  for (const line of lines) {
    if (/^\s*browser-session\s*:\s*$/.test(line)) { inSection = true; continue }
    if (inSection) {
      if (/^\S/.test(line)) { inSection = false; continue } // 退回顶层，段落结束
      const m = /^\s*secret\s*:\s*["']?([A-Za-z0-9_\-+/=]+)["']?\s*$/.exec(line)
      if (m) return m[1]
    }
  }
  // 兜底：整个文件里唯一的 secret 字段
  const all = [...raw.matchAll(/^\s*secret\s*:\s*["']?([A-Za-z0-9_\-+/=]{20,})["']?\s*$/gm)]
  if (all.length === 1) return all[0][1]

  throw new Error(`${file} 里找不到 browser-session.secret`)
}

// ── 桌面端的会话签名记录（cookie 的密钥就在里面）────────────────────────────

/**
 * 桌面端「浏览器会话签名记录」在凭据文档里的键。
 *
 * 桌面端 app.asar 里的实现是 `credentialKey("client-connection", "browser-session")`：
 * `/api` 的 cookie（`dsh-auth-<authority 哈希>`）拿它 `payload.secret` 做 HMAC 签名。
 * **这条记录不在文件里，插件就换不出 cookie，注入全线 401。**
 *
 * 2026-10-04 真事故：这条记录从 `~/.dsh/.credentials.yaml` 里消失了（桌面端进程内
 * 还留着旧 secret），于是「引用消息没办法回答」—— 而出站推送不需要它，
 * 所以通知照常发。**故障只出在入站**，这就是它难查的原因。
 */
export const BROWSER_SESSION_KEY = 'client-connection/browser-session'

/**
 * 记录该有的形状。
 *
 * 照抄桌面端 `storedSecret()` 的三条校验，一条都不能少，否则桌面端启动时会抛
 * `browser-session credential record has an unsupported format`：
 *   `record.kind === "grant"` / `payload.version === 1` / `payload.secret` 是合法 base64url。
 */
export function browserSessionRecord(secret) {
  return { kind: 'grant', payload: { version: 1, secret } }
}

/**
 * 从凭据文档正文里抠出 browser-session 的 secret（只认新版文档）。
 *
 * 新版文档 = 有 `records:` 段、记录键写成 `client-connection/browser-session:`。
 * 更老的两种写法（`browser-session.secret:` 扁平 / `client-connection:` 嵌套）
 * 由 `readDshSecret()` 负责 —— 两边都试，谁认出来算谁的。
 *
 * @returns {{secret: string, reason: string}} 读不到时 `secret` 为空串、`reason` 说明原因。
 */
export function secretFromCredentials(raw) {
  const text = String(raw ?? '')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  const at = lines.findIndex((l) => l.trim() === `${BROWSER_SESSION_KEY}:`)
  if (at < 0) return { secret: '', reason: `没有 ${BROWSER_SESSION_KEY} 记录` }
  const indent = lines[at].length - lines[at].trimStart().length
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') break
    if (line.length - line.trimStart().length <= indent) break   // 出了这条记录的范围
    const m = /^\s*secret\s*:\s*["']?([A-Za-z0-9_\-+/=]{20,})["']?\s*$/.exec(line)
    if (m) return { secret: m[1], reason: '' }
  }
  return { secret: '', reason: `${BROWSER_SESSION_KEY} 记录里没有合法的 secret` }
}

/**
 * 读凭据文档里的 browser-session secret。**读不到不抛**，把原因交回来 ——
 * 这样调用方能把"为什么注入不可用"原样说给用户听，而不是丢一句英文异常。
 *
 * @returns {{secret: string, reason: string, file: string}}
 */
export function readBrowserSessionSecret(homeDir) {
  const file = path.join(homeDir, '.dsh', '.credentials.yaml')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { secret: '', reason: `读不到 ${file}：${err?.message ?? err}`, file }
  }
  const got = secretFromCredentials(raw)
  return { secret: got.secret, reason: got.secret ? '' : `${file} 里${got.reason}`, file }
}

/**
 * 凭据文档里没有这条记录时**补一条**（先备份，原子写，保留权限位）。
 *
 * 为什么由插件来补：桌面端是「Connection 激活时**加载或创建**」这条记录，
 * 也就是说它自己也会创建；但它一旦把 secret 只留在内存里（2026-10-04 实测：
 * 文件里没有记录、进程里还在用），插件就永远读不到、只能等下一次重启。
 * 我们补一条之后，桌面端下次启动/激活会**加载**它，两边就对上了。
 *
 * ⚠️ 保守三条（这是别人家产品的凭据文件，写错会把桌面端弄挂）：
 *   1. 只在记录**完全不存在**时补；存在但格式怪 → 绝不覆盖，直接报错。
 *   2. 只认新版文档（必须有 `records:` 段）；老格式看不懂 → 不写。
 *   3. 写之前整份备份；tmp + rename 原子替换；权限位照抄原文件（凭据文件是 0600，
 *      默认的 0644 会把权限放松，不能接受）。
 *
 * @returns {{secret: string, file: string, backup: string}} `backup` 为空串表示没写（幂等命中）。
 */
export function healBrowserSessionRecord(homeDir, { randomBytes = crypto.randomBytes, now = Date.now } = {}) {
  const file = path.join(homeDir, '.dsh', '.credentials.yaml')
  const raw = fs.readFileSync(file, 'utf8')   // 读不到就抛：不能凭空造一份凭据文档
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(eol)

  const rec = lines.findIndex((l) => l.trim() === 'records:')
  if (rec < 0) throw new Error(`${file} 不是新版格式（没有 records: 段），不敢写入`)

  const got = secretFromCredentials(raw)
  if (got.secret) return { secret: got.secret, file, backup: '' }   // 已经有了：一个字节都不动

  const secret = randomBytes(32).toString('base64url')
  const block = [
    `  ${BROWSER_SESSION_KEY}:`,
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${secret}`,
  ]
  // 插在 `records:` 之后：它前面的内容（version / refs / 已有记录）一个字节都不动
  const out = [...lines.slice(0, rec + 1), ...block, ...lines.slice(rec + 1)]

  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '')
  const backup = `${file}.bak-remote-qqbot-${stamp}`
  const mode = fs.statSync(file).mode & 0o777
  fs.copyFileSync(file, backup)
  const tmp = `${file}.tmp`
  try { fs.unlinkSync(tmp) } catch { /* 上一轮的残留，清不掉也无所谓 */ }
  try {
    fs.writeFileSync(tmp, out.join(eol), { encoding: 'utf8', mode })
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败不影响主错误 */ }
    throw new Error(`补写 ${BROWSER_SESSION_KEY} 失败（${file}）：${err?.message ?? err}`)
  }
  return { secret, file, backup }
}

/**
 * 本机 DSH `/api` 客户端。
 *
 * ⚠️ args 的 key 是**接口的形参名**（实测结论，错一个就 gateway/arguments-invalid）：
 *    session/list   → {_request: {}}
 *    session/create → {request: {cwd}}
 *    session/prompt → {request: {sessionId, mode, content, clientTimeZone, requestId}}
 *    session/cancel → {request: {sessionId}}
 * 其中 prompt 的 **requestId 必须放在 request 内部**，否则 gateway/input-invalid。
 */
export class DshLocalApi {
  constructor({ baseUrl, authority, secret, fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.authority = authority
    this.secret = secret
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  get _cookie() {
    return dshSessionCookie(this.secret, this.authority)
  }

  async rpc(method, args) {
    const res = await this.fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: this.authority,
        cookie: this._cookie,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method,
        payload: { args },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
    if (!parsed?.result) {
      throw new Error(`DSH ${method} HTTP ${res.status}: ${String(text).slice(0, 200)}`)
    }
    if (parsed.result.ok !== true) {
      const e = parsed.result.error ?? {}
      const err = new Error(`DSH ${method} 失败 ${e.code ?? ''}: ${e.message ?? ''}`)
      err.code = e.code
      throw err
    }
    return parsed.result.value
  }

  /** 确认会话还在（被删了就重建，避免往空气里发消息）。 */
  async hasSession(sessionId) {
    const value = await this.rpc('session/list', { _request: {} })
    return (value?.items ?? []).some((s) => s.sessionId === sessionId)
  }

  async createSession(cwd) {
    const value = await this.rpc('session/create', { request: { cwd } })
    return value.sessionId
  }

  /** 往会话注入一条用户消息。这是"QQ 里下任务"的落点。 */
  async prompt(sessionId, text, { mode = 'queue', timeZone } = {}) {
    return this.rpc('session/prompt', {
      request: {
        sessionId,
        mode,
        content: [{ type: 'text', text }],
        ...(timeZone ? { clientTimeZone: timeZone } : {}),
        // 必须带，且必须在这一层 —— 少了就是 gateway/input-invalid
        requestId: crypto.randomUUID(),
      },
    })
  }

  async cancel(sessionId) {
    return this.rpc('session/cancel', { request: { sessionId } })
  }
}

// ── 文案 ───────────────────────────────────────────────────────────────────

/**
 * 这条通知的「主角」名字：优先会话名（如 "main"），没有就用工作区名。
 *
 * 同时开着好几个会话时，不说是哪一个等于没说 —— 所以会话名进主标题。
 */
function actorOf(event) {
  return String(event?.session || event?.project || '').trim()
}

/** 次要信息行。会话名已经进主标题了，这里只在工作区名不同时才补一行。 */
function metaLine(event) {
  const project = String(event?.project ?? '').trim()
  if (project === '' || project === actorOf(event)) return ''
  return `— ${project}`
}

/**
 * 把链接改成「在手机 QQ 里点得开」的形式。
 *
 * 背景（2026-10-02，主人手机 QQ 实测，三变量对照）：
 *   QQ 的**机器人平台**会检测机器人消息里的 URL。没通过检测的链接会被套一层壳，
 *   点开只显示「如需预览请使用浏览器访问」—— 页面本身是好的（`text/html`、手机自适应），
 *   是 QQ 把链接换掉了。
 *   对照实验：同一条消息里百度可点；自己的域名无论 `http:80` 还是 `https:8444` 都被拦
 *   ⇒ 唯一变量是**域名**（不是 scheme、不是端口、不是后缀 —— `.md → .html` 那次改动实测无效）。
 *   微信没有这套机器人 URL 检测，所以微信里一直正常。
 *
 * 绕过办法（有开源实现佐证）：[koishi-plugin-qqurl-bypass] 的 `uppercase` 模式 ——
 *   **只把域名整体改成大写**即可骗过检测。域名本身不区分大小写，访问完全不受影响。
 *   仓库：https://github.com/windbullet/koishi-plugin-qqurl-bypass
 *
 * 主人亲测可开的形式（2026-10-02）：
 *   `http://CYANOVO.TOP/dsh/hd882.html`
 * 所以这里除了大写域名，还把 scheme/端口归一成 `http` + 默认端口 80。
 *   第二步不是绕过的必要条件，纯粹是为了**只发实测过的那一种形式**，
 *   不留「应该也能行」的猜测。（`https://cyanovo.top:8444/...` → 大写 + `:8444` 那种
 *   组合没有经过实测确认，所以不发它。）
 *
 * ⚠️ 这里**必须手工拼装字符串**，不能用 `u.hostname = u.hostname.toUpperCase()`：
 *   URL 规范对 http(s) 这类特殊 scheme 的 host 会做 domain-to-ASCII（含**小写化**），
 *   setter 赋值后再读出来仍是小写 —— 那样写等于什么都没做，而且是**静默失效**。
 *   2026-10-02 实测（node v22.19.0）：
 *     u.hostname = 'CYANOVO.TOP'  →  u.href === 'https://cyanovo.top:8444/dsh/hd882.html'
 *   所以域名大写只能由我们自己拼。不写成注释迟早会有人"顺手"改成 setter 写法。
 *
 * 任何解析失败、空值都**原样返回**：绝不能因为改链接把推送本身弄丢。
 *
 * @param {unknown} raw - 中枢返回的链接（一般是 `https://cyanovo.top:8444/dsh/<id>.html`）。
 * @returns {string} QQ 里可直接点开的链接；输入不可用时返回原字符串（或空串）。
 */
export function qqPreviewUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '') return ''
  let u
  try {
    u = new URL(s)
  } catch {
    return s
  }
  const host = u.hostname
  if (host === '') return s
  // 只大写域名，**路径一个字都不动**（路径区分大小写，动了就是 404）。
  return `http://${host.toUpperCase()}${u.pathname}${u.search}${u.hash}`
}

// ── /status（看状态）────────────────────────────────────────────────────────

/** `/status` 里最多列几个在跑的会话（超出的折成一行"还有 N 个"）。 */
const STATUS_MAX_RUNNING = 10

/** 会话标题在 QQ 里的最大长度（码点）。太长会把一屏塞满。 */
const STATUS_TITLE_MAX = 22

// ── /sessions（挑一个会话说话）──────────────────────────────────────────────

/** 会话列表默认列几条（设置里 `qqRecentCount` 可改）。 */
export const PICKER_DEFAULT_COUNT = 6

/**
 * 「会话列表」的有效期 —— 裸数字只在这么长时间内被当成"选会话"。
 *
 * 为什么需要这个窗：列表发出去之后，你随时可能再发一句普通的话。
 * 如果「2」永远被解释成"切到第 2 个会话"，那你就没法正常说数字了；
 * 而"刚看完列表就回数字"这个场景里，数字几乎没有别的解释。
 */
export const PICK_WINDOW_MS = 5 * 60 * 1000

/** `at` 距现在多久：`刚刚` / `12 分钟前` / `3 小时前` / `2 天前`。 */
function shortAgo(at, now = Date.now()) {
  const ms = Math.max(0, now - (Number.isFinite(at) ? at : 0))
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return `${Math.floor(hr / 24)} 天前`
}

/**
 * 「会话列表」还在不在有效期里 —— **纯函数**，便于单测。
 *
 * 名单与发榜时刻**缺一不可**：只有列表真的发出去过、而且就在刚才，
 * 裸数字才有资格被解释成"选会话"。
 *
 * @param {{pickerAt?: number, ids?: string[], pickerIds?: string[]}} picker - 状态文件里记的那一份。
 *   `ids` 与 `pickerIds` 都认（后者就是 `BotState.data` 的字段名）—— 直接把
 *   `state.data` 传进来和手工映射一份，结果必须一样，不许因为键名不同就**静默判成"没名单"**。
 * @param {number} [now] - 当前时刻（测试可注入）。
 * @param {number} [windowMs] - 时间窗。
 * @returns {boolean}
 */
export function isPickerFresh(picker, now = Date.now(), windowMs = PICK_WINDOW_MS) {
  const src = picker ?? {}
  const pickerAt = src.pickerAt ?? 0
  const ids = src.ids ?? src.pickerIds ?? []
  if (!Array.isArray(ids) || ids.length === 0) return false
  if (!Number.isFinite(pickerAt) || pickerAt <= 0) return false
  return now - pickerAt <= windowMs
}

/**
 * `session/list` 的一条 item → 展示用的精简结构。
 *
 * ⚠️ **字段路径只在这里出现一次**。DSH 的会话列表是嵌套的
 *    （`projections.values.title`、`projections.values.sessionStats.turns`），
 *    哪天它改名了，只需要改这一个函数 —— 而不是散在排版逻辑里到处崩。
 *
 * 2026-10-02 实测的真实返回形状（114 条会话）：
 *   { sessionId, updatedAt, running, blank, cwd,
 *     projections: { values: { title, sessionStats: { turns, steps } } } }
 * 其中老会话可能没有 `sessionStats`（turns 为 undefined），标题也可能为 null。
 *
 * @param {object} item - `session/list` 的一条。
 * @returns {{id: string, title: string, project: string, turns: number|null, running: boolean, updatedAt: number}}
 */
export function summarizeSession(item) {
  const vals = item?.projections?.values ?? {}
  const rawTitle = String(vals?.title ?? '').trim()
  // 标题里万一带换行会把 QQ 一大段排版搅乱，统一压成单空格。
  const title = rawTitle === ''
    ? (item?.blank === true ? '（空会话）' : '未命名会话')
    : (([...rawTitle.replace(/\s+/g, ' ')].length > STATUS_TITLE_MAX)
        ? `${[...rawTitle.replace(/\s+/g, ' ')].slice(0, STATUS_TITLE_MAX - 1).join('')}…`
        : rawTitle.replace(/\s+/g, ' '))
  const turns = vals?.sessionStats?.turns
  return {
    id: String(item?.sessionId ?? ''),
    title,
    // 只取目录最后一段：完整路径在手机上会把行撑爆，而"哪个项目"才是要区分的东西。
    project: shortPath(item?.cwd),
    turns: Number.isFinite(turns) ? turns : null,
    running: item?.running === true,
    updatedAt: Number.isFinite(item?.updatedAt) ? item.updatedAt : 0,
  }
}

/** `D:\a\b\c` / `/srv/a/b` → `c` / `b`（只留最后一段，空值返回空串）。 */
function shortPath(p) {
  const s = String(p ?? '').trim().replace(/[\\/]+$/, '')
  if (s === '') return ''
  const parts = s.split(/[\\/]/)
  return parts[parts.length - 1] || s
}

/** 一条会话在列表里长这样：`主会话 · agenttool · 第 16 轮`。 */
function describeSession(s) {
  const bits = [s?.title || '未命名会话']
  if (s?.project) bits.push(s.project)
  if (Number.isFinite(s?.turns) && s.turns > 0) bits.push(`第 ${s.turns} 轮`)
  return bits.join(' · ')
}

/** 固定会话（专属/闲聊）那一行：优先显示**名字**，而不是一串 sessionId。 */
function slotLine(slotId, sessions, listError) {
  if (!slotId) return '还没建，第一次用到时我会自己建'
  if (listError) return `${String(slotId).slice(0, 20)}…（会话列表读不到）`
  const hit = sessions.find((s) => s.id === slotId)
  if (!hit) return '已经不在了，下次用到时重建'
  return `${hit.title}（${hit.running ? '正在跑' : '空闲'}）`
}

/**
 * 组装 QQ `/status` 的正文 —— **纯函数**，便于单测。
 *
 * 主人 2026-10-02 的要求：*"在我使用 QQ 的看状态的时候，能看到哪些会话正在运行"*。
 * 所以**正在运行的会话列表是主角**，放在最上面；其余（QQ 通道、待答提问、
 * 固定会话指向哪儿）都是次要信息。
 *
 * 刻意保持**纯文本**（`replyPassive` 不带 markdown 标志 → `msg_type=0`）：
 * 状态消息必须绝对发得出去，不能因为某个标题里带了 markdown 特殊字符而整条失败。
 *
 * @param {object} p
 * @param {boolean} p.channelOn - QQ 长连接是否在线。
 * @param {number} [p.pending] - 待回答提问数。
 * @param {Array<object>} [p.sessions] - `summarizeSession()` 的产物（按最近活动倒序）。
 * @param {string} [p.taskId] - 专属会话 id（`/task` 落点）。
 * @param {string} [p.chatId] - 闲聊会话 id（不引用时落点）。
 * @param {string} [p.activeId] - 用 `/sessions` 指定的那个会话 id；没指定就不显示这一行。
 * @param {string} [p.listError] - 拉会话列表失败的原因；非空时正文如实说明。
 * @param {string} [p.injectError] - 「往会话里投递」这条腿不通的原因；非空时正文如实告警。
 *   2026-10-04 那次「引用消息没办法回答」就是这条腿断了（出站推送不需要它，所以状态里
 *   只报 QQ 连着会显得一切正常）。它必须在 /status 里可见。
 * @param {string} [p.injectNote] - 已经做过的补救动作（例如"补回了签名记录，重启后生效"）。
 * @returns {string} 可直接发到 QQ 的文案。
 */
export function formatStatusText({
  channelOn = false, pending = 0, sessions = [], taskId = '', chatId = '', activeId = '', listError = '',
  injectError = '', injectNote = '',
} = {}) {
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : []
  const running = list.filter((s) => s.running === true)
  const idle = list.length - running.length

  // 2026-10-02 语气改写：主人说"机器人的话太生硬"。这一版不再用「标签：值」的仪表盘
  // 写法，而是像同事回你一句 —— 主语是"我/你/会话"，不是"通道/提问数"。
  const lines = [
    '📊 现在的状态',
    channelOn ? 'QQ 连着，有事我立刻能收到' : '⚠️ QQ 没连上，推送和回复都发不出去',
    // 收得到 ≠ 回得进去：这两条腿是分开的（推送=出站，引用回复=入站注入）
    injectError ? `⚠️ 但引用回复送不进会话：${injectError}` : '引用回复能送进会话',
    pending > 0 ? `有 ${pending} 个问题在等你回答` : '没有在等你回答的问题',
  ]
  if (injectNote) lines.push(`（${injectNote}）`)

  if (listError) {
    // 拿不到列表时**必须说出来**：显示"没有在跑的会话"是错的，会让人误以为机器闲着。
    lines.push('', `⚠️ 会话列表没读出来：${listError}`)
  } else if (running.length === 0) {
    lines.push('', '▶ 现在没有会话在跑，都闲着')
  } else {
    lines.push('', `▶ 正在跑 ${running.length} 个会话`)
    for (const [i, s] of running.slice(0, STATUS_MAX_RUNNING).entries()) {
      lines.push(`${i + 1}. ${describeSession(s)}`)
    }
    if (running.length > STATUS_MAX_RUNNING) {
      lines.push(`… 另外还有 ${running.length - STATUS_MAX_RUNNING} 个在跑`)
    }
  }

  if (!listError) lines.push('', idle > 0 ? `💤 另外 ${idle} 个闲着` : '💤 没有闲着的会话')

  lines.push('', `📌 用 /task 派活，会进这里：${slotLine(taskId, list, listError)}`)
  lines.push(`💬 不引用消息地聊天，会进这里：${slotLine(chatId, list, listError)}`)
  // 只在你真的指定过时才出现：默认状态不该多一行噪音。
  if (activeId) {
    lines.push(`🎯 你说的话现在进：${slotLine(activeId, list, listError)}（想换就发 /sessions）`)
  }
  return lines.join('\n')
}

/**
 * 组装 QQ `/sessions` 的正文 —— **纯函数**，便于单测。
 *
 * 这是"挑一个会话说话"的入口：列出最近在聊的 N 个，回数字即切过去。
 *
 * 🔴 为什么菜单里不直接把这 6 条写进去：`PUT /v2/menu` 是**整体覆盖**，
 *    而且客户端对菜单有缓存（刷新延迟至今没测到）。菜单上挂着几小时前的 6 条
 *    会话名，你点「2」却切进了别的项目 —— 那是这个功能最贵的错误。
 *    菜单只放一个固定入口「会话」，列表每次现拉，两者都不会过期。
 *
 * 刻意保持**纯文本**（`replyPassive` 不带 markdown）：会话标题里可能有
 * 下划线、星号、反引号，markdown 消息会把它们吃掉，甚至整条发失败。
 *
 * @param {object} p
 * @param {Array<object>} [p.sessions] - `summarizeSession()` 的产物（按最近活动倒序）。
 * @param {string} [p.currentId] - 当前已指定的会话 id（会标一行"现在就是它"）。
 * @param {number} [p.count] - 列几条。
 * @param {string} [p.listError] - 拉列表失败的原因；非空时如实说明，绝不假装"没有会话"。
 * @returns {string} 可直接发到 QQ 的文案。
 */
export function formatSessionPickerText({
  sessions = [], currentId = '', count = PICKER_DEFAULT_COUNT, listError = '',
} = {}) {
  if (listError) {
    return [
      '🗂 会话列表这次没读出来', '',
      `⚠️ ${listError}`, '',
      '稍等一下再发一次 /sessions 试试。',
    ].join('\n')
  }
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : []
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : PICKER_DEFAULT_COUNT
  const picked = list.slice(0, n)
  if (picked.length === 0) {
    return ['🗂 还没有可以挑的会话', '', '你在 DSH 里开一个会话之后，这里就会出现它。'].join('\n')
  }

  const lines = [`🗂 最近在聊的 ${picked.length} 个会话（回个数字切过去）`, '']
  picked.forEach((s, i) => {
    const bits = [s.title || '未命名会话']
    if (s.project) bits.push(s.project)
    bits.push(s.running ? '正在跑' : '闲着')
    bits.push(shortAgo(s.updatedAt))
    lines.push(`${i + 1}. ${bits.join(' · ')}${s.id === currentId ? ' ← 现在就是它' : ''}`)
  })
  lines.push('', '回 0 = 不指定（直接说话就进闲聊会话）')
  lines.push('引用我某条通知说话，还是优先回到那条通知的会话')
  return lines.join('\n')
}

/**
 * 切会话之后的回执 —— **纯函数**。
 *
 * 🔴 `gone` 这一支是刻意存在的：指定的会话被删掉之后**绝不能静默回落到闲聊会话**，
 *    否则你以为话进了 A、其实进了 B —— 那是这个功能最坏的失败方式。
 *
 * @param {'ok'|'cleared'|'gone'|'out-of-range'} outcome
 * @param {{title?: string, index?: number, count?: number}} [info]
 * @returns {string}
 */
export function formatPickAck(outcome, { title = '', index = 0, count = 0 } = {}) {
  switch (outcome) {
    case 'cleared':
      return '✅ 好，以后直接说话就进闲聊会话，不指定具体哪个了。'
    case 'ok':
      return `✅ 以后你说的话都进「${title}」了。想换回来再发 /sessions。`
    case 'gone':
      return `⚠️ 第 ${index} 个（${title}）已经不在了 —— 发 /sessions 重新看一次吧。`
    case 'out-of-range':
      return count > 0
        ? `列表里只有 ${count} 个，没有第 ${index} 个 —— 发 /sessions 再看一次。`
        : '我这边还没有会话列表 —— 先发 /sessions 看看有哪些。'
    default:
      return '没听懂，发 /sessions 看看有哪些会话。'
  }
}

/**
 * DSH 事件 → QQ 文本。
 *
 * 排版（用户反馈"语言太生硬"后重写）：
 *   1. 第一行说**人话**，并带上是哪个会话 —— `✅ main 跑完了`，
 *      而不是干巴巴的「任务完成」
 *   2. 空一行，接**本轮的实际结果**（来自会话事件的摘要），
 *      而不是「本轮已结束，可以查看了」这种等于没说的废话
 *   3. 最后才是工作区这类次要信息，用 `—` 起头，不喧宾夺主
 *
 * 示例：
 *   ✅ main 跑完了
 *
 *   改了去重键，顺便补了回归测试，21 项全绿。
 *
 *   — agenttool
 */
export function formatNotification(event) {
  const name = actorOf(event)
  const heads = {
    'turn-complete': name ? `✅ ${name} 跑完了` : '✅ 跑完了',
    question: name ? `❓ ${name} 想问你个事` : '❓ 想问你个事',
    error: name ? `⚠️ ${name} 出错了` : '⚠️ 出错了',
  }
  const head = heads[event?.kind] ?? `ℹ️ ${name || event?.kind || '事件'}`

  const blocks = [head]
  const summary = String(event?.summary ?? '').trim()
  if (summary !== '') blocks.push(summary)
  const meta = metaLine(event)
  if (meta !== '') blocks.push(meta)
  return blocks.join('\n\n')
}

/**
 * 把 DSH 的问题渲染成 QQ 里好回复的形态。
 *
 * 设计目标是主人明确提出的用法：**选项直接列在消息里**，他引用这条消息回
 * 「1 / 2 / 3」，或者干脆回一段自己的话。
 *
 * 2026-10-02 修正：旧版多问时把问题列成 `1. / 2.`、选项列成 `1) / 2)`，
 * 两套编号长得几乎一样 —— 用户回一个「1」根本分不清答的是"第 1 问"还是
 * "第 1 个选项"。现在问题一律用【第 N 问】包起来，只有**选项**用数字编号。
 *
 * @param {Array<object>} questions - DSH 的 AskUserQuestionItem 列表。
 * @param {{project?: string, session?: string}} [meta] - 会话/项目名，用于开头那行。
 * @returns {string} 可直接发到 QQ 的文案。
 */
/**
 * 只渲染提问的**正文**：问题 + 编号选项。
 *
 * 不含开头「❓ <会话> 想问你个事」那行（由 formatNotification 统一加），
 * 也不含结尾「引用这条消息回复…」的提示。因此它既能拼进中继消息，
 * 也能被 push 兜底直接当正文用 —— 两处共用一套编号规则，不会各写各的。
 *
 * @param {Array<object>} questions - DSH 的 AskUserQuestionItem 列表。
 * @returns {string} 多行正文。
 */
export function formatQuestionBody(questions) {
  const list = Array.isArray(questions) ? questions : []
  if (list.length === 0) return '有个问题在等你回答'
  const many = list.length > 1
  const out = []

  list.forEach((q, qi) => {
    // 多问之间空一行，读起来才分得开。
    if (qi > 0) out.push('')
    const header = typeof q?.header === 'string' ? q.header.trim() : ''
    const text = String(q?.question ?? '')
    if (many) out.push(`【第 ${qi + 1} 问${header ? ` · ${header}` : ''}】${text}`)
    else out.push(header ? `【${header}】${text}` : text)

    const opts = Array.isArray(q?.options) ? q.options : []
    for (const [oi, o] of opts.entries()) {
      out.push(`  ${oi + 1}. ${String(o?.label ?? '')}`)
      // 选项自带的说明也带上：多这一行，回复时更有把握。
      const desc = typeof o?.description === 'string' ? o.description.trim() : ''
      if (desc !== '') out.push(`     ${desc}`)
    }
    if (opts.length === 0) out.push('  （这题没有选项，你直接回一句话就行）')
    else if (q?.multiSelect) out.push('  （可以多选，像「1 3」这样回）')
  })

  return out.join('\n')
}

export function formatQuestion(questions, { project, session } = {}) {
  const list = Array.isArray(questions) ? questions : []
  const name = actorOf({ session, project })
  return [
    name ? `❓ ${name} 想问你个事` : '❓ 想问你个事',
    '',
    formatQuestionBody(list),
    '',
    list.length > 1
      ? `引用这条消息回我就行：${list.length} 个问题分 ${list.length} 行答，每行回数字（比如 1），也可以直接写你的答案。`
      : '引用这条消息回我就行：想选哪个就回数字（比如 1），也可以直接写你的答案。',
  ].join('\n')
}

export const HELP_TEXT = [
  '🤖 我是 DSH 助手，这些是我能听懂的',
  '',
  '引用我的某条通知再说话 → 接着那个会话继续',
  '直接发一句话 → 进你用 /sessions 指定的会话（没指定就是闲聊）',
  '我正有问题等你答的时候直接回 → 那就是在回答它',
  '',
  '/task 内容   当成一件新活派给我',
  '/answer 内容 当成对我提问的回答',
  '/status      看看现在在忙什么',
  '/sessions    列出最近在聊的几个会话，回个数字就切过去',
  '/use 3       切到 /sessions 列表里第 3 个（0 = 取消指定）',
  '/screen      给我截一张你电脑的屏幕',
  '/help        看这条说明',
].join('\n')

// ── 回答拼装（严格对齐 DSH 的校验规则）─────────────────────────────────────

/**
 * 把一句人话变成合法的 AskUserQuestionAnswerItem。
 *
 * DSH 的校验（packages/host/apiproxy/src/api-proxy.ts `matchesQuestions`）：
 *   - answer.id 必须等于 question.id
 *   - selected 不能有重复
 *   - custom 若给了，trim 后不能为空
 *   - **单选**（multiSelect !== true）时：
 *       custom 与 selected 不能同时给；selected 最多 1 个
 *   - selected 里每个 label 都必须是 question.options 里真实存在的
 * 所以自由文本只能走 `custom + selected: []` —— 这正是微信/QQ 里直接打字的场景。
 */
export function buildOneAnswer(text, question) {
  const t = String(text ?? '').trim()
  const options = question.options ?? []
  const labels = options.map((o) => o.label)

  if (question.multiSelect === true) {
    // 多选：按常见分隔符切开，**每一项**都能命中选项才算选项；
    // 重复项要去重（DSH 校验 selected 不能有重复），所以判据是
    // "每一项都命中过"，而不是"去重后长度相等"。
    const parts = t.split(/[，,、;；\s]+/).map((s) => s.trim()).filter(Boolean)
    const picked = []
    let allMatched = parts.length > 0
    for (const p of parts) {
      const byIndex = /^\d+$/.test(p) ? labels[Number(p) - 1] : undefined
      const hit = byIndex ?? labels.find((l) => l.trim() === p)
      if (hit === undefined) { allMatched = false; break }
      if (!picked.includes(hit)) picked.push(hit)
    }
    if (allMatched && picked.length > 0) {
      return { id: question.id, selected: picked }
    }
    return { id: question.id, selected: [], ...(t ? { custom: t } : {}) }
  }

  // 单选：先试序号，再试精确匹配选项文本，最后退化成自由文本
  if (/^\d+$/.test(t)) {
    const byIndex = labels[Number(t) - 1]
    if (byIndex !== undefined) return { id: question.id, selected: [byIndex] }
  }
  const hit = labels.find((l) => l.trim() === t)
  if (hit !== undefined) return { id: question.id, selected: [hit] }

  return { id: question.id, selected: [], ...(t ? { custom: t } : {}) }
}

/**
 * 拼装整批答案。
 *
 * 单个小问：整段话就是答案。
 * 多个小问：要求分 N 行（每行一个小问）—— 行数对不上就明确报错，
 *          不能瞎猜把 3 个答案塞给 1 个问题（DSH 会直接拒掉）。
 */
export function buildAnswers(text, questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: '我这会儿没有要问你的问题' }
  }
  if (questions.length === 1) {
    const a = buildOneAnswer(text, questions[0])
    if (a.selected.length === 0 && !a.custom) {
      return { ok: false, error: '这条我读出来是空的，再说一次？' }
    }
    return { ok: true, answers: [a] }
  }
  const lines = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (lines.length !== questions.length) {
    return {
      ok: false,
      error: `这一批有 ${questions.length} 个小问，麻烦分 ${questions.length} 行回我（一行一个小问）`,
    }
  }
  const answers = questions.map((q, i) => buildOneAnswer(lines[i], q))
  if (answers.some((a) => a.selected.length === 0 && !a.custom)) {
    return { ok: false, error: '有一行是空的，麻烦补一下' }
  }
  return { ok: true, answers }
}

// ── 来消息路由 ─────────────────────────────────────────────────────────────

/**
 * 判断一条 QQ 消息是什么。
 *
 * 规则（简单可预期，用户不用记）：
 *   - 有提问在等 → 默认当回答
 *   - 没有提问   → 默认当新任务
 *   - 以 / 开头 → 显式指令，用来打破默认
 */
export function routeIncoming(text, { hasPendingQuestion = false } = {}) {
  const raw = String(text ?? '').trim()
  if (!raw) return { kind: 'ignore' }

  if (raw.startsWith('/')) {
    const m = /^\/([A-Za-z\u4e00-\u9fa5]+)\s*([\s\S]*)$/.exec(raw)
    const cmd = (m?.[1] ?? '').toLowerCase()
    const rest = (m?.[2] ?? '').trim()
    switch (cmd) {
      case 'task': case 't': case '任务':
        return rest ? { kind: 'task', text: rest } : { kind: 'usage', text: '用法：/task 要做的事' }
      case 'answer': case 'a': case '回答':
        if (!hasPendingQuestion) return { kind: 'no_question' }
        return rest ? { kind: 'answer', text: rest } : { kind: 'usage', text: '用法：/answer 你的回答' }
      case 'status': case 's': case '状态':
        return { kind: 'status' }
      // 会话列表 / 挑一个会话说话。QQ 菜单里的「会话」按钮发的就是 /sessions。
      // `/sessions 3` 等价于 `/use 3`：列表看完顺手带上数字，少记一条命令。
      case 'sessions': case 'list': case '会话': {
        if (/^\d+$/.test(rest)) return { kind: 'pick_session', index: Number(rest), text: raw }
        return { kind: 'sessions' }
      }
      case 'use': case 'switch': case '切': case '切换':
        if (/^\d+$/.test(rest)) return { kind: 'pick_session', index: Number(rest), text: raw }
        return { kind: 'usage', text: '用法：/use 3 —— 切到 /sessions 列表里第 3 个（/use 0 取消指定）' }
      // 截图：远控不方便时，点 QQ 菜单的「屏幕」= 发一条 /screen 过来。
      // 顺带认英文同义词，主人手打 /shot 也能用。
      case 'screen': case 'screenshot': case 'shot': case '截图': case '屏幕':
        return { kind: 'screen' }
      case 'help': case 'h': case '?': case '帮助':
        return { kind: 'help' }
      default:
        return { kind: 'unknown', command: cmd }
    }
  }

  return hasPendingQuestion
    ? { kind: 'answer', text: raw }
    : { kind: 'task', text: raw }
}

/** 任务正在跑时，把消息当作"追加指令"给同一会话（steer），否则排队（queue）。 */
/**
 * 决定 QQ 来的消息用哪种投递模式。
 *
 * 🔴 为什么默认是 `queue` 而不是 `steer` —— 这是修一个真 bug，依据是 DSH 源码：
 *
 *   `client/runtime/src/client/sessions/session.ts:187`
 *     → "queue appends after the current turn; steer **interrupts** it"
 *   `client/ui-conversation/src/client/conversation-nodes/message.ts`
 *     → 两种模式落成**不同的节点类型**：queue → `user`（正常的用户消息气泡）；
 *       steer → `steering`（「插话」节点，样式完全不同、不占正常对话位）
 *
 * 之前会话一在跑就用 steer，结果**从 QQ 发来的提问在 DSH 里不像自己打的字**。
 * 主人的原话：「我更希望这个提问就跟我在 dsh 的输入框提问一样，它可在 dsh 正常显示」。
 * 而 DSH 输入框自己默认就是 queue（`input/submission-policy.ts:53`：不 running 时恒 queue），
 * 所以 queue 才真正等于"跟输入框一样"。
 *
 * @param {boolean} running - 目标会话是否正在跑。
 * @param {string} [preferred] - 用户偏好（`queue` 默认 / `steer` 想即时打断时才用）。
 * @returns {'queue'|'steer'} 投递模式。
 */
export function pickPromptMode(running, preferred = 'queue') {
  // 空闲时 steer 会退化成排队（源码用例："steer while idle … degraded to a queued
  // turn, not an in-turn insert"），所以只有"真的在跑 + 用户明确选了 steer"才用它。
  if (running && preferred === 'steer') return 'steer'
  return 'queue'
}

// ── 状态持久化（只存非凭据信息）───────────────────────────────────────────

export class BotState {
  constructor(file) {
    this.file = file
    this.data = {
      openId: null,
      sessionId: null,
      chatSessionId: null,
      /**
       * 「当前会话」指针：你在 QQ 里用 /sessions 挑的那个会话。
       *
       * 它是**持久状态**而不是一次性动作 —— 选一次之后，你不引用消息说的话
       * 就一直进它，直到你再切（或发 `/use 0` 取消）。null / 空串 = 没指定。
       */
      activeSessionId: null,
      /** 上次发出会话列表的时刻（裸数字选会话的时间窗起点）。 */
      pickerAt: 0,
      /** 上次那份名单的会话 id，顺序与列表里显示的编号一一对应。 */
      pickerIds: [],
      lastSeq: null, seen: [], sentRefs: {}, recent: [],
    }
    this._load()
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      this.data = { ...this.data, ...JSON.parse(raw) }
    } catch { /* 首次运行没有文件，正常 */ }
    // 老版本状态文件里没有这些键，补上默认值
    if (this.data.sentRefs === null || typeof this.data.sentRefs !== 'object') this.data.sentRefs = {}
    if (!Array.isArray(this.data.seen)) this.data.seen = []
    if (!Array.isArray(this.data.recent)) this.data.recent = []
    if (!Array.isArray(this.data.pickerIds)) this.data.pickerIds = []
    if (!Number.isFinite(this.data.pickerAt)) this.data.pickerAt = 0
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    } catch { /* 存不下不影响主流程 */ }
  }

  set(patch) {
    Object.assign(this.data, patch)
    this.save()
  }

  /** 消息去重：官方明确说同一条 msg_id 可能重复推送。 */
  markSeen(id, max = 500) {
    if (!id) return false
    if (this.data.seen.includes(id)) return true
    this.data.seen.push(id)
    if (this.data.seen.length > max) this.data.seen = this.data.seen.slice(-max)
    this.save()
    return false
  }

  /**
   * 记住「我发出去的哪条消息属于哪个会话」。
   *
   * 这是**引用回复**能落地的前提：机器人发消息时响应里带 `ext_info.ref_idx`，
   * 你引用那条消息回复时，事件里会带 `ref_msg_idx` —— 两者是同一个索引。
   * 靠它反查，就知道你这条回复该进哪个会话。
   *
   * @param {string} refIdx - 发送响应里的 `ext_info.ref_idx`。
   * @param {{sessionId?: string, session?: string, kind?: string, askId?: string}} target
   */
  addSentRef(refIdx, target, max = 300) {
    if (!refIdx) return
    this.data.sentRefs[refIdx] = { ...target, at: Date.now() }
    const keys = Object.keys(this.data.sentRefs)
    // 只保留最近的 max 条，避免状态文件无限膨胀
    if (keys.length > max) {
      keys.sort((a, b) => (this.data.sentRefs[a].at ?? 0) - (this.data.sentRefs[b].at ?? 0))
      for (const k of keys.slice(0, keys.length - max)) delete this.data.sentRefs[k]
    }
    this.save()
  }

  /** 按 `ref_msg_idx` 反查这条被引用消息属于哪个会话。 */
  refTarget(refIdx) {
    if (!refIdx) return null
    return this.data.sentRefs[refIdx] ?? null
  }

  /**
   * 记一条「刚发出去的通知」到时间线（最新在前）。
   *
   * 这是 {@link BotState.refTarget} 的**兜底数据源**：ref_idx 有可能拿不到
   * （老版本状态文件、异常响应、消息被撤回等），那时引用反查会落空。
   *
   * @param {{sessionId?: string, session?: string, kind?: string, refIdx?: string}} target
   * @param {number} [max] - 保留条数。
   */
  noteRecent(target, max = 20) {
    const list = Array.isArray(this.data.recent) ? this.data.recent : []
    this.data.recent = [{ ...target, at: Date.now() }, ...list].slice(0, max)
    this.save()
  }

  /**
   * 引用反查的兜底：ref_idx 认不出来时，如果**最近一条通知刚刚发出**，就用它。
   *
   * 为什么值得冒"可能送错会话"的风险：反查落空时当前代码回一句「认不出这条消息」，
   * 用户的提问就**整条丢失**了（既不进任何会话、也不会被回答）—— 那比"落到最近那个
   * 会话"糟糕得多。窗口限制得很短，避免引用一条很旧的消息时送错地方。
   *
   * @param {number} [withinMs] - 兜底时间窗，默认 5 分钟。
   * @returns {object|null} 兜底目标（带 `viaFallback: true`）。
   */
  recentTarget(withinMs = 5 * 60 * 1000) {
    const list = Array.isArray(this.data.recent) ? this.data.recent : []
    const first = list[0]
    if (!first?.sessionId) return null
    if (Date.now() - (first.at ?? 0) > withinMs) return null
    return { ...first, viaFallback: true }
  }
}

/**
 * 从 C2C_MESSAGE_CREATE 事件里取出「你引用的是哪条消息」。
 *
 * 官方结构（见「单聊消息事件」文档）：
 *   message_type = 103 表示引用消息；
 *   `message_scene.ext` 是 `["ref_msg_idx=REFIDX_xxx==", "msg_idx=REFIDX_yyy=="]`
 *   这样的 key=value 字符串数组，`ref_msg_idx` 就是被引用消息的索引。
 *
 * ⚠️ 刻意**不按 message_type===103 判断**：真正可靠的信号是 ext 里有没有
 *    `ref_msg_idx`。这样即使官方调整 message_type，引用识别也不会静默失效。
 *
 * @param {object} data - C2C_MESSAGE_CREATE 的事件体。
 * @returns {string} 被引用消息的 ref_idx；不是引用消息时返回空串。
 */
export function extractRefIdx(data) {
  const ext = data?.message_scene?.ext
  if (!Array.isArray(ext)) return ''
  for (const item of ext) {
    const m = /^ref_msg_idx=(.+)$/.exec(String(item ?? '').trim())
    if (m) return m[1].trim()
  }
  return ''
}

/**
 * 决定一条 QQ 消息该往哪去。
 *
 * 规则（用户拍板）：
 *   - **引用**了我发的某条通知 → 回到**那条通知对应的会话**接着聊
 *   - **不引用** → 当作「跟机器人闲聊」，进闲聊会话
 *   - 例外：**有提问在等**时不引用也当作答 —— 否则 agent 会一直卡在等回答，
 *     而这条规则是"防卡死"的安全兜底，比严格照字面执行更重要
 *   - 例外：**刚看过 /sessions 列表**时回一个纯数字 → 切到列表里那个会话
 *     （但上面那条"有提问在等"仍然优先 —— 回「1」是在回答提问）
 *   - `/task` 等显式指令优先级最高，压过上面全部
 *
 * @param {object} opts
 * @param {string} opts.text - 消息正文。
 * @param {string} opts.refIdx - {@link extractRefIdx} 的结果。
 * @param {boolean} opts.hasPendingQuestion - 当前是否有提问在等回答。
 * @param {object|null} opts.refTarget - {@link BotState.refTarget} 的结果。
 * @param {boolean} [opts.pickerActive] - 会话列表还在有效期内（见 {@link isPickerFresh}）。
 * @returns {{kind: string, reason: string, text?: string, sessionId?: string, askId?: string}}
 */
export function routeMessage({ text, refIdx, hasPendingQuestion, refTarget, pickerActive = false }) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { kind: 'ignore', reason: '空消息' }

  // ① 显式指令最优先：用户打了 `/task` 就是要覆盖默认判断
  if (raw.startsWith('/')) {
    return { ...routeIncoming(raw, { hasPendingQuestion }), reason: '显式指令' }
  }

  // ② 引用了我发的消息 → 回到那条消息对应的会话
  if (refIdx) {
    // 引用的是我刚发的**截图**：它不属于任何会话，别硬塞进某个会话里。
    // 单独回一句更清楚（否则会落到下面 unknown_ref 的"认不出"上，误导成"太久被清理了"）。
    if (refTarget?.kind === 'screen') {
      return { kind: 'screen_ref', text: raw, reason: '引用的是一条截图' }
    }
    if (refTarget?.sessionId) {
      // 引用的是我发的**提问** → 当作那个提问的答案。
      if (refTarget.kind === 'question') {
        // ⚠️ 提问已经超时或被答掉了：**绝不能**退化成"当消息注入会话"，
        //    否则你回一句「1」会被原样塞进工作会话里，莫名其妙。
        //    这种情况明确告诉你提问已结束，让你重新发。
        if (!hasPendingQuestion) {
          return { kind: 'no_question', text: raw, reason: '引用的提问已经结束' }
        }
        return { kind: 'answer', text: raw, askId: refTarget.askId, reason: '引用提问' }
      }
      return {
        kind: 'prompt', text: raw, sessionId: refTarget.sessionId,
        session: refTarget.session ?? '', reason: '引用通知',
      }
    }
    // 引用的是一条我认不出来的消息（你自己发的、或太久了已被清理）
    return { kind: 'unknown_ref', text: raw, reason: '引用的消息认不出来' }
  }

  // ③ 没引用：有提问在等就先作答（防 agent 卡死），否则当闲聊
  //
  // 🔴 作答**优先于**选会话：agent 卡在提问上等你回「1」的时候，
  //    那个「1」是在回答它，不是在说"切到第 1 个会话"。
  //    顺序反了会让 agent 永远等不到答案 —— 这是最不能犯的错。
  if (hasPendingQuestion) return { kind: 'answer', text: raw, reason: '有提问在等，按作答处理' }

  // ④ 刚看过 /sessions 的名单，回一个纯数字 = 选会话。
  //    只在名单还有效的那几分钟内生效（见 PICK_WINDOW_MS），
  //    否则你很久以后随口说的「2」会被解释成"切会话"。
  if (pickerActive && /^\d+$/.test(raw)) {
    return { kind: 'pick_session', index: Number(raw), text: raw, reason: '刚发过会话列表，按选择处理' }
  }

  return { kind: 'chat', text: raw, reason: '闲聊' }
}
