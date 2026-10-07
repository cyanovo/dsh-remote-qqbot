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
import { fileURLToPath } from 'node:url'

import { QqBotClient } from './qqbot.js'
import {
  BotState, DshLocalApi, HELP_TEXT, PICKER_DEFAULT_COUNT, WORKSPACE_PICK_WINDOW_MS,
  buildAnswers, buildHelpKeyboard,
  buildNumberButtons, buildOptionKeyboard, buildUpdateNoticeKeyboard,
  extractMsgIdx,
  extractQuoted, extractRefIdx,
  formatNotification, formatPickAck, formatQuestion, formatSessionPickerText,
  formatStatusText, formatTaskSessionPickAck, formatTaskSessionPickerText,
  formatWorkspacePickAck, formatWorkspacePickerText,
  inferSessionFromQuote, isPickerFresh, makeCmdButton, pickPromptMode, readDshSecret,
  healBrowserSessionRecord, readBrowserSessionSecret, resolveQuoteTarget, shortPath,
  routeMessage, summarizeSession,
} from './qqbridge.js'
import { planQqFulltext } from './fulltext.js'
import { captureScreen } from './screenshot.js'
import {
  DEFAULT_UPDATE_SOURCE, RESTART_DELAY_SECONDS, UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_INSTALL_TIMEOUT_MS, UPDATE_LOG_FILE_NAME, buildAddCommand, buildRestartScript,
  compareVersions, fetchAndVerifyPackage, fetchLatestVersion, formatAlreadyLatest, formatCheckFailed,
  formatNothingToSkip, formatRemoteOlder, formatRestartDone, formatUpdateAvailable,
  formatUpdateBusy, formatUpdateDone, formatUpdateFailed,
  formatUpdateMisconfigured, formatUpdateNoChange, formatUpdateSkipped, formatUpdating,
  formatPendingRestart,
  launchRestartScript, parseDesktopRuntime,
  parseUpdateSource, pluginRootFromFile, readPackageVersion, removeVerifiedPackage,
  resolveProfileFromPluginFile, restartLogSize, runProcess, verifyRestartLaunched,
  writeRestartLauncher, writeRestartScript,
} from './update.js'

/**
 * 已推送过的问题最多等这么久；超过就把它从「待回答」表里摘掉。
 *
 * 🔴 2026-10-05 从 **30 分钟放宽到 24 小时**。30 分钟太短，正是「AI 问我，我过了一阵才答，
 * 它却说我回答的那个提问不存在」这条故障的根因 —— 现场时间线：
 *
 *   - 23:51:38  提问发到 QQ（askId=ask-…-j65zsj，会话 session-edc80d93…）
 *   - 00:21:38  TTL 到期，条目**静默**作废（日志里当时什么也没有）
 *   - 00:45:13  主人引用那条提问作答 → 路由查不到待答提问 → 回一句「这会儿没有等你回答的问题」
 *               → 他的回答正文被丢掉，而 agent 那边还卡在这个提问上等
 *
 * 提问是 agent 在**阻塞等待**的东西，人什么时候回都应该算数 —— 出门、睡觉回来才答很正常。
 * 所以真正该清理的时机不是「过了多久」，而是「这轮提问已经结束了」：
 *   - `relayAsk` 里 request.signal 一中止（turn 被取消）就立刻摘掉条目；
 *   - 桌面卡片被回答/取消（`showDesktop` 的 `done`）时摘掉条目。
 * 保留这个上限只是**兜底**：万一上面两条路都没走到，也不至于让一个陈年提问永远吞掉后续消息。
 */
const ASK_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 「问题已经发到 QQ，但还没人回」时，等多久才**也**把提问显示到 DSH 界面里兜底。
 *
 * 为什么必须有兜底：桌面那张提问卡片由 api-proxy 自己持有（`pendingQuestions`），
 * 插件这边 resolve 掉 `ask()` 只能让 agent 继续跑，**清不掉那张卡片**。
 * 所以正常路径是「问题发到 QQ → 在 QQ 里作答」→ 桌面上从头到尾没有卡片，
 * 自然不会有残留；只有 QQ 这条线没人搭理时，才把卡片显示出来交给桌面自己管。
 */
const ASK_DESKTOP_FALLBACK_MS = 90 * 1000

/**
 * 启动那次更新检查"配置还没就绪"时，隔多久补查、最多补几次。
 *
 * 30 秒 × 3 ≈ 一分半，足够覆盖插件 apply 到配置就绪之间的空窗；
 * 再多也没意义 —— 真关着 QQ 通道的人，补一百次也还是关着。
 */
const UPDATE_LATE_RETRY_MS = 30 * 1000
const UPDATE_LATE_RETRY_MAX = 3

/** 闲聊回答的默认最大长度（按码点）。QQ 单条消息有长度上限，留足余量。 */
const CHAT_ANSWER_MAX = 1500

/**
 * 这个模块自己的文件路径。
 *
 * 用途只有一个：**反推"插件装在哪个 profile 里"**（路径里带着
 * `…/.dsh/profiles/<名字>/node_modules/dsh-remote-qqbot/lib/…`）。
 * 为什么不从配置里取：profile 是 DSH 自己的概念，插件没有任何入参能拿到它。
 */
const SELF_FILE = fileURLToPath(import.meta.url)

/**
 * 🔴 **这份代码被加载的那一刻**、磁盘上 package.json 里的版本号。
 *
 * 这是"内存里跑的是哪一版"的**唯一可靠来源**，绝不能改成"用到的时候现读"：
 * 插件装在 profile 里，`pnpm add` 换掉磁盘文件对**已经加载进内存的代码没有任何影响**；
 * 一旦"装完还没重启"，现读就会读到**新版**，于是插件以为自己在跑新版 ——
 *
 *   主人发 `/update` → 回「已经是最新版 1.0.20，不用更新」→ **永远不重启**，
 *   而他手机那头跑的还是 1.0.18，新功能一个也看不到。
 *
 * 2026-10-07 15:2x 主人踩的正是这个（跑 1.0.18、磁盘 1.0.20、`/update` 说已是最新）：
 * 旧代码把版本号缓存在**第一次用到时**才读，而这一次调用发生在装完 1.0.20 之后。
 * 加载时读一次就没有这个窗口 —— 文件是这一刻从磁盘读进来的，版本号必然对得上。
 */
const RUNNING_VERSION = (() => {
  try {
    const root = pluginRootFromFile(SELF_FILE)
    if (!root) return ''
    return readPackageVersion(path.join(root, 'package.json'))
  } catch {
    return ''
  }
})()

/**
 * 读**磁盘上装的那一份**代码的版本号（可能比内存里跑的这份新，见 {@link RUNNING_VERSION}）。
 *
 * 盘上那份的位置是固定的：`<profile>/node_modules/dsh-remote-qqbot/package.json`
 * （跟安装完读回来用的是同一个路径，见 `installUpdate`）。
 *
 * @param {string} [profileDir] - profile 目录；不传就按本模块自己的位置反推。
 * @returns {string} 读不出来返回空串。
 */
function installedVersionOnDisk(profileDir = '') {
  try {
    const dir = String(profileDir ?? '').trim()
      || resolveProfileFromPluginFile(SELF_FILE)?.profileDir
      || ''
    if (!dir) return ''
    return readPackageVersion(path.join(dir, 'node_modules', 'dsh-remote-qqbot', 'package.json'))
  } catch {
    return ''
  }
}

/** 按码点截断；超长补省略号。空串原样返回。 */
function clampText(text, maxChars) {
  const s = String(text ?? '').trim()
  if (s === '') return ''
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : CHAT_ANSWER_MAX
  const chars = [...s]
  return chars.length <= limit ? s : `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`
}

/** 把毫秒说成人话（日志里用）：「38 秒」「54 分钟」「3.5 小时」「2 天」。 */
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = s / 3600
  if (h < 48) return `${Math.round(h * 10) / 10} 小时`
  return `${Math.round(s / 8640) / 10} 天`
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

  /**
   * 最近见过的**入站消息索引**（`message_scene.ext` 的 `msg_idx`），只活在内存里。
   *
   * 用途只有一个：观测"平台会不会把同一条消息换个 id 再推一次"（官方要求按 msg_idx 去重）。
   * 观测到之前**不丢任何消息** —— 见 onC2cMessage 里的用法。
   */
  const seenMsgIdx = new Set()

  /**
   * 已经提示过"你这句话我当闲聊发了，但有个提问在等你回答"的 askId。
   *
   * 1.0.24 起普通消息不再自动当作答案（见 routeMessage），agent 那边可能一直卡着，
   * 所以第一次发生时要提示主人该引用作答；但**同一条提问只提示一次**，否则他每说一句
   * 就念一遍，比不提示还吵。只活在内存里：重启后最多再提示一次，无所谓。
   */
  const answerHinted = new Set()

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
  async function notify({ kind, summary, project, session, sessionId, buttons = null }) {
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
      //
      // buttons = 「消息按钮」（QQ 里那些可点的蓝色文字，见 docs/ARCHITECTURE.md 6.8）。
      // 传了它就强制走 markdown 通路 —— 官方：按钮只能挂在 markdown 消息上。
      const res = await bot.sendC2C(openId, text, {
        markdown: cfg.qqMarkdown === true, keyboard: buttons,
      })
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
      if (now - item.createdAt > ASK_TTL_MS) {
        // 作废必须留痕：2026-10-05 那次「AI 问过我、我答了却说没有在等回答」的故障，
        // 当时日志里一个字都没有，事后完全看不出提问是什么时候没的。
        pendingAsks.delete(askId)
        l(`提问 ${askId} 等了 ${fmtDuration(now - item.createdAt)} 没人答，超过上限已作废`
          + `（上限 ${fmtDuration(ASK_TTL_MS)}）`)
        continue
      }
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

  /**
   * 被动回复（带 `msg_id` 的那条路）：60 分钟内有效、同一条消息最多回 4 次。
   *
   * ⚠️ 回执也**必须登记 `ref_idx`**（2026-10-05 修）：QQ 的发送响应里同样带
   *    `ext_info.ref_idx`，而主人最常见的动作恰恰是「引用机器人最后那句回执再说话」
   *    （QQ 里就是点那条消息 → 引用 → 打字）。以前回执不登记，于是精确反查必然落空、
   *    只能靠 5 分钟的兜底；兜底一过期就回一句「认不出这是哪次通知」并把他那句话
   *    **整条丢掉** —— 2026-10-05 02:28/02:31 实测丢了两条（转录里连
   *    `user/message` 和 `agent/inbox/spliced` 都没有）。
   *
   * @param {object} data - 原始事件（`id` 做被动回复，`author` 定收件人）。
   * @param {string} text - 回复正文。
   * @param {{sessionId?: string, session?: string, kind?: string}} [target]
   *   这条回执属于哪个会话；**给了才登记**，好让主人引用这条回执时能回到同一个会话。
   * @param {object|null} [buttons] - 「消息按钮」（见 qqbridge 的 buildKeyboard）。
   *   传了它会强制走 markdown 通路 —— 官方：按钮只能挂在 markdown 消息上。
   */
  async function replyPassive(data, text, target, buttons = null) {
    const openId = data?.author?.user_openid ?? data?.author?.id
    if (!openId) return null
    try {
      const res = await bot.sendC2C(openId, text, buttons
        ? { msgId: data.id, keyboard: buttons }
        : { msgId: data.id })
      if (target?.sessionId) {
        const refIdx = res?.ext_info?.ref_idx
        const kind = target.kind ?? 'ack'
        state?.addSentRef(refIdx, { sessionId: target.sessionId, session: target.session, kind })
        // 也进「最近发出」时间线：引用一条认不出来的消息时，最近这条回执所在的会话
        // 就是最可能的落点（见 BotState.recentTarget）。
        state?.noteRecent({ sessionId: target.sessionId, session: target.session, kind, refIdx: refIdx ?? '' })
      }
      return res
    } catch (err) {
      l(`被动回复失败：${err.message}`)
      return null
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

    // 官方还建议「结合 msg_idx 去重」。我们**先只观测、不据此丢消息**：万一 msg_idx 不是
    // 每条消息唯一，按它去重会把正常消息永久丢掉 —— 那比偶尔重复进一次严重得多。
    // 真要看到"同一个 idx 配不同正文"，日志会先说出来，那时再决定要不要动真格。
    const myMsgIdx = extractMsgIdx(data)
    if (myMsgIdx) {
      if (seenMsgIdx.has(myMsgIdx)) {
        l(`⚠️ 同一个 msg_idx 又收到一次（${myMsgIdx.slice(0, 20)}…）：官方说要用它去重，`
          + '但先只记日志、不丢消息（消息体是另一条 id，说明平台确实会重投）')
      } else {
        seenMsgIdx.add(myMsgIdx)
        if (seenMsgIdx.size > 200) seenMsgIdx.delete(seenMsgIdx.values().next().value)
      }
    }

    const text = String(data?.content ?? '').trim()
    const pending = oldestPending()
    // 你引用的是哪条消息？—— 引用消息的 message_scene.ext 里有 ref_msg_idx
    const refIdx = extractRefIdx(data)
    // 官方事件里**还带着被引用那条消息本身**（正文 + 是不是我发的），见 extractQuoted。
    const quoted = extractQuoted(data, refIdx)
    // 引用反查按「从确定到不确定」三级走：
    //   ① ref_idx 精确命中登记表（知道得最准）
    //   ② 从**被引用消息的正文**里认出会话名（我发的每条消息里都写着会话名）
    //   ③ 最近一条我知道属于哪个会话的消息（12 小时窗，见 BotState.recentTarget）
    // 三级全落空时**也绝不丢消息** —— 投进闲聊会话（只读）并说清去了哪，见下面的 unknown_ref。
    // 不兜底的话这条消息会以 unknown_ref 被整条丢掉：用户既没进会话、也看不到任何处理。
    // 三级怎么选是纯函数 resolveQuoteTarget 的事，这里只负责把料备齐。
    const exact = state.refTarget(refIdx)
    /** 第三条路（最近一条）的目标：只认带会话的登记，12 小时窗。精确命中时不必算。 */
    const recent = exact || !refIdx ? null : state.recentTarget()
    let refTarget = exact
    let quotedHow = ''
    if (!exact && quoted?.content) {
      // 认正文要用会话列表（标题 → id），所以这一步是异步的；失败只是少一条路，不往外抛。
      let sessions = []
      try {
        ensureApi(cfg)
        sessions = await listSessions()
      } catch (err) {
        l(`按引用正文认会话失败（继续走兜底）：${err?.message ?? err}`)
      }
      refTarget = resolveQuoteTarget({ exact, quoted, sessions, pending, recent })
      if (refTarget?.viaContent) quotedHow = refTarget.how
    } else if (!exact) {
      refTarget = recent
    }
    // 1.0.24 起"刚看过名单 → 裸数字就是选它"这条规则**取消了**：主人要求「不引用、不带 /
    // 的消息一律当闲聊，无论任何情况」。名单本身照旧有效，按钮也照旧能点（它们发的是
    // `/pick` `/open` `/use` 这种显式指令）。
    //
    // 这里只算"刚刚到底发过哪一份名单"——用途**只有一个**：万一他手打了一个数字，
    // 消息照样当闲聊投出去（投递不受影响），但顺带回一句提示。三份名单谁后发听谁的，
    // 顺序（工作区会话 → 工作区 → 会话）只在时间戳相等时才起作用：越具体的越优先。
    const nowMs = Date.now()
    const freshList = [
      {
        label: '工作区里的会话名单', cmd: '/open ',
        fresh: isPickerFresh(
          { pickerAt: state.data.taskSessionAt, ids: state.data.taskSessionIds },
          nowMs, WORKSPACE_PICK_WINDOW_MS,
        ),
      },
      {
        label: '工作区名单', cmd: '/pick ',
        fresh: isPickerFresh(
          { pickerAt: state.data.taskPickerAt, ids: state.data.taskPickerCwds },
          nowMs, WORKSPACE_PICK_WINDOW_MS,
        ),
      },
      {
        label: '会话名单', cmd: '/use ',
        fresh: isPickerFresh({ pickerAt: state.data.pickerAt, ids: state.data.pickerIds }, nowMs),
      },
    ].find((x) => x.fresh) ?? null
    const route = routeMessage({
      text, refIdx, hasPendingQuestion: Boolean(pending), refTarget,
      hasQuote: Boolean(refIdx) || Boolean(quoted),
    })
    l(`收到消息 → ${route.kind}（${route.reason}）${refIdx ? ` ref=${String(refIdx).slice(0, 20)}…` : ''}`
      + (quoted?.content
        ? `｜引用了${quoted.bot ? '我' : '你'}发的「${quoted.content.split('\n')[0].slice(0, 40)}」`
        : '')
      + (quotedHow ? `（按正文认出会话：${quotedHow}）` : '')
      + (refTarget?.viaFallback
        ? `（ref_idx 认不出，已按最近一条消息兜底${refTarget.ageMs ? `：${fmtDuration(refTarget.ageMs)} 前那条` : ''}）`
        : ''))

    switch (route.kind) {
      // 引用了我发的通知 → 回到那条通知对应的会话
      case 'prompt': {
        const ok = await handlePrompt(route.sessionId, route.session || '那个会话', route.text, data)
        // 靠**被引用消息的正文**认出会话的（ref_idx 反查没命中）时也必须明说 ——
        // 认错了主人一眼能看出来，才知道该怎么补救。
        if (ok && refTarget?.viaContent) {
          await replyPassive(data, [
            `（说一声：这条我是按${refTarget.how || '引用正文'}认出会话的 ——「${route.session || '那个会话'}」，你引用的那条我这儿没登记。）`,
            '如果送错了地方：发 /sessions 挑一个，再把你这句话重发一次。',
          ].join('\n'), { sessionId: route.sessionId, session: route.session || '' })
        } else if (ok && refTarget?.viaFallback) {
          // 这条走的是**兜底**（ref_idx 没对上，只能按"最近一条通知"猜会话）时必须明说：
          // 悄悄把话送到另一个会话，是这里最坏的失败方式。带上"那条通知是多久前的"，
          // 好让主人一眼判断猜得对不对，错了立刻能重发。
          const ago = refTarget.ageMs ? `，那条通知是 ${fmtDuration(refTarget.ageMs)} 前发的` : ''
          await replyPassive(data, [
            `（说一声：你引用的那条我认不出是哪次通知 —— 按最近一条通知的会话「${route.session || '那个会话'}」送进去了${ago}。）`,
            '如果送错了地方：发 /sessions 挑一个，再把你这句话重发一次。',
          ].join('\n'), { sessionId: route.sessionId, session: route.session || '' })
        }
        break
      }
      // 显式 /task → 派活。
      //   · 选过工作区（/task 挑过）→ 进那个工作区的专属会话
      //   · 没选过 → 保持老行为：进 qqCwd 上那个「专属会话」
      case 'task': {
        const chosen = currentTaskCwd()
        if (chosen) {
          await handlePrompt(await ensureTaskSession(chosen), `工作区 ${shortPath(chosen)}`, route.text, data)
        } else {
          await handlePrompt(await ensureNamedSession('sessionId', cfg.qqCwd, '专属会话'), '专属会话', route.text, data)
        }
        break
      }
      // `/task` 不带内容 → 先列工作区；点按钮，或者发 /pick N
      case 'task_workspaces':
        await handleTaskWorkspaces(data)
        break
      case 'pick_workspace':
        await handlePickWorkspace(route.index, data)
        break
      // 派活第二步：在挑好的工作区里选一个会话，或者开个新对话（`/open 0` / 点「新对话」）。
      case 'pick_task_session':
        await handlePickTaskSession(route.index, data)
        break
      // `/new`（也认 `/新`）：在当前工作区开一个新对话。
      case 'new_task_session':
        await handleNewTaskSession(data)
        break
      // 没引用、也不带 `/` → **一律**闲聊，进 /sessions 指定的那个会话（没指定就是闲聊会话）。
      //
      // 🔴 1.0.24 起这里不再有"抢消息"的分支：以前有提问在等就当作答、刚看过名单的数字就当
      //    选择、光秃秃的数字干脆拦下来问一句 —— 主人要求「不引用、不带 / 就是闲聊，
      //    无论任何情况」。所以下面只是"投出去之后顺带说一句提示"，**不改投递**：
      //      · 有提问在等：agent 那边正卡着，不说一声他会以为这句是回答
      //      · 刚发过名单却手打了一个数字：多半是想选它（2026-10-07 09:09 那次「2」的现场）
      case 'chat': {
        const target = await chatTarget()
        const ok = await handlePrompt(target.id, target.label, route.text, data)
        // 指定的会话不在了：退回闲聊会话，但必须说一声 —— 静默换会话是最坏的失败方式。
        if (target.fallbackFrom) {
          await replyPassive(data, `（另外说一声：你之前指定的那个会话已经不在了，这句进了闲聊会话。发 /sessions 可以重新挑一个。）`, { sessionId: target.id, session: target.label })
        }
        if (ok) {
          const digit = /^\d+$/.test(route.text)
          // 同一条提问只提示一次（问过之后他多半会去引用作答，别每句话都念一遍）。
          if (pending && !answerHinted.has(pending.askId)) {
            answerHinted.add(pending.askId)
            if (answerHinted.size > 50) answerHinted.delete(answerHinted.values().next().value)
            const where = pending.session ? `（来自「${pending.session}」）` : ''
            await replyPassive(data, [
              `（说一声：这句我当闲聊发了 —— 有个提问在等你回答${where}。`,
              '要回答它：**引用那条提问**再发一次，或者点它下面的按钮，或者发 /answer 你的回答。）',
            ].join(''))
            l(`有提问 ${pending.askId} 在等，但那句话被当闲聊发走了 —— 已提示主人引用作答`)
          } else if (digit && freshList) {
            await replyPassive(data, `（说一声：这个数字我当闲聊发了。要选刚才那份${freshList.label}：`
              + `点上面的按钮，或者发 ${freshList.cmd}${route.text}。）`)
          }
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
      // 远程更新：`/update` 装新版，`/update check` 只查。
      // 装完会自动重启 DSH —— 回执里必须说清（文案在 update.js），否则主人会以为机器人坏了。
      case 'update':
        await handleUpdate(Boolean(route.check), data)
        break
      // 「忽略本次」按钮（新版本提醒下面那个）= `/skip`：这一版先不提醒，随时可 /update 装上。
      case 'update_skip':
        await handleUpdateSkip(data)
        break
      case 'help':
        // 帮助里也挂按钮：命令变成可点的，不用照着抄。
        await replyPassive(data, HELP_TEXT, undefined, buildHelpKeyboard())
        break
      // 引用的是一条**已经结束的提问**（`/answer` 但没人在等，也走这里）：
      // 以前只说「这会儿没有等你回答的问题」，主人不知道自己的回答去哪了。
      case 'no_question': {
        const where = refTarget?.session ? `（那个提问来自「${refTarget.session}」）` : ''
        await replyPassive(data, [
          `你引用的这个提问已经结束了${where} —— 被答掉、被取消，或者等太久作废了。你刚发的这句我没送进去。`,
          '想接着说那个会话：引用我别的通知（问进展／结果那种）回一句就行；想开新活：发 /task 加上要做的事。',
        ].join('\n'), { sessionId: refTarget?.sessionId, session: refTarget?.session })
        break
      }
      case 'usage':
        await replyPassive(data, route.text)
        break
      case 'unknown':
        await replyPassive(data, `这条指令 /${route.command} 我不认识，发 /help 看看我会些什么`)
        break
      // 引用的那条既不在登记表里、也没有任何「最近发出的消息」可兜底（比如引用你自己
      // 发的那句、或引用好几天前的一条）。
      //
      // 🔴 以前这里只回一句「认不出这是哪次通知」——**把你这句话整条扔掉**：既不进任何
      //    会话、也不会被回答。2026-10-05 实测就是这么丢的（转录里连 `user/message`
      //    都没有）。现在改成投进闲聊会话（只读，动不了手）并说清去了哪 —— 宁可落错
      //    一个只读会话，也不能让主人的话消失。
      case 'unknown_ref': {
        const target = await chatTarget()
        const ok = await handlePrompt(target.id, target.label, route.text, data)
        if (ok) {
          // 把你引用的那句**摘出来**回给你：这样"我到底看见了什么"是可见的，
          // 而不是一句笼统的"认不出"（2026-10-05 那次故障里，主人完全不知道发生了什么）。
          const what = quoted?.content
            ? `你引用的那条「${quoted.content.split('\n')[0].slice(0, 30)}」`
            : '你引用的那条'
          await replyPassive(data, [
            `（说一声：${what}我认不出属于哪个会话 —— 没登记过、会话名也没对上，所以这句话我放进了「${target.label}」：那里只能看、不能动手。）`,
            '想接着说某个会话：引用我**别的**通知（跑完了／提问那种）回一句就行；想开新活：发 /task 加上要做的事。',
          ].join('\n'), { sessionId: target.id, session: target.label })
        }
        break
      }
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
    // 会话名单也挂数字按钮（发回来的是 `/use 3`，本来就有这条显式指令）——
    // 手打数字受 5 分钟窗口限制，点按钮不受。
    const picked = sessions.slice(0, recentCount())
    await replyPassive(data, formatSessionPickerText({
      sessions, currentId: state.data.activeSessionId ?? '', count: recentCount(), listError,
    }), undefined, buildNumberButtons('/use ', picked.length))
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

  // ── 按工作区派活（/task 两步：先挑工作区，再发要做的事）─────────────────────

  /**
   * 会话列表 → 工作区列表（同一个目录归成一个，按最近活动倒序）。
   *
   * 「工作区」就是 DSH 会话的工作目录：你在哪个目录下开过会话，它就是一个可选工作区。
   * 名字取目录最后一段（完整路径在手机上会把行撑爆），但**完整路径一起带着** ——
   * 派活时要用它去 `session/create`。
   *
   * @returns {Promise<Array<{cwd: string, name: string, sessions: number, updatedAt: number}>>}
   */
  async function listWorkspaces() {
    const sessions = await listSessions()
    const byCwd = new Map()
    for (const s of sessions) {
      const cwd = String(s.cwd ?? '').trim()
      if (cwd === '') continue
      const hit = byCwd.get(cwd)
      if (hit) {
        hit.sessions += 1
        hit.updatedAt = Math.max(hit.updatedAt, s.updatedAt)
      } else {
        byCwd.set(cwd, { cwd, name: s.project || shortPath(cwd), sessions: 1, updatedAt: s.updatedAt })
      }
    }
    return [...byCwd.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 当前选定的工作区（没选过返回空串）。 */
  function currentTaskCwd() {
    return String(state?.data?.activeTaskCwd ?? '').trim()
  }

  /**
   * 取（必要时创建）某个工作区的专属派活会话。
   *
   * 一个工作区一个会话（而不是每次新建）：重复派活能接着上下文，也不会在 DSH 里
   * 堆出一串同名空会话。默认工作区（`qqCwd`）沿用老的 `sessionId` 槽位，
   * 老状态文件不需要迁移。
   *
   * @param {string} cwd - 工作区目录（空 → 配置里的 qqCwd，再空 → 进程 cwd）。
   * @returns {Promise<string>} 会话 id。
   */
  async function ensureTaskSession(cwd) {
    const cfg = liveConfig()
    ensureState(cfg)
    ensureApi(cfg)
    if (!api) throw new Error(`DSH 会话密钥不可用，无法注入${injectHint() ? `：${injectHint()}` : ''}`)

    const dir = String(cwd ?? '').trim() || String(cfg.qqCwd ?? '').trim()
      || (() => { try { return process.cwd() } catch { return '.' } })()

    const map = { ...(state.data.taskSessions ?? {}) }
    let existing = map[dir] ?? ''
    // 默认工作区：老的「专属会话」就是它，直接认下来，不另建一个。
    if (!existing && dir === String(cfg.qqCwd ?? '').trim() && state.data.sessionId) {
      existing = state.data.sessionId
    }
    if (existing) {
      try {
        if (await api.hasSession(existing)) {
          if (map[dir] !== existing) state.set({ taskSessions: { ...map, [dir]: existing } })
          return existing
        }
        l(`工作区 ${dir} 的派活会话 ${existing} 已不存在，重新创建`)
      } catch (err) {
        // 查不了 ≠ 没了：宁可照原样投递（失败会在 handlePrompt 里如实报出）。
        l(`检查工作区派活会话失败，沿用原值：${err?.message ?? err}`)
        return existing
      }
    }
    const sid = await api.createSession(dir)
    state.set({ taskSessions: { ...map, [dir]: sid } })
    l(`已创建工作区派活会话 ${sid}（cwd=${dir}）`)
    return sid
  }

  /** `/task`（不带内容）：列出工作区名单，并把编号对应的完整路径记下来。 */
  async function handleTaskWorkspaces(data) {
    const cfg = liveConfig()
    ensureState(cfg)
    ensureApi(cfg)
    if (!api) {
      await replyPassive(data, formatWorkspacePickerText({
        listError: `DSH 接口还没就绪${injectHint() ? `：${injectHint()}` : ''}`,
      }))
      return
    }
    let workspaces = []
    let listError = ''
    try {
      workspaces = await listWorkspaces()
    } catch (err) {
      listError = err?.message ?? String(err)
      l(`读取工作区列表失败：${listError}`)
    }
    if (!listError) {
      // 名单与发榜时刻**一起存**：你回数字时按**你看到的那个编号**解析，
      // 中途新开/删掉会话都不会让编号错位。
      state.set({
        taskPickerAt: Date.now(),
        taskPickerCwds: workspaces.slice(0, recentCount()).map((w) => w.cwd),
      })
    }
    // 名单下面挂一排数字按钮：点了发回来的是 `/pick 3`（显式指令），
    // 不查 24 小时那个窗口 —— 手打数字才查（见 WORKSPACE_PICK_WINDOW_MS）。
    const picked = workspaces.slice(0, recentCount())
    await replyPassive(data, formatWorkspacePickerText({
      workspaces, currentCwd: currentTaskCwd(), count: recentCount(), listError,
    }), undefined, buildNumberButtons('/pick ', picked.length))
  }

  /**
   * 派活第一步：回一个数字 = 选中那个工作区，**然后列出它里面的会话**（第二步）。
   *
   * 1.0.19 起这一步不再直接落到"该工作区的专属会话"上：主人要求能在工作区里
   * 挑已有会话、或者开个新对话（2026-10-07）。所以这里只负责把工作区定下来，
   * 再用 `showTaskSessions()` 把选择权交回去。
   *
   * @param {number} index - 名单里的编号（1 起）。
   * @param {object} data - 原始事件（用于被动回复）。
   */
  async function handlePickWorkspace(index, data) {
    const cfg = liveConfig()
    ensureState(cfg)
    ensureApi(cfg)
    if (!api) {
      await replyPassive(data, `❌ DSH 接口还没就绪，等一会儿再试${injectHint() ? `（${injectHint()}）` : ''}`)
      return
    }
    const cwds = Array.isArray(state.data.taskPickerCwds) ? state.data.taskPickerCwds.slice() : []
    // 🔴 名单没了（重启清了状态、或者压根没发过 /task）**绝不现拉一份顶上**。
    //    以前这里会"现拉当前列表"充数 —— 可那个编号是你**没看过**的一份列表里的，
    //    你以为选的是第 3 个"插件"，实际选中的可能是另一个目录。选错工作区 = 把活
    //    派进了别的项目。宁可让你重发一次 /task。
    //
    //    注：`/pick 3`（按钮发的那条）也会走到这里 —— 它跳过时间窗，但同样要求
    //    "名单真的存在"，因为编号只对着你看过的那份名单才有意义。
    if (cwds.length === 0) {
      await replyPassive(data, formatWorkspacePickAck('no-list'))
      l('有人在没有工作区名单的情况下选了编号 —— 已拒绝，并要求重发 /task')
      return
    }
    const cwd = cwds[index - 1]
    if (!cwd) {
      await replyPassive(data, formatWorkspacePickAck('out-of-range', { index, count: cwds.length }))
      return
    }

    // 工作区名单用完就作废（第二步换成"会话名单"接着用数字），并把工作区记下来，
    // 这样 `/new`、`/open 0` 都知道在哪个目录开。
    state.set({ activeTaskCwd: cwd, taskPickerAt: 0, taskPickerCwds: [] })
    l(`工作区已选 ${cwd} —— 接着列它里面的会话`)
    await showTaskSessions(cwd, data)
  }

  /**
   * 派活第二步：列出某个工作区里的会话，让你挑一个或者开新对话。
   *
   * 一个会话都没有时**直接开新对话**（省掉一次"没得选"的往来），并在回执里说清
   * 是新建的 —— 因为这时"你没得选"和"你选了第一个"从结果上看是一样的。
   *
   * @param {string} cwd - 已选的工作区目录。
   * @param {object} data - 原始事件（用于被动回复）。
   */
  async function showTaskSessions(cwd, data) {
    let all = []
    let listError = ''
    try {
      all = await listSessions()
    } catch (err) {
      listError = err?.message ?? String(err)
      l(`读取 ${cwd} 的会话列表失败：${listError}`)
    }
    if (listError) {
      await replyPassive(data, formatTaskSessionPickerText({ cwd, name: nameOfWorkspace(cwd), listError }))
      return
    }
    // 只列**这个工作区**的会话：`/sessions` 那份是全局最近会话，混进别的目录就白挑了。
    const mine = all.filter((s) => String(s.cwd ?? '').trim() === cwd)
    const picked = mine.slice(0, recentCount())
    if (picked.length === 0) {
      l(`${cwd} 里没有任何会话 —— 直接开一个新对话`)
      await handleNewTaskSession(data, { cwd })
      return
    }
    const map = { ...(state.data.taskSessions ?? {}) }
    state.set({
      taskSessionAt: Date.now(),
      taskSessionIds: picked.map((s) => s.id),
      taskSessionCwd: cwd,
    })
    await replyPassive(data, formatTaskSessionPickerText({
      cwd,
      name: nameOfWorkspace(cwd, all),
      sessions: picked,
      currentId: String(state.data.activeSessionId ?? ''),
      lastUsedId: String(map[cwd] ?? ''),
      count: recentCount(),
    }), undefined, buildNumberButtons('/open ', picked.length, { extra: [makeCmdButton('新对话', '/new')] }))
  }

  /**
   * 派活第二步的落点：选第 N 个会话；**N = 0 表示开一个新对话**。
   *
   * 🔴 名单不存在就拒绝（要你先发 /task）：编号只对着你看过的那份名单才成立，
   *    拿"此刻的列表"顶上等于让你选一个你没见过的会话。
   *
   * @param {number} index - 名单编号；0 = 新对话。
   * @param {object} data - 原始事件（用于被动回复）。
   */
  async function handlePickTaskSession(index, data) {
    const cfg = liveConfig()
    ensureState(cfg)
    ensureApi(cfg)
    if (!api) {
      await replyPassive(data, `❌ DSH 接口还没就绪，等一会儿再试${injectHint() ? `（${injectHint()}）` : ''}`)
      return
    }
    // 0 = 新对话。放在"名单必须存在"之前判：`/open 0` 是明确的"开新的"，
    // 只要知道在哪个工作区就该能开（工作区在状态里，见 handlePickWorkspace）。
    if (index === 0) {
      await handleNewTaskSession(data)
      return
    }
    const ids = Array.isArray(state.data.taskSessionIds) ? state.data.taskSessionIds.slice() : []
    const cwd = String(state.data.taskSessionCwd ?? '').trim()
    if (ids.length === 0 || !cwd) {
      await replyPassive(data, formatTaskSessionPickAck('no-list'))
      l('有人在没有工作区会话名单的情况下选了编号 —— 已拒绝，并要求重发 /task')
      return
    }
    const target = ids[index - 1]
    if (!target) {
      await replyPassive(data, formatTaskSessionPickAck('out-of-range', { index, count: ids.length }))
      return
    }
    // 会话可能在你看名单之后被删掉了 —— 明说，绝不悄悄换一个。
    try {
      if (!(await api.hasSession(target))) {
        await replyPassive(data, formatTaskSessionPickAck('gone', {
          index, session: await titleOf(target), count: ids.length,
        }))
        state.set({ taskSessionAt: 0, taskSessionIds: [] })
        return
      }
    } catch (err) {
      // 查不了 ≠ 没了：宁可照原样选中（投递失败会在 handlePrompt 里如实报出）。
      l(`检查会话 ${target} 是否存在失败，仍按它选中：${err?.message ?? err}`)
    }
    const map = { ...(state.data.taskSessions ?? {}) }
    state.set({
      activeTaskCwd: cwd,
      activeSessionId: target,
      taskSessions: { ...map, [cwd]: target },
      taskSessionAt: 0,
      taskSessionIds: [],
      taskSessionCwd: '',
    })
    const title = (await titleOf(target)) || target.slice(0, 12)
    await replyPassive(data, formatTaskSessionPickAck('ok', {
      name: nameOfWorkspace(cwd), cwd, session: title,
    }))
    l(`派活会话已选 ${target}（${title}，cwd=${cwd}）`)
  }

  /**
   * 在当前工作区开一个**新对话**，并把它设成当前派活会话。
   *
   * 与 `ensureTaskSession` 的区别：那个是"复用该工作区的专属会话"，这个是**明确新建**
   * ——主人说"新对话"的时候不该又把他送回上次那个会话里。
   *
   * @param {object} data - 原始事件（用于被动回复）。
   * @param {{cwd?: string}} [opts] - 指定工作区；不给就用 `activeTaskCwd`。
   */
  async function handleNewTaskSession(data, { cwd = '' } = {}) {
    const cfg = liveConfig()
    ensureState(cfg)
    ensureApi(cfg)
    if (!api) {
      await replyPassive(data, `❌ DSH 接口还没就绪，等一会儿再试${injectHint() ? `（${injectHint()}）` : ''}`)
      return
    }
    const dir = String(cwd || state.data.taskSessionCwd || currentTaskCwd()).trim()
    // 连工作区都不知道是哪个：**绝不猜一个目录**去建会话。
    if (!dir) {
      await replyPassive(data, formatTaskSessionPickAck('no-workspace'))
      l('有人要开新对话，但还没挑过工作区 —— 已拒绝，并要求先发 /task')
      return
    }
    let sid = ''
    try {
      sid = await api.createSession(dir)
    } catch (err) {
      await replyPassive(data, `❌ 在「${shortPath(dir)}」建新对话失败：${err?.message ?? err}`)
      return
    }
    const map = { ...(state.data.taskSessions ?? {}) }
    state.set({
      activeTaskCwd: dir,
      activeSessionId: sid,
      taskSessions: { ...map, [dir]: sid },
      taskSessionAt: 0,
      taskSessionIds: [],
      taskSessionCwd: '',
    })
    const title = (await titleOf(sid)) || sid.slice(0, 12)
    await replyPassive(data, formatTaskSessionPickAck('new', {
      name: nameOfWorkspace(dir), cwd: dir, session: title,
    }))
    l(`已在 ${dir} 开新对话 ${sid}`)
  }

  /** 工作区显示名：优先用会话列表里的项目名，取不到就退回目录名。 */
  function nameOfWorkspace(cwd, sessions = []) {
    const dir = String(cwd ?? '').trim()
    if (!dir) return ''
    const hit = (Array.isArray(sessions) ? sessions : [])
      .find((s) => String(s?.cwd ?? '').trim() === dir && s?.project)
    return hit?.project || shortPath(dir)
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
      return false
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
      //
      // 🔴 但**失败必须说出来**（1.0.25）：以前失败只写日志，界面上那个开关还显示着"开"，
      // 主人以为闲聊动不了手，实际这一轮是按会话原权限（本机默认 danger-full-access）跑的。
      // 契约：钩子返回 `false` = 「要求只读但没能生效」；`true` = 已就绪或压根没要求。
      let readOnlyWarn = ''
      if (beforeChatPrompt && sessionId === state?.data?.chatSessionId) {
        try {
          if (beforeChatPrompt(sessionId) === false) {
            readOnlyWarn = '\n⚠️ 这次没能把闲聊会话切成只读，这句是在它的原权限下跑的'
              + '（原因见设置页「运行状态」里的「闲聊只读」一行）'
            l('闲聊只读没能生效，已在回执里说明（不影响投递）')
          }
        } catch (err) {
          readOnlyWarn = `\n⚠️ 这次没能把闲聊会话切成只读，这句是在它的原权限下跑的：${err?.message ?? err}`
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
      // 带上 target：回执本身也登记 ref_idx，主人引用这句「✅ 收到…」再说话时才认得出会话。
      await replyPassive(data, `✅ ${how}（${label}）`, { sessionId, session: label })
      return true
    } catch (err) {
      // 补救动作（"已经补回签名记录，重启一次桌面版"）必须出现在用户看到的那句话里 ——
      // 否则他只知道"送不进去"，不知道下一步该干什么。
      const hint = injectHint()
      const suffix = hint && !String(err?.message ?? '').includes(hint) ? `（${hint}）` : ''
      l(`注入失败：${err.message}${suffix}`)
      await replyPassive(data, `❌ 这句没送进 ${label}：${err.message}${suffix}`, { sessionId, session: label })
      return false
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
      // 走到这里 = 提问已经结束（被人答掉、被取消，或者等太久作废）。以前只回一句
      // 「这会儿没有在等你回答的问题～」，主人根本不知道他刚打的那句话去哪了 ——
      // 2026-10-05 的投诉就是这么来的。现在必须说清三件事：提问结束了、你这句**没**
      // 送进去、下一步怎么办。
      l(`收到一句作答，但${askId ? `提问 ${askId}` : '没有任何提问'}已经结束，没有可兑现的对象`)
      await replyPassive(data, [
        '这个提问已经结束了（被人答掉、被取消，或者等太久作废了），你刚发的这句我没送进去。',
        '想接着说那个会话：引用我别的通知（问进展／结果那种）回一句就行；',
        '想开新活：发 /task 加上要做的事。',
      ].join('\n'))
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
    await replyPassive(data, `✅ 收到，已经把你的回答带过去了${tail}`, {
      sessionId: item.sessionId, session: item.session,
    })
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
    // 「用 /task 派活会进这里」：选过工作区就报那个工作区的派活会话，否则报默认的专属会话。
    const taskCwd = currentTaskCwd()
    const taskId = (taskCwd && state.data.taskSessions?.[taskCwd]) || state.data.sessionId || ''
    return formatStatusText({
      channelOn: bot?.ready === true,
      pending: pendingAsks.size,
      sessions,
      taskId,
      chatId: state.data.chatSessionId ?? '',
      activeId: state.data.activeSessionId ?? '',
      listError,
      // 推送（出站）与注入（入站）是两条独立的腿：只报"QQ 连着"会让人以为
      // 引用回复也没问题 —— 2026-10-04 就是这么误诊了半天。
      injectError: api ? '' : (injectHint() || 'DSH 会话密钥不可用'),
      injectNote: api ? apiNote : '',
      // 「我在跑哪一版」：主人 2026-10-07 反复问这个（磁盘装了新版、内存还是旧版，
      // 界面上看不见、/update 又只会说"已是最新"）。放进 /status 让他一句话问到。
      runningVersion: ownVersion(),
      installedVersion: installedVersionOnDisk(),
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
      /** QQ 那条线正在等哪个 askId（`delivered` 之后才有值）。 */
      let askIdInFlight = ''

      /**
       * 这一轮提问被取消了（主人按了停止 / 会话被关 / 进程要退）：把 QQ 那边的
       * 「待回答」条目一起摘掉。
       *
       * 不摘的后果是 2026-10-05 那条故障的另一种形状：条目留着 → 几小时后主人回一句，
       * 它被当成某个提问的答案接走；条目没了 → 主人被告知「没有在等你回答的问题」。
       * **提问死了，条目就必须跟着死**，跟它等了多久无关。
       *
       * ⚠️ 这里**不**去 settle 这个 Promise：调用方（那一轮 turn）自己已经在收尾了，
       *    多一次 reject 只会在 DSH 侧多一个没人接的异常。桌面卡片那条路照旧由
       *    `original()` 的 ASK_ABORTED 收尾（`showDesktop` 里的 done 会删掉条目）。
       */
      function cancelAsk(why) {
        try { shadow.abort() } catch { /* 已经中止过 */ }
        if (settled) return
        settled = true
        if (fallbackTimer) clearTimeout(fallbackTimer)
        if (askIdInFlight && pendingAsks.delete(askIdInFlight)) {
          l(`提问 ${askIdInFlight} 随「${why}」作废，QQ 那边不再接受作答`)
        }
      }

      if (outer && typeof outer.addEventListener === 'function') {
        const onOuterAbort = () => cancelAsk('这一轮 turn 被取消')
        outer.addEventListener('abort', onOuterAbort, { once: true })
        detachOuter = () => {
          try { outer.removeEventListener('abort', onOuterAbort) } catch { /* 忽略 */ }
        }
        // 进来时就已经中止了（这轮 turn 早被取消）：影子必须同样是中止态，
        // 否则 original() 会挂出一张没人管的卡片。
        if (outer.aborted) onOuterAbort()
      }
      // 这里的 settled 只可能来自上面那行 —— 这轮提问早就作废了，**一个字都不该再发到 QQ**
      // （发出去也没人在等它，主人手机上只会多出一条莫名其妙的提问）。
      if (settled) {
        if (detachOuter) { detachOuter(); detachOuter = null }
        // 调用方递进来的是一个**已经中止**的 signal，说明它早就不等了；但这个 Promise
        // 仍然要落定 —— DSH 自己的 api-proxy 在这种情况也是 reject(ASK_ABORTED)，
        // 留一个永远不落定的 await 会把那一轮 turn 吊住。
        const aborted = new Error('提问在主人作答前被取消了')
        aborted.code = 'ASK_ABORTED'
        reject(aborted)
        return
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
          // 桌面已经回答/取消 → 这个提问就结束了，QQ 那条等待作废、删掉条目，
          // 免得它对着一份更长的 TTL（见 ASK_TTL_MS）把之后某条 QQ 回复误配到
          // 一个已经结束的提问上。
          if (askId) pendingAsks.delete(askId)
          finish(fn, value)
        }
        pending.then(done(resolve), done(reject))
      }

      const viaQq = askViaQq(request, {
        onDelivered(delivered, askId) {
          if (settled) return
          // 记下"QQ 那边正在等哪个 askId"：上面的 cancelAsk() 靠它把条目摘干净。
          if (askId) askIdInFlight = askId
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
      // session（会话名）也一起记：QQ 里答完之后的回执要带着它登记 ref_idx，
      // 主人再引用那句回执时文案才说得出是哪个会话（否则只能显示「那个会话」）。
      pendingAsks.set(askId, {
        questions, sessionId, session: sessionTitleOf(request?.agent), resolve, createdAt: Date.now(),
      })

      // 兜底让位（默认 24 小时，见 ASK_TTL_MS）。正常轮不到它：turn 被取消时 relayAsk
      // 会立刻摘掉条目，在 QQ 里答完、在桌面答完也都会摘。留着只是防止有个没人答的
      // 提问变成"陈年条目"，把几天后的某条消息误配成它的答案。
      const timer = setTimeout(() => {
        if (pendingAsks.delete(askId)) {
          l(`提问 ${askId} 等了 ${fmtDuration(ASK_TTL_MS)} 没人答，超过上限已作废（不再接受作答）`)
        }
      }, ASK_TTL_MS)
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
          // 单选的提问额外挂一排按钮：点一下就把序号发回来 ⇒ 一键作答。
          // 多选/多个问题的情形 buildOptionKeyboard 会返回 null（那时按钮帮不上忙）。
          // ⚠️ 传了 keyboard 就必须 markdown —— 官方：按钮只能挂在 markdown 消息上。
          const res = await bot.sendC2C(openId, formatQuestion(questions, {
            project: projectOf(request?.agent),
            session: sessionTitleOf(request?.agent),
          }), {
            markdown: true,
            keyboard: buildOptionKeyboard(questions),
          })
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

  // ── 远程更新（查新版本 / 装新版本 / 重启 DSH）──────────────────────────────
  //
  // 三段：①启动查一次 + 每 qqUpdateCheckHours 小时查一次，有新版就推一条（同一个版本只推一次）；
  //      ②QQ 发 `/update` 就装新版，装完自动重启 DSH；③重启后靠状态文件里的标记回一条确认。
  //
  // 🔴 为什么必须重启：DSH **没有插件热重载** —— 插件代码是主进程启动时加载进内存的，
  //    换掉磁盘上的文件对已经跑着的进程毫无影响。所以"装完"和"生效"之间隔了一次重启。

  /** 轮询定时器；null = 没开。 */
  let updateTimer = null
  /** 正在查（防止定时器和手动检查叠在一起）。 */
  let updateChecking = false
  /** 正在装（同一时刻只允许一个安装；两个 pnpm 同时改一个 profile 会互相踩）。 */
  let updating = false

  /**
   * 读**现在跑着的这份代码**的版本号。读不到返回空串。
   *
   * ⚠️ 直接返回模块加载时读到的 {@link RUNNING_VERSION}，**不要**在这里现读磁盘 ——
   * 那样在"装完还没重启"的窗口里会读到新版，插件就以为自己已经是最新版了（说明见 RUNNING_VERSION）。
   */
  function ownVersion() {
    return RUNNING_VERSION
  }

  /**
   * 把"更新要用的环境"一次凑齐：更新源、自己装在哪个 profile、当前版本。
   * 任何一项不成立都返回 `{ok:false, reason}`（人话），由调用方回给用户 —— 绝不猜。
   */
  function updateEnv() {
    const cfg = liveConfig()
    const source = String(cfg.qqUpdateSource ?? '').trim() || DEFAULT_UPDATE_SOURCE
    const parsed = parseUpdateSource(source)
    if (!parsed.ok) return { ok: false, reason: parsed.error }
    const profile = resolveProfileFromPluginFile(SELF_FILE)
    if (!profile) {
      return { ok: false, reason: `我看不出自己是装在哪个 profile 里的（我的位置：${SELF_FILE}）` }
    }
    const version = ownVersion()
    if (!version) return { ok: false, reason: '读不到自己的版本号（package.json 不在预期位置）' }
    return { ok: true, cfg, parsed, profile, version }
  }

  /**
   * 给 QQ 发一条**主动**消息（新版本提醒 / 重启确认）。
   *
   * 与 `notify` 的区别：这里不套通知模板、不写 notes、不带会话 —— 发的是完整一句话。
   * 永不 reject，发不出去只记日志并返回 false。
   */
  async function sendProactive(text, { buttons = null } = {}) {
    const cfg = liveConfig()
    if (cfg.qqEnabled !== true) return false
    if (!(await ensureStarted())) return false
    ensureState(cfg)
    const openId = state.data.openId
    if (!openId) {
      l('还没有你的 open_id，这条消息发不出去（请先在 QQ 里给机器人发条消息）')
      return false
    }
    try {
      // 没按钮时 markdown: false —— 内容里有 `/update` 这种字面量，纯文本最稳、也不会被平台改写。
      // 有按钮时按钮自己会把这条消息顶到 markdown 通路上（官方：按钮只能挂在 markdown 上）。
      const res = await bot.sendC2C(openId, text, buttons
        ? { keyboard: buttons }
        : { markdown: false })
      // 登记 ref_idx 但**不带 sessionId**：它不属于任何会话，不该被"引用兜底"路由到某个会话里去。
      state.addSentRef(res?.ext_info?.ref_idx, { kind: 'update' })
      return true
    } catch (err) {
      const hint = QqBotClient.explainError(err.code)
      l(`更新消息发送失败：${err.message}${hint ? ` —— ${hint}` : ''}`)
      return false
    }
  }

  /** 查版本用的超时：取配置与专用上限里更小的那个（检查要轻，别拖住后面的轮询）。 */
  function checkTimeout(cfg) {
    const configured = Number(cfg?.timeoutMs)
    return Number.isFinite(configured) && configured > 0
      ? Math.min(configured, UPDATE_CHECK_TIMEOUT_MS)
      : UPDATE_CHECK_TIMEOUT_MS
  }

  /**
   * 查一次新版本；**有新版且这个版本还没提醒过**才发一条 QQ。
   *
   * 三种"安静"是刻意的：没新版不发（不每天骚扰）、发失败不标记已通知（下次还会再试）、
   * 任何异常只记日志（更新检查绝不能影响 agent 主流程）。
   *
   * @returns {Promise<{ok: boolean, notified?: boolean, latest?: string, current?: string, reason?: string}>}
   */
  async function checkUpdate() {
    const cfg = liveConfig()
    if (updateChecking) return { ok: false, reason: 'busy' }
    // `qqUpdateEnabled` 是"要不要在 QQ 里提醒"；`qqNotifyEnabled` 是"先别推提醒我"的
    // 总闸 —— 后者关着时也不推（否则"静音一会儿"就成了假动作）。手动 /update 不受这两个影响。
    if (cfg.qqUpdateEnabled === false) return { ok: false, reason: 'disabled' }
    if (cfg.qqEnabled !== true) return { ok: false, reason: 'qq-disabled' }
    if (cfg.qqNotifyEnabled === false) return { ok: false, reason: 'notify-disabled' }

    const env = updateEnv()
    if (!env.ok) {
      l(`更新检查跳过：${env.reason}`)
      return { ok: false, reason: env.reason }
    }

    updateChecking = true
    try {
      const got = await fetchLatestVersion({
        source: env.parsed.spec, timeoutMs: checkTimeout(env.cfg), log: l,
      })
      if (!got.ok) return { ok: false, reason: got.error }
      // 三个分支都要分清（实测过远端比本机**旧**的情况：本机 1.0.6、GitHub 那份 1.0.5）：
      // `>` 才提醒；`===` 静默（不打扰）；`<` 也静默（否则会一直喊"有新版本"然后什么都不做）。
      const cmp = compareVersions(got.version, env.version)
      if (cmp === 0) {
        l(`已是最新版 ${env.version}`)
        return { ok: true, notified: false, latest: got.version, current: env.version }
      }
      if (cmp < 0) {
        l(`远端 ${got.version} 比本机 ${env.version} 旧，不用更新`)
        return { ok: true, notified: false, latest: got.version, current: env.version, remoteOlder: true }
      }
      ensureState(env.cfg)
      // 主人点过「忽略本次」的版本：安静。比 updateNotified 更明确 —— 日志里能看出是"人说的别提醒"。
      if (state.data.updateSkipped === got.version) {
        l(`新版本 ${got.version} 主人选过「忽略本次」，不再提醒`)
        return { ok: true, notified: false, latest: got.version, current: env.version, skipped: true }
      }
      if (state.data.updateNotified === got.version) {
        l(`新版本 ${got.version} 已经提醒过，不再重复打扰`)
        return { ok: true, notified: false, latest: got.version, current: env.version }
      }
      const sent = await sendProactive(formatUpdateAvailable({
        latest: got.version, current: env.version, notes: got.notes,
      }), {
        buttons: buildUpdateNoticeKeyboard(),
      })
      if (sent) {
        state.set({ updateNotified: got.version })
        l(`已提醒新版本 ${got.version}（当前 ${env.version}）`)
      }
      return { ok: true, notified: sent, latest: got.version, current: env.version }
    } catch (err) {
      // 兜底：更新检查是"顺手做的事"，任何异常都不许冒到外面去。
      l(`更新检查出错（已忽略）：${err?.message ?? err}`)
      return { ok: false, reason: String(err?.message ?? err) }
    } finally {
      updateChecking = false
    }
  }

  /**
   * 启动时查一次，之后每 `qqUpdateCheckHours` 小时查一次。重复调用无副作用。
   * 定时器 `unref()`：不能让一个后台检查把进程吊着不退出。
   */
  function startUpdateCheck() {
    const cfg = liveConfig()
    if (cfg.qqUpdateEnabled === false) {
      l('远程更新提醒已关闭（qqUpdateEnabled=false），不查新版本')
      return false
    }
    // 启动这一次检查**必须补一次重试**：插件 apply 的那一刻配置可能还没就绪
    // （`qqEnabled` 来自 profile 补丁层 / settings，apply 时可能还停在 DEFAULTS 的 false），
    // 这时 `checkUpdate()` 直接返回 'qq-disabled' 就收工 —— 下一次机会要等一整个轮询周期。
    // 表现就是"新版本永远不提醒"，而主人 2026-10-07 报的正是这个。
    let lateRetries = 0
    const runCheck = async () => {
      const result = await checkUpdate()
      if (result?.reason === 'qq-disabled' && lateRetries < UPDATE_LATE_RETRY_MAX) {
        lateRetries += 1
        l(`配置还没就绪（qqEnabled 还没读到），${UPDATE_LATE_RETRY_MS / 1000} 秒后补查一次`
          + `（第 ${lateRetries}/${UPDATE_LATE_RETRY_MAX} 次）`)
        const timer = setTimeout(() => { void runCheck() }, UPDATE_LATE_RETRY_MS)
        if (timer.unref) timer.unref()
      }
    }
    void runCheck()
    if (updateTimer) return true
    // ⚠️ 这里的兜底值必须跟 `DEFAULTS.qqUpdateCheckHours` 一致（1 小时，1.0.20 从 6 改的）：
    //    自动提醒只在"启动时 + 每 N 小时"发，N 太大时，两跳之间发布的版本要等很久才提醒 ——
    //    主人 2026-10-07 遇到的就是这个（10:22 启动时线上还是 1.0.18，11:14 才发出 1.0.19）。
    //    同一个版本只提醒一次（updateNotified），所以查得勤不会变吵。
    const hours = Number.isFinite(cfg.qqUpdateCheckHours) && cfg.qqUpdateCheckHours > 0
      ? cfg.qqUpdateCheckHours
      : 1
    updateTimer = setInterval(() => { void checkUpdate() }, hours * 60 * 60 * 1000)
    if (updateTimer.unref) updateTimer.unref()
    l(`远程更新：每 ${hours} 小时查一次新版本（源 ${cfg.qqUpdateSource || DEFAULT_UPDATE_SOURCE}）`)
    return true
  }

  /** 停掉轮询（卸载时调用）。 */
  function stopUpdateCheck() {
    if (updateTimer) clearInterval(updateTimer)
    updateTimer = null
  }

  /**
   * 插件启动时：状态文件里若有"刚更新完、正要重启"的标记，就回一条确认。
   *
   * ⚠️ 先清标记再发消息：发失败也不能让**每次**启动都重复回一条。
   * 返回是否真的发出去了（供日志/测试观察）。
   */
  async function reportRestartIfPending() {
    try {
      const cfg = liveConfig()
      ensureState(cfg)
      const mark = state.data.updateRestart
      if (!mark || typeof mark !== 'object') return false
      state.set({ updateRestart: null })
      const version = String(mark.version ?? '').trim() || ownVersion()
      const seconds = Math.max(0, (Date.now() - Number(mark.at ?? Date.now())) / 1000)
      if (cfg.qqEnabled !== true) {
        l(`已清掉重启标记（QQ 没开，不发确认；版本 ${version}）`)
        return false
      }
      const sent = await sendProactive(formatRestartDone({ version, seconds }))
      l(`重启确认：${sent ? '已发到 QQ' : '没发出去'}（版本 ${version}，重启用时 ${Math.round(seconds)} 秒）`)
      return sent
    } catch (err) {
      l(`重启确认出错（已忽略）：${err?.message ?? err}`)
      return false
    }
  }

  /**
   * 真正执行安装：拼命令 → 跑子进程（输出重定向到临时文件）→ 读回装完的版本。
   *
   * `spec` 是这次要装的地址：索引源下来自远端索引（`got.spec`），github / npm 源下
   * 就是配置里那个字符串。**必须用查到的那个** —— 拿索引地址（一份 JSON）去
   * `pnpm add` 是装不上的。
   * 永不抛。
   */
  async function installUpdate({ env, latest, spec, sha256, size }) {
    const target = String(spec || env.parsed.spec || '').trim()
    // 🔴 从 http(s) 直接下载的包：**先在本机校验 sha256，再交给 pnpm 装**（2026-10-07 安全审查）。
    //
    // 为什么非得自己算一遍：索引（update.json）与压缩包是两份文件，可以**一起**被换掉，
    // 索引里自报的 sha256 因此不构成证据 —— 只有在本机重新算出来的摘要才算。校验通过后
    // 用**本地文件**当安装源，pnpm 不再去网上取那份没验过的包。
    // github: / npm 名这类源走 pnpm 自己的完整性校验，这里不插手（也不该插手）。
    let installSpec = target
    let verifiedFile = ''
    if (/^https?:\/\//i.test(target)) {
      const verified = await fetchAndVerifyPackage({ url: target, sha256, size, log: l })
      if (!verified.ok) {
        l(`拒绝安装 ${latest}：${verified.error}`)
        return { ok: false, reason: verified.error, run: null }
      }
      installSpec = verified.file
      verifiedFile = verified.file
      l(`安装包校验通过（${verified.bytes} 字节，sha256 ${String(verified.sha256).slice(0, 16)}…），改用本地文件安装`)
    }
    try {
      const cmd = buildAddCommand({ profile: env.profile.profileName, spec: installSpec })
      if (!cmd.ok) return { ok: false, reason: cmd.error, run: null }
      const logFile = path.join(os.tmpdir(), `dsh-remote-update-${Date.now()}.log`)
      l(`开始更新到 ${latest}：${cmd.display}（输出 → ${logFile}）`)
      const run = await runProcess({
        file: cmd.file,
        args: cmd.args,
        cwd: cmd.cwd,
        env: cmd.env,
        timeoutMs: UPDATE_INSTALL_TIMEOUT_MS,
        logFile,
        log: l,
      })
      // 版本号从**安装目录**读，不从"命令成功"推断 —— 命令可能成功但什么都没装
      // （pnpm 的 `Already up to date` 就是这种情况：exit 0、文件没换）。
      const installed = installedVersionOnDisk(env.profile.profileDir)
      return { ok: run.ok, run, installed, reason: '' }
    } finally {
      // 校验用的临时包：装完就删（`pnpm add <本地 tgz>` 是把它解包进 node_modules，
      // 不依赖这个文件继续存在）。删失败只记日志，绝不因此把"装成功"说成失败。
      if (verifiedFile !== '' && !removeVerifiedPackage(verifiedFile)) {
        l(`临时包没能删掉（不影响安装结果）：${verifiedFile}`)
      }
    }
  }

  /**
   * 桌面版主进程的可执行文件：优先环境变量 `DSH_DESKTOP_EXE`，否则从**当前进程的
   * 命令行**里认（主进程 argv 里就有那个 exe 的绝对路径，本机实测过）。
   *
   * 为什么不写死一个路径：写死的只对一台机器成立，换台机器就是"杀不掉、也起不来"。
   * 认不出来就返回空串 —— 调用方据此**不做自动重启**（web 版 / 纯 node 版只能手动重启）。
   */
  function desktopExe() {
    const fromEnv = String(process.env.DSH_DESKTOP_EXE ?? '').trim()
    if (fromEnv !== '') return fromEnv
    return parseDesktopRuntime(process.argv).exe
  }

  /**
   * 写标记 → 写脚本 → 分离启动。
   *
   * 顺序不能变：**标记必须在拉起脚本之前落盘** —— 脚本起来 10 秒后就会杀掉 DSH，
   * 那之后这个进程再也没有机会写任何文件。
   */
  async function restartDSH({ version }) {
    try {
      const cfg = liveConfig()
      const exe = desktopExe()
      if (exe === '') {
        l('认不出桌面版主程序在哪，不自动重启（装好了，重启 dsh 后生效）')
        return false
      }
      const logFile = path.join(homeDir(), '.dsh', UPDATE_LOG_FILE_NAME)
      const script = buildRestartScript({ exePath: exe, logFile, note: `更新到 ${version}` })
      const written = writeRestartScript({ script })
      if (!written.ok) {
        l(`重启没排上：${written.error}`)
        return false
      }
      // 多写一个 .cmd 启动器：直接 spawn powershell + detached 时脚本**一行都不执行**
      // （本机四种配方差分实测），`cmd /c start` 才既跑得起来、又活得过父进程。
      const launcher = writeRestartLauncher({ scriptPath: written.path })
      if (!launcher.ok) l(`启动器没写成，退回直接启动：${launcher.error}`)
      const before = restartLogSize(logFile)
      ensureState(cfg)
      state.set({ updateRestart: { version, at: Date.now() } })
      const spawned = launchRestartScript({
        scriptPath: written.path,
        launcherPath: launcher.ok ? launcher.path : '',
        log: l,
      })
      // "进程建出来了"不等于"脚本在跑"：脚本第一件事就是往日志里写一行，
      // 所以等它真写下第一行才算排定成功。这段等待落在脚本自己的 10 秒延迟之内。
      const running = spawned && await verifyRestartLaunched({ logFile, before })
      l(running
        ? `已排定重启：${RESTART_DELAY_SECONDS} 秒后重启 ${exe}（脚本 ${written.path}）`
        : '重启脚本没能真正跑起来，需要手动重启 DSH 才生效')
      return running
    } catch (err) {
      l(`排定重启失败（已忽略）：${err?.message ?? err}`)
      return false
    }
  }

  /**
   * QQ 发 `/update`（`checkOnly=true` 是 `/update check`）。
   *
   * 步骤与文案都在这里定死：先回执 → 查版本 → 该回的四种"没问题"各自回一句 →
   * 装 → 按**安装目录里真实的版本号**决定说成功还是"没变化" → 排定重启。
   * 任何一步失败都只回一句人话 + 错误摘要，绝不抛进事件处理主流程。
   */
  /**
   * 「忽略本次」（`/skip`，也就是新版本提醒下面那个按钮）。
   *
   * 记的是 `updateNotified` 里那个版本 —— 那是**刚提醒过、主人正看着的那一版**。
   * 这里**故意不再查一次远端**：忽略只针对眼前这条提醒，多一次网络请求只会让回执更慢，
   * 而且真查出来一个更新的版本，反而会让"忽略"这件事变得含糊。
   *
   * 注意它只影响"提不提醒"，不影响 `/update` —— 想装随时能装。
   */
  async function handleUpdateSkip(data) {
    const cfg = liveConfig()
    ensureState(cfg)
    const pending = String(state.data.updateNotified ?? '').trim()
    if (!pending) {
      await replyPassive(data, formatNothingToSkip({ current: ownVersion() }))
      return
    }
    if (state.data.updateSkipped === pending) {
      await replyPassive(data, `好，${pending} 这版本来就不提醒了。想装发 /update。`)
      return
    }
    state.set({ updateSkipped: pending })
    await replyPassive(data, formatUpdateSkipped({ version: pending }))
    l(`已忽略新版本 ${pending}：不再提醒（/update 仍可安装）`)
  }

  /**
   * 「磁盘上装了新版、内存里跑的还是旧版」：回主人一句人话，能自动重启就顺手重启。
   *
   * 与安装路径共用同一套重启机制（写标记 → 写脚本 → 分离启动），所以**回执必须先发**：
   * 脚本 10 秒后会杀掉这个进程，发晚了就发不出去了。
   */
  async function replyPendingRestart({ env, installed, data }) {
    const wantRestart = env.cfg.qqUpdateAutoRestart !== false
    const canRestart = wantRestart && desktopExe() !== ''
    l(`磁盘上已装 ${installed}，现在跑的是 ${env.version}：`
      + (canRestart
        ? '自动重启'
        : (wantRestart ? '认不出桌面版主程序，只能手动重启' : 'qqUpdateAutoRestart 关着，只能手动重启')))
    const launched = canRestart ? await restartDSH({ version: installed }) : false
    await replyPassive(data, formatPendingRestart({
      running: env.version, installed, autoRestart: wantRestart, scheduled: launched,
    }))
  }

  async function handleUpdate(checkOnly, data) {
    const env = updateEnv()
    if (!env.ok) {
      l(`/update 不能执行：${env.reason}`)
      await replyPassive(data, formatUpdateMisconfigured({ reason: env.reason }))
      return
    }

    // ⓪ 磁盘比内存新：装是装过了，只是这份进程还在跑旧代码。
    //
    // DSH 没有插件热重载 —— 换掉磁盘上的文件对已经跑着的进程毫无影响，**只有重启**才换得过来。
    // 这是旧版插件最容易骗人的一格：跑 1.0.18、磁盘上已是 1.0.20 时，它会现读磁盘版本号，
    // 于是回一句「已经是最新版 1.0.20，不用更新」，把"装了但没生效"说成"你不用更新"，
    // 主人于是既看不到新功能、也没有任何按钮可点（2026-10-07 15:2x 的主人正是这样被卡住的）。
    // 这一格必须**排在版本比较之前**：磁盘上那份才是"将要生效"的那份。
    const diskVersion = installedVersionOnDisk(env.profile.profileDir)
    if (diskVersion && compareVersions(diskVersion, env.version) > 0) {
      await replyPendingRestart({ env, installed: diskVersion, data })
      return
    }

    const got = await fetchLatestVersion({
      source: env.parsed.spec, timeoutMs: checkTimeout(env.cfg), log: l,
    })
    if (!got.ok) {
      await replyPassive(data, formatCheckFailed({ error: got.error }))
      return
    }
    // 三个分支必须分清，**绝不能"版本不一样就装"** —— 远端比本机旧时那样做等于把用户降级。
    const cmp = compareVersions(got.version, env.version)
    if (cmp === 0) {
      // 这句话必须自带证据：主人 2026-10-07 就是被「已经是最新版 X」这句单独出现的结论骗到的
      // （跑 1.0.18、磁盘 1.0.20）。现在把"跑的是哪一版、磁盘上装的是哪一版"一起写出来。
      await replyPassive(data, formatAlreadyLatest({
        current: env.version, installed: diskVersion,
      }))
      return
    }
    if (cmp < 0) {
      l(`/update：远端 ${got.version} 比本机 ${env.version} 旧，不装`)
      await replyPassive(data, formatRemoteOlder({ latest: got.version, current: env.version }))
      return
    }
    if (checkOnly) {
      // 主人 2026-10-07：「有新版本，并没有给我的 QQ 机器人推送通知，我也没办法选择
      // 立即更新，或者是忽略此版本」。
      //
      // 自动提醒只在"启动时 + 每 qqUpdateCheckHours 小时"这两个时刻发 —— 新版本要是
      // 刚好在两跳之间发布（这次正是：10:22 启动时线上还是 1.0.18，11:14 才发出 1.0.19），
      // 最长要等一整轮才提醒。所以**手动查的这一次也把同一条提醒连同两个按钮回过去**：
      // 就地回在你发的那条下面，比再单独推一条更直接，忽略 / 立即更新两个按钮一样在。
      ensureState(env.cfg)
      const skipped = String(state.data.updateSkipped ?? '').trim() === got.version
      const notice = formatUpdateAvailable({ latest: got.version, current: env.version, notes: got.notes })
      await replyPassive(
        data,
        skipped
          ? `${notice}\n（这一版你点过「忽略本次」—— 这是你手动查的，所以照样给你看。）`
          : notice,
        undefined,
        buildUpdateNoticeKeyboard(),
      )
      // 记账：这一版已经让主人看过带按钮的提醒了，几小时后的自动检查别再重复推一遍。
      state.set({ updateNotified: got.version })
      l(`/update check：有新版本 ${got.version}（当前 ${env.version}），已把提醒与按钮回过去`)
      return
    }
    if (updating) {
      await replyPassive(data, formatUpdateBusy())
      return
    }

    // 先回执：安装可能要几分钟，主人得先看到"我收到了"，而不是一片安静。
    await replyPassive(data, formatUpdating({ version: got.version }))

    updating = true
    try {
      const result = await installUpdate({
        env, latest: got.version, spec: got.spec, sha256: got.sha256, size: got.size,
      })
      if (!result.ok) {
        const reason = result.run?.timedOut
          ? `安装命令超过 ${Math.round(UPDATE_INSTALL_TIMEOUT_MS / 1000)} 秒没结束（已终止）`
          : (result.reason || `安装命令失败（退出码 ${result.run?.code ?? '?'}）`)
        l(`更新到 ${got.version} 失败：${reason}`)
        await replyPassive(data, formatUpdateFailed({ reason, output: result.run?.output ?? '' }))
        return
      }
      // 命令成功 ≠ 真的换了版本：pnpm 在同版本同依赖时会打 `Already up to date` 然后 exit 0。
      // 所以这里用安装目录里读回来的版本号说话，不拿"成功"当结论。
      if (!result.installed || result.installed === env.version) {
        l(`安装命令成功，但安装目录里的版本还是 ${result.installed || env.version}`)
        await replyPassive(data, formatUpdateNoChange({ version: result.installed || env.version }))
        return
      }

      // 自动重启的两个前提：配置允许 **且** 认得出桌面版主程序在哪。
      // 认不出来时（web 版 / 纯 node 版）绝不能杀进程 —— 那会把别人的服务弄停，
      // 而且拿 node 也起不回一个服务，只能回一句"重启 dsh 后生效"。
      const wantRestart = env.cfg.qqUpdateAutoRestart !== false
      const canRestart = wantRestart && desktopExe() !== ''
      if (!wantRestart) l('qqUpdateAutoRestart 关着，只回一句"重启后生效"')
      else if (!canRestart) l('认不出桌面版主程序，只回一句"重启 dsh 后生效"')
      // 先排定重启、再回执：回执本身要占掉几百毫秒，而脚本 10 秒后就会动手。
      // 顺序反过来的话，消息可能还没发出去进程就没了。
      const launched = canRestart ? await restartDSH({ version: result.installed }) : false
      await replyPassive(data, formatUpdateDone({
        latest: result.installed, from: env.version, autoRestart: wantRestart, scheduled: launched,
      }))
    } catch (err) {
      // 兜底：onEvent 里还有一层，但这里把话说得更具体一点。
      l(`更新过程出错：${err?.message ?? err}`)
      await replyPassive(data, formatUpdateFailed({ reason: String(err?.message ?? err), output: '' }))
    } finally {
      updating = false
    }
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  function stop() {
    started = false
    stopUpdateCheck()
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
     * 查一次新版本：有新版（且这个版本还没提醒过）就发一条 QQ，没新版**一个字都不发**。
     *
     * 由 index.js 在启动时调用一次、之后由 {@link startUpdateCheck} 的定时器按小时调用。
     * 永不 reject。
     *
     * @returns {Promise<{ok: boolean, notified?: boolean, latest?: string, current?: string, reason?: string}>}
     */
    checkUpdate,
    /** 启动检查 + 每 `qqUpdateCheckHours` 小时轮询一次；重复调用无副作用。 */
    startUpdateCheck,
    /**
     * **内存里跑着的**插件版本号（模块加载时读的，见 {@link RUNNING_VERSION}）。
     *
     * 给界面「运行状态」用：它和 {@link installedVersion} 不一致，就说明"装完还没重启"。
     */
    runningVersion: () => ownVersion(),
    /** **磁盘上装好的**插件版本号；读不出来返回空串。 */
    installedVersion: () => installedVersionOnDisk(),
    /** 停掉轮询（卸载时调用）。 */
    stopUpdateCheck,
    /**
     * 启动时若状态文件里有「刚更新完、正在重启」的标记，给 QQ 回一条确认并清掉标记。
     *
     * ⚠️ 必须在 `ensureStarted()` 之后调用 —— 它要用 QQ 通道发消息。
     *
     * @returns {Promise<boolean>} 确认是否真的发出去了。
     */
    reportRestartIfPending,
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
    /**
     * 记下「每个 agent 上次已知的状态」，落盘到 `qq-bot-state.json`。
     *
     * 由 index.js 在每次 `agent/status` 变化时调用。存在的唯一理由：判断"这一轮跑完了"
     * 用的是 `running → idle` 这个**边**，而边只活在内存里 —— 插件中途重装或 DSH 中途重启，
     * 边就没了，"跑完了"的通知和 agentmd 日志会一起静默消失（2026-10-05 事故）。
     * 落盘之后 {@link agentStatusMap} 能把起点读回来。
     *
     * @param {string} agentId
     * @param {string} status - 只认 `running` / `idle`。
     */
    markAgentStatus(agentId, status) {
      try {
        ensureState(liveConfig())
        state?.markAgentStatus?.(agentId, status)
      } catch { /* 存不下不影响主流程 */ }
    },
    /**
     * 读回落盘的「每个 agent 上次已知状态」，`{ [agentId]: { s, at } }`。
     * 插件加载时调一次：没有这一步，中途重启过的那一轮就再也认不出"它刚才在跑"。
     *
     * @returns {Record<string, {s?: string, at?: number}>}
     */
    agentStatusMap() {
      try {
        ensureState(liveConfig())
        const map = state?.agentStatusMap?.()
        if (map && typeof map === 'object') return map
        return Object.freeze({})
      } catch {
        return Object.freeze({})
      }
    },
    /** 供自检/测试观察。 */
    get pendingCount() { return pendingAsks.size },
    get ready() { return Boolean(bot?.ready) },
    get lastStartError() { return lastStartError },
  }
}
