/**
 * 用真实 profile 里**已安装**的包做一次「加载 + 装配」验证。
 *
 * 与 `scripts/verify-installed.mjs` 的分工：
 *   - 本脚本只验「能不能加载、能不能装配工具」，不依赖中枢 / QQ 等外部服务；
 *   - 需要真实外部服务或安装目录字面的检查在 `scripts/` 下。
 *
 * 验证点：
 *   1. 安装目录里的 dsh-remote-qqbot/lib/index.js 能成功 import
 *   2. 它依赖的 @deepseek-ai/dsh-tools 在该 profile 里能解析到
 *   3. 用真实的 defineTool 注册 4 个工具不报错
 *
 * 路径不硬编码：默认取 `~/.dsh/profiles/<DSH_PROFILE>/node_modules`，
 * 可用环境变量 `DSH_HOME` / `DSH_PROFILE` 覆盖（换机器、换 profile 都不用改代码）。
 *
 * 用法：node tests/live/installed.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE = process.env.DSH_PROFILE || 'desktop'
const MODULES = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules')

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

console.log(`profile: ${PROFILE}`)
console.log(`modules: ${MODULES}`)

if (!fs.existsSync(MODULES)) {
  fail(`这个 profile 的 node_modules 不存在：${MODULES}\n  提示：先 dsh plugin --profile ${PROFILE} add <tgz>`)
}

const require = createRequire(path.join(MODULES, 'noop.js'))

try {
  require.resolve('dsh-remote-qqbot')
} catch {
  fail(`profile 里没有装 dsh-remote-qqbot（${MODULES}）`)
}

const pkgPath = path.join(MODULES, 'dsh-remote-qqbot', 'package.json')
const installedVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
console.log(`已安装版本: ${installedVersion}`)

const entry = path.join(MODULES, 'dsh-remote-qqbot', 'lib', 'index.js')
const mod = await import(pathToFileURL(entry).href)
console.log(`1) 插件加载成功，exports: ${Object.keys(mod).join(', ')}`)

if (typeof mod.apply !== 'function') fail('导出里没有 apply()，插件无法装配')

const toolsPath = require.resolve('@deepseek-ai/dsh-tools')
const tools = await import(pathToFileURL(toolsPath).href)
console.log(`2) 依赖解析成功 @deepseek-ai/dsh-tools → ${toolsPath}`)
console.log(`   defineTool 可用: ${typeof tools.defineTool === 'function'}`)

const registered = []
const ctx = {
  on() {},
  effect(fn) { fn(); return () => {} },
  get() { return undefined },
  tools: { register(def) { registered.push(def.name); return () => {} } },
}
mod.apply(ctx, {})
console.log(`3) 真实 defineTool 装配通过，注册工具: ${registered.sort().join(', ')}`)

const expected = ['agentmd_read', 'memory_forget', 'memory_read', 'memory_write']
const missing = expected.filter((n) => !registered.includes(n))
if (missing.length > 0) fail(`缺少工具: ${missing.join(', ')}`)

console.log(`\n全部通过：已安装的 ${installedVersion} 产物在真实 profile 依赖下可加载、可装配。`)
console.log('注意：这只是「装好了」；桌面版是长驻进程，**必须重启 DSH** 才会真正跑这份代码。')
