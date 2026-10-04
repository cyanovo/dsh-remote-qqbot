# dsh-notes-render · 「查看完整回答」的渲染服务

插件把一轮完整回答落盘成 `/var/www/dsh-notes/<id>.md` 之后，这个服务负责**把那段 Markdown 渲染成排版好的 HTML**，
让手机 QQ 里点开的那条链接真的能读 —— 而不是弹一个「如需预览请用浏览器打开」。

> **联系方式（作者）**：QQ **1103416608** ｜ GitHub **[@cyanovo](https://github.com/cyanovo)**
> 仓库总览见 [../README.md](../README.md)。

## 它解决的具体问题

QQ 客户端看到 `.md` 后缀会当成**文件**（弹"用浏览器打开"），只有 `.html` 才走**内置浏览器**渲染。
所以链接得是 `.html`，但历史上已经发出去的旧链接是 `.md`，两个都得能打 —— 于是：

```
/dsh/<id>.html  ← 现在发出去的链接（QQ 内置浏览器直接渲染）
/dsh/<id>.md    ← 兼容旧链接，同样返回渲染好的 HTML
/dsh/raw/<id>.md ← 真正的纯文本原文（排查用）
```

**URL 一直不变**：页面由本服务渲染，链接形态没改过，老消息里的链接永远有效。

## 跑在哪

| 项 | 值 |
|---|---|
| 监听 | `127.0.0.1:8790`（仅本机；外网由 nginx `location /dsh/` 反代进来） |
| 笔记目录 | `/var/www/dsh-notes`（`NOTES_DIR` 可覆盖） |
| systemd | `dsh-notes-render.service`（`systemctl {status,restart} dsh-notes-render`） |
| 代码位置 | 服务器 `/opt/dsh-notes-render` |

nginx 侧同时存在于 80 与 443 两个站点（入口映射见 [server/README.md](../README.md)），
**80 端口故意不做 80→443 跳转** —— 因为 QQ 只认 `http://大写域名/路径` 这一种形式。

## 文件

| 文件 | 作用 |
|---|---|
| `server.mjs` | 服务本体：取 `<id>.md` → 渲染 HTML（含 `repairFlattened` 尽力还原被压平的 md） |
| `apply.sh` | **历史**部署脚本（重启服务 + 改 nginx + 校验，失败自动回滚）。它里面还写着 8444/hub/面板这些**已下线的旧组件**，跑之前先对照当前 nginx 实际配置 |
| `patch-nginx.mjs` / `patch-qq-preview.mjs` | 定点改写 nginx 配置（"命中数必须恰好 1"，找不到原文就中止，不整文件重写） |
| `check-urlsec.mjs` | 校验链接里的签名/时效 |
| `verify-qq-preview.mjs` / `probe*.sh` / `send-link-probe*.mjs` | QQ 预览行为的探针与验收脚本 |

## 改它的时候注意

- 渲染是**只读**的：它不改笔记，只读 `<id>.md`。
- 改完 `server.mjs` 要 `systemctl restart dsh-notes-render` 才生效（长驻进程，和 DSH 插件一个道理）。
- 线上验收走真链路：`curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:8790/dsh/<id>.md`
  应返回 `200 text/html`；`/dsh/raw/<id>.md` 返回 `text/plain`。
