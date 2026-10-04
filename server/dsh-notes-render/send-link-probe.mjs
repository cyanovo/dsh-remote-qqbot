/**
 * 三路对照实验：往 QQ 推一条消息，里面放三种链接，
 * 用来判断「如需预览请使用浏览器访问」到底是 QQ 全局拦截、还是只针对我们的域名/端口。
 *
 *   1. https://www.baidu.com            —— 中立对照（官方、https、标准端口）
 *   2. http://cyanovo.top/dsh/hd882.html  —— 我们的域名，标准端口 80
 *   3. https://cyanovo.top:8444/dsh/hd882.html —— 我们的域名，非标端口 8444
 *
 * 只看，不写任何项目文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

// 2026-10-02：桌面版把 settings.yaml 改名成了 settings.yaml.imported，
// 配置同时存在于 profile 的 cordis.patch.yml。只读这两处，不写任何文件。
const CANDIDATES = [
  path.join(HOME, '.dsh', 'settings.yaml'),
  path.join(HOME, '.dsh', 'settings.yaml.imported'),
  path.join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
]

function readAll() {
  for (const f of CANDIDATES) {
    try {
      const raw = fs.readFileSync(f, 'utf8')
      if (/^\s*qqAppId:/m.test(raw)) return { file: f, raw }
    } catch { /* 试下一个 */ }
  }
  throw new Error(`以下文件都没找到 qqAppId：\n  ${CANDIDATES.join('\n  ')}`)
}

const { file: cfgFile, raw: cfgRaw } = readAll()
console.log(`配置来源：${cfgFile}`)

function pick(key) {
  const m = cfgRaw.match(new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, 'm'))
  if (!m) return ''
  const v = m[1].trim().replace(/\s+#.*$/, '').trim()
  return /^['"].*['"]$/.test(v) ? v.slice(1, -1) : v
}

const A = 'https://www.baidu.com'
const B = 'http://cyanovo.top/dsh/hd882.html'
const C = 'https://cyanovo.top:8444/dsh/hd882.html'

const stateFile = path.join(HOME, '.dsh', 'qq-bot-state.json')
const stateRaw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
function findOpenId(node) {
  if (!node || typeof node !== 'object') return ''
  for (const [k, v] of Object.entries(node)) {
    if (/^open_?id$/i.test(k) && typeof v === 'string' && v) return v
    const nested = findOpenId(v)
    if (nested) return nested
  }
  return ''
}
const openId = findOpenId(stateRaw)
if (!openId) throw new Error('找不到 openId')

const text = [
  '🔬 链接拦截三路对照实验',
  '',
  '请依次点下面三条链接，告诉我**哪几条**弹了「如需预览请使用浏览器访问」：',
  '',
  `① 中立对照（百度）  [点我](${A})`,
  '',
  `② 我的域名·标准端口  [点我](${B})`,
  '',
  `③ 我的域名·8444 端口  [点我](${C})`,
  '',
  '点不开的长按复制：',
  A,
  B,
  C,
  '',
  '结论怎么看：三条都弹 = QQ 全局拦；只有 ②③ 弹 = 只拦我的域名；只有 ③ 弹 = 只拦非标端口。',
].join('\n')

const { QqBotClient } = await import('../dsh-notify-memory/src/qqbot.js')
const bot = new QqBotClient({
  appId: pick('qqAppId'),
  clientSecret: pick('qqClientSecret'),
  log: (level, msg) => console.log(`[qq:${level}] ${msg}`),
})
const res = await bot.sendC2C(openId, text, { markdown: true })
console.log(JSON.stringify(res, null, 2).slice(0, 500))
console.log('\n✅ 实验消息已发出')
