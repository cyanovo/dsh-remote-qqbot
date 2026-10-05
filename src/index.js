/**
 * dsh-remote-qqbot —— DSH 定制插件
 *
 * 六件事：
 *   1. 任务完成（agent/status: running → idle）时推送到手机
 *   2. 需要你回答问题时（拦截 ask_user_question）推送到手机
 *   3. 执行出错（agent/error）时推送到手机
 *   4. 提供跨会话持久化记忆：memory_write / memory_read / memory_forget
 *   5. 会话结束时把本轮摘要自动追加到 agentmd/main.md 的「四、操作日志」表格
 *   6. 把 agentmd/main.md 全文注入会话上下文（systemPrompt.context），并提供
 *      agentmd_read 只读工具作为兜底
 *
 * 为什么用原生 fetch 而不是借道 shell + curl：
 *   pwsh 里 `curl` 是 Invoke-WebRequest 的别名，不认 curl 的参数；
 *   且中文经命令行传参会按本地代码页编码而乱码。正式插件跑在 Node 进程里，
 *   直接用内置 fetch 既简单又可靠。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
// schemastery 是插件 Config 的必需形态（见下方 Config 注释），宿主 profile 里可解析到。
import z from '@deepseek-ai/schemastery'

import {
  appendLogEntry,
  readDoc,
  buildContextDoc,
  DEFAULT_CONTEXT_MAX_CHARS,
  DEFAULT_CONTEXT_TAIL_ROWS,
  DEFAULT_ROW_MAX_CHARS,
} from './agentmd.js'
import { installCollab } from './collab.js'
import { mountConfigApi } from './config-api.js'
import { createQqRuntime } from './qqruntime.js'
import { formatQuestionBody, qqPreviewUrl } from './qqbridge.js'
import { composeChatAnswer, composeChatSummary, composeSummary, extractTurnSummary, inferResult } from './summary.js'
import { publishNote, renderNote } from './notes.js'
import {
  CLOUD_POLL_INTERVAL_S,
  cloudDevicePoll,
  cloudDeviceStart,
  cloudMe,
  cloudPublishNote,
  describeAccount,
  normalizeCloudUrl,
  qqLinkWarning,
} from './cloud.js'
import { filterPatch, overrideFilePath, persistConfigPatch, readOverrides } from './overrides.js'
import {
  FULLTEXT_MODES,
  fulltextModeLabel,
  normalizeFulltextMode,
  planQqFulltext,
  showsFulltextLink,
  uploadsFulltext,
} from './fulltext.js'

/** 注入到 system prompt 的上下文条目名（全局唯一，重复注册会报错）。 */
const AGENTMD_CONTEXT_NAME = 'remote-qqbot:agentmd'

/**
 * {@link readDoc} 的同步版本：systemPrompt 的 text provider 必须是同步的，
 * 因此在组装提示词的那一瞬间直接同步读盘。
 * @param {string} dir - agentmd 目录。
 * @param {string} file - 相对文件名。
 * @returns {{ ok: true, text: string, path: string } | { ok: false, reason: string, path?: string }} 读取结果。
 */
function readDocSync(dir, file) {
  if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, reason: 'agentmdDir 未配置' }
  const path = join(dir.trim(), typeof file === 'string' && file.trim() !== '' ? file.trim() : 'main.md')
  try {
    return { ok: true, text: readFileSync(path, 'utf8'), path }
  } catch (err) {
    return { ok: false, reason: `读取失败: ${err?.message ?? err}`, path }
  }
}

/** 配置命名空间，与 settings.yaml 中的键一致。 */
export const SETTINGS_NS = 'dsh-remote-qqbot'

/**
 * 最近一次启动自检算出的「运行状态」清单（见 reportStatus 里的 statusLines）。
 *
 * 主人 2026-10-03 要求启动日志只留「QQ 提醒 / 协作」两行，其余挪进设置面板；
 * 那么「配置到底有没有读进来」就不能再靠翻日志来判断了 —— 这个快照就是那个
 * 判断依据：**它现在是设置面板显示的同一份数据**。
 *
 * ⚠️ 名字里带 Snapshot：`apply()` 内部另有一个 `const lastStatus`（活动状态表），
 *    同名会撞成 "Assignment to constant variable"（实测踩过）。
 *
 * @type {Array<{label: string, value: string, warn?: boolean}>}
 */
let lastStatusSnapshot = []

/**
 * 读最近一次自检的运行状态（只读快照）。
 * 给测试与手工排查用；界面走的是 `/remote-qqbot/api/config` 里的 `status` 字段。
 */
export function lastStatusLines() {
  return lastStatusSnapshot
}

/**
 * 默认配置。用户只需在 ~/.dsh/settings.yaml 覆盖想改的字段：
 *
 *   dsh-remote-qqbot:
 *     hubUrl: https://你的服务器/dsh
 *     token: 你的令牌
 */
/**
 * 出厂默认值（**一律留空 = 功能关闭**）。
 *
 * 🔴 这些默认值**不能**填成真实的生产配置：`DEFAULTS` 同时被单元测试使用，
 *    一旦这里有了真实的 `hubUrl` / `qqAppId`，跑测试就会**真的向线上中枢发请求、
 *    甚至真的给主人推 QQ 通知**（2026-10-02 踩到：测试套直接挂死）。
 *
 * 所以真实配置一律只从 `~/.dsh/settings.yaml` 读；这个文件丢了会「什么都没配置」，
 * 由下面的启动自检**明确报警**，而不是在代码里藏一份悄悄生效的副本。
 */
const DEFAULTS = {
  /** 中枢服务地址；留空则只记日志、不发请求。 */
  hubUrl: '',
  /** Bearer 令牌，与中枢的 DSH_HUB_TOKEN 一致。 */
  token: '',
  /** 单次请求超时（毫秒）。 */
  timeoutMs: 10000,
  /** 各事件开关。 */
  onTurnComplete: true,
  onQuestion: true,
  onError: true,
  /**
   * 子智能体（teammate / 子任务）的通知开关，默认**关**。
   *
   * 一个主会话回合常常派生好几个子智能体，每个跑完都推一条，会把真正要看的那条
   * 「主会话跑完了」淹没。所以默认只通知你自己的会话；子智能体的完成/提问/出错静默。
   */
  notifySubagents: false,
  /**
   * 「闲聊会话」完成时是否推送通知，默认**关**。
   *
   * 什么叫闲聊会话：你在 QQ 里**不引用任何消息**、直接说一句话时，插件把它送进
   * 一个独立的"闲聊会话"（而不是任何工作会话）。那时你人就在 QQ 里等着回复，
   * 再推一条"跑完了"纯属打扰 —— 所以默认不推，只看对话本身。
   */
  notifyChatSession: false,
  /** 同一内容在此毫秒数内不重复推送。 */
  dedupeMs: 4000,
  /** 出错摘要最大长度。 */
  errorSummaryChars: 300,
  /** agentmd 目录绝对路径；留空则关闭自动日志。 */
  agentmdDir: '',
  /** agentmd 主文档文件名（相对 agentmdDir）。 */
  agentmdMainFile: 'main.md',
  /** 是否把主文档全文注入会话上下文。 */
  agentmdInject: false,
  /** 追加日志时「本轮做了什么」的最大字符数。 */
  agentmdSummaryChars: 200,
  /** 是否在会话结束时自动追加操作日志。 */
  agentmdAppendLog: true,
  /**
   * 注入上下文的**字符硬上限**。
   *
   * 🔴 这条是防爆上下文的关键：文档会被注入每一个模型步骤，如果没有上限，
   * 任何一次“往文档里贴一大段”都会让每一步的 prompt 膨胀（上游会直接回 413）。
   * 超限时按「先保 §四 最近几行日志，再保前面的正文，被丢掉的部分明写省略了多少字符」压。
   */
  agentmdInjectMaxChars: DEFAULT_CONTEXT_MAX_CHARS,
  /** 注入上下文时保留的日志表最后行数。 */
  agentmdInjectTailRows: DEFAULT_CONTEXT_TAIL_ROWS,
  /** 单条操作日志行的字符上限（超长时裁「操作」列，表格结构不动）。 */
  agentmdRowMaxChars: DEFAULT_ROW_MAX_CHARS,

  // ── 协作模式（同一工作区下的多个会话自动协作）────────────────────────────
  /**
   * 总开关，**默认开**。
   *
   * 同一个工作区里开了几个会话，它们会自动互相同步「谁在写哪个文件、给谁留了话」。
   * 靠的是插件和所有会话**在同一个 DSH 进程里**这一事实，不需要轮询、不需要外部服务。
   *
   * 单人单会话时它的代价是零：没有任何可说的，就**不往上下文里塞一个字**。
   */
  collabEnabled: true,
  /** 协作面板文件名（写进 agentmdDir）。默认与手工版同名，等于把手工协作板接管成自动维护。 */
  collabPanelFile: 'plugin-collab.md',
  /** 协作范围：workspace = 只看同一个工作目录的会话；global = 所有会话算一个池子。 */
  collabScope: 'workspace',
  /** 是否把协作现状注入会话上下文（没有其他会话时不注入）。 */
  collabInject: true,
  /** 撞车处理：warn = 只提醒（默认）；block = 直接拒绝这次写入；off = 完全不介入。 */
  collabClaimGuard: 'warn',
  /** 文件占用的过期时间（毫秒）；会话转空闲时也会立即释放。 */
  collabClaimTtlMs: 1800000,
  /** 子智能体是否也参与协作（默认否：它是派出去的内部任务，不是你的会话）。 */
  collabIncludeSubagents: false,

  // ── QQ 官方机器人（可选；不需要公网/穿透）────────────────────────────────
  /** 总开关。关着就完全不碰网络。 */
  qqEnabled: false,
  /**
   * **远程提醒总开关**（DSH 输入框下方那个开关控制的就是它）。
   *
   * 与 `qqEnabled` 的区别：`qqEnabled` 是「通道开不开」（关掉连 QQ 长连接都不建），
   * 这个是「通道开着、但先别推提醒我」。移动中想安静一会儿时用这个：
   * 只停推送，长连接与「引用回复继续对话」都还在，随时能再打开。
   */
  qqNotifyEnabled: true,
  /**
   * 通知里「本轮结果」摘要的最大字符数。
   * 0 表示不附摘要（只发一句「跑完了」）。
   */
  qqSummaryChars: 150,
  /**
   * 闲聊会话是否强制切到**只读**权限（默认开）。
   *
   * 主人明确要求：在 QQ 里不引用任何消息地闲聊时，机器人「只能看各种状态，思考完直接在聊天框回答」，
   * 不许有任何动手改东西的能力。
   *
   * 实现方式不是"禁用工具"，而是每次给它发消息前，把这个会话的 DSH 权限预设切成 `read-only`：
   * 文件写入/删除被沙箱拒绝，读取与查看类命令照常。这样它照样能查日志、看状态、读代码，
   * 只是改不动 —— 比"把工具全禁掉"更符合"能看、能想、能答"的要求。
   *
   * ⚠️ 已知边界：沙箱管的是**本机文件系统**。如果闲聊会话用 `shell` 通过 SSH 去改**远端**主机，
   * 只读预设拦不住 —— 那需要另一层工具守卫，本轮未做。
   */
  qqChatReadOnly: true,
  /**
   * 闲聊回答是否**直接发回 QQ 聊天框**（默认开）。
   *
   * 开：闲聊会话跑完后，回答正文原样发到 QQ，不推通知卡片、不传笔记、不附链接。
   * 关：回到"推一条完成通知"的老行为（见 `notifyChatSession`）。
   */
  qqChatReply: true,
  /** 闲聊回答直接发回 QQ 时的最大字符数（超出按码点截断加省略号）。 */
  qqChatAnswerChars: 1500,
  /**
   * **完整回答怎么给你**（三档，默认 `chat`）。这是主人 2026-10-03 明确要求的三选一：
   *
   * - `chat`（**默认**）：把完整回答**直接切成几条消息发到 QQ 聊天框**，一个字都不上传。
   *   好处：不依赖服务器、不占别人的带宽、断网也能看。代价：QQ 聊天记录里会多几条长消息。
   * - `note`：只推一条摘要通知，完整回答**存在服务器上**，但**不附链接**
   *   （想看得自己上网页端找）。
   * - `note-link`：摘要通知 + 可点开的短链接（老行为）。
   *
   * ⚠️ 后两档都需要 `cloudEnabled === true`（默认 **false**）才会真的上传；
   * 否则自动退回 `chat` 的行为 —— **绝不在用户不知情的情况下把内容传给别人**。
   */
  qqFulltextMode: 'chat',
  /**
   * `chat` 档下，**一次最多往 QQ 发多少字的完整回答**（默认 6000）。
   *
   * 为什么要有个上限：模型偶尔会吐出几万字的回答，切成 QQ 消息就是几十条，
   * 把聊天窗口直接刷屏。超过这个数就截断、并在末尾留一句说明（另发一条），
   * 让使用者知道"后面还有、是被截掉的"，而不是以为回答本来就到这儿。
   *
   * ⚠️ 注意这是**内容上限**，不是单条消息长度上限 —— 单条长度由
   * `src/fulltext.js` 的 `QQ_TEXT_SAFE_CHARS`（900，保守值）控制。
   */
  qqFulltextMaxChars: 6000,
  /**
   * 是否允许把完整回答上传到**作者的中枢服务器**（换取一个可分享/可回溯的链接）。
   *
   * 默认 **关**：插件开箱即用时**一个字节都不出本机**。要用云端全文（`note` / `note-link`）
   * 必须由使用者显式打开 —— 这是「默认关闭上传」这条隐私决定的技术落地。
   */
  cloudEnabled: false,
  /**
   * **云端网页端**（dsh-web）的地址，如 `http://cyanovo.top`。
   *
   * 它与 `hubUrl` 是两个不同的东西，别混：
   * - `hubUrl` 是作者自建中枢的收件箱/公开 markdown 存储（单租户、一把共享令牌）；
   * - `cloudUrl` 是"我的账号"所在的网页端：记录挂在**你自己的账号**下，
   *   看的时候要登录、按账号算配额（免费版 100 次/天、留 5 小时；付费版 1000 次/天、留 48 小时）。
   *
   * 留空 = 不用云端，仍走 `hubUrl`（如果配了）。
   */
  cloudUrl: '',
  /**
   * 云端**账号令牌**（每账号一把，只存 sha256 在服务端）。
   *
   * 不要手填：用工具 `cloud_bind` 走设备码绑定自动写进来 ——
   * 那串 8 位短码必须由你**登录网页端后确认**才换得到令牌，
   * 所以别人拿到短码也拿不到任何权限。
   *
   * 为什么不用账号密码：插件会把配置写进磁盘上的文件，密码一旦落盘就等于把账号交出去了；
   * 令牌可以单独吊销，且换不出登录态。
   */
  cloudToken: '',
  /**
   * 是否允许在 QQ 里让我**截图给你看**（默认开）。
   *
   * 用法：QQ 聊天窗口底部菜单里的「屏幕」→ 把 `/screen` 填进输入框 → 按发送。
   * 为什么需要这个开关：截屏会把**你屏幕上的一切**发出去（可能有聊天记录、密码、别的窗口），
   * 所以给一个能一键关掉的总闸；关掉后 `/screen` 只回一句"功能已关闭"。
   */
  qqScreenEnabled: true,
  /**
   * 截图最大宽度（像素，默认 1600）。屏幕比这更宽就等比缩放 —— 手机上 1600 宽已足够看清文字。
   *
   * 这是截图**唯一的体积旋钮**。原来还有一个 `qqScreenQuality`（JPEG 质量），
   * 2026-10-02 被删掉了：自定义质量必须调 `EncoderParameters`，而「抓屏 + 编码器参数」
   * 这个组合会被 Windows Defender 的 AMSI 判定为恶意脚本、整份拦下
   * （详见 `src/screenshot.js` 文件头的实测表格）。JPEG 质量改用 GDI+ 默认值（约 75）。
   */
  qqScreenMaxWidth: 1600,
  /** QQ 开放平台的 AppID。 */
  qqAppId: '',
  /** QQ 开放平台的 ClientSecret。 */
  qqClientSecret: '',
  /** 状态文件路径（存 open_id / 专属会话 id / 去重表）；留空用 ~/.dsh/qq-bot-state.json。 */
  qqStateFile: '',
  /** 专属会话的工作目录；留空用当前进程 cwd。 */
  qqCwd: '',
  /**
   * QQ 里 `/sessions` 列几个最近在聊的会话（默认 6）。
   *
   * 为什么是 6：手机 QQ 一屏大概看这么多行；再多就得翻，而"回个数字切过去"
   * 这件事一旦需要翻页就不好用了。
   */
  qqRecentCount: 6,
  /** 本机 DSH 的 /api 地址。 */
  dshApiUrl: 'http://127.0.0.1:19387',
  /** 桌面版看到的 Host —— cookie 的 authority 必须与它完全一致。 */
  dshApiAuthority: '127.0.0.1:19387',
  /** 浏览器会话密钥；留空则从 ~/.dsh/.credentials.yaml 自动读。 */
  dshSecret: '',
  /**
   * 把本轮**完整回答**存到服务器，推送里只留摘要 + 一个短链接。
   * 关掉就退回「只发摘要」的老行为（长回答会被截断在摘要里）。
   */
  notesEnabled: true,
  /** 短链接里随机字符的长度（36^len 种可能），默认 5。 */
  notesIdLength: 5,
  /** 单篇完整回答的字符上限，超过就截断。 */
  notesMaxChars: 20000,
  /**
   * QQ 推送是否用 markdown 消息（msg_type=2）。
   *
   * 只有 markdown 能把你给的链接**折叠**成一句「查看完整回答」；
   * 纯文本只能把整个 URL 铺在屏幕上。若你的客户端显示异常，把它设成 false 即可退回。
   */
  qqMarkdown: true,
  /**
   * QQ 来的提问怎么投递给会话（依据 DSH 源码，这不是审美问题是渲染差异）：
   *   - `queue`（默认）**排队**等当前这轮跑完 → DSH 里落成 `user` 节点 =
   *     **正常的用户消息气泡**，跟你在输入框里打字一模一样；
   *   - `steer` **插话打断**当前这轮 → 立刻生效，但 DSH 把它渲染成
   *     `steering`（「插话」）节点，样式完全不同、不占正常对话位。
   */
  qqPromptMode: 'queue',

  // ── 远程更新（在 QQ 里发现新版 / 一条 /update 装上新版）────────────────────
  /**
   * 发现新版本时要不要在 QQ 里提醒，**默认开**。
   *
   * 关掉只是不提醒，`/update` 照样能用（升级这件事本身不受这个开关限制）。
   * 提醒本身是"同一个版本只发一次"的，不会变成每天骚扰。
   */
  qqUpdateEnabled: true,
  /**
   * 从哪里取新版。默认是主人自己服务器上的版本索引（一个静态 `update.json`）。
   *
   * 为什么默认走自己服务器而不是 GitHub：插件还在测试期，发一次版就在仓库里留一条提交，
   * 主人不要这种历史；而且本机到 github.com / raw.githubusercontent.com 的连接不稳。
   * 索引里带着压缩包地址，插件直接 `pnpm add <那个地址>`，Git 全程不参与。
   * 三种写法都认：https 版本索引地址、`github:作者/仓库`、npm 包名。
   */
  qqUpdateSource: 'https://cyanovo.top/plugins/dsh-remote-qqbot/update.json',
  /**
   * 更新完自动重启 DSH，**默认开**。
   *
   * 为什么必须重启才有意义：DSH **没有插件热重载**，插件代码是主进程启动时加载进内存的。
   * 代价是重启期间机器人会离线十几秒 —— 所以更新回执里会提前把这件事说明白。
   * 关掉的话就只回一句「重启 DSH 后生效」，由你自己挑时间重启。
   */
  qqUpdateAutoRestart: true,
  /** 多久查一次新版本（小时），默认 6。越小越及时，代价是多几个请求。 */
  qqUpdateCheckHours: 6,
}

/**
 * 插件配置 schema。
 *
 * ⚠️ 必须是 **schemastery** schema，不能是普通 JSON Schema：
 * Cordis 在 `resolveConfig`（vendor/cordis/src/fiber.ts:53）里调用
 * `runtime.Config['~standard'].validate(config)`。普通 JSON Schema 对象没有
 * `~standard`，会炸成 `TypeError: Cannot read properties of undefined (reading 'validate')`，
 * 导致整个插件树加载失败。这是实测踩出来的。
 *
 * 因此 @deepseek-ai/schemastery 是除 dsh-tools 之外**唯一**允许的裸包导入。
 */
export const Config = z.object({
  hubUrl: z.string().default(DEFAULTS.hubUrl).description('中枢服务地址，如 https://example.com/dsh'),
  token: z.string().default(DEFAULTS.token).description('Bearer 令牌，与中枢的 DSH_HUB_TOKEN 一致'),
  timeoutMs: z.number().default(DEFAULTS.timeoutMs).description('请求超时（毫秒）'),
  onTurnComplete: z.boolean().default(DEFAULTS.onTurnComplete).description('任务完成时推送'),
  onQuestion: z.boolean().default(DEFAULTS.onQuestion).description('需要提问时推送'),
  onError: z.boolean().default(DEFAULTS.onError).description('执行出错时推送'),
  notifySubagents: z.boolean().default(DEFAULTS.notifySubagents).description('子智能体（teammate/子任务）完成、提问、出错时是否也推送；默认 false，只推你自己的会话'),
  notifyChatSession: z.boolean().default(DEFAULTS.notifyChatSession).description('QQ「闲聊会话」完成时是否推送；默认 false（你人就在 QQ 里等着回复）'),
  dedupeMs: z.number().default(DEFAULTS.dedupeMs).description('去重窗口（毫秒）'),
  errorSummaryChars: z.number().default(DEFAULTS.errorSummaryChars).description('出错摘要最大长度'),
  agentmdDir: z.string().default(DEFAULTS.agentmdDir).description('agentmd 目录的绝对路径，例如 D:\\cyanproject\\agenttool\\agentmd；留空表示关闭自动日志'),
  agentmdMainFile: z.string().default(DEFAULTS.agentmdMainFile).description('agentmd 主文档文件名，默认 main.md'),
  agentmdInject: z.boolean().default(DEFAULTS.agentmdInject).description('是否把 agentmd 主文档注入会话上下文（需要 systemPrompt 服务）'),
  agentmdSummaryChars: z.number().default(DEFAULTS.agentmdSummaryChars).description('操作日志中「本轮做了什么」的最大字符数，默认 200'),
  agentmdAppendLog: z.boolean().default(DEFAULTS.agentmdAppendLog).description('会话结束时是否自动追加操作日志到表格'),
  agentmdInjectMaxChars: z.number().default(DEFAULTS.agentmdInjectMaxChars).description('🔴 注入上下文的字符硬上限（默认 8000）：文档再大也只注入这么多，超出的部分明写“省略约 N 字符”，防止 prompt 被顶爆'),
  agentmdInjectTailRows: z.number().default(DEFAULTS.agentmdInjectTailRows).description('注入上下文时保留的日志表最后行数，默认 20（更早的日志不注入，需要时用 agentmd_read 读全文）'),
  agentmdRowMaxChars: z.number().default(DEFAULTS.agentmdRowMaxChars).description('单条操作日志行的字符上限，默认 600（超长只裁「操作」列，表格结构不动）'),

  // ── 协作模式 ────────────────────────────────────────────────────────────
  collabEnabled: z.boolean().default(DEFAULTS.collabEnabled).description('协作模式总开关：同一工作区下的多个会话自动同步文件占用与留言（默认开）'),
  collabPanelFile: z.string().default(DEFAULTS.collabPanelFile).description('协作面板文件名（写进 agentmdDir），默认 plugin-collab.md'),
  collabScope: z.string().default(DEFAULTS.collabScope).description('协作范围：workspace（同工作目录）或 global（所有会话）'),
  collabInject: z.boolean().default(DEFAULTS.collabInject).description('是否把协作现状注入会话上下文；没有其他会话时不注入任何内容'),
  collabClaimGuard: z.string().default(DEFAULTS.collabClaimGuard).description('写冲突处理：warn（只提醒）/ block（拒绝写入）/ off（不介入）'),
  collabClaimTtlMs: z.number().default(DEFAULTS.collabClaimTtlMs).description('文件占用过期时间（毫秒），默认 30 分钟'),
  collabIncludeSubagents: z.boolean().default(DEFAULTS.collabIncludeSubagents).description('子智能体是否也参与协作，默认 false'),

  // ── QQ 官方机器人 ────────────────────────────────────────────────────────
  qqEnabled: z.boolean().default(DEFAULTS.qqEnabled).description('是否启用 QQ 官方机器人（主动私聊通知 + 反向下达任务）'),
  qqNotifyEnabled: z.boolean().default(DEFAULTS.qqNotifyEnabled).description('QQ 远程提醒总开关：关闭后仍保持长连接与反向对话，只是不再主动推送提醒'),
  qqSummaryChars: z.number().default(DEFAULTS.qqSummaryChars).description('通知里「本轮结果」摘要的最大字符数，0 表示不附摘要'),
  qqChatReadOnly: z.boolean().default(DEFAULTS.qqChatReadOnly).description('闲聊会话强制只读（能看状态、不能改东西）；默认 true'),
  qqChatReply: z.boolean().default(DEFAULTS.qqChatReply).description('闲聊回答直接发到 QQ 聊天框（不推通知卡片、不传笔记）；默认 true'),
  qqChatAnswerChars: z.number().default(DEFAULTS.qqChatAnswerChars).description('闲聊回答直接发回 QQ 时的最大字符数'),
  qqScreenEnabled: z.boolean().default(DEFAULTS.qqScreenEnabled).description('是否允许在 QQ 里发 /screen 让我截一张电脑屏幕（默认开；关掉后只回一句"已关闭"）'),
  qqScreenMaxWidth: z.number().default(DEFAULTS.qqScreenMaxWidth).description('截图最大宽度（像素），默认 1600；0 表示不缩放（这是截图唯一的体积旋钮，JPEG 质量固定用系统默认值）'),
  qqAppId: z.string().default(DEFAULTS.qqAppId).description('QQ 开放平台的 AppID'),
  qqClientSecret: z.string().default(DEFAULTS.qqClientSecret).description('QQ 开放平台的 ClientSecret'),
  qqStateFile: z.string().default(DEFAULTS.qqStateFile).description('状态文件路径，留空用 ~/.dsh/qq-bot-state.json'),
  qqCwd: z.string().default(DEFAULTS.qqCwd).description('QQ 专属会话的工作目录，留空用当前进程 cwd'),
  qqRecentCount: z.number().default(DEFAULTS.qqRecentCount).description('QQ 里 /sessions 列几个最近会话（默认 6）；回个数字就能切过去'),
  qqFulltextMode: z.string().default(DEFAULTS.qqFulltextMode).description('完整回答怎么给你：chat 直接发到 QQ 聊天框（默认，不上传）/ note 只发摘要、全文存服务器 / note-link 摘要 + 可点开的链接'),
  qqFulltextMaxChars: z.number().default(DEFAULTS.qqFulltextMaxChars).description('chat 档下一次最多往 QQ 发多少字的完整回答（默认 6000），超出会截断并另发一句说明'),
  cloudEnabled: z.boolean().default(DEFAULTS.cloudEnabled).description('是否允许把完整回答上传到作者的云端网页端（默认关；关了以后 note / note-link 会自动退回 chat 的行为）'),
  cloudUrl: z.string().default(DEFAULTS.cloudUrl).description('云端网页端地址，如 http://cyanovo.top；留空表示不用云端，仍可走 hubUrl'),
  cloudToken: z.string().default(DEFAULTS.cloudToken).description('云端账号令牌（每账号一把，只存 sha256 在服务端）；别手填，用工具 cloud_bind 走设备码绑定写入'),
  dshApiUrl: z.string().default(DEFAULTS.dshApiUrl).description('本机 DSH 的 /api 地址，默认 http://127.0.0.1:19387'),
  dshApiAuthority: z.string().default(DEFAULTS.dshApiAuthority).description('DSH 看到的 Host，cookie 的 authority 必须与它一致'),
  dshSecret: z.string().default(DEFAULTS.dshSecret).description('浏览器会话密钥；留空则从 ~/.dsh/.credentials.yaml 自动读'),

  // ── 完整回答（notes）：摘要 + 短链接 ─────────────────────────────────────
  notesEnabled: z.boolean().default(DEFAULTS.notesEnabled).description('把本轮完整回答存到服务器，推送里附一个可点开的短链接'),
  notesIdLength: z.number().default(DEFAULTS.notesIdLength).description('短链接里随机字符的长度（36^len 种可能），默认 5'),
  notesMaxChars: z.number().default(DEFAULTS.notesMaxChars).description('单篇完整回答的字符上限，超过截断'),
  qqMarkdown: z.boolean().default(DEFAULTS.qqMarkdown).description('QQ 推送用 markdown 消息（链接可折叠成文字）；关掉则退回纯文本'),
  qqPromptMode: z.string().default(DEFAULTS.qqPromptMode).description('QQ 提问的投递方式：queue 排队（像在输入框打字，默认）/ steer 插话打断当前这轮'),

  // ── 远程更新 ─────────────────────────────────────────────────────────────
  qqUpdateEnabled: z.boolean().default(DEFAULTS.qqUpdateEnabled).description('发现新版本时在 QQ 里提醒（默认开；关掉只是不提醒，/update 照样能用）'),
  qqUpdateSource: z.string().default(DEFAULTS.qqUpdateSource).description('从哪里取新版：github:作者/仓库（默认）或 npm 包名'),
  qqUpdateAutoRestart: z.boolean().default(DEFAULTS.qqUpdateAutoRestart).description('更新完自动重启 DSH（默认开；DSH 没有插件热重载，必须重启才生效，重启期间机器人离线十几秒）'),
  qqUpdateCheckHours: z.number().default(DEFAULTS.qqUpdateCheckHours).description('多久查一次新版本（小时，默认 6）'),
})

export const name = 'remote-qqbot'
/**
 * 依赖的服务。
 *
 * - `tools`：必需，插件要注册 4 个工具。
 * - `settings`：**必须在这里声明**（不是只用 ctx.inject）。
 *   因为 `ctx.inject()` 的回调是异步触发的，apply 体内同步的启动自检会先跑，
 *   那时 scope 还是空的 → 打印「配置来源：内置默认值」。
 *   写进 inject 数组能保证 apply 执行时 settings 服务已就绪，配置被真正读到。
 *
 * `systemPrompt` 只用于上下文注入，**故意不注入**——它缺失时插件仍应正常工作，
 * 由注入点自行探测（见 injectAgentmdContext）。
 */
export const inject = ['tools', 'settings']

/**
 * 值级深比较（只处理配置里会出现的 JSON 类型）。
 * 用于区分「rawConfig 里这个键是显式给的」还是「Cordis 用 schema 默认值填的」。
 */
function deepEqualJson(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqualJson(a[k], b[k]))
}

/** 从 agent 取一个人类可读的项目名（cwd 在 session.header 上，不在 agent 上）。 */
function projectOf(agent) {
  try {
    const cwd = agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd
    if (typeof cwd !== 'string' || cwd === '') return 'DSH'
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : 'DSH'
  } catch {
    return 'DSH'
  }
}

/**
 * 判断一个 agent 是不是「子智能体」（subagent / teammate / 子任务）。
 *
 * 判据取自会话头的**持久化元数据**（`SessionHeader`，见 dsh-session 的 types）：
 *   - `origin === 'subagent'`：由 subagent 服务派生的子会话，会打这个粗粒度标记；
 *   - `delegationDepth >= 1`：委派深度，根会话缺省（0），子智能体=父深度+1。
 *
 * ⚠️ **不能拿 `parentSession` 单独判断**：会话 fork（分叉）同样会写 `parentSession`，
 * 但用户 fork 出来的会话**是**他自己的会话，必须照常通知。
 *
 * 任何异常都返回 false（宁可多推一条，也不要静默漏掉主会话的通知）。
 *
 * @param {object} agent - DSH Agent。
 * @returns {boolean} true 表示这是子智能体。
 */
export function isSubagent(agent) {
  try {
    const header = agent?.session?.header
    if (!header || typeof header !== 'object') return false
    if (header.origin === 'subagent') return true
    const depth = header.delegationDepth
    return typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 1
  } catch {
    return false
  }
}

export function apply(ctx, rawConfig = {}) {
  const log = (msg) => console.log(`[remote-qqbot] ${msg}`)

  /**
   * 取会话标题（就是侧栏里显示的那个名字，例如 "main"）。
   *
   * 同时开着好几个会话时，「任务完成」不说是哪一个等于没说 —— 所以标题是
   * 通知里的第一识别信息。
   *
   * 依次尝试两条**同步**取法，都不行就返回空串（通知少一行，绝不崩）：
   *   1. `sessionTitle` 服务：`ctx.sessionTitle.get(session)?.title`
   *   2. `sessionProjections` 快照：`snapshot(session).values.title`
   * 两条都是纯内存读取，不产生额外网络/IO，不会拖慢 agent 主流程。
   */
  function sessionTitleOf(agent) {
    const session = agent?.session
    if (!session) return ''
    try {
      const t = ctx.get?.('sessionTitle')?.get?.(session)?.title
      if (typeof t === 'string' && t.trim() !== '') return t.trim()
    } catch { /* 服务未装配或不支持该 session */ }
    try {
      const t = ctx.get?.('sessionProjections')?.snapshot?.(session)?.values?.title
      if (typeof t === 'string' && t.trim() !== '') return t.trim()
    } catch { /* 服务未装配 */ }
    return ''
  }

  /**
   * 注册 settings namespace 并拿到 owner scope。
   *
   * 三条踩坑记录：
   * 1. `register` 是**必须的前置步骤**——不注册的话 `get(ns)` 恒为 undefined（见 liveConfig 注释）。
   * 2. 同一 namespace 重复 register 会 throw，所以注册一次并缓存，
   *    且必须容忍「已经被注册过」（例如热重载/二次装配）而**不能崩**。
   * 3. ⚠️ `ctx.inject()` 是**异步**的：回调不在 apply 体内同步执行。
   *    依赖它的话，apply 末尾的启动自检会先跑，读到空 scope 并打印
   *    「配置来源：内置默认值」——那正是我第一轮修复后真实启动看到的现象。
   *    所以 settings 必须写进模块级 `inject` 数组（见文件顶部），
   *    保证 apply 执行时服务已就绪；下面的 inject 仅作**兜底**。
   */
  let settingsScope

  /** 统一的安全读取：scope 不存在或抛错都返回 undefined，绝不打断主流程。 */
  const safeScopeGet = () => {
    if (!settingsScope?.get) return undefined
    try {
      return settingsScope.get()
    } catch (err) {
      log(`读取 settings 失败，本次退回默认值：${err?.message ?? err}`)
      return undefined
    }
  }

  /** 幂等注册：已注册同一个 ns 时不重复注册、不抛错。 */
  const setupSettings = (settingsService) => {
    if (settingsScope || !settingsService?.register) return
    try {
      settingsScope = settingsService.register(SETTINGS_NS, Config, { base: DEFAULTS })
      const initial = settingsScope.get()
      // liveConfig() 每次从 scope 读，所以 watch 只负责给出可见的热更新提示。
      const stopWatch = settingsScope.watch(() => {
        const next = settingsScope.get()
        log(`settings 已热更新：agentmdInject=${next.agentmdInject === true}，agentmdDir=${next.agentmdDir || '（未配置）'}`)
      })
      ctx.effect?.(() => () => {
        stopWatch?.()
        settingsScope = undefined
      }, 'remote-qqbot.settings()')
      log(`已注册 settings namespace "${SETTINGS_NS}"（hubUrl ${initial.hubUrl || '未配置'}，agentmdDir ${initial.agentmdDir || '未配置'}）`)
    } catch (err) {
      const msg = String(err?.message ?? err)
      if (msg.includes('already registered')) {
        // 服务里已有注册（例如别的 fiber 先注册了）——直接用服务的 get 读，不再注册。
        log(`settings namespace "${SETTINGS_NS}" 已被注册，改用服务读取`)
        settingsScope = { get: () => settingsService.get(SETTINGS_NS), watch: () => () => {} }
      } else {
        log(`注册 settings namespace 失败，将退回默认值：${msg}`)
      }
    }
  }

  // 主路径：inject 数组里声明了 settings，服务此时应已可用。
  setupSettings(ctx.get?.('settings'))
  // 兜底：主路径没拿到（服务晚于本插件就绪）时，等服务出现再注册，
  // **并重新打印一次状态**——否则启动日志会停留在"未生效"的旧结论上，误导排查。
  if (!settingsScope) {
    try {
      ctx.inject?.(['settings'], (settingsCtx) => {
        setupSettings(settingsCtx.settings)
        // ⚠️ 这里**不能直接调 reportStatus()**：它和 liveConfig 都在 apply() 后面才定义
        //    （const，存在 TDZ），而 inject 回调**可能同步触发**（测试桩就是同步的），
        //    同步触发时这里会抛 `Cannot access 'reportStatus' before initialization`，
        //    还被下面的 catch 吞掉 —— 旧版就是这样，只是末尾那次自检把结论盖住了，
        //    所以看起来正常。推迟一拍，同步/异步两条路都稳。
        Promise.resolve().then(() => {
          try { reportStatus() } catch { /* 末尾还有一次自检兜底 */ }
        })
      })
    } catch (err) {
      log(`无法注入 settings 服务，将退回默认值：${err?.message ?? err}`)
    }
  }

  // ── 界面改动落盘（插件自己的覆盖文件）──────────────────────────────────
  //
  // 🔴 2026-10-02 主人报「QQ 提醒 / 协作模式这两个开关点了没有用，它们永远保持开启」。
  // 真凶不在界面，也不在路由，而在**桌面版根本不让第三方命名空间写入**：
  // 桌面版的 `SettingsService.write()` 会去找 profile 里 id 等于 ns 的那个条目，
  // 而我们的条目 id 是 `remote-qqbot`（ns 是 `dsh-remote-qqbot`），
  // 且 `Config` 没有任何字段声明 volatile ⇒ 每次写都抛
  // `No configurable plugin entry "dsh-remote-qqbot"`。
  // 而路由又把这个失败**误报成了成功**（`ok:false` 后面展开 `configView()` 里的 `ok:true`），
  // 于是开关静默弹回原位。两条都要修：这里给写入一条真的能用的路。
  //
  // 为什么不让插件去适配桌面版的那道门槛（改 ns + 给字段标 volatile）：
  // 见 src/overrides.js 文件头的「为什么不用」一节 —— 那条路要改 profile 条目 id、
  // 依赖一个还没确认的 schemastery volatile 写法，且成功后写的是用户手工维护的
  // cordis.patch.yml，风险与收益不成比例。
  //
  // 优先级：DEFAULTS → settings scope → cordis 补丁的显式键 → **本文件**（最高）。
  // 最高是必须的：补丁里写着 `qqEnabled: true`，主人从界面关掉时必须能压住它。
  const dshHomeDir = () => {
    const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
    if (fromEnv !== '') return fromEnv
    try { return join(homedir(), '.dsh') } catch { return join(process.env.USERPROFILE ?? '.', '.dsh') }
  }
  const overrideFile = overrideFilePath(dshHomeDir())
  // 白名单＝Config 里真实存在的键（DEFAULTS 就是它的键集合）：
  // 覆盖文件被人手工塞进别的键也不会污染配置。
  const configKeys = new Set(Object.keys(DEFAULTS))

  let uiOverrides = {}
  {
    const { values, error } = readOverrides(overrideFile, configKeys)
    uiOverrides = values
    if (error !== '') log(`⚠️ 界面改动的覆盖文件读不出来（已忽略，界面会显示配置文件里的值）：${error}`)
  }

  // 原生写入失败只报一次：桌面版**每次**都会失败，不设闸门会把日志刷爆。
  let nativeWriteReported = false

  /**
   * 落盘一条界面改动。先试 DSH 原生 settings，失败才写覆盖文件（见 src/overrides.js）。
   * @returns {Promise<{ via: 'dsh-settings'|'override-file', values: object, applied: string[] }>}
   */
  const persistUiPatch = async (patch, expectedRevision) => {
    const safe = filterPatch(patch, configKeys)
    const result = await persistConfigPatch({
      patch: safe,
      expectedRevision,
      nativeUpdate: typeof settingsScope?.update === 'function'
        ? (next, revision) => settingsScope.update(next, revision)
        : undefined,
      file: overrideFile,
      current: uiOverrides,
      onNativeError: (message) => {
        if (nativeWriteReported) return
        nativeWriteReported = true
        log(`DSH 原生 settings 拒绝写入（${message}）—— 界面改动改由插件自己的文件保存：${overrideFile}`)
      },
    })
    // 只有真写进覆盖文件时才更新内存副本；原生成功时 scope 自己会给出新值。
    if (result.via === 'override-file') uiOverrides = result.values
    return result
  }

  /**
   * 取当前生效的配置。
   *
   * ⚠️ 这里曾经是第三个致命 bug（而且是**最隐蔽**的一个）：
   * 原实现是 `ctx.get('settings').get(ns)` —— 但 settings 服务的
   * `get(ns)`（packages/settings/settings/src/index.ts:519）只返回**已注册**
   * namespace 的 resolved 值，未注册一律 `undefined`。
   * 于是 `?? {}` 静默兜底成空对象，插件"已就绪"但**所有用户配置全部失效**
   * （不会崩、不会报错，最难查）。
   *
   * 正确姿势：`ctx.settings.register(ns, schema, { base })` 拿 scope，
   * scope.get() 返回「schema 默认值 → base → 用户层」的合并结果
   * （见同文件 resolve()：`schema(mergeLayers(base, section))`）。
   *
   * ⚠️⚠️ 还有第二个更阴的坑：**不能把 `rawConfig` 合并到 scope 之上**。
   * Cordis 调 apply 时传的第二个参数是 `resolveConfig()` 的产物
   * （vendor/cordis/lib/index.js：`return result.value`），也就是
   * **经过 schema 校验、每个键都被默认值填满**的对象：
   *   `{ hubUrl: '', token: '', agentmdDir: '', … }`
   * 一旦 `{ ...scope, ...rawConfig }`，这些空串就会把 settings 里的真实值覆盖掉——
   * 表现就是「scope 里明明有 hubUrl，liveConfig() 却返回空」。
   *
   * 所以优先级必须反过来：**settings（用户配置）优先，rawConfig 只补 settings 没有的键**。
   * rawConfig 仅用于测试/显式覆盖，且必须以「显式给出的键」为准——
   * 判断标准是该值是否为 schema 默认值（即用户没配）。
   *
   * ⚠️⚠️⚠️ 第三层：**界面改动（覆盖文件）优先级最高**，压在 rawConfig 之上。
   * 原因：`cordis.patch.yml` 里的显式键（如 `qqEnabled: true`）会被算成"显式覆盖"，
   * 而主人从输入框下方把开关**关掉**时，那个 false 必须压得住补丁里的 true。
   * 详见 src/overrides.js 文件头（那里记录了"点了没有用"的完整事故）。
   */
  const liveConfig = () => {
    const fromScope = safeScopeGet()
    // 只把 rawConfig 里**与默认值不同**的键当作显式覆盖，避免被 Cordis 填满的默认值冲掉 settings。
    const overrides = {}
    for (const [key, value] of Object.entries(rawConfig ?? {})) {
      if (!deepEqualJson(value, DEFAULTS[key])) overrides[key] = value
    }
    const merged = { ...DEFAULTS, ...(fromScope ?? {}), ...overrides, ...uiOverrides }
    return {
      ...merged,
      // 留空则回落到**内嵌出厂值**（settings.yaml 丢失时功能不废，见 DEFAULTS 注释）。
      hubUrl: typeof merged.hubUrl === 'string' && merged.hubUrl.trim() !== ''
        ? merged.hubUrl.trim()
        : DEFAULTS.hubUrl,
      // 云端地址只认 http/https 且去掉末尾斜杠；不合规一律当"没配"（前端已有一层，这里是兜底）
      cloudUrl: normalizeCloudUrl(merged.cloudUrl),
      cloudToken: typeof merged.cloudToken === 'string' ? merged.cloudToken.trim() : '',
      token: typeof merged.token === 'string' && merged.token.trim() !== ''
        ? merged.token.trim()
        : DEFAULTS.token,
      timeoutMs: Number.isFinite(merged.timeoutMs) ? merged.timeoutMs : DEFAULTS.timeoutMs,
      dedupeMs: Number.isFinite(merged.dedupeMs) ? merged.dedupeMs : DEFAULTS.dedupeMs,
      errorSummaryChars: Number.isFinite(merged.errorSummaryChars) ? merged.errorSummaryChars : DEFAULTS.errorSummaryChars,
      // 留空则回落到**内嵌出厂值**（settings.yaml 丢失时功能不废，见 DEFAULTS 注释）。
      agentmdDir: typeof merged.agentmdDir === 'string' && merged.agentmdDir.trim() !== ''
        ? merged.agentmdDir.trim()
        : DEFAULTS.agentmdDir,
      agentmdMainFile: typeof merged.agentmdMainFile === 'string' && merged.agentmdMainFile.trim() !== ''
        ? merged.agentmdMainFile.trim()
        : DEFAULTS.agentmdMainFile,
      agentmdInject: merged.agentmdInject === true,
      agentmdAppendLog: merged.agentmdAppendLog !== false,
      agentmdSummaryChars: Number.isFinite(merged.agentmdSummaryChars) && merged.agentmdSummaryChars > 0
        ? merged.agentmdSummaryChars
        : DEFAULTS.agentmdSummaryChars,
      // 三条预算：0 或负数一律回落到出厂默认（绝不解释成“不限”，否则防爆护栏会被配置关掉）。
      agentmdInjectMaxChars: Number.isFinite(merged.agentmdInjectMaxChars) && merged.agentmdInjectMaxChars > 0
        ? Math.floor(merged.agentmdInjectMaxChars)
        : DEFAULTS.agentmdInjectMaxChars,
      agentmdInjectTailRows: Number.isFinite(merged.agentmdInjectTailRows) && merged.agentmdInjectTailRows >= 0
        ? Math.floor(merged.agentmdInjectTailRows)
        : DEFAULTS.agentmdInjectTailRows,
      agentmdRowMaxChars: Number.isFinite(merged.agentmdRowMaxChars) && merged.agentmdRowMaxChars > 0
        ? Math.floor(merged.agentmdRowMaxChars)
        : DEFAULTS.agentmdRowMaxChars,

      // 子智能体通知：只有显式 true 才开（默认静默）。
      notifySubagents: merged.notifySubagents === true,
      notifyChatSession: merged.notifyChatSession === true,

      // ── 协作模式 ──────────────────────────────────────────────────────────
      // 默认开：单人单会话时它什么也不输出，所以开着的代价为零。
      collabEnabled: merged.collabEnabled !== false,
      collabPanelFile: typeof merged.collabPanelFile === 'string' && merged.collabPanelFile.trim() !== ''
        ? merged.collabPanelFile.trim()
        : DEFAULTS.collabPanelFile,
      collabScope: merged.collabScope === 'global' ? 'global' : 'workspace',
      collabInject: merged.collabInject !== false,
      collabClaimGuard: merged.collabClaimGuard === 'block'
        ? 'block'
        : (merged.collabClaimGuard === 'off' ? 'off' : 'warn'),
      collabClaimTtlMs: Number.isFinite(merged.collabClaimTtlMs) && merged.collabClaimTtlMs > 0
        ? merged.collabClaimTtlMs
        : DEFAULTS.collabClaimTtlMs,
      collabIncludeSubagents: merged.collabIncludeSubagents === true,

      // ── QQ 通道 ──────────────────────────────────────────────────────────
      qqEnabled: merged.qqEnabled === true,
      // 默认开：只有显式 false 才关（用户手动关掉远程提醒时）。
      qqNotifyEnabled: merged.qqNotifyEnabled !== false,
      qqSummaryChars: Number.isFinite(merged.qqSummaryChars) && merged.qqSummaryChars >= 0
        ? Math.floor(merged.qqSummaryChars)
        : DEFAULTS.qqSummaryChars,
      // 凭据/工作目录同样回落到内嵌出厂值：配置文件丢了也不至于"什么都没配置"。
      qqAppId: typeof merged.qqAppId === 'string' && merged.qqAppId.trim() !== ''
        ? merged.qqAppId.trim()
        : DEFAULTS.qqAppId,
      qqClientSecret: typeof merged.qqClientSecret === 'string' && merged.qqClientSecret.trim() !== ''
        ? merged.qqClientSecret.trim()
        : DEFAULTS.qqClientSecret,
      qqStateFile: typeof merged.qqStateFile === 'string' ? merged.qqStateFile.trim() : '',
      qqCwd: typeof merged.qqCwd === 'string' && merged.qqCwd.trim() !== ''
        ? merged.qqCwd.trim()
        : DEFAULTS.qqCwd,
      // 上限 20：再长 QQ 一屏也放不下，而且"回个数字"的价值就在于不用翻。
      qqRecentCount: Number.isFinite(merged.qqRecentCount) && merged.qqRecentCount >= 1
        ? Math.min(20, Math.floor(merged.qqRecentCount))
        : DEFAULTS.qqRecentCount,
      // 全文模式：只认三档之一，其余一律当 'chat'（最保守：不上传、只发 QQ）。
      qqFulltextMode: normalizeFulltextMode(merged.qqFulltextMode),
      // chat 档下一次最多往 QQ 发多少字（默认 6000）。0 / 负数 / 非数字一律回默认值 ——
      // 这里不允许"不限制"，因为一份几万字的回答会把 QQ 聊天窗口刷屏。
      qqFulltextMaxChars: Number.isFinite(merged.qqFulltextMaxChars) && merged.qqFulltextMaxChars > 0
        ? Math.floor(merged.qqFulltextMaxChars)
        : DEFAULTS.qqFulltextMaxChars,
      // 🔴 云上传总闸：**只有显式 true 才开**（默认 false）。
      //    关着时 note / note-link 两档都会在运行时回退成 chat 的行为 —— 见 turn-complete 分支。
      cloudEnabled: merged.cloudEnabled === true,
      dshApiUrl: typeof merged.dshApiUrl === 'string' && merged.dshApiUrl.trim() !== ''
        ? merged.dshApiUrl.trim()
        : DEFAULTS.dshApiUrl,
      dshApiAuthority: typeof merged.dshApiAuthority === 'string' && merged.dshApiAuthority.trim() !== ''
        ? merged.dshApiAuthority.trim()
        : DEFAULTS.dshApiAuthority,
      dshSecret: typeof merged.dshSecret === 'string' ? merged.dshSecret.trim() : '',

      // ── 完整回答（notes）─────────────────────────────────────────────────
      notesEnabled: merged.notesEnabled !== false,
      notesIdLength: Number.isFinite(merged.notesIdLength) && merged.notesIdLength >= 4
        ? Math.floor(merged.notesIdLength)
        : DEFAULTS.notesIdLength,
      notesMaxChars: Number.isFinite(merged.notesMaxChars) && merged.notesMaxChars > 0
        ? Math.floor(merged.notesMaxChars)
        : DEFAULTS.notesMaxChars,
      qqMarkdown: merged.qqMarkdown !== false,
      qqPromptMode: merged.qqPromptMode === 'steer' ? 'steer' : 'queue',
      // 闲聊：默认只读 + 回答直接回 QQ（主人明确要求"只能看状态、思考完直接答"）。
      qqChatReadOnly: merged.qqChatReadOnly !== false,
      qqChatReply: merged.qqChatReply !== false,
      qqChatAnswerChars: Number.isFinite(merged.qqChatAnswerChars) && merged.qqChatAnswerChars > 0
        ? Math.floor(merged.qqChatAnswerChars)
        : DEFAULTS.qqChatAnswerChars,

      // ── 截图（/screen）────────────────────────────────────────────────────
      // 默认开：主人点菜单里的「屏幕」就是为了立刻看到画面，多一道开关反而碍事。
      qqScreenEnabled: merged.qqScreenEnabled !== false,
      // 0 是**有意义的值**：表示"不缩放，原样发"。所以这里只挡负数与非数字。
      qqScreenMaxWidth: Number.isFinite(merged.qqScreenMaxWidth) && merged.qqScreenMaxWidth >= 0
        ? Math.floor(merged.qqScreenMaxWidth)
        : DEFAULTS.qqScreenMaxWidth,

      // ── 远程更新 ──────────────────────────────────────────────────────────
      // 提醒默认开：主人在手机上收到一句「有新版本」，发 /update 就装上了。
      qqUpdateEnabled: merged.qqUpdateEnabled !== false,
      // 源写空了就回到默认源 —— 空串会让 /update 直接没法用，而这是"配置没填"，
      // 不是"我不想更新"，所以给默认值比报错更符合预期。
      qqUpdateSource: typeof merged.qqUpdateSource === 'string' && merged.qqUpdateSource.trim() !== ''
        ? merged.qqUpdateSource.trim()
        : DEFAULTS.qqUpdateSource,
      qqUpdateAutoRestart: merged.qqUpdateAutoRestart !== false,
      // 上限 168 小时（一周）：填成 10000 小时等于把功能关掉却还留着定时器，没意义。
      qqUpdateCheckHours: Number.isFinite(merged.qqUpdateCheckHours) && merged.qqUpdateCheckHours > 0
        ? Math.min(168, merged.qqUpdateCheckHours)
        : DEFAULTS.qqUpdateCheckHours,
    }
  }

  /**
   * 把「闲聊会话」钉死在**只读**权限上。
   *
   * 主人的原话：「闲聊我不希望他有任何操作能力，他只能看各种状态，思考完毕之后直接在聊天框给我回答」。
   * 所以做法不是禁工具（那连"看状态"都没了），而是每次给它发消息**之前**把该会话的权限预设切成
   * `read-only`：读文件、列目录、跑查看类命令照旧，任何写入/修改/删除会被沙箱拒绝。
   *
   * 幂等：已经是 read-only 就直接返回，不重复写事件（`permission/preset` 会进会话事件流，
   * 每轮都追加一条纯属噪音）。
   *
   * ⚠️ 已知边界（必须对主人说清楚，不能含糊）：
   * 沙箱管的是**本机文件系统**。若闲聊会话用 `shell` 通过 SSH 去改**远端**主机，只读预设拦不住 ——
   * 那需要另一层工具守卫，本轮未做。
   *
   * @param {string} sessionId - 闲聊会话 id。
   * @returns {boolean} 本轮是否确认（或已确认）处于只读。
   */
  function ensureChatReadOnly(sessionId) {
    if (liveConfig().qqChatReadOnly === false) return false
    if (!sessionId) return false

    const presets = ctx.get?.('permissionPresets')
    if (!presets || typeof presets.set !== 'function') {
      log('权限预设服务不可用，闲聊会话无法切只读（本轮仍照常回答）')
      return false
    }
    // 先确认这个 DSH 真的认识 'read-only' 这个名字，避免 set 抛错后才后悔。
    const names = presets.names
    if (Array.isArray(names) && !names.includes('read-only')) {
      log(`权限预设里没有 'read-only'（现有：${names.join(', ')}），闲聊会话无法切只读`)
      return false
    }

    const session = ctx.get?.('sessions')?.get?.(sessionId)
    if (!session) {
      log(`拿不到会话对象（${sessionId}），闲聊会话无法切只读`)
      return false
    }

    let current = ''
    try { current = presets.current?.(session.events) ?? '' } catch { /* 读不到就当作不是只读，下面照样 set 一次 */ }
    if (current === 'read-only') return true

    presets.set(session, 'read-only')
    log(`闲聊会话已切到只读权限（${sessionId}）`)
    return true
  }

  /**
   * QQ 官方机器人运行时（可选）。
   *
   * 惰性启动：只有 qqEnabled 且 AppID/Secret 齐全时才会建连接，
   * 平时它是一个纯粹的惰性对象，不碰网络、不影响任何主流程。
   *
   * `beforeChatPrompt` 只在「要往闲聊会话里投递一句话」之前被调用，
   * 用来把该会话切到只读（见 {@link ensureChatReadOnly}）。它失败**不影响**投递。
   */
  const qq = createQqRuntime({
    liveConfig,
    log: (m) => log(m),
    projectOf,
    sessionTitleOf,
    isSubagent,
    beforeChatPrompt: ensureChatReadOnly,
  })

  /** 向中枢发一个请求。任何失败都只记日志，绝不影响 agent 主流程。 */
  async function send(path, { method = 'POST', body } = {}) {
    const config = liveConfig()
    if (!config.hubUrl) return { ok: false, skipped: true }

    const headers = { Accept: 'application/json' }
    if (config.token) headers.Authorization = `Bearer ${config.token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'

    try {
      const res = await fetch(`${config.hubUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        data = { raw: text.slice(0, 300) }
      }
      return { ok: res.ok, status: res.status, data }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  }

  const lastStatus = new Map()
  /** 记录每个 agent 本轮是否出过错，用于操作日志「结果」列。 */
  const turnHadError = new Set()
  let lastPushKey = ''
  let lastPushAt = 0

  /** 提问中继是否已接上（接上了就不再重复推一条纯文本的提问）。 */
  let qqQuestionRelay = false

  /**
   * 带去重的推送。
   *
   * 两个渠道互相独立：
   *   ① QQ 官方机器人 —— **不需要服务器、不需要穿透**，主推渠道
   *   ② 中枢 hubUrl   —— 可选，配了才发
   * 去重必须在渠道判断**之前**，否则同一个事件会在两个渠道各推一次。
   */
  /**
   * 把本轮的**完整回答**存到服务器，返回能直接点开的短链接（失败返回 null）。
   *
   * 两条上传路线，**云端优先**（配了 cloudUrl + cloudToken 就走云端）：
   * - 云端（dsh-web `/api/publish`）：记录挂在你自己的账号下，登录才能看、按账号算配额。
   * - 中枢（`hubUrl` `/api/notes`）：公开可读的 markdown，单租户共享令牌。
   *
   * ⚠️ 云端失败时**不会**偷偷改发中枢 —— 那等于把内容发去另一个地方（可见性还不一样）。
   * 失败就只记日志、推送退回"只有摘要"，宁可少一个链接，也不做用户没同意的转发。
   *
   * 什么时候安静跳过：
   *   - `notesEnabled` 关了 / 云端与中枢都没配（没地方存）
   *   - 本轮压根没有文本回答（例如只调了工具）
   * 这几种情况都不算错误 —— 推送会退回"只有摘要"的老样子。
   *
   * @param {object} agent - 刚进入 idle 的 agent。
   * @param {{userText?: string, assistantText?: string}|null} parts - 已提取的本轮原文。
   * @returns {Promise<string|null>} 短链接。
   */
  async function publishTurnNote(agent, parts) {
    const config = liveConfig()
    if (!config.notesEnabled) return null
    const assistant = parts?.assistantText ?? ''
    if (!String(assistant).trim()) {
      log('本轮没有文本回答，跳过完整回答上传')
      return null
    }

    // ── 路线一：云端网页端（多租户、按账号算配额）──
    if (config.cloudUrl && config.cloudToken) {
      const capped = String(assistant).trim().slice(0, config.notesMaxChars)
      const truncated = capped.length < String(assistant).trim().length
      const r = await cloudPublishNote({
        cloudUrl: config.cloudUrl,
        token: config.cloudToken,
        text: capped,
        title: sessionTitleOf(agent),
        mode: normalizeFulltextMode(config.qqFulltextMode),
        log,
      })
      if (r.ok) {
        log(`完整回答已存到云端账号：${r.url}（${r.plan === 'pro' ? '付费版' : '免费版'}，留 ${r.retentionText}）${truncated ? `；原文过长已截断到 ${config.notesMaxChars} 字` : ''}`)
        return r.url
      }
      log(`云端没存上（本次不附链接）：${r.error}`)
      return null
    }

    // ── 路线二：中枢（公开 markdown 短链）──
    if (!config.hubUrl) return null
    try {
      const { markdown, truncated, totalChars } = renderNote({
        session: sessionTitleOf(agent),
        sessionId: agent?.id ? String(agent.id) : '',
        cwd: projectOf(agent),
        at: Date.now(),
        user: parts?.userText ?? '',
        assistant,
        maxChars: config.notesMaxChars,
      })
      const r = await publishNote({
        hubUrl: config.hubUrl,
        token: config.token,
        markdown,
        idLength: config.notesIdLength,
        session: sessionTitleOf(agent),
        log,
      })
      if (r?.url) {
        log(`完整回答已存到中枢：${r.url}${truncated ? `（原文 ${totalChars} 字符，已截断到 ${config.notesMaxChars}）` : ''}`)
      }
      return r?.url ?? null
    } catch (err) {
      log(`完整回答上传异常（不影响推送）：${err?.message ?? err}`)
      return null
    }
  }

  function push(kind, summary, agent, extra = {}) {
    const config = liveConfig()
    if (kind === 'turn-complete' && !config.onTurnComplete) return
    if (kind === 'question' && !config.onQuestion) return
    if (kind === 'error' && !config.onError) return

    // 子智能体（teammate / 子任务）默认不打扰：一个 Lead 回合常常派生好几个子智能体，
    // 每个跑完都推一条，真正要看的「主会话跑完了」就被淹了。
    // 这里放在去重**之前**返回，避免子智能体的事件占掉去重槽位、把主会话的通知顶掉。
    if (!config.notifySubagents && agent && isSubagent(agent)) {
      log(`子智能体 ${String(agent?.id ?? '?')} 的 ${kind} 按配置（notifySubagents=false）不推送`)
      return
    }

    // 闲聊会话（在 QQ 里**不引用任何消息**、直接说一句时进的那个）：
    // 你人就在 QQ 里等着回复，这时候再推一条"跑完了"纯属打扰 —— 默认不推。
    // 同样放在去重**之前**返回，不占去重槽位。
    const quietSessionId = agent?.id ? String(agent.id) : ''
    if (!config.notifyChatSession && quietSessionId && qq.isChatSession(quietSessionId)) {
      // 闲聊会话：**不推通知卡片、不传笔记**，把回答正文直接发到 QQ 聊天框。
      // 主人的原话：「思考完毕之后直接在聊天框给我回答」——聊天记录里就该是"问一句、答一段"，
      // 而不是"收到一张卡片 + 一个链接"。
      if (kind === 'turn-complete' && config.qqChatReply !== false) {
        const answerText = extra?.answerText ?? ''
        qq.sendChatAnswer({
          text: answerText,
          sessionId: quietSessionId,
          session: sessionTitleOf(agent),
          maxChars: config.qqChatAnswerChars,
        }).then(
          (sent) => { if (!sent) log('闲聊回答未能发出（详见上一行日志）') },
          (err) => log(`闲聊回答发送异常：${err?.message ?? err}`),
        )
      } else {
        log(`会话 ${quietSessionId} 是闲聊会话，按配置不推送`)
      }
      return
    }

    const project = agent ? projectOf(agent) : 'DSH'
    // 会话标题（"main" 这种）：光说"任务完成"不知道是哪个会话，必须带上。
    const session = agent ? sessionTitleOf(agent) : ''

    // ⚠️ 去重键**必须带上会话**。
    // 原来是 `${kind}|${summary}`，而所有 turn-complete 的 summary 都是
    // "本轮已结束，可以查看了" —— 于是两个**不同会话**在 dedupeMs（默认 4 秒）内
    // 先后完成时，第二条会被当成重复**静默丢弃**。多会话并发正是本插件的核心场景，
    // 这个键必须精确到会话。
    const agentKey = agent?.id ? String(agent.id) : (agent ? project : '-')
    const key = `${kind}|${agentKey}|${summary}`
    const now = Date.now()
    if (key === lastPushKey && now - lastPushAt < config.dedupeMs) return
    lastPushKey = key
    lastPushAt = now

    // 完整回答的链接只在**推送文案**里追加，去重键仍用原摘要
    //（否则同一轮重推时链接不同会被当成新事件）。
    // 链接还要过一层「QQ 点得开」的转换：QQ 的机器人平台会把没通过检测的 URL 套壳，
    // 点开只剩「如需预览请使用浏览器访问」。转换规则与实测依据见 qqbridge.qqPreviewUrl。
    const noteUrl = qqPreviewUrl(extra?.noteUrl)
    const pushText = noteUrl === ''
      ? summary
      : config.qqMarkdown
        ? `${summary}\n\n[查看完整回答](${noteUrl})`
        : `${summary}\n\n完整回答：${noteUrl}`

    // ① QQ：提问走"中继"那条更有信息量的路（带选项、且能直接回复作答），
    //    所以这里只在没有中继时才推一条纯文本提问。
    //
    // ⚠️ **必须把 sessionId 一起递下去**：你在 QQ 里"引用这条通知再回复"，
    //    靠的就是它反查该回到哪个会话（qqruntime 把 sessionId 与发送响应里的
    //    ref_idx 绑成一条记录）。少了它，登记下来的 sessionId 就是 undefined，
    //    引用回复永远匹配不到会话 —— 会掉进 unknown_ref，功能等于没做。
    if (config.qqEnabled && config.qqNotifyEnabled !== false && !(kind === 'question' && qqQuestionRelay)) {
      void qq.notify({
        kind,
        summary: pushText,
        project,
        session,
        sessionId: agent?.id ? String(agent.id) : undefined,
      })
    }

    // ①' 完整回答**正文**直接铺进 QQ 聊天框（三档全文模式里的 chat 档，也是默认档）。
    //
    // 为什么不放在推送前面：先让「跑完了」那张卡片落地，正文再一条条跟上去。
    // 顺序反了，人先看到一堆正文却不知道这是哪一轮、哪个会话的。
    // 正文来自 extra.fulltext（由 turn-complete 钩子按模式决定要不要带），
    // 别的 kind 一律不带 —— 这条路径**不经过中枢、不向服务器写任何字节**。
    //
    // ⚠️ maxChars 故意**不传**：fulltext.js 会在缺省时用 QQ_TEXT_SAFE_CHARS(900)；
    //    若图省事递 config.qqChatAnswerChars（那是"闲聊只回一段"的 1500 上限），
    //    会把安全余量顶掉，单条变长后更容易被 QQ 直接拒收。
    if (kind === 'turn-complete' && config.qqEnabled && typeof extra?.fulltext === 'string' && extra.fulltext.trim() !== '') {
      void qq.sendQqFulltext({
        text: extra.fulltext,
        sessionId: quietSessionId,
        session,
      }).then(
        (r) => {
          if (r && r.sent === 0) log(`完整回答没有发出去（原因：${r.reason ?? '未知'}）`)
        },
        (err) => log(`完整回答发送异常：${err?.message ?? err}`),
      )
    }

    // ② 中枢（可选）
    if (!config.hubUrl) {
      if (!config.qqEnabled) log(`hubUrl 未配置且 QQ 通道未启用，${kind} 事件未推送`)
      return
    }

    send('/event', {
      body: {
        kind,
        summary: pushText,
        project,
        session: session || undefined,
        sessionId: agent?.id ? String(agent.id) : undefined,
      },
    }).then((r) => {
      if (r.ok) log(`已推送到中枢 ${kind}: ${summary}`)
      else if (!r.skipped) log(`枢纽推送失败 (${kind}): ${r.error ?? JSON.stringify(r.data)}`)
    })
  }

  // ── 1. 任务完成：running → idle ─────────────────────────────────────────
  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload?.agent
      const status = payload?.status
      if (!agent || !status) return
      const id = String(agent.id ?? 'unknown')
      const prev = lastStatus.get(id)
      lastStatus.set(id, status)
      if (status === 'running') turnHadError.delete(id)
      if (status === 'idle' && prev === 'running') {
        // 提取一次本轮摘要，两处复用：
        //   - QQ 通知要「这次做完了什么」（composeChatSummary，口语、只留结果）
        //   - agentmd 日志要「用户说了什么 → 结果是什么」（composeSummary）
        // 提取失败不能影响通知，所以整体包一层。
        let parts = null
        try {
          parts = extractTurnSummary(agent)
        } catch (err) {
          log(`本轮摘要提取失败（不影响通知）: ${err?.message ?? err}`)
        }
        const chatSummary = parts ? composeChatSummary(parts, liveConfig().qqSummaryChars) : ''
        const chatSession = agent?.id ? qq.isChatSession(String(agent.id)) : false
        if (chatSession && liveConfig().qqChatReply !== false) {
          // 闲聊会话：**不做笔记上传**（回答只在 QQ 聊天框里出现，没人会点它的链接），
          // 把回答原文交给 push → 由它直接发回 QQ。省掉一次服务器写入，也省掉一篇
          // 24 小时后要被定时器删掉的笔记。
          const answerText = parts ? composeChatAnswer(parts, liveConfig().qqChatAnswerChars) : ''
          push('turn-complete', chatSummary, agent, { answerText })
        } else {
          // ── 三档「完整回答」在这里分叉（chat / note / note-link）────────────────
          //   chat      ：不上传，正文分条直接发到 QQ 聊天框（默认档）
          //   note      ：上传服务器，QQ 卡片只有摘要，正文去网页端看（不带链接）
          //   note-link ：上传服务器，QQ 卡片附一个可点开的链接（老行为）
          //
          // 🔴 云上传总闸：只有**显式打开**（cloudEnabled === true）且该档确实要上传时才上传。
          //    默认关着 ⇒ note / note-link 在这里回退成 chat 的行为，也就是**一个字节都不出本机**。
          const cfg = liveConfig()
          const fulltextMode = normalizeFulltextMode(cfg.qqFulltextMode)
          const wantsUpload = uploadsFulltext(fulltextMode)
          const uploadOn = cfg.cloudEnabled === true && wantsUpload
          if (!uploadOn) {
            if (wantsUpload) {
              log(
                `完整回答模式是「${fulltextModeLabel(fulltextMode)}」，但云上传总闸关着（cloudEnabled=false），`
                + '这次按「直接发到 QQ」处理 —— 没有把正文上传到服务器',
              )
            }
            // 正文由 push() 里的 fan-out 分条发到 QQ；这里只负责把内容塞进 extra。
            // ⚠️ 不传 maxChars 给 sendQqFulltext（那是**单条消息**长度），内容上限用
            //    qqFulltextMaxChars 在这里先截断 —— 否则一份几万字的回答会刷屏聊天窗口。
            push('turn-complete', chatSummary, agent, {
              fulltext: parts ? composeChatAnswer(parts, cfg.qqFulltextMaxChars) : '',
            })
          } else {
            // 先把完整回答存到服务器、拿到链接，再推送 —— 顺序不能反，否则推送时链接还不在手上。
            // 上传失败/超时都只返回 null（publishTurnNote 内部已兜住），推送照发：
            // 宁可这次少个链接，也不能因为你服务器抽风就丢掉「跑完了」这条通知。
            const wantLink = showsFulltextLink(fulltextMode)
            publishTurnNote(agent, parts).then(
              (noteUrl) => push('turn-complete', chatSummary, agent, wantLink ? { noteUrl } : {}),
              (err) => {
                log(`完整回答处理异常（不影响推送）：${err?.message ?? err}`)
                push('turn-complete', chatSummary, agent)
              },
            )
          }
        }
        appendAgentmdLog(agent, parts)
      }
    } catch (err) {
      log(`agent/status 处理失败: ${err?.message ?? err}`)
    }
  })

  // ── 2. 需要提问：ToolExecution 字段是扁平的 name / arguments / agent ────
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (exec?.name === 'ask_user_question') {
        const questions = exec?.arguments?.questions

        // ⚠️⚠️ 「提问中继」的最后一道保险，也是 2026-10-02「提问还是不行」最可靠的修法。
        //
        //     此刻 agent 已经真的要提问了 ⇒ userQuestions 服务**必然已经就绪**；
        //     而插件 apply 那一刻它可能还没 active —— cordis 的 ctx.get 对
        //     「提供者 fiber 未 active」的服务返回 undefined
        //     （vendor/cordis 的 `ReflectService._getImpl`：
        //       `if (strict && impl.fiber.state !== 2) return`）。
        //
        //     旧代码在 apply 时只试一次、失败就永久放弃，于是提问退化成一条**没有选项**的
        //     纯文本：主人在 QQ 里既看不到 1/2/3，引用回复也没人接。
        //
        //     这里补接一次：成功 → 本次提问立刻走带选项的中继（下面那个 push 会被 gate 抑制）；
        //     仍失败 → push 正文直接把选项渲染进去，至少让人看得见在问什么。
        if (!qqQuestionRelay) {
          qqQuestionRelay = qq.wrapUserQuestions(ctx)
          if (qqQuestionRelay) log('QQ 提问中继：等到第一次提问时才就绪，已补接上')
        }

        push('question', formatQuestionBody(questions), exec?.agent)
      }
    } catch (err) {
      log(`pre-execute 处理失败: ${err?.message ?? err}`)
    }
    return next()
  })

  // ── 3. 执行出错 ─────────────────────────────────────────────────────────
  ctx.on('agent/error', (payload) => {
    try {
      const agent = payload?.agent
      const err = payload?.error
      const msg = err?.message ? String(err.message) : String(err ?? '未知错误')
      if (agent?.id) turnHadError.add(String(agent.id))
      push('error', msg.slice(0, liveConfig().errorSummaryChars), agent)
    } catch {
      /* 通知失败绝不能影响 agent */
    }
  })

  // ── 4. agentmd 操作日志自动追加 ─────────────────────────────────────────
  /**
   * 会话转入 idle 时，把本轮摘要追加到 `<agentmdDir>/<agentmdMainFile>`
   * 的「四、操作日志」表格末尾。
   *
   * 全过程容错：任何一步失败都只 log，绝不影响 agent。
   * 追加本身由 agentmd.js 的模块级队列串行化，多 agent 同时转 idle 也安全。
   *
   * @param {object} agent - 刚进入 idle 的 DSH Agent。
   * @param {object|null} [preParts] - 调用方已经提取好的本轮摘要（避免重复遍历会话事件）。
   * @returns {void}
   */
  function appendAgentmdLog(agent, preParts = null) {
    const config = liveConfig()
    if (!config.agentmdAppendLog) return
    if (!config.agentmdDir) {
      log('agentmdDir 未配置，跳过操作日志追加')
      return
    }
    let action = ''
    let result = '完成'
    try {
      const parts = preParts ?? extractTurnSummary(agent)
      action = composeSummary(parts, config.agentmdSummaryChars)
      result = inferResult(agent, turnHadError.has(String(agent?.id ?? 'unknown')))
    } catch (err) {
      log(`本轮摘要提取失败（不影响主流程）: ${err?.message ?? err}`)
      return
    }
    // 不 await：agent/status 是同期事件，追加是纯副作用，不能拖慢主流程。
    appendLogEntry({
      dir: config.agentmdDir,
      file: config.agentmdMainFile,
      action,
      result,
      maxRowChars: config.agentmdRowMaxChars,
      log,
    }).then((r) => {
      if (!r.ok) log(`操作日志未写入: ${r.reason}`)
    }).catch((err) => {
      log(`操作日志写入异常: ${err?.message ?? err}`)
    })
  }

  // ── 5. 会话上下文注入 ───────────────────────────────────────────────────
  /**
   * 把 agentmd 主文档全文注册为该会话的一条动态上下文。
   *
   * 用 `ctx.get('systemPrompt').context({...})`（见 @deepseek-ai/dsh-system-prompt
   * 的 SystemPrompt.context / PromptContext），text 是**函数**，因此每次组装
   * system prompt 都会重新读盘——外部编辑 main.md 后，下一个模型步骤即生效。
   *
   * 注册作用域是 `agent.ctx`，所以只影响这一个 agent，插件卸载时自动回收。
   * systemPrompt 服务不存在（例如 headless 装配）时只记日志，不影响会话。
   *
   * @param {object} agent - 新创建的 DSH Agent。
   * @returns {void}
   */
  function injectAgentmdContext(agent) {
    const config = liveConfig()
    if (!config.agentmdInject) return
    if (!config.agentmdDir) {
      log('agentmdInject 已开启但 agentmdDir 未配置，跳过上下文注入')
      return
    }
    const systemPrompt = ctx.get('systemPrompt')
    if (!systemPrompt || typeof systemPrompt.context !== 'function') {
      log('systemPrompt 服务不可用，跳过上下文注入（可用 agentmd_read 工具读取）')
      return
    }
    const agentCtx = agent?.ctx
    if (!agentCtx || typeof agentCtx.effect !== 'function') {
      log('agent.ctx 不可用，跳过上下文注入')
      return
    }
    // 同一份体积只报一次日志：text provider 每个模型步骤都会跑，不能每步刷一行。
    let lastBudgetNote = ''
    agentCtx.effect(() => systemPrompt.context({
      name: AGENTMD_CONTEXT_NAME,
      // order 150：排在 harness 身份(-100)、persona(0)、工具指引(100-199) 之后。
      order: 150,
      text: () => {
        // 同步 provider：这里只能同步读，所以用 readFileSync。
        try {
          const r = readDocSync(config.agentmdDir, config.agentmdMainFile)
          if (!r.ok) {
            log(`上下文注入读取失败: ${r.reason}`)
            return ''
          }
          // 🔴 有界注入：文档可能被写到几十万字符，注入的这一份**永远不超过 agentmdInjectMaxChars**。
          const doc = buildContextDoc(r.text, {
            maxChars: config.agentmdInjectMaxChars,
            tailRows: config.agentmdInjectTailRows,
          })
          if (doc.truncated) {
            const note = `${doc.totalChars}→${doc.keptChars}`
            if (note !== lastBudgetNote) {
              lastBudgetNote = note
              log(`agentmd 注入已压缩: 原文 ${doc.totalChars} 字符 → 注入 ${doc.keptChars} 字符`
                + `（上限 ${config.agentmdInjectMaxChars}，省略 ${doc.omittedChars}，日志保留 ${doc.rowsKept} 行）`)
            }
          }
          return [
            '以下是跨会话共享的操作记录文档（agentmd）。它记录了此前各个对话做过什么、当前进展到哪，',
            '请把它当作已读到的最新上下文，不必再让用户重复说明。',
            ...(doc.truncated
              ? [
                `⚠️ 这份文档已按注入预算压缩：原文共 ${doc.totalChars} 字符，这里只注入 ${doc.keptChars} 字符`,
                '（保留了开头正文与最近的日志行）。**被省略的内容不代表不存在** —— 需要细节时用',
                '`agentmd_read` 工具读全文或指定文件，不要凭“没看到”下结论。',
              ]
              : []),
            '',
            `<agentmd file="${r.path}">`,
            doc.text.trim(),
            '</agentmd>',
          ].join('\n')
        } catch (err) {
          log(`上下文注入失败: ${err?.message ?? err}`)
          return ''
        }
      },
    }), 'remote-qqbot.agentmdContext()')
    log(`已为会话 ${String(agent?.id ?? '?')} 注册 agentmd 上下文注入`)
  }

  ctx.on('agent/created', (payload) => {
    try {
      injectAgentmdContext(payload?.agent)
    } catch (err) {
      log(`agent/created 处理失败: ${err?.message ?? err}`)
    }
  })

  // ── 6. 记忆工具 ─────────────────────────────────────────────────────────
  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_write',
    description: '记住一条关于用户的持久化信息（习惯、偏好、事实、决定）。跨会话长期有效，用于逐步了解用户。',
    parameters: {
      key: { type: 'string', required: true, description: '稳定唯一的键，建议点分层级，如 pref.reply_style' },
      value: { type: 'string', required: true, description: '要记住的内容' },
      kind: { type: 'string', description: 'preference | habit | fact | decision，默认 fact' },
      note: { type: 'string', description: '可选：补充说明或来源' },
    },
    output: textOutput,
    async execute(args) {
      const r = await send('/memory', {
        body: { key: args.key, value: args.value, kind: args.kind ?? 'fact', note: args.note, source: 'agent' },
      })
      if (r.skipped) return '未配置 hubUrl，无法写入记忆。请在 settings.yaml 配置 dsh-remote-qqbot.hubUrl'
      if (!r.ok) return `记忆写入失败: ${r.error ?? JSON.stringify(r.data)}`
      return `已记住 ${args.key} = ${args.value}`
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_read',
    description: '读取已记住的关于用户的信息。开始新任务前调用，以了解用户的习惯与偏好。',
    parameters: {
      prefix: { type: 'string', description: '可选：按键前缀过滤，如 pref.' },
      kind: { type: 'string', description: '可选：按类型过滤' },
    },
    output: textOutput,
    async execute(args) {
      const qs = new URLSearchParams()
      if (args.prefix) qs.set('prefix', args.prefix)
      if (args.kind) qs.set('kind', args.kind)
      const query = qs.toString()
      const r = await send(`/memory${query ? `?${query}` : ''}`, { method: 'GET' })
      if (r.skipped) return '未配置 hubUrl，无法读取记忆。请在 settings.yaml 配置 dsh-remote-qqbot.hubUrl'
      if (!r.ok) return `记忆读取失败: ${r.error ?? JSON.stringify(r.data)}`
      const items = r.data?.items ?? []
      if (items.length === 0) return '（暂无记忆）'
      return items
        .map((m) => `${m.key} [${m.kind}] = ${JSON.stringify(m.value)}${m.note ? ` // ${m.note}` : ''}`)
        .join('\n')
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: '删除一条已记住的信息。',
    parameters: {
      key: { type: 'string', required: true, description: '要删除的键' },
    },
    output: textOutput,
    async execute(args) {
      const r = await send(`/memory?key=${encodeURIComponent(args.key)}`, { method: 'DELETE' })
      if (r.skipped) return '未配置 hubUrl，无法删除记忆。'
      if (!r.ok) return `删除失败: ${r.error ?? JSON.stringify(r.data)}`
      return `已忘记 ${args.key}`
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'agentmd_read',
    description: '读取 agentmd 跨会话操作记录文档（默认 main.md）。开始新任务前调用它，即可知道此前各对话做过什么、进展到哪。',
    parameters: {
      file: { type: 'string', description: '可选：agentmd 目录下的文件名，默认用配置的 agentmdMainFile（通常 main.md）' },
      maxChars: { type: 'number', description: '可选：最多返回多少字符，默认 8000，防止超长文档挤爆上下文' },
    },
    output: textOutput,
    async execute(args) {
      const config = liveConfig()
      if (!config.agentmdDir) {
        return '未配置 agentmdDir，无法读取。请在 settings.yaml 的 dsh-remote-qqbot 段配置 agentmdDir 指向 agentmd 目录。'
      }
      const file = args.file && String(args.file).trim() !== '' ? String(args.file).trim() : config.agentmdMainFile
      const r = await readDoc(config.agentmdDir, file)
      if (!r.ok) return `读取失败: ${r.reason}`
      const limit = Number.isFinite(args.maxChars) && args.maxChars > 0 ? Math.floor(args.maxChars) : 8000
      const chars = [...r.text]
      const body = chars.length <= limit ? r.text : `${chars.slice(0, limit).join('')}\n\n…（已截断，完整文档见 ${r.path}）`
      return `# ${r.path}\n\n${body}`
    },
  })))

  // ── 云端账号：设备码绑定 ──────────────────────────────────────────────────
  //
  // 一次绑定分两步（中间隔着"人去浏览器里点确认"），所以用**模块内暂存**记住
  // 待确认的那组码：第一次调用申请、第二次调用兑现。刻意不让工具调用阻塞 10 分钟
  // （工具卡住会把整轮对话一起卡住），也不自动轮询——什么时候确认是人的事。

  /** 待确认的设备码（只在本进程内存里，重启即失效；长码换不出任何权限）。 */
  let pendingDevice = null

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cloud_bind',
    description: '把 DSH 绑定到云端网页端账号（两步：先申请一组设备码，你在网页端登录后确认，再调一次本工具兑现）。绑定后完整回答会存到你自己的账号下。',
    parameters: {
      cancel: { type: 'boolean', description: '可选：放弃当前待确认的那组码，重新申请一组' },
    },
    output: textOutput,
    async execute(args) {
      const config = liveConfig()
      if (!config.cloudUrl) {
        return '还没配云端网页端地址。请在「设置 → QQ 提醒与记忆 → 云端账号（网页端）」填 cloudUrl（例如 http://cyanovo.top），再调本工具。'
      }

      // 已有待确认的码 → 这一次是来兑现的
      if (pendingDevice && args?.cancel !== true) {
        const r = await cloudDevicePoll({ cloudUrl: config.cloudUrl, deviceCode: pendingDevice.deviceCode, log })
        if (!r.ok) {
          // 码过期/不存在：清掉暂存，让人重新申请，别一直卡在一个死码上
          const gone = /过期|expired|不存在|not found/i.test(String(r.error))
          if (gone) pendingDevice = null
          return `这次没换成：${r.error}${gone ? '（已作废，再调一次 cloud_bind 重新申请）' : '（还没在网页端确认？确认好再调一次）'}`
        }
        if (r.status === 'pending') {
          return `还在等你在网页端确认。打开 ${config.cloudUrl} → 登录 → 「账号」页 → 输入这串码：${pendingDevice.userCode}\n确认好之后再调一次 cloud_bind。`
        }
        if (r.status === 'approved' && r.token) {
          const saved = await persistUiPatch({ cloudToken: r.token })
          pendingDevice = null
          const who = describeAccount(r.me) || `账号 ${r.username ?? '(未知)'}`
          return `绑定成功：${who}\n令牌已保存（${saved.via === 'dsh-settings' ? 'DSH settings' : '插件覆盖文件'}），以后完整回答会存到这个账号下。`
        }
        if (r.status === 'used') {
          pendingDevice = null
          return '这组码的令牌之前已经交付过一次了（可能上次没存上）。再调一次 cloud_bind 重新申请一组。'
        }
        return `未知状态：${r.status}`
      }

      // 没有待确认的码（或被要求换一组）→ 申请
      const s = await cloudDeviceStart({ cloudUrl: config.cloudUrl, log })
      if (!s.ok) return `申请设备码失败：${s.error}`
      pendingDevice = s
      return [
        `请在 ${Math.round(s.expiresIn / 60000)} 分钟内确认（超时要重新申请）：`,
        `1. 打开 ${config.cloudUrl} 并登录（没有账号就先注册，免费版每天 100 次）`,
        `2. 进「账号」页，把这串码填进「设备码确认」：${s.userCode}`,
        '3. 回到这里，再调一次 cloud_bind —— 拿到令牌我会自动保存。',
      ].join('\n')
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cloud_status',
    description: '查看云端账号绑定状态：绑到哪个账号、什么档位、今天还剩多少次、记录保留多久。',
    parameters: {},
    output: textOutput,
    async execute() {
      const config = liveConfig()
      if (!config.cloudUrl) return '未配置 cloudUrl（云端网页端地址），当前没有云端账号。'
      if (!config.cloudToken) return `未绑定账号（cloudUrl=${config.cloudUrl}）。调 cloud_bind 走设备码绑定。`
      const r = await cloudMe({ cloudUrl: config.cloudUrl, token: config.cloudToken, log })
      if (!r.ok) return `查询失败：${r.error}（令牌可能已被吊销，重新 cloud_bind 即可）`
      if (!r.me) return '令牌有效，但服务端说这个账号不存在了（可能已注销）。'
      const q = r.me.quota ?? {}
      return [
        describeAccount(r.me),
        `模式偏好：${r.me.mode ?? '(未设置)'}`,
        `注册于：${r.me.createdAt ? new Date(r.me.createdAt).toISOString() : '?'}`,
        `重置时间：${q.resetAt ? new Date(q.resetAt).toISOString() : '?'}`,
      ].join('\n')
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cloud_unbind',
    description: '解除云端账号绑定：删掉本机保存的账号令牌，之后完整回答不再上传（服务端的令牌需要用网页端「我的令牌」吊销才会真的失效）。',
    parameters: {},
    output: textOutput,
    async execute() {
      const config = liveConfig()
      if (!config.cloudToken) return '本来就没绑定，无需解绑。'
      const saved = await persistUiPatch({ cloudToken: '' })
      // 服务端那把令牌**不会**因为本机删掉就失效：必须说清楚，否则用户以为已经吊销了。
      return `本机令牌已删除（${saved.via === 'dsh-settings' ? 'DSH settings' : '插件覆盖文件'}）。\n⚠️ 服务端那把令牌仍然有效——要真正吊销，请到 ${config.cloudUrl} 的「账号 → 我的令牌」里删除它。`
    },
  })))

  // 启动自检：明确区分「settings 读到了配置」与「没读到、在用默认值」。
  /**
   * 启动/兜底自检（定义在 apply 内，才能闭包读到 settingsScope / liveConfig / log）。
   *
   * ⚠️ 这里有两个踩过的坑，都写下来防止回归：
   *
   * 1. **不要在 apply 顶部 early-eval 配置**。本函数必须在 `setupSettings()` 之后调用；
   *    早调用会拿到 `settingsScope === undefined` 时的默认值，而旁边"配置来源"那行读的
   *    是 scope，于是两行日志自相矛盾（"配置来源是 settings.yaml" 却"hubUrl 未配置"）。
   *
   * 2. **两个数据源必须自洽**。下面显式断言：scope 里有值、但 liveConfig() 却是空，
   *    说明合并/归一化逻辑坏了——直接报错，不再指望肉眼发现。
   */
  /**
   * 「运行状态」清单 —— 启动时**不再往日志刷**，改由设置面板显示。
   *
   * 主人 2026-10-03 的原话：「除了 QQ 提醒已开、协作已开，剩下的放到设置里就行」。
   * 之前每次启动要打十来行（配置来源、中枢、云端、agentmd、界面改过的配置、
   * 提问中继…），看的人只会去关心"到底开没开"。这些信息本身有用（排查时要用），
   * 所以不是删掉，而是搬到「设置 → QQ 远程提醒与跨会话记忆」顶部当只读状态看。
   *
   * ⚠️ 例外：**警告仍然打日志**。见 reportStatus() —— 出了故障必须看得见，
   *    那不属于"日常状态"。
   *
   * @returns {Array<{label: string, value: string, warn?: boolean}>}
   */
  const statusLines = () => {
    const live = liveConfig()
    const fromSettings = settingsScope !== undefined
    const lines = []
    lines.push(fromSettings
      ? { label: '配置来源', value: `settings.yaml 的 "${SETTINGS_NS}" 段` }
      : { label: '配置来源', value: '内置默认值（settings 服务不可用）—— settings.yaml 里的配置不会生效', warn: true })

    lines.push({ label: '通知中枢', value: live.hubUrl || '未配置（事件仅记录、不发送）' })

    if (live.cloudUrl) {
      lines.push({
        label: '云端网页端',
        value: `${live.cloudUrl}${live.cloudToken ? '（已绑定账号令牌）' : '（还没绑定账号）'}`,
      })
    } else {
      lines.push({ label: '云端网页端', value: '未配置（全文不会上传到云端）' })
    }

    lines.push({
      label: 'agentmd',
      value: live.agentmdDir
        ? `${live.agentmdDir}（自动日志 ${live.agentmdAppendLog ? '开' : '关'}，上下文注入 ${live.agentmdInject ? `开，上限 ${live.agentmdInjectMaxChars} 字符` : '关'}）`
        : '未配置（自动日志与上下文注入均关闭）',
    })

    const qqCredentialsMissing = !live.qqAppId || !live.qqClientSecret
    lines.push({
      label: 'QQ 远程提醒',
      value: !live.qqEnabled
        ? '未启用（qqEnabled=false）'
        : qqCredentialsMissing
          ? 'qqEnabled=true 但 qqAppId / qqClientSecret 没配齐'
          : (live.qqNotifyEnabled === false ? '通道已连、提醒开关关着' : '开启'),
      warn: live.qqEnabled === true && qqCredentialsMissing,
    })

    if (live.qqEnabled) {
      lines.push({
        label: 'QQ 提问中继',
        value: !live.onQuestion ? '关闭（提问只走桌面）' : (qqQuestionRelay ? '已接上（提问带编号选项发到 QQ）' : '暂未接上'),
        warn: live.onQuestion === true && !qqQuestionRelay,
      })
    }

    const overriddenKeys = Object.keys(uiOverrides)
    lines.push({
      label: '界面改过的配置',
      value: overriddenKeys.length > 0 ? `${overriddenKeys.length} 项：${overriddenKeys.join(', ')}` : '无',
    })
    lines.push({ label: '覆盖文件', value: overrideFile })

    lines.push({
      label: '协作面板',
      value: live.agentmdDir ? live.collabPanelFile : '未落盘（agentmdDir 未配置）',
    })

    // QQ 里的链接会被改写成「http://大写域名/路径」（唯一实测能点开的形式），
    // 所以 https / 带端口的云端地址要提前说清楚 —— 放在状态里，别再刷启动日志。
    if (live.cloudUrl) {
      const warn = qqLinkWarning(live.cloudUrl)
      if (warn) lines.push({ label: 'QQ 链接提示', value: warn, warn: true })
    }
    return lines
  }

  const reportStatus = () => {
    const live = liveConfig()
    const fromSettings = settingsScope !== undefined
    const scopeValue = fromSettings ? safeScopeGet() : undefined

    // 把这次自检算出的运行状态**留一份**：界面走 config API 的 status，
    // 测试与手工排查可以直接读它，不必再去日志里抠字符串。
    try { lastStatusSnapshot = statusLines() } catch { lastStatusSnapshot = [] }

    // 🔴 配置文件存在性自检（2026-10-02 真实事故）：
    // `~/.dsh/settings.yaml` 一旦丢失，DSH 设置面板会显示「什么都没配置」、QQ 胶囊显示
    // 「未连接」，**但桌面版内存里仍留着启动时读到的值 —— 推送看起来完全正常**。
    // 这个静默故障已经发生过两次，所以每次启动都把话说明白。
    try {
      readFileSync(join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'settings.yaml'), 'utf8')
    } catch {
      log('⚠️ 读不到 ~/.dsh/settings.yaml —— 设置面板会显示「什么都没配置」、QQ 状态显示未连接，')
      log('   即使推送仍然正常（那是桌面版内存里的旧值）。修复：把 settings.yaml.imported 复制成 settings.yaml。')
    }

    // ⚠️ 配置来源不对 = 什么都没生效，这属于**故障**，必须留在日志里。
    if (!fromSettings) {
      log('⚠️ 配置来源：内置默认值（settings 服务不可用或未注册成功）——settings.yaml 里的配置**不会生效**')
    }

    // 自洽性断言：scope 有值 但 liveConfig 为空 → 逻辑坏了，必须报出来。
    if (fromSettings && scopeValue && typeof scopeValue.hubUrl === 'string' && scopeValue.hubUrl !== ''
        && live.hubUrl === '') {
      log('⚠️ 内部不一致：settings scope 读到了 hubUrl，但 liveConfig() 归一化后为空——请报告此问题')
    }

    // ⚠️ 配得不对 = QQ 根本连不上，也是故障。
    if (live.qqEnabled && (!live.qqAppId || !live.qqClientSecret)) {
      log('⚠️ qqEnabled=true 但 qqAppId / qqClientSecret 没配齐，QQ 通道不会连接')
    }
    if (live.qqEnabled && live.onQuestion && !qqQuestionRelay) {
      log('⚠️ QQ 提问中继：暂未接上 —— 若稍后 userQuestions 服务就绪会自动补接；'
        + '若始终保持未接上，提问只会推无选项的纯文本，在 QQ 里无法作答')
    }

    // ── 只留主人要看的两行（其余见设置面板的「运行状态」）────────────────
    if (live.qqEnabled) {
      log(`QQ 提醒：${live.qqNotifyEnabled === false ? '已开（提醒开关关着）' : '已开'}`
        + `（AppID ${String(live.qqAppId).slice(0, 6)}…，专属会话 cwd=${live.qqCwd || process.cwd()}）`)
    } else {
      log('QQ 提醒：未开（设置 → QQ 远程提醒）')
    }
    log(live.collabEnabled
      ? `协作：已开（范围 ${live.collabScope}，写冲突 ${live.collabClaimGuard}）`
      : '协作：关')
  }

  // ── QQ 官方机器人接线 ───────────────────────────────────────────────────
  // 提问中继：包装 userQuestions.ask，让提问同时出现在桌面和 QQ。
  // ⚠️ 是"包装"不是"注册 provider"——provider 全局唯一，抢注会把桌面 UI 弄坏。
  qqQuestionRelay = qq.wrapUserQuestions(ctx)

  // ⚠️⚠️ `wrapUserQuestions` **只试一次是不够的** —— 这正是主人报「提问还是不行」的真根因
  //      （2026-10-02 定案，有 cordis 源码依据）：
  //
  //      `vendor/cordis/lib/index.js` 的 `ReflectService._getImpl()`：
  //          get(name, strict = true) { … if (strict && impl.fiber.state !== 2) return … }
  //      即 `ctx.get('userQuestions')` 在**服务提供者那个插件还没加载到 active** 时
  //      返回 `undefined`（这不是故障，是正常的中间态，取决于插件加载顺序）。
  //
  //      旧代码拿到 undefined 就 `qqQuestionRelay = false` 收工，**再没有第二次机会**，
  //      于是 `push('question')` 退化成一条【没有选项的纯文本】：
  //      主人在 QQ 里既看不到 1/2/3，引用回复也无人接 —— 功能等于没做，而且全程无声。
  //
  //      补救：用 `ctx.inject(['userQuestions'], cb)` 声明依赖。cordis 会在该服务
  //      **真正就绪时**回调我们补接一次。这里 ctx.inject 只是兜底，主路径仍是上面那次同步尝试
  //      （缓存命中/加载顺序靠前时，同步那次就已经成功了）。
  if (!qqQuestionRelay) {
    try {
      ctx.inject?.(['userQuestions'], (sctx) => {
        if (qqQuestionRelay) return
        qqQuestionRelay = qq.wrapUserQuestions(sctx)
        log(qqQuestionRelay
          ? 'QQ 提问中继：userQuestions 服务就绪后补接成功'
          : 'QQ 提问中继：补接仍未成功（userQuestions 上没有 ask 方法）')
      })
    } catch (err) {
      log(`QQ 提问中继兜底注册失败（不影响其它功能）：${err?.message ?? err}`)
    }
  }

  // 真正建立连接（惰性：配置不全时什么也不做）。
  if (liveConfig().qqEnabled) {
    void qq.ensureStarted()
    // ── 远程更新接线 ──────────────────────────────────────────────────────
    // ①先回上一条「重启完成」的确认（状态文件里有标记才发）——
    //   主人发完 /update 就眼睁睁看着机器人掉线，起来后必须有一句回执，否则他不知道成没成。
    // ②再开始轮询：启动查一次 + 每 qqUpdateCheckHours 小时一次。
    // 两件事都**不许把异常冒到启动流程里**（更新是"顺手做的事"），所以整段包在 try 里。
    void (async () => {
      try {
        if (await qq.ensureStarted()) await qq.reportRestartIfPending()
        qq.startUpdateCheck()
      } catch (err) {
        log(`远程更新检查启动失败（不影响其它功能）：${err?.message ?? err}`)
      }
    })()
    ctx.effect?.(() => () => {
      qq.stop()
      log('QQ 通道已停止')
    })
  }

  // 配置界面：DSH 设置里那一项 + 输入框下方开关读写的都是这个路由。
  // ⚠️ 只在有 webServer 的环境（桌面版 / dsh web）挂载；headless CLI 里静默跳过。
  // ⚠️⚠️ `getLiveConfig: liveConfig` **不能省**：
  // `settings.describe().value` 只合成「schema 默认 → base → 用户层」三层，
  // **不含 profile 补丁层**（cordis.patch.yml 的 config:），而桌面版又会在启动时
  // 把 ~/.dsh/settings.yaml 改名为 .imported（用户层因此长期为空）。
  // 只读 describe() 的话，界面会一片空白、输入框下方永远显示「QQ 未连接」——
  // 但 QQ 推送其实完全正常。这个假故障已经骗过两轮修复。
  // ⚠️⚠️ `persist: persistUiPatch` 也**不能省**：
  // 桌面版拒绝第三方命名空间写入（`No configurable plugin entry "dsh-remote-qqbot"`），
  // 不接管写入的话，界面上的开关点一下会静默弹回原位（2026-10-02 主人报的正是这个）。
  mountConfigApi(ctx, {
    ns: SETTINGS_NS, log, getLiveConfig: liveConfig, persist: persistUiPatch, getStatus: statusLines,
  })

  // ── 协作模式接线 ────────────────────────────────────────────────────────
  // 同一工作区下的会话自动互相同步「谁在写哪个文件、给谁留了话」。
  // 全部逻辑在 src/collab.js（零裸导入、可脱离 DSH 单测）：
  //   - 自己监听 agent/created / agent/status / tools/pre-execute
  //   - 自己注册 systemPrompt 上下文（remote-qqbot:collab）与 4 个协作工具
  // 所以这里只需把 ctx 与 defineTool 交出去，其余它自己搞定；失败也不能影响其它功能。
  try {
    installCollab(ctx, { defineTool, getConfig: liveConfig, log })
  } catch (err) {
    log(`协作模式装配失败（不影响其它功能）: ${err?.message ?? err}`)
  }

  // 启动自检：把配置来源与生效值一次说清楚。
  // 第三个致命 bug 的教训就是**静默降级**——所以这里必须让"配置到底有没有生效"一眼可见。
  reportStatus()
}
