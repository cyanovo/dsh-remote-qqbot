/**
 * 第二组对照实验：把「域名信任」和「协议/端口」彻底分开。
 *
 * 第一组（①百度 https:443 / ②我的域名 http:80 / ③我的域名 https:8444）里，
 * 域名和协议端口是混在一起的，不能断定到底是谁的问题。
 * 这一组用两个「非腾讯系、非白名单、但是完全正常的网站」做对照，
 * 如果它们也被拦，说明 QQ 拦的是「所有没进白名单的域名」，而不是针对我们。
 *
 * 配置读取：settings.yaml → settings.yaml.imported → profile 的 cordis.patch.yml（只读）。
 * 用法：node send-link-probe2.mjs
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

const A = 'http://example.com'
const B = 'http://info.cern.ch'
const C = 'https://cyanovo.top:8444/dsh/hd882.html'

const text = [
  '🔬 **第二组对照：QQ 到底在拦谁？**',
  '',
  '① http://example.com',
  '　（国际中立站，http + 80，跟腾讯无关）',
  '',
  '② http://info.cern.ch',
  '　（欧洲核子中心，老站，http + 80）',
  '',
  '③ https://cyanovo.top:8444/dsh/hd882.html',
  '　（我的域名，https + 8444）',
  '',
  '——三条都点一遍，告诉我哪几条弹「如需预览请使用浏览器访问」——',
  '',
  '解读：',
  '· 三条都弹 → QQ 拦「所有没进白名单的域名」，不是针对我',
  '· 只有 ③ 弹 → QQ 单独盯上我的域名，可以拿备案去申诉',
  '· ①②正常、③弹 → 同上，申诉理由更硬',
].join('\n')

const bot = new QqBotClient({
  appId: pick('qqAppId'),
  clientSecret: pick('qqClientSecret'),
  log: (m) => console.log(`[qqbot] ${m}`),
})

const res = await bot.sendC2C(openId, text, { markdown: true })
console.log(JSON.stringify(res, null, 2).slice(0, 500))
console.log('\n✅ 第二组实验消息已发出')
