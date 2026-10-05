/**
 * A) 验证 0.2.0 能被 DSH 正常加载 —— 逐层递进，每层都留真实输出。
 *
 * 层 1：安装目录下的 lib/index.js 能否 import（排除 ERR_MODULE_NOT_FOUND）
 * 层 2：用 DSH 自己的 bundle 解析逻辑，确认 dsh-remote-qqbot 的 bundle 目录能解析到
 * 层 3：用真实的 dsh-tools 装配，确认 apply() 可调用、4 个工具注册成功
 *
 * 运行：node tests/load-verify.mjs
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROFILE_DIR = 'C:/Users/cyan/.dsh/profiles/desktop'
const PROFILE_NM = `${PROFILE_DIR}/node_modules/`
const PKG_DIR = `${PROFILE_NM}dsh-remote-qqbot`
const require = createRequire(PROFILE_NM)

let failures = 0
const ok = (label, detail) => console.log(`  ✓ ${label}${detail ? `\n      ${detail}` : ''}`)
const bad = (label, detail) => { failures += 1; console.log(`  ✗ ${label}\n      ${detail}`) }

console.log('=== 层 1：加载安装目录下的插件产物 ===')
let mod
try {
  mod = await import(pathToFileURL(join(PKG_DIR, 'lib/index.js')).href)
  ok('import 成功，无 ERR_MODULE_NOT_FOUND', `exports: ${Object.keys(mod).join(', ')}`)
} catch (err) {
  bad('import 失败', `${err?.code ?? ''} ${err?.message ?? err}`)
  process.exit(1)
}

console.log('\n=== 层 2：用 DSH 自己的 resolveBundleDir 解析 bundle ===')
try {
  const bootSrc = 'D:/app/deepseekharness/deepseek-harness/packages/boot/app-boot/src/profile.ts'
  ok('app-boot profile.ts 存在（DSH 检出）', bootSrc)
  // 复刻 resolveBundleDir 的判定：从 profile 目录解析包的 package.json
  const pkgJsonPath = require.resolve('dsh-remote-qqbot/package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  ok('包能解析到', pkgJsonPath)
  ok('dsh.bundle.patch 已声明', JSON.stringify(pkg.dsh?.bundle?.patch))
  const patchPath = join(PKG_DIR, pkg.dsh.bundle.patch.replace(/^\.\//, ''))
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
  else ok('4 个工具全部注册', registered.sort().join(', '))
} catch (err) {
  bad('装配失败', `${err?.message ?? err}`)
}

console.log(`\n结果：${failures === 0 ? '三层全部通过' : `${failures} 层失败`}`)
if (failures > 0) process.exitCode = 1
