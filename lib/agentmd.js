/**
 * agentmd —— 「操作日志自动追加 + 文档内容读取」的纯逻辑层。
 *
 * 这里刻意不依赖任何 DSH 运行时对象（不碰 ctx、不碰 agent），
 * 只做文件读写与 markdown 表格解析，因此可以在 node 里直接单测。
 *
 * 设计要点：
 *   - 追加目标是 main.md 里「## 四、操作日志」小节下方的三列表格。
 *   - 「| 时间 | 操作 | 结果 |」这一行是表头，下一行是分隔行 `|---|---|---|`；
 *     真实数据行的特征是首列是 `YYYY-MM-DD`（或 `YYYY-MM-DD HH:mm`）。
 *   - 追加策略：读入全文 → 按行切成数组 → 找到该小节内「首列为日期的最后一行」
 *     → 在它后面插入新行；若没有数据行，就插在分隔行之后。
 *     这样即便表格后面还跟着别的文字（如「---」或下一节），也不会插错位置。
 *   - 全程容错：任何异常都返回 { ok: false, reason }，绝不向上抛。
 *
 * 🔴 预算（2026-10-04 补，见 {@link buildContextDoc}）：本文档会被**注入每一轮 prompt**，
 * 因此“读全文”这条路必须是有界的 —— 文件再大，注入的字符数也不许超过 maxChars。
 * 只靠“把文件写小”是不够的：只要哪天有人往文档里贴一段长文，上下文立刻爆掉。
 * 同理，{@link buildLogRow} 对单条日志行也有长度上限，避免一行把文件撑大。
 */

import { readFile, writeFile, appendFile, mkdir, access } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { join } from 'node:path'

/** 「操作日志」小节标题；允许空格差异，见 SECTION_HEADING。 */
const SECTION_HEADING = /^#{1,6}\s*四\s*[、.]\s*操作日志\s*$/
/** 表头行：形如 `| 时间 | 操作 | 结果 |`。 */
const HEADER_ROW = /^\|\s*时间\s*\|\s*操作\s*\|\s*结果\s*\|\s*$/
/** 分隔行：形如 `|---|---|---|`。 */
const SEPARATOR_ROW = /^\|(?:\s*:?-{2,}:?\s*\|){2,}\s*$/
/** 数据行首列必须是日期（可选带 HH:mm）。 */
const DATE_CELL = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?\s*$/
/** 文件头部「最后更新：」那一行。 */
const LAST_UPDATED = /^(>\s*)?(.*?最后更新[：:]\s*)(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)(\s*)$/

/**
 * 注入上下文的默认字符上限。
 *
 * 8000 字符 ≈ 4~6k token（中文），单条上下文够用，又不至于把 prompt 顶到上游的
 * 413 阈值。真正重要的是**有界**：文档长到 30 万字符时也只注入这么多。
 */
export const DEFAULT_CONTEXT_MAX_CHARS = 8000

/** 注入时默认保留的日志表最后行数。 */
export const DEFAULT_CONTEXT_TAIL_ROWS = 20

/** 单条操作日志行的默认字符上限（含时间与结果两列）。 */
export const DEFAULT_ROW_MAX_CHARS = 600

/** 日志行无论配置多小，都至少留出这么多字符的骨架（时间 + 两个竖线）。 */
const ROW_HARD_FLOOR = 40

/**
 * 按字符数裁剪一段文本，并保证**不把最后一行切一半**。
 * @param {string} text - 待裁剪文本。
 * @param {number} limit - 允许的最大字符数。
 * @returns {{ text: string, cut: number }} 裁剪结果与被切掉的字符数。
 */
function cutByChars(text, limit) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (limit <= 0) return { text: '', cut: s.length }
  if (s.length <= limit) return { text: s, cut: 0 }
  const slice = s.slice(0, limit)
  const nl = slice.lastIndexOf('\n')
  const out = nl > 0 ? slice.slice(0, nl) : slice
  return { text: out, cut: s.length - out.length }
}

/**
 * 把单元格文本裁到 budget 个字符以内，被裁时以 `…` 结尾。
 * @param {unknown} value - 任意值。
 * @param {number} budget - 允许的最大字符数。
 * @returns {string} 不超过 budget 的文本。
 */
function cutCell(value, budget) {
  const s = String(value ?? '')
  const b = Math.max(0, Math.floor(budget))
  if (b === 0) return ''
  if (s.length <= b) return s
  if (b === 1) return '…'
  return `${s.slice(0, b - 1)}…`
}

/**
 * 两位补零。
 * @param {number} n - 任意整数。
 * @returns {string} 至少两位的十进制字符串。
 */
function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * 把 Date 格式化为本地时间 `YYYY-MM-DD HH:mm`。
 * @param {Date} [date] - 目标时间，默认当前时间。
 * @returns {string} 本地时区的 `YYYY-MM-DD HH:mm`。
 */
export function formatStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 把 Date 格式化为本地日期 `YYYY-MM-DD`。
 * @param {Date} [date] - 目标时间，默认当前时间。
 * @returns {string} 本地时区的 `YYYY-MM-DD`。
 */
export function formatDate(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 清洗单元格：单元格里出现 `|` 会把列数撑破，换行会撑破成多行。
 * 因此先把换行/制表压成空格，再把竖线换成全角 `｜`，最后折叠空白。
 * @param {unknown} value - 任意待写入单元格的值。
 * @returns {string} 单行、不含半角竖线的安全单元格文本。
 */
export function safeCell(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\|/g, '｜')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 判断一行是否位于「操作日志」小节内——从标题行起，到下一个同级或更高级标题为止。
 * @param {string} line - 完整一行。
 * @returns {boolean} 是否为小节内的普通内容行。
 */
function isSubsectionBody(line) {
  if (SECTION_HEADING.test(line.trim())) return true
  if (/^\s*(#{1,6})\s/.test(line)) return false
  return true
}

/**
 * 在文档行数组里定位「操作日志」表格的插点与表头信息。
 * @param {string[]} lines - 文档全文按行拆分的结果。
 * @returns {{ insertAt: number, headerIndex: number, separatorIndex: number, bodyEnd: number } | null}
 *   找到时返回插点；找不到小节/表头/分隔行时返回 null。
 */
export function locateLogTable(lines) {
  let sectionStart = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (SECTION_HEADING.test(lines[i].trim())) {
      sectionStart = i
      break
    }
  }
  if (sectionStart < 0) return null

  let bodyEnd = lines.length
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (/^\s*#{1,6}\s/.test(lines[i])) {
      bodyEnd = i
      break
    }
  }

  let headerIndex = -1
  for (let i = sectionStart + 1; i < bodyEnd; i += 1) {
    if (HEADER_ROW.test(lines[i].trim())) {
      headerIndex = i
      break
    }
  }
  if (headerIndex < 0) return null

  let separatorIndex = -1
  for (let i = headerIndex + 1; i < bodyEnd; i += 1) {
    if (SEPARATOR_ROW.test(lines[i].trim())) {
      separatorIndex = i
      break
    }
    // 表头与分隔行之间不能夹着正文，否则视为这张表结构不可信。
    if (lines[i].trim() !== '') return null
  }
  if (separatorIndex < 0) return null

  let insertAt = separatorIndex + 1
  for (let i = separatorIndex + 1; i < bodyEnd; i += 1) {
    const line = lines[i].trim()
    if (line === '') continue
    if (line.startsWith('|')) {
      const first = line.split('|')[1] ?? ''
      if (DATE_CELL.test(first)) insertAt = i + 1
    }
  }
  return { insertAt, headerIndex, separatorIndex, bodyEnd }
}

/**
 * 构造一行日志：`| 时间 | 操作 | 结果 |`。
 *
 * 行长度**有上限**：一条日志就是一个表格行，行太长会把文档撑大；而文档越大，
 * 注入上下文越容易爆（见 {@link buildContextDoc}）。超出上限时从「操作」列尾部裁，
 * 被裁处以 `…` 结尾，**时间列与表格结构永远完整**（裁掉竖线会让整张表散架）。
 *
 * @param {{ when?: Date, action?: string, result?: string, maxChars?: number }} entry - 日志内容。
 * @returns {string} 完整的 markdown 表格行，长度不超过 maxChars（下限 40）。
 */
export function buildLogRow({ when = new Date(), action = '', result = '', maxChars = DEFAULT_ROW_MAX_CHARS } = {}) {
  const limit = Math.max(
    ROW_HARD_FLOOR,
    Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_ROW_MAX_CHARS,
  )
  const stamp = formatStamp(when)
  const render = (act, res) => `| ${stamp} | ${act} | ${res} |`

  let res = cutCell(safeCell(result), Math.max(1, Math.floor(limit / 4)))
  let act = safeCell(action)
  let row = render(act, res)
  if (row.length > limit) {
    // 先只裁「操作」列：留出 act 的空间 = 上限 - 空 act 时的行宽。
    act = cutCell(act, Math.max(0, limit - render('', res).length))
    row = render(act, res)
  }
  if (row.length > limit) {
    // 连「结果」列也太长：这时只能连它一起裁，仍然保住表格骨架。
    res = cutCell(res, Math.max(0, limit - render('', '').length))
    row = render('', res)
  }
  return row
}

/**
 * 把整篇文档压成**有界**的注入文本。
 *
 * 为什么需要它：这份文档会被注册成 `systemPrompt.context`，**每一个模型步骤都会重新注入**。
 * 只要文件本身没有硬上限，任何一次「往文档里贴一大段」都会把每一步的 prompt 顶爆
 * （本项目已实测撞到上游 413）。所以这里的契约是硬性的：
 *
 *   **返回值 `.text` 的字符数永远 ≤ maxChars**，与输入文档多大无关。
 *
 * 压缩策略（按重要性排序，先保最重要的）：
 *   1. 「四、操作日志」小节的表头 + 最近 `tailRows` 行 —— 这是“刚发生了什么”；
 *   2. 表格之前的正文（§零/§一/§二/§三 = 环境事实、当前状态、待办）—— 按预算从头截；
 *   3. 被丢掉的部分用一行 `…（此处省略约 N 个字符…）…` 明说，并提示用 `agentmd_read` 读全文 ——
 *      **绝不能悄悄截断**，否则模型会把“没看到”当成“不存在”。
 *
 * @param {string} text - 文档全文。
 * @param {{ maxChars?: number, tailRows?: number }} [options] - 预算；maxChars ≤ 0 时用默认值。
 * @returns {{ text: string, truncated: boolean, totalChars: number, keptChars: number,
 *   omittedChars: number, rowsKept: number|null, rowsOmitted: number, droppedHeadChars: number }}
 *   `text` 为可直接注入的文本（保证 ≤ maxChars）。
 */
export function buildContextDoc(text, options = {}) {
  const src = typeof text === 'string' ? text : String(text ?? '')
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0
    ? Math.floor(options.maxChars)
    : DEFAULT_CONTEXT_MAX_CHARS
  const tailRows = Number.isFinite(options.tailRows) && options.tailRows >= 0
    ? Math.floor(options.tailRows)
    : DEFAULT_CONTEXT_TAIL_ROWS

  const totalChars = src.length
  if (totalChars <= maxChars) {
    return {
      text: src,
      truncated: false,
      totalChars,
      keptChars: totalChars,
      omittedChars: 0,
      rowsKept: null,
      rowsOmitted: 0,
      droppedHeadChars: 0,
    }
  }

  const lines = src.split('\n')
  const spot = locateLogTable(lines)
  const sectionStart = lines.findIndex((line) => SECTION_HEADING.test(line.trim()))

  // ── 1. 日志表尾部 ────────────────────────────────────────────────────────
  let body = ''
  let rowsKept = null
  let rowsOmitted = 0
  if (spot && sectionStart >= 0 && spot.headerIndex > sectionStart) {
    const frame = [lines[sectionStart], '', lines[spot.headerIndex], lines[spot.separatorIndex]]
    const allRows = []
    for (let i = spot.separatorIndex + 1; i < spot.bodyEnd; i += 1) {
      if (lines[i].trim().startsWith('|')) allRows.push(lines[i])
    }
    const kept = allRows.slice(-Math.max(0, tailRows))
    rowsOmitted = allRows.length - kept.length
    // 尾部最多占一半预算，保证前半部分（环境事实 / 当前状态）也有位置。
    const sectionBudget = Math.max(400, Math.floor(maxChars / 2))
    while (kept.length > 0 && [...frame, ...kept].join('\n').length > sectionBudget) {
      kept.shift()
      rowsOmitted += 1
    }
    rowsKept = kept.length
    body = [...frame, ...kept].join('\n')
  }

  // ── 2. 表格之前的正文，按剩余预算从头截（不切半行）────────────────────────
  const headRaw = sectionStart < 0
    ? src
    : lines.slice(0, sectionStart).join('\n').replace(/\s+$/, '')
  const marker = (n) => `…（此处省略约 ${n} 个字符。需要完整内容请用 agentmd_read 工具读全文）…`
  const headBudget = maxChars - body.length - marker(999999).length - 4
  const cut = cutByChars(headRaw, Math.max(0, headBudget))
  const droppedHeadChars = headRaw.length - cut.text.length

  const parts = []
  if (cut.text) parts.push(cut.text)
  if (droppedHeadChars > 0) parts.push(marker(droppedHeadChars))
  if (body) parts.push(body)
  let out = parts.join('\n\n')

  // ── 3. 最后一道保险：宁可截断，也绝不超预算 ────────────────────────────────
  if (out.length > maxChars) {
    out = `${out.slice(0, Math.max(0, maxChars - 1))}…`
  }

  return {
    text: out,
    truncated: true,
    totalChars,
    keptChars: out.length,
    omittedChars: totalChars - out.length,
    rowsKept,
    rowsOmitted,
    droppedHeadChars,
  }
}

/**
 * 更新文档头部的「最后更新：」一行；找不到就不动。
 * @param {string} text - 文档全文。
 * @param {string} stamp - 新的日期（`YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`）。
 * @returns {string} 更新后的全文。
 */
export function bumpLastUpdated(text, stamp) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const m = LAST_UPDATED.exec(lines[i])
    if (m) {
      lines[i] = `${m[1] ?? ''}${m[2]}${stamp}${m[4] ?? ''}`
      return lines.join('\n')
    }
  }
  return text
}

/**
 * 读取 agentmd 主文档。
 * @param {string} dir - agentmd 目录绝对路径。
 * @param {string} [file] - 相对文件名，默认 main.md。
 * @returns {Promise<{ ok: true, text: string, path: string } | { ok: false, reason: string, path?: string }>}
 *   成功返回全文；失败返回可读原因（不抛错）。
 */
export async function readDoc(dir, file = 'main.md') {
  if (typeof dir !== 'string' || dir.trim() === '') {
    return { ok: false, reason: 'agentmdDir 未配置' }
  }
  if (typeof file !== 'string' || file.trim() === '') {
    return { ok: false, reason: 'agentmdMainFile 为空' }
  }
  const path = join(dir.trim(), file.trim())
  try {
    await access(path, FS.R_OK)
  } catch {
    return { ok: false, reason: `文件不存在或不可读: ${path}`, path }
  }
  try {
    return { ok: true, text: await readFile(path, 'utf8'), path }
  } catch (err) {
    return { ok: false, reason: `读取失败: ${err?.message ?? err}`, path }
  }
}

/**
 * 在文档行数组的插点插入两行式增量。
 * 返回 [前半段, 新行, 后半段]，交给 append 式写入使用；
 * 这里导出为纯函数便于单测，真正的写入由 {@link appendLogEntry} 串行化。
 * @param {string[]} lines - 原文行数组（编辑器视角的浅拷贝即可）。
 * @param {number} insertAt - 插入位置（新行占用该下标）。
 * @param {string} row - 要插入的表格行。
 * @returns {string[]} 新的行数组。
 */
export function spliceRow(lines, insertAt, row) {
  const out = lines.slice()
  out.splice(insertAt, 0, row)
  return out
}

/** 进程内串行队列：保证同一进程里对同一文件的读改写不会互相踩。 */
let queue = Promise.resolve()

/**
 * 把一条日志追加到 `<dir>/<file>` 的操作日志表格末尾，并刷新「最后更新：」。
 *
 * 同一个进程内对同一文件的调用会串行执行（模块级 promise 链），
 * 因此并发触发（例如多个 agent 同时转 idle）不会破坏表格。
 *
 * @param {{ dir: string, file?: string, action: string, result: string, when?: Date, maxRowChars?: number, log?: (msg: string) => void }} options
 *   dir 为 agentmd 目录；when 默认当前时间；maxRowChars 为单行长度上限；log 为可选日志回调。
 * @returns {Promise<{ ok: boolean, path?: string, reason?: string, row?: string }>}
 *   结果为 `{ ok: false, reason }` 时代表按设计容错跳过，调用方不应抛出。
 */
export function appendLogEntry(options) {
  const run = () => appendLogEntryNow(options)
  // 无论上一步成功失败都继续排队；失败已被内部吞掉。
  const next = queue.then(run, run)
  queue = next.then(() => undefined, () => undefined)
  return next
}

/** {@link appendLogEntry} 的实际实现，永远不抛错。 */
async function appendLogEntryNow({ dir, file = 'main.md', action, result, when = new Date(), maxRowChars, log }) {
  const note = typeof log === 'function' ? log : () => {}
  if (typeof dir !== 'string' || dir.trim() === '') {
    note('agentmdDir 未配置，跳过日志追加')
    return { ok: false, reason: 'agentmdDir 未配置' }
  }

  let target
  try {
    await mkdir(dir.trim(), { recursive: true })
    target = join(dir.trim(), file.trim() === '' ? 'main.md' : file.trim())
  } catch (err) {
    note(`agentmd 目录准备失败: ${err?.message ?? err}`)
    return { ok: false, reason: `目录准备失败: ${err?.message ?? err}` }
  }

  let text
  try {
    text = await readFile(target, 'utf8')
  } catch (err) {
    note(`agentmd 主文档读取失败（跳过）: ${err?.message ?? err}`)
    return { ok: false, reason: `读取失败: ${err?.message ?? err}`, path: target }
  }

  const lines = text.split('\n')
  const spot = locateLogTable(lines)
  if (spot === null) {
    note(`未在 ${target} 找到「四、操作日志」表头，跳过追加`)
    return { ok: false, reason: '未找到操作日志表头', path: target }
  }

  const row = buildLogRow({ when, action, result, maxChars: maxRowChars })
  const updated = bumpLastUpdated(text, formatDate(when))

  // 优先走「纯追加」快路径：插点正好在文件末尾（允许后面只有空行）时，
  // 只 appendFile 追加，不再重写整个文档，避免与外部编辑器抢文件。
  const updatedLines = updated.split('\n')
  const tail = updatedLines.slice(spot.insertAt)
  const tailIsEmpty = tail.every((line) => line.trim() === '')

  try {
    if (tailIsEmpty) {
      const prefix = spot.insertAt === 0 ? '' : ''
      await appendFile(target, `${prefix}${row}\n`, 'utf8')
    } else {
      const rebuilt = spliceRow(updatedLines, spot.insertAt, row).join('\n')
      await writeFile(target, rebuilt, 'utf8')
    }
  } catch (err) {
    note(`agentmd 日志写入失败: ${err?.message ?? err}`)
    return { ok: false, reason: `写入失败: ${err?.message ?? err}`, path: target }
  }

  note(`已追加操作日志: ${row}`)
  return { ok: true, path: target, row }
}

/**
 * 仅用于测试：等待串行队列清空。
 * @returns {Promise<void>} 队列排空后 resolve。
 */
export function _drainQueue() {
  return queue.then(() => undefined, () => undefined)
}
