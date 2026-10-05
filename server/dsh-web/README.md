# dsh-web · DSH 通知插件的网页端

一个**零依赖**的 Node 服务：静态页 + 账号 / 配额 / 记录 API。公开入口 `http://cyanovo.top/`
（nginx `location /` → `127.0.0.1:8795`），代码在服务器 `/opt/dsh-web`，数据在 `/var/lib/dsh-web`。

它解决的问题：DSH 的通知插件默认只把**摘要**发到 QQ，长回答的正文没地方放。
这个站点就是正文的落脚点 —— 登录后打开看全文。

> **联系方式（作者）**：QQ **1103416608** ｜ GitHub **[@cyanovo](https://github.com/cyanovo)**
> —— 站点/额度/兑换码有问题，或者想要某个功能，直接找我。仓库总览见 [../README.md](../README.md)。

```
插件 ──(设备码绑定拿令牌)──▶ POST /api/publish ──▶ data.json（记录）
你   ──(浏览器登录)────────▶ GET  /api/records → POST /api/records/<id>/view（每次记 1 次）
```

## 两档（**唯一事实来源是 `proUntil`**）

| | 免费 | 付费版（¥2.99 / 30 天） |
|---|---|---|
| 每天完整查看 | **100 次** | **1000 次** |
| 记录保留 | **5 小时** | **48 小时** |
| 过期后 | — | 自动掉回免费版（读的时候现算，不看缓存） |

> 🔴 这里有一条**改过的旧语义**：从前只有一个布尔 `upgraded`，升级后是「**不限次数**」且**永不过期**。
> 那既不等于「2.99 元 = 一个月」，也让「一天 1000 次」变成空话。
> 现在额度与保留期**都是 `proUntil` 的函数**，且付费版**照样计数**
> （否则承诺的上限没人能验，也没人会撞到）。
>
> 兑换是**叠加**：`proUntil = max(now, proUntil) + 天数`。
> 覆盖式写法会让「续费」变成「重新开始」，买两次 30 天却只有 30 天。

保留期逐条记在**记录自己**身上（`rec.expiresAt`），所以"有人在 48 小时里升级/掉档"不会篡改已存下的记录。

## 设备码绑定（插件不经浏览器也能拿到令牌）
想让插件以**你自己的身份**发布，但不想让它保存你的账号密码：

```
插件                                    浏览器（你已登录）
 │ POST /api/device/start                 │
 │  ← userCode(8 位, 如 ABCD-EFGH)         │
 │     deviceCode(长码, 只留在插件里)       │
 │                                        │ POST /api/device/approve {userCode}
 │ POST /api/device/poll {deviceCode} ────┼──▶ 服务端登记"谁批的"
 │  ← {status:'approved', token}（只此一次）│
```

三条硬约束（都有断言钉着）：
1. **短码单独存在换不出任何东西** —— `approve` 必须**已登录**，`poll` 必须持长码；
2. **令牌只交付一次** —— 交付后状态变 `used`，重放同一 `deviceCode` 拿不到第二份；
3. **明文令牌从不落盘** —— 令牌在 `poll` 交付的那一刻才现签发，库里只有 `sha256`。
   （第一版是 `approve` 时就生成、存在 `devices` 里等插件来取 ⇒ 明文会躺在磁盘上最长 10 分钟。
   是验收里那条「data.json 不该含令牌明文」把它抓出来的。）

短码 10 分钟有效，`/api/device/*` 每 IP 每分钟 10 次、超限锁 10 分钟
（它是唯一**不用登录**就能创建数据库条目的写接口，不限流等于开了个刷爆入口）。

**界面上在哪儿点**：登录后进「账号」页 → 「绑定 DSH 插件」→ 填那组 8 位码 → 确认。
同一个页面上还有「我的令牌」：列出每把令牌的前缀 / 用途 / 最近使用时间，可单独吊销
（明文只在**新建**那一次显示，只读输入框里给一次，之后服务端也只有 sha256）。
这两块都由 `verify-account-ui.mjs` 用无头桩跑真 `public/app.js` 验过。

## 每账号发布令牌（多租户隔离的关键）

发布有两条路，按身份强弱分开：

- `Authorization: Bearer <每账号令牌>` —— 插件走这条，**只能以自己的身份发布**；
  在 body 里指定别的 `username` 会被 **403 明确拒绝**（不是"忽略"，免得出现"以为发出去了其实发到别处"）。
- `x-publish-token: <全局令牌>` —— 管理员通道（主人给自己用），必须显式带 `username`。

> 🔴 **旧的缺口**：从前只有一条全局 `x-publish-token`，谁拿到它就能以**任意用户名**发记录 ——
> 多租户下这是最严重的隔离问题（冒充、污染别人「我的记录」）。现在每账号一把，只存 sha256。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 只回 `{ok:true}`。**故意不报数字**：免鉴权的用量数字本身就是信息披露（2026-10-04 安全审计 H5 前它回 `{ok,records,users}`） |
| GET | `/health/detail` | 服务自报的记录/账号/设备数与运行时长（要后台口令 `x-admin-token` 或管理员登录） |
| GET | `/api/meta` | 三档模式、两档额度/保留、价格、设备码参数、**本请求要不要人机验证**（`captcha.required`） |
| GET | `/api/captcha` | 签发一张人机验证图（返回 `id` + SVG 的 data URL）。单次有效，见下「人机验证」 |
| POST | `/api/register` `/api/login` `/api/logout` | 账号与 HttpOnly 会话 cookie。前两个还要带 `captchaId` + `captchaText`（见下「人机验证」） |
| GET | `/api/me` | 我的档位、`proUntil`、配额 |
| POST | `/api/prefs` | 保存全文模式偏好 |
| GET | `/api/records` | 我的记录（只返回自己的） |
| POST | `/api/records/<id>/view` | 打开一条：返回正文并**记 1 次**（超限 429） |
| POST | `/api/publish` | 发布记录（见上：Bearer 或管理员令牌） |
| POST/GET | `/api/codes` | 生成 / 列出兑换码（仅管理员） |
| POST | `/api/redeem` | 兑换付费版（叠加） |
| POST | `/api/device/start` `/poll` `/approve` | 设备码绑定 |
| GET/POST | `/api/tokens` `POST /api/tokens/revoke` | 我的发布令牌：列出 / 新建 / 吊销 |
| POST | `/api/me/purge` | 一键删除：`scope:'records'` 删记录；`scope:'all'` 连账号注销（要密码） |
| GET | `/api/admin/overview` | 后台：总量 + 14 天趋势 + 内存/运行时长 + 配置快照 |
| GET | `/api/admin/users` | 后台：用户列表（含档位、到期、今日用量、累计查看） |
| GET | `/api/admin/users/<name>` | 后台：单个用户详情（令牌只回**前 12 位**，绝不明文） |
| POST | `/api/admin/user/create` | 后台：建账号，可 `forever:true`（管理员自用档） |
| POST | `/api/admin/user/password` | 后台：改密码 |
| POST | `/api/admin/user/quota` | 后台：重置今日用量 / 调整额度 |
| POST | `/api/admin/user/grant` | 后台：加天数（`days`，叠加）；`{revoke:true}` 或 `{plan:'free'}` → 取消付费版身份 |
| POST | `/api/admin/user/ban` | 后台：封禁账号（`{reason}` 最多 200 字）；`{banned:false}` 解封。**只标记，从不删数据** |
| POST | `/api/admin/user/admin` | 后台：给 / 取消**账号级管理员**（`{admin:true|false}`） |
| POST | `/api/admin/user/delete` | 后台：删账号 |
| GET/POST | `/api/admin/codes` · `POST /api/admin/codes/delete` | 后台：兑换码生成 / 列表 / 删除 |
| GET | `/api/admin/records` · `POST /api/admin/records/delete` | 后台：记录列表 / 删除（**不含正文**） |
| GET | `/api/admin/devices` | 后台：设备码绑定列表（不含长 `deviceCode`） |
| POST | `/api/admin/token/revoke` | 后台：吊销某账号的发布令牌 |
| — | `/api/admin/*` 未命中 | `404 no such admin api` |

## 鉴权与限流（2026-10-04 安全审计后补的闸）

开源前做了一轮安全审计，报告在 [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md)。这里只记**行为契约**，
每一条都有反向校验钉着（同一套断言指向打补丁前的 `server.mjs` 必须变红：实测 `123/0` → `105/18`）。

| 闸 | 规则 | 为什么 |
|---|---|---|
| 会话 cookie | `HttpOnly` + `SameSite=Lax` + **走 TLS 时带 `Secure`** | 不带 `Secure` 的 cookie 会在任何 http 请求里被明文发出去，而本站 80 端口是故意开着的 |
| 登录/注册限流 | 每 IP **30 次/分钟**（两者共用一把闸），超限锁 10 分钟 | 挡「一个来源狂试一堆账号」的撞库 |
| 账号锁 | 同一账号 **10 次失败**锁 10 分钟，**与来源 IP 无关** | 挡「换 IP 狂试同一个账号」的定向爆破 |
| 反枚举 | 用户名不存在时也跑一次**同样代价**的 scrypt | 否则响应时间本身就在回答"这账号存不存在"（改前实测 45 ms vs 1 ms = 45 倍） |
| 改密码 | 会话里带「世代号」，改密（含后台重置）时 +1 ⇒ **所有旧 cookie 立刻作废** | 无状态 HMAC 会话没有吊销列表，不这么做"改密码踢不掉已经进来的攻击者" |
| 兑换码 | 一张码**一生只能兑一次**，谁兑的都不行 | 改前只挡"别人用过"，自己可以反复提交叠加 |
| 令牌吊销 | `id` 为空 → **400** | 空的 `startsWith('')` 会匹配全部令牌 |
| 人机验证 | 公网请求的注册/登录必须带一张**没用过、没过期、来源 IP 对得上**的图；错 3 次作废；每 IP 60 张/分钟 | 挡「脚本批量注册/撞库」。规则与豁免见下节 |

**怎么判「走 TLS」**：看 `x-forwarded-proto`（两台 nginx 都设了这个头：80 用 `$scheme`、443 写死 `https`）。
8795 只监听 `127.0.0.1`，所以这个头和 `x-real-ip` 一样无法被外部伪造 —— **换反代时必须重看这一条**。

**已知边界（不夸大）**：从 `http://` 登录拿到的 cookie **没有** `Secure`（否则浏览器根本不会存，http 站点就登不上了）。
所以仍然建议**登录一律走 `https://cyanovo.top`**；http 只当作 QQ 链接的落地页用。

**数字挪了家**：`/health` 现在只回 `{ok:true}`；要账号数/记录数请走 `/health/detail`（要后台口令）。
验收脚本里凡是靠 `/health` 读数字的地方都一并改掉了 —— 没改的话会退化成 `undefined === undefined` 的**假绿**。

## 人机验证（登录 / 注册的图形码，2026-10-05 加）

公网的 `/api/register` 与 `/api/login` 现在各要一张图。图是**服务端自己画的 SVG**（132×44，含湍流位移滤镜），
以 data URL 直接塞进 `<img>`，不引任何第三方验证码服务。原因不是"自研更酷"：

- 本站 80 端口**故意**是明文 http（QQ 内置浏览器只能开 `http://` + 全大写域名的链接，见「nginx」一节），
  在这种页面上加载 reCAPTCHA / Turnstile 的脚本，**脚本没加载出来就是所有人全被锁在门外**；
- 那些域名在大陆的连通性不由我们掌握，而这道闸必须"永远能出图"。

契约（`verify-captcha.mjs` 里每条都有断言，19 条）：

| 项 | 规则 |
|---|---|
| 有效期 | 3 分钟（`DSH_WEB_CAPTCHA_TTL_MS` 仅供验收调短） |
| 一次性 | 验对即销毁；同一个 id 再用一次 → 400 |
| 试错 | 同一个 id 错 3 次即作废（第 4 次就算填对也不认） |
| 绑来源 | 题绑在领题时的来源 IP 上，换 IP 提交作废 |
| 输入友好 | 答案**只有 4 位**、去空格、忽略大小写、排除易混淆的 `0O1I` 等 |
| 领取限流 | 每 IP 60 张/分钟，超限锁 10 分钟 |
| 存储 | 只在内存：`id → sha256(密钥 + 答案)` + 来源 IP + 到期时间。**答案不落盘、不进日志** |
| 状态码 | 被验证码拦下是 **400** + `captcha:true`（与密码错的 401 分开，前端据此提示"换一张"） |
| 与账号锁的关系 | 验证码失败**不**计入 `loginFail` —— 否则拿验证码刷一刷就能把别人的账号锁掉 |

**两条豁免通道**（都不是"公开的后门"，`verify-captcha.mjs` 里有反例断言）：

1. **本机直连**：`req.socket.remoteAddress` 是本机回环，**且** 没有 `x-real-ip`（或它也是回环）。
   nginx 给公网流量一定会写 `x-real-ip`，而 8795 只监听 `127.0.0.1` —— 所以公网请求**永远**迈不进这条通道。
   留着它是为了本机验收脚本（`verify-*.mjs` 那一串直连 `127.0.0.1`）不必人人先解一张图。
2. **带对后台口令**（`x-admin-token`）：口令本身就是全权凭证，免掉一张图不多给任何权限；
   自动化脚本（`verify-live.mjs` / `_live-role.mjs` / `verify-deeplink-live.mjs`）靠它继续跑。
   ⚠️ **口令为空时千万别带这个头**：服务端会把"带了口令但不对"记成一次失败，10 次就把主人自己的 IP 锁 10 分钟。

验收用的开关只有两个，**生产 unit 里一个都不许设**：`DSH_WEB_CAPTCHA_TEST=1`（把答案一并回给脚本）与
`DSH_WEB_CAPTCHA_TTL_MS` / `DSH_WEB_CAPTCHA_IP_LIMIT`（调短 TTL、调小领取上限）。
和 `DSH_WEB_RETENTION_MS` 一样，它们只为"跑一遍就能验到期/限流"存在。

**前端按服务端说的来**：`/api/meta` 会回 `captcha.required`（服务端自己按上面两条豁免算），
前端只有看到 `true` 才画那张图、才把 `captchaId/captchaText` 带进请求。少了这一步，本机直连与带口令的请求
会被前端拦在一张服务端根本不看的图上（本机那些真浏览器验收会因此全红，而且看着像产品坏了）。

**上线实测（2026-10-05 17:5x）**：

| 量具 | 结果 |
|---|---|
| 公网 `http://cyanovo.top/api/meta` 与 https 两个入口 | `captcha:{required:true,chars:4,ttlMs:180000}` |
| 公网不带验证码注册 | `400` + `captcha:true`「请先填写图片里的验证码」 |
| 公网登录：密码错 + 图里填错 | `400`「验证码不对（还能试 2 次）」（**不是 401** —— 闸在密码比对之前） |
| 公网 `GET /api/captcha` | 200、`Cache-Control: no-store`、SVG 里正好 4 个 `<text>`，**响应里没有 `answer` 字段** |
| 服务器本机直连（回环） | `required:false`，注册走到的是「密码至少 6 位」、登录走到 401 —— 都没被人机验证拦下 |
| 对照：同一个 8795，只多带一个 `x-real-ip: 203.0.113.99` | 又被拦下（`captcha:true`）⇒ 公网迈不进回环那条通道 |
| 线上真浏览器（`_live-captcha-ui.mjs`） | 11/0：图解码成 132×44、点「换一张」换到另一张、空着点登录本地就拦下 |
| 线上链路（`verify-live.mjs`，带 `ADMIN_TOKEN`） | 31/0 |
| `/opt/dsh-web/server.mjs` 的 md5 | `86b9b91b98754924bfb392b4a57c52e9`，与本地**逐字节相同**；unit 里没有 `CAPTCHA` 相关环境变量 |

## 后台管理页（`/admin.html`）

浏览器打开 `https://cyanovo.top/admin.html`（`noindex,nofollow`），粘贴后台口令即可。
口令在服务器 `/var/lib/dsh-web/admin-token`（**32 字节、权限 600**，由 `deploy.sh` 第一次部署时生成并只打印一次）：

```bash
ssh cyanovo 'cat /var/lib/dsh-web/admin-token'      # 忘了就现查；想换就删掉文件再跑一次 deploy.sh
```

- 载体：`x-admin-token` 头（页面用的是这个）或 `Authorization: Bearer <口令>`，两种都收。
- 比较是**定时安全**的（先 sha256 再 `crypto.timingSafeEqual`），失败计数每 IP 10 次 → 锁 10 分钟，成功一次即清零。
- **三把钥匙互不通用**（这是刻意的隔离，`verify-admin.mjs` 里有断言守着）：
  | 钥匙 | 能干什么 | 不能干什么 |
  |---|---|---|
  | 登录 cookie（`dsw_session`） | 看**自己的**记录正文、配额、令牌 | 进不了 `/api/admin/*` |
  | 每账号发布令牌（只存 sha256） | 发布记录、读自己的配额 | 读任何记录正文、进不了后台 |
  | 后台口令（文件） | 用户/用量/兑换码/记录列表（**不含正文**） | 读不到别人记录的正文 |
- 页面里**没有一个 `innerHTML`**：全部 `textContent` / `createElement`（用户名叫什么都不会变成脚本）。
- 口令存在 `sessionStorage`（关标签页即失效），不在 URL、不写 localStorage。

### 「用户」页上，功能在哪儿（2026-10-04 修过一次"找不到"）

主人的原话是「**没有看到真正的用户管理**，比如说给指定用户 Pro、封禁账号、取消 Pro 之类的」。
功能一直在、接口也全绿 —— 问题是**界面上没有任何东西说明这页能干什么**，实测两条根因：

| # | 原来 | 现在 |
|---|---|---|
| ① | 用户表 9 列**全是数字**，一个操作按钮都没有；唯一入口是"点用户名"，而它渲染成 `btn ghost`（无边框、无底色）—— 看起来就是一行纯文字 | 多了第 10 列 **「操作」**，每行一个写着用途的 **「管理」** 按钮；页面顶部多一行说明「点每行最右边的『管理』，就能给 TA 加 Pro / 取消 Pro / 封禁·解封 / 重置密码 / 删除账号」 |
| ② | 「取消 Pro」那个按钮挂着 **「退出该账号登录」** 的牌子（点下去跑的其实是 `revoke`）⇒ 想取消 Pro 的人永远找不到它 | 改名 **「取消 Pro（改回免费版）」** |

顺带两处体验修补：
- 详情面板 `#uDetail` 在用户表**上方**，列表一长，从下面点「管理」它就在视野外渲染出来（表现是"点了没反应"）
  ⇒ 现在每次渲染后 `scrollIntoView({block:'start'})`，并把正在看的那一行加 `.on` 高亮（`markActiveRow()`）。
- 详情里的按钮按能力分了**三组带标题**：**付费版身份（Pro）** / **封禁** / **账号管理**，
  不再是一坨没有标题的按钮。加天数那句还写明了是**叠加**（从现在的到期时间往后加，不是从今天重算）。

「操作」列是 `position: sticky; right: 0` 钉在右边的：这个表有 10 列，
窄屏（手机）必然横向滚动，而"能不能给 TA 加 Pro"恰恰是这张表存在的理由，不能让它在屏幕外。
实测（`_live-admin-ui.mjs`，1360px 视口）：正常宽度 `scrollWidth - clientWidth = 0`（不用横滚），
把容器压到 420px 后按钮**仍在可视区内**。

> ⚠️ `admin.css` 里那 6 处 `var(--faint)` 已改成 `var(--muted)`。`--faint` 在 2026-10-03 的 SPA 改版里
> 因为对比度只有 2.52:1 被删掉了，而 `admin.css` 还在引用它 —— 未定义的 `var()` 不报错、不变红，
> 只会静默回落成继承值（那些"次要小字"全变成了正文色）。现在有 `verify-css-vars.mjs` 把这类问题挡在门外。

### 两条并列的进后台通道（口令**没有**被削弱）

后台页的闸门上有两个标签页，对应**两条互相独立的通道**：

| 通道 | 怎么进 | 谁在用 |
|---|---|---|
| **服务器口令**（`token`） | 粘贴 `/var/lib/dsh-web/admin-token` 的内容 | 引导期 / 命令行 / 口令丢了还没设主人账号时 |
| **账号管理员**（`account`） | 用用户名 + 密码登录，且该账号 `admin === true` 且未被封禁 | 主人日常使用（不用复制口令） |

- 服务端把它归成一个函数：`adminAuthKind()` 返回 `token` / `admin-session` / `bad-token` / `none` 四种。
- **普通账号（不是管理员）→ 403**，且**不累加失败计数**（否则随便一个人登录后点一下后台就能把主人锁掉）。
- **没带任何凭证 → 401**，也不累加。只有**口令写错**才累加 `adminFail`（10 次 / 10 分钟 → 锁 10 分钟）。
- 因此前端**绝不发送空的 `x-admin-token`**：空串会被当成"试了一把错口令"，而它本意是"这次走 cookie"。
- 主人账号由环境变量 **`DSH_WEB_OWNER`** 在服务启动时补管理员位（`deploy.sh` 的 systemd 单元里已写死为
  `Environment=DSH_WEB_OWNER=cyanovo`）。**公开注册永远不会自动给管理员**（有断言守着）。

### 封禁与「最后一个管理员」

- 封禁是**标记，不是删除**：`user.bannedAt` / `banReason` / `bannedBy` 三个字段，数据、发布令牌、
  记录、档位**一个都不动**。解封后原样回来（`verify-admin-role.mjs` 里有"封禁期间数据不变 / 解封后完全恢复"的断言）。
- 四道闸会明确拒绝被封账号，而不是伪装成"没登录"：
  | 入口 | 表现 |
  |---|---|
  | `/api/login` | **403** 且正文点名原因：「这个账号已被封禁：<原因>」（不下发 cookie） |
  | `/api/*` 中央闸门 | **403**「这个账号已被封禁，暂时不能使用」 |
  | `/api/publish`（发布令牌） | **403**「账号 <name> 已被封禁，发布令牌暂时不能用」 |
  | `/api/me` | **200**，但带 `banned:true` + `banReason` —— 刻意不用 403，好让网页端把原因显示出来 |
- **最后一个还能用的管理员不许被封 / 不许被取消管理员 / 不许被删**，三种操作都返回 **409**
  （「这是最后一个还能用的管理员…」），由 `activeAdmins()`（`admin && !banned`）判定。
  这条守卫是这次设计里唯一"防自锁"的硬约束 —— 否则主人一点就能把自己彻底关在门外。
- 被封着的账号**不给管理员**（409「这个账号正被封着，先解封再给管理员」）。

### 付费版身份：加与取消是同一个路由

`POST /api/admin/user/grant` 一处收口：`{days:N}` 叠加天数；`{revoke:true}`（或 `{plan:'free'}`）
把 `proUntil` 归零并清掉 `upgraded`。**档位/额度/保留期都不是独立字段**，它们全是 `proUntil` 的派生值，
所以取消之后不会留下"半档"状态。

## 部署

```bash
bash /opt/dsh-web/deploy.sh          # 8 步、幂等
```

八步分别是：①目录权限 ②三把钥匙（登录 secret / 发布令牌 / 后台口令）③systemd 单元
④本机自检 ⑤nginx 80 定点反代 ⑥nginx 443 站点 ⑦`nginx -t` + reload ⑧公网自检。
几条关键的幂等设计：

- 后台口令**已存在就不覆盖**（想换：删掉 `/var/lib/dsh-web/admin-token` 再跑）。
- 单元先写临时文件再 `cmp`：内容没变就**不备份、不重写**（否则每跑一次多一份 `.bak-<stamp>`）；但**每次都重启服务**
  —— `server.mjs` 可能换了内容而单元没变，只有重启才会加载新代码。
- 单元里的 `Environment=DSH_WEB_PUBLIC_BASE=<公网地址>` 由 `sed` 占位替换后**回读校验**（写不进去就退出）。
- nginx 都是"定点字符串替换 + 命中数必须恰好 1"的写法，找不到原文就中止，绝不整文件重写。
- 最后一步真的走 nginx：`http / → 200`、`https / → 200`、`/api/admin/overview` 不带口令 → **期望 401**。

`_check-idempotent.sh` 就是验这一条的：连跑两次 deploy，退出码都 0、单元备份份数不变、单元 md5 不变。

⚠️ systemd 单元**不设** `DSH_WEB_RETENTION_MS` / `DSH_WEB_PRO_RETENTION_MS`，所以线上跑的就是默认的 5h / 48h。
这两个环境变量**只为验收**存在（否则要等 5 小时才能验一条记录过期）。

## 验收（都是"跑出来的"，不是推断）

```bash
node verify-p1.mjs            # 43 条：档位/设备码/隔离/配额/TTL/叠加/限流/删除    ← 本地，临时数据目录
node verify-p1-defaults.mjs   # 12 条：生产默认值（必须在不设任何环境变量的进程里读）
node verify-p1-quota1000.mjs  #  7 条：真打 1000 次，第 1001 次必须 429
node verify-captcha.mjs       # 19 条：人机验证（签发/强制/一次性/试错/过期/绑 IP/限流/两条豁免/不落盘）
node verify-dom-ids.mjs       #  9 条：app.js 要用的每个元素 id 都有人提供（补无头桩的盲区）
node verify-deeplink.mjs      # 16 条：`/n/<id>` 深链（无头 DOM 桩跑真 app.js）
node verify-account-ui.mjs    # 55 条：首页能渲染 + 账号页设备码/令牌 + 登录页的验证码（同一个桩，真浏览器语义）
node verify-landing.mjs       # 33 条：**线上**首页落地页 + 三个静态文件逐字节一致
node verify-live-429.mjs      #  7 条：被限流时脚本要"说清 + 退出码 3"，不许级联变红
node verify-live.mjs          # 31 条（没给 ADMIN_TOKEN 则 30 条 + 1 条显式跳过）：打公网入口，全程真链路，收尾自删临时账号
                              # 给了 ADMIN_TOKEN 才能验"账号数/记录数回到开跑前"（走 /health/detail），
                              # 没给就**显式打印「跳过」**，绝不让 undefined===undefined 冒充通过
                              # 公网注册/登录现在要人机验证 ⇒ 这个脚本**必须**带 ADMIN_TOKEN 才跑得通
node _live-captcha-ui.mjs     # 11 条：**线上**真浏览器打开登录页，验那张图真的画得出来、点「换一张」真的换
node verify-admin.mjs         # 124 条：后台 API 全套（自助临时数据目录，不碰线上）
node verify-admin-ui.mjs      # 167 条：无头 Edge + CDP 真点后台页面（真 CSS 层叠、真事件）
node verify-admin-role.mjs    # 76 条：账号身份的管理员角色（DSH_WEB_OWNER 自举、封禁、最后一个管理员）
node verify-css-vars.mjs      #  2 条：两个样式表里不许出现"用了但没定义"的 var(--x)
node _reverse-admin-ui.mjs    # 反向校验：把 public/ 拷一份切 5 刀 → 期望 5 红（含"管理入口不见了"）
node _live-admin.mjs <后台口令>  # 40 条：http 与 https **各 20 条**打线上后台
# 下面两个要口令的，口令只从环境变量读（2026-10-04 安全审计后**源码里不再有默认口令**，缺了就 exit 2）
# PowerShell:  $env:ADMIN_TOKEN='<后台令牌>'; $env:OWNER_PASS='<主人账号口令>'
node _live-role.mjs           # 63 条：拿真口令打**线上**，跑一遍封禁/解封/付费版/管理员四类角色（自建自删临时账号）
# PowerShell:  $env:ADMIN_PASS='<主人账号口令>'
node _live-admin-ui.mjs       # 34 条：无头 Edge 进后台「账号+密码」通道。⚠️ 公网上跑不了（账号登录要人机验证，
                              # 无头浏览器不会看图）——脚本开工前会自己问 /api/meta 并给出隧道跑法：
                              #   ssh -N -L 18795:127.0.0.1:8795 cyanovo
                              #   $env:BASE_URL='http://127.0.0.1:18795'; $env:ADMIN_PASS='…'; node _live-admin-ui.mjs
# verify-deeplink-live.mjs 同理：口令用 --pass 或环境变量 DSW_PASS，不再有默认值
# 服务器上（它会写真实 data.json，跑完用 _cleanup-testdata.mjs 清测试账号）
ssh cyanovo 'cd /opt/dsh-web && node verify.mjs'      # 56 条：旧契约回归
```

⚠️ **`verify-live.mjs` 十分钟内别连跑**：设备码接口是全站唯一没有鉴权的写入口，
所以有 10 次/分钟 → 锁 10 分钟的限流，而脚本每跑一次都要 start/poll。
连跑会踩到自己的限流（实测：一次 429 让后面 10 条断言全红，看着像产品坏了）。
踩到时脚本会**直接说清并退 3**（`verify-live-429.mjs` 就是验这条分支的）；
要马上重跑就先 `systemctl restart dsh-web`（限流计数在内存里）。

⚠️ **登录/注册也有每 IP 30 次/分钟的闸**（2026-10-04 审计补的，见上面「鉴权与限流」）。
所以一串线上脚本（`verify-live` + `_live-role` + `_live-admin-ui` + `verify-deeplink-live`）**同一分钟连着跑**，
累计登录/注册次数可能撞到 30 次 —— 症状是突然一片 429。同样 `systemctl restart dsh-web` 即可清零。
定向爆破另有"同一账号 10 次失败锁 10 分钟"，那把锁**与 IP 无关**，重启才会清。

⚠️ **2026-10-05 起，线上脚本必须带后台口令**：公网 `/api/register` 与 `/api/login` 加了人机验证，
而脚本没法"看图写字"，只能走 `x-admin-token` 这条豁免通道（口令本身就是全权凭证，免掉一张图不多给权限）。
`verify-live.mjs` / `_live-role.mjs` / `verify-deeplink-live.mjs` 都改成了"有口令才带、没口令就**明说并退 3**"，
不再让 400 冒充成产品故障：

```powershell
$env:ADMIN_TOKEN = (ssh cyanovo cat /var/lib/dsh-web/admin-token)
node verify-live.mjs
node _live-role.mjs                     # 还需要 $env:OWNER_PASS
node verify-deeplink-live.mjs --pass <主人口令>   # 也可 --admin-token <后台口令>
```

⚠️ **`_cleanup-testdata.mjs` 改的是磁盘文件，而服务把 DB 放在内存里** ——
所以清完必须 `systemctl restart dsh-web`，否则服务下次写盘会把清理覆盖掉
（实测：清完 `/health/detail` 仍是 2 账号 2 记录，重启后才回到 0）。

**反向校验**（证明断言不是空的）：

```bash
node Temp/_make-old.mjs                       # 把当前 server.mjs 回退 5 处新语义 → Temp/old-server.mjs
P1_SERVER=Temp/old-server.mjs node verify-p1.mjs            # 期望 5 条红
P1_SERVER=Temp/old-server.mjs node verify-p1-quota1000.mjs  # 期望 4 条红
# 人机验证：把两处 `if (!cap.ok) {` 改成 `if (false) {`（等于把闸拆了）→ verify-captcha.mjs 期望 9 条红
node verify-captcha.mjs --server <拆掉校验的那份副本>        # 实测 10/9，退出码 1
# 前端：把「先 render 再注入明文令牌」改回「先注入再 render」→ verify-account-ui.mjs 期望 3 条红
```

实测：新版 `43/0`、`12/0`、`7/0`、人机验证 `19/0`、`id 一致性 9/0`、深链 `16/0`、账号页 `55/0`、首页 `33/0`、限流分支 `7/0`、旧契约 `56/0`、
后台 API `124/0`、后台页面 `167/0`、后台角色 `76/0`、线上后台 `40/0`（http+https）、
线上角色 `63/0`、**线上后台页面（账号通道）`34/0`**（那把是 2026-10-04 打公网入口测的；
加了人机验证之后公网入口跑不了它 —— 得挂 SSH 隧道，脚本开工前会把跑法打出来）、
**线上登录页人机验证 `11/0`**（`_live-captcha-ui.mjs`，真 Edge 打开 `https://cyanovo.top`：图解码出来了、
点「换一张」真的换、空着点登录本地就拦住不发请求）、**线上 `verify-live.mjs` `31/0`**；
对回退副本分别 `38/5`、`3/4`。账号页那次反向校验实测 **23/3**（红的正是明文那三条）；
`_reverse-boot.mjs` 往 app.js 里注入一句坏查找 → `verify-account-ui.mjs` 实测 **13 红**（含「boot 抛异常」与「空卡片」两条）；
`_reverse-admin-ui.mjs` 把 `public/` 切 3 刀 → **149/3，红的正好是预期的 3 条**（探针 exit 1）。
人机验证那轮的反向校验：把 `server.mjs` 里两处 `if (!cap.ok)` 改成 `if (false)`（等于把闸整个拆掉）
→ `verify-captcha.mjs` 实测 **10/9**，红的正好是"该被拦下却放行了"那 9 条，退出码 1。

**2026-10-04 安全审计那轮的反向校验**（钉住新增的 7 道闸，用的是**线上那份未打补丁的 `server.mjs`**，
md5 `a489e480db744a153a4de80dd5edb187`）：

```bash
scp cyanovo:/opt/dsh-web/server.mjs _sec-audit/_baseline-server.mjs
node verify-admin.mjs                                   # 123/0
node verify-admin.mjs --server ../_sec-audit/_baseline-server.mjs   # 105/18 ← 红的正好是新加的那 18 条
```

红的 18 条逐条对应：`/health` 仍泄 `{records,users}`、`/health/detail` 不存在、改密后旧 cookie 仍 `me!=null` 且 `/api/tokens` 仍 200、
同一张兑换码再兑仍 200（`proUntil` 0x…819200000 → 0x…424000000，**又叠了 7 天**）、
空 `id` 吊销仍 200 且真把令牌删了、cookie 无 `Secure`、12 次错密码全 401 无锁、40 次撞库无锁、注册也没被闸住、
反枚举 **45 ms vs 1 ms = 45 倍**。

⚠️ **`verify-admin-ui.mjs` 是唯一能看见 CSS 层叠的尺子**：字节比对与无头 DOM 桩在结构上都看不见"元素被样式盖住"
（本项目在 `[hidden]` 那次事故里已经吃过一次）。它用真 Edge + CDP 起一个真的 `dsh-web` 进程（`--server` / `--dir` 可指到别处），
断言里包含 `getComputedStyle` 与 `elementFromPoint` 命中测试。

## 域名与 HTTPS（2026-10-03 补上 443）

- `http://cyanovo.top`（80）：**给 QQ 用**。QQ 只认 `http://大写域名/路径` 这一种形式。
- `https://cyanovo.top`（443）：**给浏览器用**。Chrome/Edge 地址栏默认先试 https ——
  没有 443 时会直接显示"无法访问此网站"，用户只会说"网站打不开"（这就是 10-03 那次报障）。
- ⚠️ **80 绝不能重定向到 443**：那会把 QQ 里所有「查看完整回答」全部掐死。两条同时开着，各服务各的。
- ⚠️ **不加 HSTS**：加了浏览器会永久强制 https，QQ 内置浏览器点 http 链接可能被顶走。
- 证书在 `/etc/letsencrypt/live/cyanovo.top/`（ECDSA，`certbot.timer` 自动续期），
  nginx 配置：`/etc/nginx/sites-available/dsh-web-https`（443 → `127.0.0.1:8795`），
  80 那份在 `/etc/nginx/sites-available/agentrover`。备份：`/root/nginx-backup-20261003-1318.tgz`。

### 「完整回答」的两条网页路由（2026-10-03 补齐）

渲染服务在 `127.0.0.1:8790`，80 与 443 **两边都**把 `/dsh/<id>.md` 与 `/dsh/<id>.html` 转过去：

| 入口 | 改前 | 现在 |
|---|---|---|
| `http://…/dsh/<id>.html` | 200 | 200 |
| `https://…/dsh/<id>.html` | **404**（443 只有 `location /`） | **200** |
| `http://…/dsh/<id>.md` | **404**（80 只有 `.html` 一条） | **200** |
| `https://…/dsh/<id>.md` | 200 | 200 |

- 同一个 URL 换个协议一边有一边没有，是最容易被当成"网站坏了"的那种不一致，所以四格全部打通。
- 同时**删掉了 80 站点里那条 `add_header Cache-Control "public, max-age=300"`**：
  渲染服务自己已经回了一条，nginx 的 `add_header` 是**追加**语义，于是响应头变成
  `public, max-age=300, public, max-age=300`（重复值）。删掉后只剩一条，且缓存语义不变。

## 已知边界（不夸大）

1. 网页端有：首页落地页 + 记录 + 账号（额度/模式/兑换/设备码/令牌）+ **后台管理页**。兑换码现在后台页面就能发。
2. 首页（`data-view="overview"`）刻意是**静态 HTML**：不靠 JS 也读得全。额度/模式/兑换卡在「账号」页里。
3. `note-link` 档的链接指向云端记录页 `http://cyanovo.top/n/<id>`（要登录才能看正文）。
4. 没有在线支付：兑换码是手工发的。
5. 一台机、一个 JSON 文件、无备份策略；`MemoryMax=180M` 是已知的天花板（服务器 2026-10-04 起有 2G swap，
   但那是防崩的垫子，不算余量）。
6. 无头桩（`verify-deeplink.mjs` / `verify-account-ui.mjs`）证明的是**代码路径**，
   不证明排版在真浏览器/手机上好看 —— 那部分仍是"未验证"（`verify-landing.mjs` 只证明送出去的 HTML 是对的）。
7. 后台页面**在真机浏览器上仍未复看**（`verify-admin-ui.mjs` 用本机 headless Edge；线上那一层由
   `_live-admin.mjs` 的 40 条 HTTP 断言与 `_live-admin-ui.mjs` 的 34 条 headless 断言覆盖 ——
   后者确实打开了**线上** `/admin.html` 并用账号密码真进了后台，证明的是"这条路走得通 + 页面元素在"，
   不是排版，也不是手机）.
8. 后台口令目前是**单把**（无多管理员、无操作审计日志）；`admin-token` 一旦泄露就等于全部用户数据可见（正文除外）。
   但**账号管理员通道**已经是"每个管理员各自登录"的形态：给某个账号 `admin=true`，它就能用自己的密码进后台
   （`_live-role.mjs` 第 [9] 节实测：加管理员前 403 → 加完立刻能读概览与用户列表 → 取消后立刻又 403）。
