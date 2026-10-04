/**
 * QQ 机器人运行时 —— 把 qqbot.js / qqbridge.js 和 DSH 插件生命周期接起来。
 *
 * 对外只暴露 4 个方法，index.js 里的改动因此可以很小：
 *   - `notify({kind, summary, project})` 事件推送（接到原有 push() 漏斗上）
 *   - `wrapUserQuestions(ctx)`          把 agent 的提问也中继到 QQ
 *   - `ensureStarted()`                 惰性启动
 *   - `stop()`                          卸载时清理
 *
 * 三个"必须知道"的设计约束：
 *
 * 1. **不抢 userQuestions 的 provider。**
 *    该服务的 provider 全局只能有一个（重复注册抛 DUPLICATE_PROVIDER），
 *    桌面 UI 已经占住了。所以这里**包装 `ask()`**：问题**先发到 QQ**，
 *    只有发不出去、或 QQ 那边迟迟没答（`ASK_DESKTOP_FALLBACK_MS`），
 *    才把桌面提问接上来兜底（见 `relayAsk`）。QQ 那条路**永不 reject**，
 *    否则会把桌面 UI 一起拖崩。
 *
 * 2. **反向链路不依赖任何穿透。**
 *    插件就跑在 DSH 进程里，注入会话直接打 `127.0.0.1:19387/api`（HMAC cookie）。
 *    QQ 侧是纯出站 WebSocket。全程不需要 frp / 公网 IP / 回调地址。
 *
 * 3. **open_id 只能被动学到。**
 *    官方不提供"按 QQ 号查 open_id"的接口，必须等用户先给机器人发一条消息。
 *    所以首次使用前你要先在 QQ 里跟机器人说句话（发 /help 即可）。
 */

import os from 'node:os'
import path from 'node:path'

import { QqBotClient } from './qqbot.js'
import {
  BotState, DshLocalApi, HELP_TEXT, PICKER_DEFAULT_COUNT, buildAnswers, extractRefIdx,
  formatNotification, formatPickAck, formatQuestion, formatSessionPickerText,
  formatStatusText, isPickerFresh, pickPromptMode, readDshSecret,
  healBrowserSessionRecord, readBrowserSessionSecret,
  routeMessage, summarizeSession,
} from './qqbridge.js'
import { planQqFulltext } from './fulltext.js'
import { captureScreen } from './screenshot.js'

/** 已推送过的问题最多等这么久，超时后不再占用"待回答"槽位。 */
const ASK_TTL_MS = 30 * 60 * 1000

/**
 * 「问题已经发到 QQ，但还没人回」时，等多久才**也**把提问显示到 DSH 界面里兜底。
 *
 * 为什么必须有兜底：桌面那张提问卡片由 api-proxy 自己持有（`pendingQuestions`），
 * 插件这边 resolve 掉 `ask()` 只能让 agent 继续跑，**清不掉那张卡片**。
 * 所以正常路径是「问题发到 QQ → 在 QQ 里作答」→ 桌面上从头到尾没有卡片，
 * 自然不会有残留；只有 QQ 这条线没人搭理时，才把卡片显示出来交给桌面自己管。
 */
const ASK_DESKTOP_FALLBACK_MS = 90 * 1000

/** 闲聊回答的默认最大长度（按码点）。QQ 单条消息有长度上限，留足余量。 */
const CHAT_ANSWER_MAX = 1500

/** 按码点截断；超长补省略号。空串原样返回。 */
function clampText(text, maxChars) {
  const s = String(text ?? '').trim()
  if (s === '') return ''
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : CHAT_ANSWER_MAX
  const chars = [...s]
  return chars.length <= limit ? s : `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`
}

export function createQqRuntime({
  liveConfig,
  log,
  projectOf = () => 'DSH',
  sessionTitleOf = () => '',
  /**
   * 往「闲聊会话」投递消息**之前**调用一次，参数是会话 id。
   *
   * 用途：把闲聊会话按成只读沙箱（主人要求"闲聊不许有任何操作能力"）。
   * 放在这里而不是创建会话时，是因为沙箱模式是**会话级事件**，必须拿到真实
   * Session 对象才能设置；而"即将投递"这一刻必然已经能拿到。
   * 调用失败只记日志，绝不阻断投递 —— 闲聊的可达性比"只读"更重要。
   */
  beforeChatPrompt = null,
}) {
  let bot = null
  let api = null
  let state = null
  let started = false
  let lastStartError = null
  /** 注入通道不可用的**硬原因**（读不到密钥、补写失败…）；空串表示没问题。 */
  let apiReason = ''
  /** 已经做过的补救动作，会附在报错文案与 /status 后面（例如"补回了签名记录，重启后生效"）。 */
  let apiNote = ''

  /** askId -> { questions, sessionId, resolve, createdAt }，按加入顺序即最早优先。 */
  const pendingAsks = new Map()

  const l = (m) => log(`[QQ] ${m}`)

  function homeDir() {
    try { return os.homedir() } catch { return process.env.USERPROFILE ?? '.' }
  }

  function stateFile(cfg) {
    const p = (cfg.qqStateFile ?? '').trim()
    if (p) return p
    return path.join(homeDir(), '.dsh', 'qq-bot-state.json')
  }

  function ensureState(cfg) {
    const want = stateFile(cfg)
    if (state && state.file === want) return state
    state = new BotState(want)
    return state
  }

  /**
   * 读本机 DSH 的会话签名密钥。
   *
   * 两条路都试：先按老写法（`browser-session.secret:` / `client-connection:` 嵌套），
   * 再按新版凭据文档（`records:` 里的 `client-connection/browser-session:`）。
   * 谁认出来算谁的；都认不出来就把**原因**带回去，别吞掉。
   */
  function readSecret(home) {
    try {
      const old = readDshSecret(home)
      if (old) return { secret: old, reason: '' }
    } catch { /* 老写法没有 → 看新版 */ }
    return readBrowserSessionSecret(home)
  }

  /**
   * 惰性拿到本机 DSH 接口。**每次要用的时候都会重试**，不再一次失败就永久放弃。
   *
   * 2026-10-04 真事故：桌面端把 `client-connection/browser-session` 从
   * `~/.dsh/.credentials.yaml` 里拿掉了（它进程内还留着旧 secret，所以桌面端自己
   * 一切正常），插件启动时读不到 → `api = null` 且**再没有第二次机会** →
   * 「引用消息没办法回答」。出站推送不需要这个密钥，所以通知照常发 —— 故障只在入站，
   * 这就是它藏得深的原因。
   *
   * 现在三件事一起做：
   *   1. 每次要用就重读密钥：桌面端一旦重建记录，插件自动恢复，不必重启插件；
   *   2. 记录**完全不存在**时自己补一条（形状照抄桌面端 storedSecret() 的校验），
   *      这样桌面端下次启动/激活会加载它，两边密钥就对上了；
   *   3. 补过之后把"重启一次桌面版"写进报错文案与 /status，绝不静默。
   */
  function ensureApi(cfg) {
    if (api) return api
    const c = cfg ?? liveConfig()
    let secret = String(c.dshSecret ?? '').trim()
    if (!secret) {
      const got = readSecret(homeDir())
      secret = got.secret
      if (!secret) {
        try {
          const healed = healBrowserSessionRecord(homeDir())
          secret = healed.secret
          apiNote = `已经把桌面版缺失的会话签名记录补回去了${healed.backup ? `（原文件备份在 ${healed.backup}）` : ''}，重启一次 DSH 桌面版即可恢复`
          l(`会话签名记录缺失（${got.reason}）→ ${apiNote}`)
        } catch (err) {
          apiReason = `读不到会话密钥（${got.reason}），补写也失败：${err?.message ?? err}`
          if (lastStartError !== 'no-secret') {
            lastStartError = 'no-secret'
            l(`会话密钥不可用，注入通道关闭：${apiReason}`)
          }
          return null
        }
      }
    }
    api = new DshLocalApi({
      baseUrl: c.dshApiUrl || 'http://127.0.0.1:19387',
      authority: c.dshApiAuthority || '127.0.0.1:19387',
      secret,
      timeoutMs: c.timeoutMs || 20000,
    })
    apiReason = ''
    return api
  }

  /** 注入失败时给用户看的原因：先说硬原因，再说已经做过的补救。 */
  function injectHint() {
    return apiReason || apiNote
  }

  /** 惰性启动：配置齐全才建连接，缺任何一项都只记一次日志。 */
  async function ensureStarted() {
    const cfg = liveConfig()
    if (!cfg.qqEnabled) return false
    if (started) return true
    if (!cfg.qqAppId || !cfg.qqClientSecret) {
      if (lastStartError !== 'missing-cred') {
        lastStartError = 'missing-cred'
        l('已启用但缺少 qqAppId / qqClientSecret，QQ 通道未启动')
      }
      return false
    }

    ensureState(cfg)
    // 拿不到密钥**不阻断** QQ 长连接：通知照发，只有注入不可用（原因记在 apiReason）。
    ensureApi(cfg)

    bot = new QqBotClient({
      appId: cfg.qqAppId,
      clientSecret: cfg.qqClientSecret,
      onEvent: (name, data) => { void onEvent(name, data) },
      log: (level, msg) => l(`${level === 'error' ? '❌ ' : ''}${msg}`),
    })

    // 把 lastSeq 恢复回去，断线重连才能补发遗漏事件
    bot._lastSeq = state?.data?.lastSeq ?? null
    bot.start()
    started = true
    lastStartError = null
    l(`已启动（AppID ${String(cfg.qqAppId).slice(0, 6)}…）`)
    if (!state?.data?.openId) {
      l('还不知道你的 open_id —— 请先在 QQ 里给机器人发一条消息（发 /help 即可）')
    }
    return true
  }

  // ── 出站：事件 → QQ ──────────────────────────────────────────────────────

  /** 由 index.js 的 push() 调用。任何失败都只记日志，不影响 agent。 */
  async function notify({ kind, summary, project, session, sessionId }) {
    const cfg = liveConfig()
    if (!cfg.qqEnabled) return
    // 远程提醒总开关（DSH 输入框下方那个）：关掉时不推送，但**不**断开长连接 ——
    // 你在 QQ 里引用旧通知继续对话、或发 /task 派活，依然照常工作。
    if (cfg.qqNotifyEnabled === false) return
    if (!(await ensureStarted())) return

    ensureState(cfg)
    const openId = state.data.openId
    if (!openId) return // 还没学到 open_id，主动消息无从发起

    const text = formatNotification({ kind, summary, project, session })
    try {
      // markdown 模式：推送里那个 `[👉 查看完整回答](链接)` 才会折叠成一句话。
      // 传 false（或内容过长）时就是普通文本消息，长 URL 会整个显示出来。
      const res = await bot.sendC2C(openId, text, { markdown: cfg.qqMarkdown === true })
      // ⚠️ 关键：记下这条通知的 ref_idx。
      // 你「引用这条消息」回复时，事件里带的是同一个索引 —— 靠它反查会话。
      const refIdx = res?.ext_info?.ref_idx
      state.addSentRef(refIdx, { sessionId, session, kind })
      // 兜底时间线：万一 ref_idx 拿不到（老状态文件 / 异常响应 / 消息被撤），
      // 引用反查还能落到"最近这条通知"上，而不是把你的提问整条丢掉。
      // 见 BotState.recentTarget 的注释。
      state.noteRecent({ sessionId, session, kind, refIdx: refIdx ?? '' })
      l(`已推送到 QQ：${kind}${session ? `（${session}）` : ''}`
        + (refIdx ? '' : '（⚠️ 响应里没带 ref_idx，引用回复将走兜底路由）'))
    } catch (err) {
      const hint = QqBotClient.explainError(err.code)
      l(`推送失败（${kind}）：${err.message}${hint ? ` —— ${hint}` : ''}`)
    }
  }

  // ── 入站：QQ → DSH ───────────────────────────────────────────────────────

  function oldestPending() {
    const now = Date.now()
    for (const [askId, item] of pendingAsks) {
      if (now - item.createdAt > ASK_TTL_MS) { pendingAsks.delete(askId); continue }
      return { askId, ...item }
    }
    return null
  }

  /**
   * 把「闲聊会话」的回答正文**直接**发到 QQ 聊天框。
   *
   * 与 {@link notify} 的区别（这正是主人这轮要的）：
   *   - `notify` 发的是**通知卡片**：`formatNotification` 会套上 ✅/会话名/摘要，
   *     正文里还会附一条「查看完整回答」的链接；
   *   - 本函数发的**就是回答本身**：不套模板、不加链接、不存笔记、不推中枢。
   *     主人在 QQ 里问一句，机器人就在聊天框里答一句。
   *
   * 发送成功后照样登记 `ref_idx` —— 这样主人**引用这条回答**继续追问时，
   * `routeMessage` 能顺着反查回到同一个闲聊会话，上下文不断。
   */
  async function sendChatAnswer({ text, sessionId = '', session = '', maxChars }) {
    const cfg = liveConfig()
    if (cfg.qqEnabled !== true) return false
    if (cfg.qqNotifyEnabled === false) return false
    const body = clampText(text, maxChars)
    if (body === '') return false
    if (!(await ensureStarted())) return false

    ensureState(cfg)
    const openId = state.data.openId
    if (!openId) {
      l('还没有你的 open_id，闲聊回答发不出去（请先在 QQ 里给机器人发一条消息）')
      return false
    }
    try {
      // `markdown: false` 是**刻意**的：回答正文不可控，一旦模型输出了平台不喜欢的内容，
      // markdown 模式整条消息会发送失败；纯文本一定能送达，也不会把换行吃掉。
      const res = await bot.sendC2C(openId, body, { markdown: false })
      const refIdx = res?.ext_info?.ref_idx
      state.addSentRef(refIdx, { sessionId, session, kind: 'chat-answer' })
      state.noteRecent({ sessionId, session, kind: 'chat-answer', refIdx: refIdx ?? '' })
      l(`已把闲聊回答发到 QQ（${[...body].length} 字）`)
      return true
    } catch (err) {
      const hint = QqBotClient.explainError(err.code)
      l(`闲聊回答发送失败：${err.message}${hint ? ` —— ${hint}` : ''}`)
      return false
    }
  }

  /**
   * 把「完整回答」**切成若干条纯文本消息**直接发到 QQ 聊天框（模式 `chat`）。
   *
   * 这是三档全文模式里的第一档，也是**默认档**：回答不落服务器、不产生任何链接，
   * 内容只存在于你我这一条聊天记录里。
   *
   * 为什么要切：QQ 单条消息有长度上限，超长整条会**发送失败**（不是被截断）。
   * 切分规则与标记由 `fulltext.js` 的 `planQqFulltext` 决定（段落 → 行 → 硬切，
   * 且保证不丢字符），这里只负责逐条发出。
   *
   * 与 {@link sendChatAnswer} 的区别：那条是「一轮一条、超长直接截断」，
   * 用在闲聊会话（主人就在 QQ 里等着一句答复）；这条是「完整回答一条不落地发完」，
   * 用在正式会话的 turn-complete。
   *
   * 永不 reject —— 发送失败只记日志并返回已发条数，绝不能因为 QQ 抽风把推送链路拖崩。
   */
  async function sendQqFulltext({ text, sessionId = '', session = '', maxChars }) {
    const cfg = liveConfig()
    if (cfg.qqEnabled !== true) return { sent: 0, total: 0, reason: 'qq-disabled' }
    if (cfg.qqNotifyEnabled === false) return { sent: 0, total: 0, reason: 'notify-disabled' }

    const plan = planQqFulltext(text, { maxChars })
    if (plan.total === 0) return { sent: 0, total: 0, reason: 'empty' }
    if (!(await ensureStarted())) return { sent: 0, total: plan.total, reason: 'not-started' }

    ensureState(cfg)
    const openId = state.data.openId
    if (!openId) {
      l('还没有你的 open_id，完整回答发不出去（请先在 QQ 里给机器人发一条消息）')
      return { sent: 0, total: plan.total, reason: 'no-openid' }
    }

    let sent = 0
    for (const chunk of plan.chunks) {
      try {
        // `markdown: false`：完整回答的内容不可控，纯文本一定能送达，也不会吃掉换行。
        const res = await bot.sendC2C(openId, chunk, { markdown: false })
        const refIdx = res?.ext_info?.ref_idx
        state.addSentRef(refIdx, { sessionId, session, kind: 'fulltext' })
        state.noteRecent({ sessionId, session, kind: 'fulltext', refIdx: refIdx ?? '' })
        sent += 1
      } catch (err) {
        const hint = QqBotClient.explainError(err.code)
        l(`完整回答第 ${sent + 1}/${plan.total} 条发送失败：${err.message}${hint ? ` —— ${hint}` : ''}`)
        break
      }
    }
    if (sent === plan.total) {
      l(`完整回答已发到 QQ：${sent} 条（共 ${plan.chars} 字，未上传服务器）`)
    } else {
      l(`完整回答只发出 ${sent}/${plan.total} 条 —— 后面的没发出去`)
    }
    return { sent, total: plan.total, chars: plan.chars }
  }

  async function replyPassive(data, text) {
    const openId = data?.author?.user_openid ?? data?.author?.id
    if (!openId) return
    try {
      await bot.sendC2C(openId, text, { msgId: data.id })
    } catch (err) {
      l(`被动回复失败：${err.message}`)
    }
  }

  /**
   * 给 QQ 发一张**电脑当前的屏幕**。
   *
   * 这是主人要的「远控不方便时，点一下菜单就能看一眼电脑」：
   * QQ 菜单里的「屏幕」= 把 `/screen` 填进输入框 → 用户按发送 → 走到这里。
   *
   * 三步走，任何一步失败都**明确回一句话**，绝不静默：
   *   1. `captureScreen()` 抓屏 + 压成 JPEG（临时文件用完即删）；
   *   2. `bot.uploadC2CFile()` 上传，拿 `file_info`；
   *   3. `bot.sendC2CImage()` 用**被动回复**（带 `msg_id`）发出去。
   *
   * 为什么第 3 步用被动回复而不是主动消息：被动回复有 60 分钟有效期、
   * 且响应里会带 `ext_info.ref_idx`，主人**引用这张图**继续说话时，
   * 路由能认出"这是截图"（见 `routeMessage` 的 `screen_ref` 分支），不会误投进某个会话。
   */
  async function handleScreen(data) {
    const cfg = liveConfig()
    const openId = data?.author?.user_openid ?? data?.author?.id
    if (!openId) return

    if (cfg.qqScreenEnabled === false) {
      await replyPassive(data, '截图功能被我关掉了。想打开：DSH → 设置 → QQ 提醒与记忆 → 把「允许截图」打开。')
      return
    }

    try {
      const shot = await captureScreen({ maxWidth: cfg.qqScreenMaxWidth })
      const up = await bot.uploadC2CFile(openId, shot.buffer.toString('base64'), { fileType: 1 })
      const res = await bot.sendC2CImage(openId, up.file_info, { msgId: data.id, msgSeq: 1 })
      // 登记 ref_idx 但**不带 sessionId** —— 这张图不属于任何会话；
      // 这样才能让"引用截图再说话"落到 screen_ref 分支，而不是被兜底进某个会话。
      state.addSentRef(res?.ext_info?.ref_idx, { kind: 'screen' })
      const kb = Math.max(1, Math.round(shot.bytes / 1024))
      l(`已发截图：${shot.width}x${shot.height}，${kb} KB，抓屏耗时 ${shot.ms} ms`)
    } catch (err) {
      const hint = QqBotClient.explainError(err?.code)
      l(`截图失败：${err?.message ?? err}${hint ? ` —— ${hint}` : ''}`)
      await replyPassive(data, `😵 截图没成功：${err?.message ?? err}${hint ? `\n${hint}` : ''}`)
    }
  }

  async function onEvent(name, data) {
    try {
      if (name === 'C2C_MESSAGE_CREATE') await onC2cMessage(data)
      else if (name === 'FRIEND_ADD') {
        const openId = data?.openid ?? data?.open_id
        if (openId) {
          ensureState(liveConfig())
          state.set({ openId })
          l('你添加了机器人好友，已记住 open_id，现在可以主动推送了')
        }
      }
    } catch (err) {
      l(`处理事件 ${name} 出错：${err?.message ?? err}`)
      // 🔴 最后一道兜底：任何没被上面各路由接住的异常，也必须在 QQ 里说一句。
      // 2026-10-04 的事故里，`chat`/`task` 这两条路会在 handlePrompt 之前抛
      // （拿不到会话密钥时 ensureNamedSession 直接抛），于是**你什么都收不到** ——
      // 「引用消息没办法回答」最难查的形态就是这种静默。
      if (name === 'C2C_MESSAGE_CREATE') {
        try {
          await replyPassive(data, `❌ 你这条消息我没处理成功：${err?.message ?? err}`)
        } catch { /* 连被动回复都发不出去时，只剩日志了 */ }
      }
    }
  }

  async function onC2cMessage(data) {
    const cfg = liveConfig()
    if (cfg.qqEnabled === false) return

    const openId = data?.author?.user_openid ?? data?.author?.id
    if (!openId) return

    ensureState(cfg)
    if (state.data.openId !== openId) {
      state.set({ openId })
      l('已记住你的 open_id，现在可以主动推送了')
    }
    if (bot._lastSeq !== null) state.set({ lastSeq: bot._lastSeq })

    // 官方明确说同一条 msg_id 可能重复推送
    if (state.markSeen(data?.id)) return

    const text = String(data?.content ?? '').trim()
    const pending = oldestPending()
    // 你引用的是哪条消息？—— 引用消息的 message_scene.ext 里有 ref_msg_idx
    const refIdx = extractRefIdx(data)
    // 先按 ref_idx 精确反查；认不出来时退到"最近一条通知"（短时间窗内）。
    // 不兜底的话，这条消息会以 unknown_ref 被**整条丢掉** —— 用户既没进会话、
    // 也看不到任何处理，是最坏的结果。
    const exact = state.refTarget(refIdx)
    const refTarget = exact ?? (refIdx ? state.recentTarget() : null)
    // 刚发过 /sessions 名单吗？在的话，一个纯数字就是在选会话（见 isPickerFresh）。
    const pickerActive = isPickerFresh({ pickerAt: state.data.pickerAt, ids: state.data.pickerIds })
    const route = routeMessage({
      text, refIdx, hasPendingQuestion: Boolean(pending), refTarget, pickerActive,
    })
    l(`收到消息 → ${route.kind}（${route.reason}）${refIdx ? ` ref=${String(refIdx).slice(0, 20)}…` : ''}`
      + (refTarget?.viaFallback ? '（ref_idx 认不出，已按最近一条通知兜底）' : ''))

    switch (route.kind) {
      // 引用了我发的通知 → 回到那条通知对应的会话
      case 'prompt':
        await handlePrompt(route.sessionId, route.session || '那个会话', route.text, data)
        break
      // 显式 /task → 专属会话
      case 'task':
        await handlePrompt(await ensureNamedSession('sessionId', cfg.qqCwd, '专属会话'), '专属会话', route.text, data)
        break
      // 没引用也没提问 → 闲聊会话，或者你 /sessions 指定的那个会话
      case 'chat': {
        const target = await chatTarget()
        await handlePrompt(target.id, target.label, route.text, data)
        // 指定的会话不在了：退回闲聊会话，但必须说一声 —— 静默换会话是最坏的失败方式。
        if (target.fallbackFrom) {
          await replyPassive(data, `（另外说一声：你之前指定的那个会话已经不在了，这句进了闲聊会话。发 /sessions 可以重新挑一个。）`)
        }
        break
      }
      // 列出最近在聊的几个会话 → 你回个数字就切过去
      case 'sessions':
        await handleSessions(data)
        break
      case 'pick_session':
        await handlePickSession(route.index, data)
        break
      case 'answer':
        // 引用提问消息时 route.askId 精确指向那个提问；否则答最早等待的那个。
        await handleAnswer(route.askId, route.text, data)
        break
      case 'status':
        await replyPassive(data, await statusText())
        break
      case 'screen':
        await handleScreen(data)
        break
      case 'help':
        await replyPassive(data, HELP_TEXT)
        break
      case 'no_question':
        await replyPassive(data, '这会儿没有等你回答的问题。引用我某条通知就能接着那个会话说，或者直接发一句，我们随便聊聊。')
        break
      case 'usage':
        await replyPassive(data, route.text)
        break
      case 'unknown':
        await replyPassive(data, `这条指令 /${route.command} 我不认识，发 /help 看看我会些什么`)
        break
      case 'unknown_ref':
        await replyPassive(data, '你引用的这条我认不出是哪次通知了（可能是太久以前、被清理了）。直接发一句话我们闲聊，或者用 /task 派活都行。')
        break
      case 'screen_ref':
        await replyPassive(data, '你引用的是我刚发的那张截图，它不属于任何会话。想派活就用 /task，想聊天直接说一句就行。')
        break
      default:
        break
    }
  }

  /**
   * 取（必要时创建）一个固定会话，并把 id 记在状态文件的 [stateKey] 下。
   *
   * 现在有**两个**固定会话，用途不同：
   *   - `sessionId`     **专属会话**：`/task` 派的活进这里
   *   - `chatSessionId` **闲聊会话**：不带引用发的消息进这里（"跟机器人随便聊聊"）
   * 引用通知回复时**不**用这两个 —— 直接回到那条通知对应的原会话。
   */
  async function ensureNamedSession(stateKey, cwd, label) {
    const cfg = liveConfig()
    ensureState(cfg)
    ensureApi(cfg)
    if (!api) throw new Error(`DSH 会话密钥不可用，无法注入${injectHint() ? `：${injectHint()}` : ''}`)

    const existing = state.data[stateKey]
    if (existing) {
      try {
        if (await api.hasSession(existing)) return existing
        l(`${label} ${existing} 已不存在，重新创建`)
      } catch (err) {
        l(`检查${label}失败，沿用原值：${err.message}`)
        return existing
      }
    }
    const dir = String(cwd ?? '').trim()
      || (() => { try { return process.cwd() } catch { return '.' } })()
    const sid = await api.createSession(dir)
    state.set({ [stateKey]: sid })
    l(`已创建${label} ${sid}（cwd=${dir}）`)
    return sid
  }

  /** 闲聊会话：不带引用的消息都进这里。 */
  function ensureChatSession() {
    return ensureNamedSession('chatSessionId', liveConfig().qqCwd, '闲聊会话')
  }

  async function isRunning(sessionId) {
    try {
      const value = await api.rpc('session/list', { _request: {} })
      const found = (value?.items ?? []).find((s) => s.sessionId === sessionId)
      return found?.running === true
    } catch {
      return false
    }
  }

  // ── 挑一个会话说话（/sessions）────────────────────────────────────────────

  /** 会话列表一次拉几条（设置里的 `qqRecentCount`，默认 6）。 */
  function recentCount() {
    const n = liveConfig().qqRecentCount
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : PICKER_DEFAULT_COUNT
  }

  /**
   * 拉一次会话列表 → `summarizeSession()` 的产物，按最近活动倒序。
   *
   * ⚠️ 列表**从不缓存**：你随时可能在 DSH 里新建/删掉会话，缓存下来只会让你
   * 挑到一个已经不用的东西。菜单那一条是固定的入口，列表每次现拉。
   */
  async function listSessions() {
    const value = await api.rpc('session/list', { _request: {} })
    return (value?.items ?? [])
      .map(summarizeSession)
      // 服务端本来就按 updatedAt 倒序（实测 114 条严格递减），这里再排一次是防御：
      // "最近活动的排最前"是这个列表的语义，不能靠上游的实现细节。
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 会话名（拿不到就回空串；名字只影响文案，不该让主流程失败）。 */
  async function titleOf(sessionId) {
    try {
      const sessions = await listSessions()
      return sessions.find((s) => s.id === sessionId)?.title ?? ''
    } catch {
      return ''
    }
  }

  /**
   * 不引用消息时，这句话该进哪个会话。
   *
   * 默认是闲聊会话；如果你用 /sessions 指定过「当前会话」，就进那一个 ——
   * 这就是「选一次，之后你说的话都进它，直到你再切」。
   *
   * 🔴 指定的会话不在了**不能静默回落**：这里退回闲聊会话，但会把 `fallbackFrom`
   *    带出去，由调用方明说一句。悄悄换个会话 = 你的话进了你不知道的地方。
   */
  async function chatTarget() {
    const cfg = liveConfig()
    ensureState(cfg)
    const active = String(state.data.activeSessionId ?? '').trim()
    if (!active) return { id: await ensureChatSession(), label: '闲聊' }
    try {
      if (await api.hasSession(active)) {
        return { id: active, label: (await titleOf(active)) || active.slice(0, 12) }
      }
      l(`你指定的会话 ${active} 已不存在，回到闲聊会话`)
      state.set({ activeSessionId: null })
      return { id: await ensureChatSession(), label: '闲聊', fallbackFrom: active }
    } catch (err) {
      // 检查失败 ≠ 会话没了。宁可照原样投递（失败会在 handlePrompt 里如实报出），
      // 也不要因为一次网络抖动就把你的选择清掉。
      l(`检查你指定的会话失败，仍按它投递：${err?.message ?? err}`)
      return { id: active, label: active.slice(0, 12) }
    }
  }

  /** `/sessions`：列出最近的 N 个会话，并把名单记进状态（编号要跟显示的一致）。 */
  async function handleSessions(data) {
    const cfg = liveConfig()
    ensureState(cfg)
    ensureApi(cfg)
    if (!api) {
      await replyPassive(data, formatSessionPickerText({ listError: `DSH 接口还没就绪${injectHint() ? `：${injectHint()}` : ''}` }))
      return
    }
    let sessions = []
    let listError = ''
    try {
      sessions = await listSessions()
    } catch (err) {
      listError = err?.message ?? String(err)
      l(`读取会话列表失败：${listError}`)
    }
    if (!listError) {
      // 名单与发榜时刻**必须一起存**：你回「2」时按**你看到的那个编号**解析，
      // 而不是按"此刻的列表"再排一次 —— 中间新建/删除会话会让编号错位。
      state.set({
        pickerAt: Date.now(),
        pickerIds: sessions.slice(0, recentCount()).map((s) => s.id),
      })
    }
    await replyPassive(data, formatSessionPickerText({
      sessions, currentId: state.data.activeSessionId ?? '', count: recentCount(), listError,
    }))
  }

  /**
   * 切到你挑的那个会话（`/use 3`、`/sessions 3`，或发完列表后回一个数字）。
   *
   * @param {number} index - 列表里的编号；**0 = 取消指定**。
   * @param {object} data - 原始事件（用于被动回复）。
   */
  async function handlePickSession(index, data) {
    const cfg = liveConfig()
    ensureState(cfg)
    ensureApi(cfg)
    if (!api) {
      await replyPassive(data, `❌ DSH 接口还没就绪，等一会儿再试${injectHint() ? `（${injectHint()}）` : ''}`)
      return
    }
    if (index === 0) {
      state.set({ activeSessionId: null })
      await replyPassive(data, formatPickAck('cleared'))
      l('已取消指定的会话，回到闲聊会话')
      return
    }

    let ids = Array.isArray(state.data.pickerIds) ? state.data.pickerIds.slice() : []
    // 没看过列表就直接 /use 3（比如刚重启）：现拉一份 —— 这时"当前列表"是唯一
    // 合理的解释，因为根本没有"你看到过的那一份编号"。
    if (ids.length === 0) {
      try {
        const sessions = await listSessions()
        ids = sessions.slice(0, recentCount()).map((s) => s.id)
        state.set({ pickerAt: Date.now(), pickerIds: ids })
      } catch (err) {
        await replyPassive(data, `❌ 会话列表没读出来：${err?.message ?? err}`)
        return
      }
    }

    const target = ids[index - 1]
    if (!target) {
      await replyPassive(data, formatPickAck('out-of-range', { index, count: ids.length }))
      return
    }

    const title = (await titleOf(target)) || target.slice(0, 12)
    let alive = true
    try {
      alive = await api.hasSession(target)
    } catch {
      // 查不了就当作还在：真没了的话，下一条消息会以投递失败如实报出。
      alive = true
    }
    if (!alive) {
      // 🔴 绝不静默回落：你要切到 A、A 却没了，就必须说清楚，而不是悄悄送去闲聊。
      state.set({ activeSessionId: null, pickerIds: [], pickerAt: 0 })
      await replyPassive(data, formatPickAck('gone', { index, title }))
      return
    }

    state.set({ activeSessionId: target })
    await replyPassive(data, formatPickAck('ok', { title }))
    l(`当前会话已切换为 ${target}（${title}）`)
  }

  /**
   * 把一条消息注入指定会话。
   *
   * @param {string} sessionId - 目标会话。
   * @param {string} label - 给人看的来源说明（"main"/"专属会话"/"闲聊"）。
   * @param {string} text - 消息正文。
   * @param {object} data - 原始事件（用于被动回复）。
   */
  async function handlePrompt(sessionId, label, text, data) {
    if (!sessionId) {
      await replyPassive(data, '❌ 我拿不准这句该进哪个会话 —— 用 /task 指明一下，或者直接发一句试试')
      return
    }
    try {
      ensureApi(liveConfig())
      // 拿不到密钥时必须在这里就说清楚 —— 以前会掉到 `api.prompt` 的 TypeError，
      // 用户收到的是一句英文 "Cannot read properties of null"。
      if (!api) throw new Error(`DSH 会话密钥不可用，无法注入${injectHint() ? `：${injectHint()}` : ''}`)
      const running = await isRunning(sessionId)
      // 闲聊会话：投递**之前**先把它按成只读（主人要求"闲聊只能看、不能动手"）。
      // 放在 prompt 之前是关键 —— 沙箱模式是会话事件，必须在这一轮开跑前就写进去，
      // 否则第一轮就带着旧权限跑了。只读本身失败不阻断投递（可读性优先）。
      if (beforeChatPrompt && sessionId === state?.data?.chatSessionId) {
        try {
          beforeChatPrompt(sessionId)
        } catch (err) {
          l(`设定闲聊会话只读失败（不影响投递）：${err?.message ?? err}`)
        }
      }
      // 默认 queue：它在 DSH 里落成 `user` 节点（正常的用户消息气泡），跟你自己
      // 在输入框里打字完全一样。用 steer 会被渲染成「插话」节点 —— 见
      // pickPromptMode 的注释（依据 DSH 源码）。
      const mode = pickPromptMode(running, liveConfig().qqPromptMode)
      await api.prompt(sessionId, text, { mode, timeZone: 'Asia/Shanghai' })
      l(`已注入到 ${sessionId}（${label}，mode=${mode}）`)

      // 不再复述你发的那句话：QQ 聊天记录里上一条就是你自己的原话，再抄一遍纯属噪音
      // （主人明确说不喜欢）。label 保留 —— 同时开多个会话时，它能告诉你这句话进了哪个。
      const how = running
        ? (mode === 'steer' ? '收到，已经插话给正在跑的那轮了' : '收到，排在后面了 —— 这轮跑完就轮到它')
        : '收到，我这就开始'
      await replyPassive(data, `✅ ${how}（${label}）`)
    } catch (err) {
      // 补救动作（"已经补回签名记录，重启一次桌面版"）必须出现在用户看到的那句话里 ——
      // 否则他只知道"送不进去"，不知道下一步该干什么。
      const hint = injectHint()
      const suffix = hint && !String(err?.message ?? '').includes(hint) ? `（${hint}）` : ''
      l(`注入失败：${err.message}${suffix}`)
      await replyPassive(data, `❌ 这句没送进 ${label}：${err.message}${suffix}`)
    }
  }

  /**
   * 找待回答的提问：优先指定的 askId（引用提问消息时带上来的），否则最早的。
   *
   * @param {string|undefined} askId
   * @returns {{askId: string, questions: any[], sessionId?: string, resolve: Function, createdAt: number}|null}
   */
  function findPending(askId) {
    if (askId) {
      const hit = pendingAsks.get(askId)
      if (hit) return { askId, ...hit }
    }
    return oldestPending()
  }

  /**
   * 用 QQ 的回复解决一个待回答的提问。
   *
   * ⚠️ 多个提问并存时**必须按 askId 精确作答**：以前只会答"最早那个"，
   *    在你同时开了两个会话、两边都提问时会答错。
   *
   * @param {string|undefined} askId - 引用提问消息时带上的 askId。
   * @param {string} text - 你的回答原文。
   * @param {object} data - 原始事件（用于被动回复）。
   */
  async function handleAnswer(askId, text, data) {
    const item = findPending(askId)
    if (!item) {
      await replyPassive(data, '这会儿没有在等你回答的问题～')
      return
    }
    const built = buildAnswers(text, item.questions)
    if (!built.ok) {
      await replyPassive(data, `❌ ${built.error}`)
      return
    }
    pendingAsks.delete(item.askId)
    item.resolve({ answers: built.answers })
    l(`已用 QQ 的回答解决了提问 ${item.askId}`)
    // 若提问**已经**显示到了 DSH 界面（QQ 迟迟没人答 → 走了兜底），那张卡片是
    // api-proxy 自己的，插件清不掉 —— 顺手告诉主人怎么把它收起来，别以为是卡住了。
    const tail = item.desktopShown
      ? '\n（另外，DSH 窗口里那张提问卡片已经作废了 —— 点它一下选个选项，或者按取消就能收掉）'
      : ''
    await replyPassive(data, `✅ 收到，已经把你的回答带过去了${tail}`)
  }

  /**
   * QQ `/status`（"看状态"）的正文。
   *
   * 2026-10-02：主人要求**能看到哪些会话正在运行**。以前这里只报两个固定会话，
   * 同时开几个会话时完全看不出机器在忙什么。现在拉一次 `session/list`，
   * 把"在跑的"列出来（`formatStatusText` 是纯函数，排版规则由 `tests/status.test.mjs` 钉住）。
   */
  async function statusText() {
    const cfg = liveConfig()
    ensureState(cfg)
    ensureApi(cfg)
    let sessions = []
    let listError = ''
    if (!api) {
      listError = `DSH 接口尚未就绪${injectHint() ? `：${injectHint()}` : ''}`
    } else {
      try {
        sessions = await listSessions()
      } catch (err) {
        listError = err?.message ?? String(err)
        l(`读取会话列表失败：${listError}`)
      }
    }
    return formatStatusText({
      channelOn: bot?.ready === true,
      pending: pendingAsks.size,
      sessions,
      taskId: state.data.sessionId ?? '',
      chatId: state.data.chatSessionId ?? '',
      activeId: state.data.activeSessionId ?? '',
      listError,
      // 推送（出站）与注入（入站）是两条独立的腿：只报"QQ 连着"会让人以为
      // 引用回复也没问题 —— 2026-10-04 就是这么误诊了半天。
      injectError: api ? '' : (injectHint() || 'DSH 会话密钥不可用'),
      injectNote: api ? apiNote : '',
    })
  }

  // ── 中继提问 ─────────────────────────────────────────────────────────────

  /**
   * 包装 `ctx.userQuestions.ask`，让提问同时出现在桌面和 QQ。
   *
   * ⚠️ 这是**包装**不是**注册 provider**：provider 全局唯一，注册会抛
   *    DUPLICATE_PROVIDER 把桌面 UI 弄坏。
   */
  function wrapUserQuestions(ctx) {
    let svc = null
    try { svc = ctx.get?.('userQuestions') } catch { svc = null }
    // ⚠️ 这里分两种失败，日志必须能区分 —— 2026-10-02 主人报「提问还是不行」，
    //    根因就是这一步静默返回 false 之后**再没有第二次机会**（见 index.js 的补接）。
    //    cordis 的 ctx.get 对"提供者 fiber 还没 active"的服务返回 undefined，
    //    所以「还没就绪」是一个**正常且必然发生**的中间态，不是故障。
    if (!svc) {
      l('userQuestions 服务此刻还没就绪（等它就绪后会由 ctx.inject 补接）')
      return false
    }
    if (typeof svc.ask !== 'function') {
      l(`userQuestions 上没有 ask 方法（实际是 ${typeof svc.ask}），跳过"提问中继到 QQ"`)
      return false
    }
    if (svc.__dshQqWrapped) return true

    const original = svc.ask.bind(svc)
    svc.ask = (request) => {
      const cfg = liveConfig()
      if (!cfg.qqEnabled || !cfg.onQuestion) return original(request)
      return relayAsk(request, original)
    }
    svc.__dshQqWrapped = true
    l('已接上提问中继：以后 agent 的提问会先发到 QQ，桌面只作兜底')
    return true
  }

  /**
   * QQ 优先的提问中继。
   *
   * ⚠️ 为什么不能像 0.7.6 及以前那样 `Promise.race([viaQq, original(request)])`：
   * 桌面那张提问卡片是 api-proxy 自己持有的 `pendingQuestions` 条目，
   * **只有它自己的 `respond()`（浏览器里作答）和 abort 回调**能摘掉条目并广播
   * `question/resolved`（DSH 源码 `packages/host/apiproxy/src/api-proxy.ts` 的 `claimQuestion`）。
   * 插件这边 resolve 掉 `ask()` 的返回值，只能让 agent 继续跑，**清不掉那张卡片** ——
   * 现象就是「QQ 里明明答过了，DSH 窗口里那张提问还一直挂着」（还会被重连的客户端重放一遍）。
   *
   * 现在的策略：**先把问题发到 QQ；发得出去就先不给桌面显示卡片**。
   * 正常路径（在 QQ 里作答）下桌面上从头到尾没有卡片，自然不会有残留。
   * 只有两种情况才把桌面提问接上来（那时卡片由桌面自己管生命周期，同样不会残留）：
   *   ① 问题**没能**发到 QQ（没连上 / 没有 open_id / 发送报错）；
   *   ② 发出去了，但 {@link ASK_DESKTOP_FALLBACK_MS} 内没人答。
   *
   * @param {object} request - `userQuestions.ask` 的原始入参。
   * @param {Function} original - 未包装的桌面提问（绑好 this）。
   */
  function relayAsk(request, original) {
    return new Promise((resolve, reject) => {
      let desktop = null
      let settled = false
      let fallbackTimer = null

      // ★ 影子 signal：这是「QQ 里答完了，DSH 那张提问卡片自己收起来」的关键。
      //
      // 桌面卡片是 api-proxy 自己的 pendingQuestions 条目，插件**换不掉**那个 provider，
      // 但可以换掉 `request.signal` —— UserQuestionService.ask() 把 request 原样透传给 provider
      // （packages/interaction/user-questions/src/index.ts:139），而 api-proxy 的 ask() 会记下
      // `request.signal`（api-proxy.ts:1380）并挂一个 abort 监听（:1382-1389）；
      // 一旦 abort，它就 claimQuestion(pending, 'cancelled') —— 删条目、广播 `question/resolved`，
      // 于是**桌面卡片立刻消失**（新连上的客户端也不会再被 mux 重放，因为条目已经没了）。
      //
      // 所以：只在「真把卡片显示到桌面」时递影子 signal 进去；QQ 那边答完就 abort 它。
      // 外层 signal 必须继续转发到影子 signal 上 —— 否则这轮 turn 被取消时，
      // 桌面那张卡片就再也摘不掉了（那是 0.7.7 之前的老毛病）。
      const shadow = new AbortController()
      const outer = request?.signal
      let detachOuter = null
      if (outer && typeof outer.addEventListener === 'function') {
        const onOuterAbort = () => { try { shadow.abort() } catch { /* 已经中止过 */ } }
        outer.addEventListener('abort', onOuterAbort, { once: true })
        detachOuter = () => {
          try { outer.removeEventListener('abort', onOuterAbort) } catch { /* 忽略 */ }
        }
        // 进来时就已经中止了（这轮 turn 早被取消）：影子必须同样是中止态，
        // 否则 original() 会挂出一张没人管的卡片。
        if (outer.aborted) onOuterAbort()
      }

      // 只在这里解绑外层监听，避免长期握着一个已经结束的提问的 signal。
      function finish(fn, value) {
        if (detachOuter) { detachOuter(); detachOuter = null }
        fn(value)
      }

      // QQ 已经答完 → 让 DSH 自己去收卡片（它才会发 question/resolved 并清掉 pending 条目）。
      function hideDesktopCard() {
        if (!desktop) return
        try { shadow.abort() } catch { /* 已经中止过 */ }
      }

      function showDesktop(askId, why) {
        // settled：QQ 已经答完了，兜底闹钟不许再把这个问题显示到桌面（会留下残影）。
        if (settled || desktop) return
        l(`提问没有走 QQ（${why}），改为在 DSH 界面里提问`)
        if (askId) {
          // 桌面接管后 QQ 这条线**保留**：主人若稍后才在 QQ 里作答，答案照样有效
          // （那张卡片会被 abort 掉，回执里会提醒他，见 handleAnswer）。
          const item = pendingAsks.get(askId)
          if (item) item.desktopShown = true
        }
        // ⚠️ 一定递 request 的**副本**：不能动调用方那个对象（DSH 之外还有人在用）。
        const cardRequest = request && typeof request === 'object'
          ? { ...request, signal: shadow.signal }
          : request
        let pending
        try {
          pending = original(cardRequest)
        } catch (err) {
          // original 可能同步抛（例如影子 signal 已中止 → ASK_ABORTED）。别让这里变成 TypeError。
          settled = true
          finish(reject, err)
          return
        }
        desktop = pending
        const done = (fn) => (value) => {
          // 桌面已经回答/取消 → QQ 那条等待作废，删掉条目，
          // 免得它留 30 分钟、把之后某条 QQ 回复误配到这个已经结束的提问上。
          if (askId) pendingAsks.delete(askId)
          finish(fn, value)
        }
        pending.then(done(resolve), done(reject))
      }

      const viaQq = askViaQq(request, {
        onDelivered(delivered, askId) {
          if (settled) return
          if (!delivered) { showDesktop(askId, '没能把问题发到 QQ'); return }
          const seconds = Math.round(ASK_DESKTOP_FALLBACK_MS / 1000)
          fallbackTimer = setTimeout(
            () => showDesktop(askId, `QQ 那边 ${seconds} 秒没有回答`),
            ASK_DESKTOP_FALLBACK_MS,
          )
          // 兜底闹钟不能让 Node 进程吊着不退出。
          if (fallbackTimer.unref) fallbackTimer.unref()
        },
      })
      // viaQq 永不 reject：发不出去会走 onDelivered(false)，已由上面处理。
      viaQq.then((answer) => {
        settled = true
        // ⚠️ 必须撤掉兜底闹钟：否则兜底时间一到，它会把一个**已经答完**的提问
        //    显示到桌面上，主人就看到一张永远等不到答案的卡片 —— 正是原 bug 的形状。
        if (fallbackTimer) clearTimeout(fallbackTimer)
        // ★ QQ 里已经答完了 → 顺手把 DSH 那张提问卡片收掉（只在卡片真的出现过时才做）。
        //   走的是「中止影子 signal → api-proxy 自己 claimQuestion(…,'cancelled')」这条路，
        //   所以卡片在**所有已连上的客户端**上都会消失，新连上的客户端也不会被 mux 重放。
        //   desktop 那条 Promise 随后会以 ASK_ABORTED 落定，但这里已经 resolve 了 ——
        //   Promise 只认第一次落定，所以 QQ 的答案总是赢，不会有 unhandledRejection。
        hideDesktopCard()
        resolve(answer)
      })
    })
  }

  function askViaQq(request, hooks = {}) {
    // 「到底有没有把问题送到 QQ」——relayAsk 靠这个决定要不要把桌面提问接上来。
    const delivered = (ok, askId) => {
      try { hooks.onDelivered?.(ok, askId) } catch { /* 钩子出错不影响提问本身 */ }
    }
    return new Promise((resolve) => {
      const questions = request?.questions ?? []
      if (questions.length === 0) { delivered(false, ''); return } // 不兑现 → 交给桌面
      const sessionId = request?.agent?.id

      const askId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      pendingAsks.set(askId, {
        questions, sessionId, resolve, createdAt: Date.now(),
      })

      // 30 分钟后自动让位，避免一个没人答的问题堵住后续提问
      const timer = setTimeout(() => pendingAsks.delete(askId), ASK_TTL_MS)
      if (timer.unref) timer.unref()

      void (async () => {
        try {
          const cfg = liveConfig()
          if (!(await ensureStarted())) { delivered(false, askId); return }
          ensureState(cfg)
          const openId = state.data.openId
          if (!openId) {
            l('有提问但还不知道你的 open_id，无法发到 QQ（请先给机器人发条消息）')
            delivered(false, askId)
            return
          }
          const res = await bot.sendC2C(openId, formatQuestion(questions, {
            project: projectOf(request?.agent),
            session: sessionTitleOf(request?.agent),
          }))
          // ⚠️ 提问也**必须**登记 ref_idx：否则"引用提问那条消息来作答"永远
          //    认不出来（会掉进 unknown_ref），这条引用路径就成了死代码。
          state.addSentRef(res?.ext_info?.ref_idx, {
            sessionId,
            session: sessionTitleOf(request?.agent),
            kind: 'question',
            askId,
          })
          l(`提问已发到 QQ（${askId}）`)
          delivered(true, askId)
        } catch (err) {
          const hint = QqBotClient.explainError(err.code)
          l(`提问发送失败：${err.message}${hint ? ` —— ${hint}` : ''}`)
          // 关键：发送失败也要**回话**，否则 relayAsk 会白等一整个兜底窗口。
          delivered(false, askId)
        }
      })()
    })
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  function stop() {
    started = false
    try { bot?.stop() } catch { /* 忽略 */ }
    bot = null
    for (const [, item] of pendingAsks) {
      // 不 resolve：让桌面那条路继续负责
      void item
    }
    pendingAsks.clear()
  }

  return {
    notify,
    sendChatAnswer,
    /**
     * 把完整回答切成若干条发进 QQ 聊天框（三档全文模式里的 `chat` 档，也是默认档）。
     *
     * 与 `sendChatAnswer` 的区别见函数自身的注释：那条是闲聊场景「一轮一条、超长截断」，
     * 这条是正式会话「一条不落地发完」。**永不 reject**，失败只记日志并返回已发条数。
     *
     * @param {{text: string, sessionId?: string, session?: string, maxChars?: number}} args
     * @returns {Promise<{sent: number, total: number, chars?: number, reason?: string}>}
     */
    sendQqFulltext,
    ensureStarted,
    wrapUserQuestions,
    stop,
    /**
     * 这个会话是不是「闲聊会话」——即"不引用任何消息、直接说一句话"时默认进的那个。
     *
     * 用途：闲聊时你人就在 QQ 里等着回复，任务完成再推一条通知纯属打扰，
     * 所以 index.js 会用这个判断决定要不要推送（见配置 `notifyChatSession`）。
     *
     * @param {string} sessionId
     * @returns {boolean}
     */
    isChatSession(sessionId) {
      if (!sessionId) return false
      try {
        ensureState(liveConfig())
        return state?.data?.chatSessionId === sessionId
      } catch {
        return false
      }
    },
    /** 供自检/测试观察。 */
    get pendingCount() { return pendingAsks.size },
    get ready() { return Boolean(bot?.ready) },
    get lastStartError() { return lastStartError },
  }
}
