/**
 * 第三组实验：验证「域名大写」是否能绕过 QQ 机器人平台的 URL 检测。
 *
 * 依据：koishi-plugin-qqurl-bypass 的 uppercase 模式
 *   「将域名改为纯大写，不影响访问但可以神奇的绕过 url 检测」——只改域名，路径不变。
 *   论坛作者 2025-03-11：「至少到目前来看，这个 bug 还没有修复。」
 *
 * 单变量对照：A 与 B 只差一个大小写。
 *   ⑤ 若可打开 → 方案成立，直接用大写域名发链接，无需申诉、无需改服务器。
 *
 * 配置读取：settings.yaml → settings.yaml.imported → profile 的 cordis.patch.yml（只读）。
 * 用法：node send-link-probe3.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QqBotClient } from '../dsh-notify-memory/src/qqbot.js'

const HOME = os.homedir()
const CANDIDATES = [
  path.join(HOME, '.dsh', 'settings.yaml'),
  path.join(HOME, '.dsh', 'settings.yaml.imported'),
  path.join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
]

function readCfg() {
  for (const f of CANDIDATES) {
    try {
      const raw = fs.readFileSync(f, 'utf8')
      if (/^\s*qqAppId:/m.test(raw)) return { file: f, raw }
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到含 qqAppId 的配置文件')
}

const { file: cfgFile, raw: cfgRaw } = readCfg()
console.log(`配置来源：${cfgFile}`)

function pick(key) {
  const m = cfgRaw.match(new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, 'm'))
  if (!m) return ''
  const v = m[1].trim().replace(/\s+#.*$/, '').trim()
  return /^['"].*['"]$/.test(v) ? v.slice(1, -1) : v
}

function findOpenId(node) {
  if (!node || typeof node !== 'object') return null
  if (typeof node.openId === 'string' && node.openId.length > 8) return node.openId
  for (const v of Object.values(node)) {
    const hit = findOpenId(v)
    if (hit) return hit
  }
  return null
}

const openId = findOpenId(JSON.parse(fs.readFileSync(path.join(HOME, '.dsh', 'qq-bot-state.json'), 'utf8')))
if (!openId) throw new Error('在 qq-bot-state.json 里找不到 openId')
console.log(`收件人 openId：${openId.slice(0, 8)}…${openId.slice(-4)}`)

// A 与 B 只差大小写，是干净的对照组
const A = 'https://cyanovo.top:8444/dsh/hd882.html'
const B = 'https://CYANOVO.TOP:8444/dsh/hd882.html'
const C = 'http://CYANOVO.TOP/dsh/hd882.html'

const text = [
  '# 🔬 第三组：域名大写能不能绕过',
  '',
  '**A**（小写 · 对照组）',
  A,
  '',
  '**B**（全大写 · 只差大小写）',
  B,
  '',
  '**C**（全大写 + 不带端口）',
  C,
  '',
  '——三条各点一次，告诉我哪几条能直接在 QQ 里打开、哪几条还弹「如需预览请使用浏览器访问」——',
  '',
  '· **B 能开** → 找到解了：以后发的链接把域名写成大写就完事，不用申诉、不用改服务器。',
  '· **B 不能开、A 也不能开** → 这招对我不灵，回头走腾讯官方申诉。',
].join('\n')

const bot = new QqBotClient({
  appId: pick('qqAppId'),
  clientSecret: pick('qqClientSecret'),
  log: (m) => console.log(`[qqbot] ${m}`),
})

const res = await bot.sendC2C(openId, text, { markdown: true })
console.log(JSON.stringify(res, null, 2).slice(0, 500))
console.log('\n✅ 第三组实验消息已发出')
