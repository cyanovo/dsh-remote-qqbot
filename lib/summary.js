/**
 * 从 DSH 会话日志（以及可选的 agent 对象）里提取「本轮摘要」。
 *
 * 这些函数刻意写得极度防御：DSH 的 Session/事件结构会随版本演进，
 * 任何字段缺失都必须退化成空串而不是抛错——摘要失败绝不能影响主流程。
 */

/** 一条 user/message 事件里，来自真人输入（而非 agent.inject 注入）的 source 形状。 */
function isHumanSource(source) {
  if (source === undefined || source === null) return true
  const kind = typeof source === 'object' ? source.kind : source
  if (kind === undefined) return true
  return kind === 'user'
}

/**
 * 把 ContentBlock[] 里可读的文字拼出来。
 * @param {unknown} content - 消息的 content 字段，通常为 ContentBlock[]。
 * @returns {string} 拼接后的纯文本（可能为空串）。
 */
export function blocksToText(content) {
  try {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (block === null || typeof block !== 'object') continue
      // 只取模型/用户可见的 text；reasoning 是思考，不算回复正文。
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    // ⚠️⚠️ **必须保住换行** —— 这里曾经是 `parts.join(' ').replace(/\s+/g,' ')`，
    //      也就是把包括换行在内的所有空白塌成一个空格。
    //      后果：上传到服务器的「完整回答」从源头起就不是 markdown 了 ——
    //      标题、段落、列表、表格全部糊成一整行（实测：`hhfwa.md` 第 12 行是**单行 1290 字符**，
    //      里面塞了 5 个 `##` 标题和两张表格），渲染器那边**无法真正复原**
    //      （标题与正文的边界在被压平后只剩一个空格，理论上不可恢复）。
    //
    //      现在只做三件不破坏结构的事：
    //        1. 统一换行符（CRLF/CR → LF）
    //        2. 行内的连续空格/制表符合成一个，并去掉每行首尾空白
    //        3. 三段以上连续空行压成一段空行（段落边界保留）
    //
    //      需要「单行摘要」的调用方自己压平（`composeSummary` / `composeChatSummary` 都做了），
    //      所以这里保结构不会影响 QQ 通知的排版。
    return parts
      .join('\n\n')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return ''
  }
}

/**
 * 按关键字段深搜一棵对象树，找出第一段可读文本。
 * 仅在结构化取值失败时兜底使用，深度与节点数都有上限，避免拖慢主流程。
 * @param {unknown} root - 待搜索的根对象。
 * @param {number} [maxDepth] - 最大递归深度。
 * @returns {string} 找到的文本，或空串。
 */
function deepFindText(root, maxDepth = 5) {
  const seen = new Set()
  const stack = [[root, 0]]
  let visited = 0
  while (stack.length > 0 && visited < 400) {
    const [node, depth] = stack.pop()
    visited += 1
    if (node === null || node === undefined) continue
    if (typeof node === 'string') {
      if (node.length > 0) return node
      continue
    }
    if (typeof node !== 'object') continue
    if (seen.has(node)) continue
    seen.add(node)
    if (depth >= maxDepth) continue
    for (const key of ['text', 'content', 'message', 'messages', 'data', 'value', 'blocks', 'parts']) {
      if (key in node) stack.push([node[key], depth + 1])
    }
  }
  return ''
}

/**
 * 从会话里取出本轮的用户消息文本与助手最终回复文本。
 *
 * 主路径：读 `session.events` / `session.log` 里的 `user/message` 与
 * `assistant/message` 事件。备路径：从 agent 对象上深搜 content/message。
 *
 * ⚠️ 两者**按同一轮配对**：`assistantText` 只取「本轮那条真人 user/message 之后」的回复。
 * 本轮没产出回复（被打断 / 取消 / 只调工具）时 `assistantText` 为空串 —— 调用方据此
 * 判断"这一轮没有可报的结果"，而不是退回去用上一轮的回复顶上。
 *
 * @param {object} agent - DSH Agent（可缺省，缺省时退化为空摘要）。
 * @returns {{ userText: string, assistantText: string, source: string }} 提取结果与来源说明。
 */
export function extractTurnSummary(agent) {
  const session = agent?.session
  let userText = ''
  let assistantText = ''

  try {
    const events = Array.isArray(session?.events)
      ? session.events
      : Array.isArray(session?.log) ? session.log : []

    // 🔴 **助手回复必须与「本轮用户消息」配对，不能只取"最新那条"。**
    //
    //    2026-10-07 主人实测事故：发新消息把正在跑的一轮打断时，会话事件的末尾是
    //      [ …, 上一轮的 assistant/message, 本轮新来的 user/message ]
    //    —— 本轮**根本没有** assistant/message。原实现倒着扫、各自取"第一条找到的"，
    //    于是配出「本轮问题 → 上一轮回复」，而且上一轮回复一直不变 ⇒ 每打断一次就
    //    把同一段旧文字再推一次。主人因此连续收到三条一模一样、且与当轮问题毫无关系的信息。
    //
    //    修法：两个事件都记下标，最后校验「回复必须晚于本轮用户消息」。
    //    回复更早 ⇒ 那是上一轮的，本轮没有产出，assistantText 置空由调用方决定怎么办。
    //
    // ⚠️ 用下标而不是「assistantText === ''」当"还没找到"的判据：后者遇到一条
    //    正文为空的 assistant/message（只调工具、没说话）会继续往前捞，同样张冠李戴。
    let userIdx = -1
    let assistantIdx = -1
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (ev === null || typeof ev !== 'object') continue
      const data = ev.data ?? ev
      if (ev.type === 'assistant/message' && assistantIdx === -1) {
        assistantIdx = i
        assistantText = blocksToText(data?.message?.content ?? data?.content)
      } else if (ev.type === 'user/message' && userIdx === -1) {
        // 跳过 agent.inject() 的插件注入，只要真人输入。
        if (isHumanSource(data?.source ?? data?.message?.source)) {
          userIdx = i
          userText = blocksToText(data?.content ?? data?.message?.content)
        }
      }
      if (userIdx !== -1 && assistantIdx !== -1) break
    }

    // 回复比本轮用户消息还早 ⇒ 属于上一轮：本轮没有产出，别拿它冒充本轮结果。
    if (userIdx !== -1 && assistantIdx !== -1 && assistantIdx < userIdx) {
      assistantIdx = -1
      assistantText = ''
    }
  } catch {
    /* 结构化读取失败 → 走兜底 */
  }

  let source = 'session.events'
  if (userText === '' && assistantText === '') {
    source = 'fallback:deep'
    try {
      userText = deepFindText(agent?.lastUserMessage ?? agent?.pendingMessage)
      assistantText = deepFindText(agent?.lastAssistantMessage ?? agent?.lastMessage ?? agent?.message)
    } catch {
      /* 兜底也失败就接受空摘要 */
    }
  }

  return { userText, assistantText, source }
}

/**
 * 把本轮摘要拼成一句话，并裁到指定长度（超出加省略号）。
 *
 * 只有用户消息时，单条就足以说明「本轮做了什么」；
 * 同时有回复时拼成 `用户消息 → 最终回复`，让日志表一眼能看懂。
 *
 * @param {{ userText: string, assistantText: string }} parts - {@link extractTurnSummary} 的结果。
 * @param {number} maxChars - 最大字符数（按码点计，中文一字算一个）。
 * @returns {string} 可直接写进表格「操作」列的文本。
 */
export function composeSummary(parts, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 200
  const clean = (s) => String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const user = clean(parts?.userText)
  const assistant = clean(parts?.assistantText)

  let text
  if (user !== '' && assistant !== '') text = `${user} → ${assistant}`
  else if (user !== '') text = user
  else if (assistant !== '') text = assistant
  else return '（本轮无可用摘要）'

  const chars = [...text]
  return chars.length <= limit ? text : `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`
}

/**
 * 给「人看的通知」用的摘要 —— 偏口语、偏结果，而不是日志表里的 `A → B`。
 *
 * 与 {@link composeSummary} 的三点区别：
 *   1. 优先用**助手的最终回复**（那才是"这次做完了什么"）；没有才退回用户消息。
 *      日志表需要 `用户说了什么 → 结果是什么` 才能一眼对上，通知里则只需要结果。
 *   2. 清掉 markdown 记号（代码围栏、行内 code、标题 #、粗体 **、列表符号、链接）。
 *      通知是纯文本，`## 进展` 这种满是符号的正文读起来很刺眼。
 *   3. 把换行压成一行 —— QQ/通知栏里多行文本容易被折叠。
 *
 * @param {{ userText: string, assistantText: string }} parts - {@link extractTurnSummary} 的结果。
 * @param {number} maxChars - 最大字符数（按码点计，中文一字算一个）。
 * @returns {string} 单行摘要；没有可用内容时返回空串（调用方负责省略这一段）。
 */
export function composeChatSummary(parts, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 150
  const clean = (s) => String(s ?? '')
    .replace(/```[\s\S]*?```/g, ' ')            // 整段代码块直接去掉
    .replace(/`([^`]*)`/g, '$1')                // 行内 code 去反引号
    // markdown 表格的分隔行（| --- | --- |）整行丢掉，否则会变成一堆 `| --- |`。
    // ⚠️ **半角 `|` 与全角 `｜`（U+FF5C）都要算** —— 模型在中文表格里常输出全角竖线，
    //    只处理半角会漏掉一大半（实测踩过：日志里 4 个半角、14 个全角）。
    .replace(/^[ \t]*[|｜]?[ \t:：|｜-]+[|｜][ \t:：|｜-]*$/gm, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')       // 行首标题记号
    .replace(/[ \t]#{1,6}[ \t]+/g, ' ')         // 标题记号在行中时的残留（如「。 ## 进展」）
    .replace(/\*\*([^*]+)\*\*/g, '$1')          // 粗体
    .replace(/^[ \t]*>+[ \t]*/gm, '')           // 引用记号
    .replace(/(^|\s)[-*+][ \t]+/g, '$1')        // 列表符号（保留分隔用的空白）
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // 链接只留文字
    .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, ' ')  // 水平分割线
    .replace(/[|｜]/g, ' ')                     // 表格竖线：留下单元格文字，去掉框线
    // 兜底：换行若在上游已被压平，分隔行就不在行首，上面那条锚定规则会漏。
    // ⚠️ 必须放在「竖线 → 空格」**之后**：`｜---｜---｜` 里连字符前面是竖线而不是空白，
    //    先跑这步的话 `(^|\s)` 匹配不到（实测踩过）。
    // 只吃「独立成词的 3 个以上连字符」，不会误伤 `2026-10-02` 这种单连字符。
    .replace(/(^|\s)-{3,}(?=\s|$)/g, '$1')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const assistant = clean(parts?.assistantText)
  const user = clean(parts?.userText)
  const text = assistant !== '' ? assistant : user
  if (text === '') return ''

  const chars = [...text]
  return chars.length <= limit ? text : `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`
}

/**
 * 整理「闲聊回答」正文 —— 直接发到 QQ 聊天框的那份。
 *
 * 与 {@link composeChatSummary} 的区别（**这是刻意的**）：
 *   - `composeChatSummary` 是**通知里的摘要**：必须压成一行、清掉所有 markdown 记号
 *     （通知栏会把多行折叠，符号很刺眼）。
 *   - 本函数是**回答本身**：主人要的是"回答"，所以**换行、列表、代码块全部保留**，
 *     只做三件最低限度的清理：去掉笔记页脚、折叠 3 行以上空白、超长截断。
 *
 * ⚠️ 不要往这里加「压平换行」——那正是完整回答网页被毁掉的根因（见 blocksToText）。
 *
 * @param {{ userText: string, assistantText: string }} parts - {@link extractTurnSummary} 的结果。
 * @param {number} maxChars - 最大字符数（按码点计，中文一字算一个）。
 * @returns {string} 可直接发送的正文；没有可用内容时返回空串。
 */
export function composeChatAnswer(parts, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 1500
  let text = String(parts?.assistantText ?? '').trim()
  if (text === '') text = String(parts?.userText ?? '').trim()
  if (text === '') return ''

  text = text
    // 笔记末尾那行 `<sub>时间 · 会话</sub>` 是给网页看的，发到聊天框里是噪音。
    .replace(/\n*<sub>[\s\S]*?<\/sub>\s*$/i, '')
    // 三段以上连续空行压成一段（保留一段空行让段落可读，但不留下大空洞）。
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()

  const chars = [...text]
  return chars.length <= limit ? text : `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`
}

/**
 * 由摘要推断一个简短「结果」列文本。
 * @param {object} agent - DSH Agent，用于读取状态。
 * @param {boolean} hadError - 本轮是否出现过 agent/error。
 * @param {boolean} [hasReply] - 本轮是否真的产出了助手回复（见 {@link extractTurnSummary}）。
 *   只看到用户消息、没有回复 ⇒ 这一轮是**中断**而不是完成，不能记成「完成」。
 *   出错仍然优先（错因比"没回复"更有信息量）。
 * @returns {string} 结果列文本。
 */
export function inferResult(agent, hadError, hasReply = true) {
  if (hadError) return '出错（详见日志）'
  return hasReply ? '完成' : '已中断（无回复）'
}
