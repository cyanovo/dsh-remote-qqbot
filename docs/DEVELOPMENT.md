# 开发

> 测试链、构建与打包、代码结构，以及必须遵守的加载期与配置期约束。

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

## 代码结构

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

## ⚠️ 四条必须遵守的加载/配置期约束

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

## 配置生效自检

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

## 怎么验证插件真的能加载（别只看「安装成功」）

```powershell
# 建一个一次性 headless profile 做真实 loader 启动，看日志里有没有 [remote-qqbot] 已就绪
dsh plugin --profile verifyheadless add <tgz>
dsh --profile verifyheadless "1+1等于几"
```

**安装成功 ≠ 加载成功。** v0.1.0（import 了 dsh-settings）与 v0.2.0（Config 用了普通
JSON Schema）都是「pnpm 装得好好的、一启动就报错」。只有真实启动一次才算数。

---

[← 回到 README](../README.md)
