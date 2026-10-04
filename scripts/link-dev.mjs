/**
 * 本地测试引导：在插件目录里建一个 node_modules junction，指向 DSH profile 的 node_modules，
 * 这样 `import '@deepseek-ai/dsh-tools'` 才能解析到宿主提供的实现。
 *
 * 这只影响本地开发与测试；打包产物（tgz）里不含 node_modules，
 * 装到 profile 后由 profile 自己的 node_modules 提供依赖。
 *
 * 运行：node scripts/link-dev.mjs
 * DSH 主目录不是默认的 ~/.dsh 时，用 DSH_HOME 覆盖：DSH_HOME=/path/to/.dsh node scripts/link-dev.mjs
 */

import { symlink, mkdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LINK = join(ROOT, 'node_modules')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
// profile 的依赖装在 <DSH_HOME>/profiles/node_modules，所有 profile 共用这一份。
const CANDIDATES = [
  process.env.DSH_PROFILE_NODE_MODULES,
  join(DSH_HOME, 'profiles', 'node_modules'),
  join(DSH_HOME, 'profiles', 'desktop', 'node_modules'),
].filter(Boolean)

const TARGET = CANDIDATES.find((p) => existsSync(p))

if (!TARGET) {
  console.error('找不到 DSH profile 的 node_modules，试过这些位置：')
  for (const p of CANDIDATES) console.error(`  ${p}`)
  console.error('先用 `dsh plugin --profile desktop add ./dsh-remote-qqbot-<版本>.tgz` 装一次，')
  console.error('或指定 DSH_HOME=<你的 .dsh 目录> 重跑。')
  process.exit(1)
}

if (existsSync(LINK)) {
  const info = await stat(LINK).catch(() => undefined)
  if (info?.isDirectory()) await rm(LINK, { recursive: true, force: true })
  else await rm(LINK, { force: true })
}

await mkdir(dirname(LINK), { recursive: true })
// Windows 目录联接不需要管理员权限，优先用 junction。
await symlink(TARGET, LINK, 'junction')
console.log(`linked: ${LINK} -> ${TARGET}`)
console.log('现在可以运行 node tests/plugin.test.mjs 等本地测试。')
