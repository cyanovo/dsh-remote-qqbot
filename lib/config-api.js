/**
 * 插件自建的配置 HTTP 路由（host 侧）：`/remote-qqbot/api/config.get|config.set`。
 *
 * ## 为什么不用 DSH 的 settings RPC
 *
 * DSH 的配置客户端只能读写**白名单**里的 settings namespace：
 * `packages/host/apiproxy/src/api-proxy.ts:1953` 的 `exposedNamespaces()` 由
 * `WEB_SETTINGS_NAMESPACES`（同文件 :126，硬编码 7 个内置名）与
 * `PRODUCT_SETTINGS_NAMESPACES`（:256）组成，源码注释也写明「a future
 * registration does not become remotely readable or writable by default」。
 * 第三方插件的 namespace 永远不在其中 —— 客户端 `ctx.settingsScope.bind()`
 * 只会拿到 `settings-not-exposed`。
 *
 * 所以走插件自己的路由（第三方 UI 插件 `dsh-better-sidebar` 的
 * `/sidebar/api` + `settings.get`/`settings.update` 是同一做法）：路由里
 * **in-process 调 settings 服务**，浏览器侧只认同源请求。
 *
 * ## 安全边界
 *
 * `isTrustedApiRequest` 与 DSH `/api` 网关同语义（复制自
 * `@deepseek-ai/dsh-client-connection` 的 api-request-trust，因该包不导出这些
 * 助手）：Host 头必须是 loopback 或部署声明的 trusted authority，且拒绝
 * 跨站浏览器标记。这是**防 DNS-rebinding / 跨站**，不是身份认证 ——
 * 本插件与 DSH 其余部分一样，前提是 DSH 的 web 端口本身不暴露给不可信网络。
 *
 * ## 越权防护
 *
 * 写入按 `FIELD_SPECS` **白名单**逐键过滤：未知键强制丢弃、类型强制转换、
 * secret 空串表示「不修改」。所以这个路由无法被用来改本插件之外的任何配置。
 *
 * ## 但白名单还不够：三个键必须「只能手改配置文件」（2026-10-07 安全审查）
 *
 * 上面那条信任校验**不是身份认证**（它自己就这么写着）：任何能连
 * `127.0.0.1:19387` 的本机进程，或者页面里的同源脚本，都能带着一个合法的
 * Host 打进来。所以凡是「改一下就能把数据/代码引到别处」的键，不能放在这个
 * 无认证面上。本插件里有三个这样的键：
 *
 *   - `cloudUrl`      —— 完整回答正文要发去哪个服务器（配合 cloudEnabled / qqFulltextMode，
 *                        能把回答**静默改道**到别人的地址）
 *   - `hubUrl`        —— 通知中枢地址（摘要、会话标题都会往那儿发）
 *   - `qqUpdateSource`—— 从哪儿取新版本；索引里的 url 会被直接交给 `pnpm add` 当安装源，
 *                        配合默认打开的自动重启，等于**在本机执行任意包**
 *
 * 这三个键在 `FIELD_SPECS` 里标 `manualOnly: true`：字段照旧出现在设置页（能看见当前
 * 值、能看见说明），但**写入请求会被硬拒**并回报 `rejected`，界面显示的也是只读值。
 * 要改就手改配置层（profile 的 `cordis.patch.yml` 或 `~/.dsh/remote-qqbot-overrides.json`）——
 * 那两条路本来就需要能写本机文件，攻击面比这个 HTTP 面小得多。
 */

/** 路由前缀（浏览器侧同源 fetch 用）。 */
export const CONFIG_ROUTE_PREFIX = '/remote-qqbot/api'

/** 请求体上限：配置补丁都是小 JSON，超过即拒。 */
const MAX_BODY_BYTES = 64 * 1024

/** 绝不回显明文的字段（写入仍允许，空串 = 保持原值）。 */
const SECRET_KEYS = new Set(['token', 'qqClientSecret', 'dshSecret'])

/**
 * 设置页要渲染的字段清单。
 *
 * 这是 host 侧的**单一真源**：client bundle 不自带字段表，而是渲染这里返回的
 * `fields`，所以以后加一个配置项只需要改这一处 + `Config` schema。
 */
export const FIELD_SPECS = [
  // ── QQ 远程提醒 ──────────────────────────────────────────────────────────
  { key: 'qqEnabled', group: 'qq', label: 'QQ 机器人通道', type: 'boolean',
    description: '总开关。关闭后插件完全不碰 QQ 网络（也不接收 QQ 消息）。' },
  { key: 'qqNotifyEnabled', group: 'qq', label: '接收 QQ 推送', type: 'boolean',
    description: '推送总开关：任务完成 / 需要提问 / 执行出错，以及"有新版本"的提醒，都归它管。'
      + '关掉后 QQ 长连接和反向对话照旧（你发消息我照收照答），只是我不再主动推给你 —— 想安静一会儿就关它。'
      + '输入框旁边那个小开关是同一个东西，两处任一处改了立刻生效。' },
  { key: 'qqAppId', group: 'qq', label: 'AppID', type: 'string', placeholder: 'QQ 开放平台的 AppID',
    description: '到 q.qq.com 建机器人后拿到。' },
  { key: 'qqClientSecret', group: 'qq', label: 'ClientSecret', type: 'secret', placeholder: '留空表示不修改',
    description: 'QQ 开放平台的 ClientSecret。出于安全不回显，留空即保持原值。' },
  { key: 'qqCwd', group: 'qq', label: '专属会话工作目录', type: 'string', placeholder: '留空用当前进程 cwd',
    description: '你在 QQ 里发的话进入的那个专属会话所在的目录。' },
  { key: 'qqRecentCount', group: 'qq', label: '会话列表条数', type: 'number', min: 1,
    description: '发 /sessions（或点菜单「会话」）时列几个最近会话。默认 6，上限 20；回个数字就切过去，之后不引用通知说的话都进那个会话。' },
  { key: 'onTurnComplete', group: 'qq', label: '完成时提醒', type: 'boolean',
    description: '会话跑完一轮时推一条。' },
  { key: 'onQuestion', group: 'qq', label: '提问时提醒', type: 'boolean',
    description: 'agent 需要你回答时推一条。' },
  { key: 'onError', group: 'qq', label: '出错时提醒', type: 'boolean',
    description: '执行出错时推一条。' },
  { key: 'notifySubagents', group: 'qq', label: '子智能体也提醒', type: 'boolean',
    description: '默认关：子任务的通知会淹没主会话那条。' },
  { key: 'notifyChatSession', group: 'qq', label: 'QQ 闲聊会话也提醒', type: 'boolean',
    description: '默认关：你人就在 QQ 里等着回复。' },
  { key: 'qqSummaryChars', group: 'qq', label: '通知摘要长度', type: 'number', min: 0,
    description: '通知里「本轮做了什么」最多几个字，0 = 不附摘要。' },
  { key: 'qqChatReadOnly', group: 'qq', label: '闲聊会话只读', type: 'boolean',
    description: '默认开：你在 QQ 里随口说的那句只读不写 —— 看文件、查状态可以，写/改/删都会被沙箱拒绝。' },
  { key: 'qqChatReply', group: 'qq', label: '闲聊回答直接回 QQ', type: 'boolean',
    description: '默认开：闲聊的回答直接发回 QQ 聊天框，不推通知卡片、不上传。' },
  { key: 'qqChatAnswerChars', group: 'qq', label: '闲聊回答长度上限', type: 'number', min: 100,
    description: '发回 QQ 的回答最多几个字，超出截断。' },
  // 「完整回答怎么给你」这一组是三个模式的核心开关。默认档是 chat：
  // 正文只进 QQ 聊天记录，**一个字节都不上传**（默认档位要经得起"我没同意上传"这句话）。
  { key: 'qqFulltextMode', group: 'qq', label: '完整回答怎么给', type: 'string',
    placeholder: 'chat',
    options: ['chat', 'note', 'note-link'],
    description: 'chat＝切成几条直接发到 QQ（默认，不上传）；note＝只推摘要，正文存服务器（记录留 5 小时，赞助后 2 天）；note-link＝同 note，通知里多一条「查看完整回答」链接。后两档都要先打开「允许上传正文」。' },
  { key: 'qqFulltextMaxChars', group: 'qq', label: '发到 QQ 的正文上限', type: 'number', min: 100,
    description: '只对 chat 档有效：最多发多少字，超出截断。默认 6000，每条 QQ 消息按 900 字切，免得刷屏。' },
  { key: 'cloudEnabled', group: 'qq', label: '允许上传正文', type: 'boolean',
    description: '默认关。关着的时候，选了 note / note-link 也按 chat 处理 —— 一个字都不会离开这台机器。' },
  // 这两个键以前只在 Config schema 里，界面上看不到 —— 于是关掉截图后，
  // 那句「去设置里把『允许截图』打开」的提示指向了一个**并不存在的字段**。
  // 截图会把屏幕上的一切发出去，必须给用户一个能一键关掉的地方。
  { key: 'qqScreenEnabled', group: 'qq', label: '允许截图', type: 'boolean',
    description: '默认开。发 /screen 或点菜单「屏幕」，就把当前整个屏幕拍给你 —— 上面可能有聊天记录、密码、别的窗口。不想被拍就关掉这项。' },
  { key: 'qqScreenMaxWidth', group: 'qq', label: '截图最大宽度', type: 'number', min: 0,
    description: '像素，默认 1600；超宽按比例缩，0 = 不缩放。' },
  // ── 远程更新 ─────────────────────────────────────────────────────────────
  // 装在哪儿、怎么重启都是自动的，所以这里只留"要不要提醒 / 从哪儿取 / 要不要自动重启 / 多久查一次"。
  { key: 'qqUpdateEnabled', group: 'qq', label: '有新版本时提醒我', type: 'boolean',
    description: '默认开。发现新版本会在 QQ 里提醒一次（同一个版本只提一次）；关掉只是不提醒，发 /update 照样能更新。'
      + '注意它还受上面「接收 QQ 推送」那个总开关约束 —— 总开关关着时新版本提醒也不发。' },
  { key: 'qqUpdateSource', group: 'qq', label: '从哪里取新版', type: 'string',
    placeholder: 'https://cyanovo.top/plugins/dsh-remote-qqbot/update.json',
    manualOnly: true,
    description: '默认是服务器上的版本索引（一个 update.json，里面写着版本号与压缩包地址）；也可以填 github:作者/仓库 或 npm 包名。'
      + '出于安全，这一项**不能在网页设置里改**（它决定"装哪份代码"），要改请手改配置文件。' },
  { key: 'qqUpdateAutoRestart', group: 'qq', label: '更新完自动重启', type: 'boolean',
    description: '默认开。DSH 没有插件热重载，必须重启才生效 —— 重启期间机器人会离线十几秒。关掉就只回一句「重启后生效」，由你自己挑时间重启。' },
  { key: 'qqUpdateCheckHours', group: 'qq', label: '多久查一次新版本（小时）', type: 'number', min: 1,
    description: '默认 1 小时。启动时也会查一次；同一个版本只提醒一次。想立刻查：QQ 里发 /update check —— '
      + '它会把带「忽略本次 / 立即更新」两个按钮的提醒直接回给你（没推送成功时这是手动补一次的办法）。' },

  // ── 云端账号（dsh-web 网页端）────────────────────────────────────────────
  //
  // 与「通知中枢」分组分开列：它们看着像同一件事（都是"往服务器上传"），
  // 其实归属、鉴权、配额、可见性全都不同 —— 混在一组里最容易让人以为
  // "配了 hubUrl 就等于有云端账号"。
  { key: 'cloudUrl', group: 'cloud', label: '云端网页端地址', type: 'string',
    placeholder: 'http://cyanovo.top',
    manualOnly: true,
    description: '记录挂在你自己的账号下：登录才能看，按账号算次数。留空 = 不用云端。'
      + '出于安全，这一项**不能在网页设置里改**（它决定完整回答发去哪台服务器），要改请手改配置文件。' },
  { key: 'cloudToken', group: 'cloud', label: '账号令牌', type: 'secret', placeholder: '留空表示不修改',
    description: '别手填：让 DSH 调 cloud_bind 走设备码绑定，令牌会自动写到这儿（服务端只存哈希，可单独吊销）。' },

  // ── 中枢 ────────────────────────────────────────────────────────────────
  { key: 'hubUrl', group: 'hub', label: '中枢地址', type: 'string',
    placeholder: 'https://<你的中枢域名>/dsh-hub',
    manualOnly: true,
    description: '留空则只记日志、不发请求（QQ 通道仍可单独工作）。'
      + '出于安全，这一项**不能在网页设置里改**（它决定摘要与会话标题发去哪台服务器），要改请手改配置文件。' },
  { key: 'token', group: 'hub', label: '中枢令牌', type: 'secret', placeholder: '留空表示不修改',
    description: '与中枢的 DSH_HUB_TOKEN 一致。不回显，留空即保持原值。' },
  { key: 'timeoutMs', group: 'hub', label: '请求超时（毫秒）', type: 'number', min: 100 },

  // ── agentmd ─────────────────────────────────────────────────────────────
  { key: 'agentmdDir', group: 'agentmd', label: 'agentmd 目录', type: 'string',
    placeholder: '<agentmd 目录的绝对路径>',
    description: '留空表示关闭 agentmd 的自动日志与上下文注入。' },
  { key: 'agentmdMainFile', group: 'agentmd', label: '主文档文件名', type: 'string' },
  { key: 'agentmdInject', group: 'agentmd', label: '注入会话上下文', type: 'boolean',
    description: '把主文档注入每个新会话的 system prompt（超出下面的字符上限时只注入压缩后的一部分）。' },
  { key: 'agentmdAppendLog', group: 'agentmd', label: '自动追加操作日志', type: 'boolean',
    description: '会话结束时把「本轮做了什么」追加进第 4 节表格。' },
  { key: 'agentmdSummaryChars', group: 'agentmd', label: '日志摘要长度', type: 'number', min: 0 },
  { key: 'agentmdInjectMaxChars', group: 'agentmd', label: '注入字符硬上限', type: 'number', min: 500,
    description: '防爆上下文的关键：文档被写到几十万字符，注入的也只有这么多（默认 8000）。'
      + '超出的部分先保最近的日志行、再保开头正文，并在正文里写明省略了多少字符。' },
  { key: 'agentmdInjectTailRows', group: 'agentmd', label: '注入保留日志行数', type: 'number', min: 0,
    description: '注入时保留第 4 节表格的最后 N 行；更早的日志不注入（要看全文用 agentmd_read）。' },
  { key: 'agentmdRowMaxChars', group: 'agentmd', label: '单条日志行上限', type: 'number', min: 60,
    description: '单条日志行的字符上限：超长只裁「操作」列，时间列和表格结构不动。' },

  // ── 协作模式 ────────────────────────────────────────────────────────────
  //
  // 这几个键以前只存在于 Config schema 里（默认开），界面上看不到、也改不了 ——
  // 于是"同一工作区下的会话自动协作"是一个**用户关不掉的**行为。
  // 现在补进字段表：既出现在设置面板里，也是输入框下方那个小开关的读写对象。
  { key: 'collabEnabled', group: 'collab', label: '协作模式', type: 'boolean',
    description: '同一工作区下的会话自动共享「谁在改哪些文件」和留言。关掉就立刻噤声（工具还在，只是不再协作）。' },
  { key: 'collabScope', group: 'collab', label: '协作范围', type: 'string', placeholder: 'workspace',
    description: 'workspace = 只跟同一工作目录的会话协作；global = 所有会话。', options: ['workspace', 'global'] },
  { key: 'collabClaimGuard', group: 'collab', label: '写冲突处理', type: 'string', placeholder: 'warn',
    description: 'warn = 只提醒；block = 直接拒绝写入；off = 完全不介入。', options: ['warn', 'block', 'off'] },
  { key: 'collabInject', group: 'collab', label: '注入协作现状', type: 'boolean',
    description: '把「谁在跑、占了哪些文件、有什么留言」注入会话上下文；没有别的会话时不注入。' },
  { key: 'collabIncludeSubagents', group: 'collab', label: '子智能体也参与', type: 'boolean',
    description: '默认关：子任务是主会话派生的，参与协作只会刷屏。' },
]

/** key → spec，写入白名单查表用。 */
const SPEC_BY_KEY = new Map(FIELD_SPECS.map((spec) => [spec.key, spec]))

/**
 * 「只能手改配置文件」的键（`manualOnly`）。
 *
 * 为什么需要这一层：本路由的信任校验只挡浏览器跨站与 DNS-rebinding，**不是身份认证**
 * —— 任何本机进程或同源脚本都能带合法 Host 打进来。所以「改一下就能把正文/摘要改道，
 * 或把安装源换成别人的包」的键，一律不许从这个面无认证地写（详见文件头「越权防护」）。
 *
 * 从 `FIELD_SPECS` 派生（单一真源）：标了 `manualOnly: true` 的条目自动进这张表，
 * 不存在"表里漏了一个"的第二种可能。
 */
export const MANUAL_ONLY_KEYS = new Set(
  FIELD_SPECS.filter((spec) => spec.manualOnly === true).map((spec) => spec.key),
)

/** 分组标题（设置页按此顺序渲染）。 */
export const FIELD_GROUPS = [
  { id: 'qq', title: 'QQ 远程提醒', hint: '手机 QQ 上的通知与反向派活' },
  { id: 'cloud', title: '云端账号（网页端）', hint: '完整回答存到自己账号下：免费版 100 次/天，记录留 5 小时（地址只能手改配置文件）' },
  { id: 'hub', title: '通知中枢', hint: '自建中枢的收件箱与记忆存储（可选，暂未部署）' },
  { id: 'agentmd', title: 'agentmd 跨会话上下文', hint: '操作日志自动追加与上下文注入' },
  { id: 'collab', title: '协作模式', hint: '同一工作区下多个会话自动互相通报与留言' },
]

// ── 浏览器信任 fence（与 DSH /api 网关同语义）───────────────────────────────

/** 规范化 URL 的 Host 是否指向本机 loopback。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 解析 Host 头为 URL，失败返回 undefined。 */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** 规范化 trustedHosts 条目的 authority 形式。 */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** trustedHosts 命中（精确或省略端口）。 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * 一个请求是否允许打到本插件的配置路由。
 * @param {import('node:http').IncomingMessage} request - node 请求（只读 headers）。
 * @param {readonly string[]} trustedHosts - 部署声明的非 loopback authority。
 * @returns {boolean} Host 属于本机/受信，且不带跨站浏览器标记。
 */
export function isTrustedApiRequest(request, trustedHosts) {
  const pick = (name) => {
    const value = request.headers?.[name]
    return typeof value === 'string' ? value : undefined
  }
  const host = pick('host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (pick('sec-fetch-site') === 'cross-site') return false
  const origin = pick('origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── 读写 ────────────────────────────────────────────────────────────────────

/** 写 JSON 响应（配置内容一律不缓存）。 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 读 JSON 请求体（带上限，超出/非法即抛）。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 把字段值强制成 schema 认得的类型；不可用的值返回 `undefined`（表示跳过该键）。
 * @param {{type: string, min?: number}} spec - 字段规格。
 * @param {unknown} raw - 浏览器送来的原始值。
 * @returns {unknown} 归一化后的值，或 undefined 表示不改这个键。
 */
function coerce(spec, raw) {
  if (spec.type === 'boolean') return raw === true || raw === 'true'
  if (spec.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) return undefined
    if (typeof spec.min === 'number' && n < spec.min) return undefined
    return n
  }
  if (raw === null || raw === undefined) return undefined
  return String(raw)
}

/**
 * 读当前配置视图：字段清单 + 脱敏后的值 + revision。
 * @param {object} settings - DSH settings 服务。
 * @param {string} ns - 本插件的 namespace。
 * @param {Function|object} [live] - host 侧真值（见下方长注释）。
 * @param {Function|Array} [status] - 「运行状态」清单（只读），由 host 提供。
 *   ⚠️ 它是给**设置面板**看的：以前这些东西是每次启动往日志刷十来行，
 *   主人 2026-10-03 明确要求「除了 QQ 提醒已开、协作已开，剩下的放到设置里就行」。
 * @returns {{ok: true, revision: number|undefined, groups: unknown[], fields: unknown[], values: object, secretsSet: object, status: Array<{label: string, value: string, warn?: boolean}>}}
 */
export function configView(settings, ns, live, status) {
  let descriptor
  try {
    descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === ns)
  } catch {
    descriptor = undefined
  }

  // ⚠️⚠️ 为什么不能只信 describe()：
  //
  // `describe().value` 只合成「schema 默认 → registrant 的 base → 用户层」三层
  // （packages/settings/settings/src/index.ts:696 resolve()，注释原文
  //  "Resolve one namespace value: schema defaults, then `base`, then the user layer"）。
  // **profile 补丁层（cordis.patch.yml 的 config:）不在其中** —— 它只经
  // cordis 的 resolveConfig() 传给 apply(ctx, config)。
  //
  // 而桌面版启动时会把 `~/.dsh/settings.yaml` 无条件改名为 `settings.yaml.imported`
  // （见 app.asar 的 SettingsForms.importLegacyDocument()），用户层因此长期为空。
  //
  // 两者叠加的结果：h ost 侧（liveConfig）配置齐全、QQ 推送一切正常，
  // 但这个 UI 路由读 describe() 得到**全 null** → 显示「QQ 未连接」+ 设置面板空白。
  // 这个假故障曾连续骗过两轮修复（05:08 那轮往 settings.yaml 写配置，会立刻被改名）。
  //
  // 所以这里用 host 侧的真值兜底：UI 显示的必须与插件**实际在用**的配置一致。
  const fromSettings = descriptor?.value ?? {}
  let fromHost = {}
  if (live !== undefined && live !== null) {
    try {
      // 正常契约是函数（host 每次请求现取，settings 热更新立刻反映到界面）；
      // 也接受直接传对象 —— 单测与手工排查时更顺手，且避免「传了对象却被静默忽略」。
      const raw = typeof live === 'function' ? live() : live
      if (raw && typeof raw === 'object') fromHost = raw
    } catch {
      fromHost = {}
    }
  }
  const value = { ...fromSettings }
  for (const [key, raw] of Object.entries(fromHost)) {
    if (raw !== undefined && raw !== null) value[key] = raw
  }

  const values = {}
  const secretsSet = {}
  for (const spec of FIELD_SPECS) {
    const raw = value[spec.key]
    if (SECRET_KEYS.has(spec.key) || spec.type === 'secret') {
      // 明文绝不回显：只告诉前端「已经设过值」。
      // 注意这里的 raw 可能是 host 侧真值（明文），所以判断后必须立刻丢弃。
      secretsSet[spec.key] = typeof raw === 'string' ? raw !== '' : raw !== undefined && raw !== null
      values[spec.key] = ''
      continue
    }
    values[spec.key] = raw ?? null
  }
  return {
    ok: true,
    revision: descriptor?.revision,
    groups: FIELD_GROUPS,
    fields: FIELD_SPECS,
    values,
    secretsSet,
    // 只读「运行状态」：启动日志里不再刷的那些（中枢/云端/agentmd/覆盖文件…）。
    // 取不到就返回空数组，界面不显示这一块，绝不因此让整个配置视图失败。
    status: (() => {
      try {
        const raw = typeof status === 'function' ? status() : status
        if (!Array.isArray(raw)) return []
        return raw
          .filter((row) => row && typeof row.label === 'string')
          .map((row) => ({
            label: row.label,
            value: String(row.value ?? ''),
            warn: row.warn === true,
          }))
      } catch {
        return []
      }
    })(),
    // 诊断用：说明这次读数的来源，便于线上排查「设置面板空白」类问题。
    diag: {
      settingsNamespaceFound: descriptor !== undefined,
      hostConfigKeys: Object.keys(fromHost).length,
      source: descriptor !== undefined && Object.keys(fromHost).length > 0
        ? 'settings+host'
        : (Object.keys(fromHost).length > 0 ? 'host' : (descriptor !== undefined ? 'settings' : 'none')),
    },
  }
}

/**
 * 挂载配置路由（随 fiber 释放）。
 *
 * ⚠️ 用 `ctx.inject(['webServer', 'webRuntime'])` 而**不是**写进模块级 inject 数组：
 * 本插件在 headless / CLI 环境同样要工作（agentmd、记忆、QQ），而那些环境没有
 * webServer。写进模块级 inject 会让插件在 CLI 里整个不加载。缺失时静默跳过：
 * 没有 web 界面，也就没有配置界面要服务。
 *
 * @param {object} ctx - 插件上下文。
 * @param {{ns: string, log: (msg: string) => void, getLiveConfig?: () => object, persist?: (patch: object, expectedRevision: unknown) => Promise<{via?: string, applied?: string[]}>, getStatus?: () => Array<{label: string, value: string, warn?: boolean}>}} options
 *   - namespace、日志，以及可选的「host 侧真值」读取函数与「写入落盘」函数。
 *   ⚠️ `getLiveConfig` 是**应当**传的：`settings.describe()` 拿不到 profile 补丁层
 *   （详见 configView 顶部注释），只靠它会让设置面板一片空白、输入框下方
 *   误报「QQ 未连接」——而 QQ 推送其实完全正常。
 *   ⚠️ `persist` 也是**应当**传的：桌面版 `SettingsService.write()` 只认
 *   profile 里 id 等于 ns 的条目（我们的条目 id 是 `remote-qqbot`，不是
 *   `dsh-remote-qqbot`），第三方命名空间直接抛
 *   `No configurable plugin entry "..."`。不接管写入的话，界面上的开关
 *   点一下会**静默弹回原位**（2026-10-02 主人报的问题）。
 *   传了就由它负责「先试原生、失败落插件自己的覆盖文件」，见 src/overrides.js。
 * @returns {boolean} 是否已请求挂载（服务就绪后才真正注册）。
 */
export function mountConfigApi(ctx, { ns, log, getLiveConfig, persist, getStatus }) {
  if (typeof ctx.inject !== 'function') return false
  try {
    ctx.inject(['webServer', 'webRuntime'], (sctx) => {
      const webServer = sctx.webServer
      if (!webServer?.register) return
      const trustedHosts = () => {
        try {
          return sctx.webRuntime?.trustedHosts ?? []
        } catch {
          return []
        }
      }
      // host 侧真值（liveConfig）：每次请求现取，保证 settings 热更新后界面立刻跟上。
      const live = () => (typeof getLiveConfig === 'function' ? getLiveConfig() : {})
      /** 只读运行状态（启动日志里不再刷的那些）。 */
      const status = () => (typeof getStatus === 'function' ? getStatus() : [])
      const handler = async (req, res) => {
        if (!isTrustedApiRequest(req, trustedHosts())) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: '请求来源不可信' } })
          return
        }
        const settings = sctx.get('settings')
        if (!settings?.describe) {
          writeJson(res, 503, { ok: false, error: { code: 'settings-absent', message: 'settings 服务不可用' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith(`${CONFIG_ROUTE_PREFIX}/`)
          ? pathname.slice(CONFIG_ROUTE_PREFIX.length + 1)
          : ''

        // GET = 读当前配置（命令行 curl 也能直接看，验证用）
        if (method === 'config.get' && (req.method === 'GET' || req.method === 'POST')) {
          try {
            writeJson(res, 200, configView(settings, ns, live, status))
          } catch (error) {
            writeJson(res, 500, { ok: false, error: { code: 'read-failed', message: String(error?.message ?? error) } })
          }
          return
        }

        if (method === 'config.set') {
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: { code: 'method-error', message: '只接受 POST' } })
            return
          }
          let payload
          try {
            payload = await readJsonBody(req)
          } catch (error) {
            writeJson(res, 400, { ok: false, error: { code: 'bad-body', message: String(error?.message ?? error) } })
            return
          }
          const patch = {}
          const rejected = []
          for (const [key, raw] of Object.entries(payload?.patch ?? {})) {
            const spec = SPEC_BY_KEY.get(key)
            if (spec === undefined) continue // 白名单之外：直接丢弃
            // 「只能手改配置文件」的键：**硬拒**，并且如实回报，别让调用方以为写成功了。
            // 这一层是安全边界（决定数据去哪、装哪份代码），不是权限偏好，所以不静默丢弃。
            if (MANUAL_ONLY_KEYS.has(key)) {
              rejected.push({ key, reason: '该字段只能手改配置文件（网页路由不是身份认证面）' })
              continue
            }
            if (spec.type === 'secret' && String(raw ?? '') === '') continue // 空 = 不改
            const coerced = coerce(spec, raw)
            if (coerced !== undefined) patch[key] = coerced
          }
          if (rejected.length > 0) {
            log(`配置写入被拒（只能手改配置文件）：${rejected.map((row) => row.key).join(', ')}`)
          }
          if (Object.keys(patch).length === 0) {
            writeJson(res, 200, { ...configView(settings, ns, live, status), applied: [], rejected })
            return
          }
          try {
            // 优先用 host 注入的 persist（桌面版唯一能真正落盘的路径）；
            // 没传时才退回原生 settings.update（允许第三方命名空间写入的环境）。
            let applied
            let via
            if (typeof persist === 'function') {
              const result = await persist(patch, payload?.expectedRevision)
              applied = Array.isArray(result?.applied) && result.applied.length > 0
                ? result.applied
                : Object.keys(patch)
              via = result?.via ?? 'unknown'
            } else {
              await settings.update(ns, patch, payload?.expectedRevision)
              applied = Object.keys(patch)
              via = 'dsh-settings'
            }
            log(`配置已更新：${applied.join(', ')}（${via}）`)
            writeJson(res, 200, { ...configView(settings, ns, live, status), applied, rejected, via })
          } catch (error) {
            // ⚠️⚠️ `ok: false` 必须写在 `...configView(...)` **之后**。
            // configView() 返回的对象里带 `ok: true` —— 展开在后面会把前面的
            // `ok: false` 覆盖掉，浏览器于是把失败当成功：开关弹回原位、一个字的提示都没有。
            // 这正是 2026-10-02「点了没有用」最直接的成因之一。
            log(`配置写入失败：${String(error?.message ?? error)}`)
            writeJson(res, 200, {
              ...configView(settings, ns, live, status),
              ok: false,
              applied: [],
              rejected,
              error: { code: 'settings-rejected', message: String(error?.message ?? error) },
            })
          }
          return
        }

        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `未知方法 "${method}"` } })
      }

      ctx.effect(
        () => webServer.register({ kind: 'prefix', path: CONFIG_ROUTE_PREFIX, handler }),
        'remote-qqbot: 配置路由',
      )
      log(`配置界面路由已挂载：${CONFIG_ROUTE_PREFIX}（同源 + 本机信任校验）`)
    })
    return true
  } catch (error) {
    log(`配置路由挂载失败（不影响其它功能）：${String(error?.message ?? error)}`)
    return false
  }
}
