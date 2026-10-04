# 服务端（可选）

这个目录里是两个零依赖的 Node 服务，合起来提供插件「完整回答」那条云端链路。
**不部署也能用插件** —— 默认模式下正文切成几条直接发进 QQ，一个字节都不过服务器。

| 服务 | 干什么 | 监听 | 作者实例的部署位置 |
|---|---|---|---|
| [dsh-web](dsh-web/) | 账号 / 额度 / 兑换码 / 记录 / 完整回答网页，以及配套 API | `127.0.0.1:8795` | `/opt/dsh-web` |
| [dsh-notes-render](dsh-notes-render/) | 把落盘的 markdown 渲染成网页，让 QQ 里点开的链接能直接读 | `127.0.0.1:8790` | `/opt/dsh-notes-render` |

两个服务都只监听本机，公网入口由 nginx 反代：80 与 443 都进 8795，`/dsh/` 进 8790。
作者的实例跑在 `cyanovo.top`（插件里 `cloudBaseUrl` 默认指向它）；
你在自己的机器上部署时要换成自己的域名。

## 本地跑起来

两个服务都不需要 `npm install`（只用 Node 内置模块），Node ≥ 20：

```bash
# 完整回答网页：默认 8795。改成别的端口/数据目录，别动线上那份
DSH_WEB_PORT=8795 DSH_WEB_DATA=/tmp/dsh-web-data node server/dsh-web/server.mjs

# markdown 渲染服务：默认 8790，笔记目录用 NOTES_DIR 指定
NOTES_DIR=/tmp/dsh-notes node server/dsh-notes-render/server.mjs
```

回环自测（另开一个终端）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8795/
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:8790/dsh/<id>.md
```

各目录里的 `verify-*.mjs` 是验收脚本，可以直接 `node <脚本>` 跑。需要管理员令牌或线上地址的那些，
凭据一律从环境变量取（`ADMIN_TOKEN` / `OWNER_PASS` 等），脚本里不写死任何凭据。

## 部署到自己的服务器

`dsh-web/deploy.sh` 是幂等脚本：装 systemd 单元、建数据目录、起服务，逐条说明见
[dsh-web/README.md](dsh-web/README.md)；渲染服务见 [dsh-notes-render/README.md](dsh-notes-render/README.md)。

这两份 README 原本是作者自用服务器的操作记录，里面会出现主机别名、`/opt/...` 之类的本地约定，
照着自己的环境替换即可。

## 公开部署前请自己决定的事

- 这两个服务会**接公网**：额度、兑换码、后台口令、限流都要按「对手会来打」设计，别沿用自用尺度。
- `dsh-web` 的后台口令落在数据目录里一个 `0600` 的文件中，由你写入或首次启动生成。
- 插件侧的 `cloudEnabled` 默认关闭，所以云端挂了也不影响本地功能。
