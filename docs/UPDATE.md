# 远程更新

插件把「有新版本」和「装新版本」都放在 QQ 里：有新版本主动提醒一次，回一个 `/update` 就装上，
装完自动重启 DSH（DSH 没有插件热重载，不重启不生效）。

| 指令 | 作用 |
|---|---|
| `/update`（也认 `/更新`） | 检查并安装最新版，装完走自动重启 |
| `/update check` | 只检查，不安装 |

## 用户看到的过程

1. 插件定期查更新源（`qqUpdateCheckHours`，默认 6 小时；进程启动时也查一次）。
2. 远端版本号**更高**时，QQ 里收到一条提醒，写明新版本号与当前版本号，并说明装完会自动重启。
   同一个版本只提醒一次；已经是最新版、或远端版本比本机低，一律不吭声、也绝不安装。
3. 回 `/update`：从更新源拿到安装地址，交给桌面版自带的运行时安装。
4. 安装成功回一条 `✅ 已装 x.y.z（原来是 a.b.c）`，随后自动重启 DSH。
   这一步的文案里带兜底动作：**过一分钟还没回来，手动打开一次 DSH 就行**。
   插件自己会被这次重启杀掉，没法当场汇报结果，所以这句必须提前说。
5. 重启后（自动或手动都算）回一条 `✅ 重启完成，插件现在是 x.y.z`。
   这条回执靠状态文件里的一个重启标记实现，因此手动重启也能收到。

关掉 `qqUpdateAutoRestart` 就只回一句「重启后生效」，由你自己挑时间重启。
关掉 `qqUpdateEnabled` 只是不提醒，发 `/update` 照样能更新。

## 更新源的三种写法（`qqUpdateSource`）

默认值是作者服务器上的版本索引：

```
https://cyanovo.top/plugins/dsh-remote-qqbot/update.json
```

| 写法 | 版本号从哪来 | 安装地址 |
|---|---|---|
| `https://…/update.json` | 这个 JSON 的 `version` | JSON 里的 `url` |
| `github:作者/仓库`（可带 `#分支`） | `api.github.com` 的 contents API 读仓库里的 `package.json` | GitHub 仓库本身（`lib/` 已入库，装完即可用） |
| npm 包名，例如 `dsh-remote-qqbot` | npm registry 上的 latest | npm registry |

GitHub 写法走未认证的公开接口，同一个 IP 每小时有次数上限（约 60 次）；
查得太勤会拿到 403，插件会把它当成「这次没查到」并写进日志，不会误报有新版本。

## 版本索引的格式

一个静态 JSON 文件，字段如下（`scripts/publish-update.mjs` 会按这个格式生成）：

```json
{
  "name": "dsh-remote-qqbot",
  "version": "1.0.11",
  "url": "https://example.com/plugins/dsh-remote-qqbot/dsh-remote-qqbot-1.0.11.tgz",
  "sha256": "956cc2fd1f69f355b01f57cee9be7a32a8c82cd431c45729b8f3b0f13fbfa0ce",
  "size": 239800,
  "at": "2026-10-04T23:34:14.500Z",
  "notes": "这个版本改了什么"
}
```

- 只有 `version` 与 `url` 是必须的。缺 `version` 会被明确拒绝（例如把地址写成了压缩包本身）。
- `sha256` 目前用于人工核对与发布脚本上传后的回读校验，插件不校验压缩包哈希；
  压缩包本身的完整性由 pnpm 安装时记在 lockfile 里的记录来管。
- `notes` 不会发到 QQ（提醒只写版本号），它留在索引里给人看。

## 自己搭一个通道

把版本索引与压缩包放在任意 HTTPS 静态托管上即可，两条要求：

1. **地址稳定**：`qqUpdateSource` 指向索引文件，索引里的 `url` 指向压缩包；两个都可以是完整 URL。
2. **不要被缓存**：索引要带上 `Cache-Control: no-store`，否则可能读到上一个版本，
   于是「明明发了新版，却一直说已是最新」。插件请求时也会带 `cache-control: no-cache`，
   但中间层不认这个头时只能靠服务端的 `no-store`。

nginx 的例子（放在已有站点里的一个 `location`）：

```nginx
location /plugins/ {
  alias /var/www/dsh-plugins/;
  limit_except GET HEAD { deny all; }
  add_header Cache-Control "no-store";
}
```

发版的顺序是**先传压缩包，最后覆盖索引文件** —— 反过来会出现「索引已经指向新版本、压缩包还没传完」
的窗口，那一刻点 `/update` 会失败。仓库里的 `scripts/publish-update.mjs` 就是按这个顺序做的，
并且在覆盖索引后回头读一遍，核对版本号与 sha256。

## 自动重启做了什么

更新装完后，插件写一个 PowerShell 脚本并脱离当前进程启动它，脚本负责：

1. 先把日志写下来（日志增长 = 脚本真的跑起来了，这是插件唯一能确认它启动的方式）；
2. 清掉从插件进程继承来的一组环境变量（见下）；
3. 按可执行文件路径找到正在跑的 DSH 进程，结束它，并等它真正退出；
4. 依次尝试三种启动方式（`Start-Process`、资源管理器壳、WMI），每种方式启动后用两套量具确认进程真的起来了，
   再观察 4 秒确认它没秒退；一次不成就整体重试，最多 3 轮；
5. 全部失败时写「重启失败：请手动打开 DSH」，并把退出码与桌面端崩溃日志的尾部一起写进日志。

日志在 `~/.dsh/dsh-remote-update.log`，每次更新与重启的每一步都追加在里面。

## 出问题怎么查

先看 `~/.dsh/dsh-remote-update.log`，再对着下表：

| 现象 | 大概率原因 | 怎么办 |
|---|---|---|
| 一直说已是最新版，但确实发了新版 | 索引被缓存，或索引没被覆盖 | 打开索引地址确认 `version`；服务端加 `Cache-Control: no-store` |
| `/update` 回「远端返回的不是 JSON」 | 更新源写成了压缩包地址或别的东西 | 指向 `update.json` 这一层 |
| 回「这个更新源我不认识」 | 三种写法都不匹配 | 用完整 https 地址、`github:作者/仓库` 或 npm 包名 |
| 更新装上了，但重启后还是旧版本号 | 装到了别的 profile，或重启没起来 | 看日志里「更新完成（更新到 x）」与「重启」两段；确认 profile 对了（桌面版是 `desktop`） |
| 通知说会重启，但 DSH 一直没回来 | 自动重启失败 | 手动打开一次 DSH；日志里有退出码与崩溃日志尾部，用它定位 |
| 重启后没收到确认 | 重启标记文件被删，或 QQ 通道没连上 | 看 `/status`；手动重启也会有确认，前提是状态文件还在 |

## 两个 Windows 上的坑（1.0.10 / 1.0.11 修）

- **继承来的 `ELECTRON_RUN_AS_NODE`**：插件跑在桌面版的 host 子进程里，而 host 是「把 Electron
  当 node 用」启动的，所以插件进程带着这个变量。它会顺着 插件 → cmd → PowerShell → `Start-Process`
  一路传下去，于是新起的 `DeepSeek Harness.exe` 只会当 node 跑一下就退出，桌面版根本没启动 ——
  表现是「进程列表里什么都没有、也没有崩溃日志」。现在启动前先清掉这一类继承变量。
- **刚创建的进程读不到 `.Path`**：只认 `Get-Process` 的 `.Path` 会把「已经起来了」误判成「没起来」，
  于是反复重试、把好好的进程杀掉重来。现在用 CIM 的 `ExecutablePath` 兜底。

## 已知边界

- 更新过程会杀掉当前 DSH 进程，包括正在跑的会话：QQ 会在十几秒内没有响应，正在执行的回合会被中断。
- 自动重启只在 Windows 上做过实现与实测；其他平台上会走到「重启失败，请手动打开」这一条。
- 不校验压缩包的 sha256，见上文「版本索引的格式」。
