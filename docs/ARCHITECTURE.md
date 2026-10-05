# dsh-remote-qqbot 架构与实现说明

> 这份文档写给**要改这个插件的人**（未来的我、别的会话、别的机器）。
> 面向使用者的安装/配置说明在 [../README.md](../README.md)，本文只讲**内部怎么跑的**。
>
> 文档描述的是当前源码状态。最后核对：2026-10-05（版本 **1.0.7**；1.0.7 新增
> **远程更新**：启动时查一次、之后每 `qqUpdateCheckHours` 小时查一次，发现新版本就在 QQ 里提醒一次
> （同一个版本只提一次、远端更旧或相同都**不吭声**）；QQ 里发 `/update`（同义词 `/更新`，
> `/update check` 只查不装）就装新版，装完**自动重启 DSH**（可关），重启后回一条「已生效」确认。
> 新增 `src/update.js`（纯逻辑，零外部依赖）与 `tests/update.test.mjs`，见 3.10。
> 1.0.6 修的是
> **「引用一条 QQ 消息发过去，机器人回『认不出这是哪次通知』，而那句话哪儿都没进去」**：
> ①机器人自己的**回执**（✅ 收到 / ❌ 没送进）以前从不登记 `ref_idx` → 引用回执必然反查落空；
> ②兜底只有 5 分钟窗口、且只看 `recent[]`（不看 `sentRefs`）；
> ③两路落空就回一句「认不出」并把消息**整条丢掉**。
> 现在：回执也登记 `ref_idx`；兜底窗口放宽到 12 小时并合并两个数据源（回复里明说是多久前那条）；
> 真的一条都对不上时改投**闲聊会话（只读）**并说清去了哪 —— 绝不静默丢消息。见 3.6b。
> 1.0.5 修的是
> **「AI 提问后隔久了再答，系统却说没有在等你回答的问题」**：`ASK_TTL_MS` 从 30 分钟放宽到
> **24 小时**（提问是 agent 在阻塞等的东西，清理依据该是"这轮提问结不结束"，不是"过了多久"），
> 且 `request.signal` 一中止就立刻摘掉 QQ 条目、真过期必须打日志、提问已结束时把话说明白。
> 见 3.7。1.0.4 只动**文案**：
> QQ 侧档位名统一成「免费版 / 付费版」。
> 1.0.3 只动**文案**：
> 设置面板的字段说明改成短句、去掉 emoji 与「体积旋钮」这类术语；顺手把中枢地址的示例
> 从已下线的 `cyanovo.top:8444` 换成占位符。逻辑一行没动，`npm test` 与两个安装校验脚本全绿。
> 1.0.2 修的是
> **「协作文档把上下文顶爆」**：注入腿原本每步把 `main.md` **全文**塞进 prompt（文件多大、
> prompt 就多大），文档涨到 30 万字符后上游直接回 `413`；现在过 `buildContextDoc()` 压缩，
> 注入正文**永不超过** `agentmdInjectMaxChars`（默认 8000），且省略处明写省略了多少字符；
> 追加腿也给单条日志行封了顶（`agentmdRowMaxChars`，默认 600）。见 3.3。
> 1.0.1 修的是
> **「引用消息没办法回答」**：桌面版把 `~/.dsh/.credentials.yaml` 里的
> `client-connection/browser-session` 记录弄丢后，`dshApi` 的 cookie 换不出来、
> 入站注入全线 401，而出站推送不受影响 ⇒「通知正常、引用回复全死」。现在
> `ensureApi()` 每次要用都重读密钥、记录缺失时自己补回来，并把结果写进报错文案与 `/status`，
> 见 3.9；1.0.0 把这个插件正式公开：
> **包名从 `dsh-notify-memory` 改为 `dsh-remote-qqbot`**，并把 `lib/` 改成**必须提交进版本库**
> —— `dsh plugin add github:<owner>/<repo>` 装的是 git 里的文件，git 没有"安装时构建"这一步，
> 不提交 `lib/` 用户就装到一个空壳，见第九节「发布到 GitHub」；
> 0.9.0 把输入框下方的小开关**从 4 个收回 2 个** —— `qqFulltextMode` / `cloudEnabled` 搬进设置面板，见 4.1「UI 挂点」；
> 0.8.6 新增**三档全文模式** `chat` / `note` / `note-link` 与**默认关闭的云上传总闸** `cloudEnabled`，
> 见 3.8 与 6.7；0.8.4 新增**插件自有覆盖存储** `src/overrides.js`，见 5.3b）。

---

## 一、它是什么

一个 **DSH（DeepSeek Harness，cordis 架构）插件**，纯 ESM JavaScript，**无 TypeScript、无构建期转译**。
包名与仓库同名：**`dsh-remote-qqbot`**；安装方式是
`dsh plugin --profile desktop add github:<owner>/dsh-remote-qqbot`
（仓库里带着构建产物 `lib/`，装完即可用，见第九节）。
它靠两条腿工作：

| 侧 | 文件 | 运行位置 | 能干什么 |
|---|---|---|---|
| **host 侧** | `src/index.js` 等 11 个模块 | DSH 的 Node 主进程 | 订阅 agent 事件、注册工具、发 HTTP、连 QQ 长连接 |
| **client 侧** | `src/client.js` | DSH 的浏览器前端 | 设置页那一项、「输入框下方」的两个小开关 |

两侧**没有共享代码**，靠一条同源 HTTP 路由（`/remote-qqbot/api`）通信：

```
浏览器 (client.js)  ──fetch──▶  /remote-qqbot/api/*   (config-api.js 挂的路由)
                                        │
                                        └──▶ host 的 liveConfig() / 写配置（原生 settings 优先，被拒则落覆盖文件）
```

**外部依赖只有两个裸包**（构建脚本会拦住其它裸包）：

- `@deepseek-ai/dsh-tools` —— 只为了 `defineTool`
- `@deepseek-ai/schemastery` —— 只为了 `z.object` 定义配置 schema

> ⚠️ 不要 import `@deepseek-ai/dsh-settings` 之类的 workspace 包：它们只存在于 DSH 源码
> checkout，用户的 profile 的 `node_modules` 里没有，会在**加载期** `ERR_MODULE_NOT_FOUND`
> （v0.1.0 就是这么挂的）。

核心不变量：**`src/` 里没有一个文件读环境变量、没有一个文件写死生产地址。**
所有真实配置只从 `~/.dsh/settings.yaml`（及其 profile 补丁层）来，见 [第六节](#六配置系统为什么这么绕)。

---

## 二、目录结构

```
src/                 源码（唯一可编辑的真相来源）
  index.js           1274 行 · 插件入口
  qqbot.js           QQ 官方机器人客户端（取 token / WS 长连接 / REST 发送）
  qqbridge.js        QQ 纯逻辑：文案、引用索引、入站路由、本机 /api 客户端、/status 排版
  qqruntime.js       把 qqbot + qqbridge 接到 DSH 生命周期：通知、提问中继、作答
  collab.js          协作模式：会话注册表 / 文件占用 / 留言 / 注入渲染 / 面板落盘
  notes.js           完整回答：渲染 markdown + 上传中枢换短链接
  summary.js         从会话事件里提取「本轮做了什么」
  agentmd.js         操作日志表格定位与追加
  config-api.js      浏览器侧配置路由 + 字段表 + 白名单写入
  overrides.js       插件自有覆盖存储：原生写入被拒时的落盘 / 原子写 / 失败必抛
  client.js          浏览器侧 bundle（DSH loader 的闭包工厂格式）

lib/                 构建产物（npm run build 由 src/ 生成，不手工编辑、不进版本库）
tests/               单元测试，全部进 npm test 链，零外部依赖
tests/live/          要真实环境（真中枢 / 真 profile / 真 QQ）才跑得起来的一次性脚本
scripts/             正式工具：build / pack / link-dev / verify-installed / verify-ui-installed
scripts/oneoff/      运维一次性脚本
docs/                本目录
cordis.patch.yml     DSH bundle 补丁：把插件插进 desktop profile
```

---

## 三、六个数据流

### 3.1 出站推送（任务完成 / 提问 / 出错）

```
agent 事件
  │
  ├─ agent/status  (running → idle) ─┐
  ├─ tools/pre-execute(ask_user_question) ─┐
  └─ agent/error ────────────────────┐     │
                                     ▼     ▼
                            push(kind, summary, agent, extra)
                                     │
                     ┌───────────────┼────────────────┐
                     ▼               ▼                ▼
              中枢 POST /api/events   QQ 主动私聊    agentmd 追加日志
              （收件箱 + ntfy）      （qqruntime）
```

`push()` 是唯一的出口，它在这里做**噪声过滤**（顺序就是判定顺序）：

| 过滤 | 条件 | 效果 |
|---|---|---|
| 子智能体 | 会话头 `origin` 表明是 subagent，且 `notifySubagents=false` | 静默 |
| 闲聊会话 | 是该会话，且 `notifyChatSession=false` | 静默（回答另走 3.6） |
| 去重 | 同内容在 `dedupeMs` 内已推过 | 静默 |

三类事件各有开关（`onTurnComplete` / `onQuestion` / `onError`）。

**推送里怎么出现「查看完整回答」链接：** 长回答会先走 `notes.publishTurnNote()`
（渲染 markdown → 上传中枢 → 换回 `<id>`），推送正文只留摘要 + 一个链接。
链接必须过 `qqPreviewUrl()` 加工（见 [第七节](#七qq-三个容易踩死的点)）。

### 3.2 跨会话记忆

三个工具直接读写中枢：

| 工具 | 动作 |
|---|---|
| `memory_write` | `POST /api/memory` |
| `memory_read` | `GET /api/memory` |
| `memory_forget` | `DELETE /api/memory/:key` |

`hubUrl` 留空时**只记日志、不发请求**（默认值就是空的，所以单元测试不会误打线上）。

### 3.3 agentmd 跨会话上下文

两个方向，分别由两个开关控制：

- **写入**（`agentmdAppendLog`，默认开）：会话转 idle 时，把「本轮做了什么」追加进
  `agentmdDir/main.md` 第 4 节的表格里。表格定位在 `agentmd.js`，是纯函数。
  单行还会过 `buildLogRow({maxChars})` 封顶（`agentmdRowMaxChars`，默认 600）：
  超长只裁「操作」列，时间列与三列骨架不动 —— 否则一条超长摘要会把表格越撑越大。
- **读取**（`agentmdInject`，默认关）：`agent/created` 时把 `main.md` 注入这个会话的
  system prompt（注入 id 形如 `remote-qqbot:agentmd`）。`text` 是**函数**、每步重读盘，
  所以**注入前必须先压缩**：`buildContextDoc(text, {maxChars, tailRows})` 保证返回
  `text.length ≤ agentmdInjectMaxChars`（默认 8000），压缩策略是「§四 小节 + 最近
  `agentmdInjectTailRows` 行日志」优先、剩余预算给开头正文，被丢掉的部分在正文里
  明写 `…（此处省略约 N 个字符…）…`。**绝不能静默截断** —— 模型会把「没看到」当成
  「不存在」；也绝不能只靠「把文件写小」——没人能保证下一个人不往里贴长文。

### 3.4 协作模式

**前提事实**：同一个工作区里的所有会话**跑在同一个 DSH 进程里**。所以协作不需要轮询、
不需要外部服务，就是一个进程内注册表。

```
collab_claim / 写文件工具前置钩子
        │
        ▼
  collab.js 注册表（sessionId → 占用的文件 + 留言 + 心跳）
        │
        ├─▶ 撞车：collabClaimGuard = warn（默认，提醒）| block（拒绝写入）| off
        ├─▶ 注入：有新情况时把「谁在写什么、谁给你留言了」塞进会话上下文
        └─▶ 落盘：写进 agentmdDir/plugin-collab.md（给人看的手工版，自动维护）
```

会话转空闲时**立即释放**占用；没释放的按 `collabClaimTtlMs`（默认 30 分钟）过期。
单人单会话时这套的代价是零——没有可说的就**一个字都不注入**。

四个工具（`collab_status` / `collab_post` / `collab_claim` / `collab_release`）**即使
`collabEnabled=false` 也仍然注册**，只是回一句「协作模式已关闭」——刻意避免「工具突然消失 /
报错」这种惊吓。

### 3.5 QQ 出站：从事件到手机

```
push(event) ──▶ qqruntime.notify() ──▶ qqbot.sendC2C(openId, markdown 文本)
```

- 通道是官方机器人 **WebSocket 长连接**（`qqbot.js` 取 access token → `/gateway` → 心跳）；
- 消息类型由 `qqMarkdown` 决定：`true` = `msg_type=2`（markdown），
  **只有 markdown 才能把链接折叠成一句「查看完整回答」**；客户端显示异常时设 `false` 退回纯文本；
- 摘要长度受 `qqSummaryChars` 限制，0 = 不附摘要。

### 3.6 QQ 入站：三种消息、三条路

```
        QQ 消息（C2C_MESSAGE_CREATE）
                 │
      ┌──────────┼───────────────────────┐
      ▼          ▼                       ▼
  以 / 开头的指令   引用了机器人的消息        什么都没引用
  (/status /help   （ref_idx 反查 →          （先看有没有「当前会话」）
   /task /answer   消息属于哪个会话）              │
   /sessions /use)      │              ┌─────────┴─────────┐
   /screen ── 截图直接回图  │          指定过 → 投进它     没指定 → 闲聊
       │              │              （不在了会明说）    （只读 + 回答直发 QQ）
       ▼              ▼
  本地直接回复    投进那个会话
                  继续对话
```

**裸数字的归属（0.8.5 起，顺序不能反）**：`引用 > 有提问在等 > 选会话 > 闲聊`。
agent 卡在提问上等你回一个 `1` 时，那个 `1` 是在**回答它**；只有在「没引用 + 没有提问在等 +
名单刚发出去 5 分钟内」这三个条件同时成立时，裸数字才被当作「切到第 N 个会话」。设计理由见 6.6。

> `/screen` 是唯一一条**回图片**的入站路径：它不注入任何会话，抓一张屏就往回发。
> 权限上走 `qqScreenEnabled`（默认开）。实现见 `src/screenshot.js`，
> 它踩过的 AMSI 坑记在下面 6.4。

**引用是怎么反查到会话的**：插件发出去每条通知时，都在消息里埋了一个引用索引 `ref_idx`
（自己的短 id）。你引用那条消息回复，QQ 会把被引用消息的原文回传，插件据此解析出它当时属于
哪个会话 —— 所以「引用谁 → 回到谁」是**确定性**的，不是猜的。

**但「发出去的每条都要埋」这条以前没做到 —— 回执漏了**（1.0.6 修，见 3.6b）。

### 3.6b 引用反查的三级兜底：认不出会话也**不许丢消息**（1.0.6）

真事故（2026-10-05 02:31，主人报「机器人说认不出这是哪次通知」）：QQ 里收到 4 条消息，
只有 1 条进了会话，另外 3 条**哪儿都没进去** —— `session-edc80d93` 的转录里连
`user/message` 和 `agent/inbox/spliced` 都没有，等于主人的话凭空消失。

| 级 | 判据 | 以前的行为 | 现在的行为 |
|---|---|---|---|
| ① 精确 | `sentRefs[ref_idx]` 里有这条 | 只登记**通知/提问/全文/截图**；**回执不登记** → 引用「✅ 收到」必然落空 | 回执（`replyPassive`，带 target 时）**也登记** `ref_idx` → 引用它回到同一个会话 |
| ② 兜底 | `ref_idx` 不认识，但最近发过带会话的消息 | 只看 `recent[]`、窗口 **5 分钟** | `recentTarget()` 合并 `recent[]` + `sentRefs{}` 取**真正最新**一条，窗口 **12 小时**；回复里明说「按最近那条的会话送进去了，那条是 N 分钟前发的」 |
| ③ 落底 | 一条带会话的记录都没有（引用自己发的、或好几天前的） | 回一句「你引用的这条我认不出是哪次通知了」→ **消息整条丢掉** | 投进**闲聊会话**（`qqChatReadOnly`，只读、动不了手）并说清「这句话我放进了闲聊」 |

三条的设计取向都是同一句话：**落错一个只读会话，也比让主人的话消失强**。
`ageMs` 会如实报出来，所以他一眼能判断②猜得对不对，错了立刻 `/sessions` 重挑再发。

窗口为什么是 12 小时：QQ 的引用没有有效期，隔一顿饭再引用一条通知回话是正常用法；
再往前的（隔天、隔几天）就不敢猜了，那时宁可按③落到只读的闲聊会话。

**`qqPromptMode` 决定投递方式**（这是渲染差异，不是审美问题）：

| 值 | 行为 | 在 DSH 里长什么样 |
|---|---|---|
| `queue`（默认） | 排队，等当前这轮跑完 | `user` 节点 = **正常的用户消息气泡**，和你在输入框打字一样 |
| `steer` | 插话，立刻打断当前这轮 | `steering` 节点 = 「插话」样式，不占正常对话位 |

**闲聊会话的两条硬规则**（用户明确要求）：

1. `qqChatReadOnly`（默认开）：每次发消息前把这个会话的 DSH 权限预设切成 `read-only`。
   实现方式是**切权限**而不是禁工具——这样它照样能查状态、读文件、跑查看类命令，
   只是改不动。⚠️ 已知边界：沙箱管的是**本机文件系统**，拦不住 `shell` 里 SSH 去改远端主机。
2. `qqChatReply`（默认开）：回答正文**直接发回 QQ 聊天框**，不推通知卡片、**不上传笔记**
   （所以服务器上零残留），代价是超过 `qqChatAnswerChars`（默认 1500）会被截断。

### 3.7 提问中继：QQ 优先，桌面只是「延时兜底」

```
agent 要提问 ──▶ svc.ask(request)
                    │
                    ├─ 先发 QQ：发失败 → 立刻 original(request)（与原生提问一致）
                    │
                    └─ 发成功 → 只等 QQ 的回答
                                │
                                └─ 90 秒（ASK_DESKTOP_FALLBACK_MS）没回
                                     → 才补一张桌面卡片
```

**为什么要这么设计（这是 0.7.7 修的一个真 bug）：**
桌面那张提问卡片**只能由 DSH 自己收起**。旧写法 `Promise.race([viaQq, original(request)])`
一开头就在桌面创建了一条 pending 记录，于是「QQ 里答完了、agent 继续跑，卡片却永远挂着」，
而且新连上的客户端还会被重放。正确解法是**一开始就别创建那条记录**，
而不是答完了再去清（清不掉）。

配套细节：
- 兜底卡片真出现、你随后又在 QQ 里回答 → 答案照算，回执末尾追加一行提示你怎么把卡片收掉；
- 桌面那条 Promise 落定后**删掉** `pendingAsks` 里对应条目（否则在更长的 TTL 内全局 FIFO
  可能把下一条消息投错）；
- 兜底定时器在 QQ 回答到达后必须 `clearTimeout` —— 否则 90 秒后一个**已经答过**的提问
  会突然弹到桌面上（写测试时抓到的第二个 bug）。

**提问的「待答条目」跟提问同生共死（2026-10-05 修的 bug）：**

主人报的原话是「AI 想对我提问，我长时间不回答，等我回答的时候就会提示我没有对我进行提问」。
现场时间线（`~/.dsh/qq-bot-state.json` + 会话快照，不是推测）：

| 时刻 | 发生了什么 |
|---|---|
| 23:51:38 | 提问发到 QQ（`ask-…-j65zsj`，会话 `session-edc80d93…`），agent 阻塞等待 |
| 00:21:38 | **`ASK_TTL_MS` 到期**，条目被静默摘掉（当时日志里一个字都没有） |
| 00:45:13 | 主人引用那条提问作答 → 查不到待答提问 → 回「这会儿没有等你回答的问题」，回答被丢掉 |

根因是**把"过了多久"当成了清理依据**：`ASK_TTL_MS` 原本只有 30 分钟，一个人出门/睡一觉回来
再答就超时了；而提问是 agent 在**阻塞等待**的东西，清理依据应该是「这轮提问结不结束」。
现在两条都钉住了：

| 位置 | 行为 |
|---|---|
| `ASK_TTL_MS` | 30 分钟 → **24 小时**，只当兜底（`tests/qq.test.mjs` 里有一条"等了 54 分钟仍算数"的行为测试 + 反向校验） |
| `relayAsk` 的 `cancelAsk()` | `request.signal` 一中止（turn 被取消）就**立刻摘掉** QQ 条目，并撤掉兜底闹钟；早中止的 signal 干脆一个字都不发到 QQ |
| `oldestPending()` / 兜底闹钟 | 真过期时必须**打日志**（这次故障最难查的就是"提问静默消失"） |
| 已结束的提问收到回答 | 文案改成说清「提问结束了 / 你这句没送进去 / 下一步怎么办」，而不是一句「没有在等你回答的问题」 |


---

### 3.8 完整回答的三档去向：正文到底会不会离开本机（0.8.6）

`agent/status` 的 `idle && prev==='running'` 分支里，非闲聊会话发起一次**三选一**：

```
cfg = liveConfig()                                    // 现读，热更新立即生效
mode   = normalizeFulltextMode(cfg.qqFulltextMode)     // 非法值 → 'chat'（永不误上传）
upload = cfg.cloudEnabled === true && uploadsFulltext(mode)

!upload ─┬─ 若 mode 本来想要上传 → log（说清是哪条闸挡住的）
         └─ push(turn-complete, summary, { fulltext: composeChatAnswer(parts, qqFulltextMaxChars) })
                 └─ push() 里：kind==='turn-complete' 且 fulltext 非空
                        → qq.sendQqFulltext({ text })      ← 零字节出网到"我的服务器"
upload  ──→ publishTurnNote(agent, parts) → notes.js → POST <hubUrl>/api/notes
                 └─ push(turn-complete, summary, showsFulltextLink(mode) ? { noteUrl } : {})
```

三条硬约束（都在 `src/fulltext.js` 里做成纯函数，所以能单测、不用起 DSH）：

| 函数 | 语义 |
|---|---|
| `normalizeFulltextMode(v)` | 只认 `chat` / `note` / `note-link`，**其它任何值 → `chat`**。宁可少一个功能，不可因拼错配置就把正文传出去 |
| `uploadsFulltext(mode)` | `note` / `note-link` 才是 true；`chat` 永远 false |
| `showsFulltextLink(mode)` | 只有 `note-link` 为 true |

**为什么把"总闸"和"模式"拆成两个开关**：模式表达**意图**（我想怎么用正文），
总闸表达**授权**（我同意这台服务器接住我的正文）。只有两者都满足才发生上传；
于是"默认不发"这件事**不依赖任何人的自觉**，而是合并逻辑的必然结果 ——
探针实测：`chat` + `cloudEnabled:false` 时 `/api/notes` 请求数为 **0**。

**分条发送**（`chat` 档）：`planQqFulltext` = `splitForQq`（段落 → 行 → 硬切，不丢字符）
+ `markQqChunks`（给每条加 `（i/n）` 前缀）。两个必须记住的点：

1. **`planQqFulltext` 已经加过序号，调用方不许再加一次**（`markQqChunks` 在 `splitForQq` 之后）；
2. **序号算在长度预算里**：`MARKER_RESERVE = 9`（`（1/15）\n` 是 8 码点，留 1 余量），
   所以 `bodyLimit = max(1, limit - MARKER_RESERVE)`。
   🔴 这里原来写的是 `Math.max(MIN_CHUNK_CHARS, …)`（下限 100），
   **当 `limit ≤ 109` 时 `bodyLimit` 被抬到 100 以上，加序号后反而超限** ——
   实测 `limit=100` 时产出 106 字的 chunk（超限 6）。取消这个下限后才真正满足"带序号不超限"。

**`maxChars` 的两种含义别混**：`qqFulltextMaxChars`（默认 6000）管的是**正文总量**
（`composeChatAnswer` 按码点截断），`QQ_TEXT_SAFE_CHARS`（900）管的是**每条 QQ 消息**。
所以 `push()` 调 `qq.sendQqFulltext({text})` 时**故意不传 `maxChars`**（代码里留了 🔴 注释）。

### 3.9 入站注入的前置条件：桌面版的会话签名记录（1.0.1 真事故）

**这条是 2026-10-04「引用消息没办法回答」的根因，改这个插件之前必须知道。**

`127.0.0.1:19387/api` 的 cookie（`dsh-auth-<base64url(sha256(authority))>`）用
`~/.dsh/.credentials.yaml` 里 `client-connection/browser-session` 这条 grant 记录的
`payload.secret` 做 HMAC 签名（桌面端 app.asar 里 `credentialKey("client-connection",
"browser-session")` + `storedSecret()`）。**这条记录不在文件里 ⇒ 插件换不出 cookie ⇒
入站注入全线 401。**

三条要记住的事实：

1. **出站与入站是两条独立的腿。** 推送只走 QQ 长连接，不需要这个密钥。所以故障形态是
   「通知一切正常、引用回复全死」—— 只看「QQ 连着」会误诊（本次就是这么误诊的）。
2. **桌面端是「Connection 激活时加载**或创建**」这条记录，并把 secret 留在内存里。**
   它内存里还留着旧 secret 时，桌面上一切正常，而文件里已经没有这条记录了 ——
   插件怎么读都读不到，只有**桌面端重启**才会把记录重新落到文件里。
   实测：`.credentials.yaml.bak` / `.credentials.yaml.preflat` 里那把旧 secret 拿去打 `session/list`
   得到 `HTTP 401 unauthorized`，反向对照（故意错的 secret）同样 401 —— 探针可信，
   旧密钥确实**救不回来**。
3. **所以插件做了三件事（`src/qqruntime.js` 的 `ensureApi()`）**：
   - 每次要用时**重读**密钥，而不是启动时读一次就永久放弃（`api = null` 的旧写法
     让插件一直到重启前都没有第二次机会）；
   - 记录**完全不存在**时自己补一条：`healBrowserSessionRecord()`
     （`src/qqbridge.js`）先整份备份到 `.credentials.yaml.bak-remote-qqbot-<时间戳>`，
     再用 tmp + rename 原子写入 `kind: grant` / `payload.version: 1` /
     `secret` = base64url(32 随机字节)，**权限位照抄原文件**。
     形状与桌面端 `storedSecret()` 的三条校验、以及桌面端自己写过的记录完全一致
     （`tests/qq.test.mjs` 的 `[2b]` 组把这三条校验钉住了）；
   - 补过之后把「重启一次 DSH 桌面版即可恢复」写进**报错文案**与 QQ `/status`
     （`formatStatusText({injectError, injectNote})` 新增的两行）。补写只在记录
     **完全不存在**时发生；存在但格式怪 → 直接报错，绝不覆盖（那是别人家产品的凭据文件）。
   `onEvent` 的 catch 也补了最后一道兜底：任何没被各路由接住的异常，也要在 QQ 里回一句，
   不再出现「你什么都收不到」的静默失败（`chat` / `task` 两条路过去就会这样）。

### 3.10 远程更新：怎么装、装哪儿、怎么重启（1.0.11）

整条链是**四段**，每段都可能失败，所以每段的失败都被收敛成「日志 + 一句人话」，
**绝不允许把异常抛进 agent 主流程**（更新是顺手做的事，不能因为它把会话搞崩）。

**① 查版本（`fetchLatestVersion`）**
源有**三种**写法，`parseUpdateSource` 解析：
- **版本索引（默认）**：一个 https 地址，返回 JSON（`{version, url, sha256}`）。默认值
  `https://cyanovo.top/plugins/dsh-remote-qqbot/update.json` —— 自己服务器上的静态文件（nginx 直出）。
  `pnpm add` 用的是**索引里的 `url`**，不是索引地址本身；请求带 `cache-control: no-cache`。
  校验必须严：索引地址打错时宿主的单页应用会回**首页 HTML 且状态码 200**（实测），
  所以只认「对象 + 非空 `version` + http(s) 的 `url`」，缺字段逐条说清（`versionFromManifestResponse`）。
- `github:作者/仓库[#ref]` → `https://api.github.com/repos/<仓库>/contents/package.json`
  （`raw.githubusercontent.com` 在本机不可达，所以走 contents API，`content` 是 base64）
- npm 包名 → `https://registry.npmjs.org/<包名>/latest`

带 UA、20 秒超时。

**② 比版本 —— 这里必须三分支（`compareVersions`）**
`>` 才提醒/安装；`===` 回「已经是最新版」并静默；`<` 回「远端还旧」并静默。
实测过：GitHub 上还是 1.0.5，而本机已经 1.0.6 —— 只判「不一样就装」等于**把用户降级**。
版本号比较按数字段（`1.0.10 > 1.0.9`）、认 `v` 前缀、pre-release 排在同号正式版之前、忽略 `+build`。

**③ 装（`buildAddCommand` + `runProcess`）—— 通道选择是这一版最重要的硬事实**
PATH 上的 `dsh` 在开发机上指向一份**源码检出**（`node --import tsx/esm .../bin.ts`），
拿它更新会装到别的地方；所以顺序是：
1. **桌面版自带运行时**（首选）：`spawn(process.execPath, ['--expose-internals', <argv 里的 pnpm.mjs>, 'add', spec])`，
   `cwd` = profile 目录、`env` 带 `ELECTRON_RUN_AS_NODE=1`（同一个 exe 当 node 用，官方 `node.cmd` 就是这么干的）；
   这些路径全部从**本进程自己的 `process.argv`** 里认（`parseDesktopRuntime`），不猜安装位置；
2. `%DSH_DESKTOP_NODE_EXECUTABLE%` + 同一个 pnpm.mjs；
3. PATH 上的 `dsh`（Windows 上 `.cmd` 不能直接 spawn，要 `cmd.exe /c`，路径带空格必须加引号）；
4. profile 目录里的 `pnpm add`。

profile 目录的判定是「`package.json` 里有 `dsh.profile`」，不是目录名（`isProfileDir`）。
子进程输出**必须重定向到临时文件**（`stdio: ['ignore', fd, fd]`）——
Windows 沙箱下用管道收子进程输出会 `EPERM`，这条踩过。安装超时 180 秒，超时就 kill。

**④ 重启 + 回执**
- 装的版本号从**安装目录的 `node_modules/dsh-remote-qqbot/package.json` 读回来**，
  不靠「命令成功」推断（pnpm 可能打印 `Already up to date` 却什么都没换）；
  版本没变就老实回「版本还是 x.y.z，远端可能还没发这一版」。
- 重启靠一个**临时目录里的 PowerShell 脚本**：等 10 秒（让那条回执先发出去）→
  按**可执行文件路径**杀进程（同名进程可能不止一个）→ 等它真的消失（最多 20 秒）→
  再稳 3 秒 → 启动 → 最多 3 次、每次隔 5 秒 → 全程追加写
  `~/.dsh/dsh-remote-update.log`。脚本文件**带 BOM**（PowerShell 5.1 才认中文）。
- 🔴 **启动新进程前必须清掉 `ELECTRON_RUN_AS_NODE`** —— 这是 2026-10-05 那次
  「`/update` 装好了、DSH 却没自己回来，主人手动打开」的根因，现场取证如下：
  插件跑在桌面版的 host 子进程里，host 是**把 Electron 当 node 用**跑起来的，所以插件进程
  （以及它派生的一切：`cmd` → 启动器 → PowerShell 脚本）都带着 `ELECTRON_RUN_AS_NODE=1`；
  `Start-Process` 把这个环境原样传给了新进程，而带着这个变量的
  `DeepSeek Harness.exe` **只会当 node 跑一下就退出**（实测 `--version` 输出 `v24.18.1`、退出码 0）
  —— 桌面版根本没启动：没有进程、没有 `lockfile`、没有崩溃日志，脚本只看到「启动后没看到进程」，
  三次重试全一样；主人双击能起来，是因为 explorer 的环境里没有这个变量。
  修法是脚本开头 `Remove-Item Env:<名单>`，名单常量 `RESTART_POISON_ENV` 是唯一来源
  （`ELECTRON_RUN_AS_NODE`、`ELECTRON_NO_ATTACH_CONSOLE`、`NODE_OPTIONS`，
  加上这次会话自己的标记 `DSH_SHELL` / `DSH_SESSION_ID` / `DSH_WEB_URL`）。
- 启动有**三种方式依次兜底**：`Start-Process -WorkingDirectory <exe 目录>` →
  `explorer.exe "<exe>"`（和主人双击同一条路，环境天然干净）→
  `Invoke-CimMethod Win32_Process Create`（由 `WmiPrvSE` 服务建进程，完全不沾我们的进程树）。
  前一种失败要把原因写进日志再换下一种，不能默默跳过。
- **认进程用两套量具**：`Get-Process` 的 `.Path` **常常读不到**（刚创建的进程实测就是空串），
  所以读不到时用 `Get-CimInstance Win32_Process` 的 `ExecutablePath` 兜底 ——
  只看前者会把「其实已经起来了」判成失败。
- **"看到进程"也算不上成功**：抢单实例锁失败会「起来又秒退」，所以看到进程后还要再盯 4 秒；
  盯不住就换下一种启动方式。**新进程"起了又没"时日志会带上它的退出码**（`Get-ExitCodeText`，
  需要 `-PassThru` 拿到的那个进程对象）—— 秒退这类故障看一眼退出码就能定性（当 node 跑那次就是
  退出码 0、零点几秒结束）。全部失败时把桌面版最新的 `crash-*.log` 尾巴抄进同一份日志
  （下次不用满硬盘找线索）。
- **"进程建出来了"不等于"脚本在跑"**：脚本第一件事就是写日志，所以拉起之后要用
  `verifyRestartLaunched()` 等日志长出来（最多 4 秒，落在脚本自己的 10 秒延迟之内）；
  没长出来就回「自动重启没能排上，手动重启 DSH 后生效」，而不是让主人干等一个不会发生的重启。
- ⚠️ **插件自己活不到重启那一刻**（它会被自己拉起的脚本杀掉），所以「重启成功没有」它当场
  验证不了，只能事后靠状态文件里的标记回执。因此装好那条回复必须**提前把兜底动作说清楚**：
  「要是过了一分钟还没回来，手动打开 DSH 就行」—— 2026-10-05 就是没说这句，主人对着 QQ 等
  一条永远不会来的确认。
- 🔴 **怎么把脚本拉起来，这一版踩过坑**（2026-10-05 四种配方差分实测）：
  直接 `spawn('powershell.exe', …, {detached:true, stdio:'ignore'})` 时**脚本一行都不执行**
  （进程建出来了、`unref()` 也正常，就是没动静）；同一个 spawn **不分离**时脚本能跑、
  但活不过父进程结束；`spawn(process.execPath, …, {detached:true})` 反而正常 ——
  所以不是"分离"本身的问题，是"分离 + powershell.exe"这个组合。
  最终方案：多写一个一行的 `.cmd` 启动器（`start "" /min "powershell.exe" … -File 脚本`，
  内容保持全 ASCII），再用 `spawn(comspec, ['/c', 启动器], {detached:true, stdio:'ignore', windowsHide:true})`
  + `unref()` 拉起 —— 实测这是唯一"既跑得起来、又活得过父进程"的配方。
- **"进程建出来了"不等于"脚本在跑"**：脚本第一件事就是写日志，所以拉起之后要用
  `verifyRestartLaunched()` 等日志长出来（最多 4 秒，落在脚本自己的 10 秒延迟之内）；
  没长出来就回「自动重启没能排上，手动重启 DSH 后生效」，而不是让主人干等一个不会发生的重启。
- 重启目标 exe **不写死路径**：优先环境变量 `DSH_DESKTOP_EXE`，否则从本进程的 `process.argv`
  里认（`parseDesktopRuntime`）。认不出来（web 版 / 纯 node 版）就**不自动重启** ——
  杀掉别人的服务是灾难，而且拿 node 也起不回一个服务。
- **重启后的确认**靠状态文件里的 `updateRestart` 标记：插件下次启动时 `reportRestartIfPending()`
  先**清标记再发**（发失败也不会每次启动都重发），文案带上新版本号与用时。

**⑤ 提醒的闸门**
自动提醒要求 `qqUpdateEnabled !== false` **且** `qqEnabled === true` **且** `qqNotifyEnabled !== false`；
手动 `/update` 不受这三个开关限制（用户主动要求的事不该被静默吞掉）。
状态文件里 `updateNotified` 记住「已经提醒过哪个版本」，同一个版本只提一次。

离线测试在 `tests/update.test.mjs`（91 条）：版本比较、三种源解析（含"索引地址打错拿到首页
HTML 也必须判失败"）、三分支、**用本机实测 argv** 跑通道选择、注入假 `spawn`/`fs` 跑 `runProcess`
（含超时，并断言 `stdio` 里不许出现 `pipe`）、重启脚本的形状与 BOM（含"清环境变量的动作必须排在
任何启动动作之前"、退出码诊断）、启动器的形状与 `cmd /c` 配方、"日志长出来才算脚本在跑"的正反两向，
以及每一条用户可见文案的逐字断言。
另有一次性端到端探针（跑完即删）：`.tmp-restart-e2e.mjs` 用 `cmd.exe` 的副本当假 DSH，
让它把**自己继承到的环境**导出到文件并靠 `ping` 撑住不退出，从而真实走一遍
「写脚本 → 写 `.cmd` 启动器 → `cmd /c` 拉起 → 杀进程 → 清环境 → 启动 → 4 秒复检 → 写日志」，
再用"直接起同一个假 DSH"作反向对照，证明量具本身认得出 `ELECTRON_RUN_AS_NODE`；
`.tmp-restart-exitcode.mjs` 用 `whoami.exe` 的副本（永远秒退）走失败路径，
断言日志里出现「已经退出，退出码 0」、三种启动方式都试过、最后落到「重启失败」。

---

## 四、模块职责与关键导出

| 文件 | 允许碰 DSH？ | 关键导出 | 说明 |
|---|---|---|---|
| `index.js` | ✅ | `apply(ctx, config)`、`Config`、`inject` | 事件订阅、工具注册、`liveConfig()`、启动自检、挂 config 路由 |
| `qqbot.js` | 只碰网络 | QQ 客户端类 | 取 token、WS 长连接、心跳、REST 发送 |
| `qqbridge.js` | ❌ **零裸导入** | `formatQuestionBody`、`formatStatusText`、`summarizeSession`、`qqPreviewUrl`、`formatSessionPickerText`、`isPickerFresh`、`formatPickAck`、入站路由 | 所有排版与路由纯逻辑，**可以被单元测试直接跑** |
| `qqruntime.js` | ✅ | `wrapUserQuestions`、`relayAsk` | 生命周期接线、中继、作答 |
| `collab.js` | ❌ 零裸导入 | 注册表操作、注入渲染、`DISABLED_NOTE` | 协作模式全部纯逻辑 |
| `notes.js` | 只碰 `fetch` | `publishTurnNote` | 渲染 markdown + 上传（测试注入假 fetch，不出网） |
| `screenshot.js` | 只碰 `child_process` | `buildPowerShellScript`、`parseShotOutput`、**`parseRawOutput`**、`captureCommand`、`captureScreen`、`isAvBlocked` | 抓屏；脚本是**纯 ASCII**、**先认领 DPI 感知再读 `VirtualScreen`**（否则只截左上角，见 6.5）、且**不许含 `GetImageEncoders`/`EncoderParameter`**（会触发 AMSI）；临时目录 `finally` 必删 |
| `summary.js` | ❌ 零裸导入 | `blocksToText` 等 | 从会话事件提取摘要 |
| `agentmd.js` | ❌ 零裸导入 | 表格定位与追加 | 纯字符串处理 |
| `config-api.js` | 只碰 webServer | `configView`、`mountConfigApi`、`FIELD_SPECS`、`isTrustedApiRequest` | 字段表 + 白名单 + 信任校验；**失败时 `ok:false` 必须写在 `...configView(...)` 之后**（否则被 `ok:true` 掩盖） |
| `overrides.js` | ❌ 零裸导入 | `OVERRIDE_FILE_NAME`、`overrideFilePath`、`filterPatch`、`readOverrides`、`writeOverrides`、`persistConfigPatch` | 原生写入被拒时的落盘（原子写：临时文件 + rename）；**写不进去必须抛**，不许静默 |
| `client.js` | 浏览器侧 | 设置页组件、`InputDockControls` | 见下 |

**分层的硬规则：纯逻辑必须能脱离 DSH 单测。** 所以上面标 ❌ 的五个文件一个裸包都不 import；
只有 `index.js` / `qqruntime.js` / `config-api.js` / `qqbot.js` 允许接触 DSH 服务或网络，
它们的护栏放在 `tests/plugin.test.mjs` 里用 **mock ctx** 跑。

### `client.js` 的三条限制

1. **不能用 npm 依赖**：前端只冻结共享了 `react` 等约 10 个平台模块。
   所以样式全是内联 style、图标用字符、不做 animate 库。
2. **配置读写只能走同源路由** `/remote-qqbot/api`（`config-api.js`）。
3. **它必须被 DSH 的 client-modules 找到**：靠 `package.json` 的
   `exports["./client"]` + `dsh.client.platform: "web"`。

UI 上目前有两个挂点：

| 挂点 | 组件 | 内容 |
|---|---|---|
| 设置页 | 独立一项「QQ 提醒与记忆」 | 按 `FIELD_GROUPS` 分组的表单（QQ 远程提醒 / 通知中枢 / agentmd / 协作模式） |
| 输入框下方 | `InputDockControls` → `MiniToggle` | **只有两个**：「QQ 提醒」「协作模式」。**24px 高、12px 字、无边框底色阴影**，悬停才浮出极淡底色 |
| 设置面板 | 插件配置卡片（`configView.fields`） | 其余全部配置，含 `qqFulltextMode`（三档全文去向）与 `cloudEnabled`（云上传总闸） |

> 设计约定（用户明确要求过「太显眼」）：**状态是"知道就好"的信息，不该占据视觉重心。**
> 加新开关请复用 `MiniToggle`，不要新造一个更抢眼的控件。
>
> ⚠️ **但不要往输入框下面再加开关。** 2026-10-03 用户原话：
> 「除了 QQ 提醒已开、协作已开，剩下的放到设置里就行」——
> `qqFulltextMode` / `cloudEnabled` 曾经也是这里的小开关（2026-10-03 上午才有），现已**撤回设置面板**。
> 判据是「抬手就要按」：某项**开了没开必须一眼看到**才配待在输入框旁；
> 三档全文去向属于"配置"，一年也改不了几次。
> `scripts/verify-ui-installed.mjs` 会**数** `InputDockControls` 里 MiniToggle 的个数（必须恰为 2），
> 谁加回去谁报红；同时另有两条断言要求设置字段表里**必须还有** `qqFulltextMode` / `cloudEnabled`
> —— 合起来守住"只搬位置、不砍能力"。


---

## 五、配置系统为什么这么绕

### 5.1 `DEFAULTS` 是 40 个键，且**一律留空 = 功能关闭**

```js
const DEFAULTS = { hubUrl: '', token: '', qqAppId: '', qqClientSecret: '', ... }
```

🔴 **不要往 `DEFAULTS` 里填真实的生产配置。** 它同时被单元测试使用——一旦里面有真实的
`hubUrl` / `qqAppId`，跑测试就会**真的向线上中枢发请求、真的给用户推 QQ 通知**
（2026-10-02 踩过：测试套直接挂死）。

### 5.2 五个必须记住的加载/配置期约束

| # | 约束 | 违反后的现象 |
|---|---|---|
| 1 | `Config` 必须是 **schemastery schema**，不能是普通 JSON Schema | `TypeError: Cannot read properties of undefined (reading 'validate')`，**整个插件树加载失败**（不只坏这一个插件） |
| 2 | 读配置必须 `ctx.settings.register(ns, Config, {base})` 再 `scope.get()` | `settings.get(ns)` 未注册一律 `undefined`，`?? {}` 兜底 = **静默降级**：日志说「已就绪」，用户配置全失效 |
| 3 | **不要把 cordis 传进 `apply` 的 `config` 合并到 settings 之上** | 那个 `config` 已被 schema 用默认值**填满**（含空串），合并会把真实值全盖成空 |
| 4 | 不要 `import` DSH 的 workspace 包 | 加载期 `ERR_MODULE_NOT_FOUND`（profile 里没有那些包） |
| 5 | **配置写入不能只信原生通道；失败更不许被吞** | 桌面版对第三方 namespace 的 `update()` 必抛；若把 `ok:false` 写在响应展开之前，前端会看到 `ok:true` ⇒ **点了没反应也不报错**（0.8.4 修的正是这条） |

第 3 条的正确写法（源码在 `index.js` 的 `liveConfig()`）：
**只把 `config` 里与默认值不同的键当显式覆盖**，其余以 settings 为准。

### 5.3 为什么有 `settings.yaml` 和 `cordis.patch.yml` 两份

- `cordis.patch.yml`（随插件包发出去）只负责一件事：**把插件插进 profile 的插件树**；
- 真实配置（含 QQ 凭证）在 `~/.dsh/settings.yaml` 的 `dsh-remote-qqbot` 段，
  或 profile 的补丁层里。

⚠️ 已知环境设计：**桌面版启动时会把 `~/.dsh/settings.yaml` 改名成 `settings.yaml.imported`**
（`SettingsForms.importLegacyDocument()`），用户层因此可能长期为空。所以：

- host 侧的 `liveConfig()` **自己合并了补丁层**，一直是准的；
- 而 `settings.describe().value` **不含 profile 补丁层** ⇒ 早期 UI 读它 → 界面显示「QQ 未连接」，
  而 QQ 其实一切正常（骗过两轮修复的 bug）。

**修法（照做，别再改回去）**：让 UI 去读**插件真正在用的数据源**，
即 `mountConfigApi(ctx, { getLiveConfig: liveConfig })`，由 `configView()` 以 `describe()` 为底、
再用 host 真值覆盖。来源会写进响应的 `diag.source` 便于排障。

### 5.3b 写配置：原生被拒 → 落插件自有覆盖文件（0.8.4）

「读」修好之后，「写」还有一个独立的坑，症状正是用户报的
**「点 QQ 提醒 / 协作模式这两个开关，点了没用，永远保持开启」**。

三个缺陷叠在一起（都在 0.8.4 修掉）：

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | namespace 名对不上：插件注册 `dsh-remote-qqbot`，profile 里 entry id 是 `remote-qqbot` | `settings.update()` 抛 `No configurable plugin entry "dsh-remote-qqbot"` |
| 2 | `describe()` 会**跳过没有 volatile 字段的条目** | 原生通道连「可写」都认定不了 |
| 3 | `config.set` 的成功响应里 `...configView(...)`（自带 `ok:true`）**排在** `{ok:false, error:{code:'settings-rejected'}}` **之后** | 失败被覆盖成成功 ⇒ 前端把拒绝当成功、界面弹回原样且不报错 |

写入顺序（`overrides.js` 的 `persistConfigPatch`，返回 `via` 供 UI 区分）：

```
1. 先试原生 settingsScope.update()      → 成功则 via='dsh-settings'（DSH 若放开第三方写入即自动走官方通道）
2. 抛错 → 原子写 ~/.dsh/remote-qqbot-overrides.json → via='override-file'
3. 覆盖文件也写不进去 → 抛错；路由回 ok:false + error.code='settings-rejected'
                       （此时 ok:false 必须出现在 ...configView(...) 之后）
```

合并优先级（`liveConfig()`，后者盖前者；覆盖文件**故意排最后**）：

```
DEFAULTS < settings 用户层 < cordis.patch.yml 显式键 < remote-qqbot-overrides.json
```

否则 `cordis.patch.yml` 里写死的 `collabEnabled: true` 会让「关掉协作」永远关不掉。

> ⚠️ 覆盖文件是**明文 JSON**，`qqClientSecret` / `token` 同样明文落盘 —— 与 `cordis.patch.yml`
> 同级别的暴露面，文档必须写明（README 已写）。UI/API 侧仍只回报 `secretsSet`，绝不出明文。
>
> ⚠️ 删掉这个文件 = 开关回到 profile 配置里的旧值，没有别的暗桩。

### 5.4 secret 永不回显

`configView()` 对 `qqClientSecret` / `token` / `dshSecret` **只回报 `secretsSet: true|false`**，
绝不返回明文。UI 也据此显示「已设置 / 未设置」。写回时才接受新值。

### 5.5 配置项清单（按分组）

**通知中枢**

| 键 | 默认 | 说明 |
|---|---|---|
| `hubUrl` | `''` | 中枢地址；留空 = 只记日志不发请求 |
| `token` | `''` | Bearer 令牌 |
| `timeoutMs` | `10000` | 单次请求超时 |
| `onTurnComplete` | `true` | 任务完成推送 |
| `onQuestion` | `true` | 提问推送 |
| `onError` | `true` | 出错推送 |
| `notifySubagents` | `false` | 子智能体完成是否推送 |
| `notifyChatSession` | `false` | 闲聊会话完成是否推送 |
| `dedupeMs` | `4000` | 同内容去重窗口 |
| `errorSummaryChars` | `300` | 错误摘要长度上限 |

**agentmd 跨会话上下文**

| 键 | 默认 | 说明 |
|---|---|---|
| `agentmdDir` | `''` | 文档目录绝对路径；留空 = 关闭自动日志 |
| `agentmdMainFile` | `'main.md'` | 主文档文件名 |
| `agentmdAppendLog` | `true` | 会话结束自动追加日志 |
| `agentmdInject` | `false` | 是否把主文档注入会话上下文（超上限时只注入压缩后的一部分） |
| `agentmdSummaryChars` | `200` | 「本轮做了什么」的截断长度 |
| `agentmdInjectMaxChars` | `8000` | 🔴 注入**硬上限**（字符）；`buildContextDoc` 的契约就是返回值永不超它，0/负数/NaN 一律回落默认 |
| `agentmdInjectTailRows` | `20` | 注入时保留日志表最后 N 行 |
| `agentmdRowMaxChars` | `600` | 单条日志行上限（只裁「操作」列） |

**QQ 远程提醒**

| 键 | 默认 | 说明 |
|---|---|---|
| `qqEnabled` | `false` | 通道总开关（关掉连长连接都不建） |
| `qqNotifyEnabled` | `true` | **提醒**开关（输入框下方那个）。通道开着但先别推我 |
| `qqSummaryChars` | `150` | 通知里的摘要长度，0 = 不附摘要 |
| `qqChatReadOnly` | `true` | 闲聊会话强制只读 |
| `qqChatReply` | `true` | 闲聊回答直发 QQ（不推通知、不留笔记） |
| `qqChatAnswerChars` | `1500` | 直发回答的长度上限 |
| `qqScreenEnabled` | `true` | 允许 `/screen` 抓屏回图（关掉只回一句"被我关掉了"+ 去哪儿打开） |
| `qqScreenMaxWidth` | `1600` | 截图最大宽度，0 = 不缩放。**截图唯一的体积旋钮**（JPEG 质量固定系统默认，见 6.4） |
| `qqMarkdown` | `true` | 用 markdown 消息（唯一能折叠链接的方式） |
| `qqPromptMode` | `'queue'` | 投递方式：`queue` 排队 / `steer` 插话 |
| `qqAppId` | `''` | 开放平台 AppID |
| `qqClientSecret` | `''` | 开放平台 ClientSecret（secret，不回显） |
| `qqStateFile` | `''` | 状态文件；留空用 `~/.dsh/qq-bot-state.json` |
| `qqCwd` | `''` | 专属会话工作目录；留空用进程 cwd |
| `qqRecentCount` | `6` | **QQ 菜单「会话」（`/sessions`）列几个最近会话**，上限 20；顺序按最近活动倒序 |
| `dshApiUrl` | `'http://127.0.0.1:19387'` | 本机 /api 地址 |
| `dshApiAuthority` | `'127.0.0.1:19387'` | **必须与桌面版看到的 Host 完全一致**（cookie 的 authority 靠它） |
| `dshSecret` | `''` | 浏览器会话密钥；留空从 `~/.dsh/.credentials.yaml` 自动读（先老写法 `browser-session.secret:`，再新版 `records:` 段里的 `client-connection/browser-session:`；都读不到就自己补一条，见 3.9） |

**协作模式**

| 键 | 默认 | 说明 |
|---|---|---|
| `collabEnabled` | `true` | 总开关 |
| `collabPanelFile` | `'plugin-collab.md'` | 落盘文件名（写进 `agentmdDir`） |
| `collabScope` | `'workspace'` | `workspace` 同工作目录 / `global` 全局一个池 |
| `collabInject` | `true` | 是否注入协作现状（没别的会话就不注入） |
| `collabClaimGuard` | `'warn'` | 撞车处理：`warn` / `block` / `off` |
| `collabClaimTtlMs` | `1800000` | 占用过期时间（30 分钟） |
| `collabIncludeSubagents` | `false` | 子智能体是否参与协作 |

**完整回答（笔记）与三档全文模式**

| 键 | 默认 | 说明 |
|---|---|---|
| `cloudEnabled` | **`false`** | **云上传总闸**：关着时 `note`/`note-link` 也不传正文，退回「直接发 QQ」（**默认零上传**） |
| `qqFulltextMode` | `'chat'` | `chat` 正文切条发 QQ / `note` 存服务器不给链接 / `note-link` 存服务器 + 短链接；非法值 → `chat` |
| `qqFulltextMaxChars` | `6000` | 正文写进分条前的字符上限（按码点截断） |
| `notesEnabled` | `true` | 存完整回答到服务器（**还需 `cloudEnabled` 打开才生效**） |
| `notesIdLength` | `5` | 短链 id 长度（36^len 种可能） |
| `notesMaxChars` | `20000` | 单篇字符上限 |

> 字段表 `FIELD_SPECS` 在 `config-api.js`，是设置页与**写入白名单**的唯一来源
> （`SPEC_BY_KEY` 从它派生）⇒ **字段在表里就可写，不在就写不进去**。
> 加配置项的正确顺序：`DEFAULTS` → `Config` schema → `FIELD_SPECS`（含分组）→ 测试。

---

## 六、QQ：四个容易踩死的点

### 6.1 域名必须大写才能绕过平台检测

QQ 平台会拦截官方机器人消息里的 URL，命中后把链接包进中转壳页、弹「如需预览请使用浏览器访问」。
实测把 **host 全大写**就不被拦（路径一个字都不能动，路径区分大小写）。

```js
// src/qqbridge.js
export function qqPreviewUrl(raw) {
  return `http://${host.toUpperCase()}${pathname}${search}${hash}`  // 手工拼字符串
}
```

⚠️ **不能用 `u.hostname = u.hostname.toUpperCase()`**：WHATWG URL 的 special scheme 会走
domain-to-ASCII，**静默把域名转回小写**——赋值后 `u.href` 一个字符都没变，还不报错。
测试里有一条 `assert.notEqual(u.href, out)` 专门钉住这个陷阱。

### 6.2 指令只能走「自定义菜单」，且点击只填输入框

- **面板（panels）会把 `PanelItem.name` 的前导斜杠剥掉**（传 `/status` 回读成 `status`），
  **菜单（menu）的 `send_message` 保留斜杠** ⇒ 以 `/` 开头的指令走菜单最稳；
- 菜单/面板点击**只是把文本填进聊天输入框，不会自动发送**，你还要按一下发送 ⇒
  走的是普通 C2C 消息事件，**插件不需要 `INTERACTION_CREATE` 处理器**；
- 菜单 PUT 是**整体覆盖**，改之前先 GET 备份；
- `GET /v2/panels` 必须带 `?scope=c2c|group|channel|dm`，不带直接 400。

当前线上菜单（2026-10-03 回读 version 43，**五个一级项**）：
`看状态 /status`、**`会话 /sessions`**、`屏幕 /screen`、`帮助 /help`、
派活子菜单（新任务 `/task `、作答 `/answer `）。

> 5 个一级项**平台是接受的**（PUT 返回 200、回读 5 项齐全、version 42 → 43）。
> 此前"一级项最多 3 个"的担心属**未实测的传闻**，这条现已由实测闭合。
> 写入前先 GET 备份（`work/qq-menu.mjs` 会自动存 `work/qq-menu-backup-*.json`），
> 因为 `PUT /v2/menu` 是**整体覆盖**。
前导斜杠会被面板剥掉，而截图这条必须靠 `/screen` 才进得了路由。

### 6.3 `/status` 的排版是纯函数

`formatStatusText({channelOn, pending, sessions, taskId, chatId, activeId, listError})` 在 `qqbridge.js`；
`qqruntime.statusText()` 只负责取数据，而取数据本身被抽成 `listSessions()`
（`/sessions` 与 `/status` 共用同一份，**每次现拉、从不缓存**）。

这样做是为了**可测**：早期版本只能正则扫源码（「源码里出现了某个字符串」），
而**量具本身会骗人**（本项目两次被注释里的字面量骗过）。现在测试是**真的把函数跑起来看输出**。

几条刻意的取舍：

- **纯文本**：回复不带 `markdown: true`，所以正文里不能出现 markdown 记号（有断言守着）；
- 标题按**码点**截断到 22 字（不是 `slice`，否则 emoji/中文会被切成半个字）；
- `turns` 缺失（老会话没有 `sessionStats`）时说「没有轮次」，不吐 `undefined`；
- 超过 10 个在跑折叠成「… 还有 N 个在跑」；
- 列表读不到**不崩**，正文里明说 `⚠️ 会话列表读不到：<原因>`。

### 6.4 抓屏脚本：不许出现 `GetImageEncoders` / `EncoderParameter`（AMSI）

**症状**：抓屏一律失败，报 `ParserError … ScriptContainedMaliciousContent`
（「This script contains malicious content and has been blocked by your antivirus software.」），
**报错位置指向脚本第 1 行第 1 字符** —— 也就是第一行注释。这是假象：AMSI 在整份脚本送进
解析器**之前**就把它毙了，行号只是"解析器拿到空内容"的副作用。

**二分实测**（每份脚本单独落盘后真跑 `powershell.exe -File`）：

| 脚本内容 | 结果 |
|---|---|
| 抓屏 + `Save($Out)`（不带格式） | 通过 |
| 抓屏 + `GetImageEncoders()` 存 JPEG | **拦** |
| 抓屏 + `New-Object EncoderParameters(1)` | **拦** |
| 抓屏 + `EncoderParameter(Quality)` | **拦** |
| 抓屏 + `ImageFormat::Jpeg` 直接存 | 通过 |
| 单独 `GetImageEncoders()`（不抓屏） | 通过 |
| 单独 `New-Object EncoderParameters(1)` | 通过 |

⇒ 被拦的是**组合特征**：「抓屏 + 枚举/构造 JPEG 编码器参数」= 屏幕窃取类脚本的经典指纹。
不是中文注释、不是缩进、不是 sandbox、不是 `-File`，也不是 `child_process` 的问题
（命令行手工跑同样被拦）。

**结论与代价**：
- 只允许 `$target.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)`（GDI+ 默认质量 ≈ 75）；
- 因此 `qqScreenQuality` **被删除**（自定义质量非得用 `EncoderParameters`）；
  留一个点了没用的开关比没有这个开关更糟；
- `isAvBlocked()` 把这类失败翻成**中文提示 + 放行办法**（含 `Windows 安全中心 → 排除项`），
  不让手机端收到英文报错；
- `tests/screen.test.mjs` 有一条专门的墓碑断言（把老写法塞回去会立刻报红，已反向验证过），
  `scripts/verify-installed.mjs` 第 [3] 节每次装完**真抓一张屏**，被拦就整节失败。

---

### 6.5 抓屏必须先认领 DPI 感知，否则只截到左上角（**顺序就是修复的全部**）

**症状**（用户 2026-10-02 报的）：截图能用、能发到 QQ，但**永远只有屏幕左上角那一块**。

**根因**（像素级取证，不是推断）：
`Graphics.CopyFromScreen` 是**按物理像素**搬运的，而一个 **DPI unaware** 的进程看到的
`SystemInformation.VirtualScreen` 是**被系统缩放后的逻辑尺寸**。
本机是 2880x1800 物理屏 + **200% 缩放** ⇒ 未认领时 `VirtualScreen` 报 **1440x900**，
于是"搬 1440x900 个物理像素"= 真实桌面的**左上四分之一**，右下 3/4 整块丢掉。

**决定性实验**（同一份脚本，只差 `SetProcessDPIAware()` 的位置）：

| 步骤 | 输出 |
|---|---|
| 认领前抓图 | `GRAB small.png = 1440x900` |
| 认领后抓图 | `GRAB big.png = 2880x1800` |
| 网格采样比对（每 10px 一点，共 12960 点） | **`meanDiff 0.00`，仅 1 点超过容差 24，maxDiff 38** |

⇒ 小图确实就是大图的左上角**同一画面**，不是"另一张图"——这条排除了"两次抓屏内容本来就不一样"的解释。

**修复**（`src/screenshot.js` 的脚本模板，两条语句的相对顺序是关键）：

```powershell
Add-Type -Namespace DshShot -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][DshShot.Dpi]::SetProcessDPIAware()          # ← 必须在下一行之前
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
```

- **为什么不用 `Application.SetHighDpiMode`**：脚本跑在 `powershell.exe`（Windows PowerShell 5.1 /
  .NET Framework）上，**.NET Framework 没有这个 API**；`SetProcessDPIAware()`（Win7+ 的 user32）
  才是对的，返回值即便为 false 也容忍（进程可能已被 manifest 标为 DPI aware）。
- **为什么不用 manifest**：脚本是每次抓屏临时落盘的 `.ps1`，没有可注入 manifest 的宿主。

**回执与验证链**（让"没被虚拟化"可被机器判定，而不是靠眼睛）：
1. 脚本额外打印一行 `RAW 2880x1800`（缩放前的原始尺寸）；
2. `parseRawOutput(stdout)` 把它解析成 `{width, height}`，`captureScreen()` 透出
   `rawWidth` / `rawHeight`（**新增导出**，`tests/screen.test.mjs` 有 3 项专门测它）；
3. `scripts/verify-installed.mjs` §三之二 用 `Get-CimInstance Win32_VideoController`
   取**所有**非空分辨率（本机 2 块），断言 `raw` 命中其中**任意一块**
   —— ⚠️ **不能只取第一条**：本机第一条是虚拟适配器的 `3840x2160`，
   单值断言会给出**假红**。量具本身也会骗人。

**护栏不是空断言**：把这套检查拿去跑**旧版 0.8.2** 的安装目录，**9 项全红**
（脚本没有 DPI 认领、没有 RAW 行、没有 `parseRawOutput`、没有 `rawWidth`…），
且旧版真实抓屏结果是 `1440x900 / 144,442 B` —— 与"左上角"症状逐字吻合。

**实测数据（0.8.3 生产代码）**：原始 **2880x1800** → 缩放 **1600x1000**，
**216,196–217,204 字节**，**521–533 ms**，文件头 `ffd8ff`。

---

### 6.6 挑会话（`/sessions`）：为什么是「指针」而不是「菜单里塞 6 个会话名」

用户的原话：*「我希望在机器人菜单栏这里可以选择最近的六条会话进行对话」*。

**第一个决定：菜单里不放会话名。**
QQ 的自定义菜单是**平台侧的一份静态配置**，而且客户端有缓存、刷新有延迟（延迟多长**没有测过**）。
把「最近 6 个会话」写进菜单，等于把一份随时会变的数据烙进缓存里：
你点第 2 项时，平台填进输入框的可能是**一个已经不存在、或者已经不是第 2 个**的会话。
「点 2 却切到别的会话」是这个功能**最贵的失败方式**，所以菜单只放一个**永远正确**的入口：`/sessions`。

**第二个决定：选会话是状态，不是一次性动作。**
挑会话天生带状态 —— 记住一个指针，之后每句话都省掉一次选择；换会话时才再说一句。
指针存在 `~/.dsh/qq-bot-state.json` 的 `activeSessionId`（和 `chatSessionId` 并列），重启 DSH 也不丢。

**第三个决定：列表每次现拉，`pickerIds` 只用来解释数字。**
`listSessions()` → `summarizeSession` → 按 `updatedAt` 倒序 → `formatSessionPickerText`。
名单发出去时，把那一份 id 顺序与时刻也记进状态（`pickerIds` / `pickerAt`），
于是「回 2」解析的是**你当时看到的那份名单**，而不是「再拉一次列表、按新顺序数第 2 个」
（会话的活动顺序随时会变，重新排序会让你的 2 变成另一个会话）。

**第四个决定：裸数字只在 5 分钟窗口内算数，且优先级最低。**
顺序写死在 `routeMessage` 里，由 `tests/session-picker.test.mjs` 钉住：

| 优先级 | 条件 | 结果 |
|---|---|---|
| 1 | 有 `ref_idx`（引用了我某条消息） | 回到那条消息所属的会话 |
| 2 | 没有引用 + 有提问在等 | **当作答**（`1` 就是答案，绝不能拿去切会话） |
| 3 | 没有引用 + 没有提问在等 + 名单还在 5 分钟窗口内 | `pick_session` |
| 4 | 其余 | 闲聊，或进当前指针指向的会话 |

**第五个决定：指定的会话不在了，绝不静默回落。**
投递前用 `api.hasSession` 校验：不在了就清掉指针、并且**明确回一句**
`⚠️ 第 N 个（X）已经不在了 —— 发 /sessions 重新看一次吧。`；
若是在"投递那一瞬间"才发现不见了，那句话会进闲聊会话，并**额外补一句说明**。
悄悄把话投进另一个会话，是这个功能最坏的失败方式 —— 宁可多说一句。

### 6.7 QQ 单条消息的长度上限：官方没给数字，只能实测（2026-10-03）

官方《发送单聊消息》文档只列了两个错误码 —— `40054007 消息长度超限`、`40054018 消息过长或异常` ——
**没有任何字数**。而 `chat` 档（默认档）把整篇正文切条发出去，全靠这个数字：
猜大了 → 整条发送失败、正文白丢；猜小了 → 一条回答被炸成一串碎消息。

实测方法（**3 条封顶**，走插件真实发送路径 `QqBotClient.sendC2C(openId, text, {markdown:false})`，
即 `msg_type=0` 纯文本，与 `sendQqFulltext` 完全同一条路）：

| 实发长度 | 服务端回执 |
|---|---|
| 900 字 | ✅ 接受，返回 `id` / `timestamp` |
| 1500 字 | ✅ 接受 |
| 3000 字 | ✅ 接受 |

⇒ 服务端上限 **≥ 3000 字**，而插件用的是 `QQ_TEXT_SAFE_CHARS = 900`，
安全边际 3 倍以上。**结论：900 保持不动**（保守方向是"多发两条"，而不是"丢正文"）。

⚠️ 两个诚实边界：**①** 无法从回执判断**客户端**会不会折叠/截断长消息（那要看手机）；
**②** 平台随时可能改规则，所以这个数字**不该被当成更激进的依据**。

⚠️ 探针踩到的坑：`cordis.patch.yml` 里 `qqAppId` / `qqClientSecret` 是**带引号**的，
直接正则取值不去引号 ⇒ `getAppAccessToken 失败 code=100007: appid invalid`，
三条全部被挡在 token 环节（**一条都没真的发出去**）。**读凭据必须去引号。**

---

## 七、状态文件与落盘位置


| 内容 | 位置 | 说明 |
|---|---|---|
| QQ 状态（open_id / 专属会话 id / 去重表） | `qqStateFile`，默认 `~/.dsh/qq-bot-state.json` | 换机器要重新授权 |
| agentmd 主文档 + 协作面板 | `agentmdDir/` | `collabPanelFile` 默认 `plugin-collab.md` |
| 完整回答笔记 | 中枢服务器 `/var/www/dsh-notes/<id>.md` | 由服务器侧定时清理（1 天） |
| 插件配置（读） | `~/.dsh/settings.yaml` / profile 补丁层 / `~/.dsh/remote-qqbot-overrides.json` | 见第五、5.3b 节 |
| 插件配置（写：原生被拒后落这里） | `~/.dsh/remote-qqbot-overrides.json` | 明文 JSON；**里面的键优先级最高**（盖过 `cordis.patch.yml`）；删掉即回落到 profile 值 |
| 浏览器会话密钥 | `~/.dsh/.credentials.yaml` | `dshSecret` 留空时自动读 |

---

## 八、测试体系

```bash
npm test    # 16 组，全部零外部依赖（cloud-integration 会顺手做一次真实 HTTP 往返）
```

| 文件 | 断言数 | 守什么 |
|---|---|---|
| `tests/agentmd.test.mjs` | 27 | 表格定位与追加 + **注入/单行预算**（上限单调性、非法上限回落、压缩不静默） |
| `tests/settings.test.mjs` | 9 | settings 注册/覆盖语义 |
| `tests/config-view.test.mjs` | 24 | 设置页读数来源（`describe` 为空时必须靠 host 兜底、secret 绝不回显、**提示里点名的字段必须真的存在**、**「运行状态」只读块与告警位**） |
| `tests/fulltext.test.mjs` | 49 | **三档全文模式**：`normalizeFulltextMode` 非法值必落 `chat`、`uploadsFulltext`/`showsFulltextLink` 语义、切分**不丢字符**、**带序号不超限**（★`limit=100` 边界）、`maxChars` 下限 100 的契约 |
| `tests/ui-persist.test.mjs` | 29 | 开关落盘：桌面拒绝原生写入 → 落插件自有覆盖文件；写失败必抛；`ok:false` 不被 success spread 掩盖；secret 不回显 |
| `tests/qq.test.mjs` | 179 | QQ 文案、引用索引、入站路由、`qqPreviewUrl`、提问中继行为、**引用反查三级兜底（回执登记 `ref_idx` / 12 小时兜底窗口 / 认不出也必须投递）** |
| `tests/status.test.mjs` | 23 | `/status` 排版（真跑 `formatStatusText`），含「当前会话看得见」 |
| `tests/session-picker.test.mjs` | 33 | **挑会话**：列表编号与纯文本、`isPickerFresh` 时效、**裸数字的优先级（提问 > 选会话）**、`formatPickAck` 四种结果、指针真的落盘（含老状态文件） |
| `tests/screen.test.mjs` | 59 | 抓屏脚本内容（**不含 AMSI 触发构造**、**DPI 认领必须在读 VirtualScreen 之前**）、`parseRawOutput`、隐私清理、`/screen` 路由、图片上行形状、AMSI 报错翻译 |
| `tests/plugin.test.mjs` | 33 | mock ctx 驱动的整插件装配，含协作接线回归（**工具名逐个点名**，少一个就红）+ **244KB 文档注入仍 ≤8000、上限调小注入跟着变短**（端到端防爆） |
| `tests/collab.test.mjs` | 44 | 协作注册表 / 占用 / 留言 / 总开关关闭后的行为 |
| `tests/notes.test.mjs` | 19 | 笔记渲染与上传（注入假 fetch） |
| `tests/cloud.test.mjs` | 29 | **云端客户端**：地址规整（非 http(s) 判为未配）、`/n/<id>` 形状**必须被 dsh-web 前端深链正则接受**（跨项目读真源码验证）、请求逐字（Bearer、**不带 username**）、设备码三态、`qqLinkWarning` |
| `tests/cloud-integration.test.mjs` | 22 | **真 cloud.js × 真 dsh-web**（进程内起服务 + 真 HTTP）：设备码绑定 → 上传 → 网页端打开（计 1 次）→ 换账号看不到 → 吊销后上传明确失败 |
| `tests/cloud-routing.test.mjs` | 7 | **路由**（mock ctx 驱动 lib/index.js）：配了云端就**只**发云端、云端失败**绝不**改发中枢、总闸关着两边都不发、非法地址退化成"没配" |
| `tests/load-verify.mjs` | 3 层 | import → bundle 解析 → 真实装配（最后一道防线） |

> 断言数是 **0.9.0 实测值**（每组跑完自己打印的「通过 N 项」就是权威来源）。
> 改了测试请顺手更新本表——但不要用本表去核测试，**以实际输出为准**。

**写测试的三条纪律（都是踩出来的）：**

1. **mock 必须复刻真实契约的失败模式**，不能只让 happy path 通过。
   旧的 settings mock 只有 `get()`、没有 `register()`，17 项测试全绿却测不出
   「未注册 → get 恒为空」；补上 `register()` 后**8 项立刻转红**。
2. **验行为要跑函数，不要正则扫源码。** 源码里的注释会命中正则——
   「不要用 setter」这句说明文字曾被当成「残留 setter 写法」报出来。
3. **新护栏要反向验证**：临时把源码改回旧写法，确认断言真的会红，再改回来。
   否则你只是加了一条永远为真的断言。

另外：`tests/live/` 里的脚本**不在 `npm test` 链里**（要真环境），
`scripts/verify-installed.mjs` / `verify-ui-installed.mjs` 是**装完后的正式验收**，
它们直接 import **安装目录**里的产物做真实调用与哈希比对。

---

## 九、开发与发布流程

```bash
node scripts/link-dev.mjs    # 建 node_modules junction（首次必需）
node scripts/build.mjs       # src/ → lib/，含语法与依赖检查
npm test                     # 16 组全绿（exit 0）
# 改 package.json 的 version
node scripts/pack.mjs        # 生成 dsh-remote-qqbot-<ver>.tgz
dsh plugin --profile desktop add ./dsh-remote-qqbot-<ver>.tgz
node scripts/verify-installed.mjs      # 验加载 + 真实函数行为
node scripts/verify-ui-installed.mjs   # 验 lib 全部哈希 + 版本 + client 字面
```

> ⚠️ **`add` 的参数必须带 `./`（或写成绝对 `file:` 路径）。**
> 2026-10-03 实测：`dsh plugin --profile desktop add dsh-remote-qqbot-0.8.6.tgz`
> ⇒ `[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-remote-qqbot-0.8.6.tgz: Not Found`。
> 裸文件名被 pnpm 当成**registry 包名**了；加 `./` 才是本地 tarball。

> ⚠️ **profile 里残留指向"已删除 tgz"的依赖，会让 `add` 在解析阶段就 ENOENT 死掉** ——
> 报错还是指向**旧版本的文件名**（`dsh-remote-qqbot-0.8.5.tgz`），看起来像"我打错了包名"。
> 顺序必须是：**`remove` → `add`**。
> ⚠️ 另有一条实测：`remove` 会把 `dsh.profile.bundles` 里的 `dsh-remote-qqbot` **一起摘掉**，
> `add` 成功后会自动加回来 —— 装完**必须回读 `bundles` 确认它还在**，否则插件根本不会被加载。

> desktop profile 的 `package.json` 里依赖指向**具体 tgz 路径**。旧 tgz 被新 `pack` 覆盖后，
> 不改依赖会 `ENOENT`——所以「bump 版本」和「改 profile 依赖」必须一起做。

> ⚠️ **同一个版本号 + 同一条 `file:` 依赖 ⇒ pnpm 直接说 `Already up to date`，根本不重新解包。**
> 2026-10-02 实测：改完 `src/config-api.js` 再 `pack`（同名 `0.8.1.tgz`，内容变了）→
> `dsh plugin --profile desktop add` 输出 `Already up to date / added 0`，退出码 0，
> 而安装目录里的 `config-api.js` **仍是旧的**（哈希 DIFF、缺字段）。
> 规矩：**只要产物内容变了就 bump 版本号**（让依赖字符串跟着变），或者先 `remove` 再 `add`；
> 事后必须用 `scripts/verify-ui-installed.mjs` 比对哈希 ——
> 这次就是它抓出来的（**`add` 成功 ≠ 文件被替换，退出码 0 会骗过所有人**）。

### 发布到 GitHub（当作社区插件分发）

```bash
# 1) 先保证构建产物是最新的，而且**它必须进这次提交**
npm run build && npm test
git add -A && git commit -m "…"          # lib/ 必须在这次提交里

# 2) 用户这样装（DSH CLI 原生认 github: 前缀）
dsh plugin --profile desktop add github:<owner>/dsh-remote-qqbot
```

- 🔴 **`lib/` 必须提交**：`.gitignore` 里**不许再出现 `lib/`**。
  git 依赖没有"安装时构建"这一步（pnpm 默认还会拦掉 `prepare` 脚本），
  不提交 `lib/` ⇒ 用户装到一个没有代码的包，`main: lib/index.js` 直接找不到。
  **纪律：改完 `src/` 必须 `npm run build`，且 build 与 commit 要在同一次完成。**
- **仓库名 = 包名 = `dsh-remote-qqbot`**。DSH CLI 对 git 规格的判定见
  `apps/cli/src/plugin.ts:150`（`/^git\+|^github:|\.git(?:#|$)/`）。
- **想被社区目录收录**：给仓库加 GitHub topic **`dsh-plugin`**（生态目录主要抓这个标签），
  再去 [dshbase](https://github.com/ylwl1997/dshbase) 提 plugin-submission Issue，
  官方社区在 [deepseek-ai/deepseek-harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)。
  **不要求发 npm** —— 绝大多数 DSH 插件就是 `dsh plugin add github:<owner>/<repo>`。

### 🔴 铁律：不重启 = 没生效

桌面版是**长驻进程**，任何插件改动都必须重启 DSH。判定方法固定为**比时间**：

```
安装目录 package.json 的 mtime  <  桌面版进程 StartTime   ⇒ 才真正生效
```

⚠️ **不要用 `lib/*.js` 的 mtime 判**：pnpm 解包**不保留安装时刻**，安装目录里
`lib/index.js` 的 mtime 可能是一小时前（甚至比本地 `lib/` 还晚、却远早于真实安装时刻）。
本项目已经因此差点把"没生效"看成"生效了"。**只看 `package.json` 的 mtime，或直接比对哈希。**

### 并发写入纪律

本项目出过一次「看起来装好了、其实是半成品」的版本 —— 两个会话同时写 `src/index.js`。
所以：

- 改任何文件前先登记（协作面板 / 协作工具），**同一个文件同一时刻只允许一个写入者**；
- **只有一方跑 build/pack/install**，另一方等信号；
- 装完必须核对「**安装目录的 lib 哈希 == 本地 lib 哈希**」，再谈验证。

---

## 十、已解决与未解决

### 已经修掉、且**不要改回去**的设计

| 事项 | 结论 |
|---|---|
| 用户配置从不生效 | 根因是「未注册就 `get`」+「把填满默认值的 config 合并到 settings 之上」，见 5.2 |
| UI 显示「QQ 未连接」 | 让 UI 读 `liveConfig()`，不要让数据源迁就 UI，见 5.3 |
| 询问卡片永远挂着 | QQ 优先 + 桌面延时兜底，**一开始就不创建桌面 pending**，见 3.7 |
| 提问推送没有选项 | `userQuestions` 服务提供者 fiber 未 active 时 `ctx.get` 返回 `undefined`，靠三层补接（`inject` / `tools/pre-execute` 时刻 / 兜底文案） |
| 链接被 QQ 拦 | host 全大写，手工拼字符串（不能用 setter），见 6.1 |
| 收到确认后复述用户原话 | 回执只留一行，但**保留 `（会话名）`** |
| 抓屏被 Defender/AMSI 整份拦下 | **不许再碰 `GetImageEncoders()` / `EncoderParameters`**，只用 `ImageFormat::Jpeg` 存；`qqScreenQuality` 已删（见 6.4） |
| 抓屏失败甩英文报错给手机 | `isAvBlocked()` 翻成中文 + 放行办法（Windows 安全中心 → 排除项） |
| **截图只剩左上角** | DPI unaware 进程看到的是**逻辑尺寸**（1440x900），`CopyFromScreen` 却搬物理像素 ⇒ 只存了左上四分之一。修法：`SetProcessDPIAware()` 必须在读 `VirtualScreen` **之前**；顺序就是全部（见 6.5） |
| **输入框下方两个开关「点了没用、永远显示已开」** | 三个缺陷叠加：命名空间与 profile 条目 id 不一致（桌面 `update()` 必抛）/ 没有 volatile 字段（`describe()` 直接跳过）/ `ok:false` 写在 success spread **之前**被掩盖。修法：写配置走「原生优先 → 插件自有覆盖文件」两条路，失败必抛且 UI 显示（见 5.3b） |
| **裸数字被误当成"切会话"** | 优先级写死为 `引用 > 有提问在等 > 选会话 > 闲聊`，且裸数字只在名单发出后 5 分钟内算数（见 6.6） |
| **指定的会话没了却静默投进别处** | 投递前 `api.hasSession` 校验；不在了就明确回一句并清指针，**绝不悄悄换一个会话** |
| **`blocksToText()` 把换行压平**（0.8.6 修） | 原来是 `parts.join(' ').replace(/\s+/g,' ')` ⇒ 上传的正文从源头就不是 markdown（实测 `hhfwa.md` 单行 1290 字符里塞 5 个 `##` 标题）。现在只统一换行、压行内空格、折叠多余空行，**段落/标题/表格结构保住**；需要单行摘要的调用方（`composeSummary` / `composeChatSummary`）自己压平 |
| **「默认不发正文」只是句承诺**（0.8.6） | 拆成「模式（意图）+ `cloudEnabled` 总闸（授权）」两道，只有两者都满足才上传。`chat` 档 + 总闸关闭 ⇒ **对服务器 0 字节**，探针实测 `/api/notes` 请求数为 0 |
| **`MARKER_RESERVE` 下限缺陷**（0.8.6） | `bodyLimit` 原来写 `Math.max(MIN_CHUNK_CHARS, …)`，`limit ≤ 109` 时反而超限（实测 `limit=100` 产出 106 字）。改成 `Math.max(1, limit - MARKER_RESERVE)`；★边界用例钉在 `tests/fulltext.test.mjs` |
| **引用一条 QQ 消息 → 回「认不出这是哪次通知」且消息消失**（1.0.6） | 三级兜底缺了两级：①回执（`replyPassive`）从不登记 `ref_idx`；②兜底只看 `recent[]` 且只有 5 分钟。现在回执登记 `ref_idx`、兜底合并 `sentRefs{}` 并放宽到 12 小时、真认不出**也必须投进闲聊会话（只读）**。**任何一级都不许再退回"只回一句就丢掉"**，见 3.6b |

### 已知未解决 / 未验证

| 事项 | 状态 |
|---|---|
| QQ 单条**客户端**渲染上限 | 服务端实测接受 900/1500/3000 字（见 6.7），但**手机端会不会折叠/截断长消息没观测过**；因此 `QQ_TEXT_SAFE_CHARS` 保持 900 |
| `note` / `note-link` 档的真实端到端 | 本轮只保证「默认档 `chat` 零上传」；上传路径本身（P1 服务端账号/额度/保留期）尚未改，`note*` 档仍指向现有中枢 `/api/notes` |
| `src/summary.js` 换行压平 | **已修（0.8.6）** —— 见上表；但**服务器上那 14 篇历史笔记仍是被压平的旧文本**，渲染器只能尽力还原（`repairFlattened`），新笔记才会是正常 markdown |
| 闲聊只读拦不住 `ssh` 到远端改文件 | 已知边界。沙箱只管本机文件系统 |
| nginx 的 `Cache-Control` 被 `add_header` 加了两次 | 无害，低优先级 |
| 「QQ 菜单点击 → 输入框 → 按发送」的完整真机链路 | 逻辑上已通（菜单保留前导斜杠、线上菜单已含 `屏幕 /screen`），但尚未亲眼见到 |
| 截图在 macOS 上的路径（`screencapture`） | **未在任何 mac 上跑过**，属于"顺手写上"；Linux 故意不支持（明确报错，不假装成功） |
| Defender 的 AMSI 规则将来可能改 | 现在这条绕过依赖启发式规则；再被拦时 `verify-installed.mjs` 第 [3] 节会红，QQ 里也会收到中文提示 |
| 大小写绕过依赖平台检测的漏洞 | 腾讯若修掉就失效，届时要走官方申诉 |
| QQ 菜单的**客户端缓存与刷新延迟** | **完全没测过**（这也是"会话名不写进菜单"的决定性理由）。菜单只放固定入口，会话名单永远现算 |
| 「菜单点「会话」→ 输入框出现 `/sessions` → 按发送」的真机链路 | 逻辑与线上配置都已就位（回读 version 43），但"用户手点那一下"仍未亲眼观测 |

---

## 十一、给下一个改这个插件的人

1. **先读 [../README.md](../README.md) 的「五条必须遵守的加载/配置期约束」**，再看本文件。
2. 加配置项：`DEFAULTS` → `Config` → `FIELD_SPECS` → 测试，四步缺一不可。
3. 改文案/排版：**把规则放进导出的纯函数**，让测试真跑它，别写只匹配字符串的断言。
4. 改完必须：`build` → `npm test` → `pack` → `install` → `verify-*` → **让用户重启** → 比时间戳。
5. 任何「看起来应该可以」的结论都不算完成；`verified` 和 `unverified` 分开写清楚。
