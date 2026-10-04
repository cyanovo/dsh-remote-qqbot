/**
 * 构建脚本：把 src/ 拷到 lib/。
 *
 * 本插件是纯 ESM JavaScript，没有 TypeScript、没有外部运行时依赖
 * （`src/settings.js` 是自备实现；dsh-tools 与 schemastery 由宿主 profile 提供）。
 * 所以「构建」就是复制 + 逐个文件校验语法与依赖。这样任何人 clone 下来
 * 都能在没有 DSH 仓库依赖的情况下重新生成产物。
 */

import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src')
const LIB = join(ROOT, 'lib')

await rm(LIB, { recursive: true, force: true })
await mkdir(LIB, { recursive: true })
await cp(SRC, LIB, { recursive: true })

/** 逐文件做语法检查，避免「复制成功但其实是坏文件」。 */
const files = (await readdir(LIB)).filter((f) => f.endsWith('.js'))
for (const file of files) {
  await run(process.execPath, ['--check', join(LIB, file)])
}

/** 宿主 profile 保证提供的裸包：dsh-tools（defineTool）与 schemastery（Config 必需形态）。 */
const HOST_PACKAGES = new Set(['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'])

// 检查产物里没有引入宿主未提供的裸包（只允许 node: 内建、相对路径、上面这些宿主包）。
const { readFile } = await import('node:fs/promises')
for (const file of files) {
  const text = await readFile(join(LIB, file), 'utf8')
  for (const m of text.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
    const specifier = m[1]
    const ok = specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')
      || HOST_PACKAGES.has(specifier)
    if (!ok) throw new Error(`${file} 引入了宿主不保证提供的依赖 "${specifier}"`)
  }
}

console.log(`built: src/ -> lib/（${files.length} 个文件，语法与依赖检查通过）`)
