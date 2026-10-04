# dsh-remote-qqbot

**DSH 的 QQ 远程机器人插件。** DSH 在电脑上干活，你在外面 ——
**跑完了 / 需要你拍板 / 出错了**，它主动发到你 QQ；你在 QQ 里**引用那条消息**回一句，
这句话就回到了它所属的会话里，跟你坐在电脑前打字一样。

> **联系方式（作者）**：QQ **1103416608** ｜ GitHub **[@cyanovo](https://github.com/cyanovo)**
> —— 装不上、报错看不懂、想要新功能，直接找我。

**仓库结构**（插件和它的云端服务在同一个仓库）：

| 路径 | 内容 |
|---|---|
| 根目录 | 插件本体 —— 这个仓库根目录就是 npm 包，`dsh.bundle` 指向 `cordis.patch.yml` |
| `server/dsh-web` | 云端：账号、额度、兑换码、记录、完整回答网页 |
| `server/dsh-notes-render` | 把 markdown 渲染成网页，并生成 QQ 能展开的预览卡 |
| `docs/ARCHITECTURE.md` | 设计与实现细节（含踩过的坑） |

云端是**可选**的：不部署它，插件照常工作 —— 正文直接切条发进 QQ，一个字节都不过服务器。

## 上手：两步

1. **装插件** —— 一条命令，见「[安装](#安装)」。
2. **填一对 QQ 机器人凭证** —— DSH 里「设置 → QQ 远程提醒与跨会话记忆 → QQ 远程提醒」，
   打开「QQ 机器人通道」，填 **AppID** 与 **ClientSecret**，然后**重启 DSH**。

> **不需要注册账号、不需要登录、不需要服务器、不需要公网 IP、不需要 frp。**
> 插件直接连腾讯官方机器人接口：收事件走 WebSocket **纯出站**长连接，
> 往会话里投递走本机 `127.0.0.1` 的 DSH 接口 —— 两头都不需要被外网访问。

## 要不要登录？只有一件事需要

| 你想要的功能 | 要准备什么 |
|---|---|
| 跑完 / 提问 / 出错推送到 QQ；QQ 里引用回复；`/status` `/sessions` `/screen` `/help` | **只要一对 QQ 凭证** |
| agentmd 自动操作日志、会话上下文注入 | 只要填一个本机目录 `agentmdDir` |
| 同一工作区多会话自动协作、QQ 闲聊 | **零配置**（默认就开着） |
| 跨会话记忆（`memory_read` / `memory_write`） | 一个中枢地址（可自建）—— 可选 |
| **在 QQ 里点开「完整回答」的短链接** | **一个云端账号 —— 唯一需要登录的功能**，可选 |

> 🔴 把最后一行说白：**只有「把完整回答存到服务器、换一条能点开的短链接」这一档需要登录。**
> 它的默认档**不需要**任何账号 —— 正文切成几条**直接发进 QQ**，**一个字节都不离开你的机器**。
> 而且「允许上传正文」这个总闸 `cloudEnabled` **默认是关的**：就算你把模式改成「存服务器」，
> 也传不出去（日志会写明是哪一道闸挡住的）。
> 真想要短链接，再看后面「完整回答去哪」那一节。

## 能做什么

| # | 能力 | 触发点 |
|---|---|---|
| 1 | 任务完成推送到手机 | `agent/status` running → idle |
| 2 | 需要你回答问题时推送 | 拦截 `tools/pre-execute` 的 `ask_user_question` |
| 3 | 执行出错时推送 | `agent/error` |
| 4 | 跨会话持久化记忆 | `memory_write` / `memory_read` / `memory_forget` |
| 5 | **agentmd 操作日志自动追加** | 会话转 idle 时写入 `main.md` 第四节表格 |
| 6 | **会话上下文注入** | `agent/created` 时把 `main.md` 全文注入 system prompt |
| 7 | **QQ 主动私聊通知** | 任务完成 / 提问 / 出错时经官方机器人主动发给你 |
| 8 | **QQ 引用回复 → 回到对应会话** | **引用**机器人发的某条消息再回复，就回到那条消息所属的会话 |
| 9 | **DSH 设置里的独立一项** | 「设置 → QQ 远程提醒与跨会话记忆」：图形界面改全部配置（含 QQ 凭证） |
| 10 | **输入框下方的两个低调小开关** | `QQ 提醒` 与 `协作模式` 各自一键开关，不影响连接、不用重启 |
| 11 | **协作模式：同工作区多会话自动协作** | 自动登记「谁在写哪个文件」，撞车当场提醒，会话之间可留言（可在输入框下方或设置里关掉） |
| 12 | **完整回答三档可选**（默认**不落服务器**） | `chat`=正文切成几条直接发到 QQ（默认）/ `note`=存服务器但不给链接 / `note-link`=存服务器并给短链接。见「完整回答去哪」 |
| 13 | **闲聊：只看不动 + 回答直接回聊天框** | 不引用直接发消息时，会话被切成**只读**（能查不能改），回答**正文直接发回 QQ**、不占服务器 |
| 14 | **QQ 菜单里的「屏幕」→ 手机收到电脑截图** | 点菜单「屏幕」（把 `/screen` 填进输入框）或直接发 `/screen`：抓**所有显示器合成的整块桌面**，压缩成 JPEG 发给你 |
| 15 | **QQ 菜单里的「会话」→ 挑一个最近的会话说话** | 点菜单「会话」（`/sessions`）→ 列出最近在聊的 6 个会话 → **回个数字**就切过去；之后不引用消息直接说的话都进它，直到你再切 |

> **一句话记住入站规则**：**引用**机器人的消息 = 对那条消息所属的会话说话；
> **不引用**直接发 = **用 `/sessions` 指定过就进那个会话**（有提问在等时优先当作答），
> 什么都没指定时才是闲聊（进独立的「闲聊会话」，**不进**任何工作会话）。

> **不打扰你的两类"完成"**：子智能体（subagent）跑完不推送 —— 它是你派出去的内部活儿；
> 闲聊会话跑完也不推送 —— 你人就在 QQ 里等着回复。两者都可用配置打开。

> **闲聊会话是"只读"的**（默认开）：机器人可以查状态、读文件、跑查看类命令，
> 但**任何写入 / 修改 / 删除都会被拒绝**，回答只做分析和建议。
> ⚠️ 只读保护的是**本机文件系统**；它拦不住 `shell` 里去改**远程主机**（例如 `ssh` 到服务器上删文件）——
> 那属于远程侧权限，需要服务端自己收紧。
>
> **闲聊的回答直接发在 QQ 聊天框里**（默认开）：不发推送卡片、**也不上传**「完整回答」笔记，
> 所以不会在服务器上留下任何文件；代价是超长回答会被截断（默认 1500 字）。

> 🔴 **隐私默认值**：**云上传总闸 `cloudEnabled` 默认关闭**。
> 关着的时候，即使模式选了「存服务器」，插件也**一个字节都不会往服务器传**，
> 而是退回「把正文直接切条发到 QQ」（日志会明说这件事）。
> 也就是说：**默认配置下，你的回答正文只存在于你自己的机器和你的 QQ 聊天记录里。**
> 想用短链接就得自己去设置里把这个总闸打开 —— 这是刻意的：
> 「把你的正文上传到别处的服务器」这件事必须由你明确同意。

---

## 安装

**方式一：从 npm 装（推荐）** —— 一条命令：

```powershell
dsh plugin --profile desktop add dsh-remote-qqbot
```

**方式二：从 GitHub 装** —— 仓库里带了构建好的 `lib/`，装完即可用，不需要本地构建：

```powershell
dsh plugin --profile desktop add github:cyanovo/dsh-remote-qqbot
```

**方式三：本机构建 tgz**（改过源码，或想离线装）：

```powershell
cd dsh-remote-qqbot
npm run pack                                          # 产出 dsh-remote-qqbot-<版本>.tgz
dsh plugin --profile desktop add ./dsh-remote-qqbot-<版本>.tgz
```

三个容易踩的地方（都踩过）：

| 坑 | 说明 |
|---|---|
| `--profile` 装错 | DSH 桌面版用 **`desktop`**；`dsh web` 起的用 `web`。装错 profile = 装了个看不见的 |
| tgz 路径**必须带 `./`** | 写 `dsh-remote-qqbot-<版本>.tgz` 会被 pnpm 当成 npm 上的包名 ⇒ `ERR_PNPM_FETCH_404` |
| 升级要**先 remove 再 add** | profile 里残留指向已删除 tgz 的依赖时，`add` 在解析阶段就会 ENOENT |

**装完必须重启 DSH 进程**才会加载 —— 桌面版是长驻进程，插件没有热加载。

### 装完第一件事：确认它活着

在 QQ 里给机器人发一句 `/status`，应该回：

```
📊 现在的状态
QQ 连着，有事我立刻能收到
引用回复能送进会话
没有在等你回答的问题
▶ 现在没有会话在跑，都闲着
```

回了就说明整条链路通了。**没反应的话按这个顺序查**（九成是前两条）：

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 发什么都没回 | 还没重启 DSH，或凭证填错 | 重启桌面版；检查 AppID / ClientSecret 有没有多余空格 |
| **通知收得到，但你引用它回复 → 回一句 `❌ 这句没送进 …：DSH 会话密钥不可用，无法注入`** | 桌面版把「会话签名记录」（`~/.dsh/.credentials.yaml` 里的 `client-connection/browser-session`，`/api` 的 cookie 用它签名）弄丢了。推送不需要它，所以通知照发 —— **故障只在入站，最难查** | 插件 1.0.1 起会**自己把这条记录补回来**（原文件先备份到 `~/.dsh/.credentials.yaml.bak-remote-qqbot-*`）。补完**重启一次 DSH 桌面版**即可恢复；`/status` 里会明确写着「引用回复送不进会话：…」以及已做过什么补救 |
| 日志说**还不知道你的 open_id** | 你还从没给机器人发过消息 | 用你的 QQ 给机器人发任意一句话 —— **open_id 只能从你发来的消息里被动学到**，官方不提供「按 QQ 号查 openid」的接口 |
| 推送收不到，报 `40054004 无好友关系` | 没加好友 | 用你的 QQ 把机器人**加为好友** |
| 推送收不到，报 `40054013 用户拒收消息` | QQ 客户端里关掉了主动消息 | 在 QQ 的机器人会话设置里打开「允许主动发送」 |
| 推送收不到，报 `40034105 主动消息无权限` | 平台权限没开 | 到 [q.qq.com](https://q.qq.com) 的机器人权限里打开**单聊主动消息** |

> **收得到 ≠ 回得进去。** 这个插件有两条**互相独立**的腿：出站推送只走 QQ 长连接，
> 入站注入（引用通知接着聊、`/task` 派活、`/sessions` 挑会话）要走本机
> `127.0.0.1:19387/api`，而那个接口的 cookie 由桌面版 `~/.dsh/.credentials.yaml`
> 里的会话签名记录签名。所以「QQ 连着、通知正常」并不代表引用回复能用 ——
> 2026-10-04 的事故就是这条记录消失导致引用回复全线失效，而通知一切正常。
> 想一眼确认两条腿都在：QQ 里发 `/status`。

想知道「中枢 / 云端 / agentmd / 界面里改过的配置」各自落在哪、值是什么，
看 **设置 → QQ 远程提醒与跨会话记忆 → 顶部「运行状态」**（只读）。

---

## 文档

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 本文件：**怎么装、怎么配、怎么用**，以及开发约定与硬约束 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **架构与内部实现**：模块职责、数据流、状态文件、配置项全表、QQ 指令路由、测试体系、发布流程、踩坑清单 |
| [LICENSE](LICENSE) | MIT |

> 只想「装上、用起来」→ 本文件就够；
> 想「改代码 / 排查问题」→ 先看 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，再看对应模块的头部注释。

## 配置

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

### 在 DSH 界面里改（不用手写 YAML）

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

### 配置写在哪、谁盖谁（0.8.4 新增）

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


### 全部配置项

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
| `qqScreenMaxWidth` | number | `1600` | 截图最大宽度（像素），超宽等比缩放；`0` = 不缩放。**这是截图唯一的体积旋钮** —— JPEG 质量固定用系统默认值（约 75），原因见 [`src/screenshot.js`](src/screenshot.js) 文件头的 AMSI 实测 |
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

---

## 协作模式（同一工作区下的多会话自动协作）

**要解决的问题**：你同时开几个会话推进同一个项目时，它们彼此看不见 ——
两个会话同时改 `src/index.js`，谁都不知道，最后可能产出"看起来装好了、其实是半成品"的版本。
（本项目自己就栽过一次，所以这个功能是**被自己的事故逼出来的**。）

**为什么插件能做这件事**：DSH 桌面版是**一个进程**托管所有会话，而插件就跑在这个进程里 ——
所以同工作区的会话彼此**天然可见**，不需要轮询文件、不需要外部服务。
文件只是跨重启的兜底与人类可读的面板。

**它自动做四件事：**

| 能力 | 说明 |
|---|---|
| **会话注册表** | 谁在跑、在哪个工作区、什么状态、最后活动时间 |
| **文件占用表** | 谁在写哪个文件；**撞车时当场告诉后来者**（`warn`）或直接拒绝（`block`） |
| **留言板** | 会话之间互相传话（`collab_post`），对方下一个模型步骤就能看到 |
| **自动面板** | 把上面三样写进 `plugin-collab.md` 的自动区块（人也能直接看） |

**三个刻意的设计（都有代价，都是踩出来的）：**

1. **单人单会话时完全静默**：没有任何别的东西可说，就**不往上下文里塞一个字** ——
   所以默认开着，代价为零。（回归测试专门锁死了这一点。）
2. **面板只写标记之间的区块**：`<!-- collab:auto:begin -->` … `<!-- collab:auto:end -->`，
   **标记之外你自己写的文字一字不碰** —— 纯手工维护的协作板就是这样被平滑接管的。
   标记还必须**独占一整行**才算数：这样你在板上讨论格式、把标记当字面量写出来，也不会被误当成区块
   （否则下一次自动维护会把面板插进你那条留言中间，把留言劈成两半）。
3. **转空闲即释放占用**：会话跑完睡下，它占的文件立刻放掉 ——
   否则一个会话崩了就会留下**死锁**，那比冲突更糟。
4. **可以一键关掉**：会话输入框下方那个 `协作已开 / 协作已关` 小开关，
   或「设置 → 协作模式 → 总开关」。关掉后不再互通占用与留言，**立刻生效、无需重启**
   （四个 `collab_*` 工具仍注册着，但会回一句「协作模式已关闭」而不是报错）。

**给模型的四个工具：**

| 工具 | 用途 |
|---|---|
| `collab_status` | 看同工作区其他会话 + 文件占用 + 留言 |
| `collab_post` | 给其他会话留言 |
| `collab_claim` / `collab_release` | 手动认领 / 释放文件占用 |

> 写文件**不需要**模型主动认领：插件从 `tools/pre-execute` 里就已经自动登记了。
> 它只认 `file_path` / `path` 这类**显式路径参数**，**不解析 shell 命令** ——
> 解析命令必然误报，而误报会让人干脆关掉整个功能，比漏报更糟。

**已知限制（写在代码注释里）**：工具的 `execute()` 里拿不到"是谁在调用"，插件用**参数指纹**回溯；
指纹失配时退回到"最近一次带 agent 的调用"，多个会话同一瞬间调用协作工具时可能串号 ——
只影响留言署名，不会写坏协作状态。

**不想要它**：`collabEnabled: false`。只想别被拦：`collabClaimGuard: off`。

---

## 可选：完整回答去哪（三档，默认零上传）

> **全文里唯一涉及「登录」的地方就是这一节，而且只有第 3 档需要。**
> 默认档 `chat` 不需要任何账号，也不连任何服务器。

**要解决的问题**：通知里那句摘要是给人**扫一眼**的，遇到长回答必然被截掉 ——
"到底改了哪几个文件、结论是什么"这类细节只有原文里才有。
但"正文放哪儿"这件事，不同的人答案不一样：有人根本不想让任何东西离开自己的机器，
有人愿意换一个能点开的链接。所以这是一道**你自己选的题**：

| 模式 | 正文去哪 | 服务器上有东西吗 | 推送里有什么 |
|---|---|---|---|
| `chat`（**默认**） | 切成几条**直接发到 QQ 聊天框** | **没有**（一个字节都不传） | 摘要一条，正文随后分条发出 |
| `note` | 存到服务器（`/var/www/dsh-notes/`） | 有，按保留期自动删 | 只有摘要，**不给链接** |
| `note-link` | 同上，并给一个可点开的短链接 | 有 | 摘要 + `[查看完整回答](…)` |

**怎么切换**：**都在设置里** —— 设置 →「QQ 远程提醒与跨会话记忆」→ 分组「QQ 远程提醒」：
模式是 `qqFulltextMode`（「完整回答怎么给」），总闸是 `cloudEnabled`（「允许上传正文」）。

> ⚠️ **这两个开关不在输入框下面，这是刻意的：**
> 输入框下方**只留**「QQ 提醒」「协作」——那是抬手就要按的（开了没开必须一眼看到）；
> 全文去向属于"配置"，一年也改不了几次，摆在输入框旁边只是噪音。
> **功能一个都没少**，只是搬回了设置面板（同一张 `FIELD_SPECS` 字段表、同一套白名单校验）。
> `scripts/verify-ui-installed.mjs` 有两条断言分别守着「输入框下面恰好 2 个开关」
> 和「设置里必须有 `qqFulltextMode` / `cloudEnabled` 这两个字段」。

**三道闸，缺一不可**（这是刻意的设计，不是绕）：
1. 模式必须是 `note` / `note-link`；
2. `cloudEnabled` 总闸必须**显式打开**（默认关）；
3. `notesEnabled` 得是开的，且**至少有一个地方能存**：云端（`cloudUrl` + `cloudToken`）或中枢（`hubUrl`）。

任一条不满足 ⇒ **按「直接发到 QQ」处理，不传正文**，并在日志里写明是哪一条挡住了
（`完整回答模式是「…」，但云上传总闸关着（cloudEnabled=false），这次按「直接发到 QQ」处理`）。
所以「默认关闭上传」不是一句承诺，而是**可以被观察到的行为**：
`chat` 档 + 总闸关闭时，插件对本机以外的服务器发送的字节数是 0（探针实测）。

**分条的长度**：`QQ_TEXT_SAFE_CHARS = 900`（`src/fulltext.js`），按段落 → 行 → 硬切三级切分，
**保证一个字符都不丢**，并给每段加 `（1/7）` 这样的序号（序号算在 900 之内，不会让某条溢出）。
超长回答先被 `qqFulltextMaxChars`（默认 6000 字）截断，再分条。

> **900 这个数字是实测过的**：官方文档只写了错误码「消息长度超限 / 消息过长或异常」，
> **没给字数**。2026-10-03 用真实 QQ 接口实测：**纯文本 900 / 1500 / 3000 字服务端全部接受**
> （三条真发出去、拿到消息 id）。也就是说 900 的安全边际很足 —— 方向选择上**宁可多发两条，
> 也不冒"整条发不出去、正文白丢"的风险**。想少刷屏可以把这个常量调大，
> 但那属于"平台哪天改规则就失效"的自负，故留保守值。

---

### 可选·第 3 档需要登录：云端账号（设备码绑定）与「记录挂在自己账号下」

上面那张表里的「服务器」有两个不同的地方，**别混**：

| | 中枢（`hubUrl`） | 云端网页端（`cloudUrl`，0.8.8 起） |
|---|---|---|
| 记录归谁 | 谁都不知道，**公开可读**的 `.md` | **你自己的账号**，登录才能看 |
| 鉴权 | 一把共享令牌 | **每账号一把**令牌（设备码绑定换来的） |
| 配额 | 无 | 免费版 100 次/天、记录留 5 小时；付费版 1000 次/天、留 48 小时 |
| 链接 | `…/dsh/<id>.md`（不带登录） | `…/n/<id>`（要登录，且**每打开一次算 1 次**） |

**配了云端就走云端**（`cloudUrl` + `cloudToken` 都有值时），否则走中枢。
⚠️ 云端失败时**不会**偷偷改发中枢 —— 那等于把内容转发去另一个可见性不同的地方；
失败就只记日志、推送退回"只有摘要"。

**怎么绑定（不用手抄令牌）**：让 DSH 调一次工具 `cloud_bind`：

1. 它调用 `/api/device/start` 拿到一串 **8 位短码**（如 `ABCD-EFGH`），念给你；
2. 你打开 `cloudUrl`、登录，在「账号」页填入这串码确认；
3. 再调一次 `cloud_bind`，它换回令牌并**自动保存**到配置里。

短码单独泄露**换不出任何权限**：服务端规定"必须已登录才能确认"，且令牌**只交付一次**；
令牌在服务端只存 `sha256`，明文从不落盘。

另外两个工具：`cloud_status`（看绑到哪个账号、什么档位、今天还剩几次）、
`cloud_unbind`（删掉本机令牌；⚠️ 服务端那把仍需到网页端「我的令牌」里吊销）。

**安全边界（写清楚，别指望别人猜）**：这把发布令牌能**发布**、能读**配额与档位**，
但**读不到任何记录正文** —— `/api/records*` 只认登录 cookie。

> **云端地址填什么**（自建或换实例时看这里）：
>
> - **填 `https`**（如 `https://cyanovo.top`）—— API 走 TLS，令牌不过明文网络；
> - QQ 里的链接**仍然**会被改写成 `http://大写域名/n/<id>`（唯一实测能点开的形式），
>   所以要求「**这个域名的 80 端口也在服务**」。作者那个实例的 80/443 现在同时开着，
>   两种写法都能用。
> - **别填带端口的**（如 `http://x:8444`）：端口会被 QQ 的链接改写丢掉，链接必然打不开。
>
> 插件判断不了你服务器的 80 通不通，所以会在**设置 → 运行状态**里留一条提示让人确认。

---

### 可选·第 3 档细说：存服务器 + 短链接（`note-link`）

会话转空闲时，插件把本轮的**用户提问原文 + 助手回答原文**（未删节）
POST 到中枢，中枢把它落成 `/var/www/dsh-notes/<id>.md`，推送文案里追加一行链接：

```
✅ main 跑完了

把协作模式写进插件了

[查看完整回答](https://notes.example.com/dsh/k3f9a.md)
```

- QQ 走 **markdown 消息**（`msg_type=2`）时，上面那行渲染成一句**可点的文字**，
  而不是把长 URL 铺满屏幕（`qqMarkdown: true`，默认开）。
- 万一 markdown 不被接受（权限、长度、内容被拒），插件会**自动退回纯文本重发** ——
  链接完整显示出来，通知不会丢。

**为什么链接是静态返回、不经过中枢**：nginx 用**正则 location** 把 `/dsh/<id>.md`
映射到静态目录，所以**中枢挂了，已经发出去的链接照样打得开**。正则同时限定了 id 的形状，
`../` 之类根本匹配不上，从匹配层面杜绝目录穿越（而不是靠事后过滤）。

**id 只有 5 位**（`notesIdLength`，36^5 ≈ 6047 万种）。**这是一条要你自己权衡的取舍**：
链接**不需要登录**就能打开，短 id 好记、也就更好猜。所以：

- 别把带密钥、带隐私的会话拿来做测试；
- 想更安全就把 `notesIdLength` 调大（比如 12）：链接长一点，猜中概率低得多；
- 彻底不想公开就 `notesEnabled: false`，退回"只有摘要"的老行为。

**页面长什么样**：`<id>.md` 以 `text/markdown; charset=utf-8` 返回，浏览器直接显示原文
（标题 + 工作区 + 时间 +「我这一轮说了什么」+「完整回答」）。
超过 `notesMaxChars` 会**明确写出被截断了多少**，不会让人误以为那就是全部。

**失败怎么办**：上传超时（默认 6 秒）、中枢 500、DNS 挂了 —— 全部只记一条日志，
**推送照发**，只是这次没链接。宁可少一个链接，也不能因为服务器抽风就丢掉「跑完了」这条通知。

---

## QQ 官方机器人

**为什么用官方平台**：NapCat / Lagrange 那类需要**真实 QQ 账号登录**（扫码/小号），
违反协议、有封号风险。官方机器人是平台分配的独立身份，只要 AppID + ClientSecret，
你用 QQ 把它加为好友即可。

**为什么不需要 frp / 公网 IP / 回调地址**：收事件走 **WebSocket 长连接**（纯出站），
注入会话走 **本机 `127.0.0.1:19387/api`**。两端都不需要被外部访问。

```
┌──────────── 你的电脑（全部跑在这）────────────┐
│  DSH 进程                                     │
│   └ dsh-remote-qqbot 插件                    │
│       ├─ QQ 机器人（WebSocket 出站长连接）      │
│       ├─ 任务完成/提问/出错 → 主动私聊你        │
│       └─ 你的回复 → session/prompt 注入         │
└───────────────────────────────────────────────┘
        ↕ 纯出站（无公网、无 frp、无服务器）
     QQ 服务器 ↕ 你手机上的 QQ
```

### 能力边界（官方文档 2026-09 版）

| 类型 | 条件 | 限额 |
|---|---|---|
| **主动消息**（不要 `msg_id`） | **无任何条件** | 个人认证 20 条/分钟·每关系，**1000 条/用户/天** |
| 被动回复（带 `msg_id`） | 收到消息后 | 单聊 **60 分钟**内，每条最多回 **4 次** |

三个容易踩的前提（都有明确错误码）：

- `40054004 无好友关系` → 先用你的 QQ 把机器人**加为好友**
- `40054013 用户拒收消息` → QQ 客户端里被关掉了「允许主动发送」
- `40034105 主动消息无权限` → 开放平台里机器人权限没开单聊主动消息

### 配置步骤

1. 到 [q.qq.com](https://q.qq.com) 建机器人，拿 **AppID + ClientSecret**
2. 用你的 QQ **把机器人加为好友**，然后给它随便发一句（这一步不是可选的：
   官方不提供"按 QQ 号查 openid"的接口，**open_id 只能从你发来的消息里被动学到**）
3. 写配置：

```yaml
dsh-remote-qqbot:
  qqEnabled: true
  qqAppId: '你的 AppID'
  qqClientSecret: '你的 ClientSecret'
  qqCwd: 'D:\cyanproject\agenttool'   # 专属会话的工作目录
```

4. 重启 DSH。启动日志**只会出现两行状态**（其余都挪进了设置面板，见下）：
   ```
   [remote-qqbot] QQ 提醒：已开（AppID 102xxxx…，专属会话 cwd=D:\cyanproject\agenttool）
   [remote-qqbot] 协作：已开（范围 workspace，写冲突 warn）
   [QQ] 已启动（AppID 102xxx…）
   [QQ] QQ 机器人已就绪：xxx机器人（session=…）
   ```
   ⚠️ **出故障仍然会打日志**（`⚠️ 读不到 ~/.dsh/settings.yaml`、`qqAppId 没配齐`、
   提问中继没接上…）—— 那些不是"日常状态"，藏着只会让人白排查一轮。

   想知道"中枢 / 云端 / agentmd / 界面改过的配置"落在哪、值是什么，
   去 **设置 → QQ 远程提醒与跨会话记忆 → 顶部「运行状态」**（只读）。
   插件还在 `lib/index.js` 导出了 `lastStatusLines()`，返回的就是这份快照，方便脚本排查。

   若出现 `还不知道你的 open_id`，说明第 2 步还没做。

### 用起来是什么样

**出站**（机器人 → 你）：

- **任务完成 / 出错 / 需要提问** → 机器人主动私聊你；
- 完成通知里带你那句"这轮做了什么"的摘要 + 会话名；提问通知里带选项，引用它回个数字就行。

**入站**（你 → 机器人）：**看有没有引用消息**，这是唯一的分流依据。

| 你的操作 | 结果 |
|---|---|
| **引用**机器人发的「任务完成」通知再回复 | 回到**那条通知所属的会话**继续说话 —— **默认排队**（`queue`），也就是它在你 DSH 会话里就是一条**正常的用户消息**，跟你自己打字完全一样 |
| **引用**机器人发的「提问」通知再回复 | 当作**那个提问的答案**（多个提问并存时也精确对应，不会答错） |
| **不引用**，直接发一句话 | 进**独立的「闲聊会话」**——只是和机器人聊天，**不会**污染任何工作会话 |
| **引用**一条认不出来的消息 | 若**最近 5 分钟**内刚推过通知，就按那一条兜底（宁可送回最近的会话，也不让你的提问凭空消失）；否则明确告诉你认不出来 |
| 有提问在等时**不引用**直接回 | 仍按"回答"处理（否则 agent 会永远卡在那条提问上） |
| 引用一条**已经结束**的提问再回 | 明确提示提问已结束，**不会**把「1」当成消息注入工作会话 |

> **「不引用」那条路是"只读 + 直接回话"的**（`qqChatReadOnly` / `qqChatReply`，默认都开）：
> 投递前插件会把闲聊会话切到 `read-only` 权限 —— 它能读文件、能跑查看类命令，
> 但**任何写入 / 修改 / 删除都会被 DSH 拒绝**；跑完之后，回答**正文直接发在 QQ 聊天框里**
> （纯文本，不折叠成卡片，也**不**上传「完整回答」笔记）。所以闲聊不会在服务器上留下任何文件。
> 超长回答按 `qqChatAnswerChars`（默认 1500 字）截断。
> ⚠️ 已知边界：`read-only` 保护的是**本机文件系统**，管不住 `shell` 里去动**远程主机**
> （例如 `ssh 服务器 rm ...`）—— 那要用远程那侧的权限来兜。

> **为什么默认是「排队」而不是「插话」**（依据 DSH 源码，不是口味问题）：
> `client/runtime/src/client/sessions/session.ts` 写明 *"queue appends after the current
> turn; steer **interrupts** it"*，而 `client/ui-conversation/src/client/conversation-nodes/
> message.ts` 把两者落成**不同的节点类型** ——
> `queue` → `user`（正常用户消息气泡）、`steer` → `steering`（「插话」节点，样式完全不同）。
> 之前会话一在跑就用 steer，结果**从 QQ 发来的提问在 DSH 里根本不像自己打的字**。
> 想恢复即时打断：`qqPromptMode: steer`。

> 机器人处理你的提问后，只回一句 `✅ 收到，我这就开始（<会话名>）`，
> **不再复述你发的那句话** —— QQ 聊天记录里上一条就是你自己的原话，再抄一遍只是噪音。
> 会话名仍然保留：同时开多个会话时，它告诉你这句话进了哪一个。

**指令**（发在聊天框里、以 `/` 开头的话）：

| 指令 | 作用 |
|---|---|
| `/task <内容>` | 强制当新任务送进专属会话（压过上面所有判断） |
| `/sessions`（也认 `/会话`、`/list`） | **列出最近在聊的几个会话**（默认 6 个，见 `qqRecentCount`），回个数字就切过去 |
| `/use <N>`（也认 `/切 <N>`） | 直接切到第 N 个；`/use 0` = 取消指定。`/sessions 3` 与 `/use 3` 等价 |
| `/screen`（也认 `/screenshot`、`/shot`、`/截图`、`/屏幕`） | **抓一张电脑屏幕发给你** —— 见下节 |
| `/status` | 看状态：列出**正在跑哪些会话**（标题 · 项目 · 第几轮，按最近活动排序）以及另外还有多少闲着 |
| `/help` | 打印指令清单 |

### 菜单里的「屏幕」：手机收到一张电脑截图

**怎么用**：QQ 聊天窗口底部（机器人菜单）→ 点「屏幕」→ 输入框里出现 `/screen` → **按发送**。

> ⚠️ **要说清楚：这是两次点击，不是一次。** 官方自定义菜单的 `send_message` 类型只是把文本
> **填进输入框**，平台不代你发送（`switch` 类型才会自动发消息，但它只能表达"开关"，
> 表达不了"截一张图"，所以没有采用）。所以"点一下菜单就有图"这个动作，实际是
> **点菜单 → 按发送**；输入框里已经是 `/screen` 了，不用再打字。
> 想省掉那一下也行：直接把 `/screen` 当普通消息发出来，效果完全一样。

**发过来的是什么**：

- **整块物理桌面**（`SystemInformation.VirtualScreen`）—— 双屏/多屏合成一张，不用自己拼；
- 宽度超过 `qqScreenMaxWidth`（默认 1600）就等比缩小；
  **JPEG 质量固定用系统默认值**。本机实测：原始 **2880x1800** → 缩到 **1600x1000**，
  约 **211–212 KB**（实测 **217,204 字节 / 523 ms**）；
  `scripts/verify-installed.mjs` 每次装完都会真抓一张，被拦就报红；
- 脚本与图片都在临时目录里，**成功失败都会删**（`finally`），不在你机器上留图。

> ★ **抓之前必须先认领 DPI 感知（否则只会截到左上角）**
> `Graphics.CopyFromScreen` 按**物理像素**搬，但一个 DPI  unaware 的进程看到的
> `VirtualScreen` 是**被缩放过的逻辑尺寸**。本机 2880x1800、200% 缩放 ⇒ 不认领时
> VirtualScreen 报 **1440x900** ⇒ 存下来的图正好是**真实桌面的左上四分之一**。
> 所以脚本里 `SetProcessDPIAware()` 必须在读 `VirtualScreen` **之前**调用 ——
> **顺序就是修复的全部**，`tests/screen.test.mjs` 用 `indexOf` 比较两条语句的先后把它钉住了。
> 像素级取证：认领前 1440x900、认领后 2880x1800，对同一块区域网格采样 12960 点，
> 两图**平均差值 0.00**（仅 1 点超过容差 24）⇒ 小图确实就是大图的左上角，不是另一张画面。
> 抓完脚本会额外打印一行 `RAW 2880x1800`（缩放前的原始尺寸），
> `parseRawOutput()` 把它透出成 `rawWidth/rawHeight`，验收脚本再拿它去比对
> `Win32_VideoController` 里**任意一块**真实显示器的分辨率（本机有两块虚拟/物理适配器，
> 所以判的是"命中任意一块"，不能只看第一条 —— 量具本身也会骗人）。

**引用这张截图再说话** → 机器人会明确告诉你"这条截图不属于任何会话"，
不会把它错当成某次通知、把话投进不相干的会话。

**隐私总闸**：截图会把**你屏幕上的一切**发出去（聊天记录、密码、别的窗口都可能在里面），
所以有 `qqScreenEnabled`（默认开）。关掉后 `/screen` 只回一句"被我关掉了"，并告诉你去哪儿打开。

**⚠️ 已知坑（2026-10-02 实测，改抓屏脚本前务必先读）**：Windows Defender 的 AMSI 会拦截
**"抓屏 + 枚举/构造 JPEG 编码器参数"**这种组合（判定为屏幕窃取类脚本的经典指纹），
把**整份脚本**毙掉，而且报错位置故意指向第 1 行注释
（`ParserError … ScriptContainedMaliciousContent`），极具误导性 —— 改注释改一万遍也没用。
所以现在的实现**不碰 `GetImageEncoders()` / `EncoderParameters`**，改用
`$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)`。
代价是**质量不可调**，于是原来的 `qqScreenQuality` 配置项被**删掉**了 ——
留一个点了没用的开关比没有这个开关更糟。
万一将来又被拦：QQ 里收到的是**中文提示**（不是英文报错），照提示在
「Windows 安全中心 → 病毒和威胁防护 → 排除项」放行，或临时关掉实时保护。
完整二分表格见 [`src/screenshot.js`](src/screenshot.js) 文件头。

**其他平台**：macOS 走 `screencapture`（写了，但**没在 mac 上跑过**，属于"顺手写上"）；
Linux **故意不支持**，会明确报错而不是假装成功。

### 菜单里的「会话」：点一下，挑一个会话说话

**怎么用**：QQ 聊天窗口底部（机器人菜单）→ 点「会话」→ 输入框里出现 `/sessions` → **按发送**
（和「屏幕」一样是**两次点击**：菜单只把文本填进输入框，平台不代发）。
机器人列出**最近在聊的几个会话**，逐字长这样：

```
🗂 最近在聊的 6 个会话（回个数字切过去）
1. 主会话 · agenttool · 正在跑 · 刚刚
2. 插件优化 · agenttool · 闲着 · 12 分钟前
3. 手机端 · mobile · 闲着 · 2 天前

回 0 = 不指定（直接说话就进闲聊会话）
引用我某条通知说话，还是优先回到那条通知的会话
```

你**回一个数字**（比如 `2`），机器人答一句
`✅ 以后你说的话都进「插件优化」了。想换回来再发 /sessions。`
—— 从此**不引用消息直接发的每一句话都进它**，直到你换（或回 `0` 取消指定）。

**为什么设计成"选一次、记住"而不是"每条消息都问一遍"**：
你要的是「能挑最近的会话聊天」，而挑会话这件事**天生是有状态的** ——
记住一个指针，之后每句话都省掉一次选择；换会话时才需要再说一句。

设计上必须处理好的五件事（都写进了 `tests/session-picker.test.mjs`）：

1. **数字不能抢走"答案"**。agent 卡在提问上等你回一个 `1` 时，那个 `1` 是在**回答它**，
   不是在说"切到第 1 个会话"。所以优先级是 **引用 > 有提问在等 > 选会话 > 闲聊**；
   而且裸数字只在**名单刚发出去的 5 分钟内**才算"选择"，之后又变回普通文本。
2. **名单每次现拉**，从不缓存。菜单里的文字是**静态**的（平台那边有客户端缓存、刷新有延迟），
   所以菜单只放一个固定入口 `/sessions`，会话名单永远现算 —— 不会让你"点了 2 却切到别的会话"。
3. **当前会话看得见**。成功切换有回执；`/status` 里也多一行
   `🎯 你说的话现在进：插件优化（闲着）（想换就发 /sessions）`。
4. **指定的会话不在了，绝不静默换一个**。会明确回
   `⚠️ 第 2 个（插件优化）已经不在了 —— 发 /sessions 重新看一次吧。`
   万一它是在你说完话、投递前才没的，那句话会进闲聊会话，并**额外补一句说明**
   （悄悄投进另一个会话，是这个功能最坏的失败方式）。
5. **排序按最近活动倒序**，正在跑的打「正在跑」标记 —— 同时开几个会话时，
   一眼能看出机器在忙哪个。

**指定的会话有完整权限**（不是闲聊那种只读）：它就是你的工作会话，和你在 DSH 里直接打开它说话完全一样。

> **三个会话是不同的东西**：**专属会话**（`/task` 用，固定一个）、**闲聊会话**（不引用时用，固定一个）、
> 以及**各个真实工作会话**（引用对应通知时用）。互相不干扰，id 都记在 `~/.dsh/qq-bot-state.json`。
>
> **引用是怎么实现的**：机器人每发一条消息，插件都把响应里的 `ext_info.ref_idx` 与"这属于哪个会话"
> 一起记进状态文件（`sentRefs`，最多留 300 条）。你引用时 QQ 事件会带上 `ref_msg_idx`，
> 插件据此反查回原会话 —— 全程纯出站，不需要公网、不需要回调地址、不需要 frp。
> （已实测：主动消息响应确实返回 `ext_info.ref_idx`。）

### 两个实现约束（都有代价，已写在代码注释里）

1. **提问是"包装"而不是"注册 provider"**：`userQuestions` 的 provider 全局唯一
   （重复注册抛 `DUPLICATE_PROVIDER`），桌面 UI 已经占住了。所以插件包装 `ask()`。
2. **QQ 优先，桌面只是"兜底"**（0.7.7 起，之前是 `Promise.race`）：顺序是
   先往 QQ 发；**发失败**（通道没连、没 openId、异常）立刻改在 DSH 界面里提问；
   **发成功**就等 QQ 的回答，只有当 QQ 那边 `qqAskFallbackSec`（默认 90 秒）**一直没回**，
   才补一张 DSH 界面的提问卡片。
   为什么要这样：DSH 桌面的提问卡片只能由 DSH 自己收起（api-proxy 的 `claimQuestion()`），
   插件侧答完 `ask()` 也**清不掉那张卡** —— 旧版 `Promise.race` 一开头就在桌面挂了一条
   pending 记录，于是"在 QQ 里答完了，DSH 那张卡还一直挂着"。现在正常路径**根本不创建**
   桌面卡片，自然没有东西会变陈旧。
   兜底卡片真出现、你又回到 QQ 里回答时：答案照样算数，回执会多一行提示
   「（另外，DSH 窗口里那张提问卡片已经作废了 —— 点它一下选个选项，或者按取消就能收掉）」。
3. **QQ 那条路永不 reject**：失败时返回一个永不兑现的 Promise，让提问自然落到桌面那条。
   否则 QQ 一断就会把桌面 UI 的提问一起弄崩。

---

## agentmd 自动日志

会话从 `running` 转 `idle` 时，插件会：

1. 从**该会话的事件流**里取本轮的用户消息与最终回复
   （只取 `source.kind === 'user'` 的真人输入，跳过 `agent.inject()` 注入的内容）；
2. 拼成 `用户消息 → 最终回复`，按 `agentmdSummaryChars` 截断；
3. 追加到 `<agentmdDir>/<agentmdMainFile>` 中「## 四、操作日志」表格的**最后一条数据行之后**；
4. 同步刷新文件头部「最后更新：」那一行的日期。

生成的行形如：

```
| 2026-09-30 02:04 | 真实链路验证 → 链路验证完成 | 完成 |
```

**容错**：`agentmdDir` 未配置 / 目录不存在 / 文件不存在 / 找不到日志表头 —— 一律只写
`[remote-qqbot]` 日志后跳过，绝不抛错、绝不影响 agent 主流程。

**并发安全**：同一进程内对同一文件的读改写走模块级 promise 队列串行化，
多个 agent 同时转 idle 也不会破坏表格。

## 会话上下文注入

`agentmdInject: true` 时，每个新会话在 `agent/created` 时注册一条
`systemPrompt.context`（名称 `remote-qqbot:agentmd`，`order: 150`）：

- 注册在 **`agent.ctx`** 作用域上，只影响该 agent，插件卸载时自动回收；
- `text` 是**函数**，每次组装 system prompt 都重新读盘 —— 外部编辑 `main.md`
  后，下一个模型步骤即生效，无需重启；
- 文件不存在时返回空串，该条上下文自动消失；
- `systemPrompt` 服务不可用（如 headless 装配）时只记日志并降级到 `agentmd_read` 工具。

### 🔴 注入是**有界**的（防爆上下文，1.0.2 起）

`text` 是每步重读盘的函数，所以「文件多大 = 每步 prompt 多大」。文档一旦被写到几十万字符，
上游会直接回 `413`，而且**每多贴一段就更糟**。所以注入前先过 `buildContextDoc()` 压缩：

- **硬上限** `agentmdInjectMaxChars`（默认 `8000`）：返回值**永不超过**这个字符数（有单测钉死）；
- 先保**最近的日志行**（`agentmdInjectTailRows`，默认 20 行）+ §四 小节，再拿剩余预算保开头正文；
- 压缩**绝不静默**：正文里明写 `…（此处省略约 N 个字符。需要完整内容请用 agentmd_read 工具读全文）…`
  —— 否则模型会把「没看到」当成「不存在」；
- 三个键都做了兜底：给 `0` / 负数 / `NaN` 一律回落出厂默认，**不会**被解释成「不限」。

追加方向也封了顶：单条日志行超过 `agentmdRowMaxChars`（默认 `600`）时只裁「操作」列，
时间列与三列结构保持完整 —— 免得一条超长日志把表格撑变形、越积越大。

> 实测（`tests/plugin.test.mjs`）：244,582 字符的文档经真实 provider 注入 **7,994 字符**；
> 把上限改成 1500 后注入 722 字符 —— 上限真的在起作用，不是写了不读。

## 工具

| 工具 | 作用 |
|---|---|
| `agentmd_read` | 读取 agentmd 主文档（或指定文件），支持 `maxChars` 截断 |
| `memory_write` | 记住一条持久化信息 |
| `memory_read` | 读取已记住的信息 |
| `memory_forget` | 删除一条记忆 |
| `collab_status` | **协作模式**：看同工作区其他会话 + 文件占用 + 留言 |
| `collab_post` | **协作模式**：给其他会话留言 |
| `collab_claim` | **协作模式**：手动认领文件占用（写文件时插件已自动认领） |
| `collab_release` | **协作模式**：释放文件占用（会话转空闲时也会自动释放） |

---

## 开发

```powershell
# 一次性准备（只需执行一次）
node scripts/link-dev.mjs       # 建 node_modules junction（本地测试必需）

# ── npm test 跑的就是下面这 16 条，顺序与 package.json 一致 ────────────
node tests/agentmd.test.mjs     # agentmd 追加逻辑单测（16 项）
node tests/settings.test.mjs    # settings 注册/覆盖语义单测（9 项）
node tests/config-view.test.mjs # 设置面板读数来源：describe 为空时必须靠 host 兜底（18 项）
node tests/fulltext.test.mjs    # ★三档全文模式：切分不丢字符、序号不超限（49 项）
node tests/ui-persist.test.mjs  # ★开关落盘：桌面版拒绝原生写入 → 落覆盖文件；写失败必须抛（29 项）
node tests/qq.test.mjs          # QQ 桥接纯逻辑单测（146 项，含入站路由、ref_idx 反查、提问中继）
node tests/status.test.mjs      # /status 排版纯函数（23 项：列出正在跑的会话、截断、折叠、当前会话行）
node tests/session-picker.test.mjs # ★挑会话：编号/时效/优先级（提问与引用优先）、指针落盘（33 项）
node tests/screen.test.mjs      # 截图：脚本内容（★不含会被 AMSI 拦的构造、★DPI 认领顺序）、路由、图片上行形状（59 项）
node tests/plugin.test.mjs      # mock ctx 驱动的插件集成测试（32 项，含协作接线回归）
node tests/collab.test.mjs      # 协作模式纯逻辑单测（44 项，含总开关护栏，零裸导入、不需要 DSH）
node tests/notes.test.mjs       # 完整回答渲染与上传单测（19 项，注入假 fetch，不出网）
node tests/cloud.test.mjs       # 云端账号 API 客户端单测（29 项，注入假 fetch）
node tests/cloud-integration.test.mjs # ★插件 × 云端 端到端（22 项，真跑一次 HTTP 往返）
node tests/cloud-routing.test.mjs     # 云端优先 / 失败**不**改发中枢的路由规则（7 项）
node tests/load-verify.mjs      # 三层加载验证：import / bundle 解析 / 真实装配（要装到 profile 上）

# 改完代码先跑这个（等价于上面 16 条）
npm test

# 构建 / 打包
node scripts/build.mjs          # src/ -> lib/，含语法与依赖检查
node scripts/pack.mjs           # 打包 tgz
```

下面这批**不在 `npm test` 链里**，是一次性工具：有的要真连中枢、有的要真装到 profile 才能跑，
所以单独放在 `tests/live/`；`scripts/oneoff/` 里则是用完即弃的运维脚本。

```powershell
# ── tests/live/：要真实环境才跑得起来 ──────────────────────────
node tests/live/loader-boot.mjs      # 真实 Cordis 容器启动 + Config 校验路径
node tests/live/installed.test.mjs   # 验证 profile 里装好的产物可加载、可装配
node tests/live/inject-analysis.mjs  # 注入体量与 order 合理性分析
node tests/live/e2e-real.mjs         # 真实 settings + 真实中枢 + 真实文件追加
node tests/live/hub-connectivity.mjs # 中枢连通性（真发 HTTP）
node tests/live/e2e-settings.mjs     # 真实 settings 读写
node tests/live/qq-live.mjs          # QQ 长连接实况
node tests/live/qq-send.mjs          # 真发一条 QQ 消息
node tests/live/dsh-api.mjs          # 本机 /api 客户端探针
node tests/live/verify-final.mjs     # 收尾综合核对

# ── scripts/oneoff/：运维一次性脚本 ────────────────────────────
node scripts/oneoff/fix-credentials.mjs   # 修 ~/.dsh/.credentials.yaml 的旧嵌套格式
node scripts/oneoff/check-qq-markdown.mjs # 检查 QQ markdown 实际渲染效果
```

> `scripts/verify-installed.mjs` / `scripts/verify-ui-installed.mjs` 是**正式验收脚本**（不是一次性的）：
> 装完插件后跑，直接 import **安装目录**里的产物做真实调用与哈希比对。

> 涉及中枢的测试（`tests/live/hub-connectivity.mjs`、`tests/live/loader-boot.mjs`）**不硬编码令牌**，
> 按 `--token=` → `DSH_NOTIFY_TOKEN` → `~/.dsh/settings.yaml` 的顺序解析
> （见 `tests/live/_hub-config.mjs`）。都读不到就**跳过并给出中文提示、退出码 0**，
> 不算失败。这样用户轮换令牌后脚本依然可用。
>
> `scripts/oneoff/fix-credentials.mjs` 用于修复 `~/.dsh/.credentials.yaml` 的旧嵌套格式
> （见下节）。它只打印键名与长度，**绝不打印凭据值**。

### 代码结构

```
src/
  index.js     插件入口：事件订阅、配置解析、工具注册、噪声过滤（子智能体 / 闲聊）
  agentmd.js   操作日志表格定位与追加（纯逻辑，可脱离 DSH 单测）
  collab.js    协作模式：会话注册表 / 文件占用 / 留言 / 注入渲染 / 自动面板（零裸导入，可独立单测）
  notes.js     完整回答：渲染 markdown + 上传中枢换短链接（零裸导入，可独立单测）
  screenshot.js 抓屏：生成 PowerShell 脚本（纯 ASCII）、跑它、拿 JPEG 字节；临时目录必删
  summary.js   从会话事件提取本轮摘要
  qqbot.js     QQ 官方机器人客户端（取 token / WebSocket 长连接 / REST 发送）
  qqbridge.js  QQ 桥接纯逻辑：文案、引用索引（ref_idx）、入站路由、本机 /api 客户端
  qqruntime.js 把上面两者接到 DSH 插件生命周期：通知、提问中继、作答
  config-api.js 浏览器侧用的配置路由（/remote-qqbot/api）：字段表 + 白名单写入 + 信任校验
  overrides.js **插件自有覆盖存储**：原生写入被拒时的落盘、原子写、失败必须抛（零裸导入）
  client.js    **浏览器侧 bundle**（DSH loader 的闭包工厂格式）：设置页那一项 + 输入框下方的两个小开关

tests/         单元测试，全部进 npm test 链，零外部依赖（不连中枢、不连 QQ、不读真实 profile）
  agentmd / settings / config-view / ui-persist / qq / status / screen / plugin / collab / notes : 各组断言
  load-verify.mjs  三层加载验证（import → bundle 解析 → 真实装配），最后一道防线

tests/live/    要真实环境才跑得起来的一次性脚本（不在 npm test 链里，见上）
scripts/       正式工具：build / pack / link-dev / verify-installed / verify-ui-installed
scripts/oneoff/ 运维一次性脚本
docs/          架构文档
lib/           构建产物（npm run build 生成，**不手工编辑、不进版本库**）
```

> 分层原则：**纯逻辑必须能脱离 DSH 单测**，所以 `qqbridge.js` / `collab.js` / `notes.js` /
> `agentmd.js` / `summary.js` 都是「零裸导入」的纯模块；只有 `index.js` / `qqruntime.js` /
> `config-api.js` 允许接触 DSH 服务，它们的护栏放在 `plugin.test.mjs` 里靠 mock ctx 跑。

> `client.js` 是唯一一个「跑在浏览器里」的文件：它不能用 npm 依赖（前端只冻结共享了
> `react` 等 10 个平台模块，见 `packages/client/web/src/platform.ts`），所以样式全是内联 style、
> 图标用字符、配置读写一律走 `config-api.js` 那条同源路由。`package.json` 里靠
> `exports["./client"]` + `dsh.client.platform: "web"` 把它声明给 DSH 的 client-modules 服务。

### ⚠️ 四条必须遵守的加载/配置期约束

**1. `Config` 必须是 schemastery schema，不能是普通 JSON Schema。**
Cordis 在 `resolveConfig`（`vendor/cordis/src/fiber.ts:53`）里调用
`runtime.Config['~standard'].validate(config)`。普通 JSON Schema 对象没有 `~standard`，
会炸成 `TypeError: Cannot read properties of undefined (reading 'validate')`，
**导致整个插件树加载失败**（不是只坏这一个插件）：

```js
import z from '@deepseek-ai/schemastery'
export const Config = z.object({ /* ... */ })                    // ✅
export const Config = { type: 'object', properties: { /* */ } }  // ❌ 整树挂掉
```

**2. 读配置必须 `register`，不能直接 `get`。**
`settings.get(ns)`（`packages/settings/settings/src/index.ts:519`）只返回**已注册**
namespace 的 resolved 值，未注册一律 `undefined`：

```js
const scope = ctx.settings.register(SETTINGS_NS, Config, { base: DEFAULTS })
scope.get()      // 默认值 → base → 用户层 的合并结果
scope.watch(cb)  // 热更新通知
```

直接 `get` 再 `?? {}` 兜底 = **静默降级**：插件打印「已就绪」，但用户配置全部失效。
不崩、不报错，是最难查的一类 bug。

**3. 不要把 cordis 传入的 `config` 合并到 settings 之上。**
Cordis 调 `apply(ctx, config)` 时，`config` 是 `resolveConfig()` 的产物
（`vendor/cordis/lib/index.js`：`return result.value`）——**经过 schema 校验、
每个键都被默认值填满**的对象，形如 `{ hubUrl: '', agentmdDir: '', … }`。
写成 `{ ...scope.get(), ...config }` 会让这些空串覆盖掉 settings 里的真实值，
现象是「scope 里明明有值，读出来却是空」。本插件只把 `config` 里
**与默认值不同**的键当作显式覆盖（见 `src/index.js` 的 `liveConfig()`）。

**4. 不要 import DSH 的 workspace 包。**
`@deepseek-ai/dsh-settings` 这类包只存在于 DSH 源码 checkout，不会出现在用户 profile 的
`node_modules` 里，import 它会在加载期 `ERR_MODULE_NOT_FOUND`。
`@deepseek-ai/dsh-tools`（`defineTool`）与 `@deepseek-ai/schemastery` 是**唯一**允许的
裸包导入，构建脚本会拦住其它裸包。

**5. 配置写入不要只信原生通道，失败更不许被吞。**
桌面版设置服务对第三方 namespace 的 `update()` 会抛
`No configurable plugin entry "dsh-remote-qqbot"`（profile 里的 entry id 是 `remote-qqbot`，
且 `describe()` 会跳过没有 volatile 字段的条目）。所以：

- 写入必须先试原生、抛错就落**覆盖文件**（`src/overrides.js`），两条路都不通时**必须抛**；
- 失败响应里 `ok: false` 只能出现在 `...configView(...)` **之后**——反过来写会让
  `ok: true` 把失败盖掉，前端于是「点了没反应、也不报错」（0.8.4 修的正是这条）；
- 合并配置时覆盖文件排在最后（见「配置写在哪、谁盖谁」），否则关不掉的开关永远关不掉。

### 配置生效自检

启动日志**只有两行状态**（其余都挪进了设置面板）：

```
[remote-qqbot] QQ 提醒：已开（AppID 1904***，专属会话 cwd=D:\…）
[remote-qqbot] 协作：已开（范围 workspace，写冲突 warn）
```

想知道 settings / 中枢 / 云端 / agentmd / 界面改过的配置**到底读到了什么**，
看 **设置 → QQ 远程提醒与跨会话记忆 → 顶部「运行状态」**（只读）；
插件还导出了 `lastStatusLines()`，返回的就是这份快照，方便脚本排查。

⚠️ 出故障时**仍然会打日志**（`⚠️ 读不到 ~/.dsh/settings.yaml`、`qqAppId 没配齐`、
提问中继没接上…）—— 那些不是"日常状态"，藏着只会让人白排查一轮。

### 怎么验证插件真的能加载（别只看「安装成功」）

```powershell
# 建一个一次性 headless profile 做真实 loader 启动，看日志里有没有 [remote-qqbot] 已就绪
dsh plugin --profile verifyheadless add <tgz>
dsh --profile verifyheadless "1+1等于几"
```

**安装成功 ≠ 加载成功。** v0.1.0（import 了 dsh-settings）与 v0.2.0（Config 用了普通
JSON Schema）都是「pnpm 装得好好的、一启动就报错」。只有真实启动一次才算数。
