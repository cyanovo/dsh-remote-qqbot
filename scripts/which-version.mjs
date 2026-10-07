/**
 * 「磁盘上装的是哪一版」和「进程里跑的到底是哪一版」，一句话问清楚。
 *
 * ## 为什么需要这个脚本
 *
 * 插件**只在 DSH 启动时加载一次**，没有热重载。所以「装好了」和「在跑」是两件事：
 * 装完不重启，进程里跑的还是上一次启动时读进内存的那份代码。本项目已经因此反复
 * 误会过 —— 2026-10-07 那次主人报「选完工作区还是没让我挑会话」，查到最后不是功能
 * 坏了，而是进程里跑的是 10:22:31 加载的 1.0.18，而两步派活是 11:12 才装进来的 1.0.19。
 *
 * ## 判据为什么是「字段标签」而不是版本号
 *
 * 运行中的插件**从不自报版本号**（它就是内存里那份代码，没有"我是谁"的口）。但老板本的
 * 插件会在 `GET /remote-qqbot/api/config.get` 里返回它自己那份 `FIELD_SPECS` ——
 * 字段标签/说明是随版本一起改的文本。所以拿**运行中返回的标签集合**和**本地这一版的
 * 标签集合**对一下：有差异 ⇒ 进程里跑的不是本地这一版（并把它列出来，一眼能看出是哪一代）。
 * 版本号只用来判断"磁盘比进程新还是旧"，两者都不猜。
 *
 * 用法：
 *   node scripts/which-version.mjs                 # 默认探 127.0.0.1:19387
 *   node scripts/which-version.mjs --port 19387
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const flag = (key, dflt) => {
  const i = argv.indexOf(key)
  return i === -1 ? dflt : (argv[i + 1] ?? dflt)
}
const PORT = Number(flag('--port', '19387'))

const localVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

/** 安装目录里的版本：扫所有 profile，找出装了本插件的那些。 */
function installedVersions() {
  const base = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles')
  const out = []
  if (!fs.existsSync(base)) return out
  for (const profile of fs.readdirSync(base)) {
    const pkg = path.join(base, profile, 'node_modules', 'dsh-remote-qqbot', 'package.json')
    if (!fs.existsSync(pkg)) continue
    try {
      out.push({ profile, version: JSON.parse(fs.readFileSync(pkg, 'utf8')).version, pkg })
    } catch { /* 读坏了就当没装 */ }
  }
  return out
}

const installed = installedVersions()
console.log(`仓库里这一版        : ${localVersion}`)
if (installed.length === 0) console.log('安装目录            : （没找到装了本插件的 profile）')
for (const it of installed) {
  const mt = fs.statSync(it.pkg).mtime.toLocaleString('zh-CN')
  console.log(`安装目录（${it.profile}）  : ${it.version}   （package.json 改动于 ${mt}）`)
}

const url = `http://127.0.0.1:${PORT}/remote-qqbot/api/config.get`
let live = null
try {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
  live = await res.json()
} catch (err) {
  console.log(`\n运行中的插件        : 问不到（${url} 连不上：${err?.message ?? err}）`)
  console.log('   ⇒ 要么 DSH 没在跑，要么这次启动没加载这个插件。')
  process.exit(0)
}

if (!live?.ok) {
  console.log(`\n运行中的插件        : 路由在，但返回的不是配置视图（ok=${live?.ok}）`)
  process.exit(0)
}

const liveLabels = new Map((live.fields ?? []).map((f) => [f.key, String(f.label ?? '')]))
const { FIELD_SPECS } = await import(new URL('../lib/config-api.js', import.meta.url).href)
const diffs = []
for (const spec of FIELD_SPECS) {
  const got = liveLabels.get(spec.key)
  if (got === undefined) diffs.push(`  字段 ${spec.key}：本地有「${spec.label}」，运行中的没有`)
  else if (got !== spec.label) diffs.push(`  字段 ${spec.key}：本地「${spec.label}」 ／ 运行中「${got}」`)
}
for (const key of liveLabels.keys()) {
  if (!FIELD_SPECS.some((s) => s.key === key)) diffs.push(`  字段 ${key}：运行中有，本地这一版没有`)
}

const hours = live.values?.qqUpdateCheckHours
console.log(`\n运行中的插件自报     : 拿本地 ${path.relative(ROOT, 'lib/config-api.js')} 对标签 = ${diffs.length === 0 ? '完全一致' : `${diffs.length} 处不一致`}`)
console.log(`  新版本间隔（生效值）: ${JSON.stringify(hours)}`)
for (const d of diffs) console.log(d)

const stale = diffs.length > 0
console.log(`\n结论                : ${stale
  ? '❌ 进程里跑的不是本地这一版 —— 重启 DSH 才会换成磁盘上的那份代码。'
  : '✅ 进程里跑的就是本地这一版（标签集合一致）。'}`)
console.log(stale
  ? '   重启方式：关掉 DSH 再打开；或在 QQ 里发 /update，让机器人装完自己重启。'
  : '   （标签一致只能证明配置字段这一块是同一代；真要逐字节核对安装产物用 scripts/verify-ui-installed.mjs。）')
