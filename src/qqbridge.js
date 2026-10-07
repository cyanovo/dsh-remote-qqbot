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
 *
 * 会话列表保持短窗：会话是易变对象（随时新建/改名），隔久了编号虽然不会错位
 * （名单是真的存下来了），但你自己已经记不清哪个是第 3 个了 —— 想慢慢挑就发 `/use 3`。
 */
export const PICK_WINDOW_MS = 5 * 60 * 1000

/**
 * 「工作区列表」的有效期（`/task` 发的那份）—— **故意比会话名单长得多**。
 *
 * 2026-10-07 的实测：08:45:15 发名单 → 09:09:18 回「2」（隔 24 分钟）→ 名单早已作废
 * → 路由判定"这不是在选名单" → 那个「2」被当成一句派活正文**注入了会话**：
 * 选择没生效，还白白跑了一轮（转录里 `user/message` 的正文就是 `"2"`）。
 *
 * 根因不是"窗口设短了"，而是**过期之后的降级方式错了**：数字不该变成派活正文。
 * 所以这一版两件事一起改：
 *   ① 工作区名单放宽到 24 小时（手机上从看到名单到想好选哪个，24 分钟都算快的）；
 *   ② 裸数字在**没有任何有效名单**时一律不当派活正文，改成问一句（见 routeMessage ⑤）。
 * 光有 ① 不够 —— 窗口再长也会过期；光有 ② 也不够 —— 那会让你白等一天才被拦。
 */
export const WORKSPACE_PICK_WINDOW_MS = 24 * 60 * 60 * 1000

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
 * 一段时长说成人话：`24 分钟` / `3 小时` / `2 天`（**不含"前"字**，给拼句子用）。
 *
 * 不足 1 分钟按 1 分钟算 —— 这一步只会用在"名单明明已经过期"的场合，
 * 说「0 分钟前」会让人以为是自己看错了时间。
 */
function ageText(ms) {
  const min = Math.max(1, Math.floor(Math.max(0, Number(ms) || 0) / 60000))
  if (min < 60) return `${min} 分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时`
  return `${Math.floor(hr / 24)} 天`
}

/**
 * 名单发出至今多久了 —— **纯函数**。
 *
 * @param {{pickerAt?: number, ids?: string[], pickerIds?: string[]}} picker - 状态文件里记的那一份。
 * @param {number} [now] - 当前时刻（测试可注入）。
 * @returns {number|null} 毫秒数；**`null` = 压根没有名单**（从没发过，或被重启清掉了）。
 *   有名单时不会返回负数（时钟回拨按 0 算）。
 *
 * 为什么要区分"没有名单"和"名单太老"：这两种情况要给**不一样**的回话 ——
 * 前者是"先发 /task 我列一份"，后者是"你回的数字对上了 24 分钟前那份名单，它作废了"。
 */
export function pickerAge(picker, now = Date.now()) {
  const src = picker ?? {}
  const pickerAt = src.pickerAt ?? 0
  const ids = src.ids ?? src.pickerIds ?? []
  if (!Array.isArray(ids) || ids.length === 0) return null
  if (!Number.isFinite(pickerAt) || pickerAt <= 0) return null
  return Math.max(0, now - pickerAt)
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
  const age = pickerAge(picker, now)
  return age !== null && age <= windowMs
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
 * @returns {{id: string, title: string, project: string, cwd: string, turns: number|null, running: boolean, updatedAt: number}}
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
    // ⚠️ 完整路径也要留着：`project` 只是给人看的短名，而"按工作区派活"必须
    //    拿完整 cwd 去 `session/create`（见 qqruntime 的 ensureTaskSession）。
    cwd: String(item?.cwd ?? '').trim(),
    turns: Number.isFinite(turns) ? turns : null,
    running: item?.running === true,
    updatedAt: Number.isFinite(item?.updatedAt) ? item.updatedAt : 0,
  }
}

/** `D:\a\b\c` / `/srv/a/b` → `c` / `b`（只留最后一段，空值返回空串）。 */
export function shortPath(p) {
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
 * @param {string} [p.runningVersion] - **内存里跑着的**插件版本；没给就不显示这一行。
 * @param {string} [p.installedVersion] - **磁盘上装着的**插件版本。
 *   两者不一致 = "装完还没重启"，那是 2026-10-07 主人被卡住的坑，必须在 /status 里看得见。
 * @returns {string} 可直接发到 QQ 的文案。
 */
export function formatStatusText({
  channelOn = false, pending = 0, sessions = [], taskId = '', chatId = '', activeId = '', listError = '',
  injectError = '', injectNote = '', runningVersion = '', installedVersion = '',
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

  // 插件版本：主人 2026-10-07 反复问"为什么新功能没有、它却说已经是最新"——
  // 根因就是这条看不见的错位（磁盘上装了新版、内存里跑的还是旧版）。放进 /status，
  // 让"我在跑哪一版"一句话就能问到，不必再翻设置页或找日志。
  const runningVer = String(runningVersion ?? '').trim()
  const diskVer = String(installedVersion ?? '').trim()
  if (runningVer !== '') {
    lines.push(diskVer !== '' && diskVer !== runningVer
      ? `⚠️ 插件：跑的是 ${runningVer}，磁盘上装的已经是 ${diskVer} —— 重启 DSH 才会换过去`
      : `🧩 插件 ${runningVer}（磁盘上装的也是 ${diskVer || runningVer}）`)
  }

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

  const lines = [`🗂 最近在聊的 ${picked.length} 个会话（点下面的按钮，或者发 /use 数字）`, '']
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
 * 剥掉「消息按钮」点出来时带的 `@机器人` 前缀 —— **纯函数**。
 *
 * 官方：指令按钮（`action.type=2`）点击后「自动在输入框插入 `@bot data`」。
 * 也就是说点一下「看状态」发过来可能是 `@机器人 /status`，而不是干净的 `/status`。
 * 不剥掉这段前缀，按钮点了等于发了一句普通消息 —— 整个按钮功能就是白做的。
 *
 * ⚠️ **只在 `@某段` 后面紧跟 `/` 时才剥**：以 `@` 开头的正常内容（`@张三 你好`）
 * 一个字都不动，避免为了按钮去改普通消息的含义。
 *
 * @param {string} text - 原始消息正文。
 * @returns {string} 可用于判指令的文本。
 */
export function stripBotMention(text) {
  return String(text ?? '').replace(/^@[^\s/]{1,32}\s+(?=\/)/, '')
}

/** 按钮文字上限（官方：`render_data.label` 最多 10 字符）。 */
export const BUTTON_LABEL_MAX = 10
/** 一个 keyboard 最多几行、每行最多几个按钮（官方：最多 5 行、每行最多 5 个）。 */
export const KEYBOARD_MAX_ROWS = 5
export const KEYBOARD_MAX_PER_ROW = 5

/** 按码点截断到 n 个字符（中文一字算一个；不要用 slice，会把 emoji 切半个）。 */
function cutChars(text, n) {
  const chars = [...String(text ?? '').replace(/\s+/g, ' ').trim()]
  return chars.slice(0, Math.max(1, n)).join('')
}

/**
 * 一个「指令按钮」—— **纯函数**。
 *
 * `render_data.label` 是**显示**在按钮上的文字，`action.data` 才是点下去发回来的内容。
 * 所以显示文字可以写得像人话（「立即更新」），而 data 是命令（`/update`）。
 * 两者都受官方限制：label ≤10 字符。
 *
 * @param {string} label - 按钮上显示的文字。
 * @param {string} data - 点下去发回来的内容（一般是一条 `/命令`）。
 * @param {{style?: number, visited?: string}} [opts] - style：0 灰框 / 1 蓝框 / 3 白底红字 / 4 蓝底白字。
 * @returns {object} 可直接放进 `keyboard.content.rows[].buttons[]` 的对象。
 */
export function makeCmdButton(label, data, { style = 1, visited = '' } = {}) {
  const text = cutChars(label, BUTTON_LABEL_MAX)
  const cmd = String(data ?? '').trim()
  return {
    id: (cmd || text).slice(0, 20),
    render_data: {
      label: text,
      visited_label: visited ? cutChars(visited, BUTTON_LABEL_MAX) : cutChars(`✓ ${text}`, BUTTON_LABEL_MAX),
      style,
    },
    action: {
      type: 2,                  // 指令按钮：点了把 data 当一条消息发回来
      permission: { type: 2 },  // 所有人可点
      data: cmd,
      enter: true,              // 单聊可用：点一下直接发送，不用再按一次
      reply: false,
      unsupport_tips: '你的 QQ 版本不支持按钮，把这条命令打到输入框发给我也行',
    },
  }
}

/**
 * 把「若干行按钮」拼成消息的 `keyboard` 字段 —— **纯函数**。
 *
 * 官方上限：最多 5 行、每行最多 5 个按钮。**超限就整个不装**（宁可没有按钮，
 * 也不要发一条平台会拒的消息 —— 那会把整条通知一起弄丢）。
 *
 * @param {Array<Array<object>>} rows - 二维数组，每个元素是一行按钮。
 * @returns {{content: {rows: Array}}|null}
 */
export function buildKeyboard(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => Array.isArray(r) && r.length > 0)
  if (list.length === 0 || list.length > KEYBOARD_MAX_ROWS) return null
  if (list.some((r) => r.length > KEYBOARD_MAX_PER_ROW)) return null
  return { content: { rows: list.map((r) => ({ buttons: r })) } }
}

/** 「有新版本」提醒下面那排按钮：忽略本次 / 立即更新。 */
export function buildUpdateNoticeKeyboard() {
  return buildKeyboard([[
    makeCmdButton('忽略本次', '/skip'),
    makeCmdButton('立即更新', '/update', { style: 4 }),
  ]])
}

/**
 * 「名单选一个」那排数字按钮 —— **纯函数**。
 *
 * 为什么给名单配按钮：名单下面那些编号，在手机上要手打一个数字发回来；而只要你是
 * 手打的，就受时间窗限制（见 {@link WORKSPACE_PICK_WINDOW_MS}）。点按钮发回来的是一条
 * **显式指令**（`/pick 3`），显式指令不查时间窗 —— 只要名单还在状态文件里就能选。
 *
 * 按钮上只印数字：名单就在上面几行，编号与内容挨着看最省事；印名字会挤到 10 字符上限
 * （见 {@link BUTTON_LABEL_MAX}），截成半个词反而认不出。
 *
 * @param {string} prefix - 指令前缀，形如 `'/pick '`、`'/use '`、`'/open '`。
 * @param {number} count - 发几个（= 名单里实际有几条）。**0 条就一个都不装**（含 extra）——
 *   没有编号行的"新对话"会让人以为刚发过一份名单。
 * @param {{extra?: Array<object>}} [opts] - 追加在最后一行的按钮（如「新对话」）。
 *   单独占一行，免得跟编号混在一起；行数超上限时整个返回 null。
 * @returns {{content: {rows: Array}}|null} 超过 5 行时返回 null（名单太长就不装按钮）。
 */
export function buildNumberButtons(prefix, count, { extra = [] } = {}) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  const tail = (Array.isArray(extra) ? extra : []).filter(Boolean)
  // 0 条 = 没有名单可点：这时**一个按钮都不装**，连「新对话」也不装 ——
  // 没有编号行的"新对话"会让人以为刚发过一份名单。
  if (n === 0) return null
  const buttons = []
  for (let i = 1; i <= n; i += 1) {
    buttons.push(makeCmdButton(String(i), `${prefix}${i}`))
  }
  const rows = []
  for (let i = 0; i < buttons.length; i += KEYBOARD_MAX_PER_ROW) {
    rows.push(buttons.slice(i, i + KEYBOARD_MAX_PER_ROW))
  }
  if (tail.length > 0) rows.push(tail)
  return buildKeyboard(rows)
}

/** `/help` 回复下面那排按钮：把主要命令变成可点的。 */
export function buildHelpKeyboard() {
  return buildKeyboard([
    [
      makeCmdButton('看状态', '/status'),
      makeCmdButton('挑工作区', '/task'),
      makeCmdButton('会话', '/sessions'),
    ],
    [
      makeCmdButton('屏幕', '/screen'),
      makeCmdButton('新对话', '/new'),
      makeCmdButton('更新', '/update'),
      makeCmdButton('帮助', '/help'),
    ],
  ])
}

/**
 * 按钮上**留给选项文字**几个字（`N.` 那部分之外的余量）—— **纯函数**。
 *
 * 单独抽出来是为了「正文要不要补一句」和「按钮写什么」用**同一个口径**：
 * 正文那边靠它判断"这个选项名在按钮上会不会被切"（见 `formatQuestionBody`）。
 *
 * @param {number} index - 选项序号（0 起）。
 * @param {{max?: number}} [opts] - 按钮文字上限（官方 10 字符）。
 * @returns {number} 还能放几个字（≥0）。
 */
export function optionLabelRoom(index, { max = BUTTON_LABEL_MAX } = {}) {
  const num = String((Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0) + 1)
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : BUTTON_LABEL_MAX
  return Math.max(0, limit - num.length - 1)
}

/**
 * 选项文字 → 按钮上那点地方能放下的**短标签**（`1.方案A`）—— **纯函数**。
 *
 * 只做三件事：剥掉模型自己加的编号前缀、剥掉「（推荐）」这种装饰、按码点截断。
 * 剥掉的都是**重复信息**：编号由按钮给（正文那条说明也按同一个编号），「推荐」标在正文那行上。
 *
 * @param {string} label - 原始选项文字（DSH 里那个 `label`）。
 * @param {number} index - 选项序号（0 起）。
 * @param {{max?: number}} [opts] - 按钮文字上限（官方 10 字符）。
 * @returns {string} 形如 `1.方案A`；放不下正文时只留序号。
 */
export function optionButtonLabel(label, index, { max = BUTTON_LABEL_MAX } = {}) {
  const num = String((Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0) + 1)
  const room = optionLabelRoom(index, { max })
  const clean = cleanOptionText(label)
  if (room < 2 || clean === '') return num
  return `${num}.${cutChars(clean, room)}`
}

/**
 * 选项文字里那些**不该再进按钮**的东西 —— **纯函数**。
 *
 * 为什么必须剥：
 *   - 「A.」「1、」「B)」这类前缀是模型自己编的序号，而按钮左边已经印了 `N.`；
 *     10 字上限里多留一个"1."，真正能看的内容就少两个字。
 *   - 「（推荐）」是**元信息**不是选项名。它在 10 字上限里极容易把括号切成半个
 *     （`1.A. 一行一个按钮（推` 这种半截括号，2026-10-07 主人原话："我根本看不见是什么东西"）；
 *     而正文那行会单独标「（推荐）」，剥掉不丢信息。
 */
export function cleanOptionText(label) {
  return String(label ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[A-Za-z][.)、．:：]\s*/, '')
    .replace(/^\d+\s*[.)、．:：]\s*/, '')
    .replace(/\s*[（(]\s*(?:推荐|recommended)\s*[）)]\s*$/i, '')
    .trim()
}

/** 这个选项是不是被标了「（推荐）」—— 正文那行要靠它标回来。 */
export function isRecommendedLabel(label) {
  return /\s*[（(]\s*(?:推荐|recommended)\s*[）)]\s*$/i.test(String(label ?? ''))
}

/**
 * 把「一个单选提问」的选项变成消息按钮（QQ 里那种可点的蓝色文字）—— **纯函数**。
 *
 * 为什么是「恰好一个问题 + 单选」才装按钮：
 *   - 多个问题时，一次点击没办法把 N 个问题都答完（`relayAsk` 要求一行一个答案），
 *     点了只会答掉其中一个，反而更乱；
 *   - 多选同理（本来就要点好几个），按钮不比打字省事。
 *
 * 🔴 **一行一个按钮**（1.0.26 改；以前是 5 个挤一行）。主人 2026-10-07 的原话：
 *    「按钮里的字还是挺多的，你一行放 4 个按钮，我根本看不见是什么东西」——
 *    一行 4~5 个时每个按钮只分到 1/5 宽度，10 字上限里塞「2.A + 顺带把名单」这种被硬切
 *    的文字，手机上等于看不清。一行一个后每个按钮占满整行，标签才真的能读。
 *    代价：行数上限 5 = 选项数上限 5（与旧版的一行 5 个**同一个上限**，没有变少）。
 *
 * `action.data` 放的是**显式指令** `/answer N`（不是裸数字）：1.0.24 起"不引用、不带 / 的消息
 * 一律当闲聊"，裸数字不再被当作答 —— 按钮要是还发裸数字，点了就等于白发一句闲聊。
 * 解析答案那条路本来就认数字（`buildOneAnswer` 里 `labels[Number(p) - 1]`），
 * 所以 `/answer N` 与"引用提问后回一个数字"走的是**同一条**解析路。
 *
 * @param {Array<object>} questions - DSH 的提问列表（`{id, options:[{label}], multiSelect}`）。
 * @param {{labelMax?: number}} [opts]
 * @returns {{content: {rows: Array}}|null} 可直接放进消息 `keyboard` 字段的对象；不装按钮时 null。
 */
export function buildOptionKeyboard(questions, { labelMax = BUTTON_LABEL_MAX } = {}) {
  const list = Array.isArray(questions) ? questions.filter(Boolean) : []
  if (list.length !== 1) return null
  const q = list[0]
  if (q.multiSelect === true) return null
  const options = Array.isArray(q.options)
    ? q.options.filter((o) => o && typeof o.label === 'string')
    : []
  if (options.length === 0 || options.length > KEYBOARD_MAX_ROWS) return null

  const rows = options.map((o, i) => [makeCmdButton(
    optionButtonLabel(o.label, i, { max: labelMax }),
    `/answer ${i + 1}`,
    { visited: `✓ ${i + 1}` },
  )])
  return buildKeyboard(rows)
}

/**
 * 组装「挑工作区」的名单 —— **纯函数**。
 *
 * `/task` 不带内容时发这一份：先挑工作区，再发要做的事。工作区就是 DSH 会话的工作目录
 * （`cwd`），所以名单直接由会话列表归并而来：同一个目录下的会话算一个工作区，
 * 按最近活动倒序。
 *
 * @param {object} p
 * @param {Array<{cwd: string, name: string, sessions: number, updatedAt: number}>} [p.workspaces]
 *   已按"最近活动倒序"排好的工作区。
 * @param {string} [p.currentCwd] - 上次选过的工作区（那一行标"就是它"）。
 * @param {number} [p.count] - 最多列几个。
 * @param {string} [p.listError] - 拉列表失败的原因；非空时如实说明，绝不假装"没有工作区"。
 * @returns {string} 可直接发到 QQ 的文案。
 */
export function formatWorkspacePickerText({
  workspaces = [], currentCwd = '', count = PICKER_DEFAULT_COUNT, listError = '',
} = {}) {
  if (listError) {
    return [
      '🗂 工作区列表这次没读出来', '',
      `⚠️ ${listError}`, '',
      '稍等一下再发一次 /task 试试。',
    ].join('\n')
  }
  const list = Array.isArray(workspaces) ? workspaces.filter((w) => w && w.cwd) : []
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : PICKER_DEFAULT_COUNT
  const picked = list.slice(0, n)
  if (picked.length === 0) {
    return [
      '🗂 还没有可以挑的工作区', '',
      '你在 DSH 里开一个会话之后，这里就会出现它的目录。',
      '也可以直接发 `/task 要做的事` —— 那会进默认工作区。',
    ].join('\n')
  }
  const lines = ['🗂 挑个工作区，再把你的事发给我 —— 点下面的按钮，或者发 /pick 数字', '']
  picked.forEach((w, i) => {
    const bits = [w.name || shortPath(w.cwd)]
    if (w.sessions > 0) bits.push(`${w.sessions} 个会话`)
    bits.push(shortAgo(w.updatedAt))
    lines.push(`${i + 1}. ${bits.join(' · ')}${w.cwd === currentCwd ? ' ← 就是它' : ''}`)
  })
  lines.push('', '选好工作区之后，我再列出它里面的会话 —— 挑一个，或者开个新对话。')
  lines.push('这份名单留 24 小时，慢慢想 —— 过期了重发 /task 就行。')
  lines.push('直接派给上次那个工作区：`/task 要做的事`')
  return lines.join('\n')
}

/**
 * 挑工作区之后的回执 —— **纯函数**。
 *
 * 🔴 失败的三支都**不能静默回落**：选中的那个不在了就明说，悄悄换一个工作区
 *    等于把你的活派进了你不知道的目录。
 *
 * @param {'ok'|'out-of-range'|'gone'|'usage'} outcome
 * @param {{name?: string, cwd?: string, session?: string, index?: number, count?: number}} [info]
 * @returns {string}
 */
export function formatWorkspacePickAck(outcome, {
  name = '', cwd = '', session = '', index = 0, count = 0,
} = {}) {
  switch (outcome) {
    case 'ok':
      return [
        `✅ 工作区已选：${name || shortPath(cwd)}`,
        cwd,
        '',
        `接下来你发的话都派进${session ? `「${session}」` : '这个工作区的专属会话'}。`,
        '要换工作区：再发一次 /task',
      ].join('\n')
    case 'gone':
      return `⚠️ 第 ${index} 个（${name}）已经不在了 —— 再发一次 /task 重新挑。`
    case 'out-of-range':
      return count > 0
        ? `列表里只有 ${count} 个工作区，没有第 ${index} 个 —— 再发一次 /task 看看。`
        : '我这边还没有工作区列表 —— 先发 /task 看看有哪些。'
    // 名单本身没了（重启清了状态，或者从没发过）：**不许**悄悄拿"此刻的列表"顶上 ——
    // 你没看过那份列表，编号对你没有任何意义，选出来大概率是别的目录。
    case 'no-list':
      return [
        '我这边没有在等你选的工作区名单 —— 先发 /task，我列一份给你。',
        '（名单会跟着状态文件留着，重发一份也不费事。）',
      ].join('\n')
    default:
      return '没听懂，发 /task 看看有哪些工作区。'
  }
}

/**
 * 派活第二步：列出**某个工作区里**的会话，让你挑一个或者开新对话 —— **纯函数**。
 *
 * 为什么要第二步（主人 2026-10-07 提的需求）：
 *   以前 `/task` 是"一个工作区一个固定专属会话"，你没法在同一个工作区里接着**别的**会话
 *   说话，也没法明确地"从零开始一个新对话"。现在挑完工作区先列它里面的会话，
 *   由你决定这次是接着聊还是开新的。
 *
 * 编号规则（和会话名单故意不同）：**0 = 开新对话**。
 *   会话名单里 0 是"取消指定"，但这里不存在"不指定"—— 你既然挑了这个工作区，
 *   下一步总要落到某个会话上；0 留给"新对话"这件最常用的事。
 *
 * @param {object} p
 * @param {string} [p.cwd] - 工作区目录（列表为空时显示用）。
 * @param {string} [p.name] - 工作区名（优先显示）。
 * @param {Array<{id: string, title: string, running: boolean, updatedAt: number}>} [p.sessions]
 *   已按最近活动倒序排好的会话。
 * @param {string} [p.currentId] - 现在派活用的会话（那一行标"就是它"）。
 * @param {string} [p.lastUsedId] - 这个工作区上次用过的会话（标"上次用的"）。
 * @param {number} [p.count] - 最多列几个。
 * @param {string} [p.listError] - 拉列表失败的原因；非空时如实说明，绝不假装"没有会话"。
 * @returns {string}
 */
export function formatTaskSessionPickerText({
  cwd = '', name = '', sessions = [], currentId = '', lastUsedId = '',
  count = PICKER_DEFAULT_COUNT, listError = '',
} = {}) {
  const where = name || shortPath(cwd) || '这个工作区'
  if (listError) {
    return [
      '🗂 这个工作区里的会话这次没读出来', '',
      `⚠️ ${listError}`, '',
      '稍等一下再发一次 /task 试试。',
    ].join('\n')
  }
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : []
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : PICKER_DEFAULT_COUNT
  const picked = list.slice(0, n)
  if (picked.length === 0) {
    // 兜底：正常情况下调用方会发现"一个会话都没有"并直接开新对话，不会发这条。
    return [
      `🗂 ${where} 里还没有会话`, '',
      '回 0 或者点下面的「新对话」按钮，我就在这个工作区开一个。',
    ].join('\n')
  }
  const lines = [`🗂 ${where} 里的会话（点下面的按钮，或者发 /open 数字）`, '']
  picked.forEach((s, i) => {
    const bits = [s.title || '未命名会话']
    bits.push(s.running ? '正在跑' : '闲着')
    bits.push(shortAgo(s.updatedAt))
    const mark = s.id === currentId
      ? ' ← 现在就是它'
      : (s.id === lastUsedId ? ' ← 上次派活用的' : '')
    lines.push(`${i + 1}. ${bits.join(' · ')}${mark}`)
  })
  lines.push('', '回 0 = 在这个工作区开一个新对话')
  lines.push('选好之后，你发的话就派进那个会话；要换工作区：再发一次 /task')
  return lines.join('\n')
}

/**
 * 派活第二步之后的回执 —— **纯函数**。
 *
 * 🔴 `gone` 与 `no-list` 两支都**不能静默回落**：会话不在了、名单没了，都明说让你重挑。
 *    悄悄把你换到另一个会话（尤其另一个工作区的会话），是这个功能最坏的失败方式。
 *
 * @param {'ok'|'new'|'gone'|'out-of-range'|'no-list'|'no-workspace'} outcome
 * @param {{name?: string, cwd?: string, session?: string, index?: number, count?: number}} [info]
 * @returns {string}
 */
export function formatTaskSessionPickAck(outcome, {
  name = '', cwd = '', session = '', index = 0, count = 0,
} = {}) {
  const where = name || shortPath(cwd)
  switch (outcome) {
    case 'ok':
      return [
        `✅ 派活会话已选：${session || '那个会话'}`,
        cwd || where,
        '',
        '接下来你发的话都进它。要换：再发一次 /task 重新挑。',
      ].join('\n')
    case 'new':
      return [
        `✅ 已经开了个新对话：${session || '新会话'}`,
        cwd || where,
        '',
        '接下来你发的话都进这个新对话（原来那些会话都还在，随时能再挑）。',
      ].join('\n')
    case 'gone':
      return `⚠️ 第 ${index} 个（${session || '那个会话'}）已经不在了 —— 再发一次 /task 重新挑。`
    case 'out-of-range':
      return count > 0
        ? `这个工作区里只有 ${count} 个会话，没有第 ${index} 个 —— 再发一次 /task 看看。`
        : '这个工作区里现在没有会话 —— 回 0 或者点「新对话」我开一个给你。'
    // 名单没了（重启清了状态、或者压根没走到那一步）：**不许**拿"此刻的列表"顶上 ——
    // 那个编号你没看过，选出来大概率是别的会话。
    case 'no-list':
      return [
        '我这边没有在等你选的工作区会话名单 —— 先发 /task，我列一份给你。',
        '（只是想开个新对话的话，直接发 /new 也行。）',
      ].join('\n')
    // 连工作区都没挑过：不知道在哪儿建会话，绝不猜一个目录。
    case 'no-workspace':
      return [
        '我还不确定你说的是哪个工作区 —— 先发 /task 挑一个。',
        '（挑过工作区之后，这里回 0 就是开新对话。）',
      ].join('\n')
    default:
      return '没听懂，发 /task 看看有哪些工作区。'
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
 * 🔴 `buttonsShown: true` 时**不再重复列选项文字**（1.0.26）。主人 2026-10-07：
 *    「你按钮里面也要写 A. 一行一个按钮 这样的文字，那不如直接用按钮替代掉正文里面的
 *      这个文字，然后让它独立占一行」——按钮已经把选项文字承担了，正文再写一遍就是
 *    同一条信息出现两次；正文只留「编号 + 说明」，编号与下面的按钮一一对应。
 *    唯一例外：某个选项**既没有说明、名字又会被按钮切成半截**（见循环里的 ③），
 *    那行就把完整选项名补回来 —— 那时它是唯一的答案依据，不算重复。
 *
 * ⚠️ 只有"确实装了按钮"时才敢省（`formatQuestion` 会把 `buildOptionKeyboard` 的结果传进来）：
 *    多选、多个问题、超过 5 个选项时按钮不装，那时正文里的选项文字**是唯一的答案依据**，
 *    少一个字，主人就答不出来。
 *
 * @param {Array<object>} questions - DSH 的 AskUserQuestionItem 列表。
 * @param {{buttonsShown?: boolean}} [options] - 下面是否真装了选项按钮。
 * @returns {string} 多行正文。
 */
export function formatQuestionBody(questions, { buttonsShown = false } = {}) {
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
    // 按钮承担选项文字的前提，与 buildOptionKeyboard 装按钮的条件**必须一致**：
    // 恰好一问、单选、有选项（选项数上限由它那边把关）。
    const labelsInBody = !(buttonsShown && !many && q?.multiSelect !== true && opts.length > 0)
    for (const [oi, o] of opts.entries()) {
      const label = String(o?.label ?? '')
      const desc = typeof o?.description === 'string' ? o.description.trim() : ''
      const rec = isRecommendedLabel(label)
      if (labelsInBody) {
        out.push(`  ${oi + 1}. ${label}`)
        // 选项自带的说明也带上：多这一行，回复时更有把握。
        if (desc !== '') out.push(`     ${desc}`)
      } else {
        // 按钮上有选项名，这里只补"按钮上放不下的那部分"：
        //   ① 有说明 → 发说明（带不带「推荐」标记）；
        //   ② 没说明、且选项名**能在按钮上完整显示** → 一个字都不写（信息在按钮上，
        //      这一行就是主人说的"正文里重复的那遍文字"）；
        //   ③ 没说明、但选项名会被按钮切成半截 → 正文补全文，否则只能对着
        //      「1.一个特别」猜（口径与 optionLabelRoom 同一个来源）。
        const clean = cleanOptionText(label)
        const full = [...clean].length > optionLabelRoom(oi)
        const line = desc !== '' ? desc : (full ? clean : '')
        if (line !== '' || rec) out.push(`  ${oi + 1}. ${rec ? '（推荐）' : ''}${line}`)
      }
    }
    if (opts.length === 0) out.push('  （这题没有选项：**引用这条消息**回一句话就行）')
    else if (q?.multiSelect) out.push('  （可以多选：**引用这条消息**回，像「1 3」这样）')
  })

  return out.join('\n')
}

export function formatQuestion(questions, { project, session } = {}) {
  const list = Array.isArray(questions) ? questions : []
  const name = actorOf({ session, project })
  // 1.0.24 起"不引用、不带 / 的消息一律当闲聊"，所以**必须**在这里说清怎么才算回答 ——
  // 否则主人顺手回一句「1」，那句会进闲聊会话，agent 一直等下去（他 2026-10-07 18:1x
  // 明确要求"不引用就是闲聊，无论任何情况"）。有按钮时按钮发的是 /answer N，也算显式指令。
  const keyboard = buildOptionKeyboard(list)
  const hasButtons = Boolean(keyboard)
  const hasOptions = list.some((q) => Array.isArray(q?.options) && q.options.length > 0)
  const how = hasButtons
    ? '要回答：点下面的按钮；或者**引用这条消息**回我一句（回数字比如 1，也可以直接写你的答案）。'
    : hasOptions
      ? '要回答：**引用这条消息**回我一句（回数字比如 1，也可以直接写你的答案）。'
      : '要回答：**引用这条消息**回我一句，直接写你的答案就行。'
  return [
    name ? `❓ ${name} 想问你个事` : '❓ 想问你个事',
    '',
    // 正文里的选项文字由按钮承担了（见 formatQuestionBody 的说明），把"装没装按钮"传下去。
    formatQuestionBody(list, { buttonsShown: hasButtons }),
    '',
    list.length > 1
      ? `${how}（${list.length} 个问题分 ${list.length} 行答）`
      : how,
  ].join('\n')
}

export const HELP_TEXT = [
  '🤖 我是 DSH 助手，点下面的按钮，或者把这些命令发给我',
  '',
  '🔴 只要**不引用我的消息**、又**不带 / 开头**，你说的话一律当闲聊 —— 不管我是不是',
  '在看名单、也不管我是不是正有问题等你答。想派活、想选名单、想作答，都用下面这些',
  '显式指令或按钮。',
  '',
  '引用我的某条通知再说话 → 接着那个会话继续',
  '引用我的某条提问再说话 → 那就是在回答它（点它下面的按钮也一样）',
  '直接发一句话 → 当闲聊，进你用 /sessions 指定的会话（没指定就是闲聊会话）',
  '',
  '/task        列出工作区；点按钮或发 /pick 3 选它，再挑工作区里的会话或开新对话',
  '/task 内容   直接派给当前工作区，当成一件新活',
  '/pick 3      选 /task 名单里第 3 个工作区（名单 24 小时内有效，这里不受限）',
  '/open 2      选当前工作区里第 2 个会话（0 = 开一个新对话）',
  '/new         在当前工作区开一个新对话',
  '/answer 答案 回答我的提问（回答自由作答的提问时用它，或引用那条提问）',
  '/status      看看现在在忙什么',
  '/sessions    列出最近在聊的几个会话；点按钮或发 /use 3 切过去',
  '/use 3       切到 /sessions 列表里第 3 个（0 = 取消指定）',
  '/screen      给我截一张你电脑的屏幕',
  '/update      把插件更新到最新版（会自动重启 DSH）',
  '/update check 只查一下有没有新版；有的话把「忽略本次 / 立即更新」两个按钮回给你',
  '/skip        这次的新版本先不提醒（想装还是发 /update）',
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
 * 判断一条 QQ 消息是**哪条显式指令**（只处理以 `/` 开头的话）。
 *
 * 规则（1.0.24 起，主人拍板，简单到不用记）：
 *   - 以 `/` 开头（前面可以带 `@机器人 ` 前缀）→ 显式指令
 *   - 不是 `/` 开头的文本 → 这里**没有别的意思**，一律按闲聊原样交回去
 *
 * 🔴 别再在这里加"有提问在等就当回答""没有提问就当新任务"之类的默认判断 ——
 *    那两条正是 1.0.24 删掉的东西：一句话去哪，只由「有没有引用」和「带不带 /」决定。
 *    真正的分流在 {@link routeMessage}，这里是它的第 ① 步。
 */
export function routeIncoming(text, { hasPendingQuestion = false } = {}) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return { kind: 'ignore' }
  // 消息按钮（指令按钮）点出来会带 `@机器人 ` 前缀，先剥掉再判指令。
  // 非指令那两条路仍用 trimmed —— 普通消息的内容一个字都不改。
  const raw = stripBotMention(trimmed)

  if (raw.startsWith('/')) {
    const m = /^\/([A-Za-z\u4e00-\u9fa5]+)\s*([\s\S]*)$/.exec(raw)
    const cmd = (m?.[1] ?? '').toLowerCase()
    const rest = (m?.[2] ?? '').trim()
    switch (cmd) {
      case 'task': case 't': case '任务':
        // 不带内容 = 先挑工作区（两步派活的第一步）；带了就直接派给当前工作区。
        return rest ? { kind: 'task', text: rest } : { kind: 'task_workspaces' }
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
      // 挑工作区（`/task` 名单下面那些数字按钮发的就是它）。
      //
      // 🔴 为什么要有这条显式指令：裸数字那条路只在名单"新鲜"时才认（见 PICK_WINDOW_MS），
      //    而手机上从看到名单到回一个数字很容易超时 —— 2026-10-07 实测超时 24 分钟，
      //    那个「2」于是被当成派活正文注入了会话（选择没生效、还污染了一轮）。
      //    显式 `/pick 3` 不受窗口限制，名单在状态文件里就一直能选。
      case 'pick': case 'choose': case '选': case '选择':
        if (/^\d+$/.test(rest)) return { kind: 'pick_workspace', index: Number(rest), text: raw }
        return { kind: 'usage', text: '用法：/pick 3 —— 选 /task 名单里第 3 个（也可以直接点名单下面的按钮）' }
      // 第二步：在已选的工作区里挑一个会话（`/task` 第二步那份名单下面的数字按钮发的就是它）。
      // 与 `/use` 的区别是**作用域**：`/use` 是全局最近会话，`/open` 只认"当前工作区里"那份名单，
      // 所以它需要 `taskSessionIds` 真的存在（那份名单你看过，编号才有意义）。
      case 'open': case '开': case '打开':
        if (/^\d+$/.test(rest)) return { kind: 'pick_task_session', index: Number(rest), text: raw }
        return { kind: 'usage', text: '用法：/open 2 —— 选当前工作区里第 2 个会话（/open 0 = 开一个新对话）' }
      // 在这个工作区开一个新对话（`/task` 第二步那个「新对话」按钮发的就是它）。
      // 与 `/task 内容` 的区别：这条只建会话、不改派活内容，建完你直接说要做什么就行。
      case 'new': case '新': case '新对话':
        return { kind: 'new_task_session' }
      // 截图：远控不方便时，点 QQ 菜单的「屏幕」= 发一条 /screen 过来。
      // 顺带认英文同义词，主人手打 /shot 也能用。
      case 'screen': case 'screenshot': case 'shot': case '截图': case '屏幕':
        return { kind: 'screen' }
      // 远程更新：`/update` 直接装，`/update check` 只查不装。
      // 装完会重启 DSH（这一条只在这里说没用 —— 回执里也必须说清，见 update.js 的文案）。
      case 'update': case '更新':
        // 「忽略本次」按钮也可以写成 `/update skip`，两种写法都认。
        if (rest === 'skip' || rest === '忽略') return { kind: 'update_skip' }
        return { kind: 'update', check: rest === 'check' || rest === '检查' }
      // `忽略本次` 按钮（新版本提醒下面那个）＝ `/skip`：这一版先不提醒，随时可以 /update 装上。
      case 'skip': case '忽略': case 'ignore':
        return { kind: 'update_skip' }
      case 'help': case 'h': case '?': case '帮助':
        return { kind: 'help' }
      default:
        return { kind: 'unknown', command: cmd }
    }
  }

  // 不是 `/` 开头 ⇒ 不是指令，交给 routeMessage 的 ③ 当闲聊（1.0.24 起这里不再"猜"）。
  // 注意 `hasPendingQuestion` 只影响 `/answer` 那条指令有没有人等着答，绝不影响这段话的去向。
  return { kind: 'chat', text: trimmed }
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
      /**
       * `/task` 先挑工作区用的那份名单：`taskPickerAt` 是发榜时刻，`taskPickerCwds`
       * 是完整工作目录，顺序与显示编号一一对应。
       *
       * 为什么与 `pickerAt` / `pickerIds` 分开存：两份名单都用裸数字回复，
       * 必须靠"谁后发"来消除歧义（见 routeMessage 的第 ④ 步）。
       */
      taskPickerAt: 0,
      taskPickerCwds: [],
      /**
       * 当前选定的**工作区**（完整目录）。空串 = 还没选过，`/task 内容` 走老的「专属会话」。
       */
      activeTaskCwd: '',
      /**
       * `{ [cwd]: sessionId }` —— 每个工作区一个专属派活会话。
       *
       * 一个工作区一个会话（而不是每次都新建）：重复派活能接着上下文，
       * 也避免在 DSH 里堆出一串同名空会话。
       */
      taskSessions: {},
      lastSeq: null, seen: [], sentRefs: {}, recent: [],
      /**
       * 已经提醒过新版本的版本号（空串 = 还没提醒过）。
       *
       * 为什么必须落盘：更新检查是按小时轮询的，不记下来的话**每一个周期都会再推一条**
       * 同样的「有新版本」——那就变成每天骚扰好几次。同一个版本只提醒一次。
       */
      updateNotified: '',
      /**
       * 主人点了「忽略本次」的那个版本号（空串 = 没忽略过）。
       *
       * 与 `updateNotified` 的区别：那个记的是"**提醒过**哪个版本"（防重复打扰），
       * 这个记的是"主人**明确说过**这版先别管"。分两个字段是为了让日志能说清是哪种静默，
       * 也为了以后想改口径（比如忽略过的版本还偶尔提一次）时不用猜历史状态。
       */
      updateSkipped: '',
      /**
       * 重启标记：`{ version, at }`，在「装完新版本、即将重启 DSH」时写，重启后读到就回一条确认。
       *
       * 为什么要落盘而不是留在内存里：写它的进程**正是接下来要被杀掉的那个**，
       * 重启后是一个全新进程 —— 不落盘就没人知道"这次启动是因为刚更新过"。
       * `at` 是写标记的时刻，用来算"重启用了多少秒"。
       */
      updateRestart: null,
      /**
       * `{ [agentId]: { s: 'running' | 'idle', at } }` —— 每个 agent 上次已知的状态。
       *
       * 为什么要落盘：判断"这一轮跑完了"用的是 `running → idle` 这个**边**，只看内存的话，
       * 插件在回合中途重装/宿主中途重启就会把边弄丢，完成通知与 agentmd 日志一起静默消失
       * （2026-10-05 事故）。见 {@link BotState.markAgentStatus}。
       */
      agentStatus: {},
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
    if (!Array.isArray(this.data.taskPickerCwds)) this.data.taskPickerCwds = []
    if (!Number.isFinite(this.data.taskPickerAt)) this.data.taskPickerAt = 0
    if (typeof this.data.activeTaskCwd !== 'string') this.data.activeTaskCwd = ''
    if (typeof this.data.updateSkipped !== 'string') this.data.updateSkipped = ''
    if (this.data.taskSessions === null || typeof this.data.taskSessions !== 'object'
        || Array.isArray(this.data.taskSessions)) {
      this.data.taskSessions = {}
    }
    if (this.data.agentStatus === null || typeof this.data.agentStatus !== 'object'
        || Array.isArray(this.data.agentStatus)) {
      this.data.agentStatus = {}
    }
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

  /**
   * 记下「每个 agent 上次已知的状态」（`running` / `idle`），落盘。
   *
   * 为什么要落盘：插件判断"这一轮跑完了"靠的是**内存里**那张状态表的
   * `running → idle` 这个边。插件在回合中途被重装、DSH 中途重启，内存里的表就没了，
   * 于是"跑完了"既不发 QQ 通知、也不写 agentmd 日志，**整段逻辑静默跳过**
   * （2026-10-05 主人报的故障）。落盘之后，重新加载时能把 `running` 读回来，
   * 那个边就还在。
   *
   * ⚠️ 只记 `running` / `idle` 两种 —— 别的状态（如果宿主将来发了）会盖掉"它正在跑"
   * 这个事实，反而不如不记。
   *
   * @param {string} agentId
   * @param {string} status
   * @param {number} [max] - 最多留多少个 agent。
   * @param {number} [ttlMs] - 超过这个时长没更新的条目算过期（默认 24 小时）。
   */
  markAgentStatus(agentId, status, max = 50, ttlMs = 24 * 60 * 60 * 1000) {
    if (!agentId) return
    if (status !== 'running' && status !== 'idle') return
    if (this.data.agentStatus === null || typeof this.data.agentStatus !== 'object'
        || Array.isArray(this.data.agentStatus)) {
      this.data.agentStatus = {}
    }
    const now = Date.now()
    this.data.agentStatus[String(agentId)] = { s: status, at: now }
    const map = this.data.agentStatus
    for (const k of Object.keys(map)) {
      if (!(Number(map[k]?.at) > now - ttlMs)) delete map[k]
    }
    const keys = Object.keys(map)
    if (keys.length > max) {
      keys.sort((a, b) => (Number(map[a]?.at) ?? 0) - (Number(map[b]?.at) ?? 0))
      for (const k of keys.slice(0, keys.length - max)) delete map[k]
    }
    this.save()
  }

  /** 读回 `{ agentId: {s, at} }`（可能为空对象）。 */
  agentStatusMap() {
    const m = this.data.agentStatus
    return (m && typeof m === 'object' && !Array.isArray(m)) ? { ...m } : {}
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
   * 引用反查的兜底：ref_idx 认不出来时，用**最近一条我发过、且知道属于哪个会话**的消息。
   *
   * 为什么值得冒"可能送错会话"的风险：反查落空时调用方会回一句「认不出这次通知」，
   * 用户的那句话就**整条丢失**了（既不进任何会话、也不会被回答）—— 那比"落到最近那个
   * 会话"糟糕得多。
   *
   * ⚠️ 两个数据源都要看（2026-10-05 修）：
   *   - `recent[]`  —— 主动推送的通知（跑完了／提问／出错…），最新在前；
   *   - `sentRefs{}` —— **每一条**带 `ref_idx` 的发出记录（通知、回执、全文、截图…）。
   *   以前只看 `recent[]` 且窗口只有 5 分钟：主人引用的若是我发的一句**回执**
   *   （✅ 收到…，那时回执还没登记 ref_idx），或者最近一条通知已经过了 5 分钟，
   *   两路就一起落空 → 回「认不出这是哪次通知」并把他那句话整条丢掉。
   *   实测（2026-10-05 02:31）：最近一条通知 02:24:00、消息 02:31:2x —— 差 7 分钟，
   *   状态文件里 108 条 sentRefs 明明都认得那个会话，却一条都没用上。
   *
   * 窗口放宽到 12 小时是有意的：QQ 的引用没有有效期，隔一顿饭再引用一条通知回话是
   * 正常用法；再往前的（隔天、隔几天）就不敢猜了。返回值里带 `ageMs`，好在 QQ 回复
   * 里明说「我按 N 分钟前那条通知的会话送进去了」，送错了他也能立刻看出来。
   *
   * @param {number} [withinMs] - 兜底时间窗，默认 12 小时。
   * @returns {object|null} 兜底目标（带 `viaFallback: true` 与 `ageMs`）。
   */
  recentTarget(withinMs = 12 * 60 * 60 * 1000) {
    const all = []
    for (const r of Array.isArray(this.data.recent) ? this.data.recent : []) {
      if (r?.sessionId && r.at) all.push(r)
    }
    for (const r of Object.values(this.data.sentRefs ?? {})) {
      if (r?.sessionId && r.at) all.push(r)
    }
    if (all.length === 0) return null
    all.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    const first = all[0]
    const ageMs = Math.max(0, Date.now() - (first.at ?? 0))
    if (ageMs > withinMs) return null
    return { ...first, viaFallback: true, ageMs }
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
  if (Array.isArray(ext)) {
    for (const item of ext) {
      const m = /^ref_msg_idx=(.+)$/.exec(String(item ?? '').trim())
      if (m) return m[1].trim()
    }
  }
  // 兜底（2026-10-05）：`ext` 里没有 `ref_msg_idx` 时，事件里的被引用消息元素带的
  // `msg_idx` 与它是**同一个索引**。少这一条的话，官方一旦调整 ext 的组成，
  // 引用识别会**静默**失效 —— 又变成"认不出这是哪次通知"。
  const el = Array.isArray(data?.msg_elements) ? data.msg_elements[0] : null
  return String(el?.msg_idx ?? '').trim()
}

/**
 * 取出**这条新消息自己的**索引（`message_scene.ext` 里的 `msg_idx`）。
 *
 * 官方在「单聊消息事件」里说：同一个 `msg_id` 可能重复推送，建议结合 `msg_idx` 去重。
 * ⚠️ 我们**先只拿它做观测、不据此丢消息**：万一 `msg_idx` 不是"每条消息唯一"，
 * 按它去重会把正常消息**永久**丢掉 —— 那比偶尔重复进一次严重得多。见 qqruntime 里的用法。
 *
 * @param {object} data - C2C_MESSAGE_CREATE 的事件体。
 * @returns {string} 本条消息的 msg_idx；没有则空串。
 */
export function extractMsgIdx(data) {
  const ext = data?.message_scene?.ext
  if (!Array.isArray(ext)) return ''
  for (const item of ext) {
    const m = /^msg_idx=(.+)$/.exec(String(item ?? '').trim())
    if (m) return m[1].trim()
  }
  return ''
}

/**
 * 从 C2C_MESSAGE_CREATE 事件里取出**被引用那条消息本身**（正文 + 作者）。
 *
 * 🔴 2026-10-05 主人问了一句把我说醒的话：「我引用的消息，QQ 机器人那里不是可以
 *    正确获取吗？应该有对应的接口吧？」—— **对，而且不用调任何接口**：
 *    官方事件里就带着被引用消息的正文，我们以前只读了索引、把正文扔掉了。
 *
 * 官方「单聊消息事件」文档（message_type=103 引用消息）：
 *   `msg_elements[0]` 就是被引用那条：
 *     .msg_idx        —— 被引用消息的索引（与 `ext` 里的 `ref_msg_idx` 同值）
 *     .content        —— 被引用消息的**正文**
 *     .author.bot     —— 那条是不是机器人自己发的
 *     .author.user_openid —— 发那条的人
 *
 * 有了正文，引用反查就多了一条**完全不依赖状态文件**的路：我发出去的每条消息里
 * 都写着会话名（通知是「✅ main 跑完了」，回执是「✅ 收到…（main）」），
 * 于是从正文里就能把会话认出来（见 {@link inferSessionFromQuote}）。
 * 状态文件被清、sentRefs 被挤出 300 条上限、我压根没登记过——都还能认得。
 *
 * @param {object} data - C2C_MESSAGE_CREATE 的事件体。
 * @param {string} [refIdx] - 已知的被引用索引；有就按它挑元素（理论上只有一个元素，这是防御）。
 * @returns {{idx: string, content: string, bot: boolean, authorId: string}|null}
 */
export function extractQuoted(data, refIdx = '') {
  const list = Array.isArray(data?.msg_elements) ? data.msg_elements : []
  const els = list.filter((el) => el && typeof el === 'object')
  if (els.length === 0) return null
  const want = String(refIdx ?? '').trim()
  const el = (want && els.find((e) => String(e.msg_idx ?? '').trim() === want)) || els[0]

  const idx = String(el.msg_idx ?? '').trim()
  const content = String(el.content ?? '').trim()
  if (idx === '' && content === '') return null
  const author = el.author && typeof el.author === 'object' ? el.author : {}
  return {
    idx,
    content,
    // 只有明确的 true 才算"我发的"：字段缺失时宁可当作别人发的（那只是少一条路，不会投错会话）
    bot: author.bot === true,
    authorId: String(author.user_openid ?? author.id ?? '').trim(),
  }
}

/**
 * 我方通知开头那一行：「✅ main 跑完了」「❓ main 想问你个事」「⚠️ main 出错了」。
 * 见 {@link formatNotification} —— 会话名就在这儿。
 */
const QUOTE_HEAD_RE = /^[✅❓⚠️ℹ️]\s*(.+?)\s*(?:跑完了|想问你个事|出错了)$/gm
/** 我方回执/尾巴里的会话名：「✅ 收到，我这就开始（main）」。 */
const QUOTE_LABEL_RE = /（([^（）\n]{1,60})）/g

/**
 * 从**被引用消息的正文**里认出它属于哪个会话 —— 不需要 ref_idx 反查表。
 *
 * 两条判据，从严到宽：
 *   ① 我方格式里的会话名：通知首行「✅ <会话> 跑完了」、回执括号「（<会话>）」。
 *      只认**与现有会话标题完全相等**的候选 —— 猜错会话比认不出更糟（话会进错地方）。
 *   ② 退一步：只有**我发的**消息才按首行猜（用户自己发的话里出现会话名，不代表那是话题）。
 *      同一行里有多个标题时取**最长**的（"前端重构" 比 "前端" 更具体）。
 *
 * @param {{content?: string, bot?: boolean}|null} quote - {@link extractQuoted} 的结果。
 * @param {Array<{id: string, title: string}>} sessions - 现有会话列表。
 * @returns {{sessionId: string, session: string, how: string}|null}
 */
export function inferSessionFromQuote(quote, sessions) {
  const content = String(quote?.content ?? '').trim()
  if (content === '') return null
  const known = (Array.isArray(sessions) ? sessions : [])
    .map((s) => ({ id: String(s?.id ?? '').trim(), title: String(s?.title ?? '').trim() }))
    .filter((s) => s.id !== '' && s.title !== '')
  if (known.length === 0) return null
  const byTitle = new Map(known.map((s) => [s.title, s]))

  // ① 我方格式里的会话名（高置信）
  const candidates = []
  for (const m of content.matchAll(QUOTE_HEAD_RE)) candidates.push(m[1])
  for (const m of content.matchAll(QUOTE_LABEL_RE)) candidates.push(m[1])
  for (const c of candidates) {
    const hit = byTitle.get(String(c).trim())
    if (hit) return { sessionId: hit.id, session: hit.title, how: '引用正文里我方格式的会话名' }
  }

  // ② 我发的消息，按首行猜（低一档置信）
  if (quote?.bot === true) {
    const firstLine = content.split('\n')[0].trim()
    let best = null
    for (const s of known) {
      // 单字标题（比如「主」）太容易撞上，不猜
      if (s.title.length < 2 || !firstLine.includes(s.title)) continue
      if (!best || s.title.length > best.title.length) best = s
    }
    if (best) return { sessionId: best.id, session: best.title, how: '引用正文首行里的会话名' }
  }
  return null
}

/**
 * 决定「引用的这条消息算哪个会话」—— 三级兜底的**纯函数**部分（好测、好读）。
 *
 * 顺序（从确定到不确定，不能反）：
 *   ① `exact`   —— `ref_idx` 精确命中登记表；
 *   ② 引用**正文**里认出的会话 —— 见 {@link inferSessionFromQuote}；
 *   ③ `recent`  —— 调用方给的"最近一条知道属于哪个会话的消息"（见 BotState.recentTarget）。
 *
 * ②还管一件**语义**上的事：如果认出来的会话**正卡在提问上等回答**（`pending.sessionId`
 * 与之相同），那这条引用就得按**作答**处理（`kind: 'question'` + `askId`）——
 * 否则它会被当成普通消息注入会话，而 agent 还在等那个答案，两边都僵住。
 *
 * @param {object} opts
 * @param {object|null} [opts.exact] - `ref_idx` 精确反查结果。
 * @param {{content?: string, bot?: boolean}|null} [opts.quoted] - {@link extractQuoted} 的结果。
 * @param {Array<{id: string, title: string}>} [opts.sessions] - 现有会话列表。
 * @param {{askId?: string, sessionId?: string}|null} [opts.pending] - 正在等回答的提问。
 * @param {object|null} [opts.recent] - 最近一条兜底目标。
 * @returns {object|null} 目标（内容认出来的会带 `viaContent` / `how` / `quoted`）。
 */
export function resolveQuoteTarget({ exact = null, quoted = null, sessions = [], pending = null, recent = null }) {
  if (exact) return exact
  const hit = inferSessionFromQuote(quoted, sessions)
  if (hit) {
    const isAsk = Boolean(pending && pending.sessionId === hit.sessionId)
    return {
      sessionId: hit.sessionId,
      session: hit.session,
      kind: isAsk ? 'question' : 'quote-content',
      ...(isAsk ? { askId: pending.askId } : {}),
      viaContent: true,
      how: hit.how,
      quoted: String(quoted?.content ?? ''),
    }
  }
  return recent ?? null
}

/**
 * 决定一条 QQ 消息该往哪去。
 *
 * 🔴 规则只剩三条（主人 2026-10-07 18:1x 拍板：「只要我不引用信息或者信息前边不带 / 的命令
 *    就是闲聊，**无论任何情况**」）：
 *
 *   ① 以 `/` 开头（前面可以带 `@机器人 ` 前缀）→ 显式指令，见 {@link routeIncoming}
 *   ② 引用了我的某条消息 → 回到**那条消息对应的会话**（引用提问 = 作答）
 *   ③ 其余**一律**当闲聊 → 进当前会话（`/sessions` 指定的那个，没指定就是闲聊会话）
 *
 *   1.0.24 起**没有例外**了。以前有两条"抢消息"的规则，都被这条要求删掉：
 *     · 有提问在等时不引用也当作答 —— 现在要去**引用那条提问**（或点提问下面的按钮，
 *       按钮发的是 `/answer N` 显式指令）。代价：agent 可能多等一轮，见 qqruntime 里
 *       那两句提示（消息照投，只是顺带告诉你该怎么回答）。
 *     · 刚看过名单时回一个纯数字 = 选名单 —— 现在一律当闲聊；选名单请点按钮或发
 *       `/pick N`、`/open N`，这些本来就是显式指令。
 *
 *   代价知情的部分：一个光秃秃的数字现在会真的进会话（2026-10-07 09:09 那次「2」被
 *   当成派活正文的现场就是这么来的）。主人明确选了"可预测"而不是"帮我猜"，所以这里
 *   不再拦。qqruntime 会在"有提问在等 / 刚发过名单"时回一句提示，但**不改投递**。
 *
 * @param {object} opts
 * @param {string} opts.text - 消息正文。
 * @param {string} opts.refIdx - {@link extractRefIdx} 的结果。
 * @param {boolean} opts.hasPendingQuestion - 当前是否有提问在等回答（只影响 `/answer` 那条指令）。
 * @param {object|null} opts.refTarget - {@link BotState.refTarget} 的结果。
 * @param {boolean} [opts.hasQuote] - 这条消息引用了别的消息（默认按 `refIdx` 是否非空判断）。
 *   单独给这个开关，是因为「引用了，但索引没拿到」也会发生（官方结构变动 / 异常事件）：
 *   那时不该把它当成"没引用的闲聊"，该走引用那条路。
 * @returns {{kind: string, reason: string, text?: string, sessionId?: string, askId?: string}}
 */
export function routeMessage({
  text, refIdx, hasPendingQuestion, refTarget, hasQuote = Boolean(refIdx),
}) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { kind: 'ignore', reason: '空消息' }

  // ① 显式指令最优先：用户打了 `/task` 就是要覆盖默认判断。
  //    ⚠️ 判之前先剥掉 `@机器人 ` 前缀 —— 消息按钮点出来的指令长这样。
  const cmdText = stripBotMention(raw)
  if (cmdText.startsWith('/')) {
    return { ...routeIncoming(cmdText, { hasPendingQuestion }), reason: '显式指令' }
  }

  // ② 引用了我发的消息 → 回到那条消息对应的会话
  if (hasQuote) {
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

  // ③ 其余**一律**闲聊（1.0.24 起没有例外）。
  //
  // 🔴 这里以前还有三条分支：有提问在等就当作答、刚看过名单的纯数字就当选择、
  //    以及"哪个名单都解释不了"的纯数字被拦下来问一句。主人 2026-10-07 明确要求
  //    「只要我不引用信息或者信息前边不带 / 的命令就是闲聊，无论任何情况」——
  //    三条全删。理由是他要的是**可预测**：一句话去哪，只由"有没有引用"和
  //    "带不带 /"决定，不再看他刚才看过什么名单、agent 是不是在等回答。
  //
  //    代价写在明处（这是我们主动交换掉的）：
  //      · agent 卡在提问上时，普通消息不再当答案 —— 要回答就**引用那条提问**
  //        （或点它下面的按钮，按钮发的是 `/answer N`）。qqruntime 会在这种时候
  //        补一句提示，否则 agent 会一直等。
  //      · 手打一个「2」不再等于选名单 —— 选名单请点按钮或发 `/pick 2` / `/open 2`。
  return { kind: 'chat', text: raw, reason: '闲聊（不引用、不带 / 就是闲聊）' }
}
