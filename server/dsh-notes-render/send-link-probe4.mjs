/**
 * 第四组：用**生产实际格式**发一条链接，验证大写域名在机器人消息里是否真的可点。
 *
 * 与第三组的区别（也是这一组的全部意义）：
 *   第三组是把三条裸链接并列，主人手点 —— 但生产里链接不是裸的，
 *   而是包在 markdown 链接语法里：[查看完整回答](http://CYANOVO.TOP/dsh/xxx.html)
 *   且整条消息走 markdown 通道（qqMarkdown 默认 true）。
 *   「裸链接能点」不等于「markdown 链接能点」，必须按真实格式再验一次。
 *
 * 单变量：只发一条，格式与 src/index.js 拼 pushText 的写法逐字一致。
 * 配置读取：settings.yaml → settings.yaml.imported → profile 的 cordis.patch.yml（只读）。
 * 用法：node send-link-probe4.mjs
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

function pick(raw, key) {
  const m = raw.match(new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, 'm'))
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

const { file: cfgFile, raw: cfgRaw } = readCfg()
console.log(`配置来源：${cfgFile}`)
const openId = findOpenId(JSON.parse(fs.readFileSync(path.join(HOME, '.dsh', 'qq-bot-state.json'), 'utf8')))
if (!openId) throw new Error('在 qq-bot-state.json 里找不到 openId')
console.log(`收件人 openId：${openId.slice(0, 8)}…${openId.slice(-4)}`)

// 这里就是 src/index.js 拼 pushText 的原样写法（summary + 空行 + markdown 链接）
const noteUrl = 'http://CYANOVO.TOP/dsh/hd882.html'
const summary = '✅ 链接修复验证'
const text = `${summary}\n\n[查看完整回答](${noteUrl})`

console.log('\n--- 实际发出的正文（与生产逐字一致）---')
console.log(text)
console.log('-------------------------------------\n')

const bot = new QqBotClient({
  appId: pick(cfgRaw, 'qqAppId'),
  clientSecret: pick(cfgRaw, 'qqClientSecret'),
  log: (m) => console.log(`[qqbot] ${m}`),
})

const res = await bot.sendC2C(openId, text, { markdown: true })
console.log(JSON.stringify(res, null, 2).slice(0, 500))
console.log('\n✅ 第四组（生产格式）消息已发出')
