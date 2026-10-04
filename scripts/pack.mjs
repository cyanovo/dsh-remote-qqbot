/**
 * 打 npm 包（tgz）。
 *
 * 优先用 `npm pack`（产物结构与 pnpm 安装预期完全一致）；
 * 本机 npm 不可用时退回手工 tar：在临时目录里搭出 `package/` 前缀再打包，
 * 因为 Windows 自带的 bsdtar 不支持 `--transform`。
 *
 * 运行：node scripts/pack.mjs
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, readFile, rm, stat, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const run = promisify(execFile)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const tarball = join(ROOT, `${pkg.name}-${pkg.version}.tgz`)
const WANTED = ['package.json', 'lib', 'cordis.patch.yml']

/** 删掉旧产物，避免 tar 把上一次的 tgz 也卷进去。 */
for (const name of await readdir(ROOT)) {
  if (name.endsWith('.tgz')) await rm(join(ROOT, name), { force: true })
}

let packed = false
try {
  // npm 把 notice 写到 stderr，因此不能靠捕获 stdout 判断；
  // 只认「退出码为 0 且产物存在」。
  const { spawnSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  spawnSync('npm', ['pack'], { cwd: ROOT, shell: true, stdio: 'ignore' })
  const produced = join(ROOT, `${pkg.name}-${pkg.version}.tgz`)
  if (existsSync(produced)) packed = true
} catch (err) {
  console.warn(`npm pack 失败（${err?.message ?? err}），回退到手工 tar`)
}

if (!packed) {
  const stage = join(await mkdtempStage(), 'package')
  await mkdir(stage, { recursive: true })
  for (const name of WANTED) {
    const from = join(ROOT, name)
    const to = join(stage, name)
    if (name.endsWith('.json') || name.endsWith('.yml')) await cp(from, to)
    else await cp(from, to, { recursive: true })
  }
  await run('tar', ['-czf', tarball, '-C', dirname(stage), 'package'])
  await rm(dirname(stage), { recursive: true, force: true })
}

const { stdout: listing } = await run('tar', ['-tzf', tarball])
const size = (await stat(tarball)).size
console.log(`packed: ${tarball} (${size} bytes)`)
console.log(listing.trim())

/** 建立一个临时暂存目录。 */
async function mkdtempStage() {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), 'dsh-pack-'))
}
