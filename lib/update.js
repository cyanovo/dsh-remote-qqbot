/**
 * 远程更新 —— 「查有没有新版本 / 装上新版本 / 重启 DSH」的全部逻辑。
 *
 * 为什么单独一个文件：这一段最危险（要起子进程、要杀 DSH 主进程），
 * 而它同时几乎全是**可以当纯函数测**的东西 —— 源解析、版本比较、命令拼装、
 * PowerShell 脚本拼装、面向用户的文案。所以这里不直接碰任何外部状态：
 * fetch / spawn / fs / 时钟**全部可注入**，`tests/update.test.mjs` 因此能在
 * **不联网、不起进程**的前提下把每处判断钉住。
 *
 * 三条设计约束（都是踩过坑才写下来的）：
 *
 * 1. **绝不对主流程抛异常。** 更新是"顺手做的事"，网络不通、源没发新版、
 *    pnpm 卡住、PowerShell 被杀……任何一种都只能记日志 + 回一句人话。
 *    所以这里每个可能失败的动作都返回 `{ ok:false, error }`，而不是 throw。
 *
 * 2. **子进程的输出必须重定向到文件，不能用管道。** Windows 沙箱下
 *    `stdio: 'pipe'` 会让子进程直接 EPERM（本项目已实测）。所以安装命令
 *    写成 `stdio: ['ignore', fd, fd]`，跑完再把文件读回来。
 *
 * 3. **Windows 上不能直接 spawn `.cmd`。** `dsh` 在本机是
 *    `C:\Users\cyan\.dsh\bin\dsh.cmd`，而 Node 从 18.20 / 20.12 起为了修
 *    CVE-2024-27980，**拒绝在没有 shell 的情况下 spawn `.cmd` / `.bat`**
 *    （报 EINVAL）。所以 Windows 分支统一走 `cmd.exe /c <命令>`。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * 默认更新源：**自己服务器上的版本索引**（nginx 直出的静态文件）。
 *
 * 为什么不用 GitHub：插件还在测试期，发一次版就在仓库里留一条提交，主人不要这种历史；
 * 而且本机到 github.com / raw.githubusercontent.com 的连接不稳（后者直接被重置）。
 * 索引里除了版本号还给出压缩包地址与 sha256，插件拿到地址直接 `pnpm add <地址>`。
 * 想换回 GitHub 把这个字符串改成 `github:作者/仓库` 即可 —— 解析器三种形态都认。
 */
export const DEFAULT_UPDATE_SOURCE = 'https://cyanovo.top/plugins/dsh-remote-qqbot/update.json'

/** 装新版本最多等这么久（默认 180 秒，见配置说明）。 */
export const UPDATE_INSTALL_TIMEOUT_MS = 180 * 1000

/** 查版本是个小请求，超时要短 —— 不然一次卡住的检查会拖着后面的轮询。 */
export const UPDATE_CHECK_TIMEOUT_MS = 20 * 1000

/** 更新完等多久再重启：留出「回执已经发到 QQ」的时间，别把回执和进程一起杀掉。 */
export const RESTART_DELAY_SECONDS = 10

/** 启动失败重试次数与间隔。 */
export const RESTART_RETRIES = 3
export const RESTART_RETRY_DELAY_SECONDS = 5

/** 杀进程后最多等多久确认它真的没了。 */
export const RESTART_KILL_WAIT_SECONDS = 20

/** 旧进程全没了之后，再多等几秒让退出流程与单实例锁彻底释放。 */
export const RESTART_SETTLE_SECONDS = 3

/** 每次启动尝试后，最多等多久看到桌面版进程。 */
export const RESTART_START_VERIFY_SECONDS = 8

/** 看到进程之后再盯这么久，确认它不是"起来又秒退"（单实例抢锁失败就是这样）。 */
export const RESTART_HOLD_VERIFY_SECONDS = 4

/**
 * 重启脚本启动新进程前**必须清掉**的继承环境变量。
 *
 * 🔴 这是 2026-10-05 那次「/update 装好了但 DSH 没自己回来」的根因，实测结论：
 * 插件跑在桌面版的 host 子进程里，而 host 是**把 Electron 当 node 用**跑起来的，
 * 所以插件进程（以及它派生的一切）都带着 `ELECTRON_RUN_AS_NODE=1`。这个变量会一路
 * 传到 `Start-Process` 启动的新进程 —— 带着它的 `DeepSeek Harness.exe` 只会当 node
 * 跑一下就退出（实测 `DeepSeek Harness.exe --version` 输出 `v24.18.1`，退出码 0），
 * 桌面版根本没启动：没有进程、没有 lockfile、没有崩溃日志，脚本那边只看到
 * "启动后没看到进程"。主人手动双击能起来，是因为 explorer 的环境里没有这个变量。
 *
 * 后面几个是**这次会话自己的标记**（host 注入给子进程的），新开的桌面版不该继承一份
 * 已经死掉的会话的上下文。
 */
export const RESTART_POISON_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'NODE_OPTIONS',
  'DSH_SHELL',
  'DSH_SESSION_ID',
  'DSH_WEB_URL',
]

/**
 * 拉起重启脚本后，最多等这么久确认**它真的在跑**。
 *
 * 为什么要等：`spawn` 成功只代表进程建出来了。本机实测（2026-10-05）直接
 * `spawn('powershell.exe', …, {detached:true})` 时子进程**一行都不执行**，
 * 而不分离时它又活不过父进程结束 —— 也就是说"进程建出来了"和"脚本在跑"是两回事。
 * 脚本第一件事就是往日志里写一行，所以"日志长出来了"才是证据。
 * 这个等待发生在脚本自己的 10 秒延迟之内，不影响回执发出。
 */
export const RESTART_VERIFY_TIMEOUT_MS = 4 * 1000

/** 失败时给用户看的错误摘要最多这么多字符（取**最后**一段，错误原因通常在最末尾）。 */
export const ERROR_TAIL_CHARS = 600

/** 重启脚本的日志文件名（放 ~/.dsh/ 下）。 */
export const UPDATE_LOG_FILE_NAME = 'dsh-remote-update.log'

// ── 版本号 ──────────────────────────────────────────────────────────────────

/**
 * 规范化版本号：去掉 `v` / `V` 前缀与首尾空白。
 *
 * npm 与 GitHub 上两种写法都见过（`v1.0.7` / `1.0.7`），比较前必须抹平，
 * 否则 `v1.0.7` 会被当成"不认识的版本"而漏掉真正的更新。
 */
export function normalizeVersion(input) {
  return String(input ?? '').trim().replace(/^[vV]/, '')
}

/**
 * 拆开一个版本号：`1.0.10-rc.1` → `{ core: [1,0,10], pre: ['rc','1'] }`。
 *
 * 自己拆而不用依赖：插件对宿主要求"零外部依赖"，为了比较版本号引一个 semver
 * 包（还要考虑它在 profile 里装不装得上）不值得。
 */
function splitVersion(input) {
  const text = normalizeVersion(input)
  if (text === '') return { core: [], pre: [], valid: false }
  // 构建元数据（`+sha`）不参与比较，按 semver 直接丢掉。
  const [main = '', ...preParts] = text.split('+')[0].split('-')
  const core = main.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN))
  const pre = preParts.join('-').split('.').filter((part) => part !== '')
  const valid = core.length > 0 && core.every((n) => Number.isFinite(n))
  return { core, pre, valid }
}

/** 比较 pre-release 标识符：数字按数字比，其余按字符串比（semver 的规定）。 */
function comparePreIdentifiers(a, b) {
  const na = /^\d+$/.test(a)
  const nb = /^\d+$/.test(b)
  if (na && nb) return Math.sign(Number(a) - Number(b))
  if (na) return -1 // 数字标识符优先级低于字母标识符
  if (nb) return 1
  return a === b ? 0 : (a < b ? -1 : 1)
}

/**
 * 比较两个版本号：`a` 比 `b` 新返回 1，旧返回 -1，相同返回 0。
 *
 * 必须支持 `1.0.10 > 1.0.9`（**按数字段比，不是按字符串比** —— 字符串比会得出
 * `"1.0.9" > "1.0.10"` 这个错误结论），并容忍 `v` 前缀与 `-rc.1` 这种后缀。
 * 带 pre-release 的版本按 semver 排在**同号正式版之前**（`1.0.7-rc.1 < 1.0.7`）。
 */
export function compareVersions(a, b) {
  const va = splitVersion(a)
  const vb = splitVersion(b)
  // 认不出来的版本号一律当 0 处理：宁可多提醒一次，也不要因为一个畸形字符串
  // 把真正的更新判成"没有新版本"。
  if (!va.valid && !vb.valid) return 0
  if (!va.valid) return -1
  if (!vb.valid) return 1

  const len = Math.max(va.core.length, vb.core.length)
  for (let i = 0; i < len; i += 1) {
    const x = va.core[i] ?? 0
    const y = vb.core[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }

  if (va.pre.length === 0 && vb.pre.length === 0) return 0
  if (va.pre.length === 0) return 1 // 正式版 > 预发布版
  if (vb.pre.length === 0) return -1
  const preLen = Math.max(va.pre.length, vb.pre.length)
  for (let i = 0; i < preLen; i += 1) {
    const x = va.pre[i]
    const y = vb.pre[i]
    if (x === undefined) return -1 // 前缀相同则短的更小
    if (y === undefined) return 1
    const cmp = comparePreIdentifiers(x, y)
    if (cmp !== 0) return cmp
  }
  return 0
}

/** `candidate` 是不是比 `current` 新（当前版本读不出来时也认新）。 */
export function isNewerVersion(candidate, current) {
  if (String(candidate ?? '').trim() === '') return false
  return compareVersions(candidate, current) > 0
}

// ── 更新源 ──────────────────────────────────────────────────────────────────

/** GitHub 仓库页 → API 的 contents 地址（`raw.githubusercontent.com` 在本机被重置，用不了）。 */
function gitHubPackageUrl(repo, ref) {
  const base = `https://api.github.com/repos/${repo}/contents/package.json`
  return ref ? `${base}?ref=${encodeURIComponent(ref)}` : base
}

/**
 * 解析更新源。三种形态：
 *   - `https://…/update.json`                 → 版本索引（**默认**，自己服务器上的静态文件）
 *   - `github:cyanovo/dsh-remote-qqbot[#ref]` → 版本检查走 api.github.com 的 contents API
 *   - npm 包名（可带 `@scope/`、可带 `@版本`）  → 版本检查走 registry.npmjs.org/<包名>/latest
 *
 * 索引形态下**压缩包地址由远端给**（插件没法从索引地址猜出包在哪），所以这里
 * `spec` 先原样留着索引地址；真正交给 `pnpm add` 的地址由 `fetchLatestVersion`
 * 从索引里读出来，放在它返回值的 `spec` 上。
 *
 * ⚠️ 为什么不支持任意 git URL：那种写法没法**可靠地**推出"去哪儿看版本号"，
 *    与其猜一个 URL 出来发请求，不如明确告诉用户"这个源我不认识"。
 *
 * @param {string} source - 配置里的 `qqUpdateSource`。
 * @returns {{ok: true, kind: 'manifest'|'github'|'npm', spec: string, name: string, repo?: string, ref?: string, checkUrl: string}
 *   | {ok: false, error: string}}
 */
export function parseUpdateSource(source) {
  const raw = String(source ?? '').trim()
  if (raw === '') return { ok: false, error: '更新源是空的' }

  // ① 版本索引：一个 http(s) 地址，返回 JSON（版本号 + 压缩包地址 + 可选 sha256）。
  //    要求带 `/` 与主机名，避免把 `github:…` 这类写法误判进来（它不以 http 开头，不会命中）。
  if (/^https?:\/\/\S+$/i.test(raw)) {
    return { ok: true, kind: 'manifest', spec: raw, name: '', ref: '', checkUrl: raw }
  }

  // ② GitHub 仓库。
  const gh = /^github:([^/\s#]+)\/([^/\s#]+?)(?:#(\S+))?$/.exec(raw)
  if (gh) {
    const [, owner, repo, ref] = gh
    const repoFull = `${owner}/${repo}`
    return {
      ok: true,
      kind: 'github',
      spec: raw,
      name: repo,
      repo: repoFull,
      ref: ref ?? '',
      checkUrl: gitHubPackageUrl(repoFull, ref ?? ''),
    }
  }

  // npm 包名：可选 scope（`@scope/`）+ 包名 + 可选 `@版本`。
  const npm = /^(@[^/\s@]+\/[^/\s@]+|[^/\s@]+)(?:@(\S+))?$/.exec(raw)
  if (npm && !raw.startsWith('github:')) {
    const [, name] = npm
    return {
      ok: true,
      kind: 'npm',
      spec: raw,
      name,
      ref: npm[2] ?? '',
      checkUrl: `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
    }
  }

  return {
    ok: false,
    error: `这个更新源我不认识：「${raw}」。支持 https 版本索引地址、github:作者/仓库、npm 包名三种写法`,
  }
}

/**
 * 从**版本索引**里取版本号，并顺手校验这份索引能不能用。
 *
 * 🔴 为什么校验要写得这么细：宿主的站点是单页应用，nginx 对"没有扩展名的未知路径"
 * 会回首页 HTML 且状态码是 200（本机实测过）。要是只看 `res.ok`，某天索引文件传丢了
 * 就会把首页当索引解析，然后去"安装"一个不存在的地址。所以这里要求：必须是对象、
 * 必须有 `version`、必须有 http(s) 的 `url`。
 *
 * @param {unknown} json - 索引内容。
 * @returns {string} 版本号。
 * @throws {Error} 索引不合法时抛出（中文原因，直接给用户看）。
 */
export function versionFromManifestResponse(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('远端返回的不是版本索引（要一个 JSON 对象）')
  }
  const version = String(json.version ?? '').trim()
  if (version === '') {
    throw new Error('远端索引里没有 version —— 地址要指向 update.json 这类版本索引文件')
  }
  const url = String(json.url ?? '').trim()
  if (url === '') throw new Error('远端索引里没有 url（压缩包地址）')
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`远端索引里的 url 不是 http(s) 地址：${url}`)
  }
  return version
}

/** 从 GitHub contents API 的响应里取版本号（内容 base64，见官方 API）。 */
export function versionFromGitHubResponse(json) {
  const content = json?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(json?.message ? `GitHub 说：${json.message}` : '响应里没有 package.json 内容')
  }
  const text = Buffer.from(content, json?.encoding === 'base64' || !json?.encoding ? 'base64' : 'utf8')
    .toString('utf8')
  const pkg = JSON.parse(text)
  const version = String(pkg?.version ?? '').trim()
  if (version === '') throw new Error('远端 package.json 里没有 version')
  return version
}

/** 从 npm registry 的 `/latest` 响应里取版本号。 */
export function versionFromNpmResponse(json) {
  const version = String(json?.version ?? '').trim()
  if (version === '') throw new Error('npm 返回里没有 version')
  return version
}

/**
 * 查远端最新版本。**永不抛异常**：失败返回 `{ok:false, error}`，由调用方记日志。
 *
 * @param {object} options
 * @param {string} options.source - 更新源（配置里的 `qqUpdateSource`）。
 * @param {Function} [options.fetchImpl] - 注入用（测试里给假 fetch，绝不联网）。
 * @param {number} [options.timeoutMs] - 请求超时。
 * @param {Function} [options.log] - 日志函数。
 * @returns {Promise<{ok: boolean, version?: string, kind?: string, url?: string, spec?: string, sha256?: string, error?: string}>}
 *   `spec` 是**真正拿去安装**的那个字符串：索引源是从索引里读出来的压缩包地址，
 *   github / npm 源就是配置里那个字符串本身。
 */
export async function fetchLatestVersion({
  source, fetchImpl = globalThis.fetch, timeoutMs = UPDATE_CHECK_TIMEOUT_MS, log = () => {},
} = {}) {
  const parsed = parseUpdateSource(source)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  if (typeof fetchImpl !== 'function') return { ok: false, error: '这个环境里没有 fetch' }

  try {
    const res = await fetchImpl(parsed.checkUrl, {
      headers: {
        // GitHub 不接受没有 User-Agent 的请求（会回 403）。
        'user-agent': 'dsh-remote-qqbot',
        accept: parsed.kind === 'github' ? 'application/vnd.github+json' : 'application/json',
        // 索引要每次都拿最新的：中间任何一层把旧索引缓存住，主人就再也看不到新版了。
        ...(parsed.kind === 'manifest' ? { 'cache-control': 'no-cache' } : {}),
      },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (res?.ok === false) {
      return { ok: false, error: `请求失败（HTTP ${res.status ?? '?'}）`, url: parsed.checkUrl }
    }
    const json = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text())
    const version = parsed.kind === 'github'
      ? versionFromGitHubResponse(json)
      : parsed.kind === 'npm'
        ? versionFromNpmResponse(json)
        : versionFromManifestResponse(json)
    const spec = parsed.kind === 'manifest' ? String(json?.url ?? '').trim() : parsed.spec
    const sha256 = parsed.kind === 'manifest' ? String(json?.sha256 ?? '').trim() : ''
    return {
      ok: true, version: normalizeVersion(version), kind: parsed.kind, url: parsed.checkUrl, spec, sha256,
    }
  } catch (err) {
    const raw = String(err?.message ?? err)
    const message = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）`
      // 索引地址写错时最可能拿到一份 HTML（宿主的站点对未知路径回首页，状态码还是 200），
      // 这时 Node 报的是 JSON 解析错 —— 得翻译成人话，不然主人看不懂。
      // 只有**真的解析不出来**（JSON.parse / res.json() 抛的 SyntaxError）才翻译成人话；
      // 字段校验抛的是普通 Error，它的原因更具体（缺 version / 缺 url），原样透出去。
      : (parsed.kind === 'manifest' && err?.name === 'SyntaxError'
        ? '远端返回的不是 JSON —— 这个地址要指向版本索引文件（比如 update.json），确认地址没写错、文件也真的在'
        : raw)
    log(`查新版本失败（${parsed.checkUrl}）：${message}`)
    return { ok: false, error: message, url: parsed.checkUrl }
  }
}

// ── 自己装在哪儿（反推 profile）──────────────────────────────────────────────

/**
 * 从**当前加载的这个文件**推出它是装在哪个 profile 里的。
 *
 * 为什么不读配置/环境变量：profile 名字是 DSH 自己的概念，插件没有"我在哪个 profile"
 * 这个入参。但安装路径里带着它，而且 pnpm 会把真实文件放进
 * `profiles/<名字>/node_modules/.pnpm/…`、再用符号链接指过去 —— 所以不能只看
 * `node_modules` 的上一级，必须**从路径里找 `profiles` 这一段**：
 *
 *   C:\Users\cyan\.dsh\profiles\desktop\node_modules\dsh-remote-qqbot\lib\update.js
 *   C:\…\profiles\desktop\node_modules\.pnpm\file+…\node_modules\dsh-remote-qqbot\lib\update.js
 *                                              ↑ 两种形态都能落到 desktop
 *
 * @param {string} file - 本模块的文件路径（`fileURLToPath(import.meta.url)`）。
 * @returns {{profileDir: string, profileName: string}|null} 推不出来时返回 null。
 */
export function resolveProfileFromPluginFile(file) {
  const text = String(file ?? '').trim()
  if (text === '') return null
  const segments = text.split(/[\\/]+/)
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    if (segments[i].toLowerCase() !== 'profiles') continue
    const profileName = segments[i + 1]
    if (!profileName) continue
    const head = segments.slice(0, i + 2).join(path.sep)
    return { profileDir: head, profileName }
  }
  return null
}

/** 插件根目录（`…/node_modules/dsh-remote-qqbot`）：本文件在 `lib/` 或 `src/` 下，往上两层。 */
export function pluginRootFromFile(file) {
  const text = String(file ?? '').trim()
  if (text === '') return ''
  return path.dirname(path.dirname(text))
}

/**
 * 读某个 package.json 的版本号；读不出来返回空串（**不抛**）。
 *
 * @param {string} packageFile - package.json 路径。
 * @param {{readFileSync?: Function}} [fsImpl] - 注入用。
 */
export function readPackageVersion(packageFile, { readFileSync = fs.readFileSync } = {}) {
  try {
    const pkg = JSON.parse(readFileSync(packageFile, 'utf8'))
    return String(pkg?.version ?? '').trim()
  } catch {
    return ''
  }
}

// ── 安装命令 ────────────────────────────────────────────────────────────────
//
// 🔴 这里有一条**实测**的硬约束：更新通道**不能**用 PATH 上的 `dsh`。
//    本机 `C:\Users\cyan\.dsh\bin\dsh.cmd` 指向的是**开发检出**
//    （`node --import tsx/esm D:\app\deepseekharness\deepseek-harness\apps\cli\src\bin.ts`）——
//    那是"这台机器上恰好有源码"的产物，别人装插件时根本不存在。
//
//    正确的通道是**桌面版自带的运行时**，它就在当前进程的命令行里。实测那个进程
//    （dsh-desktop-host，插件就跑在它里面）的 argv 是：
//
//      "D:\app\dshdestop\DeepSeek Harness.exe" --expose-internals
//      D:\app\dshdestop\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js
//      D:\app\dshdestop\resources\app.asar\dsh
//      C:\Users\cyan\.dsh\profiles\desktop                     ← profile 目录
//      D:\app\dshdestop\resources\runtime\primary-runtime
//      D:\app\dshdestop\resources\runtime\pnpm\bin\pnpm.mjs    ← 自带 pnpm
//      D:\app\dshdestop\resources\runtime\bin                  ← 自带 node.cmd 就在这儿
//
//    而 `…\runtime\bin\node.cmd` 的内容是 `set ELECTRON_RUN_AS_NODE=1` +
//    `"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals %*` —— 官方自己就是
//    「同一个 exe 当 node 用」。所以这里照抄这个做法：
//
//      spawn(process.execPath, ['--expose-internals', pnpmEntry, 'add', spec],
//            { cwd: profileDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })

/** 默认的存在性判断（测试里注入假的，就能把每个分支都跑一遍）。 */
function defaultExists(target) {
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}

/** 默认的文件读取（同上）。 */
function defaultReadFileSync(target, encoding) {
  return fs.readFileSync(target, encoding)
}

/**
 * 一个目录是不是 DSH 的 profile 目录：`package.json` 里带 `dsh.profile`。
 *
 * 为什么不靠目录名/路径猜：`profiles/<名字>` 只是当前约定，而 `dsh.profile` 是
 * DSH 自己写在文件里的**事实**。实测 `C:\Users\cyan\.dsh\profiles\desktop\package.json`
 * 里就有 `"dsh": { "profile": { "bundles": [...] } }`。
 */
export function isProfileDir(dir, { exists = defaultExists, readFileSync = defaultReadFileSync } = {}) {
  const target = String(dir ?? '').trim()
  if (target === '') return false
  if (!exists(path.join(target, 'package.json'))) return false
  try {
    const pkg = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'))
    return Boolean(pkg?.dsh?.profile)
  } catch {
    return false
  }
}

/**
 * 路径是不是绝对路径。
 *
 * 为什么要同时问 posix 与 win32：插件在 Windows 上跑，但**测试可能在 Linux 的 CI 上跑**，
 * 而测试里会把本机实测的 Windows argv 原样喂进来。只按当前平台判会漏掉一半。
 */
function isAbsoluteAnywhere(target) {
  return path.isAbsolute(target) || path.win32.isAbsolute(target)
}

/**
 * 从进程命令行里认出「桌面版自带的运行时」。
 *
 * **纯函数**：argv 与文件系统判断都可注入，所以 `tests/update.test.mjs` 能拿
 * 本机那份**实测的** argv 原样跑一遍（见测试里的 `REAL_ARGV`）。
 *
 * 分隔符一律按 `/` 或 `\` 都认（同上：测试要能跨平台跑同一份 Windows argv）。
 *
 * @param {string[]} argv - `process.argv`。
 * @param {{exists?: Function, readFileSync?: Function}} [deps]
 * @returns {{pnpmEntry: string, runtimeBinDir: string, nodeCmd: string, profileDir: string, exe: string}}
 *   认不出来的字段是空串（不抛错）。
 */
export function parseDesktopRuntime(argv = [], { exists = defaultExists, readFileSync = defaultReadFileSync } = {}) {
  const found = { pnpmEntry: '', runtimeBinDir: '', nodeCmd: '', profileDir: '', exe: '' }
  const list = Array.isArray(argv) ? argv : []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const item = raw.trim().replace(/^"|"$/g, '')
    // 只认绝对路径：argv 里还有 `--type=renderer` 这种开关，以及运行目录这种相对路径。
    if (item === '' || !isAbsoluteAnywhere(item)) continue
    const lower = item.toLowerCase()
    if (found.pnpmEntry === '' && lower.endsWith('pnpm.mjs') && exists(item)) found.pnpmEntry = item
    if (found.nodeCmd === '' && lower.endsWith('node.cmd') && exists(item)) found.nodeCmd = item
    if (
      found.runtimeBinDir === ''
      && /[/\\]bin$/.test(lower)
      && /[/\\]runtime[/\\]/.test(lower)
      && exists(item)
    ) found.runtimeBinDir = item
    if (found.exe === '' && lower.endsWith('.exe') && exists(item)) found.exe = item
    if (found.profileDir === '' && isProfileDir(item, { exists, readFileSync })) found.profileDir = item
  }
  return found
}

/** Windows 下路径带空格时必须整体加引号，否则 cmd.exe 会把它拆成两段。 */
function winQuote(value) {
  const text = String(value ?? '')
  return /\s/.test(text) ? `"${text}"` : text
}

/**
 * 在 PATH 里找一个可执行文件（Windows 上把 `.cmd` / `.exe` / `.bat` 都试一遍）。
 * 找不到返回空串。**纯函数**：env / 平台 / 存在性判断都可注入。
 */
export function findOnPath(name, { env = process.env, platform = process.platform, exists = defaultExists } = {}) {
  const base = String(name ?? '').trim()
  if (base === '') return ''
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter((d) => d !== '')
  const names = platform === 'win32'
    ? [`${base}.cmd`, `${base}.exe`, `${base}.bat`, base]
    : [base]
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate)
      if (exists(full)) return full
    }
  }
  return ''
}

/**
 * 从「正在运行的这个 exe」推出桌面版**自带**的 pnpm 入口。
 *
 * 桌面版的资源目录就贴在 exe 旁边：`<exe目录>/resources/runtime/pnpm/bin/pnpm.mjs`
 * （本机实测：`D:\app\dshdestop\resources\runtime\pnpm\bin\pnpm.mjs`；同目录的
 * `runtime/bin/node.cmd` 干的就是 `ELECTRON_RUN_AS_NODE=1 "<exe>" --expose-internals %*`）。
 *
 * 为什么需要这条：桌面版主进程的 argv 里**只有 exe 自己**
 * （实测 `Win32_Process.CommandLine` = `"D:\app\dshdestop\DeepSeek Harness.exe"`），
 * 所以 `parseDesktopRuntime` 认不出 pnpm.mjs，会一路掉到「PATH 上的 dsh」——
 * 而那个在开发机上指向源码检出。
 *
 * 这不是"猜安装位置"：起点是**本进程自己的可执行文件**，而且要求文件真的存在。
 * macOS 的 `.app` 布局另外试一次 `Contents/Resources/…`。
 *
 * @returns {string} pnpm.mjs 的路径，认不出来是空串。
 */
export function bundledPnpmEntry(executable, { exists = defaultExists } = {}) {
  const exe = String(executable ?? '').trim()
  if (exe === '' || !isAbsoluteAnywhere(exe)) return ''
  const dir = path.dirname(exe)
  const candidates = [
    path.join(dir, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
    path.join(dir, '..', 'Resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
  ]
  for (const candidate of candidates) {
    if (exists(candidate)) return path.normalize(candidate)
  }
  return ''
}

/**
 * 拼出「装新版本」要跑的进程、参数、工作目录与环境变量。
 *
 * 通道优先级（①→⑤ 是**兜底顺序**，不是并列选择）：
 *   ① argv 里的 pnpm.mjs + `process.execPath`（桌面版自己，实测可用）
 *   ② 同上，但 node 用 `%DSH_DESKTOP_NODE_EXECUTABLE%`
 *   ③ **exe 旁边的自带运行时**（`<exe目录>/resources/runtime/pnpm/bin/pnpm.mjs`）——
 *      桌面版主进程 argv 里只有 exe 自己，这条才是实际会命中的那条
 *   ④ PATH 上的 `dsh`（这时才需要 `cmd.exe /c` 包装 `.cmd`）
 *   ⑤ profile 目录里直接 `pnpm add`
 *
 * @param {object} options
 * @param {string} options.profile - profile 名（日志与 ④ 用）。
 * @param {string} options.spec - 安装源。
 * @param {string} [options.profileDir] - 已推出来的 profile 目录（优先于 argv 里认到的）。
 * @param {string[]} [options.argv] - `process.argv`。
 * @param {object} [options.env] - `process.env`。
 * @param {string} [options.platform] - 平台（注入用）。
 * @param {string} [options.executable] - 当 node 用的可执行文件（默认 `process.execPath`）。
 * @returns {{ok: true, via: string, file: string, args: string[], cwd: string, env: object, display: string}
 *   | {ok: false, error: string}}
 */
export function buildAddCommand({
  profile, spec, profileDir = '', argv = process.argv, env = process.env,
  platform = process.platform, executable = process.execPath,
  exists = defaultExists, readFileSync = defaultReadFileSync, comspec,
} = {}) {
  const name = String(profile ?? '').trim()
  const source = String(spec ?? '').trim()
  if (name === '') return { ok: false, error: '推不出 profile 名字，没法更新' }
  if (source === '') return { ok: false, error: '更新源是空的' }

  const shell = comspec || env.ComSpec || 'cmd.exe'
  const runtime = parseDesktopRuntime(argv, { exists, readFileSync })
  const cwd = String(profileDir ?? '').trim() || runtime.profileDir

  // ①② 桌面版自带 pnpm。`process.execPath` 在 Electron 里就是那个 exe 自己。
  const nodeFromEnv = String(env.DSH_DESKTOP_NODE_EXECUTABLE ?? '').trim()
  if (runtime.pnpmEntry !== '') {
    const candidates = [
      { file: executable, via: 'desktop-pnpm' },
      ...(nodeFromEnv !== '' && nodeFromEnv !== executable
        ? [{ file: nodeFromEnv, via: 'desktop-node' }]
        : []),
    ]
    for (const candidate of candidates) {
      if (!candidate.file || !exists(candidate.file)) continue
      const args = ['--expose-internals', runtime.pnpmEntry, 'add', source]
      return {
        ok: true,
        via: candidate.via,
        file: candidate.file,
        args,
        cwd,
        env: { ELECTRON_RUN_AS_NODE: '1' },
        display: `${candidate.file} ${args.join(' ')}${cwd ? `（cwd=${cwd}）` : ''}`,
      }
    }
  }

  // ③ exe 旁边的自带运行时（桌面版实际会命中的那条，见 bundledPnpmEntry 的注释）。
  const bundled = bundledPnpmEntry(executable, { exists })
  if (bundled !== '' && exists(executable)) {
    const args = ['--expose-internals', bundled, 'add', source]
    return {
      ok: true,
      via: 'desktop-pnpm-bundled',
      file: executable,
      args,
      cwd,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      display: `${executable} ${args.join(' ')}${cwd ? `（cwd=${cwd}）` : ''}`,
    }
  }

  // ④ 兜底：PATH 上的 dsh。⚠️ 这在开发机上指向的是**源码检出**，只在前面几条都不成立时才走。
  const dsh = findOnPath('dsh', { env, platform, exists })
  if (dsh !== '') {
    const tail = ['plugin', '--profile', name, 'add', source]
    if (platform === 'win32') {
      return {
        ok: true, via: 'dsh', file: shell, args: ['/c', winQuote(dsh), ...tail], cwd, env: {},
        display: `${shell} /c ${winQuote(dsh)} ${tail.join(' ')}`,
      }
    }
    return { ok: true, via: 'dsh', file: dsh, args: tail, cwd, env: {}, display: `${dsh} ${tail.join(' ')}` }
  }

  // ④ 最后兜底：直接在 profile 目录里 `pnpm add`（少了 bundles 登记，但能装上）。
  const pnpm = findOnPath('pnpm', { env, platform, exists })
  if (pnpm === '' || cwd === '') {
    return {
      ok: false,
      error: '找不到可用的更新通道（桌面版自带的 pnpm、PATH 上的 dsh 和 pnpm 都没找到）',
    }
  }
  if (platform === 'win32') {
    return {
      ok: true, via: 'pnpm', file: shell, args: ['/c', winQuote(pnpm), 'add', source], cwd, env: {},
      display: `${shell} /c ${winQuote(pnpm)} add ${source}（cwd=${cwd}）`,
    }
  }
  return {
    ok: true, via: 'pnpm', file: pnpm, args: ['add', source], cwd, env: {},
    display: `${pnpm} add ${source}（cwd=${cwd}）`,
  }
}

/**
 * 跑一个子进程，输出**重定向到文件**再读回来。
 *
 * 为什么不用 `stdio: 'pipe'`：Windows 沙箱下子进程开管道会 EPERM（实测），
 * 而更新恰恰是最不该因为系统限制而静默失败的动作。写文件最笨也最稳，
 * 顺带把完整输出留在磁盘上，出问题能事后翻。
 *
 * 任何失败（spawn 报错、超时、退出码非 0）都只返回结果对象，**不抛**。
 *
 * @param {object} options
 * @param {string} options.file - 可执行文件。
 * @param {string[]} options.args - 参数。
 * @param {string} [options.cwd] - 工作目录。
 * @param {number} [options.timeoutMs] - 超时（默认 180 秒）。
 * @param {string} options.logFile - 输出重定向到的文件。
 * @param {object} [options.env] - 追加的环境变量（合到 `baseEnv` 上）。桌面版自带的 pnpm
 *   必须靠 `ELECTRON_RUN_AS_NODE=1` 才能让同一个 exe 当 node 用。
 * @param {object} [options.baseEnv] - 基础环境变量（默认 `process.env`，注入用）。
 * @param {Function} [options.spawnImpl] - 注入用。
 * @param {object} [options.fsImpl] - 注入用（openSync/closeSync/readFileSync/unlinkSync）。
 * @param {Function} [options.log] - 日志函数。
 * @returns {Promise<{ok: boolean, timedOut: boolean, code: number|null, output: string, error?: string}>}
 */
export function runProcess({
  file, args = [], cwd, timeoutMs = UPDATE_INSTALL_TIMEOUT_MS, logFile,
  env = null, baseEnv = process.env,
  spawnImpl = spawn, fsImpl = fs, log = () => {},
} = {}) {
  return new Promise((resolve) => {
    let fd = null
    let child = null
    let timedOut = false
    let settled = false
    let timer = null

    /** 收尾：关 fd、读输出、删日志文件，然后落定。**只落定一次**。 */
    const finish = (code, error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      let output = ''
      try {
        if (fd !== null) fsImpl.closeSync(fd)
      } catch { /* 关不掉不影响结果 */ }
      try {
        output = String(fsImpl.readFileSync(logFile, 'utf8'))
      } catch { /* 没有输出文件时就是空 */ }
      try {
        if (logFile) fsImpl.unlinkSync(logFile)
      } catch { /* 删不掉就留着，不影响结果 */ }
      resolve({
        ok: !timedOut && error === undefined && code === 0,
        timedOut,
        code: code ?? null,
        output,
        ...(error !== undefined ? { error } : {}),
      })
    }

    try {
      fd = fsImpl.openSync(logFile, 'w')
    } catch (err) {
      finish(null, `打不开输出文件 ${logFile}：${err?.message ?? err}`)
      return
    }

    try {
      child = spawnImpl(file, args, {
        ...(cwd ? { cwd } : {}),
        // env 只有需要时才覆盖（桌面版自带的 pnpm 靠 ELECTRON_RUN_AS_NODE 用同一个 exe 当 node）。
        ...(env && Object.keys(env).length > 0 ? { env: { ...baseEnv, ...env } } : {}),
        // stdout 与 stderr 都写进同一个 fd；stdin 关掉（更新命令不需要交互输入）。
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      })
    } catch (err) {
      finish(null, `启动失败：${err?.message ?? err}`)
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      log(`安装命令超过 ${Math.round(timeoutMs / 1000)} 秒没结束，已终止`)
      try { child?.kill() } catch { /* 已经退了 */ }
    }, timeoutMs)
    // 超时闹钟不能让进程吊着（面板里跑测试时尤其明显）。
    if (timer.unref) timer.unref()

    child.on('error', (err) => finish(null, `启动失败：${err?.message ?? err}`))
    child.on('close', (code) => finish(typeof code === 'number' ? code : 0))
  })
}

// ── 重启脚本（PowerShell）────────────────────────────────────────────────────

/** PowerShell 单引号字符串里，单引号要写两遍。 */
function psQuote(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`
}

/**
 * `-ArgumentList @(...)` 里的**单个参数**。
 *
 * ⚠️ 这是实测踩出来的：PowerShell 把数组元素**用空格直接拼起来交给目标程序**，
 * 不做任何引号处理 —— 参数里有空格/括号/逗号时，目标程序收到的是被拆散的一堆碎片。
 * 现场表现：`-e 'setInterval(() => {}, 1)'` 被拼成 `-e setInterval(() => {}, 1)`，
 * node 直接语法错误退出，脚本那边看到的现象是「启动了但立刻没了 → 重试到失败」。
 * 所以带特殊字符的参数自己加一层双引号，内层双引号按 `\"` 转义。
 */
function psArg(text) {
  const value = String(text ?? '')
  if (!/[\s(){},"'&;|<>]/.test(value)) return psQuote(value)
  return `'"${value.replace(/"/g, '\\"')}"'`
}

/**
 * 生成"重启 DSH"的 PowerShell 脚本。
 *
 * 为什么是外部脚本而不是 `spawn('Stop-Process')` 之类：**它要杀掉插件自己所在的那个
 * 进程**（DSH 主进程）。只有把动作交给一个已经分离出去的脚本，杀父进程时才不会
 * 连自己一起带走。所以脚本必须是自包含的：等一会儿 → 杀 → 确认真的死了 → 启动 →
 * 失败重试 → 全程写日志。
 *
 * 为什么先等 10 秒：主人先收到 QQ 回执（"10 秒后自动重启"），等回执真的发出去了
 * 再动手；不等的话消息可能还在路上，进程就没了。
 *
 * @param {object} options
 * @param {string} options.exePath - 要重启的可执行文件。
 * @param {string} options.logFile - 日志文件（追加写）。
 * @param {number} [options.delaySeconds] - 启动前等待秒数。
 * @param {number} [options.retries] - 启动失败最多重试几次。
 * @param {number} [options.retryDelaySeconds] - 重试间隔。
 * @param {number} [options.killWaitSeconds] - 杀完最多等多久确认消失。
 * @param {number} [options.settleSeconds] - 旧进程消失后、启动前再等几秒。
 * @param {number} [options.startVerifySeconds] - 每次启动后最多等多久看到进程。
 * @param {number} [options.holdVerifySeconds] - 看到进程后再盯多久确认它没秒退。
 * @param {string} [options.note] - 写进日志开头的一句说明（例如"更新到 1.0.7"）。
 * @param {string[]} [options.exeArgs] - 启动参数；桌面版为空，测试里用来让"假 DSH"活着。
 * @returns {string} 可直接 `powershell -File` 跑的脚本。
 */
export function buildRestartScript({
  exePath, logFile,
  delaySeconds = RESTART_DELAY_SECONDS,
  retries = RESTART_RETRIES,
  retryDelaySeconds = RESTART_RETRY_DELAY_SECONDS,
  killWaitSeconds = RESTART_KILL_WAIT_SECONDS,
  settleSeconds = RESTART_SETTLE_SECONDS,
  startVerifySeconds = RESTART_START_VERIFY_SECONDS,
  holdVerifySeconds = RESTART_HOLD_VERIFY_SECONDS,
  note = '',
  exeArgs = [],
} = {}) {
  const argsLine = exeArgs.length > 0
    ? `-ArgumentList @(${exeArgs.map((a) => psArg(a)).join(', ')})`
    : ''
  const poisonList = RESTART_POISON_ENV.map((name) => psQuote(name)).join(', ')
  return [
    '# 由 dsh-remote-qqbot 自动生成：装完新版本后重启 DSH 桌面版。',
    '# 这份脚本是**分离启动**的，所以它可以放心杀掉 DSH 主进程（包括生成它的那个进程）。',
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$log = ${psQuote(logFile)}`,
    `$exe = ${psQuote(exePath)}`,
    '$exeDir = Split-Path -Parent $exe',
    '$exeName = [System.IO.Path]::GetFileNameWithoutExtension($exe)',
    '',
    'function Write-UpdateLog([string]$message) {',
    '  $line = "[{0}] {1}" -f (Get-Date -Format \'yyyy-MM-dd HH:mm:ss\'), $message',
    '  Add-Content -LiteralPath $log -Value $line -Encoding UTF8',
    '}',
    '',
    `Write-UpdateLog ${psQuote(`更新完成${note ? `（${note}）` : ''}，${delaySeconds} 秒后重启 DSH`)}`,
    '',
    '# ① 先清掉从插件进程继承来的变量。',
    '# 插件跑在桌面版的 host 子进程里，而 host 是"把 Electron 当 node 用"跑起来的',
    '# （ELECTRON_RUN_AS_NODE=1）。这个变量会一路传到我们启动的新进程，而带着它的',
    '# DeepSeek Harness.exe 只会当 node 跑一下就退出（实测 --version 输出 v24.18.1），',
    '# 桌面版根本不会启动 —— 现象就是"启动后没看到进程"，且不留任何日志。',
    `$poison = @(${poisonList})`,
    '$cleared = @()',
    'foreach ($name in $poison) {',
    '  if (Test-Path "Env:$name") {',
    '    Remove-Item "Env:$name" -ErrorAction SilentlyContinue',
    '    $cleared += $name',
    '  }',
    '}',
    "$clearedText = '（没有）'",
    'if ($cleared.Count -gt 0) { $clearedText = $cleared -join \', \' }',
    'Write-UpdateLog "清掉继承来的环境变量：$clearedText"',
    '',
    '# ② 认进程用两套量具：Get-Process 的 Path 常常读不到（新进程尤其如此），',
    '#    CIM 的 ExecutablePath 顶上。只看其中一个会漏掉刚启动的进程。',
    'function Find-AppProcess {',
    '  $found = @()',
    '  foreach ($p in @(Get-Process -Name $exeName -ErrorAction SilentlyContinue)) {',
    '    if ($p.Id -eq $PID) { continue }',
    '    $path = [string]$p.Path',
    '    if ($path -eq \'\') {',
    '      $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue',
    '      if ($cim) { $path = [string]$cim.ExecutablePath }',
    '    }',
    '    if ($path -eq $exe) { $found += $p }',
    '  }',
    '  return $found',
    '}',
    '',
    '# ③ 三种启动方式，一种不行换下一种。',
    "#    start-process：最直接，环境已经被我们清干净了；",
    "#    explorer：和主人双击同一个路子，进程由 explorer 建、环境与我们无关；",
    '#    wmi：由 WmiPrvSE 服务建进程，完全不沾我们的进程树。',
    'function Start-DshApp([string]$how) {',
    "  if ($how -eq 'start-process') {",
    `    $p = Start-Process -FilePath $exe -WorkingDirectory $exeDir ${argsLine ? `${argsLine} ` : ''}-PassThru -ErrorAction Stop`,
    '    return @{ ok = $true; pid = $p.Id; proc = $p; error = \'\' }',
    '  }',
    "  if ($how -eq 'explorer') {",
    "    Start-Process -FilePath 'explorer.exe' -ArgumentList ('\"{0}\"' -f $exe) -ErrorAction Stop",
    '    return @{ ok = $true; pid = 0; proc = $null; error = \'\' }',
    '  }',
    "  if ($how -eq 'wmi') {",
    "    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('\"{0}\"' -f $exe) } -ErrorAction Stop",
    '    if ($r.ReturnValue -ne 0) { return @{ ok = $false; pid = 0; proc = $null; error = "Win32_Process.Create 返回 $($r.ReturnValue)" } }',
    '    return @{ ok = $true; pid = $r.ProcessId; proc = $null; error = \'\' }',
    '  }',
    '  return @{ ok = $false; pid = 0; proc = $null; error = "不认识的启动方式 $how" }',
    '}',
    '',
    '# 新进程"起来就没了"时，把它的退出码写进日志。这条是 2026-10-05 那次故障最缺的一句话：',
    '# exe 带着 ELECTRON_RUN_AS_NODE 跑起来时会当 node 立刻退出（退出码 0），一眼就能认出。',
    'function Get-ExitCodeText($proc) {',
    "  if ($proc -eq $null) { return '' }",
    "  try { if ($proc.HasExited) { return \"（已经退出，退出码 $($proc.ExitCode)）\" } } catch { }",
    "  return ''",
    '}',
    '',
    `Start-Sleep -Seconds ${delaySeconds}`,
    '',
    '$started = $false',
    `for ($attempt = 1; $attempt -le ${retries}; $attempt++) {`,
    `  Write-UpdateLog "第 $attempt/${retries} 次：准备重启 $exe"`,
    '  # 按**可执行文件路径**杀，而不是按进程名 —— 同名进程可能不止一个。',
    '  foreach ($p in @(Find-AppProcess)) {',
    '    Write-UpdateLog "结束进程 pid=$($p.Id)"',
    '    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue',
    '  }',
    '  # 必须等它**真的**消失：立刻启动的话，新进程可能被上一次的退出流程带掉。',
    '  $waited = 0',
    `  while ($waited -lt ${killWaitSeconds} -and @(Find-AppProcess).Count -gt 0) {`,
    '    Start-Sleep -Seconds 1',
    '    $waited++',
    '  }',
    '  if (@(Find-AppProcess).Count -gt 0) {',
    `    Write-UpdateLog "等了 ${killWaitSeconds} 秒，旧进程还在，放弃这一轮"`,
    '  } else {',
    '    # 旧进程全没了之后再稳一会儿：退出流程与单实例锁要时间彻底释放。',
    `    Start-Sleep -Seconds ${settleSeconds}`,
    "    foreach ($how in @('start-process', 'explorer', 'wmi')) {",
    "      $r = @{ ok = $false; pid = 0; error = '' }",
    "      try { $r = Start-DshApp -how $how } catch { $r = @{ ok = $false; pid = 0; error = $_.Exception.Message } }",
    '      if (-not $r.ok) {',
    '        Write-UpdateLog "用 $how 启动失败：$($r.error)"',
    '        continue',
    '      }',
    "      $pidText = ''",
    '      if ($r.pid -gt 0) { $pidText = "（pid=$($r.pid)）" }',
    '      Write-UpdateLog "用 $how 启动了$pidText，等它起来"',
    '      $up = $false',
    '      $waited = 0',
    `      while ($waited -lt ${startVerifySeconds}) {`,
    '        Start-Sleep -Milliseconds 500',
    '        $waited = $waited + 0.5',
    '        if (@(Find-AppProcess).Count -gt 0) { $up = $true; break }',
    '      }',
    `      if (-not $up) { Write-UpdateLog "用 $how 启动后 ${startVerifySeconds} 秒内没看到进程$(Get-ExitCodeText $r.proc)"; continue }`,
    '      # 看到进程还不算成功：抢单实例锁失败会"起来又秒退"，再盯一会儿。',
    `      Start-Sleep -Seconds ${holdVerifySeconds}`,
    '      if (@(Find-AppProcess).Count -gt 0) {',
    `        Write-UpdateLog "DSH 已重新启动（用 $how，$waited 秒看到进程，${holdVerifySeconds} 秒后仍在）"`,
    '        $started = $true',
    '        break',
    '      }',
    '      Write-UpdateLog "用 $how 起来的进程又没了（多半是单实例检测）$(Get-ExitCodeText $r.proc)，换下一种方式"',
    '    }',
    "    if (-not $started) { Write-UpdateLog '这一轮三种启动方式都没起来，重试' }",
    '  }',
    '  if ($started) { break }',
    `  if ($attempt -lt ${retries}) { Start-Sleep -Seconds ${retryDelaySeconds} }`,
    '}',
    '',
    'if (-not $started) {',
    "  Write-UpdateLog '重启失败：请手动打开 DSH'",
    '  # 顺手把桌面版最新的崩溃日志尾巴抄过来，省得下次满硬盘找线索。',
    "  $crashDir = Join-Path $env:APPDATA '@deepseek-ai\\dsh-desktop\\logs'",
    "  $newest = Get-ChildItem -LiteralPath $crashDir -Filter 'crash-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1",
    '  if ($newest) {',
    '    Write-UpdateLog "最新崩溃日志：$($newest.FullName)（$($newest.Length) 字节，$($newest.LastWriteTime)）"',
    '    foreach ($line in @(Get-Content -LiteralPath $newest.FullName -Tail 8 -ErrorAction SilentlyContinue)) {',
    '      Write-UpdateLog "  | $line"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n')
}

/**
 * 把重启脚本写到临时目录。**不抛异常**：失败返回 `{ok:false, error}`。
 *
 * @param {object} options
 * @param {string} [options.dir] - 目标目录（默认系统临时目录）。
 * @param {string} options.script - 脚本正文。
 * @param {object} [options.fsImpl] - 注入用（mkdirSync/writeFileSync）。
 * @param {number} [options.stamp] - 文件名里的时间戳（注入用，便于测试）。
 * @returns {{ok: true, path: string}|{ok: false, error: string}}
 */
export function writeRestartScript({ dir, script, fsImpl = fs, stamp = Date.now() } = {}) {
  const target = dir && String(dir).trim() !== '' ? String(dir) : os.tmpdir()
  const file = path.join(target, `dsh-remote-restart-${stamp}.ps1`)
  try {
    fsImpl.mkdirSync(target, { recursive: true })
    // BOM 会让 Windows PowerShell 5.1 正确按 UTF-8 读中文注释与日志文案。
    fsImpl.writeFileSync(file, `\uFEFF${script}`, 'utf8')
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: `写重启脚本失败：${err?.message ?? err}` }
  }
}

/**
 * 写一个一行的 `.cmd` 启动器，里面只有 `start "" /min powershell … -File 脚本`。
 *
 * **为什么要多这一层**：本机实测（2026-10-05，四种配方差分跑过）——
 *   - `spawn('powershell.exe', …, {detached:true})`：进程建出来了，脚本**一行都不执行**；
 *   - 同一个 spawn 不分离：脚本能跑，但活不过父进程结束；
 *   - `spawn(process.execPath, …, {detached:true})`：正常执行（所以不是"分离"本身的问题）；
 *   - `cmd /c start "" /min powershell … -File 脚本`：**唯一一个两者都成立的**。
 * 重启脚本必须活过它自己杀掉的那个进程，所以走 `start` —— 那是 Windows 上"另起一个
 * 独立进程"的正统做法：新进程不挂在父进程的控制台上，父进程死掉与它无关。
 *
 * 内容保持全 ASCII（只有路径可能是中文），免得 cmd 按 OEM 代码页读乱。
 *
 * @returns {{ok: true, path: string}|{ok: false, error: string}}
 */
export function writeRestartLauncher({
  dir, scriptPath, fsImpl = fs, stamp = Date.now(), powershell = 'powershell.exe',
} = {}) {
  if (!scriptPath) return { ok: false, error: '没有脚本路径，写不了启动器' }
  const target = dir && String(dir).trim() !== '' ? String(dir) : os.tmpdir()
  const file = path.join(target, `dsh-remote-restart-${stamp}.cmd`)
  try {
    fsImpl.mkdirSync(target, { recursive: true })
    const line = `@echo off\r\nstart "" /min "${powershell}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"\r\n`
    fsImpl.writeFileSync(file, line, 'utf8')
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: `写重启启动器失败：${err?.message ?? err}` }
  }
}

/** 日志文件现在多大（不存在算 0）—— 用来判断"拉起来之后日志有没有长出来"。 */
export function restartLogSize(logFile, fsImpl = fs) {
  try {
    return fsImpl.statSync(logFile).size
  } catch {
    return 0
  }
}

/**
 * 等重启脚本真的写下第一行日志（脚本第一件事就是写日志，所以这就是"它在跑"的证据）。
 *
 * @returns {Promise<boolean>} true = 脚本确实在执行。
 */
export async function verifyRestartLaunched({
  logFile, before = 0, timeoutMs = RESTART_VERIFY_TIMEOUT_MS, intervalMs = 200,
  fsImpl = fs, sleep = null,
} = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms) }))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (restartLogSize(logFile, fsImpl) > before) return true
    if (Date.now() >= deadline) return false
    await wait(intervalMs)
  }
}

/**
 * 拉起重启脚本：有启动器就走 `cmd /c 启动器`（正式路径，原因见 `writeRestartLauncher`），
 * 没有就直接 spawn powershell（测试注入用，也是启动器写不出来时的兜底）。
 *
 * `detached: true` + `unref()` + `stdio: 'ignore'` 三件套仍然缺一不可：脚本要活过
 * "它杀掉的 DSH 主进程"（也就是生成它的这个进程），所以不能共享控制台、也不能让父进程等它。
 *
 * @param {object} options
 * @param {string} options.scriptPath - 脚本路径。
 * @param {string} [options.launcherPath] - 启动器 `.cmd` 路径（有就走 cmd）。
 * @param {Function} [options.spawnImpl] - 注入用。
 * @param {string} [options.powershell] - PowerShell 可执行文件。
 * @param {string} [options.comspec] - cmd 可执行文件。
 * @param {Function} [options.log] - 日志函数。
 * @returns {boolean} 是否把进程拉起来了（**不代表脚本真在跑**，那要 `verifyRestartLaunched`）。
 */
export function launchRestartScript({
  scriptPath, launcherPath = '', spawnImpl = spawn, powershell = 'powershell.exe',
  comspec = process.env.ComSpec || 'cmd.exe', log = () => {},
} = {}) {
  if (!scriptPath) return false
  try {
    const [file, args] = launcherPath
      ? [comspec, ['/c', launcherPath]]
      : [powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]]
    const child = spawnImpl(file, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref?.()
    return true
  } catch (err) {
    log(`启动重启脚本失败：${err?.message ?? err}`)
    return false
  }
}

// ── 面向用户的文案 ──────────────────────────────────────────────────────────

/** 按码点截断，取**最后** max 个字符（错误原因通常在输出末尾）。 */
export function tailText(text, max = ERROR_TAIL_CHARS) {
  const s = String(text ?? '')
  if (s === '') return ''
  const chars = [...s]
  if (chars.length <= max) return s
  return `…${chars.slice(chars.length - max).join('')}`
}

/** 发现新版本时的主动提醒（同一个版本只发一次）。 */
export function formatUpdateAvailable({ latest, current } = {}) {
  return `🔔 插件有新版本 ${latest}（现在跑的是 ${current}）。发 /update 我就装上 —— 装完会自动重启 DSH，中间有十几秒连不上。`
}

/** `/update check` 的回复：有新版本时说的和主动提醒同一件事，只是不带铃铛。 */
export function formatUpdateCheck({ latest, current, upToDate = false } = {}) {
  if (upToDate) return `已经是最新版 ${current}，不用更新。`
  return `有新版本 ${latest}（现在跑的是 ${current}）。发 /update 我就装上 —— 装完会自动重启 DSH，中间有十几秒连不上。`
}

/** 开始安装前的回执。 */
export function formatUpdating({ version } = {}) {
  return `正在更新到 ${version}…`
}

/** 已经是最新版时的回复。 */
export function formatAlreadyLatest({ current } = {}) {
  return `已经是最新版 ${current}，不用更新`
}

/**
 * 远端比本机**旧**时的回复。
 *
 * 这不是假想情况：本机装了还没发布的版本（或自己有 fork）时，远端确实可能更旧。
 * 这时候**绝对不能装** —— 装下去就是把用户的插件降级，而且降级后它还会再"发现新版"
 * （因为远端版本号一直小于本机），来回震荡。
 */
export function formatRemoteOlder({ latest, current } = {}) {
  return `远端还是 ${latest}，比本机（${current}）旧，不用更新`
}

/**
 * 装好了的回复。
 *
 * 开着自动重启时必须把「会断线一会儿」说在前面 —— 主人手机上会看到机器人掉线，
 * 不说清楚就会以为插件坏了。
 */
export function formatUpdateDone({
  latest, from, autoRestart = true, scheduled = null, delaySeconds = RESTART_DELAY_SECONDS,
} = {}) {
  const head = `✅ 已装 ${latest}（原来是 ${from}）。`
  if (!autoRestart) return `${head}重启 DSH 后生效。`
  // `scheduled === false` = 自动重启这条路没走通（认不出桌面版主程序，或者脚本没真跑起来）。
  // 这种情况必须说清"要你自己动一下"，不能让主人盯着等一个不会发生的重启。
  if (scheduled === false) return `${head}自动重启没能排上，手动重启 DSH 后生效。`
  // 重启脚本是"另起一个分离进程"去杀 DSH 再拉起来的，插件自己活不到那一刻、
  // 没法回头汇报结果（Linux 上还能靠外部守护，桌面版没有）。所以这句里必须
  // 带上"万一没回来怎么办"，不能让主人对着一个不会发生的重启干等。
  return `${head}${delaySeconds} 秒后自动重启 DSH —— 重启期间机器人会离线一会儿，起来后我会回你一条确认；要是过了一分钟还没回来，手动打开 DSH 就行。`
}

/** 装完了但版本没变（源上还没发新版，或装到别处去了）—— 必须说清，不能假装成功。 */
export function formatUpdateNoChange({ version } = {}) {
  return `装完了，但版本还是 ${version} —— 远端可能还没发这一版，或者装到别的地方去了。`
}

/** 更新失败：一句人话 + 最后一段错误输出。 */
export function formatUpdateFailed({ reason, output } = {}) {
  const tail = tailText(output)
  const head = `❌ 更新没成功：${reason ?? '原因不明'}。`
  return tail === '' ? head : `${head}\n\n错误摘要（最后 ${ERROR_TAIL_CHARS} 字）：\n${tail}`
}

/** 检查新版本本身失败（网络不通、源上没有这个包…）。 */
export function formatCheckFailed({ error } = {}) {
  return `❌ 查新版本失败：${error ?? '原因不明'}。网络不通或源上没这个包都可能，稍后再试。`
}

/** 环境不完整（推不出 profile / 源写错）时的说明。 */
export function formatUpdateMisconfigured({ reason } = {}) {
  return `❌ 现在没法自动更新：${reason ?? '配置不全'}。可以在 DSH 设置里改「从哪里取新版」。`
}

/** 重启之后那条确认（插件启动时发现状态里有重启标记就发它）。 */
export function formatRestartDone({ version, seconds } = {}) {
  return `✅ 重启完成，插件现在是 ${version}（重启用了 ${Math.max(0, Math.round(seconds))} 秒）。`
}

/** 已经有一个更新在进行中：不并发，明确说一句。 */
export function formatUpdateBusy() {
  return '正在更新中，稍等一下 —— 装完我会告诉你的。'
}
