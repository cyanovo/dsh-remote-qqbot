# dsh-remote-qqbot

[![CI](https://github.com/cyanovo/dsh-remote-qqbot/actions/workflows/ci.yml/badge.svg)](https://github.com/cyanovo/dsh-remote-qqbot/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A520-43853d?logo=node.js&logoColor=white)](#安装)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![QQ](https://img.shields.io/badge/QQ-%E5%AE%98%E6%96%B9%E6%9C%BA%E5%99%A8%E4%BA%BA-12B7F5)](https://q.qq.com)

DSH 的 QQ 远程机器人插件。DSH 在电脑上干活，你在外面：跑完了、需要你拍板、出错了，它主动发到你 QQ；
你在 QQ 里引用那条消息回一句，这句话就回到它所属的会话里，跟你坐在电脑前打字一样。

## 网站：完整回答在这里看

QQ 消息里放不下长回答。这个站点是完整回答的落脚点：插件把正文存上去，QQ 里只留一条短链接，
点开就是排版好的全文，手机上打开的也是这个页面。

网站入口：<https://cyanovo.top>

| 站点上有什么 | 说明 |
|---|---|
| 完整回答 | 登录后打开记录，读排版好的原文，不受聊天窗口长度限制 |
| 账号与额度 | 免费版每天可看 100 次、记录保留 5 小时；付费版 ¥2.99 / 30 天，每天 1000 次、保留 48 小时 |
| 设备码绑定 | 插件里不用填账号密码：设置里点绑定，网站给一组设备码，确认一次就把插件挂到你账号下 |
| 记录列表 | 每条记录带来源会话、时间与过期时间 |

网站是可选的。默认配置下插件一个字节都不上传，正文只存在于你自己的机器和 QQ 聊天记录里。
要用短链接，先在设置里打开 `cloudEnabled` 总闸。

想自己部署也可以，代码就在本仓库 `server/` 下，见 [server/README.md](server/README.md)。

## 仓库结构

| 路径 | 内容 |
|---|---|
| 根目录 | 插件本体 —— 仓库根目录就是 npm 包，`dsh.bundle` 指向 `cordis.patch.yml` |
| `server/dsh-web` | 网站：账号、额度、记录、完整回答页面 |
| `server/dsh-notes-render` | 把 markdown 渲染成网页，并生成 QQ 能展开的预览卡 |
| `docs/` | 配置、接入 QQ、完整回答、开发等专题文档 |

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
| 跑完 / 提问 / 出错推送到 QQ；QQ 里引用回复；`/status` `/sessions` `/screen` `/update` `/help` | **只要一对 QQ 凭证** |
| agentmd 自动操作日志、会话上下文注入 | 只要填一个本机目录 `agentmdDir` |
| 同一工作区多会话自动协作、QQ 闲聊 | **零配置**（默认就开着） |
| 跨会话记忆（`memory_read` / `memory_write`） | 一个中枢地址（可自建）—— 可选 |
| **在 QQ 里点开「完整回答」的短链接** | **一个云端账号 —— 唯一需要登录的功能**，可选 |

> 把最后一行说白：**只有「把完整回答存到服务器、换一条能点开的短链接」这一档需要登录。**
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
| 16 | **远程更新：有新版本 QQ 提醒，`/update` 一句话装好** | 插件定期查版本索引；装完自动重启 DSH（不重启不生效）。见「[QQ 指令](#qq-指令)」 |

> **一句话记住入站规则**：**引用**机器人的消息 = 对那条消息所属的会话说话；
> **不引用**直接发 = **用 `/sessions` 指定过就进那个会话**（有提问在等时优先当作答），
> 什么都没指定时才是闲聊（进独立的「闲聊会话」，**不进**任何工作会话）。
>
> **不打扰你的两类"完成"**：子智能体（subagent）跑完不推送 —— 它是你派出去的内部活儿；
> 闲聊会话跑完也不推送 —— 你人就在 QQ 里等着回复。两者都可用配置打开。
>
> **闲聊会话是"只读"的**（默认开）：机器人可以查状态、读文件、跑查看类命令，
> 但**任何写入 / 修改 / 删除都会被拒绝**，回答只做分析和建议。
> ⚠️ 只读保护的是**本机文件系统**；它拦不住 `shell` 里去改**远程主机**（例如 `ssh` 到服务器上删文件）——
> 那属于远程侧权限，需要服务端自己收紧。
>
> **闲聊的回答直接发在 QQ 聊天框里**（默认开）：不发推送卡片、**也不上传**「完整回答」笔记，
> 所以不会在服务器上留下任何文件；代价是超长回答会被截断（默认 1500 字）。
>
> **隐私默认值**：**云上传总闸 `cloudEnabled` 默认关闭**。
> 关着的时候，即使模式选了「存服务器」，插件也**一个字节都不会往服务器传**，
> 而是退回「把正文直接切条发到 QQ」（日志会明说这件事）。
> 也就是说：**默认配置下，你的回答正文只存在于你自己的机器和你的 QQ 聊天记录里。**
> 想用短链接就得自己去设置里把这个总闸打开 —— 这是刻意的：
> 「把你的正文上传到别处的服务器」这件事必须由你明确同意。

## 安装

**方式一：从 GitHub 装（推荐）** —— 仓库里带了构建好的 `lib/`，装完即可用，不需要本地构建：

```powershell
dsh plugin --profile desktop add github:cyanovo/dsh-remote-qqbot
```

**方式二：从 npm 装** —— 包**还没有发布到 npm**，这条现在会报 `ERR_PNPM_FETCH_404`：

```powershell
dsh plugin --profile desktop add dsh-remote-qqbot
```

**方式三：本机构建 tgz**（改过源码，或想离线装）：

```powershell
cd dsh-remote-qqbot
npm run pack                                          # 产出 dsh-remote-qqbot-<版本>.tgz
dsh plugin --profile desktop add ./dsh-remote-qqbot-<版本>.tgz
```

用 `dsh web` 起的把命令里的 `--profile desktop` 换成 `--profile web`，其余不变。

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

## QQ 指令

发在聊天框里、以 `/` 开头的话：

| 指令 | 作用 |
|---|---|
| `/task <内容>` | 强制当新任务送进专属会话（压过引用与闲聊的全部判断） |
| `/sessions`（也认 `/会话`、`/list`） | 列出最近在聊的几个会话（默认 6 个，见 `qqRecentCount`），回个数字就切过去 |
| `/use <N>`（也认 `/切 <N>`） | 直接切到第 N 个；`/use 0` = 取消指定 |
| `/screen`（也认 `/screenshot`、`/shot`、`/截图`、`/屏幕`） | 抓一张电脑屏幕发给你，见 [docs/QQ.md](docs/QQ.md) |
| `/status` | 看状态：正在跑哪些会话，以及 QQ 与入站链路是否正常 |
| `/update`（也认 `/更新`） | 把插件更新到最新版（默认装完自动重启 DSH）；`/update check` 只查不装 |
| `/help` | 打印指令清单 |

### 有新版本时：它来告诉你，`/update` 一句话装好

QQ 里会收到「🔔 插件有新版本 x.y.z（现在跑的是 a.b.c）。发 /update 我就装上 —— 装完会自动重启 DSH，中间有十几秒连不上。」
回一个 `/update` 就行；只想确认一下，用 `/update check`。

- **只在真的有新版时才吭声**：同一个版本只提醒一次，已经是最新版就什么都不发（不刷屏）。
  🔴 远端版本比本机**旧**时同样不发、也**绝不安装** —— 版本号不一样就装等于把用户降级。
- 装完回一条 `✅ 已装 x.y.z（原来是 a.b.c）`，然后**自动重启 DSH**（DSH 没有插件热重载，重启是唯一让新版本生效的办法）。
  起来之后还会再回一条 `✅ 重启完成，插件现在是 x.y.z`；那条回执靠一个重启标记文件，所以手动重启也会收到。
- 那句话里带着兜底动作：**要是过了一分钟 DSH 还没回来，手动打开一次就行**。插件自己会被这个重启流程杀掉，
  没法当场汇报重启结果，所以这句必须提前说。
- 不想自动重启，把 `qqUpdateAutoRestart` 关掉：只回一句「重启后生效」，由你自己挑时间。
- 更新源默认是作者服务器上的版本索引（`https://cyanovo.top/plugins/dsh-remote-qqbot/update.json`：
  版本号 + 压缩包地址 + sha256），所以发版**不需要往 Git 仓库里塞提交**。想换成 GitHub 或 npm，
  把 `qqUpdateSource` 改成 `github:作者/仓库` 或包名。自己搭通道的格式见 [docs/UPDATE.md](docs/UPDATE.md)。
- 更新走**桌面版自带的那套运行时**（`DeepSeek Harness.exe --expose-internals …/pnpm.mjs add …`），
  不会去调用 PATH 上的 `dsh`（开发机上那个 `dsh` 常常指向一份源码检出，用它更新会装错地方）。
- 自动重启在 Windows 上有两个坑（1.0.10 / 1.0.11 修）：启动新进程前要清掉从插件进程继承来的
  `ELECTRON_RUN_AS_NODE`（带着它的 `DeepSeek Harness.exe` 只当 node 跑一下就退出，桌面版不会启动）；
  认进程不能只看 `Get-Process` 的 `.Path`（刚创建的进程读不到它），要用 CIM 兜底。
  细节见 [docs/UPDATE.md](docs/UPDATE.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §3.10。
- 每次检查与安装都追加到 `~/.dsh/dsh-remote-update.log`，事后能查。

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

## 完整回答去哪（三档）

| 档 | 正文去哪 | 要账号吗 |
|---|---|---|
| `chat`（默认） | 切成几条直接发进 QQ | 不要 |
| `note` | 存到网站，但 QQ 里不给链接 | 要 |
| `note-link` | 存到网站，并在 QQ 里给一条短链接 | 要 |

三档的取舍、设备码绑定、短链接的实现细节，见 [docs/FULLTEXT.md](docs/FULLTEXT.md)。

## 配置

在 DSH 里打开「设置 → QQ 远程提醒与跨会话记忆」，全部配置项都能在图形界面里改，不用手写 YAML。
配置文件是 `~/.dsh/settings.yaml`，界面里改过的值会覆盖文件里的值。
全部字段、默认值、以及谁盖谁，见 [docs/CONFIG.md](docs/CONFIG.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/CONFIG.md](docs/CONFIG.md) | 配置写在哪个文件、谁盖谁、全部字段与默认值 |
| [docs/QQ.md](docs/QQ.md) | 接入 QQ 官方机器人：能力边界、配置步骤、指令、屏幕与会话 |
| [docs/UPDATE.md](docs/UPDATE.md) | 远程更新：版本索引的格式、自己搭通道、自动重启与失败排查 |
| [docs/FULLTEXT.md](docs/FULLTEXT.md) | 完整回答三档、设备码绑定、短链接 |
| [docs/COLLAB.md](docs/COLLAB.md) | 协作模式：同一工作区多会话自动避让 |
| [docs/AGENTMD.md](docs/AGENTMD.md) | agentmd 自动操作日志与会话上下文注入 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发：测试、构建、代码结构、硬约束、自检 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构与内部实现：模块职责、数据流、状态文件、踩坑清单 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |
| [LICENSE](LICENSE) | MIT |

## 开发

~~~bash
npm install          # 装 DSH 自己的包，仅用于本地测试；跑起来时由 DSH 宿主提供
npm test             # 17 组测试
npm run pack         # 构建 + 打出 tgz
~~~

本机开发也可以不装依赖，用 `node scripts/link-dev.mjs` 建一个指向 DSH profile 的 node_modules 联接。
测试链、构建流程、代码结构与必须遵守的加载期约束，见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 联系方式

装不上、报错看不懂、想要新功能，直接找我。

QQ **1103416608** ｜ GitHub **[@cyanovo](https://github.com/cyanovo)**

## License

MIT，见 [LICENSE](LICENSE)。
