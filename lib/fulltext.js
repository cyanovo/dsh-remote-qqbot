/**
 * 全文查看的三档模式 + 「把长文切成能发进 QQ 的几条」。
 *
 * 主人 2026-10-03 的需求原话：
 *   使用全文查看功能有两个选项，1 是直接输出到 QQ 聊天页面 2 是现在的但是不带使用链接的
 *   全文查看 3 就是目前的带链接全文查看功能。
 *
 * 于是定成三档（都是**用户偏好**，不是服务端策略）：
 *   - `chat`（默认）：**一个字节都不上传**。完整回答切成几条直接发进 QQ 聊天框。
 *                     这也是「默认关闭上传」那一条决定的落地方式 —— 默认态下服务器完全不知道
 *                     你的对话内容，插件对它只字不提。
 *   - `note`：上传到作者服务器永久化（受配额与 TTL 约束），QQ 里只推「摘要」，不给链接。
 *   - `note-link`：和 `note` 一样上传，但 QQ 摘要后面**多一个可以点开的短链接**（当前行为）。
 *
 * ⚠️ 本模块**刻意零依赖、纯函数**：不读配置、不碰网络、不 import 任何别的文件。
 *    这样护栏测试可以直接把函数跑起来看输出，而不是去正则扫源码
 *    （本项目已经被"注释里的字面量"骗过三次）。
 */

/** 三档全文模式，顺序即设置面板里的展示顺序。 */
export const FULLTEXT_MODES = ['chat', 'note', 'note-link']

/** 出厂默认：发到 QQ 聊天框、不上传。 */
export const DEFAULT_FULLTEXT_MODE = 'chat'

/**
 * QQ 单条纯文本消息的安全长度。
 *
 * ⚠️ **这个数是保守估计，不是实测出来的**。QQ 官方对 C2C 文本消息的长度上限没有公开准确值，
 *    我们没有拿主人的真实聊天窗口去做二分探测（那会在聊天里留下垃圾消息）。
 *    899 这个取值保证「即使 QQ 的上限比它小，也只是多切几条」，而不会出现发不出去。
 *    将来若真测出上限，改这里一个常量即可（测试与调用点都只用这个默认值）。
 */
export const QQ_TEXT_SAFE_CHARS = 900

/**
 * 给「第 i / 共 n 条」标记预留的字符数。
 *
 * 最长的形式是 `（10/10）\n` —— 3 位以上只在 n ≥ 100 时出现，而 100 条 × 900 字 = 9 万字，
 * 已经超过 `notesMaxChars`（默认 20000）的量级，实际到不了。取 9 是安全且不浪费的。
 */
const MARKER_RESERVE = 9

/** 单条消息的下限：比这还小就没有切分的意义了（也防住调用方传 0 导致死循环）。 */
const MIN_CHUNK_CHARS = 100

/**
 * 把任意输入归一化成三档之一；认不出来一律回落到默认档 `chat`。
 *
 * 「认不出来 → 不上传」是刻意的方向：配置写错时的失败模式应该是**保守**的
 * （少发一次全文），而不是"照传不误"。
 *
 * @param {unknown} value - 配置里读到的值。
 * @returns {'chat'|'note'|'note-link'} 归一化后的模式。
 */
export function normalizeFulltextMode(value) {
  if (typeof value !== 'string') return DEFAULT_FULLTEXT_MODE
  const v = value.trim().toLowerCase().replace(/[_\s]+/g, '-')
  // 容错几种常见写法：online / link / cloud 之类的手写值不该把用户带进"悄悄不上传"。
  if (v === 'note-link' || v === 'notelink' || v === 'link' || v === 'noteurl' || v === 'note-url') return 'note-link'
  if (v === 'note' || v === 'cloud' || v === 'upload') return 'note'
  if (v === 'chat' || v === 'qq' || v === 'direct') return 'chat'
  return DEFAULT_FULLTEXT_MODE
}

/** 这一档要不要**上传**到作者服务器（即要不要写笔记）。 */
export function uploadsFulltext(mode) {
  return normalizeFulltextMode(mode) !== 'chat'
}

/** 这一档要不要在 QQ 摘要后面**附链接**。 */
export function showsFulltextLink(mode) {
  return normalizeFulltextMode(mode) === 'note-link'
}

/** 这一档要不要把全文**切成几条发进 QQ 聊天框**。 */
export function sendsFulltextToChat(mode) {
  return normalizeFulltextMode(mode) === 'chat'
}

/** 这一档在设置面板/文档里的中文名。 */
export function fulltextModeLabel(mode) {
  switch (normalizeFulltextMode(mode)) {
    case 'note':
      return '存到服务器（只给摘要，不给链接）'
    case 'note-link':
      return '存到服务器 + 链接'
    default:
      return '直接发到 QQ 聊天框（不上传）'
  }
}

/** 判断一个 UTF-16 码元是不是代理对的低半区（不能在它前面切断）。 */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * 把一行**过长的**文本硬切成若干段。
 *
 * 两条纪律：
 *   1. **不许切断代理对**（emoji / 生僻字会被切成半个，QQ 那边就是乱码方块）；
 *   2. 能在空格处断就断在空格处（英文/代码可读得多）。
 *
 * @param {string} line - 单行文本（可能本身就很长）。
 * @param {number} limit - 每段最大 UTF-16 长度。
 * @returns {string[]} 切好的段（每段 ≤ limit，且都非空）。
 */
function hardSplitLine(line, limit) {
  const out = []
  let rest = line
  while (rest.length > limit) {
    let cut = limit
    if (isLowSurrogate(rest.charCodeAt(cut))) cut -= 1
    // 只在"离上限不算太远"的空格处断，否则会切出很短的一条一条。
    const sp = rest.lastIndexOf(' ', cut)
    if (sp > Math.floor(limit * 0.5)) cut = sp
    if (cut <= 0) cut = limit
    const piece = rest.slice(0, cut).replace(/\s+$/, '')
    if (piece !== '') out.push(piece)
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest !== '') out.push(rest)
  return out
}

/**
 * 把文本拆成「段落」和「行」两种最小单元，各自不超过 limit。
 * 拆的时候只在空白处动手，**不增删任何非空白字符**。
 */
function toUnits(text, limit) {
  const out = []
  for (const rawPara of text.split(/\n{2,}/)) {
    const para = rawPara.replace(/^\s+|\s+$/g, '')
    if (para === '') continue
    if (para.length <= limit) {
      out.push({ kind: 'para', text: para })
      continue
    }
    for (const rawLine of para.split('\n')) {
      const line = rawLine.replace(/^\s+|\s+$/g, '')
      if (line === '') continue
      if (line.length <= limit) {
        out.push({ kind: 'line', text: line })
        continue
      }
      for (const piece of hardSplitLine(line, limit)) out.push({ kind: 'line', text: piece })
    }
  }
  return out
}

/** 一个单元单独占一条时用的切分（菜单/测试友好：不依赖贪心打包）。 */
function packUnits(units, limit) {
  const chunks = []
  let cur = ''
  let curKind = null
  for (const unit of units) {
    if (cur === '') {
      cur = unit.text
      curKind = unit.kind
      continue
    }
    // 段落之间空一行（保住 markdown 的段落边界），行之间只换行。
    const sep = unit.kind === 'para' && curKind === 'para' ? '\n\n' : '\n'
    const merged = `${cur}${sep}${unit.text}`
    if (merged.length <= limit) {
      cur = merged
      curKind = unit.kind
      continue
    }
    chunks.push(cur)
    cur = unit.text
    curKind = unit.kind
  }
  if (cur !== '') chunks.push(cur)
  return chunks
}

/**
 * 把长文切成**能逐条发进 QQ** 的若干段。返回的是**纯内容**，不含任何「1/3」标记
 * （标记由 {@link markQqChunks} 加，这样切分逻辑本身可以独立测）。
 *
 * 保证：
 *   - 每段长度 ≤ `maxChars`；
 *   - 拼接后去掉的首尾空白之外，**没有任何内容丢失**（有护栏测试逐段拼回原文比对）；
 *   - 优先在段落、其次在行、最后才硬切；
 *   - 空文本返回 `[]`（调用方据此什么都不发）。
 *
 * @param {unknown} text - 完整回答原文。
 * @param {{maxChars?: number}} [options] - `maxChars` 为单条消息上限。
 * @returns {string[]} 切好的段。
 */
export function splitForQq(text, options = {}) {
  const raw = typeof text === 'string' ? text : ''
  if (raw.trim() === '') return []
  const limit = Number.isFinite(options.maxChars) && options.maxChars >= MIN_CHUNK_CHARS
    ? Math.floor(options.maxChars)
    : QQ_TEXT_SAFE_CHARS

  const first = packUnits(toUnits(raw, limit), limit)
  if (first.length <= 1) return first

  // 会切成多条 ⇒ 每条前面要加「（i/n）」，于是正文得再让出几个字符，避免加完标记反而超限。
  //
  // 🔴 下限必须是 1，不能是 MIN_CHUNK_CHARS：调用方传进来的 limit 已经过了
  //    `limit >= MIN_CHUNK_CHARS` 的门槛（见上面那个三元），这里若再拿 100 兜底，
  //    当 limit ≤ 109 时 `limit - MARKER_RESERVE` 会被顶回 100 ⇒ 正文 100 字 + 标记 6 字 = 106 字，
  //    **带序号的每一条都会超过调用方给的上限**（实测 limit=100 时得到 106）。
  //    这条「带标记后仍不超过 limit」的保证由 tests/fulltext.test.mjs 钉住。
  //    下限取 1 只防 limit 被算成 0/负数，不会让硬切死循环（hardSplitLine 有 cut <= 0 兜底）。
  const bodyLimit = Math.max(1, limit - MARKER_RESERVE)
  return packUnits(toUnits(raw, bodyLimit), bodyLimit)
}

/**
 * 给切好的段加上「第 i / 共 n 条」标记。只有当 n > 1 时才加 —— 单条消息不该多一行噪音。
 *
 * 标记放在**开头**：QQ 消息被折叠或只看后半段时，开头那行是唯一能告诉你"这是第几条"的东西。
 *
 * @param {string[]} chunks - {@link splitForQq} 的输出。
 * @returns {string[]} 可直接逐条发送的文本。
 */
export function markQqChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return []
  if (chunks.length === 1) return [chunks[0]]
  const n = chunks.length
  return chunks.map((c, i) => `（${i + 1}/${n}）\n${c}`)
}

/**
 * 一步到位：长文 → 可直接逐条发送的 QQ 文本。
 *
 * @param {unknown} text - 完整回答原文。
 * @param {{maxChars?: number}} [options] - 同 {@link splitForQq}。
 * @returns {{chunks: string[], total: number, chars: number}} `chunks` 已带标记。
 */
export function planQqFulltext(text, options = {}) {
  const raw = typeof text === 'string' ? text : ''
  const chunks = markQqChunks(splitForQq(raw, options))
  return { chunks, total: chunks.length, chars: raw.length }
}
