/**
 * 主动发一条 QQ 私聊（一次性，不开 WebSocket）。
 *
 * ⚠️ 刻意**只调 HTTP 接口、不建长连接**：插件已经占着那条 WebSocket，
 *    再开一个同 shard 的连接会互相抢事件（官方 session_start_limit.max_concurrency=1）。
 *
 * 凭据来源顺序：环境变量 → profile 的 cordis.patch.yml。
 * openId 来源：~/.dsh/qq-bot-state.json（插件学到的）。
 *
 * 用法：node tests/live/qq-send.mjs "要发的内容"
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { QqBotClient } from '../../src/qqbot.js'

const PATCH = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const STATE = path.join(os.homedir(), '.dsh', 'qq-bot-state.json')

/** 从 profile 补丁里抠出凭据（避免每次都在命令行里带 secret）。 */
function credsFromPatch() {
  try {
    const raw = fs.readFileSync(PATCH, 'utf8')
    const pick = (k) => {
      const m = new RegExp(`^\\s*${k}\\s*:\\s*['"]?([^'"\\s#]+)['"]?\\s*$`, 'm').exec(raw)
      return m?.[1] ?? ''
    }
    return { appId: pick('qqAppId'), secret: pick('qqClientSecret') }
  } catch {
    return { appId: '', secret: '' }
  }
}

const patch = credsFromPatch()
const APP_ID = process.env.QQ_APP_ID || patch.appId
const SECRET = process.env.QQ_CLIENT_SECRET || patch.secret
const text = process.argv.slice(2).join(' ')

if (!text) {
  console.error('用法: node tests/live/qq-send.mjs "要发的内容"')
  process.exit(2)
}
if (!APP_ID || !SECRET) {
  console.error('❌ 拿不到凭据（环境变量与 cordis.patch.yml 都没有）')
  process.exit(2)
}

let openId = process.env.QQ_OPEN_ID || ''
if (!openId) {
  try {
    openId = JSON.parse(fs.readFileSync(STATE, 'utf8')).openId ?? ''
  } catch { /* 没状态文件 */ }
}
if (!openId) {
  console.error('❌ 还没有 openId —— 请先在 QQ 里给机器人发一条消息（发 /help 即可）')
  process.exit(2)
}

const bot = new QqBotClient({
  appId: APP_ID,
  clientSecret: SECRET,
  log: (lvl, msg) => console.log(`[${lvl}] ${msg}`),
})

console.log(`收件人 openId: ${openId.slice(0, 8)}…${openId.slice(-4)}`)
try {
  const r = await bot.sendC2C(openId, text)
  console.log(`✅ 主动消息已发出`)
  console.log(`   id        = ${r.id}`)
  console.log(`   timestamp = ${r.timestamp}`)
} catch (err) {
  console.error(`❌ 发送失败：${err.message}`)
  const hint = QqBotClient.explainError(err.code)
  if (hint) console.error(`   👉 ${hint}`)
  process.exit(1)
}
