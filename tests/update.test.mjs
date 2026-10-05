/**
 * 远程更新（`/update`）离线自测 —— **不联网、不起真进程、不动真 profile**。
 *
 * 这一组守的是「远程更新」这条链上每一处**判断**：
 *   1. 版本比较（`1.0.10 > 1.0.9`、`v` 前缀、`-rc.1`）—— 判错就会**把用户降级**；
 *   2. 更新源解析（`github:作者/仓库` 与 npm 包名各自去哪儿查版本号）；
 *   3. 查远端版本的三条分支（`>` 提醒 / `===` 静默 / `<` 静默）—— 实测过远端比本机旧的情况；
 *   4. 从自己的安装路径反推 profile；
 *   5. **更新通道**：桌面版自带 pnpm（`process.execPath` + `--expose-internals pnpm.mjs add`）
 *      优先，PATH 上的 `dsh` 只做兜底 —— 这一条是本轮实测钉下来的硬事实，
 *      而且 `tests` 里直接拿**本机真实 argv**（`REAL_ARGV`）跑，不是编的样例；
 *   6. 子进程输出必须**重定向到文件**（`stdio` 里不许出现 `'pipe'`：Windows 沙箱下会 EPERM）；
 *   7. 重启脚本（10 秒延迟 / 按路径杀 / 等它真死 / 清掉 ELECTRON_RUN_AS_NODE /
 *      三种启动方式兜底 / 3 次重试 / 追加日志）；
 *   8. 面向用户的每一句文案（主人明确规定了措辞）。
 *
 * 设计纪律：**跑函数验行为，不正则扫源码**；网络 / 进程 / 文件系统全部走注入的假实现。
 *
 * 跑法：node tests/update.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_UPDATE_SOURCE, ERROR_TAIL_CHARS, RESTART_DELAY_SECONDS,
  RESTART_RETRIES, UPDATE_INSTALL_TIMEOUT_MS,
  buildAddCommand, buildRestartScript, bundledPnpmEntry, compareVersions, fetchLatestVersion,
  RESTART_POISON_ENV,
  findOnPath, formatAlreadyLatest, formatCheckFailed, formatRemoteOlder, formatRestartDone,
  formatUpdateAvailable, formatUpdateBusy, formatUpdateCheck, formatUpdateDone,
  formatUpdateFailed, formatUpdateMisconfigured, formatUpdateNoChange, formatUpdating,
  isNewerVersion, isProfileDir, launchRestartScript, normalizeVersion, parseDesktopRuntime,
  parseUpdateSource, pluginRootFromFile, readPackageVersion, resolveProfileFromPluginFile,
  restartLogSize, runProcess, tailText, verifyRestartLaunched, versionFromGitHubResponse,
  versionFromManifestResponse, versionFromNpmResponse, writeRestartLauncher, writeRestartScript,
} from '../src/update.js'
import { HELP_TEXT, routeIncoming } from '../src/qqbridge.js'

let pass = 0
let fail = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (err) {
    fail += 1
    failures.push({ name, err })
    console.log(`  ❌ ${name}\n     ${err?.message ?? err}`)
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.dirname(here)
const readSrc = (name) => fs.readFileSync(path.join(pluginDir, 'src', name), 'utf8')

/**
 * 本机**实测**的进程命令行（2026-10-05，用 `Get-CimInstance Win32_Process` 读的
 * dsh-desktop-host 那条，插件就跑在它里面）。测试直接拿它跑，而不是自己编一份 ——
 * 编的样例只能证明"我的正则认识我自己编的字符串"。
 */
const REAL_ARGV = [
  'D:\\app\\dshdestop\\DeepSeek Harness.exe',
  '--expose-internals',
  'D:\\app\\dshdestop\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
  'D:\\app\\dshdestop\\resources\\app.asar\\dsh',
  'C:\\Users\\cyan\\.dsh\\profiles\\desktop',
  'D:\\app\\dshdestop\\resources\\runtime\\primary-runtime',
  'D:\\app\\dshdestop\\resources\\runtime\\pnpm\\bin\\pnpm.mjs',
  'D:\\app\\dshdestop\\resources\\runtime\\bin',
]
const REAL_EXE = REAL_ARGV[0]
const REAL_PNPM = REAL_ARGV[6]
const REAL_PROFILE = REAL_ARGV[4]
const REAL_BIN = REAL_ARGV[7]

/** 把路径统一成 `/` 分隔、小写 —— 让断言与假文件系统不绑死当前平台的分隔符。 */
const norm = (x) => String(x).replace(/\\/g, '/').toLowerCase()

/**
 * 让 `exists` 只对给定的路径成立，`readFileSync` 只对 profile 目录给 package.json。
 *
 * 注意 `exists` 还要认「profile 目录下的 package.json」—— `isProfileDir` 问的正是那个路径。
 */
function fakeDeps(existing, profileDirs = []) {
  const want = existing.map(norm)
  const profiles = profileDirs.map(norm)
  return {
    exists: (target) => want.includes(norm(target)) || profiles.includes(norm(path.dirname(String(target)))),
    readFileSync: (target) => {
      const dir = norm(path.dirname(String(target)))
      if (profiles.includes(dir)) {
        return JSON.stringify({ name: 'dsh-profile-desktop', dsh: { profile: { bundles: [] } } })
      }
      throw new Error('ENOENT')
    },
  }
}

const realDeps = () => fakeDeps(
  [REAL_EXE, REAL_PNPM, REAL_BIN, REAL_PROFILE],
  [REAL_PROFILE],
)

/** 把任意分隔符的路径拆成段，避免断言绑死当前平台的分隔符。 */
const segs = (p) => String(p).split(/[/\\]+/).filter((x) => x !== '')

console.log('远程更新组（离线）\n')

// ── [1] 版本比较 ────────────────────────────────────────────────────────────
console.log('[1] 版本比较')

await t('1.0.10 比 1.0.9 新（按数字段比，不是按字符串比）', () => {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1, '字符串比会得出反的结论')
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1)
  assert.equal(isNewerVersion('1.0.10', '1.0.9'), true)
})

await t('v 前缀与首尾空白被抹平', () => {
  assert.equal(normalizeVersion(' v1.0.7 '), '1.0.7')
  assert.equal(compareVersions('v1.0.7', '1.0.7'), 0)
  assert.equal(compareVersions('V2.0.0', 'v1.9.9'), 1)
})

await t('位数不同的版本按缺位补 0 比（1.0 == 1.0.0）', () => {
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0.1', '1.0'), 1)
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1)
})

await t('pre-release 排在同号正式版之前（semver）', () => {
  assert.equal(compareVersions('1.0.7-rc.1', '1.0.7'), -1)
  assert.equal(compareVersions('1.0.7', '1.0.7-rc.1'), 1)
  assert.equal(compareVersions('1.0.7-rc.2', '1.0.7-rc.1'), 1)
  assert.equal(compareVersions('1.0.7-rc.10', '1.0.7-rc.9'), 1, '数字标识符要按数字比')
})

await t('构建元数据（+sha）不参与比较', () => {
  assert.equal(compareVersions('1.0.7+build.9', '1.0.7'), 0)
})

await t('读不出自己的版本号时宁可认"有新版"，也不漏掉更新', () => {
  assert.equal(isNewerVersion('1.0.7', ''), true)
  assert.equal(isNewerVersion('', '1.0.7'), false, '远端读不出来不能算新版本')
})

// ── [2] 更新源解析 ──────────────────────────────────────────────────────────
console.log('[2] 更新源解析')

await t('默认源是服务器上的版本索引，检查地址就是它本身', () => {
  assert.equal(DEFAULT_UPDATE_SOURCE, 'https://cyanovo.top/plugins/dsh-remote-qqbot/update.json')
  const r = parseUpdateSource(DEFAULT_UPDATE_SOURCE)
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'manifest')
  assert.equal(r.checkUrl, DEFAULT_UPDATE_SOURCE)
  assert.equal(r.spec, DEFAULT_UPDATE_SOURCE, '解析阶段先把配置里那个字符串原样留着')
})

await t('索引源：装的是索引里给的压缩包地址，不是索引地址本身', async () => {
  const url = 'https://cyanovo.top/plugins/dsh-remote-qqbot/dsh-remote-qqbot-9.9.9.tgz'
  const f = fakeFetch({ body: { name: 'dsh-remote-qqbot', version: '9.9.9', url, sha256: 'a'.repeat(64) } })
  const got = await fetchLatestVersion({ source: DEFAULT_UPDATE_SOURCE, fetchImpl: f })
  assert.equal(got.ok, true)
  assert.equal(got.kind, 'manifest')
  assert.equal(got.version, '9.9.9')
  assert.equal(got.spec, url, 'pnpm add 要用索引里的 url 字段')
  assert.equal(got.sha256, 'a'.repeat(64))
  assert.equal(f.calls[0].options.headers['cache-control'], 'no-cache', '索引必须每次拿最新的')
})

await t('索引地址打错（远端回的其实是首页 HTML）⇒ 报人话，绝不装作查到了版本', async () => {
  // 宿主的站点是单页应用：没有扩展名的未知路径会回首页 HTML 且状态码 200（本机实测）。
  // 真 fetch 的 res.json() 遇到 HTML 会抛 SyntaxError，这里照原样模拟。
  const f = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError("Unexpected token '<', \"<!doctype \"... is not valid JSON") },
  })
  const got = await fetchLatestVersion({ source: DEFAULT_UPDATE_SOURCE, fetchImpl: f })
  assert.equal(got.ok, false)
  assert.match(got.error, /不是 JSON/, '状态码 200 也不能当成功')
})

await t('索引是合法 JSON 但形状不对 ⇒ 逐条说清缺什么（不盖成"不是 JSON"）', async () => {
  const html = await fetchLatestVersion({ source: DEFAULT_UPDATE_SOURCE, fetchImpl: fakeFetch({ body: '<!doctype html>' }) })
  assert.equal(html.ok, false)
  assert.match(html.error, /不是版本索引/)

  const noUrl = await fetchLatestVersion({ source: DEFAULT_UPDATE_SOURCE, fetchImpl: fakeFetch({ body: { version: '9.9.9' } }) })
  assert.equal(noUrl.ok, false)
  assert.match(noUrl.error, /没有 url/, '缺字段的原因不能被兜底文案吃掉')
})

await t('github:作者/仓库#分支 会把 ref 带进检查地址', () => {
  const r = parseUpdateSource('github:cyanovo/dsh-remote-qqbot#v1.0.7')
  assert.equal(r.ok, true)
  assert.equal(r.ref, 'v1.0.7')
  assert.match(r.checkUrl, /\?ref=v1\.0\.7$/)
})

await t('npm 包名走 registry.npmjs.org/<包名>/latest', () => {
  const r = parseUpdateSource('dsh-remote-qqbot')
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'npm')
  assert.equal(r.checkUrl, 'https://registry.npmjs.org/dsh-remote-qqbot/latest')
})

await t('带 scope 的 npm 包名会被正确转义', () => {
  const r = parseUpdateSource('@cyanovo/dsh-remote-qqbot')
  assert.equal(r.ok, true)
  assert.match(r.checkUrl, /^https:\/\/registry\.npmjs\.org\/%40cyanovo%2Fdsh-remote-qqbot\/latest$/)
})

await t('认不出的源（既不是 http(s)、也不是仓库/包名）给出人话，而不是硬猜一个地址去请求', () => {
  const r = parseUpdateSource('ftp://cyanovo.top/update.json')
  assert.equal(r.ok, false)
  assert.match(r.error, /不认识/)
  assert.equal(parseUpdateSource('').ok, false)
})

await t('HTML 与 JSON 两种响应都能取出版本号；缺字段时报错', () => {
  const b64 = Buffer.from(JSON.stringify({ name: 'x', version: '1.0.9' }), 'utf8').toString('base64')
  assert.equal(versionFromGitHubResponse({ content: b64, encoding: 'base64' }), '1.0.9')
  assert.equal(versionFromNpmResponse({ version: 'v2.3.4' }), 'v2.3.4')
  assert.throws(() => versionFromGitHubResponse({}), /没有 package.json 内容|version/)
  assert.throws(() => versionFromNpmResponse({}), /version/)
})

await t('索引字段不全时逐条报清楚（缺 version / 缺 url / url 不是 http / 根本不是对象）', () => {
  assert.equal(versionFromManifestResponse({ version: '1.0.9', url: 'https://x/y.tgz' }), '1.0.9')
  assert.throws(() => versionFromManifestResponse({ url: 'https://x/y.tgz' }), /没有 version/)
  assert.throws(() => versionFromManifestResponse({ version: '1.0.9' }), /没有 url/)
  assert.throws(() => versionFromManifestResponse({ version: '1.0.9', url: 'file:///x.tgz' }), /不是 http/)
  assert.throws(() => versionFromManifestResponse('<html>首页</html>'), /不是版本索引/)
  assert.throws(() => versionFromManifestResponse(null), /不是版本索引/)
})

// ── [3] 查远端版本：三条分支 ────────────────────────────────────────────────
console.log('[3] 查远端版本（注入假 fetch，不联网）')

/** 造一个假 fetch：返回给定 body / 状态码，并记下请求。 */
function fakeFetch({ status = 200, body = {}, reject = null }) {
  const calls = []
  const impl = async (url, options) => {
    calls.push({ url, options })
    if (reject) throw reject
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }
  impl.calls = calls
  return impl
}

await t('GitHub 源：把 contents API 的 base64 内容解出来', async () => {
  const b64 = Buffer.from(JSON.stringify({ version: '1.0.7' }), 'utf8').toString('base64')
  const f = fakeFetch({ body: { content: b64, encoding: 'base64' } })
  const got = await fetchLatestVersion({ source: 'github:cyanovo/dsh-remote-qqbot', fetchImpl: f })
  assert.equal(got.ok, true)
  assert.equal(got.version, '1.0.7')
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/cyanovo/dsh-remote-qqbot/contents/package.json')
  assert.equal(f.calls[0].options.headers['user-agent'], 'dsh-remote-qqbot', 'GitHub 不要无 UA 的请求')
})

await t('远端更新：1.0.9 > 1.0.6 ⇒ 该提醒', async () => {
  const f = fakeFetch({ body: { version: '1.0.9' } })
  const got = await fetchLatestVersion({ source: 'dsh-remote-qqbot', fetchImpl: f })
  assert.equal(compareVersions(got.version, '1.0.6'), 1)
})

await t('远端相同：1.0.6 === 1.0.6 ⇒ 静默，一个字都不发', async () => {
  const f = fakeFetch({ body: { version: '1.0.6' } })
  const got = await fetchLatestVersion({ source: 'dsh-remote-qqbot', fetchImpl: f })
  assert.equal(compareVersions(got.version, '1.0.6'), 0)
})

await t('远端更旧：1.0.5 < 1.0.6 ⇒ 静默，且**绝不允许装**（那是降级）', async () => {
  const f = fakeFetch({ body: { version: '1.0.5' } })
  const got = await fetchLatestVersion({ source: 'dsh-remote-qqbot', fetchImpl: f })
  assert.equal(compareVersions(got.version, '1.0.6'), -1)
  assert.equal(isNewerVersion(got.version, '1.0.6'), false)
  assert.match(formatRemoteOlder({ latest: '1.0.5', current: '1.0.6' }), /比本机（1\.0\.6）旧/)
})

await t('网络挂了只记日志 + 返回 ok:false（绝不抛给调用方）', async () => {
  const logs = []
  const f = fakeFetch({ reject: Object.assign(new Error('socket hang up'), { name: 'FetchError' }) })
  const got = await fetchLatestVersion({ source: DEFAULT_UPDATE_SOURCE, fetchImpl: f, log: (m) => logs.push(m) })
  assert.equal(got.ok, false)
  assert.match(got.error, /socket hang up/)
  assert.equal(logs.length, 1, '失败必须留一条日志')
  assert.match(logs[0], /查新版本失败/)
})

await t('HTTP 4xx/5xx 也走 ok:false（不让 JSON 解析的异常冒出去）', async () => {
  const got = await fetchLatestVersion({ source: DEFAULT_UPDATE_SOURCE, fetchImpl: fakeFetch({ status: 404, body: {} }) })
  assert.equal(got.ok, false)
  assert.match(got.error, /HTTP 404/)
})

await t('源写错时不发请求（解析失败先短路）', async () => {
  // 注意：光一个词（如 `dsh-remote-qqbot`）是**合法**的 npm 包名，不能拿它当"写错"的样本。
  const f = fakeFetch({ body: {} })
  const got = await fetchLatestVersion({ source: 'ftp://cyanovo.top/update.json', fetchImpl: f })
  assert.equal(got.ok, false)
  assert.equal(f.calls.length, 0, '地址都不认识就不该发请求')
})

// ── [4] 自己在哪儿 ──────────────────────────────────────────────────────────
console.log('[4] 从安装路径反推 profile')

await t('普通安装路径能推出 profile 名与目录', () => {
  const p = resolveProfileFromPluginFile(
    'C:\\Users\\cyan\\.dsh\\profiles\\desktop\\node_modules\\dsh-remote-qqbot\\lib\\update.js',
  )
  assert.ok(p)
  assert.equal(p.profileName, 'desktop')
  assert.deepEqual(segs(p.profileDir), ['C:', 'Users', 'cyan', '.dsh', 'profiles', 'desktop'])
})

await t('pnpm 的 .pnpm 存储路径也能推出同一个 profile（不能只看 node_modules 的上一级）', () => {
  const p = resolveProfileFromPluginFile(
    'C:\\Users\\cyan\\.dsh\\profiles\\desktop\\node_modules\\.pnpm\\file+github+cyanovo+dsh-remote-qqbot\\node_modules\\dsh-remote-qqbot\\lib\\update.js',
  )
  assert.ok(p)
  assert.equal(p.profileName, 'desktop')
  assert.deepEqual(segs(p.profileDir).slice(-2), ['profiles', 'desktop'])
})

await t('没有 profiles 那一段就返回 null（不瞎猜）', () => {
  assert.equal(resolveProfileFromPluginFile('D:\\cyanproject\\agenttool\\dsh-remote-qqbot\\lib\\update.js'), null)
  assert.equal(resolveProfileFromPluginFile(''), null)
})

await t('插件根目录 = 本文件往上两层（lib/update.js → 插件根）', () => {
  assert.deepEqual(
    segs(pluginRootFromFile('C:\\x\\profiles\\desktop\\node_modules\\dsh-remote-qqbot\\lib\\update.js')).slice(-1),
    ['dsh-remote-qqbot'],
  )
})

await t('读版本号：坏 JSON / 缺文件都返回空串，不抛', () => {
  assert.equal(readPackageVersion('x', { readFileSync: () => '{"version":"1.0.7"}' }), '1.0.7')
  assert.equal(readPackageVersion('x', { readFileSync: () => '{坏了' }), '')
  assert.equal(readPackageVersion('x', { readFileSync: () => { throw new Error('ENOENT') } }), '')
  assert.equal(readPackageVersion('x', { readFileSync: () => '{"version":123}' }), '123')
})

await t('profile 目录判定看 package.json 里的 dsh.profile（不看目录名）', () => {
  const deps = fakeDeps([REAL_PROFILE], [REAL_PROFILE])
  assert.equal(isProfileDir(REAL_PROFILE, deps), true)
  const other = fakeDeps([REAL_PROFILE], [])
  assert.equal(isProfileDir(REAL_PROFILE, other), false, '没有 dsh.profile 就不算 profile 目录')
})

// ── [5] 更新通道 ────────────────────────────────────────────────────────────
console.log('[5] 更新通道（桌面版自带 pnpm 优先，dsh 只做兜底）')

await t('本机真实 argv 能认出 pnpm.mjs / runtime\\bin / profile 目录 / exe', () => {
  const rt = parseDesktopRuntime(REAL_ARGV, realDeps())
  assert.equal(rt.pnpmEntry, REAL_PNPM)
  assert.equal(rt.runtimeBinDir, REAL_BIN)
  assert.equal(rt.profileDir, REAL_PROFILE)
  assert.equal(rt.exe, REAL_EXE)
})

await t('runtime\\primary-runtime 不会被误判成 bin 目录', () => {
  const rt = parseDesktopRuntime(REAL_ARGV, realDeps())
  assert.notEqual(rt.runtimeBinDir, REAL_ARGV[5])
})

await t('argv 里的开关与相对路径会被跳过（不拿 `--expose-internals` 当目录）', () => {
  const rt = parseDesktopRuntime(REAL_ARGV, realDeps())
  assert.equal(rt.pnpmEntry.startsWith('--'), false)
  assert.equal(parseDesktopRuntime(['--type=renderer', 'node'], realDeps()).pnpmEntry, '')
})

await t('首选通道 = process.execPath + --expose-internals + pnpm.mjs add（实测可用那条）', () => {
  const cmd = buildAddCommand({
    profile: 'desktop',
    spec: DEFAULT_UPDATE_SOURCE,
    argv: REAL_ARGV,
    env: { ComSpec: 'cmd.exe' },
    platform: 'win32',
    executable: REAL_EXE,
    ...realDeps(),
  })
  assert.equal(cmd.ok, true)
  assert.equal(cmd.via, 'desktop-pnpm')
  assert.equal(cmd.file, REAL_EXE)
  assert.deepEqual(cmd.args, ['--expose-internals', REAL_PNPM, 'add', DEFAULT_UPDATE_SOURCE])
  assert.equal(cmd.cwd, REAL_PROFILE, '必须在 profile 目录里装')
  assert.equal(cmd.env.ELECTRON_RUN_AS_NODE, '1', '同一个 exe 当 node 用，官方 node.cmd 就是这么干的')
})

await t('execPath 不存在时退到 %DSH_DESKTOP_NODE_EXECUTABLE%', () => {
  const nodeExe = 'D:\\app\\dshdestop\\resources\\runtime\\bin\\node.exe'
  const cmd = buildAddCommand({
    profile: 'desktop',
    spec: 'dsh-remote-qqbot',
    argv: REAL_ARGV,
    env: { DSH_DESKTOP_NODE_EXECUTABLE: nodeExe, ComSpec: 'cmd.exe' },
    platform: 'win32',
    executable: 'D:\\不存在\\nope.exe',
    ...fakeDeps([REAL_PNPM, REAL_BIN, REAL_PROFILE, nodeExe], [REAL_PROFILE]),
  })
  assert.equal(cmd.ok, true)
  assert.equal(cmd.via, 'desktop-node')
  assert.equal(cmd.file, nodeExe)
})

await t('即使 PATH 上有 dsh，也优先用桌面版自带 pnpm（dsh 在开发机上指向源码检出）', () => {
  const dshCmd = path.join('D:\\tools', 'dsh.cmd')
  const cmd = buildAddCommand({
    profile: 'desktop',
    spec: DEFAULT_UPDATE_SOURCE,
    argv: REAL_ARGV,
    env: { PATH: 'D:\\tools', ComSpec: 'cmd.exe' },
    platform: 'win32',
    executable: REAL_EXE,
    ...fakeDeps([REAL_EXE, REAL_PNPM, REAL_BIN, REAL_PROFILE, dshCmd], [REAL_PROFILE]),
  })
  assert.equal(cmd.via, 'desktop-pnpm', '①必须压过③')
})

await t('bundledPnpmEntry：从 exe 自己推出资源目录，文件不存在就认不出来', () => {
  assert.equal(bundledPnpmEntry(REAL_EXE), REAL_PNPM, '本机确实存在 <exe目录>/resources/runtime/pnpm/bin/pnpm.mjs')
  assert.equal(bundledPnpmEntry(REAL_EXE, { exists: () => false }), '', '文件不存在就不认（不许猜安装位置）')
  assert.equal(bundledPnpmEntry(''), '')
  assert.equal(bundledPnpmEntry('DeepSeek Harness.exe'), '', '相对路径不算')
})

await t('argv 里没有 pnpm.mjs 时（主进程 CommandLine 只有 exe 自己）退到 exe 旁边的自带运行时', () => {
  const cmd = buildAddCommand({
    profile: 'desktop',
    spec: DEFAULT_UPDATE_SOURCE,
    argv: [REAL_EXE],
    env: { ComSpec: 'cmd.exe' },
    platform: 'win32',
    executable: REAL_EXE,
    profileDir: REAL_PROFILE,
    exists: (target) => [REAL_EXE, REAL_PNPM].map(norm).includes(norm(target)),
    readFileSync: () => { throw new Error('ENOENT') },
  })
  assert.equal(cmd.ok, true)
  assert.equal(cmd.via, 'desktop-pnpm-bundled')
  assert.equal(cmd.file, REAL_EXE, '还是用同一个 exe 当 node')
  assert.deepEqual(cmd.args, ['--expose-internals', REAL_PNPM, 'add', DEFAULT_UPDATE_SOURCE])
  assert.equal(cmd.cwd, REAL_PROFILE)
  assert.equal(cmd.env.ELECTRON_RUN_AS_NODE, '1')
})

await t('没有自带 pnpm 时才用 PATH 上的 dsh，且 Windows 必须走 cmd.exe /c', () => {
  const dshCmd = path.join('D:\\Program Files\\dsh', 'dsh.cmd')
  const cmd = buildAddCommand({
    profile: 'desktop',
    spec: DEFAULT_UPDATE_SOURCE,
    argv: ['D:\\app\\DeepSeek Harness.exe'],
    env: { PATH: 'D:\\Program Files\\dsh', ComSpec: 'cmd.exe' },
    platform: 'win32',
    executable: REAL_EXE,
    ...fakeDeps([REAL_EXE, dshCmd], []),
  })
  assert.equal(cmd.ok, true)
  assert.equal(cmd.via, 'dsh')
  assert.equal(cmd.file, 'cmd.exe')
  assert.equal(cmd.args[0], '/c')
  assert.equal(cmd.args[1], `"${dshCmd}"`, '带空格的路径必须加引号，否则 cmd 会拆开')
  assert.deepEqual(cmd.args.slice(2), ['plugin', '--profile', 'desktop', 'add', DEFAULT_UPDATE_SOURCE])
})

await t('非 Windows 上直接用 dsh，不加 cmd.exe 包装', () => {
  // 期望值用 path.join 现算：在 Windows 上跑这份测试时它是反斜杠，在 Linux 上是斜杠。
  const dshPath = path.join('/usr/local/bin', 'dsh')
  const cmd = buildAddCommand({
    profile: 'web',
    spec: 'dsh-remote-qqbot',
    argv: ['/usr/bin/node', '/home/me/.dsh/profiles/web'],
    env: { PATH: '/usr/local/bin' },
    platform: 'linux',
    executable: '/usr/bin/node',
    ...fakeDeps(['/usr/bin/node', '/home/me/.dsh/profiles/web', dshPath], ['/home/me/.dsh/profiles/web']),
  })
  assert.equal(cmd.ok, true)
  assert.equal(cmd.file, dshPath)
  assert.deepEqual(cmd.args, ['plugin', '--profile', 'web', 'add', 'dsh-remote-qqbot'])
  assert.equal(cmd.cwd, '/home/me/.dsh/profiles/web', 'profile 目录优先取 argv 里那个')
})

await t('最后兜底：profile 目录里 pnpm add（连 dsh 都没有时）', () => {
  // 特意用带空格的目录：Windows 上经 cmd.exe /c 启动时必须整体加引号。
  const pnpm = path.join('D:\\Program Files\\pnpm', 'pnpm.cmd')
  const cmd = buildAddCommand({
    profile: 'desktop',
    spec: 'dsh-remote-qqbot',
    argv: ['D:\\app\\DeepSeek Harness.exe'],
    env: { PATH: 'D:\\Program Files\\pnpm', ComSpec: 'cmd.exe' },
    platform: 'win32',
    executable: REAL_EXE,
    profileDir: 'C:\\Users\\cyan\\.dsh\\profiles\\desktop',
    ...fakeDeps([REAL_EXE, pnpm], []),
  })
  assert.equal(cmd.ok, true)
  assert.equal(cmd.via, 'pnpm')
  assert.deepEqual(cmd.args.slice(0, 2), ['/c', `"${pnpm}"`])
  assert.deepEqual(cmd.args.slice(2), ['add', 'dsh-remote-qqbot'])
})

await t('三条路都不通时给出人话，而不是抛异常', () => {
  const cmd = buildAddCommand({
    profile: 'desktop',
    spec: 'dsh-remote-qqbot',
    argv: ['D:\\app\\DeepSeek Harness.exe'],
    env: { PATH: 'D:\\空' },
    platform: 'win32',
    executable: REAL_EXE,
    ...fakeDeps([REAL_EXE], []),
  })
  assert.equal(cmd.ok, false)
  assert.match(cmd.error, /找不到可用的更新通道/)
})

await t('profile 名或源为空时直接拒绝（不拼出半条命令）', () => {
  assert.equal(buildAddCommand({ profile: '', spec: 'x', argv: [], ...fakeDeps([]) }).ok, false)
  assert.equal(buildAddCommand({ profile: 'desktop', spec: '  ', argv: [], ...fakeDeps([]) }).ok, false)
})

await t('findOnPath：Windows 上连 .cmd / .exe / .bat 一起试，找不到返回空串', () => {
  const exe = path.join('D:\\a', 'pnpm.exe')
  const found = findOnPath('pnpm', {
    env: { PATH: ['D:\\a', 'D:\\b'].join(path.delimiter) },
    platform: 'win32',
    ...fakeDeps([exe], []),
  })
  assert.equal(found, exe)
  assert.equal(findOnPath('nope', { env: { PATH: 'D:\\a' }, platform: 'win32', ...fakeDeps([], []) }), '')
})

// ── [6] 跑子进程（输出必须落文件）──────────────────────────────────────────
console.log('[6] 跑子进程（注入假 spawn / 假 fs，不起真进程）')

/** 假 fs：记录 fd 生命周期与写入的"输出文件"内容。 */
function fakeFs(output = '') {
  const seen = { opened: [], closed: [], unlinked: [] }
  return {
    seen,
    openSync: (file) => { seen.opened.push(file); return 42 },
    closeSync: (fd) => seen.closed.push(fd),
    readFileSync: () => output,
    unlinkSync: (file) => seen.unlinked.push(file),
  }
}

/** 假子进程：可控制退出码 / error 事件 / 永不退出（测超时）。 */
function fakeSpawn({ code = 0, error = null, hang = false } = {}) {
  const state = { options: null, file: null, args: null, killed: false }
  const child = { on() { return this }, kill() { state.killed = true } }
  state.spawn = (file, args, options) => {
    state.file = file
    state.args = args
    state.options = options
    const handlers = {}
    child.on = (ev, cb) => { handlers[ev] = cb; return child }
    if (!hang) {
      setImmediate(() => {
        if (error) handlers.error?.(error)
        else handlers.close?.(code)
      })
    } else {
      child.kill = () => { state.killed = true; setImmediate(() => handlers.close?.(null)) }
    }
    return child
  }
  return state
}

await t('成功：输出从文件读回来，fd 关掉、临时文件删掉', async () => {
  const state = fakeSpawn({ code: 0 })
  const fsf = fakeFs('added 1 package\n')
  const res = await runProcess({
    file: 'x.exe', args: ['add'], logFile: 'C:\\t\\out.log',
    spawnImpl: state.spawn, fsImpl: fsf,
  })
  assert.equal(res.ok, true)
  assert.equal(res.code, 0)
  assert.equal(res.output, 'added 1 package\n')
  assert.deepEqual(fsf.seen.closed, [42])
  assert.deepEqual(fsf.seen.unlinked, ['C:\\t\\out.log'], '别把临时输出文件留在磁盘上')
})

await t('stdio 里**不许出现** pipe（Windows 沙箱下子进程开管道会 EPERM）', async () => {
  const state = fakeSpawn({ code: 0 })
  await runProcess({ file: 'x.exe', args: [], logFile: 'C:\\t\\o.log', spawnImpl: state.spawn, fsImpl: fakeFs('') })
  const stdio = state.options.stdio
  assert.deepEqual(stdio, ['ignore', 42, 42])
  assert.equal(stdio.includes('pipe'), false)
  assert.equal(state.options.windowsHide, true, '别弹黑框')
})

await t('非零退出码 → ok:false（但输出照样带回来给用户看）', async () => {
  const state = fakeSpawn({ code: 1 })
  const res = await runProcess({
    file: 'x.exe', args: [], logFile: 'C:\\t\\o.log',
    spawnImpl: state.spawn, fsImpl: fakeFs('ERR_PNPM_NO_MATCHING_VERSION'),
  })
  assert.equal(res.ok, false)
  assert.equal(res.code, 1)
  assert.match(res.output, /NO_MATCHING_VERSION/)
})

await t('spawn 报错 / 同步抛异常都只是 ok:false + 一句人话', async () => {
  const s1 = fakeSpawn({ error: new Error('spawn EINVAL') })
  const r1 = await runProcess({ file: 'x.cmd', args: [], logFile: 'C:\\t\\o.log', spawnImpl: s1.spawn, fsImpl: fakeFs('') })
  assert.equal(r1.ok, false)
  assert.match(r1.error, /EINVAL/)

  const r2 = await runProcess({
    file: 'x', args: [], logFile: 'C:\\t\\o.log',
    spawnImpl: () => { throw new Error('boom') },
    fsImpl: fakeFs(''),
  })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /启动失败：boom/)
})

await t('打不开输出文件时立刻失败（不硬着头皮 spawn）', async () => {
  const res = await runProcess({
    file: 'x', args: [], logFile: 'C:\\只读\\o.log',
    spawnImpl: () => { throw new Error('不该走到这里') },
    fsImpl: { openSync: () => { throw new Error('EPERM') }, closeSync() {}, readFileSync: () => '', unlinkSync() {} },
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /打不开输出文件/)
})

await t('超时会被 kill，并标成 timedOut（安装卡死不能把 DSH 一起拖住）', async () => {
  const state = fakeSpawn({ hang: true })
  const logs = []
  // ⚠️ runProcess 的超时闹钟是 unref 的（生产环境里它是对的：不能让一次检查吊住进程），
  //    所以这里要**自己**留一个 ref 的计时器把事件循环撑住，否则进程会在闹钟响之前退出。
  let bail = null
  const res = await Promise.race([
    runProcess({
      file: 'x.exe', args: [], logFile: 'C:\\t\\o.log', timeoutMs: 30,
      spawnImpl: state.spawn, fsImpl: fakeFs('partial'), log: (m) => logs.push(m),
    }),
    new Promise((resolve) => { bail = setTimeout(() => resolve({ ok: 'HARNESS_TIMEOUT' }), 3000) }),
  ])
  clearTimeout(bail)
  assert.equal(state.killed, true)
  assert.equal(res.timedOut, true)
  assert.equal(res.ok, false)
  assert.match(logs.join('\n'), /没结束，已终止/)
})

await t('env 只有在需要时才覆盖（ELECTRON_RUN_AS_NODE 会合进基础环境）', async () => {
  const s1 = fakeSpawn({ code: 0 })
  await runProcess({
    file: 'x', args: [], logFile: 'C:\\t\\o.log', env: { ELECTRON_RUN_AS_NODE: '1' },
    baseEnv: { PATH: 'D:\\a' }, spawnImpl: s1.spawn, fsImpl: fakeFs(''),
  })
  assert.equal(s1.options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(s1.options.env.PATH, 'D:\\a', '基础环境变量不能丢')

  const s2 = fakeSpawn({ code: 0 })
  await runProcess({ file: 'x', args: [], logFile: 'C:\\t\\o.log', spawnImpl: s2.spawn, fsImpl: fakeFs('') })
  assert.equal(s2.options.env, undefined, '不需要时别动环境')
})

await t('安装超时默认 180 秒（配置项说明里承诺的数字）', () => {
  assert.equal(UPDATE_INSTALL_TIMEOUT_MS, 180 * 1000)
})

// ── [7] 重启脚本 ────────────────────────────────────────────────────────────
console.log('[7] 重启脚本')

const script = buildRestartScript({
  exePath: 'D:\\app\\dshdestop\\DeepSeek Harness.exe',
  logFile: 'C:\\Users\\cyan\\.dsh\\dsh-remote-update.log',
  note: '更新到 1.0.7',
})

await t('先等 10 秒再动手（回执得先发出去）', () => {
  assert.equal(RESTART_DELAY_SECONDS, 10)
  assert.match(script, /Start-Sleep -Seconds 10/)
})

await t('按**可执行文件路径**杀进程（同名进程可能不止一个）', () => {
  assert.match(script, /\$path -eq \$exe/)
  assert.match(script, /foreach \(\$p in @\(Find-AppProcess\)\)/)
  assert.match(script, /Stop-Process -Id \$p\.Id -Force/)
})

await t('杀完要**等它真的消失**再启动（否则新进程会被退出流程带掉）', () => {
  assert.match(script, /while \(\$waited -lt 20 -and @\(Find-AppProcess\)\.Count -gt 0\)/)
  assert.match(script, /Start-Sleep -Seconds 1/)
  // 全没了之后再稳几秒：单实例锁与旧退出流程要时间彻底放开。
  assert.match(script, /Start-Sleep -Seconds 3/)
})

await t('最多 3 次，每次隔 5 秒', () => {
  assert.equal(RESTART_RETRIES, 3)
  assert.match(script, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/)
  assert.match(script, /Start-Sleep -Seconds 5/)
})

// ── 这一条是 2026-10-05 真实故障的防线 ──────────────────────────────────────
// 现场：/update 装好了、脚本也跑了、进程也杀了，但 DSH 再没起来，主人只能手动打开。
// 查到根因是重启链继承了插件进程的 `ELECTRON_RUN_AS_NODE=1`：带着它的
// `DeepSeek Harness.exe` 只当 node 跑一下就退出（实测 `--version` 输出 `v24.18.1`），
// 桌面版根本没启动 —— 没有进程、没有 lockfile、没有崩溃日志，脚本只看到"启动后没看到进程"。
await t('启动新进程前必须清掉继承来的 ELECTRON_RUN_AS_NODE（否则 exe 只当 node 跑）', () => {
  // 常量与脚本必须一致：名单是唯一来源，不能各写一份。
  assert.ok(RESTART_POISON_ENV.includes('ELECTRON_RUN_AS_NODE'))
  assert.match(script, /\$poison = @\('ELECTRON_RUN_AS_NODE'/)
  assert.match(script, /Remove-Item "Env:\$name"/)
  // 清理必须发生在**任何启动动作之前**（否则等于没清）。
  assert.ok(script.indexOf('Remove-Item "Env:$name"') < script.indexOf('Start-Process -FilePath $exe'))
  // 会话自己的标记也不该被新实例继承。
  for (const name of ['DSH_SHELL', 'DSH_SESSION_ID', 'DSH_WEB_URL']) {
    assert.ok(RESTART_POISON_ENV.includes(name), `${name} 应该在清理名单里`)
  }
})

await t('三种启动方式依次兜底（start-process → explorer → wmi），环境脏了也还有退路', () => {
  assert.match(script, /foreach \(\$how in @\('start-process', 'explorer', 'wmi'\)\)/)
  assert.match(script, /Start-Process -FilePath \$exe -WorkingDirectory \$exeDir/)
  assert.match(script, /Start-Process -FilePath 'explorer\.exe'/)
  assert.match(script, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/)
  // 每种方式失败要把原因写进日志，不能默默换下一种。
  assert.match(script, /Write-UpdateLog "用 \$how 启动失败：\$\(\$r\.error\)"/)
})

await t('认进程用两套量具：Get-Process 的 Path 读不到时用 CIM 的 ExecutablePath 兜底', () => {
  // 实测：刚创建出来的进程 `$_.Path` 常常是空的，只看它会漏掉"其实已经起来了"的进程。
  assert.match(script, /\$path = \[string\]\$p\.Path/)
  assert.match(script, /Get-CimInstance Win32_Process -Filter "ProcessId=\$\(\$p\.Id\)"/)
  assert.match(script, /\$path = \[string\]\$cim\.ExecutablePath/)
})

await t('看到进程还不算成功：再盯 4 秒确认它没秒退（抢单实例锁失败就是这样）', () => {
  assert.match(script, /Start-Sleep -Seconds 4/)
  assert.match(script, /起来的进程又没了/)
})

await t('失败时把桌面版最新崩溃日志的尾巴抄进同一份日志（下次不用满硬盘找）', () => {
  assert.match(script, /crash-\*\.log/)
  assert.match(script, /重启失败：请手动打开 DSH/)
  assert.match(script, /-Tail 8/)
})

await t('新进程"起了又没"时把它的退出码写进日志（2026-10-05 最缺的就是这句话）', () => {
  // 现场那次 exe 是当 node 跑、**退出码 0** 立刻退出 —— 有退出码就能一眼认出"起来就秒退"。
  assert.match(script, /function Get-ExitCodeText\(\$proc\)/)
  assert.match(script, /\$proc\.ExitCode/)
  assert.match(script, /没看到进程\$\(Get-ExitCodeText \$r\.proc\)/)
  assert.match(script, /起来的进程又没了（多半是单实例检测）\$\(Get-ExitCodeText \$r\.proc\)/)
  // 得把进程对象带回来才拿得到退出码（只有 pid 是不够的）。
  assert.match(script, /return @\{ ok = \$true; pid = \$p\.Id; proc = \$p; error = '' \}/)
  // 另两种方式没有进程对象，必须传 $null 而不是崩掉。
  assert.match(script, /return @\{ ok = \$true; pid = 0; proc = \$null; error = '' \}/)
})

await t('全程追加写日志（事后能查"到底重启成功没有"）', () => {
  assert.match(script, /Add-Content -LiteralPath \$log -Value \$line -Encoding UTF8/)
  assert.match(script, /dsh-remote-update\.log/)
  assert.match(buildRestartScript({ exePath: 'x.exe', logFile: 'l.log', note: '更新到 1.0.7' }), /更新到 1\.0\.7/)
})

await t('路径里有单引号时按 PowerShell 规矩转义（写两遍）', () => {
  const s = buildRestartScript({ exePath: "D:\\a'b\\x.exe", logFile: "C:\\l'o.log" })
  assert.match(s, /\$exe = 'D:\\a''b\\x\.exe'/)
  assert.match(s, /\$log = 'C:\\l''o\.log'/)
})

await t('桌面版不需要参数：默认不给 $exe 加 -ArgumentList；带参数的按 PowerShell 规矩转义', () => {
  // explorer 兜底那条自己会带 -ArgumentList（那是给 explorer 的），这里只要求**桌面版本体**不带参数。
  assert.equal(/Start-Process -FilePath \$exe[^\n]*-ArgumentList/.test(script), false)
  const withArgs = buildRestartScript({ exePath: 'x.exe', logFile: 'l.log', exeArgs: ['-e', 'setInterval(()=>{},1)'] })
  assert.match(withArgs, /-ArgumentList @\('-e', '"setInterval\(\(\)=>\{\},1\)"'\)/)
  // 干净参数原样单引号；带空格/括号/引号的自己再裹一层双引号。
  assert.match(
    buildRestartScript({ exePath: 'x.exe', logFile: 'l.log', exeArgs: ['--foo', 'ok'] }),
    /-ArgumentList @\('--foo', 'ok'\)/,
  )
  // ⚠️ 实测踩过：PowerShell 把数组元素用空格拼起来、**不加引号**，带空格的参数会被拆成碎片
  // （`-e "setInterval(() => {}, 1)"` 拼过去后 node 直接语法错误退出 → 表现为"起了又立刻没了"）。
  const spaced = buildRestartScript({ exePath: 'x.exe', logFile: 'l.log', exeArgs: ['--user-data-dir=C:\\a b', 'ok'] })
  assert.match(spaced, /-ArgumentList @\('"--user-data-dir=C:\\a b"', 'ok'\)/)
  const hasQuote = buildRestartScript({ exePath: 'x.exe', logFile: 'l.log', exeArgs: ['--x="a b"'] })
  assert.match(hasQuote, /'"--x=\\"a b\\""'/)
})

await t('写脚本：加 BOM（PowerShell 5.1 才能正确读中文）+ 真的写进临时目录', () => {
  const seen = {}
  const fake = {
    mkdirSync: (dir, opts) => { seen.dir = dir; seen.opts = opts },
    writeFileSync: (file, text, enc) => { seen.file = file; seen.text = text; seen.enc = enc },
  }
  const res = writeRestartScript({ dir: 'C:\\t', script: 'Write-Host 好', fsImpl: fake, stamp: 7 })
  assert.equal(res.ok, true)
  assert.equal(seen.text.slice(0, 1), '\uFEFF')
  assert.equal(seen.enc, 'utf8')
  assert.deepEqual(seen.opts, { recursive: true })
  assert.match(res.path, /dsh-remote-restart-7\.ps1$/)

  // 真写一次，用**字节**核对 BOM（不是看字符串）—— BOM 错了 PowerShell 会读成乱码。
  const real = writeRestartScript({ dir: os.tmpdir(), script, stamp: Date.now() })
  assert.equal(real.ok, true)
  const bytes = fs.readFileSync(real.path).subarray(0, 3)
  assert.deepEqual([...bytes], [0xEF, 0xBB, 0xBF])
  fs.unlinkSync(real.path)
})

await t('写脚本失败也不抛（返回 ok:false）', () => {
  const res = writeRestartScript({
    dir: 'C:\\t', script: 'x',
    fsImpl: { mkdirSync() {}, writeFileSync() { throw new Error('EACCES') } },
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /写重启脚本失败/)
})

await t('分离启动：走 cmd 的 start（实测唯一"既跑得起来又活得过父进程"的配方）', () => {
  const state = {}
  const ok = launchRestartScript({
    scriptPath: 'C:\\t\\r.ps1',
    launcherPath: 'C:\\t\\r.cmd',
    comspec: 'cmd.exe',
    spawnImpl: (file, args, options) => {
      state.file = file
      state.args = args
      state.options = options
      state.unrefCalled = false
      return { unref: () => { state.unrefCalled = true } }
    },
  })
  assert.equal(ok, true)
  assert.equal(state.file, 'cmd.exe', '直接 detached 起 powershell 时脚本一行都不执行')
  assert.deepEqual(state.args, ['/c', 'C:\\t\\r.cmd'])
  assert.equal(state.options.detached, true)
  assert.equal(state.options.stdio, 'ignore')
  assert.equal(state.options.windowsHide, true)
  assert.equal(state.unrefCalled, true)
})

await t('启动器写不出来时退回直接 spawn powershell（兜底路径仍可用）', () => {
  const state = {}
  launchRestartScript({
    scriptPath: 'C:\\t\\r.ps1',
    spawnImpl: (file, args) => { state.file = file; state.args = args; return { unref() {} } },
  })
  assert.equal(state.file, 'powershell.exe')
  assert.deepEqual(state.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\t\\r.ps1'])
})

await t('启动器内容：一行 start "" /min powershell -File 脚本，且全 ASCII', () => {
  const written = []
  const res = writeRestartLauncher({
    dir: 'C:\\t',
    scriptPath: 'C:\\t a\\r.ps1',
    stamp: 7,
    fsImpl: { mkdirSync() {}, writeFileSync: (f, text) => written.push({ f, text }) },
  })
  assert.equal(res.ok, true)
  assert.match(res.path, /dsh-remote-restart-7\.cmd$/)
  assert.match(written[0].text, /^@echo off\r\n/)
  assert.match(written[0].text, /start "" \/min "powershell\.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\\t a\\r\.ps1"/)
  assert.equal(/[^\x00-\x7F]/.test(written[0].text), false, 'cmd 按 OEM 代码页读文件，非 ASCII 会乱')
})

await t('确认脚本真在跑：日志长出来才算成功（正向 + 反向都测）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-verify-'))
  try {
    const log = path.join(dir, 'update.log')
    const before = restartLogSize(log)
    assert.equal(before, 0, '日志还不存在时算 0')
    // 反向：没人写日志（= 脚本没跑起来）→ 必须判失败
    assert.equal(await verifyRestartLaunched({ logFile: log, before, timeoutMs: 300, intervalMs: 50 }), false)
    // 正向：脚本写下第一行 → 必须判成功
    const pending = verifyRestartLaunched({ logFile: log, before, timeoutMs: 2000, intervalMs: 50 })
    setTimeout(() => fs.appendFileSync(log, 'x\n'), 150)
    assert.equal(await pending, true)
    assert.equal(await verifyRestartLaunched({ logFile: log, before: restartLogSize(log), timeoutMs: 200 }), false, '已有内容不算新长出来')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await t('拉不起来重启脚本时返回 false 而不是抛', () => {
  const logs = []
  const ok = launchRestartScript({
    scriptPath: 'C:\\t\\r.ps1',
    spawnImpl: () => { throw new Error('EPERM') },
    log: (m) => logs.push(m),
  })
  assert.equal(ok, false)
  assert.match(logs.join('\n'), /启动重启脚本失败/)
  assert.equal(launchRestartScript({ scriptPath: '' }), false)
})

// ── [8] 面向用户的文案 ──────────────────────────────────────────────────────
console.log('[8] 文案（措辞是硬要求）')

await t('发现新版本：说清版本差异 + 会重启 + 中间连不上', () => {
  const text = formatUpdateAvailable({ latest: '1.0.7', current: '1.0.6' })
  assert.equal(text, '🔔 插件有新版本 1.0.7（现在跑的是 1.0.6）。发 /update 我就装上 —— 装完会自动重启 DSH，中间有十几秒连不上。')
})

await t('开始更新 / 已是最新 / 远端更旧 / 正在忙', () => {
  assert.equal(formatUpdating({ version: '1.0.7' }), '正在更新到 1.0.7…')
  assert.equal(formatAlreadyLatest({ current: '1.0.6' }), '已经是最新版 1.0.6，不用更新')
  assert.equal(formatRemoteOlder({ latest: '1.0.5', current: '1.0.6' }), '远端还是 1.0.5，比本机（1.0.6）旧，不用更新')
  assert.match(formatUpdateBusy(), /正在更新中/)
  assert.match(formatUpdateCheck({ latest: '1.0.7', current: '1.0.6' }), /^有新版本 1\.0\.7/)
  assert.match(formatUpdateCheck({ current: '1.0.6', upToDate: true }), /^已经是最新版/)
})

await t('装好了：自动重启那版必须提醒会离线；关掉自动重启就说"重启后生效"', () => {
  const auto = formatUpdateDone({ latest: '1.0.7', from: '1.0.6', autoRestart: true })
  assert.equal(auto, '✅ 已装 1.0.7（原来是 1.0.6）。10 秒后自动重启 DSH —— 重启期间机器人会离线一会儿，起来后我会回你一条确认；要是过了一分钟还没回来，手动打开 DSH 就行。')
  // 插件活不到重启那一刻，"没回来怎么办"必须提前说：2026-10-05 就是自动重启失败、
  // 主人对着 QQ 等一条不会来的确认，最后自己手动打开的。
  assert.match(auto, /手动打开 DSH/)
  const manual = formatUpdateDone({ latest: '1.0.7', from: '1.0.6', autoRestart: false })
  assert.equal(manual, '✅ 已装 1.0.7（原来是 1.0.6）。重启 DSH 后生效。')
  const unscheduled = formatUpdateDone({ latest: '1.0.7', from: '1.0.6', autoRestart: true, scheduled: false })
  assert.equal(unscheduled, '✅ 已装 1.0.7（原来是 1.0.6）。自动重启没能排上，手动重启 DSH 后生效。')
})

await t('装完版本没变：说清"源上可能还没发"，不假装成功', () => {
  assert.match(formatUpdateNoChange({ version: '1.0.6' }), /版本还是 1\.0\.6/)
  assert.match(formatUpdateNoChange({ version: '1.0.6' }), /远端可能还没发这一版/)
})

await t('失败：一句人话 + 最后 600 字错误摘要', () => {
  const text = formatUpdateFailed({ reason: '安装命令失败（退出码 1）', output: 'A'.repeat(900) + 'END' })
  assert.match(text, /^❌ 更新没成功：安装命令失败（退出码 1）。/)
  assert.match(text, /错误摘要（最后 600 字）/)
  assert.ok(text.endsWith('END'))
  assert.equal([...text].filter((c) => c === 'A').length, ERROR_TAIL_CHARS - 3, '只留最后 600 个字（含 END 三个）')
})

await t('查版本失败 / 环境不全也各有一句人话', () => {
  assert.match(formatCheckFailed({ error: '请求超时（20 秒）' }), /❌ 查新版本失败：请求超时（20 秒）/)
  assert.match(formatUpdateMisconfigured({ reason: '看不出自己是装在哪个 profile 里的' }), /❌ 现在没法自动更新/)
})

await t('重启后的确认：带上新版本号与用时', () => {
  assert.equal(formatRestartDone({ version: '1.0.7', seconds: 12.4 }), '✅ 重启完成，插件现在是 1.0.7（重启用了 12 秒）。')
  assert.equal(formatRestartDone({ version: '1.0.7', seconds: -3 }), '✅ 重启完成，插件现在是 1.0.7（重启用了 0 秒）。')
})

await t('tailText：按码点数取尾部，长文本前面加省略号', () => {
  assert.equal(tailText('abc', 10), 'abc')
  assert.equal(tailText('', 10), '')
  assert.equal(tailText('abcdef', 3), '…def')
  // 代理对（emoji）不能被切成半个字符
  const emoji = '😀😀😀😀'
  assert.equal([...tailText(emoji, 2)].length, 3)
})

// ── [9] 接线（源码字面；这几条只有 line-level 的判据）──────────────────────
console.log('[9] 接线')

await t('qqbridge：/update 与 /更新 都路由到 {kind:update}，check 只查不装', () => {
  assert.deepEqual(routeIncoming('/update'), { kind: 'update', check: false })
  assert.deepEqual(routeIncoming('/更新'), { kind: 'update', check: false })
  assert.deepEqual(routeIncoming('/update check'), { kind: 'update', check: true })
  assert.deepEqual(routeIncoming('/更新 检查'), { kind: 'update', check: true })
  assert.match(HELP_TEXT, /^\/update\s+把插件更新到最新版（会自动重启 DSH）$/m)
})

await t('qqruntime：/update 有自己的处理函数，并在 switch 里被调用', () => {
  const src = readSrc('qqruntime.js')
  assert.match(src, /async function handleUpdate\(checkOnly, data\)/)
  assert.match(src, /case 'update':\s*\n\s*await handleUpdate\(Boolean\(route\.check\), data\)/)
  assert.match(src, /async function checkUpdate\(\)/, '轮询用的查版本入口')
  assert.match(src, /async function reportRestartIfPending\(\)/)
  assert.match(src, /function restartDSH\(\{ version \}\)/)
})

await t('qqruntime：三分支判据（> 提醒 / === 静默 / < 静默且不装）', () => {
  const src = readSrc('qqruntime.js')
  assert.match(src, /const cmp = compareVersions\(got\.version, env\.version\)/)
  assert.match(src, /cmp === 0/, '相同版本要静默')
  assert.match(src, /cmp < 0/, '远端更旧也要静默')
  assert.match(src, /formatRemoteOlder/, '更旧时不许装，只回一句"远端还旧"')
})

await t('qqruntime：装完的版号从**安装目录**读回来，不靠"命令成功"推断', () => {
  const src = readSrc('qqruntime.js')
  assert.match(src, /node_modules', 'dsh-remote-qqbot', 'package\.json'/)
  assert.match(src, /result\.installed === env\.version/, '版本没变必须说"没变化"')
})

await t('qqruntime：自动重启要**确认脚本真在跑**，不能"进程建出来了"就当成功', () => {
  const src = readSrc('qqruntime.js')
  assert.match(src, /writeRestartLauncher\(/, '要走 cmd 启动器（直接 detached 起 powershell 实测不执行）')
  assert.match(src, /await verifyRestartLaunched\(\{ logFile, before \}\)/, '要等日志长出来才算排定成功')
  assert.match(src, /autoRestart: wantRestart, scheduled: launched/, '排不上时必须回"手动重启"而不是"正在重启"')
})

await t('qqruntime：轮询定时器 unref 且 stop() 里清掉（不吊着进程）', () => {
  const src = readSrc('qqruntime.js')
  assert.match(src, /updateTimer = setInterval\(\(\) => \{ void checkUpdate\(\) \}/)
  assert.match(src, /if \(updateTimer\.unref\) updateTimer\.unref\(\)/)
  assert.match(src, /function stop\(\) \{[\s\S]{0,80}?stopUpdateCheck\(\)/)
})

await t('index.js：四个键进了 DEFAULTS、settings schema 与归一化', () => {
  const src = readSrc('index.js')
  for (const key of ['qqUpdateEnabled', 'qqUpdateSource', 'qqUpdateAutoRestart', 'qqUpdateCheckHours']) {
    assert.match(src, new RegExp(`${key}: (true|false|'[^']+'|6),`), `${key} 要在 DEFAULTS 里`)
    assert.match(src, new RegExp(`${key}: z\\.(boolean|string|number)\\(\\)`), `${key} 要在 Config schema 里`)
    assert.match(src, new RegExp(`${key}: `), `${key} 要在归一化块里`)
  }
  assert.match(src, /qqUpdateEnabled: merged\.qqUpdateEnabled !== false/, '缺省视为开')
  assert.match(src, /qqUpdateAutoRestart: merged\.qqUpdateAutoRestart !== false/)
  assert.match(src, /qqUpdateSource[\s\S]{0,200}?DEFAULTS\.qqUpdateSource/, '源写空了回到默认源')
  assert.match(
    src,
    /qqUpdateSource: 'https:\/\/cyanovo\.top\/plugins\/dsh-remote-qqbot\/update\.json'/,
    '默认源 = 服务器上的版本索引',
  )
  assert.match(src, /qqUpdateCheckHours[\s\S]{0,200}?Math\.min\(168,/, '上限一周，别让定时器空转')
})

await t('index.js：启动时先回重启确认，再开始轮询', () => {
  const src = readSrc('index.js')
  assert.match(src, /await qq\.reportRestartIfPending\(\)/)
  assert.match(src, /qq\.startUpdateCheck\(\)/)
  assert.match(src, /远程更新检查启动失败（不影响其它功能）/, '整段要包在 try 里，不许影响启动')
})

await t('config-api：四个键进了设置界面（否则用户改不了）', () => {
  const src = readSrc('config-api.js')
  for (const key of ['qqUpdateEnabled', 'qqUpdateSource', 'qqUpdateAutoRestart', 'qqUpdateCheckHours']) {
    assert.match(src, new RegExp(`key: '${key}', group: 'qq'`), `${key} 必须在 FIELD_SPECS 里，且归到 QQ 分组`)
  }
})

await t('qqbridge：状态文件里存了"已提醒过的版本"与"重启标记"', () => {
  const src = readSrc('qqbridge.js')
  assert.match(src, /updateNotified: ''/)
  assert.match(src, /updateRestart: null/)
})

await t('重启目标是**从命令行认出来的**主程序，不写死任何一台机器的路径', () => {
  const src = readSrc('qqruntime.js')
  assert.doesNotMatch(src, /dshdestop/i, '不许把某台机器的安装路径写进代码')
  assert.match(src, /DSH_DESKTOP_EXE/, '要能用环境变量覆盖')
  assert.match(src, /parseDesktopRuntime\(process\.argv\)\.exe/, '认不出来就给空串 ⇒ 不自动重启')
  // 认得出桌面版时，exe 就是主进程 argv 里那个 exe（本机实测的那份 argv）
  assert.equal(parseDesktopRuntime(REAL_ARGV, realDeps()).exe, REAL_EXE)
  assert.match(REAL_EXE, /DeepSeek Harness\.exe$/i)
})

await t('src/update.js 不引任何外部依赖（宿主要求零依赖，构建脚本也只放行两个）', () => {
  const src = readSrc('update.js')
  const imports = [...src.matchAll(/^import .*from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports.sort(), ['node:child_process', 'node:fs', 'node:os', 'node:path'])
})

console.log(`\n${fail === 0 ? '✅' : '❌'} update 组：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  for (const f of failures) console.log(`\n--- ${f.name}\n${f.err?.stack ?? f.err}`)
}
process.exit(fail === 0 ? 0 : 1)
