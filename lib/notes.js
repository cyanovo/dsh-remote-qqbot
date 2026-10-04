/**
 * 会话「完整回答」——把这一轮的原文存到服务器，换回一个能直接点开的短链接。
 *
 * 为什么要有它：
 *   QQ 推送里那几句摘要是给人**扫一眼**的，遇到长回答必然被截掉；
 *   而"到底改了哪几个文件、结论是什么"这类细节只有原文里才有。
 *   所以推送留摘要 + 一个链接，正文落到服务器，点开就是完整原文。
 *
 * 依赖：只用 Node 内置的全局 fetch / AbortController。**不 import 任何裸包** ——
 *       与 collab.js 同理，本模块可以脱离 DSH 直接单测（见 tests/notes.test.mjs）。
 */

/** id 字符表；必须与中枢 `server.mjs` 里的 NOTE_ALPHABET 完全一致。 */
export const NOTE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** 默认 id 长度：36^5 ≈ 6047 万种，够短也好认。 */
export const DEFAULT_ID_LENGTH = 5
/** 上传超时。宁可少一个链接，也不能让通知迟到 —— 超时就当没存。 */
export const DEFAULT_TIMEOUT_MS = 6000
/** 正文上限（字符）：超过就截断，避免一份巨大的回答把服务器塞满。 */
export const DEFAULT_MAX_CHARS = 20000

/**
 * 生成一个随机 id（纯本地运算，便于测试注入 deterministic 的 random）。
 *
 * @param {number} [length] - 长度。
 * @param {() => number} [random] - 随机源，默认 Math.random。
 * @returns {string} 形如 `k3f9a` 的 id。
 */
export function makeNoteId(length = DEFAULT_ID_LENGTH, random = Math.random) {
  const len = Math.max(1, Math.floor(Number(length)) || DEFAULT_ID_LENGTH)
  let out = ''
  for (let i = 0; i < len; i += 1) out += NOTE_ID_ALPHABET[Math.floor(random() * NOTE_ID_ALPHABET.length)]
  return out
}

/**
 * 把时间戳格式化成 `2026-10-02 04:30:00`（本地时区）。
 *
 * 刻意手工补零而不是用 `toLocaleString('zh-CN')`：后者在不同 Node/ICU 版本下
 * 可能给出 `2026/10/2 4:30:13` 这种不补零、甚至不同分隔符的结果 ——
 * 这是要出现在**页面标题下**给人看的，格式必须稳定。
 */
export function formatStamp(at = Date.now()) {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return String(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 把一轮对话渲染成一份自洽的 markdown。
 *
 * 刻意**不做**转义/清洗：`sanitize` 是防注入的活儿，这里的内容全部来自你自己的
 * 会话，转义只会把代码块里的 `<` 变成 `&lt;` 然后让你看不懂。链接是公开可读的，
 * 所以别把密钥之类的会话拿来做测试。
 *
 * @param {object} p - 各字段。
 * @param {string} [p.session] - 会话标题（如 `main`）。
 * @param {string} [p.sessionId] - 会话 id。
 * @param {string} [p.cwd] - 工作区目录。
 * @param {number|Date} [p.at] - 时间。
 * @param {string} [p.user] - 用户消息原文。
 * @param {string} [p.assistant] - 助手回答原文。
 * @param {number} [p.maxChars] - 正文上限。
 * @returns {{ markdown: string, truncated: boolean, totalChars: number }} 渲染结果。
 */
export function renderNote({
  session = '',
  sessionId = '',
  cwd = '',
  at = Date.now(),
  user = '',
  assistant = '',
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const body = String(assistant ?? '').trim()
  const limit = Math.max(0, Math.floor(Number(maxChars)) || DEFAULT_MAX_CHARS)
  const truncated = limit > 0 && body.length > limit
  const shown = truncated
    ? `${body.slice(0, limit)}\n\n> ⚠️ 原文过长，此处已截断（完整 ${body.length} 字符）`
    : body

  const meta = [cwd ? `工作区 \`${cwd}\`` : '', sessionId ? `会话 \`${sessionId}\`` : ''].filter(Boolean).join('　｜　')
  const lines = [
    `# ${String(session ?? '').trim() || 'DSH 会话'}`,
    '',
  ]
  if (meta) lines.push(`> ${meta}`)
  lines.push(`> ${formatStamp(at)}`, '')
  lines.push('## 我这一轮说了什么', '')
  lines.push(String(user ?? '').trim() || '_（这一轮没有新的用户输入）_', '')
  lines.push('## 完整回答', '')
  lines.push(shown || '_（这一轮没有产生文本回答）_', '')
  lines.push('---', '')
  lines.push('<sub>由 dsh-remote-qqbot 自动记录 · 这里是未删节的原文，不是摘要</sub>', '')

  return { markdown: lines.join('\n'), truncated, totalChars: body.length }
}

/**
 * 把 markdown 上传到中枢，拿回可公开访问的短链接。
 *
 * **绝不抛异常**：任何失败都返回 null 并记一条日志 —— 调用方（推送）不能因为
 * 服务器抽风就丢通知。
 *
 * @param {object} p - 各字段。
 * @param {string} p.hubUrl - 中枢地址，如 `https://cyanovo.top:8444/dsh-hub`。
 * @param {string} [p.token] - 中枢 Bearer 令牌。
 * @param {string} p.markdown - 正文。
 * @param {number} [p.idLength] - id 长度。
 * @param {string} [p.session] - 会话名（只用于服务端日志）。
 * @param {Function} [p.fetchImpl] - fetch 实现（测试注入）。
 * @param {number} [p.timeoutMs] - 超时。
 * @param {(msg: string) => void} [p.log] - 日志。
 * @returns {Promise<{id: string, url: string, bytes?: number}|null>} 成功时的结果。
 */
export async function publishNote({
  hubUrl,
  token = '',
  markdown,
  idLength,
  session = '',
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const base = String(hubUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) return null
  const text = String(markdown ?? '')
  if (!text.trim()) return null
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    log('当前环境没有 fetch，跳过完整回答上传')
    return null
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
  try {
    const res = await doFetch(`${base}/api/notes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ markdown: text, idLength, session: session || undefined }),
      signal: controller.signal,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.url) {
      log(`上传完整回答失败：HTTP ${res.status}${data?.error ? ` ${data.error}` : ''}`)
      return null
    }
    return { id: data.id, url: data.url, bytes: data.bytes }
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (err?.message ?? String(err))
    log(`上传完整回答失败：${reason}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}
