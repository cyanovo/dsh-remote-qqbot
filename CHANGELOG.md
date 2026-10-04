# 更新日志

本仓库从 **1.0.4** 起公开；更早的版本只在作者本机使用，没有对外发布过。

## 1.0.4 — 2026-10-04

插件：

- 完整回答分三档：`chat`（默认，切条直接发进 QQ）、`note`、`note-link`；总闸 `cloudEnabled` 默认关闭
- QQ 侧档位名统一为「免费版 / 付费版」，与网页端一致
- `npm test` 16 组测试，其中包含 `lib/`（入库的构建产物）与 `src/` 的一致性校验

服务端：

- `dsh-web` 网页端与后台文案重写为中性说明体，档位名与插件统一
- `dsh-notes-render` 同时提供 `/dsh/<id>.html`、兼容旧链接的 `/dsh/<id>.md` 与纯文本 `/dsh/raw/<id>.md`

文档：

- README 收敛为落地页，配置、接入 QQ、完整回答、协作、agentmd、开发各自拆到 `docs/`
- README 增加网站入口（<https://cyanovo.top>）：完整回答在网页端阅读，QQ 里只留短链接
