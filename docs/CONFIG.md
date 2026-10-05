# 配置

> 本文件是配置的完整说明：写在哪个文件、谁覆盖谁、全部字段与默认值。安装与上手见 [README](../README.md)。

**默认玩法只用到两个值：`qqAppId` 和 `qqClientSecret`** —— 其余配置项全部有默认值、都能留空。

推荐**直接在 DSH 界面里改**（见下节：分组表单、每项带说明、凭证填进去**不回显**）。
保存后值落到插件自有的覆盖文件 `~/.dsh/remote-qqbot-overrides.json`，host 侧每次用时现读，
**不用重启**（只有浏览器侧 `client.js` 的改动才需要重启）。也可以手写 YAML
（`~/.dsh/settings.yaml` 或 profile 的 `cordis.patch.yml`；**不要带 BOM**，否则首个键名会解析错）。

**最小可用配置就这几行**：

```yaml
dsh-remote-qqbot:
  qqEnabled: true
  qqAppId: '你的 AppID'
  qqClientSecret: '你的 ClientSecret'
```

可选、但比较常用的几个：

```yaml
dsh-remote-qqbot:
  agentmdDir: D:\你的项目\agentmd   # 填了才有 agentmd 自动日志与上下文注入
  qqCwd: D:\你的项目                # QQ 专属会话（/task 派活）的工作目录
  hubUrl: https://…/dsh-hub         # 跨会话记忆；留空则只记日志、不发请求
  token: <中枢 Bearer 令牌>
  cloudUrl: https://…               # 云端账号 —— 只有想用短链接才需要它
  cloudToken: <账号令牌>            # 别手填：让 DSH 调工具 cloud_bind 走设备码绑定写入
```

**完整清单见本节末尾的「全部配置项」表**，每一项都有默认值与说明。

## 在 DSH 界面里改（不用手写 YAML）

插件带浏览器侧 UI（`src/client.js` → `lib/client.js`），装好后重启 DSH 就有两处入口：

| 入口 | 位置 | 作用 |
|---|---|---|
| **设置 → QQ 远程提醒与跨会话记忆** | 设置面板左侧导航里独立的一项 | 分组表单：QQ 凭证（AppID / ClientSecret）、**完整回答怎么给 / 允许上传正文**、远程提醒开关、**允许截图 / 截图最大宽度**、通知中枢、agentmd、**协作模式**（总开关 / 范围 / 冲突策略 / 上下文注入 / 是否含子智能体）。凭证**不回显**，留空即保持原值 |
| **输入框工具行里的两个低调小开关** | 会话输入框那一行（工具行） | 左边 `QQ 提醒已开/已关`（关掉只停提醒，不断开长连接——引用回复、`/task` 照常可用）；右边 `协作已开/已关`（关掉后同工作区会话不再互相通报占用与留言）。两个都是 12px 浅灰小字 + 小圆点，**无边框无底色**，鼠标悬停才轻微加深 |

两点设计说明：

- **填写凭证不用手改 YAML**：设置页/小开关保存后写进插件自己的覆盖文件，host 侧每次用时现读，
  **无需重启**（只有 `client.js` 本身的改动才需要重启才能看到新 UI）。
- **为什么设置页不是 DSH 内置的插件卡片**：DSH 的配置 RPC 只服务**硬编码白名单**里的 namespace
  （`packages/host/apiproxy/src/api-proxy.ts:126` 的 `WEB_SETTINGS_NAMESPACES`，源码注释明说
  「a future registration does not become remotely readable or writable by default」），第三方插件的
  namespace 永远不在白名单里，客户端 `settingsScope.bind()` 只会拿到 `settings-not-exposed`。
  所以插件**自建**一条同源路由 `/remote-qqbot/api`（`src/config-api.js`），在进程内直连 settings 服务；
  路由带与 DSH `/api` 网关同语义的浏览器信任校验（Host 必须 loopback / 受信 authority、拒绝跨站标记），
  并按白名单逐键过滤写入 —— 它改不了本插件之外的任何配置。

## 配置写在哪、谁盖谁（0.8.4 新增）

桌面版的设置服务**拒绝第三方 namespace 的写入**：`ctx.settings.update()` 会抛
`No configurable plugin entry "dsh-remote-qqbot"`（entry id 用的是 profile 里的 `remote-qqbot`，
与插件注册的 namespace 名对不上，而且 `describe()` 会跳过没有 volatile 字段的条目）。
于是 `POST /remote-qqbot/api/config.set` 一旦只依赖原生写入，就必然失败 ——
**失败又被错误地报成成功**（`configView(...)` 的 `ok:true` 展开排在 `ok:false` 之后），
表现就是「点一下开关，界面弹回原样、也不报错」。0.8.4 把这两件事一起修了。

写入顺序（`src/overrides.js` 的 `persistConfigPatch`）：

| 顺序 | 动作 | 结果 |
|---|---|---|
| 1 | 先试原生 `settingsScope.update()` | 一旦 DSH 将来放开第三方写入，自动改走官方通道（自愈），并回报 `via: 'dsh-settings'` |
| 2 | 抛错则落**插件自有覆盖文件** | `~/.dsh/remote-qqbot-overrides.json`，原子写（临时文件 + rename），回报 `via: 'override-file'` |
| 3 | 覆盖文件也写不进去 | **抛错**，路由据此回 `ok:false` + `error.code='settings-rejected'`，前端显示红色「切换失败：…」 |

配置合并优先级（`liveConfig()`，后者盖前者）：

```
DEFAULTS  <  settings 用户层  <  cordis.patch.yml 的显式键  <  ~/.dsh/remote-qqbot-overrides.json
```

覆盖文件**故意排在最后**：否则 `cordis.patch.yml` 里写死的 `collabEnabled: true`
会让「关掉协作」永远关不掉。

> ⚠️ **安全提醒**：覆盖文件是**明文 JSON**，与 `cordis.patch.yml` 同级暴露
> （`qqClientSecret` / `token` 会以明文躺在里面）。UI 与 API 从不回显明文，
> 只报 `secretsSet: true/false`。介意的话请把 `~/.dsh` 目录权限收紧到当前用户。
>
> ⚠️ **删掉这个文件 = 开关回到 profile 配置的旧值**；这是它的全部状态，没有别的暗桩。

## 全部配置项

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `hubUrl` | string | `''` | 中枢服务地址；留空则只记日志、不发请求 |
| `token` | string | `''` | Bearer 令牌，与中枢的 `DSH_HUB_TOKEN` 一致 |
| `timeoutMs` | number | `10000` | 请求超时（毫秒） |
| `onTurnComplete` | boolean | `true` | 任务完成时推送 |
| `onQuestion` | boolean | `true` | 需要提问时推送 |
| `onError` | boolean | `true` | 执行出错时推送 |
| `dedupeMs` | number | `4000` | 去重窗口（毫秒） |
| `errorSummaryChars` | number | `300` | 出错摘要最大长度 |
| `agentmdDir` | string | `''` | agentmd 目录绝对路径；**留空即关闭自动日志与注入** |
| `agentmdMainFile` | string | `'main.md'` | 主文档文件名（相对 `agentmdDir`） |
| `agentmdInject` | boolean | `false` | 是否把主文档注入会话上下文（**超出下面的字符上限时只注入压缩后的一部分**） |
| `agentmdSummaryChars` | number | `200` | 日志「操作」列最大字符数 |
| `agentmdAppendLog` | boolean | `true` | 会话结束时是否自动追加操作日志 |
| `agentmdInjectMaxChars` | number | `8000` | 🔴 注入字符**硬上限**：文档再大也只注入这么多，超出的部分在正文里明写「省略约 N 个字符」 |
| `agentmdInjectTailRows` | number | `20` | 注入时保留日志表的最后 N 行；更早的日志不注入（需要时用 `agentmd_read` 读全文） |
| `agentmdRowMaxChars` | number | `600` | 单条日志行的字符上限；超长只裁「操作」列，表格骨架与时间列不动 |
| `collabEnabled` | boolean | `true` | **协作模式总开关**：同一工作区多会话自动同步文件占用与留言 |
| `collabPanelFile` | string | `'plugin-collab.md'` | 自动维护的协作面板文件名（相对 `agentmdDir`） |
| `collabScope` | string | `'workspace'` | `workspace`=只看同工作目录；`global`=所有会话算一个池子 |
| `collabInject` | boolean | `true` | 是否把协作现状注入上下文（**没有别的会话时不注入任何内容**） |
| `collabClaimGuard` | string | `'warn'` | 写冲突处理：`warn` 只提醒 / `block` 拒绝写入 / `off` 不介入 |
| `collabClaimTtlMs` | number | `1800000` | 文件占用过期时间（毫秒）；会话转空闲时也会立即释放 |
| `collabIncludeSubagents` | boolean | `false` | 子智能体是否也参与协作；默认否（它是派出去的内部任务） |
| `notifySubagents` | boolean | `false` | 子智能体（subagent/teammate）跑完是否也推送；默认不推，只推你自己的会话 |
| `notifyChatSession` | boolean | `false` | QQ「闲聊会话」跑完是否推送；默认不推（你人就在 QQ 里等着回复） |
| `qqChatReadOnly` | boolean | `true` | **闲聊会话只读**：每次给闲聊会话投递前把它切到 `read-only` 权限（能查能读、不能改）。关掉则不动权限 |
| `qqChatReply` | boolean | `true` | **闲聊回答直接回 QQ 聊天框**：把这一轮的正文发到 QQ，且**不**上传「完整回答」笔记、不发推送卡片 |
| `qqChatAnswerChars` | number | `1500` | 闲聊回答发到 QQ 的字符上限，超出截断加省略号 |
| `qqScreenEnabled` | boolean | `true` | **是否允许在 QQ 里让我截图**（`/screen` 或菜单「屏幕」）。关掉后只回一句「被我关掉了」并告诉你去哪儿打开 |
| `qqScreenMaxWidth` | number | `1600` | 截图最大宽度（像素），超宽等比缩放；`0` = 不缩放。**这是截图唯一的体积旋钮** —— JPEG 质量固定用系统默认值（约 75），原因见 [`src/screenshot.js`](../src/screenshot.js) 文件头的 AMSI 实测 |
| `qqEnabled` | boolean | `false` | 是否启用 QQ 官方机器人通道 |
| `qqNotifyEnabled` | boolean | `true` | **QQ 远程提醒总开关**（输入框下方那个 `QQ 提醒` 开关控制的就是它）：关掉仍保持长连接与反向对话，只是不再主动推送 |
| `qqAppId` | string | `''` | QQ 开放平台 AppID |
| `qqClientSecret` | string | `''` | QQ 开放平台 ClientSecret |
| `qqStateFile` | string | `''` | 状态文件路径，留空用 `~/.dsh/qq-bot-state.json` |
| `qqCwd` | string | `''` | QQ 专属会话的工作目录，留空用进程 cwd |
| `qqRecentCount` | number | `6` | **QQ 菜单「会话」（`/sessions`）列几个最近会话**，上限 20。列出来的顺序是**按最近活动倒序**；在这儿回的数字对应的就是这一份名单 |
| `dshApiUrl` | string | `'http://127.0.0.1:19387'` | 本机 DSH 的 `/api` 地址 |
| `dshApiAuthority` | string | `'127.0.0.1:19387'` | DSH 看到的 Host，cookie 的 authority 必须一致 |
| `dshSecret` | string | `''` | 会话密钥，留空则自动读 `~/.dsh/.credentials.yaml` |
| `notesEnabled` | boolean | `true` | **完整回答存服务器**（仅当 `cloudEnabled` 也打开时才真的传）：推送里只留摘要 + 一个可点开的短链接 |
| `notesIdLength` | number | `5` | 短链接里随机字符的长度（36^len 种可能） |
| `notesMaxChars` | number | `20000` | 单篇完整回答的字符上限，超出会截断并在页面上写明 |
| `qqMarkdown` | boolean | `true` | QQ 推送用 markdown 消息（链接折叠成一句文字）；关掉退回纯文本 |
| `qqPromptMode` | string | `'queue'` | QQ 提问的投递方式：`queue` 排队（**在 DSH 里是正常的用户消息气泡**）/ `steer` 插话打断（渲染成「插话」节点） |
| `cloudEnabled` | boolean | **`false`** | **云上传总闸**。默认关：关着时 `note` / `note-link` 档也**不传正文**，退回「直接发到 QQ」。要往服务器传正文，必须显式打开 |
| `cloudUrl` | string | `''` | **云端网页端地址**（**只有想用短链接才需要配**）。QQ 里的链接会被改写成 `http://大写域名/…`，所以那个域名的 **80 端口也要能访问**。配了它 + `cloudToken` 就**优先走云端**（记录挂在你账号下、按账号算次数），否则走 `hubUrl`。作者维护了一个公开实例 `https://cyanovo.top`（免费版 100 次/天、记录留 5 小时），也可以自建 |
| `cloudToken` | secret | `''` | **云端账号令牌**（每账号一把，服务端只存 sha256）。**别手填** —— 让 DSH 调工具 `cloud_bind` 走设备码绑定自动写入 |
| `qqFulltextMode` | string | `'chat'` | **完整回答三档**：`chat` 正文切条直接发 QQ（不落服务器）/ `note` 存服务器但不给链接 / `note-link` 存服务器 + 短链接。非法值一律按 `chat`（**永不误上传**） |
| `qqFulltextMaxChars` | number | `6000` | 「完整回答」正文写进 QQ 分条前的字符上限（按**码点**截断，不会把中文/emoji 切成半个） |
| `qqUpdateEnabled` | boolean | `true` | **有新版本时在 QQ 里提醒一次**（同一个版本只提一次）。关掉只是不提醒，发 `/update` 照样能更新 |
| `qqUpdateSource` | string | 作者服务器上的版本索引 | 从哪儿取新版：① 一个 https 版本索引地址（JSON，里写版本号 + 压缩包地址 + sha256）；② `github:作者/仓库`（可带 `#分支`）；③ npm 包名。格式与自建通道见 [UPDATE.md](UPDATE.md) |
| `qqUpdateAutoRestart` | boolean | `true` | 更新完**自动重启 DSH**（DSH 没有插件热重载，不重启不生效）。关掉就只回一句「重启后生效」，由你自己挑时间 |
| `qqUpdateCheckHours` | number | `6` | 多久查一次新版本（小时），上限 168。启动时也会查一次 |

---

[← 回到 README](../README.md)
