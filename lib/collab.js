/**
 * 协作模式（collab mode）：让**同一个工作区下的多个会话自动协作**。
 *
 * 为什么插件能做这件事：DSH 桌面版是**一个进程**托管所有会话，
 * 而插件跑在这个进程里 —— 所以同工作区的会话彼此**天然可见**，
 * 不需要轮询文件、不需要外部服务。文件只是跨重启/跨进程的兜底与人类可读的面板。
 *
 * 它替人做掉四件事：
 *   1. **会话注册表**：谁在跑、在哪个工作区、什么状态、最后活动时间。
 *   2. **文件占用表**：谁在写哪个文件；同一文件被两个会话同时写时**当场提醒**。
 *   3. **留言板**：会话之间可以直接传话（`collab_post`），对方下一个模型步骤就能看到。
 *   4. **自动面板**：把上面三样写进 `<agentmdDir>/plugin-collab.md` 的自动区块，
 *      标记之外的人工内容**原样保留**，绝不覆盖。
 *
 * 设计约束（都是踩过的坑换来的）：
 *   - **零裸包导入**（只用 node: 内置）→ 可以脱离 DSH 直接单测。
 *   - **没有其他会话时不注入任何文本**（返回 ''）→ 不污染单人环境的上下文。
 *   - **写盘节流 + 定时器 unref** → 不拖慢 agent，也不阻塞进程退出。
 *   - **会话转 idle 时自动释放它占的文件** → 会话崩了/睡着了不会留下死锁。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 面板里插件自动维护的区块标记；标记之外的人工内容不会被碰。 */
export const AUTO_BEGIN = '<!-- collab:auto:begin -->'
export const AUTO_END = '<!-- collab:auto:end -->'

/** 默认面板文件名 —— 与手工版同名，等于把手工版接管成自动版。 */
export const DEFAULT_PANEL_FILE = 'plugin-collab.md'
/** 机器状态文件（留言跨重启保留）。 */
export const DEFAULT_STATE_FILE = '.collab-state.json'

/** 会话多久没动静就不再算「同工作区的活跃会话」。 */
export const SESSION_TTL_MS = 30 * 60 * 1000
/** 文件占用的默认过期时间。 */
export const CLAIM_TTL_MS = 30 * 60 * 1000
/** 留言保留条数。 */
export const MAX_MESSAGES = 50
/** 注入文本的硬上限（防止把上下文挤爆）。 */
export const MAX_INJECT_CHARS = 1400
/** 面板写盘节流间隔。 */
export const FLUSH_DEBOUNCE_MS = 1500

// ── 纯工具函数 ──────────────────────────────────────────────────────────────

/** 路径归一化：统一反斜杠、去尾部斜杠、盘符/大小写归一（Windows 大小写不敏感）。 */
export function normalizePath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return s.toLowerCase()
}

/** 工作区标识：同一个 cwd 得到同一个 key（用于状态文件名）。 */
export function workspaceKey(cwd) {
  return createHash('sha1').update(normalizePath(cwd)).digest('hex').slice(0, 12)
}

/** 这个工具名是不是「会改文件」的工具。 */
const WRITE_TOOL_RE = /(write|edit|patch|create|append|move|rename|delete|remove|copy)/i
export function isWriteTool(toolName) {
  return WRITE_TOOL_RE.test(String(toolName ?? ''))
}

/** 疑似文件路径的参数名（大小写不敏感）。 */
const PATH_KEYS = new Set([
  'file_path', 'filepath', 'file', 'filename', 'path', 'paths', 'files',
  'target', 'targets', 'dest', 'destination', 'source', 'src', 'to', 'from',
])

/**
 * 从工具参数里挖出「将被改动」的文件路径。
 *
 * 只认显式路径型参数，**不去解析 shell 命令字符串** —— 解析命令必然误报，
 * 而误报会让人关掉整个功能，比漏报更糟。
 */
export function extractPaths(toolName, args, { maxDepth = 4 } = {}) {
  if (!isWriteTool(toolName)) return []
  const out = new Set()
  const walk = (value, depth) => {
    if (depth > maxDepth || value === null || value === undefined) return
    if (typeof value === 'string') return
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    for (const [k, v] of Object.entries(value)) {
      const key = String(k).toLowerCase()
      if (PATH_KEYS.has(key)) {
        if (typeof v === 'string' && v.trim() !== '') out.add(v.trim())
        else if (Array.isArray(v)) {
          for (const item of v) if (typeof item === 'string' && item.trim() !== '') out.add(item.trim())
        }
      }
      if (v !== null && typeof v === 'object') walk(v, depth + 1)
    }
  }
  walk(args, 0)
  return [...out]
}

/** 从 agent 里读出 id / cwd / 标题（与 QQ 侧同一套取法）。 */
export function describeAgent(agent) {
  const header = agent?.session?.header ?? {}
  const cwd = header.cwd ?? agent?.session?.meta?.cwd ?? ''
  const id = agent?.id ? String(agent.id) : ''
  const raw = header.title ?? header.name ?? agent?.title ?? ''
  const title = typeof raw === 'string' && raw.trim() !== ''
    ? raw.trim()
    : (id ? `会话 ${id.slice(0, 8)}` : '未知会话')
  return { id, cwd, title, isSubagent: isSubagentAgent(agent) }
}

/**
 * 是不是子智能体。
 *
 * ⚠️ **不能用 `parentSession` 判断** —— 用户自己 fork 出来的会话也带这个字段，
 * 那是「主人的会话」，必须照常参与协作。（本项目为此踩过一次。）
 */
export function isSubagentAgent(agent) {
  const header = agent?.session?.header
  if (!header) return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && depth >= 1
}

/** 相对时间，给人看。 */
export function agoText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 10_000) return '刚刚'
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`
  return `${Math.floor(ms / 3_600_000)} 小时前`
}

function shortPath(p) {
  const s = String(p).replace(/\\/g, '/')
  const parts = s.split('/').filter(Boolean)
  return parts.length <= 2 ? s : parts.slice(-2).join('/')
}

// ── 状态 ────────────────────────────────────────────────────────────────────

/**
 * 协作状态（纯内存 + 可序列化）。
 *
 * 占用表是 `path -> 占用者数组`：**故意允许登记多个占用者**——
 * 冲突时不覆盖别人的登记，否则弄丢的正是「冲突证据」本身。
 */
export class CollabState {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.sessions = new Map()
    this.claims = new Map()
    this.messages = []
  }

  // —— 会话 ——

  upsert(agent, { status = 'running' } = {}) {
    const { id, cwd, title, isSubagent } = describeAgent(agent)
    if (!id) return null
    const prev = this.sessions.get(id)
    const entry = {
      id,
      cwd: cwd || '',
      title,
      isSubagent,
      status: status ?? prev?.status ?? 'running',
      firstSeenAt: prev?.firstSeenAt ?? this.now(),
      lastActiveAt: this.now(),
    }
    this.sessions.set(id, entry)
    return entry
  }

  touch(id, status) {
    const s = this.sessions.get(String(id ?? ''))
    if (!s) return null
    if (status) s.status = status
    s.lastActiveAt = this.now()
    return s
  }

  get(id) {
    return this.sessions.get(String(id ?? '')) ?? null
  }

  /** 同一个工作区里的其他会话（可选含自己）。 */
  peers(cwd, { excludeId = '', scope = 'workspace', ttlMs = SESSION_TTL_MS, includeSelf = false } = {}) {
    const key = normalizePath(cwd)
    const cutoff = this.now() - ttlMs
    const out = []
    for (const s of this.sessions.values()) {
      if (s.lastActiveAt < cutoff) continue
      if (scope === 'workspace' && normalizePath(s.cwd) !== key) continue
      if (!includeSelf && excludeId && s.id === excludeId) continue
      out.push(s)
    }
    // 在跑的排前面，其次按最后活动时间倒序。
    return out.sort((a, b) => {
      if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1
      return b.lastActiveAt - a.lastActiveAt
    })
  }

  drop(id) {
    const key = String(id ?? '')
    this.sessions.delete(key)
    for (const [path, holders] of [...this.claims.entries()]) {
      const kept = holders.filter((h) => h.sessionId !== key)
      if (kept.length === 0) this.claims.delete(path)
      else this.claims.set(path, kept)
    }
  }

  // —— 文件占用 ——

  claim(path, sessionId, { tool = '', title = '' } = {}) {
    const key = normalizePath(path)
    if (!key || !sessionId) return null
    const list = this.claims.get(key) ?? []
    const known = list.find((h) => h.sessionId === sessionId)
    if (known) {
      known.at = this.now()
      known.tool = tool || known.tool
      return known
    }
    const entry = { sessionId, title, tool, path: String(path), at: this.now() }
    list.push(entry)
    this.claims.set(key, list)
    return entry
  }

  release(path, sessionId) {
    const key = normalizePath(path)
    const list = this.claims.get(key)
    if (!list) return false
    const kept = list.filter((h) => h.sessionId !== sessionId)
    if (kept.length === 0) this.claims.delete(key)
    else this.claims.set(key, kept)
    return kept.length !== list.length
  }

  releaseAll(sessionId) {
    const key = String(sessionId ?? '')
    let n = 0
    for (const [path, holders] of [...this.claims.entries()]) {
      if (!holders.some((h) => h.sessionId === key)) continue
      n += holders.filter((h) => h.sessionId === key).length
      const kept = holders.filter((h) => h.sessionId !== key)
      if (kept.length === 0) this.claims.delete(path)
      else this.claims.set(path, kept)
    }
    return n
  }

  /** 谁在占这个文件（排除自己和已过期的）。 */
  conflict(path, sessionId, ttlMs = CLAIM_TTL_MS) {
    const list = this.claims.get(normalizePath(path)) ?? []
    const cutoff = this.now() - ttlMs
    return list.filter((h) => h.sessionId !== sessionId && h.at >= cutoff)
  }

  /** 某个会话占的文件（原始路径，给人看）。 */
  claimedBy(sessionId, ttlMs = CLAIM_TTL_MS) {
    const key = String(sessionId ?? '')
    const cutoff = this.now() - ttlMs
    const out = []
    for (const list of this.claims.values()) {
      for (const h of list) if (h.sessionId === key && h.at >= cutoff) out.push(h.path)
    }
    return [...new Set(out)]
  }

  /** 清掉过期占用（顺手做，不用定时器）。 */
  sweepClaims(ttlMs = CLAIM_TTL_MS) {
    const cutoff = this.now() - ttlMs
    for (const [path, list] of [...this.claims.entries()]) {
      const kept = list.filter((h) => h.at >= cutoff)
      if (kept.length === 0) this.claims.delete(path)
      else this.claims.set(path, kept)
    }
  }

  // —— 留言 / 提醒 ——

  post(sessionId, text, { title = '' } = {}) {
    const body = String(text ?? '').trim()
    if (!body) return null
    const msg = { at: this.now(), sessionId: String(sessionId ?? ''), title, text: body }
    this.messages.push(msg)
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES)
    return msg
  }

  /** 别人留给我的、我还没读过的。 */
  unread(sessionId, { limit = 5 } = {}) {
    const me = String(sessionId ?? '')
    const since = this.sessions.get(me)?.lastReadAt ?? 0
    return this.messages
      .filter((m) => m.at > since && m.sessionId !== me)
      .slice(-limit)
  }

  markRead(sessionId) {
    const s = this.sessions.get(String(sessionId ?? ''))
    if (s) s.lastReadAt = this.now()
  }

  /** 会话自己的待读提醒（冲突警告等，只给本人看）。 */
  note(sessionId, text) {
    const s = this.sessions.get(String(sessionId ?? ''))
    if (!s) return
    s.notes = Array.isArray(s.notes) ? s.notes : []
    s.notes.push({ at: this.now(), text: String(text) })
    if (s.notes.length > 8) s.notes.splice(0, s.notes.length - 8)
  }

  /**
   * 读该会话的待提示提醒（**只读，不清空**）。
   *
   * 为什么不在这里清空：注入用的 text() 是**每个模型步骤都会调用一次**的 provider。
   * 若第一次调用就清空，同一步之后的所有步骤都看不到（而恰恰是它们在做工具调用）；
   * 所以改成只读 + **转 idle 时统一清理**（一轮结束才清）。
   */
  snapshotNotes(sessionId) {
    const s = this.sessions.get(String(sessionId ?? ''))
    return Array.isArray(s?.notes) ? s.notes : []
  }

  clearNotes(sessionId) {
    const s = this.sessions.get(String(sessionId ?? ''))
    if (s) s.notes = []
  }

  // —— 序列化（只持久化留言，会话/占用是进程内易失状态）——

  toJSON() {
    return { version: 1, savedAt: this.now(), messages: this.messages.slice(-MAX_MESSAGES) }
  }

  loadJSON(raw) {
    if (!raw || typeof raw !== 'object') return
    if (Array.isArray(raw.messages)) {
      this.messages = raw.messages
        .filter((m) => m && typeof m.text === 'string' && Number.isFinite(m.at))
        .slice(-MAX_MESSAGES)
    }
  }
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/**
 * 生成注入到 system prompt 的协作提示。
 *
 * ⚠️ **没有别的东西可说时返回空串** —— 单人、单会话环境下不该往上下文里塞任何噪音。
 */
export function renderInjection(state, { cwd = '', sessionId = '', now = Date.now(), scope = 'workspace' } = {}) {
  const others = state.peers(cwd, { excludeId: sessionId, scope })
  const mine = state.claimedBy(sessionId)
  const notes = state.snapshotNotes(sessionId)
  const unread = state.unread(sessionId)
  if (others.length === 0 && notes.length === 0 && unread.length === 0) return ''

  const lines = []
  lines.push('【协作模式】这个工作区里还有别的会话在同时干活，你们共用同一份文件。')
  lines.push('')
  lines.push(`同工作区的其他会话（${others.length} 个）：`)
  for (const s of others.slice(0, 6)) {
    const held = state.claimedBy(s.id)
    const tail = held.length > 0 ? ` · 占用 ${held.slice(0, 3).map(shortPath).join('、')}${held.length > 3 ? ` 等 ${held.length} 个` : ''}` : ''
    lines.push(`- 「${s.title}」${s.status === 'running' ? '正在跑' : '空闲'} · ${agoText(now - s.lastActiveAt)}${tail}`)
  }
  if (mine.length > 0) {
    lines.push('')
    lines.push(`你自己已登记占用：${mine.slice(0, 5).map(shortPath).join('、')}`)
  }
  if (notes.length > 0) {
    lines.push('')
    lines.push('⚠️ 需要注意：')
    for (const n of notes.slice(-3)) lines.push(`- ${n.text}`)
  }
  if (unread.length > 0) {
    lines.push('')
    lines.push('📮 其他会话给你留的话：')
    for (const m of unread) lines.push(`- 「${m.title || '其他会话'}」${m.text}`)
  }
  lines.push('')
  lines.push('规矩：**改文件前先用 `collab_claim` 认领**；同一个文件同一时刻只允许一个写入者；'
    + '要跟别人商量用 `collab_post`；收工用 `collab_release` 释放（转空闲时也会自动释放）。'
    + '想看全局现状用 `collab_status`。')

  const text = lines.join('\n')
  return text.length <= MAX_INJECT_CHARS ? text : `${text.slice(0, MAX_INJECT_CHARS)}\n…（已截断，完整现状用 collab_status）`
}

/** 面板的自动区块。 */
export function renderAutoBlock(state, { cwd = '', now = Date.now(), scope = 'workspace' } = {}) {
  const sessions = state.peers(cwd, { scope, includeSelf: true })
  const out = []
  out.push(AUTO_BEGIN)
  out.push('')
  out.push('> 本节由 `dsh-remote-qqbot` 插件的**协作模式自动维护**，每次会话状态变化都会重写。')
  out.push('> 标记之外的文字是你的，插件**不会碰**。')
  out.push(`> 更新时间：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`)
  out.push('')

  out.push(`### 活跃会话（工作区 \`${cwd || '（未知）'}\`）`)
  out.push('')
  if (sessions.length === 0) {
    out.push('_（最近 30 分钟内没有活跃会话）_')
  } else {
    out.push('| 会话 | 状态 | 正在占用 | 最后活动 |')
    out.push('|---|---|---|---|')
    for (const s of sessions) {
      const held = state.claimedBy(s.id)
      const cell = held.length === 0 ? '—' : held.slice(0, 4).map((p) => `\`${shortPath(p)}\``).join('、')
        + (held.length > 4 ? ` 等 ${held.length} 个` : '')
      out.push(`| ${s.title}${s.isSubagent ? '（子智能体）' : ''} | ${s.status === 'running' ? '🟢 运行中' : '⚪ 空闲'} | ${cell} | ${agoText(now - s.lastActiveAt)} |`)
    }
  }
  out.push('')

  out.push('### 文件占用')
  out.push('')
  const rows = []
  for (const [path, holders] of state.claims.entries()) {
    const list = holders.filter((h) => h.sessionId !== '')
    if (list.length === 0) continue
    rows.push(`| \`${shortPath(path)}\` | ${list.map((h) => h.title || h.sessionId.slice(0, 8)).join('、')} | ${agoText(now - Math.max(...list.map((h) => h.at)))} |`)
  }
  if (rows.length === 0) {
    out.push('_（当前没有登记中的文件占用）_')
  } else {
    out.push('| 文件 | 占用者 | 开始于 |')
    out.push('|---|---|---|')
    out.push(...rows)
  }
  out.push('')

  out.push('### 会话留言')
  out.push('')
  const msgs = state.messages.slice(-12)
  if (msgs.length === 0) {
    out.push('_（还没有留言。会话可以用 `collab_post` 在这里留言。）_')
  } else {
    for (const m of msgs) {
      const t = new Date(m.at).toLocaleString('zh-CN', { hour12: false })
      out.push(`- \`${t}\` **${m.title || m.sessionId.slice(0, 8)}**：${m.text}`)
    }
  }
  out.push('')
  out.push(AUTO_END)
  return out.join('\n')
}

/**
 * 找到「独占一整行」的标记位置（返回行首下标）；找不到返回 -1。
 *
 * ⚠️ 刻意**不用**裸 `indexOf`：面板是人和插件共写的文件，谁在留言里贴出标记字面量
 * （讨论格式时极其常见），裸 indexOf 会把它当成区块起点，下一次 flush 就会把自动区块
 * **插进那条留言中间**、把留言劈成两半。要求「标记独占一行」后，正文里的同样字符串无害。
 *
 * @param {string} text - 面板全文。
 * @param {string} marker - 标记字符串（会被转义，可按字面量匹配）。
 * @param {number} [from] - 从哪个下标开始找。
 * @returns {number} 匹配行的起始下标，未找到为 -1。
 */
function findMarkerLine(text, marker, from = 0) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^[ \\t]*${escaped}[ \\t]*$`, 'gm')
  re.lastIndex = from
  const m = re.exec(text)
  return m ? m.index : -1
}

/** 把自动区块合并进面板：有标记就替换中间，没标记就追加到末尾。 */
export function mergePanel(existing, autoBlock) {
  const text = String(existing ?? '')
  const begin = findMarkerLine(text, AUTO_BEGIN)
  // 从 begin 之后找 end，避免正文里更早出现的字面量干扰。
  const end = begin >= 0 ? findMarkerLine(text, AUTO_END, begin + AUTO_BEGIN.length) : -1
  if (begin >= 0 && end > begin) {
    // end 是「行首」下标，必须整行跳过（否则 end 标记会被输出两次）。
    const endLineBreak = text.indexOf('\n', end)
    const tail = endLineBreak === -1 ? '' : text.slice(endLineBreak + 1)
    return `${text.slice(0, begin)}${autoBlock}\n${tail}`
  }
  const sep = text.trim() === '' ? '' : (text.endsWith('\n') ? '\n' : '\n\n')
  return `${text}${sep}${autoBlock}\n`
}

// ── 与 DSH 接线 ─────────────────────────────────────────────────────────────
//
// ⚠️ 这里**不 import 任何 DSH 包**：`defineTool` / `ctx` 全部由调用方注入，
//    这样本模块可以脱离 DSH 直接单测（见 tests/collab.test.mjs）。

/**
 * 把协作模式装进插件。
 *
 * @param {object} ctx - cordis 上下文（插件 apply 里的那个）。
 * @param {object} deps
 * @param {Function} [deps.defineTool] - `@deepseek-ai/dsh-tools` 的 defineTool；给了才注册工具。
 * @param {Function} deps.getConfig - 返回实时配置（归一化后的）。
 * @param {Function} [deps.log] - 日志函数。
 * @returns {CollabState} 供测试检查的内部状态。
 */
export function installCollab(ctx, { defineTool, getConfig = () => ({}), log = () => {} } = {}) {
  const state = new CollabState()
  let timer = null
  let writing = Promise.resolve()
  let enabledLogged = false

  const cfg = () => {
    const c = getConfig() || {}
    return {
      enabled: c.collabEnabled !== false,
      dir: typeof c.agentmdDir === 'string' ? c.agentmdDir.trim() : '',
      panelFile: (typeof c.collabPanelFile === 'string' && c.collabPanelFile.trim()) || DEFAULT_PANEL_FILE,
      scope: c.collabScope === 'global' ? 'global' : 'workspace',
      inject: c.collabInject !== false,
      guard: c.collabClaimGuard === 'block' ? 'block' : (c.collabClaimGuard === 'off' ? 'off' : 'warn'),
      ttl: Number.isFinite(c.collabClaimTtlMs) && c.collabClaimTtlMs > 0 ? c.collabClaimTtlMs : CLAIM_TTL_MS,
      includeSubagents: c.collabIncludeSubagents === true,
    }
  }

  // 协作模式可以在 DSH 界面上随时开/关（输入框下方那个小开关，或设置面板）。
  // 配置是**每次现读**的，所以关掉之后必须立刻全面噤声 —— 而不是"下次重启才生效"。
  // 工具本身留在注册表里（注销/重注册会牵动 tools 服务，代价大且没必要），
  // 但一律先看这个开关：关着就回一句人话，什么都不做。
  const DISABLED_NOTE = '协作模式已关闭（在 DSH 输入框下方、或「设置 → 协作模式」里打开）。'
  const collabOff = () => cfg().enabled !== true

  const panelPath = () => {
    const c = cfg()
    return c.dir ? join(c.dir, c.panelFile) : ''
  }
  const statePath = () => {
    const c = cfg()
    return c.dir ? join(c.dir, DEFAULT_STATE_FILE) : ''
  }

  /** 写盘：读现有面板 → 替换自动区块 → 原子写。串行化，避免并发写坏文件。 */
  function flush() {
    const c = cfg()
    const file = panelPath()
    if (!c.enabled || !file) return writing
    writing = writing.then(() => {
      try {
        state.sweepClaims(c.ttl)
        let existing = ''
        try {
          existing = readFileSync(file, 'utf8')
        } catch {
          existing = ''
        }
        const cwd = state.currentCwd ?? ''
        const block = renderAutoBlock(state, { cwd, now: state.now(), scope: c.scope })
        const next = mergePanel(existing, block)
        mkdirSync(c.dir, { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, next, 'utf8')
        renameSync(tmp, file)
        const sp = statePath()
        if (sp) writeFileSync(sp, JSON.stringify(state.toJSON(), null, 2), 'utf8')
      } catch (err) {
        log(`协作面板写入失败: ${err?.message ?? err}`)
      }
    }).catch(() => {})
    return writing
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, FLUSH_DEBOUNCE_MS)
    // unref：面板写盘不能阻止进程退出。
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** 启动时把上次的留言捞回来（跨重启保留）。 */
  function restore() {
    const sp = statePath()
    if (!sp) return
    try {
      state.loadJSON(JSON.parse(readFileSync(sp, 'utf8')))
    } catch {
      /* 首次运行没有状态文件，正常 */
    }
  }

  // ── 会话注册 ──
  ctx.on?.('agent/created', (payload) => {
    try {
      const c = cfg()
      if (!c.enabled) return
      const agent = payload?.agent
      if (!agent) return
      const info = describeAgent(agent)
      if (info.isSubagent && !c.includeSubagents) return
      state.upsert(agent, { status: 'running' })
      if (!state.currentCwd && info.cwd) state.currentCwd = info.cwd
      if (!enabledLogged) {
        enabledLogged = true
        log(`协作模式：已开启（范围 ${c.scope}${c.dir ? '' : '，agentmdDir 未配置 → 仅内存协作、不落盘'}，写冲突策略 ${c.guard}）`)
      }
      if (c.inject) attachInjection(agent, c)
      schedule()
    } catch (err) {
      log(`协作模式 agent/created 失败: ${err?.message ?? err}`)
    }
  })

  // ── 状态流转 ──
  ctx.on?.('agent/status', (payload) => {
    try {
      const c = cfg()
      if (!c.enabled) return
      const agent = payload?.agent
      const status = payload?.status
      const id = agent?.id ? String(agent.id) : ''
      if (!id) return
      if (!state.get(id)) {
        const info = describeAgent(agent)
        if (info.isSubagent && !c.includeSubagents) return
        state.upsert(agent, { status })
      } else {
        state.touch(id, status)
      }
      if (!state.currentCwd) {
        const info = describeAgent(agent)
        if (info.cwd) state.currentCwd = info.cwd
      }
      // 转空闲 = 这一轮结束了，把它占的文件放掉。
      // 否则一个会话写完睡下，别人永远等不到锁 —— 死锁比冲突更糟。
      if (status === 'idle') {
        const n = state.releaseAll(id)
        if (n > 0) log(`协作模式：会话 ${id.slice(0, 8)} 转空闲，自动释放 ${n} 个文件占用`)
        // 一轮结束，清掉已提示过的冲突警告，避免下一轮重复刷屏。
        state.clearNotes(id)
      }
      schedule()
    } catch (err) {
      log(`协作模式 agent/status 失败: ${err?.message ?? err}`)
    }
  })

  // ── 写冲突检测（与主插件的 pre-execute 监听并存，互不干扰）──
  //
  // 顺带在这里记下"这次调用是谁发起的"：工具的 execute() 里拿不到 exec，
  // 也就拿不到 agent。所以用**参数指纹 → agentId** 做精确回溯（首选），
  // 指纹失配时退回"最近一次带 agent 的调用"（并发下可能串号，但不写坏状态）。
  const pendingByFp = new Map()
  let lastAgentId = ''
  const fingerprint = (toolName, args) => {
    try {
      return `${String(toolName)}:${JSON.stringify(args ?? {})}`.slice(0, 2000)
    } catch {
      return `${String(toolName)}:?`
    }
  }
  const rememberCaller = (exec) => {
    const id = exec?.agent?.id ? String(exec.agent.id) : ''
    if (!id) return
    lastAgentId = id
    pendingByFp.set(fingerprint(exec?.name, exec?.arguments), { id, at: Date.now() })
    if (pendingByFp.size > 200) {
      const cutoff = Date.now() - 60_000
      for (const [k, v] of pendingByFp) if (v.at < cutoff) pendingByFp.delete(k)
    }
  }
  function currentAgentId(toolName = '', args = null) {
    if (toolName && args !== null && args !== undefined) {
      const hit = pendingByFp.get(fingerprint(toolName, args))
      if (hit && Date.now() - hit.at < 60_000) return hit.id
    }
    return lastAgentId
  }

  ctx.on?.('tools/pre-execute', (exec, next) => {
    try {
      rememberCaller(exec)
    } catch {
      /* 记不住调用者不影响主流程 */
    }
    try {
      checkWrite(exec)
    } catch (err) {
      // ⚠️ block 策略下**必须**把异常抛出去才能拦住工具：
      //    这里故意不做通用捕获 —— 只有真正的碰撞才抛，其它错误只记日志。
      if (err && err.__collabBlock) throw err
      log(`协作模式 pre-execute 失败: ${err?.message ?? err}`)
    }
    return typeof next === 'function' ? next() : undefined
  })

  function checkWrite(exec) {
    const c = cfg()
    if (!c.enabled || c.guard === 'off') return
    const toolName = exec?.name
    if (!isWriteTool(toolName)) return
    const agent = exec?.agent
    const id = agent?.id ? String(agent.id) : ''
    if (!id) return
    const info = describeAgent(agent)
    if (info.isSubagent && !c.includeSubagents) return
    if (!state.get(id)) state.upsert(agent, { status: 'running' })
    if (info.cwd && !state.currentCwd) state.currentCwd = info.cwd

    const targets = extractPaths(toolName, exec?.arguments)
    if (targets.length === 0) return

    const hits = []
    for (const p of targets) {
      const holders = state.conflict(p, id, c.ttl)
      if (holders.length > 0) hits.push({ path: p, holders })
    }

    if (hits.length > 0) {
      const detail = hits
        .map((h) => `${shortPath(h.path)}（正被「${h.holders.map((x) => x.title || x.sessionId.slice(0, 8)).join('、')}」占用）`)
        .join('；')
      const text = `你正要改 ${detail}。先看 agentmd/plugin-collab.md 的「文件占用」，或用 collab_post 跟对方商量 —— 直接写会互相覆盖。`
      state.note(id, text)
      log(`协作模式：⚠️ 文件冲突 —— 会话 ${id.slice(0, 8)} 试图写 ${hits.map((h) => h.path).join('、')}，已被 ${hits.map((h) => h.holders.map((x) => x.title).join('/')).join('、')} 占用`)
      if (c.guard === 'block') {
        const err = new Error(`[协作模式] ${text}`)
        err.__collabBlock = true
        throw err
      }
    }
    // 无论有没有冲突都登记自己 —— 冲突时更要登记，否则证据就丢了。
    for (const p of targets) state.claim(p, id, { tool: String(toolName ?? ''), title: info.title })
    schedule()
  }

  // ── 协作上下文注入 ──
  function attachInjection(agent, c) {
    const systemPrompt = ctx.get?.('systemPrompt')
    if (!systemPrompt || typeof systemPrompt.context !== 'function') return
    const agentCtx = agent?.ctx
    if (!agentCtx || typeof agentCtx.effect !== 'function') return
    const id = agent?.id ? String(agent.id) : ''
    if (!id) return
    // 用**这个会话自己的** cwd，而不是"第一个会话的 cwd" —— 多工作区下才正确。
    const cwd = describeAgent(agent).cwd || state.currentCwd || ''
    agentCtx.effect(() => systemPrompt.context({
      name: 'remote-qqbot:collab',
      // 排在 agentmd(150) 之后：先把"此前做过什么"给到，再给"现在还有谁在动"。
      order: 160,
      text: () => {
        try {
          // 关掉协作模式后，连已注入过的会话也不再收到协作上下文 —— 开关要"立刻"生效。
          if (collabOff()) return ''
          return renderInjection(state, { cwd, sessionId: id, now: state.now(), scope: c.scope })
        } catch (err) {
          log(`协作上下文生成失败: ${err?.message ?? err}`)
          return ''
        }
      },
    }))
  }

  // ── 工具 ──
  if (typeof defineTool === 'function') {
    const textOutput = {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    }
    const register = (spec) => ctx.effect(() => ctx.tools.register(defineTool(spec)))

    register({
      name: 'collab_status',
      description: '查看同一工作区里其他会话的协作现状：谁在跑、谁占了哪些文件、有什么留言。开始改别人可能也在动的文件前先看一眼。',
      parameters: {
        markRead: { type: 'boolean', description: '是否把留言标记为已读，默认 true' },
      },
      output: textOutput,
      async execute(args) {
        if (collabOff()) return DISABLED_NOTE
        const id = currentAgentId('collab_status', args)
        const c = cfg()
        state.sweepClaims(c.ttl)
        const me = state.get(id)
        const cwd = me?.cwd || state.currentCwd || ''
        const lines = [`工作区：${cwd || '（未知）'}`, '']
        const all = state.peers(cwd, { scope: c.scope, includeSelf: true })
        if (all.length === 0) lines.push('（最近 30 分钟内没有其他活跃会话）')
        for (const s of all) {
          const held = state.claimedBy(s.id)
          lines.push(`- 「${s.title}」${s.id === id ? '（你）' : ''} ${s.status === 'running' ? '🟢 运行中' : '⚪ 空闲'}`
            + ` · ${agoText(state.now() - s.lastActiveAt)}`
            + (held.length > 0 ? ` · 占用 ${held.map(shortPath).join('、')}` : ''))
        }
        const unread = state.unread(id, { limit: 10 })
        if (unread.length > 0) {
          lines.push('', '留言：')
          for (const m of unread) lines.push(`- 「${m.title || '其他会话'}」${m.text}`)
        }
        if (args?.markRead !== false) state.markRead(id)
        return lines.join('\n')
      },
    })

    register({
      name: 'collab_post',
      description: '给同一工作区的其他会话留言（会写进协作面板，并出现在对方的协作上下文里）。用于协调"这个文件我在改""我先做 A 你做 B"这类事。',
      parameters: {
        text: { type: 'string', required: true, description: '留言内容，一句话说清你要对方知道什么' },
      },
      output: textOutput,
      async execute(args) {
        if (collabOff()) return DISABLED_NOTE
        const id = currentAgentId('collab_post', args)
        const me = state.get(id)
        const msg = state.post(id, args?.text, { title: me?.title ?? '' })
        if (!msg) return '留言内容为空，没有写入。'
        schedule()
        return `已留言，其他会话下一步就能看到：「${msg.text}」`
      },
    })

    register({
      name: 'collab_claim',
      description: '声明"这些文件我在改"，避免与其他会话撞车。改文件前调用；转空闲时会自动释放，也可用 collab_release 手动释放。',
      parameters: {
        paths: { type: 'string', required: true, description: '文件路径，多个用英文逗号或换行分隔' },
        note: { type: 'string', description: '可选：你在做什么，便于别人判断' },
      },
      output: textOutput,
      async execute(args) {
        if (collabOff()) return DISABLED_NOTE
        const id = currentAgentId('collab_claim', args)
        const me = state.get(id)
        const list = String(args?.paths ?? '').split(/[,\n;]/).map((s) => s.trim()).filter(Boolean)
        if (list.length === 0) return '没有给出有效路径。'
        const conflicts = []
        for (const p of list) {
          const holders = state.conflict(p, id, cfg().ttl)
          if (holders.length > 0) conflicts.push({ p, holders })
        }
        for (const p of list) state.claim(p, id, { tool: 'collab_claim', title: me?.title ?? '' })
        if (args?.note) state.note(id, `你自己登记的备注：${args.note}`)
        schedule()
        const head = `已登记占用 ${list.length} 个文件。`
        if (conflicts.length === 0) return head
        return `${head}\n⚠️ 其中这些**已被别人占用**，你确认清楚再写：\n`
          + conflicts.map((c) => `- ${shortPath(c.p)} ← ${c.holders.map((h) => h.title || h.sessionId.slice(0, 8)).join('、')}`).join('\n')
      },
    })

    register({
      name: 'collab_release',
      description: '释放自己登记的文件占用（收工、或发现别人更需要时）。不给 paths 就释放自己全部占用。',
      parameters: {
        paths: { type: 'string', description: '可选：要释放的文件路径，多个用逗号或换行分隔；留空释放全部' },
      },
      output: textOutput,
      async execute(args) {
        if (collabOff()) return DISABLED_NOTE
        const id = currentAgentId('collab_release', args)
        const raw = String(args?.paths ?? '').trim()
        if (!raw) {
          const n = state.releaseAll(id)
          schedule()
          return n === 0 ? '你没有登记任何占用。' : `已释放全部 ${n} 个文件占用。`
        }
        const list = raw.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean)
        let n = 0
        for (const p of list) if (state.release(p, id)) n += 1
        schedule()
        return `已释放 ${n} / ${list.length} 个占用。`
      },
    })
  }

  restore()
  // 给测试与外部调用使用：立即落盘（不等 1.5s 的 debounce）。
  state.flushNow = () => flush()
  state.panelPath = panelPath
  state.collabConfig = cfg
  return state
}
