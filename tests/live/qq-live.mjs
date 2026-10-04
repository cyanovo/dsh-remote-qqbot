/**
 * QQ 机器人**真实链路**实测（需要真凭据，会真的连 QQ 服务器）。
 *
 * 依次验证四件事：
 *   ① AppID / ClientSecret 能不能换到 access_token
 *   ② 机器人身份正不正常（GET /users/@me）
 *   ③ WebSocket 网关能不能连上、能不能收到你发的消息
 *   ④ 能不能**主动**给你发私聊（这是整个需求的核心）
 *
 * 用法（凭据走环境变量，不落盘、不进日志）：
 *   node tests/live/qq-live.mjs --seconds=180
 *
 * 跑起来之后，用你的 QQ 给机器人随便发一句话。脚本会：
 *   - 打印收到的原始事件
 *   - 记住你的 open_id
 *   - 用**被动回复**回你一句
 *   - 再用**主动消息**给你发一条（证明"任务完成了主动通知你"可行）
 */

import { QqBotClient, C2C_INTENTS } from '../../src/qqbot.js'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=?(.*)$/.exec(a)
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true]
  }),
)

const APP_ID = process.env.QQ_APP_ID ?? args.appId ?? ''
const SECRET = process.env.QQ_CLIENT_SECRET ?? args.secret ?? ''
const SECONDS = Number(args.seconds ?? 180)

const mask = (s) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-3)}` : '(空)')

if (!APP_ID || !SECRET) {
  console.error('❌ 缺少凭据：请设 QQ_APP_ID / QQ_CLIENT_SECRET 环境变量')
  process.exit(2)
}

console.log('=== QQ 机器人真实链路实测 ===')
console.log(`AppID: ${APP_ID}（${mask(APP_ID)}）`)
console.log(`Secret: ${mask(SECRET)}`)
console.log(`运行 ${SECONDS} 秒\n`)

const bot = new QqBotClient({
  appId: APP_ID,
  clientSecret: SECRET,
  intents: C2C_INTENTS,
  log: (level, msg) => console.log(`[${level}] ${msg}`),
  onEvent: (name, data) => {
    console.log(`\n📨 收到事件 ${name}`)
    console.log('   ' + JSON.stringify(data).slice(0, 800))
    if (name === 'C2C_MESSAGE_CREATE') void onUserMessage(data)
  },
})

let myOpenId = null

async function onUserMessage(data) {
  const openId = data?.author?.user_openid ?? data?.author?.id
  if (!openId) {
    console.log('   ⚠️ 事件里没有 openid，字段结构可能变了')
    return
  }
  if (!myOpenId) {
    myOpenId = openId
    console.log(`\n✅ 学到你的 open_id: ${mask(openId)}`)
  }

  const text = String(data?.content ?? '').trim()
  console.log(`   你说的是：「${text}」`)

  // ① 被动回复（带 msg_id）
  try {
    const r = await bot.sendC2C(openId, `收到你的消息：「${text}」\n这是**被动回复**（60 分钟内、最多 4 次）。`, { msgId: data.id, msgSeq: 1 })
    console.log(`✅ 被动回复成功 id=${String(r.id).slice(0, 24)}…`)
  } catch (err) {
    const hint = QqBotClient.explainError(err.code)
    console.log(`❌ 被动回复失败：${err.message}${hint ? `\n   👉 ${hint}` : ''}`)
  }

  // ② 主动消息（不带 msg_id）—— 这是"任务完成了主动通知你"的关键
  try {
    const r = await bot.sendC2C(openId, '这是**主动消息**（没有 msg_id）。\n如果你能收到这条，说明「AI 跑完主动私聊你」这条路通了 ✅')
    console.log(`✅ 主动消息成功 id=${String(r.id).slice(0, 24)}…`)
  } catch (err) {
    const hint = QqBotClient.explainError(err.code)
    console.log(`❌ 主动消息失败：${err.message}${hint ? `\n   👉 ${hint}` : ''}`)
  }
}

// ── ① 凭据 ──────────────────────────────────────────────────────────────
console.log('[1] 换 access_token …')
try {
  const token = await bot.getAccessToken()
  console.log(`    ✅ 成功，token 长度 ${token.length}\n`)
} catch (err) {
  console.error(`    ❌ ${err.message}`)
  const hint = QqBotClient.explainError(String(err.message).match(/code=(\d+)/)?.[1])
  if (hint) console.error(`    👉 ${hint}`)
  process.exit(1)
}

// ── ② 机器人身份 ────────────────────────────────────────────────────────
console.log('[2] 查机器人身份 GET /users/@me …')
try {
  const { status, data } = await bot.api('/users/@me', { method: 'GET' })
  console.log(`    HTTP ${status}`)
  console.log('    ' + JSON.stringify(data).slice(0, 400))
} catch (err) {
  console.log(`    ⚠️ ${err.message}`)
}

// ── ③ 网关 ──────────────────────────────────────────────────────────────
console.log('\n[3] 取 WebSocket 网关 …')
try {
  const gw = await bot.getGatewayUrl()
  console.log(`    ✅ ${gw.url}（shards=${gw.shards}）`)
} catch (err) {
  console.error(`    ❌ ${err.message}`)
  process.exit(1)
}

// ── ④ 连上等消息 ────────────────────────────────────────────────────────
console.log(`\n[4] 建立长连接，等你发消息（最多 ${SECONDS} 秒）…`)
console.log('    👉 现在用你的 QQ 给机器人发一句话\n')
bot.start()

const timer = setTimeout(() => {
  console.log('\n⏱ 时间到')
  if (myOpenId) console.log('✅ 本轮已学到 open_id，主动/被动消息都验证过了')
  else console.log('⚠️ 全程没收到消息 —— 请确认：① 已加机器人为好友 ② 在开放平台开了单聊权限')
  bot.stop()
  process.exit(myOpenId ? 0 : 1)
}, SECONDS * 1000)

process.on('SIGINT', () => {
  clearTimeout(timer)
  bot.stop()
  process.exit(0)
})
