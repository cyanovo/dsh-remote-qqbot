# tests/live —— 要真实环境才跑得起来的一次性脚本

这里的脚本**不在 `npm test` 链里**。原因是它们都需要「真实的东西」才能跑：

- 真的中枢服务器（要网络 + 令牌）
- 真的装在 profile 里的插件产物（要先 `dsh plugin add`）
- 真的 QQ 长连接（要 AppID / ClientSecret）
- 真的在本机跑的 DSH 桌面版（19387 端口）

所以它们**不适合当 CI 门禁**，但排查问题、验收发布时很有用。

> ⚠️ 这些脚本会**造真实数据**（往中枢发事件、往 QQ 发消息、往 `agentmd/*.md` 追加日志）。
> 跑之前想清楚，跑完检查现场。

> ⚠️ **不重启 DSH = 没生效。** 装完插件后判定是否真的生效，方法是比时间：
> 安装目录 `lib/*.js` 的最大 mtime **早于** 桌面版进程的 StartTime 才算数。
> 只比 `lib/index.js` 一个文件会骗人（`build` 会跳过未改动的文件）。

---

## 脚本清单

| 脚本 | 需要什么 | 干什么 |
|---|---|---|
| `loader-boot.mjs` | 真实 Cordis 容器 | 真实启动插件树 + 走 Config 校验路径 |
| `installed.test.mjs` | profile 里装好的包 | 验证产物能 import、依赖能解析、4 个工具注册成功 |
| `inject-analysis.mjs` | 无（只读源码） | 注入体量与 order 合理性分析 |
| `e2e-real.mjs` | 真实 settings + 真实中枢 | 端到端：读配置 → 发事件 → 真实文件追加 |
| `e2e-settings.mjs` | 真实 settings | settings 读写语义实况 |
| `hub-connectivity.mjs` | 真实中枢 | 连通性（真发 HTTP） |
| `qq-live.mjs` | QQ 凭据 | 长连接实况 |
| `qq-send.mjs` | QQ 凭据 | 真发一条消息 |
| `dsh-api.mjs` | 本机桌面版 | 本机 `/api` 客户端探针 |
| `verify-final.mjs` | 全部 | 收尾综合核对 |
| `_hub-config.mjs` | — | **共享工具**（不是可执行脚本）：令牌解析 |

## 令牌解析约定

涉及中枢的脚本（`hub-connectivity.mjs`、`loader-boot.mjs` 等）**不硬编码令牌**，
统一用 `_hub-config.mjs`，按这个顺序解析：

```
--token=<值>  →  环境变量 DSH_NOTIFY_TOKEN  →  ~/.dsh/settings.yaml
```

都读不到就**跳过、打印中文提示、退出码 0**（不算失败）。
这样主人轮换令牌之后脚本依然可用，也不会把令牌写进版本库。

## 路径约定

这些脚本原本住在 `tests/` 根目录，2026-10-02 统一挪进 `tests/live/`。
所以里面的相对路径都是 `../../src/...`（多一层）。新加脚本请照抄这个深度。

## 不在这里的正式工具

发布验收请用 `scripts/` 下这两个（它们是**正式**脚本，不是一次性的）：

```powershell
node scripts/verify-installed.mjs      # 五节：加载 + 真实函数行为（QQ 链接改写、/status 排版、挑会话与当前会话指针、**真抓一张屏**、开关落盘）
node scripts/verify-ui-installed.mjs   # lib 全部哈希 + 版本 + client.js 字面 + config-api 真实调用
```
