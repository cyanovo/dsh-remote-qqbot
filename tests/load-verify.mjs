/**
 * 验证这个包能被 DSH 正常加载 —— 逐层递进，每层都留真实输出。
 *
 * 层 1：包里的 lib/index.js 能否 import（排除 ERR_MODULE_NOT_FOUND）
 * 层 2：包自己声明的 bundle 层（dsh.bundle.patch）能解析到，且 main 指向对
 * 层 3：用真实的 @deepseek-ai/dsh-tools 装配，确认 apply() 可调用、工具都注册上了
 *
 * 验证对象：机器上装了 profile 就验**装好的那一份**（真装真跑），没装就验**当前仓库**
 * （结果只取决于这份代码 + devDependencies）。两种模式在 CI 与别人的机器上都能跑。
 *
 *   node tests/load-verify.mjs                 # 自动：装了 profile 就验 profile，否则验仓库
 *   node tests/load-verify.mjs --repo          # 强制验当前仓库
 *   node tests/load-verify.mjs --installed [profile名]
 *   DSH_HOME=/path/to/.dsh node tests/load-verify.mjs --installed
 *
 * 前置：仓库模式下要先有 node_modules（npm install，或本地开发用 node scripts/link-dev.mjs）。
 * 脚本里**不写死任何机器上的路径**。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

const args = process.argv.slice(2)
const forceRepo = args.includes('--repo')
const forceInstalled = args.includes('--installed') || process.env.VERIFY_INSTALLED === '1'
const profileArg = args.find((a) => !a.startsWith('--'))
const PROFILE = process.env.DSH_PROFILE || profileArg || 'desktop'

// 装过的那份在 <DSH_HOME>/profiles/<profile>/node_modules/dsh-remote-qqbot；
// 宿主依赖（@deepseek-ai/*）也在**同一个** profile 的 node_modules 里。
const PROFILE_NM = join(DSH_HOME, 'profiles', PROFILE, 'node_modules')
const INSTALLED_PKG = join(PROFILE_NM, 'dsh-remote-qqbot')

const installedExists = existsSync(INSTALLED_PKG)
const USE_INSTALLED = forceInstalled || (!forceRepo && installedExists)
if (forceInstalled && !installedExists) {
  console.log(`✗ profile ${PROFILE} 里没装这个包：${INSTALLED_PKG}`)
  console.log(`  先装：dsh plugin --profile ${PROFILE} add <包名 | ./xxx.tgz | github:cyanovo/dsh-remote-qqbot>`)
  process.exit(1)
}

const PKG_DIR = USE_INSTALLED ? INSTALLED_PKG : ROOT
const RESOLVE_FROM = USE_INSTALLED ? PROFILE_NM : join(ROOT, 'node_modules')

if (!existsSync(RESOLVE_FROM)) {
  console.log(`✗ 找不到依赖目录：${RESOLVE_FROM}`)
  console.log('  先在仓库里装依赖：npm install（或本地开发：node scripts/link-dev.mjs）')
  process.exit(1)
}
const require = createRequire(join(RESOLVE_FROM, 'noop.js'))

let failures = 0
const ok = (label, detail) => console.log(`  ✓ ${label}${detail ? `\n      ${detail}` : ''}`)
const bad = (label, detail) => { failures += 1; console.log(`  ✗ ${label}\n      ${detail}`) }

console.log(`验证对象：${USE_INSTALLED ? `profile ${PROFILE} 里装好的那一份` : '当前仓库'}${USE_INSTALLED && !forceInstalled ? '（自动选中：机器上装了）' : ''}`)
console.log(`  包目录：${PKG_DIR}`)
console.log(`  依赖解析自：${RESOLVE_FROM}`)

console.log('\n=== 层 1：加载包里的插件产物 ===')
let mod
try {
  mod = await import(pathToFileURL(join(PKG_DIR, 'lib/index.js')).href)
  ok('import 成功，无 ERR_MODULE_NOT_FOUND', `exports: ${Object.keys(mod).join(', ')}`)
} catch (err) {
  bad('import 失败', `${err?.code ?? ''} ${err?.message ?? err}`)
  process.exit(1)
}

console.log('\n=== 层 2：包自己声明的 bundle 层 ===')
try {
  // 装过的走 require.resolve（复刻 DSH 的 resolveBundleDir 判定）；仓库自身直接读本目录的 package.json
  const pkgJsonPath = USE_INSTALLED ? require.resolve('dsh-remote-qqbot/package.json') : join(ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  ok('package.json 能读到', pkgJsonPath)
  ok('dsh.bundle.patch 已声明', JSON.stringify(pkg.dsh?.bundle?.patch))
  const patchPath = join(PKG_DIR, String(pkg.dsh?.bundle?.patch ?? '').replace(/^\.\//, ''))
  if (!existsSync(patchPath)) bad('patch 文件不存在', patchPath)
  else ok('patch 文件存在', `${patchPath} (${readFileSync(patchPath).length} B)`)
  if (pkg.main !== 'lib/index.js') bad('main 字段不对', String(pkg.main))
  else ok('main 指向 lib/index.js', pkg.main)
} catch (err) {
  bad('bundle 解析失败', `${err?.message ?? err}`)
}

console.log('\n=== 层 3：真实 @deepseek-ai/dsh-tools 装配 ===')
try {
  const toolsPath = require.resolve('@deepseek-ai/dsh-tools')
  ok('宿主提供 @deepseek-ai/dsh-tools', toolsPath)
  const registered = []
  const events = []
  const ctx = {
    on(e, h) { events.push(e); return () => {} },
    effect(fn) { fn(); return () => {} },
    get() { return undefined },
    tools: { register(def) { registered.push(def.name); return () => {} } },
  }
  mod.apply(ctx, {})
  ok('apply() 调用成功', `订阅事件: ${[...new Set(events)].join(', ')}`)
  const expected = ['agentmd_read', 'memory_forget', 'memory_read', 'memory_write']
  const missing = expected.filter((n) => !registered.includes(n))
  if (missing.length > 0) bad('工具注册不全', `缺少 ${missing.join(', ')}`)
  else ok(`${expected.length} 个核心工具全部注册`, registered.slice().sort().join(', '))
} catch (err) {
  bad('装配失败', `${err?.message ?? err}`)
}

console.log(`\n结果：${failures === 0 ? '三层全部通过' : `${failures} 层失败`}`)
if (failures > 0) process.exitCode = 1
