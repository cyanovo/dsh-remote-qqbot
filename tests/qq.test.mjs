/**
 * QQ 机器人 + 桥接层离线自测 —— **不需要 AppID、不发任何真实请求**。
 *
 * 覆盖：
 *   - HMAC cookie 的算法与结构（与手机端实现对齐）
 *   - ~/.dsh/.credentials.yaml 两种写法都能读出来
 *   - access_token 缓存 / 并发合流 / "HTTP 200 但 code 非 0" 的坑
 *   - 单聊发送：主动消息与被动回复的请求体差异、错误码翻译
 *   - WebSocket 全流程：HELLO → IDENTIFY → READY → 心跳 → 事件分发
 *   - 断线重连 / 致命错误码停止重连
 *   - 回答拼装严格对齐 DSH 的 matchesQuestions 校验
 *   - 来消息路由规则
 *   - 状态持久化与 msg_id 去重
 *
 * 跑法：node tests/qq.test.mjs
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  C2C_INTENTS, QqBotClient, dshSessionCookie, logSafe,
} from '../src/qqbot.js'
import {
  BotState, DshLocalApi, HELP_TEXT, PICK_WINDOW_MS, WORKSPACE_PICK_WINDOW_MS,
  buildAnswers, buildHelpKeyboard, buildKeyboard, buildNumberButtons,
  buildOneAnswer, buildOptionKeyboard, buildUpdateNoticeKeyboard, makeCmdButton,
  cleanOptionText, isRecommendedLabel, optionLabelRoom,
  extractMsgIdx, extractQuoted, extractRefIdx, formatNotification, formatQuestion, formatQuestionBody,
  formatTaskSessionPickAck, formatTaskSessionPickerText,
  formatWorkspacePickAck, formatWorkspacePickerText, isPickerFresh,
  stripBotMention, summarizeSession,
  inferSessionFromQuote, pickPromptMode, pickerAge, qqPreviewUrl, readDshSecret, resolveQuoteTarget,
  browserSessionRecord, healBrowserSessionRecord, readBrowserSessionSecret, secretFromCredentials,
  routeIncoming, routeMessage,
} from '../src/qqbridge.js'
import { composeChatAnswer, composeChatSummary } from '../src/summary.js'

let pass = 0
let fail = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (err) {
    fail += 1
    failures.push({ name, err })
    console.log(`  ❌ ${name}\n     ${err.message}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-test-'))

// ── 假 WebSocket ───────────────────────────────────────────────────────────
class FakeWs {
  constructor() {
    this.sent = []
    this.closed = false
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null
  }

  send(s) { this.sent.push(JSON.parse(s)) }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.closed = true
    this.onclose?.({ code, reason })
  }

  /** 模拟服务端下发。 */
  server(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }

  open() { this.onopen?.({}) }
}

function makeBot(overrides = {}) {
  const ws = new FakeWs()
  const events = []
  const bot = new QqBotClient({
    appId: 'app', clientSecret: 'sec',
    wsFactory: () => ws,
    fetchImpl: async (url) => {
      if (url.includes('getAppAccessToken')) {
        return { status: 200, json: async () => ({ access_token: 'TOK', expires_in: 7200 }), text: async () => '{}' }
      }
      if (url.includes('/gateway/bot')) {
        // ⚠️ api() 是按 res.text() 解析 JSON 的，这里必须给真 JSON，
        // 给 '{}' 会让网关地址取不到、整条 WS 链路建不起来。
        return {
          status: 200,
          json: async () => ({ url: 'wss://gw', shards: 1 }),
          text: async () => JSON.stringify({ url: 'wss://gw', shards: 1 }),
        }
      }
      return { status: 200, json: async () => ({ id: 'MSG1', timestamp: 'now' }), text: async () => '{}' }
    },
    onEvent: (n, d) => events.push({ n, d }),
    log: () => {},
    ...overrides,
  })
  return { bot, ws, events }
}

// 测试夹具：**故意不是**真凭据。这一段只验证 HMAC/结构的数学性质，
// 任何 43 字符的 base64url 串都成立 —— 第 122 行就是从同一个字面量重算签名做对比。
// （真实 secret 由 qqruntime.js 在运行时从 DSH 凭据库读取，绝不能写进仓库。）
const FIXTURE_SECRET = 'TESTFIXTURE-ONLY-000000000000000000000000000'

console.log('\n[1] HMAC cookie（与手机端 dsh_protocol.dart 对齐）')
await t('结构是 v1.<body>.<sig>，名字是 dsh-auth-<base64url(sha256(authority))>', () => {
  const authority = '127.0.0.1:19387'
  const c = dshSessionCookie(FIXTURE_SECRET, authority)
  const [pair] = c.split(';')
  const [name, value] = pair.split('=')
  const expectName = 'dsh-auth-' + Buffer.from(
    crypto.createHash('sha256').update(authority, 'utf8').digest(),
  ).toString('base64url')
  assert.equal(name, expectName)
  const parts = value.split('.')
  assert.equal(parts.length, 3)
  assert.equal(parts[0], 'v1')
})
await t('签名可用同算法独立验证', () => {
  const secret = FIXTURE_SECRET
  const c = dshSessionCookie(secret, '127.0.0.1:19387')
  const value = c.split('=').slice(1).join('=') // body 里可能含 =，取第一个 = 之后全部
  const [, body, sig] = value.split('.')
  const expect = crypto.createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest()
  assert.equal(sig, expect.toString('base64url'))
})
await t('payload 里 authority/version/issuedAt 正确，且 issuedAt 是过去时间', () => {
  const c = dshSessionCookie(FIXTURE_SECRET, '127.0.0.1:19387')
  const body = c.split('.')[1]
  const json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  assert.equal(json.version, 1)
  assert.equal(json.authority, '127.0.0.1:19387')
  assert.ok(json.issuedAt < Date.now(), 'issuedAt 必须回拨（DSH 不接受未来时间戳）')
  assert.ok(json.expiresAt > json.issuedAt)
})
await t('authority 变了 cookie 就变（绑定 Host）', () => {
  const a = dshSessionCookie(FIXTURE_SECRET, '127.0.0.1:19387')
  const b = dshSessionCookie(FIXTURE_SECRET, 'localhost:19387')
  assert.notEqual(a, b)
})

console.log('\n[2] 读取 DSH secret')
await t('扁平写法 browser-session.secret', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'h1-'))
  fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.dsh', '.credentials.yaml'),
    'client-connection:\n  browser-session.secret: AbCdEf0123456789AbCdEf0123456789AbCdEf012\n')
  assert.equal(readDshSecret(dir), 'AbCdEf0123456789AbCdEf0123456789AbCdEf012')
})
await t('嵌套写法 secret:', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'h2-'))
  fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.dsh', '.credentials.yaml'),
    'client-connection:\n  browser-session:\n    secret: ZzYyXx0123456789ZzYyXx0123456789ZzYyXx012\n')
  assert.equal(readDshSecret(dir), 'ZzYyXx0123456789ZzYyXx0123456789ZzYyXx012')
})
await t('文件不存在时给出可操作的中文错误', () => {
  assert.throws(() => readDshSecret(path.join(tmp, 'nope-')), /读不到/)
})

console.log('\n[2b] 桌面端会话签名记录 —— 2026-10-04「引用消息没办法回答」的根修')

const REAL_SECRET = 'FAKEnotarealsecret0000000000000000000000000'   // 43 字符 = base64url(32 字节)，**故意是假值**

/** 一份**形状照抄真实文件**的新版凭据文档：version + refs + records 三段。 */
function credsDoc(recordLines = []) {
  return [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: "sk-not-a-real-key"',
    'records:',
    ...recordLines,
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      token: not-a-real-token',
    '',
  ].join('\n')
}

const sessionRecordLines = [
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  `      secret: ${REAL_SECRET}`,
]

/** 造一个带凭据文档的假 DSH_HOME。 */
function homeWithCreds(text) {
  const dir = fs.mkdtempSync(path.join(tmp, 'cred-'))
  fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true })
  const file = path.join(dir, '.dsh', '.credentials.yaml')
  fs.writeFileSync(file, text, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return { dir, file }
}

await t('secretFromCredentials：新版文档 records 段里的 secret 读得出来', () => {
  assert.equal(secretFromCredentials(credsDoc(sessionRecordLines)).secret, REAL_SECRET)
})

await t('缺记录时给出**带路径**的原因，而不是空手而归', () => {
  const got = readBrowserSessionSecret(homeWithCreds(credsDoc()).dir)
  assert.equal(got.secret, '')
  assert.ok(got.reason.includes('client-connection/browser-session'), got.reason)
  assert.ok(got.reason.includes('.credentials.yaml'), got.reason)
})

await t('文件不存在 / 记录格式怪：都不抛（注入腿的失败必须能变成一句人话）', () => {
  assert.equal(readBrowserSessionSecret(path.join(tmp, 'nope-')).secret, '')
  const weird = credsDoc(['  client-connection/browser-session:', '    kind: grant'])
  assert.equal(secretFromCredentials(weird).secret, '')
  assert.ok(secretFromCredentials(weird).reason.includes('没有合法的 secret'))
})

await t('★ 记录缺失 → 补一条：形状必须过桌面端 storedSecret() 那三条校验', () => {
  const { dir, file } = homeWithCreds(credsDoc())
  const healed = healBrowserSessionRecord(dir)
  const rec = browserSessionRecord(healed.secret)
  // 桌面端 app.asar 里的校验：kind === 'grant' / payload.version === 1 /
  // payload.secret 是合法 base64url（32 字节 → 43 字符）
  assert.equal(rec.kind, 'grant')
  assert.equal(rec.payload.version, 1)
  assert.equal(Buffer.from(rec.payload.secret, 'base64url').length, 32)
  // 写进去之后必须能读回来，而且就是同一把
  assert.equal(secretFromCredentials(fs.readFileSync(file, 'utf8')).secret, healed.secret)
  assert.equal(readBrowserSessionSecret(dir).secret, healed.secret)
  // 备份必须真的存在（写别人家产品的东西，出事要能退回去）
  assert.ok(healed.backup && fs.existsSync(healed.backup), '必须留备份')
  assert.equal(fs.readFileSync(healed.backup, 'utf8'), credsDoc(), '备份必须是原文件原文')
})

await t('补写**只动该动的地方**：refs 段与别的记录一个字节都不变，权限位不被放松', () => {
  const { dir, file } = homeWithCreds(credsDoc())
  const before = fs.statSync(file).mode & 0o777
  healBrowserSessionRecord(dir)
  const after = fs.readFileSync(file, 'utf8')
  assert.ok(after.startsWith(credsDoc().slice(0, credsDoc().indexOf('records:') + 'records:'.length)))
  assert.ok(after.includes('  DEEPSEEK_API_KEY: "sk-not-a-real-key"'), 'refs 段必须原样保留')
  assert.ok(after.includes('  deepseek-account-platform/default:'), '别的记录必须原样保留')
  // ⚠️ Windows 上 Node 一律把可写文件报成 0o666、chmod 只切只读位，所以这里只能断言
  // **不被放松**（写成 0o600 的具体数字在 Windows 上必然失败）。POSIX 上 mode 会原样保持。
  assert.equal(fs.statSync(file).mode & 0o777, before, '权限位不能被放松')
})

await t('已经有记录时**一个字节都不动**（幂等），并且不产生备份', () => {
  const original = credsDoc(sessionRecordLines)
  const { dir, file } = homeWithCreds(original)
  const healed = healBrowserSessionRecord(dir)
  assert.equal(healed.secret, REAL_SECRET)
  assert.equal(healed.backup, '', '没写就不该有备份')
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})

await t('老格式（没有 records: 段）宁可报错也不乱写', () => {
  const { dir, file } = homeWithCreds('client-connection:\n  browser-session:\n    secret: ' + REAL_SECRET + '\n')
  const before = fs.readFileSync(file, 'utf8')
  assert.throws(() => healBrowserSessionRecord(dir), /不敢写入/)
  assert.equal(fs.readFileSync(file, 'utf8'), before, '报错就必须原样不动')
})

await t('补出来的密钥能直接换出 cookie（新老两条读法各司其职）', () => {
  const { dir } = homeWithCreds(credsDoc())
  const healed = healBrowserSessionRecord(dir)
  // 补写后的文件里只有这一条 `secret:`，所以连老读法的兜底正则也能认出来 ——
  // 两条读法**给的是同一把密钥**，这正是我们要的（qqruntime 里先老后新地试）。
  assert.equal(readDshSecret(dir), healed.secret)
  assert.equal(readBrowserSessionSecret(dir).secret, healed.secret)
  assert.ok(dshSessionCookie(readBrowserSessionSecret(dir).secret, '127.0.0.1:19387').includes('dsh-auth-'))
})

console.log('\n[3] access_token')
await t('缓存：同一 token 只取一次', async () => {
  let calls = 0
  const bot = new QqBotClient({
    appId: 'a', clientSecret: 's',
    fetchImpl: async () => { calls += 1; return { status: 200, json: async () => ({ access_token: 'T', expires_in: 7200 }) } },
    log: () => {},
  })
  assert.equal(await bot.getAccessToken(), 'T')
  assert.equal(await bot.getAccessToken(), 'T')
  assert.equal(calls, 1)
})
await t('并发 20 次只打 1 个请求', async () => {
  let calls = 0
  const bot = new QqBotClient({
    appId: 'a', clientSecret: 's',
    fetchImpl: async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 15))
      return { status: 200, json: async () => ({ access_token: 'T', expires_in: 7200 }) }
    },
    log: () => {},
  })
  const all = await Promise.all(Array.from({ length: 20 }, () => bot.getAccessToken()))
  assert.deepEqual([...new Set(all)], ['T'])
  assert.equal(calls, 1)
})
await t('⚠️ HTTP 200 但带 code → 必须判失败（官方就是这样返回错误的）', async () => {
  const bot = new QqBotClient({
    appId: 'bad', clientSecret: 'bad',
    // 注意：status 是 200
    fetchImpl: async () => ({ status: 200, json: async () => ({ code: 100016, message: 'invalid appid or secret' }) }),
    log: () => {},
  })
  await assert.rejects(() => bot.getAccessToken(), /getAppAccessToken 失败 code=100016/)
})

console.log('\n[4] 发送单聊消息')
function sendBot(capture, { status = 200, data = { id: 'M1', timestamp: 't' } } = {}) {
  return new QqBotClient({
    appId: 'a', clientSecret: 's', log: () => {},
    fetchImpl: async (url, init) => {
      if (url.includes('getAppAccessToken')) {
        return { status: 200, json: async () => ({ access_token: 'TOK', expires_in: 7200 }) }
      }
      capture.url = url
      capture.headers = init.headers
      capture.body = JSON.parse(init.body)
      return { status, json: async () => data, text: async () => JSON.stringify(data) }
    },
  })
}
await t('主动消息：不带 msg_id（这才是"主动私聊"）', async () => {
  const cap = {}
  await sendBot(cap).sendC2C('OPENID123', '任务完成了', {})
  assert.equal(cap.url, 'https://api.bot.qq.com/v2/users/OPENID123/messages')
  assert.equal(cap.headers.Authorization, 'QQBot TOK')
  assert.deepEqual(cap.body, { content: '任务完成了', msg_type: 0 })
  assert.equal('msg_id' in cap.body, false)
})
await t('被动回复：带 msg_id + msg_seq', async () => {
  const cap = {}
  await sendBot(cap).sendC2C('O', '收到', { msgId: 'EV1', msgSeq: 2 })
  assert.equal(cap.body.msg_id, 'EV1')
  assert.equal(cap.body.msg_seq, 2)
})
await t('互动召回：带 is_wakeup', async () => {
  const cap = {}
  await sendBot(cap).sendC2C('O', '还在等你', { isWakeup: true })
  assert.equal(cap.body.is_wakeup, true)
  assert.equal('msg_id' in cap.body, false)
})
await t('openid 会被 URL 编码', async () => {
  const cap = {}
  await sendBot(cap).sendC2C('a/b c', 'x')
  assert.ok(cap.url.includes('/v2/users/a%2Fb%20c/messages'))
})
await t('失败时抛错并带上 code', async () => {
  const cap = {}
  const bot = sendBot(cap, { status: 200, data: { code: 40054004, message: 'no relation' } })
  await assert.rejects(() => bot.sendC2C('O', 'x'), /code=40054004/)
})
await t('错误码翻译成人话', () => {
  assert.match(QqBotClient.explainError(40054004), /加为好友/)
  assert.match(QqBotClient.explainError(40054013), /允许主动发送/)
  assert.match(QqBotClient.explainError(40034105), /权限/)
  assert.match(QqBotClient.explainError(100016), /AppID/)
  assert.equal(QqBotClient.explainError(999999), null)
})

// ── 消息按钮（1.0.16）────────────────────────────────────────────────────────
// 官方：按钮只能挂在 markdown 消息上（`keyboard` 字段）。这里守的是"发出去的形状"：
// 带按钮就必须 msg_type=2 + keyboard，且 markdown 失败退回纯文本时按钮必须一起丢。
console.log('\n[4b] 消息按钮（keyboard）')

await t('★ 带按钮 ⇒ 必须走 markdown（msg_type=2），keyboard 原样带上', async () => {
  const cap = {}
  const kb = { content: { rows: [{ buttons: [{ id: '1' }] }] } }
  await sendBot(cap).sendC2C('O', '**选一个**', { keyboard: kb })
  assert.equal(cap.body.msg_type, 2)
  assert.equal(cap.body.markdown.content, '**选一个**')
  assert.deepEqual(cap.body.keyboard, kb)
  assert.equal('content' in cap.body, false, 'markdown 消息不能同时带 content')
})

await t('不带按钮时行为不变：纯文本 msg_type=0，且不出现 keyboard 字段', async () => {
  const cap = {}
  await sendBot(cap).sendC2C('O', '普通消息', {})
  assert.equal(cap.body.msg_type, 0)
  assert.equal('keyboard' in cap.body, false)
})

await t('★ markdown 发失败 ⇒ 退回纯文本**且丢掉按钮**（宁可少按钮也不能丢消息）', async () => {
  const bodies = []
  const bot = new QqBotClient({
    appId: 'a', clientSecret: 's', log: () => {},
    fetchImpl: async (url, init) => {
      if (url.includes('getAppAccessToken')) {
        return { status: 200, json: async () => ({ access_token: 'TOK' }) }
      }
      bodies.push(JSON.parse(init.body))
      if (bodies.length === 1) {
        return { status: 400, json: async () => ({ code: 40034127, message: '无markdown模板权限' }), text: async () => '{"code":40034127}' }
      }
      return { status: 200, json: async () => ({ id: 'M2' }), text: async () => '{"id":"M2"}' }
    },
  })
  const r = await bot.sendC2C('O', '带按钮的正文', { keyboard: { content: { rows: [] } } })
  assert.equal(r.id, 'M2')
  assert.equal(bodies.length, 2, '应当重发一次')
  assert.equal(bodies[0].msg_type, 2)
  assert.ok(bodies[0].keyboard, '第一次要带按钮')
  assert.equal(bodies[1].msg_type, 0)
  assert.equal('keyboard' in bodies[1], false, '退回来的纯文本不能带 keyboard')
})

console.log('\n[5] WebSocket 全流程')
await t('HELLO → 自动 IDENTIFY（token 前缀 / intents / shard 都要对）', async () => {
  const { bot, ws } = makeBot()
  bot.start()
  await new Promise((r) => setTimeout(r, 30))
  ws.open()
  ws.server({ op: 10, d: { heartbeat_interval: 45000 } })
  await new Promise((r) => setTimeout(r, 10))
  const id = ws.sent.find((m) => m.op === 2)
  assert.ok(id, '应该发出 op2 IDENTIFY')
  assert.equal(id.d.token, 'QQBot TOK')
  assert.equal(id.d.intents, C2C_INTENTS)
  assert.deepEqual(id.d.shard, [0, 1])
  bot.stop()
})
await t('READY → ready=true 并记住 session_id', async () => {
  const { bot, ws } = makeBot()
  bot.start()
  await new Promise((r) => setTimeout(r, 30))
  ws.open()
  ws.server({ op: 10, d: { heartbeat_interval: 45000 } })
  ws.server({ op: 0, s: 1, t: 'READY', d: { session_id: 'SESS-1', user: { username: '机器人' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(bot.ready, true)
  assert.equal(bot._sessionId, 'SESS-1')
  bot.stop()
})
await t('业务事件分发给 onEvent', async () => {
  const { bot, ws, events } = makeBot()
  bot.start()
  await new Promise((r) => setTimeout(r, 30))
  ws.open()
  ws.server({ op: 10, d: { heartbeat_interval: 45000 } })
  ws.server({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: { id: 'EV1', content: '你好' } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(events.length, 1)
  assert.equal(events[0].n, 'C2C_MESSAGE_CREATE')
  assert.equal(events[0].d.content, '你好')
  bot.stop()
})
await t('断线后带 session 重连走 RESUME', async () => {
  const wsList = []
  const bot = new QqBotClient({
    appId: 'a', clientSecret: 's', log: () => {},
    wsFactory: () => { const w = new FakeWs(); wsList.push(w); return w },
    fetchImpl: async (url) => {
      if (url.includes('getAppAccessToken')) return { status: 200, json: async () => ({ access_token: 'TOK', expires_in: 7200 }) }
      return { status: 200, json: async () => ({ url: 'wss://gw' }), text: async () => JSON.stringify({ url: 'wss://gw' }) }
    },
  })
  bot.start()
  await new Promise((r) => setTimeout(r, 30))
  wsList[0].open()
  wsList[0].server({ op: 10, d: { heartbeat_interval: 45000 } })
  wsList[0].server({ op: 0, s: 7, t: 'READY', d: { session_id: 'S1', user: {} } })
  await new Promise((r) => setTimeout(r, 10))
  wsList[0].close(1006)
  // 退避 1 秒后重连
  await new Promise((r) => setTimeout(r, 1200))
  assert.ok(wsList.length >= 2, '应该发起了重连')
  wsList[1].open()
  wsList[1].server({ op: 10, d: { heartbeat_interval: 45000 } })
  await new Promise((r) => setTimeout(r, 10))
  const resume = wsList[1].sent.find((m) => m.op === 6)
  assert.ok(resume, '应该发 op6 RESUME')
  assert.equal(resume.d.session_id, 'S1')
  assert.equal(resume.d.seq, 7)
  bot.stop()
})
await t('致命错误码 4915（已封禁）停止重连', async () => {
  const { bot, ws } = makeBot()
  bot.start()
  await new Promise((r) => setTimeout(r, 30))
  ws.open()
  ws.close(4915)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(bot._running, false, '不该继续无限重连')
})

console.log('\n[6] 回答拼装（严格对齐 DSH 的 matchesQuestions）')
const Q1 = {
  id: 'q1',
  question: '选哪个方案？',
  options: [{ label: '方案A' }, { label: '方案B' }],
}
const Q2 = { id: 'q2', question: '还有什么要补充？', options: [] }
await t('回序号 → 选中对应选项', () => {
  assert.deepEqual(buildOneAnswer('2', Q1), { id: 'q1', selected: ['方案B'] })
})
await t('回选项原文 → 选中该选项', () => {
  assert.deepEqual(buildOneAnswer('方案A', Q1), { id: 'q1', selected: ['方案A'] })
})
await t('回自由文本 → custom + selected 为空（单选必须这样，不能两者都给）', () => {
  const a = buildOneAnswer('我自己想了个方案C', Q1)
  assert.deepEqual(a, { id: 'q1', selected: [], custom: '我自己想了个方案C' })
})
await t('没有选项的问题 → 纯自由文本', () => {
  assert.deepEqual(buildOneAnswer('补充一句', Q2), { id: 'q2', selected: [], custom: '补充一句' })
})
await t('序号越界 → 退化成自由文本，不会错选', () => {
  const a = buildOneAnswer('9', Q1)
  assert.deepEqual(a.selected, [])
  assert.equal(a.custom, '9')
})
await t('多选：全部命中才当选项', () => {
  const q = { id: 'm', question: '多选', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }] }
  assert.deepEqual(buildOneAnswer('甲,丙', q).selected, ['甲', '丙'])
  assert.deepEqual(buildOneAnswer('甲和丁', q), { id: 'm', selected: [], custom: '甲和丁' })
})
await t('多选题不重复选中', () => {
  const q = { id: 'm', question: '多选', multiSelect: true, options: [{ label: '甲' }] }
  assert.deepEqual(buildOneAnswer('甲 甲', q).selected, ['甲'])
})
await t('单问整段话就是答案', () => {
  const r = buildAnswers('方案B', [Q1])
  assert.equal(r.ok, true)
  assert.deepEqual(r.answers, [{ id: 'q1', selected: ['方案B'] }])
})
await t('多个小问：行数对不上要明确报错，不能瞎塞', () => {
  const r = buildAnswers('只有一行', [Q1, Q2])
  assert.equal(r.ok, false)
  assert.match(r.error, /2 个小问/)
})
await t('多个小问：分两行正确映射', () => {
  const r = buildAnswers('1\n补充内容', [Q1, Q2])
  assert.equal(r.ok, true)
  assert.deepEqual(r.answers, [
    { id: 'q1', selected: ['方案A'] },
    { id: 'q2', selected: [], custom: '补充内容' },
  ])
})
await t('空回答被拒', () => {
  assert.equal(buildAnswers('', [Q1]).ok, false)
  assert.equal(buildAnswers('   ', [Q2]).ok, false)
})
await t('没有问题时被拒', () => {
  assert.equal(buildAnswers('x', []).ok, false)
})

console.log('\n[7] 来消息路由')
await t('★ 1.0.24：不是 `/` 开头的文本，routeIncoming 一律按闲聊交回去', () => {
  // ⚠️ 以前这里是「无提问 → 当新任务」「有提问 → 当回答」。那两条"默认判断"已被删除：
  //    一句话的去向只由「有没有引用」和「带不带 /」决定（见 routeMessage 的 ③）。
  assert.deepEqual(routeIncoming('帮我跑一下测试', { hasPendingQuestion: false }),
    { kind: 'chat', text: '帮我跑一下测试' })
  assert.deepEqual(routeIncoming('方案A', { hasPendingQuestion: true }),
    { kind: 'chat', text: '方案A' })
})
await t('/task 强制当任务（即使有提问）', () => {
  assert.deepEqual(routeIncoming('/task 换个活干', { hasPendingQuestion: true }),
    { kind: 'task', text: '换个活干' })
})
await t('/answer 无提问时明确告知', () => {
  assert.equal(routeIncoming('/answer 嗯', { hasPendingQuestion: false }).kind, 'no_question')
})
await t('/status 与 /help', () => {
  assert.equal(routeIncoming('/status').kind, 'status')
  assert.equal(routeIncoming('/help').kind, 'help')
})
await t('未知指令被识别', () => {
  const r = routeIncoming('/frobnicate')
  assert.equal(r.kind, 'unknown')
  assert.equal(r.command, 'frobnicate')
})
await t('空消息忽略', () => {
  assert.equal(routeIncoming('   ').kind, 'ignore')
})
await t('/task 不带内容 = 先挑工作区（不是给用法）', () => {
  assert.equal(routeIncoming('/task').kind, 'task_workspaces')
})
// 远程更新（1.0.7）：`/update` 直接装、`/update check` 只查不装；中文同义词 `/更新`。
// 这里守的是**路由**这一层（三分支判断与文案在 tests/update.test.mjs 里守）。
await t('/update 与 /更新 路由到 {kind:update}，check 只查不装', () => {
  assert.deepEqual(routeIncoming('/update'), { kind: 'update', check: false })
  assert.deepEqual(routeIncoming('/更新'), { kind: 'update', check: false })
  assert.deepEqual(routeIncoming('/update check'), { kind: 'update', check: true })
  assert.deepEqual(routeIncoming('/更新 检查'), { kind: 'update', check: true })
})
await t('帮助里列了 /update（否则用户不知道有这个功能）', () => {
  assert.match(HELP_TEXT, /^\/update\s+把插件更新到最新版（会自动重启 DSH）$/m)
})

// ── 工作区派活（1.0.15；1.0.24 起"选名单"必须显式）──────────────────────────
// 主人的原话：「我希望我输入 /task 的时候可以选择工作区再进行输入派活」。
// 两步：/task → 点按钮 / 发 /pick N 选工作区 → 之后发的话都派进那个工作区的专属会话。
console.log('\n[7b] 工作区派活（/task 两步）')

await t('/task 三种写法：不带内容列工作区、带内容直接派活', () => {
  assert.deepEqual(routeIncoming('/task'), { kind: 'task_workspaces' })
  assert.deepEqual(routeIncoming('/任务'), { kind: 'task_workspaces' })
  assert.deepEqual(routeIncoming('/task 跑一下测试'), { kind: 'task', text: '跑一下测试' })
  assert.deepEqual(routeIncoming('/task 跑一下测试', { hasPendingQuestion: true }),
    { kind: 'task', text: '跑一下测试' }, '/task 带内容仍压过"有提问在等"')
})

// ⚠️ 这一节 2026-10-07 晚**反向改过**：以前"刚发过名单 + 纯数字 = 选它"。主人当天要求
//    「不引用、不带 / 就是闲聊，无论任何情况」，所以裸数字一律当闲聊，选名单只剩两条路：
//    点按钮（按钮发的是 /pick、/open）或者显式发指令。这里守的就是这两条路都还在。
await t('★ 选名单必须显式：/pick N、/open N、/use N 都还在，裸数字不再算', () => {
  assert.deepEqual(routeIncoming('/pick 2'), { kind: 'pick_workspace', index: 2, text: '/pick 2' })
  assert.deepEqual(routeIncoming('/open 2'), { kind: 'pick_task_session', index: 2, text: '/open 2' })
  assert.deepEqual(routeIncoming('/use 2'), { kind: 'pick_session', index: 2, text: '/use 2' })
  for (const n of ['0', '1', '2', '12']) {
    assert.equal(routeMessage({ text: n, refIdx: '', refTarget: null }).kind, 'chat',
      `裸数字「${n}」必须当闲聊`)
  }
})

await t('★ 工作区名单的按钮发的是 /pick N（不是裸数字）', () => {
  const kb = buildNumberButtons('/pick ', 6)
  const data = kb.content.rows.flatMap((r) => r.buttons).map((b) => b.action.data)
  assert.deepEqual(data, ['/pick 1', '/pick 2', '/pick 3', '/pick 4', '/pick 5', '/pick 6'])
})

await t('★ 提问的选项按钮发的是 /answer N（裸数字已经不作答了）', () => {
  const kb = buildOptionKeyboard([{ options: [{ label: '方案 A' }, { label: '方案 B' }] }])
  // 一行一个：两个按钮分在两行，别再把 rows[0] 当整排。
  assert.deepEqual(kb.content.rows.map((r) => r.buttons.length), [1, 1])
  const data = kb.content.rows.map((r) => r.buttons[0].action.data)
  assert.deepEqual(data, ['/answer 1', '/answer 2'])
  for (const d of data) {
    assert.equal(routeIncoming(d, { hasPendingQuestion: true }).kind, 'answer', `${d} 必须仍能作答`)
  }
})

await t('工作区名单文案：编号 + 名字 + 会话数 + 标出当前 + 说清下一步', () => {
  const text = formatWorkspacePickerText({
    workspaces: [
      { cwd: 'D:\\cyanproject\\agenttool', name: 'agenttool', sessions: 12, updatedAt: Date.now() - 60000 },
      { cwd: 'D:\\work\\x', name: 'x', sessions: 1, updatedAt: Date.now() - 3600000 },
    ],
    currentCwd: 'D:\\cyanproject\\agenttool',
    count: 6,
  })
  assert.match(text, /1\. agenttool · 12 个会话/)
  assert.match(text, /← 就是它/)
  assert.match(text, /2\. x · 1 个会话/)
  assert.match(text, /\/pick/)
  assert.match(text, /\/task 要做的事/)
})

await t('工作区名单：空 / 读不到都如实说，不假装"没有工作区"', () => {
  assert.match(formatWorkspacePickerText({ workspaces: [] }), /还没有可以挑的工作区/)
  const err = formatWorkspacePickerText({ listError: 'socket hang up' })
  assert.match(err, /没读出来/)
  assert.match(err, /socket hang up/)
})

await t('选工作区的回执：成功 / 越界 / 已不在，三支都要有话说', () => {
  const ok = formatWorkspacePickAck('ok', {
    name: 'agenttool', cwd: 'D:\\cyanproject\\agenttool', session: 'main',
  })
  assert.match(ok, /工作区已选：agenttool/)
  assert.match(ok, /D:\\cyanproject\\agenttool/, '完整路径要带上，免得同名目录选错')
  assert.match(ok, /「main」/)
  assert.match(formatWorkspacePickAck('out-of-range', { index: 9, count: 2 }), /只有 2 个工作区/)
  assert.match(formatWorkspacePickAck('gone', { index: 2, name: 'x' }), /已经不在了/)
})

await t('summarizeSession 带出完整 cwd（派活要靠它建会话），短名仍只留最后一段', () => {
  const s = summarizeSession({ sessionId: 's1', updatedAt: 1, cwd: 'D:\\cyanproject\\agenttool' })
  assert.equal(s.cwd, 'D:\\cyanproject\\agenttool')
  assert.equal(s.project, 'agenttool')
  assert.equal(summarizeSession({ sessionId: 's2' }).cwd, '', '没有 cwd 时给空串，不吐 undefined')
})

await t('老状态文件平滑升级：工作区那三个键都有安全默认值', () => {
  const f = path.join(tmp, 'state-task-old.json')
  fs.writeFileSync(f, JSON.stringify({ openId: 'o', pickerIds: ['a'], pickerAt: 5 }), 'utf8')
  const st = new BotState(f)
  assert.deepEqual(st.data.taskPickerCwds, [])
  assert.equal(st.data.taskPickerAt, 0)
  assert.deepEqual(st.data.taskSessions, {})
  assert.equal(st.data.activeTaskCwd, '')
})

await t('帮助里写了 /task 的两步用法', () => {
  assert.match(HELP_TEXT, /^\/task\s+列出工作区/m)
  assert.match(HELP_TEXT, /^\/task 内容\s+直接派给当前工作区/m)
})

// ── 消息按钮：选项按钮与 @机器人 前缀（1.0.16）────────────────────────────────
// 主人的要求：「发送的信息里有蓝色的字，我点击可以执行操作」。
// 按钮 = 指令按钮（type=2）：点了把 data 当一条消息发回来，走普通消息事件、不需要新事件订阅。
console.log('\n[7c] 消息按钮：选项按钮与 @机器人 前缀')

await t('单选提问 ⇒ 一行一个按钮，data 是 `/answer N` 显式指令（1.0.24 起裸数字不作答了）', () => {
  const kb = buildOptionKeyboard([{ id: 'q1', options: [{ label: '方案A' }, { label: '方案B' }] }])
  // 1.0.26：一行一个（以前 2 个挤在同一行）。主人原话「你一行放 4 个按钮，我根本看不见是什么东西」。
  assert.equal(kb.content.rows.length, 2, '2 个选项 = 2 行，一个按钮一行')
  assert.equal(kb.content.rows[0].buttons.length, 1)
  assert.equal(kb.content.rows[1].buttons.length, 1)
  const b0 = kb.content.rows[0].buttons[0]
  assert.equal(b0.render_data.label, '1.方案A')
  assert.equal(b0.action.data, '/answer 1')
  assert.equal(b0.action.type, 2, '指令按钮：点了把 data 当消息发回来')
  assert.equal(b0.action.permission.type, 2, '所有人可点')
  assert.equal(b0.action.enter, true, '单聊：点一下直接发送')
  assert.equal(b0.render_data.style, 1, '蓝色线框')
  const b1 = kb.content.rows[1].buttons[0]
  assert.equal(b1.action.data, '/answer 2')
  // 序号能被既有的答案解析吃掉 —— 这才是"点一下等于作答"的关键。
  // 路由那一半：`/answer 2` 必须被认成作答（裸数字「2」现在会被当闲聊，所以按钮不能发裸数字）。
  assert.equal(routeIncoming(b1.action.data, { hasPendingQuestion: true }).kind, 'answer')
  assert.equal(routeIncoming(b1.action.data, { hasPendingQuestion: true }).text, '2')
  const built = buildOneAnswer('2', { id: 'q1', options: [{ label: '方案A' }, { label: '方案B' }] })
  assert.deepEqual(built.selected, ['方案B'])
})

await t('★ 按钮文字剥掉模型自带的「A.」「1、」前缀与「（推荐）」尾巴（1.0.26）', () => {
  // 就是 2026-10-07 那条真问题：一行 4 个按钮 + 硬切 ⇒ 主人看到的是「1.A. 一行一个按钮（推」。
  const kb = buildOptionKeyboard([{
    id: 'q',
    options: [
      { label: 'A. 一行一个按钮（推荐）' },
      { label: 'B) 正文精简' },
      { label: '3、选项全交给按钮' },
      { label: 'D. 保持现状（推荐）' },
    ],
  }])
  const labels = kb.content.rows.map((r) => r.buttons[0].render_data.label)
  assert.deepEqual(labels, ['1.一行一个按钮', '2.正文精简', '3.选项全交给按钮', '4.保持现状'])
  for (const l of labels) {
    assert.ok([...l].length <= 10, `超官方上限：${l}`)
    // 一个括号都不许留：半截括号（「1.A. 一行一个按钮（推」）正是主人说"看不见是什么东西"的元凶。
    assert.ok(!/[（()）]/.test(l), `不该出现任何括号（更不该是半截的）：${l}`)
  }
  // 剥掉的必须是**重复信息**：编号由按钮给，「推荐」由正文那行标 —— 正文里要能标回来。
  assert.equal(isRecommendedLabel('A. 一行一个按钮（推荐）'), true)
  assert.equal(isRecommendedLabel('A. 一行一个按钮'), false)
  assert.equal(cleanOptionText('A) 正文精简'), '正文精简')
  assert.equal(cleanOptionText('3、选项全交给按钮'), '选项全交给按钮')
  assert.equal(cleanOptionText('（推荐）'), '')
})

await t('按钮文字不超过 10 字符（官方硬限制），长选项自动截断', () => {
  const kb = buildOptionKeyboard([{ id: 'q', options: [{ label: '一个特别特别长的选项名字' }] }])
  const label = kb.content.rows[0].buttons[0].render_data.label
  assert.ok([...label].length <= 10, `实际 ${label}`)
  assert.ok(label.startsWith('1.'))
  const tight = buildOptionKeyboard([{ id: 'q', options: [{ label: 'x'.repeat(30) }] }], { labelMax: 4 })
  assert.equal(tight.content.rows[0].buttons[0].render_data.label, '1.xx', '序号占 2 字，正文留 2 字')
  assert.equal([...tight.content.rows[0].buttons[0].render_data.label].length, 4)
  // 正文那边判断"会不会被切"用的是同一个口径（optionLabelRoom），不能各写各的。
  assert.equal(optionLabelRoom(0), 8, '10 字上限 - 「1.」= 8 字给选项名')
  assert.equal(optionLabelRoom(0, { max: 4 }), 2)
})

await t('多选 / 多个问题 / 选项超过 5 个 / 没有选项 ⇒ 不装按钮（返回 null）', () => {
  assert.equal(buildOptionKeyboard([{ id: 'q', multiSelect: true, options: [{ label: 'a' }] }]), null)
  assert.equal(buildOptionKeyboard([
    { id: 'a', options: [{ label: 'x' }] }, { id: 'b', options: [{ label: 'y' }] },
  ]), null)
  assert.equal(buildOptionKeyboard([{
    id: 'q', options: Array.from({ length: 6 }, (_, i) => ({ label: `o${i}` })),
  }]), null)
  assert.equal(buildOptionKeyboard([{ id: 'q', options: [] }]), null)
  assert.equal(buildOptionKeyboard([]), null)
  assert.equal(buildOptionKeyboard(null), null)
})

await t('★ 指令按钮点出来带 @机器人 前缀：剥掉后仍然是指令', () => {
  assert.equal(stripBotMention('@DSH助手 /status'), '/status')
  assert.equal(stripBotMention('@bot /task 跑测试'), '/task 跑测试')
  assert.equal(routeIncoming('@DSH助手 /status').kind, 'status')
  assert.equal(routeIncoming('@DSH助手 /task 跑测试').kind, 'task')
  assert.equal(
    routeMessage({ text: '@DSH助手 /status', refIdx: '', hasPendingQuestion: false, refTarget: null }).kind,
    'status',
  )
})

await t('@ 前缀只在后面紧跟 / 时才剥（不误伤正常消息的正文）', () => {
  assert.equal(stripBotMention('@张三 你好'), '@张三 你好')
  assert.equal(stripBotMention('邮箱 a@b /c'), '邮箱 a@b /c')
  assert.equal(routeIncoming('@张三 你好').kind, 'chat', '1.0.24：不是指令就是闲聊')
  assert.equal(routeIncoming('@张三 你好', { hasPendingQuestion: true }).kind, 'chat',
    '有提问在等也一样 —— 不作答，除非引用那条提问或发 /answer')
  assert.equal(routeIncoming('@张三 你好').text, '@张三 你好', '送进会话的正文仍是原话')
  assert.equal(
    routeMessage({ text: '@张三 你好', refIdx: '', refTarget: null }).kind, 'chat',
  )
})

// ── 更新提醒与帮助里的按钮（1.0.17）─────────────────────────────────────────
console.log('\n[7d] 更新提醒的两个按钮 / 帮助按钮 / /skip')

await t('/skip 与 /update skip 都是「忽略本次」，且没吃掉 /update check', () => {
  assert.equal(routeIncoming('/skip').kind, 'update_skip')
  assert.equal(routeIncoming('/忽略').kind, 'update_skip')
  assert.equal(routeIncoming('/update skip').kind, 'update_skip')
  assert.equal(routeIncoming('/update 忽略').kind, 'update_skip')
  assert.deepEqual(routeIncoming('/update check'), { kind: 'update', check: true })
  assert.deepEqual(routeIncoming('/update'), { kind: 'update', check: false })
})

await t('更新提醒的两个按钮：显示中文，data 是命令，且命令真的能被路由认出来', () => {
  const bs = buildUpdateNoticeKeyboard().content.rows[0].buttons
  assert.equal(bs.length, 2)
  assert.equal(bs[0].render_data.label, '忽略本次')
  assert.equal(bs[0].action.data, '/skip')
  assert.equal(bs[1].render_data.label, '立即更新')
  assert.equal(bs[1].action.data, '/update')
  assert.equal(bs[1].render_data.style, 4, '「立即更新」用蓝底白字，比「忽略本次」显眼')
  assert.equal(routeIncoming(bs[0].action.data).kind, 'update_skip', '点了忽略必须真的能执行')
  assert.equal(routeIncoming(bs[1].action.data).kind, 'update', '点了更新必须真的能执行')
})

await t('帮助的按钮：两行七个，每个命令都被路由认得出、文字不超 10 字符', () => {
  const kb = buildHelpKeyboard()
  assert.equal(kb.content.rows.length, 2)
  const all = kb.content.rows.flatMap((r) => r.buttons)
  assert.equal(all.length, 7)
  for (const b of all) {
    assert.ok([...b.render_data.label].length <= 10, `${b.render_data.label} 超过 10 字符`)
    assert.notEqual(routeIncoming(b.action.data).kind, 'unknown', `${b.action.data} 不是已知指令`)
  }
  assert.equal(all[0].render_data.label, '看状态')
  assert.equal(all[0].action.data, '/status')
  // 1.0.19 加的第 7 个：直接开个新对话（`/task` 第二步也能点到，这里顺手放一个）。
  assert.ok(all.some((b) => b.action.data === '/new'), '帮助里要能直接开新对话')
})

await t('按钮超限就整个不装（宁可没按钮，也不要发一条平台会拒的消息）', () => {
  const one = makeCmdButton('x', '/x')
  assert.equal(buildKeyboard([Array(6).fill(one)]), null, '一行 6 个超限')
  assert.equal(buildKeyboard(Array(6).fill([one])), null, '6 行超限')
  assert.equal(buildKeyboard([]), null)
  assert.equal(buildKeyboard([[]]), null)
  assert.ok(buildKeyboard([Array(5).fill(one)]), '5 个一行是允许的')
  assert.ok(buildKeyboard(Array(5).fill([one])), '5 行是允许的')
})

await t('label 超长会自动截到 10 字符（官方硬限制）', () => {
  const b = makeCmdButton('这是一个非常非常长的按钮名字', '/x')
  assert.equal([...b.render_data.label].length, 10)
  assert.equal(b.action.data, '/x', 'data 不受显示文字截断影响')
})

// ⚠️ 这一条是**源码级守卫**（不是行为测试）：更新检查跑在定时器里、要假 fetch 才能端到端跑，
//    而这里要守的只是"接线有没有被拆掉"。真正的行为（点了按钮会怎样）由上面那几条路由断言守。
await t('【源码】更新提醒挂了按钮、检查认「忽略本次」、帮助也挂了按钮', () => {
  // 自己读一份：`qqruntimeSrc` 是在文件后面才声明的，这里直接用会踩 TDZ。
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'qqruntime.js'), 'utf8')
  assert.match(src, /updateSkipped === got\.version/, '更新检查必须认「忽略本次」')
  assert.match(src, /async function handleUpdateSkip/, '要有 /skip 的处理器')
  assert.match(src, /state\.set\(\{ updateSkipped: pending \}\)/, '忽略必须落盘')
  assert.match(src, /buttons: buildUpdateNoticeKeyboard\(\)/, '新版本提醒要挂两个按钮')
  assert.match(src, /replyPassive\(data, HELP_TEXT, undefined, buildHelpKeyboard\(\)\)/,
    '帮助回复要挂按钮')
})
await t('★ 投递模式默认 queue：DSH 里才会落成正常的用户消息气泡', () => {
  // 依据 DSH 源码：queue → `user` 节点（正常消息）；steer → `steering`（「插话」节点）。
  // 主人明确要求「QQ 提问跟在 dsh 输入框提问一样」，所以**会话在跑时也必须是 queue**。
  assert.equal(pickPromptMode(true), 'queue', '会话在跑时也必须默认 queue')
  assert.equal(pickPromptMode(false), 'queue', '空闲时当然是 queue')
})

await t('只有「在跑 + 明确选了 steer」才插话（空闲时 steer 会退化成排队）', () => {
  assert.equal(pickPromptMode(true, 'steer'), 'steer')
  assert.equal(pickPromptMode(false, 'steer'), 'queue', '空闲时 steer 无意义，退化为排队')
  assert.equal(pickPromptMode(true, 'nonsense'), 'queue', '非法值一律回到安全的 queue')
})

// ── 派活的两处修复（1.0.18）─────────────────────────────────────────────────
//
// 🔴 现场：2026-10-07 08:45 发的 `/task` 工作区名单，主人 09:09 回「2」。
//    名单 5 分钟就作废了 ⇒ workspacePickerActive=false ⇒ 那个「2」一路走到 `chat`，
//    被当成一句派活正文注入了会话（转录里 `user/message` 的正文就是 `"2"`）：
//    选择没生效、白跑一轮、还往会话里塞了句没头没脑的东西。
//
//    两处修复，缺一不可：
//    ① 工作区名单的窗口 5 分钟 → **24 小时**（手机上看到名单到想好选哪个，5 分钟不够）；
//    ② 裸数字**绝不再注入会话** —— 没有名单能解释它就问一句（`stray_number`）。
console.log('\n[7e] 派活：工作区名单 24 小时有效 + 裸数字绝不注入会话')

await t('★ `/pick 3` 是显式指令：直接给出编号，不需要名单新鲜', () => {
  assert.deepEqual(routeIncoming('/pick 3'), { kind: 'pick_workspace', index: 3, text: '/pick 3' })
  assert.equal(routeIncoming('/选择 5').index, 5)
  assert.equal(routeIncoming('/choose 12').index, 12)
})

await t('/pick 不带编号 / 带非数字 → 说清用法，而不是当成选第 0 个', () => {
  assert.equal(routeIncoming('/pick').kind, 'usage')
  assert.match(routeIncoming('/pick').text, /\/pick 3/)
  assert.equal(routeIncoming('/pick 三').kind, 'usage')
  assert.equal(routeIncoming('/pick 3 5').kind, 'usage')
})

await t('★ 工作区窗口 24 小时、会话窗口 5 分钟，且两个常量关系正确', () => {
  assert.equal(WORKSPACE_PICK_WINDOW_MS, 24 * 60 * 60 * 1000)
  assert.equal(PICK_WINDOW_MS, 5 * 60 * 1000)
  assert.ok(WORKSPACE_PICK_WINDOW_MS > PICK_WINDOW_MS)
})

await t('★ 复现当天现场：隔 24 分钟的名单，对工作区**仍有效**（对会话仍然失效）', () => {
  const now = 1791335358000 // 2026-10-07 09:09:18 前后
  const listAt = now - 24 * 60 * 1000 // 08:45 那份名单
  const picker = { pickerAt: listAt, ids: ['D:/a', 'D:/b'] }
  assert.equal(isPickerFresh(picker, now), false, '按会话那个 5 分钟窗口，它确实过期了（故障成因）')
  assert.equal(isPickerFresh(picker, now, WORKSPACE_PICK_WINDOW_MS), true, '按工作区窗口必须还有效')
  assert.equal(pickerAge(picker, now), 24 * 60 * 1000, '要能说清"是 24 分钟前那份名单"')
})

await t('工作区名单超过 24 小时才失效', () => {
  const now = 1791335358000
  const old = { pickerAt: now - WORKSPACE_PICK_WINDOW_MS - 1, ids: ['D:/a'] }
  assert.equal(isPickerFresh(old, now, WORKSPACE_PICK_WINDOW_MS), false)
})

await t('★ 名单下面挂数字按钮：点了发回来的是 `/pick N`，且真的能选中第 N 个', () => {
  const kb = buildNumberButtons('/pick ', 6)
  assert.equal(kb.content.rows.length, 2, '6 个 → 两行（每行 5 个）')
  assert.equal(kb.content.rows[0].buttons.length, 5)
  assert.equal(kb.content.rows[1].buttons.length, 1)
  const all = kb.content.rows.flatMap((r) => r.buttons)
  all.forEach((b, i) => {
    assert.equal(b.render_data.label, String(i + 1), '显示的就是编号')
    assert.equal(b.action.data, `/pick ${i + 1}`, 'data 是显式指令（不走裸数字那条路）')
    assert.equal(b.action.type, 2)
    // 按钮文字不超过 10 字符（官方硬限制），编号一定不超
    assert.ok([...b.render_data.label].length <= 10)
    // 关键：点出来的东西必须真的被路由认成"选第 i+1 个工作区"
    const r = routeIncoming(b.action.data)
    assert.equal(r.kind, 'pick_workspace', `点了第 ${i + 1} 个必须能执行`)
    assert.equal(r.index, i + 1)
  })
})

await t('会话名单的数字按钮同理（`/use N`），6 个也不超两行', () => {
  const kb = buildNumberButtons('/use ', 6)
  const all = kb.content.rows.flatMap((r) => r.buttons)
  assert.equal(all.length, 6)
  all.forEach((b, i) => {
    const r = routeIncoming(b.action.data)
    assert.equal(r.kind, 'pick_session', `点了第 ${i + 1} 个会话必须能切过去`)
    assert.equal(r.index, i + 1)
  })
})

await t('按钮装不下就整个不装：0 个 / 超过 5 行（25 个）都返回 null', () => {
  assert.equal(buildNumberButtons('/pick ', 0), null)
  assert.equal(buildNumberButtons('/pick ', -1), null)
  assert.equal(buildNumberButtons('/pick ', 26), null, '26 个要 6 行，超限')
  assert.ok(buildNumberButtons('/pick ', 25), '25 个正好 5 行，允许')
})

await t('★ 1.0.24：路由里已经没有"裸数字"这条分支了（拦人不再存在）', () => {
  // 行为断言在 session-picker [3] 里（裸数字一律 chat）。这里守**另一件**事：那套
  // 「拦下来问一句」的机制被真正删掉了 —— 只剩一个空壳函数就说明回退了一半。
  const bridge = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'qqbridge.js'), 'utf8')
  const rt = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'qqruntime.js'), 'utf8')
  assert.ok(!bridge.includes('stray_number'), 'qqbridge 里不该再有 stray_number')
  assert.ok(!bridge.includes('formatStrayNumber'), 'formatStrayNumber 应当已经删掉')
  assert.ok(!rt.includes('stray_number'), 'qqruntime 里那个 case 也要删干净')
  assert.ok(!rt.includes('formatStrayNumber'), 'qqruntime 不该再引用它')
  // 路由函数本身不许再看"名单新不新鲜" —— 那是被删掉的那条规则的全部依据。
  const at = bridge.indexOf('export function routeMessage(')
  assert.ok(at > 0)
  const routeFn = bridge.slice(at, bridge.indexOf('\n}\n', at))
  assert.ok(routeFn.length > 200, '切出来的函数体不能是空的（否则这条守卫等于没写）')
  assert.ok(!/pickerActive|workspacePickerActive|taskSessionPickerActive/.test(routeFn),
    '🔴 routeMessage 的签名里不该再出现这三个"名单新鲜"开关')
  assert.match(routeFn, /kind: 'chat'/, '不引用、不带 / → 一律闲聊')
})

await t('★ 1.0.24：消息一律照投，只在两种"多半打错了"的情形下补一句提示', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'qqruntime.js'), 'utf8')
  const at = src.indexOf("case 'chat': {")
  assert.ok(at > 0, '要有 chat 分支')
  const body = src.slice(at, src.indexOf("case 'sessions':", at))
  const promptAt = body.indexOf('await handlePrompt(')
  const hintAt = body.indexOf('answerHinted')
  assert.ok(promptAt > 0, '闲聊分支必须照常投递（handlePrompt）')
  assert.ok(hintAt > promptAt, '🔴 提示只能发生在投递**之后**，绝不能拦下这条消息')
  assert.match(body, /引用那条提问/, '有提问在等时要告诉主人"引用才能回答"')
  assert.match(body, /\/answer /, '也要给出显式指令这条路')
  assert.match(body, /点上面的按钮/, '刚发过名单却手打了数字时，要说清怎么选')
  // 同一条提问只提示一次（否则他每说一句都被念一遍）。
  assert.match(body, /!answerHinted\.has\(pending\.askId\)/, '提示要去重')
  assert.ok(src.includes('const answerHinted = new Set()'), '去重集合要在模块作用域')
})

await t('★ 提问文案必须说清"怎么才算回答"（1.0.24 起普通消息不再算作答）', () => {
  const single = formatQuestion([{ options: [{ label: 'A' }, { label: 'B' }] }])
  assert.match(single, /引用这条消息/, '单选带按钮：两个入口都要写出来')
  assert.match(single, /点下面的按钮/)
  const freeform = formatQuestion([{ options: [] }])
  assert.match(freeform, /引用这条消息/)
  assert.ok(!/回数字比如 1/.test(freeform), '没有选项的题不该让人"回数字"')
  const multi = formatQuestion([{ options: [{ label: 'A' }] }, { options: [{ label: 'B' }] }])
  assert.match(multi, /引用这条消息/)
  assert.match(multi, /2 个问题分 2 行答/)
})

await t('`/pick` 时没有名单：明说"先发 /task"，**不许**悄悄拿此刻的列表顶上', () => {
  const t1 = formatWorkspacePickAck('no-list')
  assert.match(t1, /没有在等你选的工作区名单/)
  assert.match(t1, /\/task/)
})

await t('工作区名单文案里写了「名单留 24 小时」和可以点按钮', () => {
  const txt = formatWorkspacePickerText({
    workspaces: [
      { cwd: 'D:/a', name: 'a', sessions: 1, updatedAt: Date.now() },
      { cwd: 'D:/b', name: 'b', sessions: 2, updatedAt: Date.now() },
    ],
    currentCwd: 'D:/a', count: 6,
  })
  assert.match(txt, /24 小时/)
  assert.match(txt, /按钮/)
})

await t('★ 1.0.24 的硬要求：不引用、不带 / 的一句话（含数字）就是闲聊', () => {
  // ⚠️ 这一条 2026-10-07 晚**方向反了**。当天早些时候为了修「09:09 那个 2 被当成派活正文」
  //    的故障，这里断言的是"必须落到 stray_number、绝不能 chat"。主人当晚明确要求
  //    「只要我不引用信息或者信息前边不带 / 的命令就是闲聊，无论任何情况」——
  //    他选了可预测，代价（数字可能被当成一句话送进会话）由他知情承担。
  //    现在拦人的那套没了，"打错了"由 qqruntime 的一句提示兜着（见上面那条源码守卫）。
  for (const s of ['2', '派 2', '2 号项目先别动', '在吗']) {
    const r = routeMessage({ text: s, refIdx: '', hasPendingQuestion: false, refTarget: null })
    assert.equal(r.kind, 'chat', `「${s}」必须当闲聊`)
    assert.equal(r.text, s)
  }
  // 但"选名单"这条路没丢：显式指令与按钮都还在（按钮发的是 /pick、/open）。
  assert.equal(routeIncoming('/pick 2').kind, 'pick_workspace')
  assert.equal(routeIncoming('/open 2').kind, 'pick_task_session')
})

// ⚠️ 源码级守卫（行为跑不动：那几条路要真起 DSH 接口）。
//    要守的是：①三份名单都挂上了按钮；②派活第二步的"没有名单就拒绝"还在。
await t('【源码】三份名单都挂按钮；没名单就拒绝；24 小时窗口真的传进去了', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'qqruntime.js'), 'utf8')
  assert.match(src, /buildNumberButtons\('\/pick ', picked\.length\)/, '工作区名单要挂数字按钮')
  assert.match(src, /buildNumberButtons\('\/use ', picked\.length\)/, '会话名单要挂数字按钮')
  // 派活第二步：数字按钮 + 一个额外的「新对话」按钮（单独一行）。
  assert.match(src, /buildNumberButtons\('\/open ', picked\.length, \{ extra: \[makeCmdButton\('新对话', '\/new'\)\] \}\)/,
    '工作区里的会话名单要挂数字按钮和「新对话」')
  // 两处"没名单就拒绝"：工作区名单（1.0.18）、工作区会话名单（1.0.19）。
  assert.match(src, /formatWorkspacePickAck\('no-list'\)/, '没有工作区名单时要明确拒绝，不许现拉一份')
  assert.match(src, /formatTaskSessionPickAck\('no-list'\)/, '没有工作区会话名单时也要明确拒绝')
  assert.match(src, /formatTaskSessionPickAck\('no-workspace'\)/, '不知道工作区时不许猜一个目录建会话')
  // ⚠️ 必须钉住**调用形状**（第三个实参），不能只匹配常量名 —— 名字在注释里也出现过，
  //    只匹配名字的话，把窗口改回 5 分钟这条守卫还是绿的（量具骗人的老毛病）。
  //    工作区名单与"工作区里的会话名单"各要传一次（1.0.24 起这一句只用来决定"提示里说哪份名单"）。
  const windowArg = src.match(/\},\s*nowMs,\s*WORKSPACE_PICK_WINDOW_MS\s*,?\s*\)/g) ?? []
  assert.equal(windowArg.length, 2,
    '工作区名单和派活第二步的会话名单都必须把 24 小时窗口**传给** isPickerFresh（写在注释里不算）')
})

// ── [7f] 派活第二步：在工作区里挑会话 / 开新对话（1.0.19）────────────────────
// 主人 2026-10-07 的原话：「我不仅需要挑工作区，还需要在工作区里挑选会话或者新对话」。
// 以前 `/task` 是"一个工作区一个固定专属会话"，既接不上该工作区里的别的会话，
// 也没法明确地从零开一个新对话。
console.log('\n[7f] 派活第二步：工作区里挑会话 / 开新对话')

await t('`/open N` 是"选当前工作区里第 N 个会话"，`/open 0` 是新对话', () => {
  const r = routeIncoming('/open 2')
  assert.equal(r.kind, 'pick_task_session')
  assert.equal(r.index, 2)
  assert.equal(routeIncoming('/开 3').index, 3, '中文别名也要认')
  assert.equal(routeIncoming('/打开 4').index, 4)
  assert.equal(routeIncoming('/open 0').index, 0, '0 = 开一个新对话')
  assert.equal(routeIncoming('/open').kind, 'usage', '不带数字要给用法，不能瞎猜')
})

await t('`/new` 就是不挑会话、直接开新对话', () => {
  assert.equal(routeIncoming('/new').kind, 'new_task_session')
  assert.equal(routeIncoming('/新').kind, 'new_task_session')
  assert.equal(routeIncoming('/新对话').kind, 'new_task_session')
})

await t('`/open` 与 `/use` 是两回事：一个只认本工作区的名单，一个是全局最近会话', () => {
  assert.equal(routeIncoming('/use 2').kind, 'pick_session')
  assert.equal(routeIncoming('/open 2').kind, 'pick_task_session')
  assert.notEqual(routeIncoming('/use 2').kind, routeIncoming('/open 2').kind)
})

await t('★ 第二步的按钮：数字走 `/open N`，最后单独一行是「新对话」', () => {
  const kb = buildNumberButtons('/open ', 6, { extra: [makeCmdButton('新对话', '/new')] })
  assert.equal(kb.content.rows.length, 3, '6 个数字两行 + 新对话一行')
  const all = kb.content.rows.flatMap((r) => r.buttons)
  assert.equal(all.length, 7)
  all.slice(0, 6).forEach((b, i) => {
    const r = routeIncoming(b.action.data)
    assert.equal(r.kind, 'pick_task_session', `点了第 ${i + 1} 个会话必须能选它`)
    assert.equal(r.index, i + 1)
  })
  const last = all[6]
  assert.equal(last.render_data.label, '新对话')
  assert.equal(routeIncoming(last.action.data).kind, 'new_task_session', '「新对话」按钮点了必须真能开')
})

await t('加了额外一行之后，行数上限照样守得住（宁可没按钮，也不发会被拒的消息）', () => {
  const extra = [makeCmdButton('新对话', '/new')]
  assert.equal(buildNumberButtons('/open ', 25, { extra }), null, '25 个已经 5 行，再加一行就超限')
  assert.ok(buildNumberButtons('/open ', 25), '不带额外那一行时 25 个仍然可以')
  assert.equal(buildNumberButtons('/open ', 0), null, '没有数字也没有额外按钮 → 不装')
  assert.equal(buildNumberButtons('/open ', 0, { extra }), null)
  const onlyExtra = buildNumberButtons('/open ', 0, { extra: [] })
  assert.equal(onlyExtra, null, '空数组不算额外按钮')
})

await t('★ 1.0.24：第二步的名单新鲜也不吃裸数字了，`/open N` 才是选择', () => {
  const r = routeMessage({ text: '3', refIdx: '', hasPendingQuestion: false, refTarget: null })
  assert.equal(r.kind, 'chat', '裸数字一律闲聊')
  assert.equal(routeIncoming('/open 3').kind, 'pick_task_session')
  assert.equal(routeIncoming('/open 3').index, 3)
  assert.equal(routeIncoming('/open 0').index, 0, '0 也要走到那个分支（由运行时解释成"新对话"）')
  assert.equal(routeMessage({ text: '开 2', refIdx: '', refTarget: null }).kind, 'chat')
})

await t('★ 三份名单的开关现在都不起作用了（1.0.24 删掉了那条规则）', () => {
  // 以前 os 这三份名单都用裸数字，调用方只能把"后发的那份"置 true。现在它们
  // 只用来决定"提示里说哪一份名单"，路由本身不再看 —— 传 true 也必须是闲聊。
  const r = routeMessage({
    text: '2', refIdx: '', hasPendingQuestion: false, refTarget: null,
    taskSessionPickerActive: true, workspacePickerActive: true, pickerActive: true,
  })
  assert.equal(r.kind, 'chat', '三份都新鲜也不能把一句闲聊变回"选择"')
})

await t('第二步的名单文案：列出会话、标出"现在是它/上次派活用的"，并写清 0 = 新对话', () => {
  const now = Date.now()
  const txt = formatTaskSessionPickerText({
    cwd: 'D:/cyanproject/agenttool',
    name: 'agenttool',
    sessions: [
      { id: 's1', title: '修派活按钮', running: true, updatedAt: now },
      { id: 's2', title: '插件 1.0.18', running: false, updatedAt: now - 2 * 3600 * 1000 },
    ],
    currentId: 's1',
    lastUsedId: 's2',
    count: 6,
  })
  assert.match(txt, /agenttool 里的会话/)
  assert.match(txt, /1\. 修派活按钮/)
  assert.match(txt, /正在跑/)
  assert.match(txt, /现在就是它/, '要能一眼看出现在是哪个')
  assert.match(txt, /上次派活用的/, '上次那个也要标出来，省得重新找')
  assert.match(txt, /回 0 = 在这个工作区开一个新对话/)
  assert.match(txt, /再发一次 \/task/)

  // 空列表：兜底文案要给出"回 0"，不能只说"没有"。
  const empty = formatTaskSessionPickerText({ cwd: 'D:/x', name: 'x', sessions: [] })
  assert.match(empty, /回 0/)
  // 读不出来：如实说 + 让人重试，绝不假装"没有会话"。
  const bad = formatTaskSessionPickerText({ cwd: 'D:/x', listError: 'ECONNREFUSED' })
  assert.match(bad, /ECONNREFUSED/)
  assert.match(bad, /再发一次 \/task/)
})

await t('第二步的回执：六种结果各说各的，绝不含糊', () => {
  const ok = formatTaskSessionPickAck('ok', { name: 'agenttool', cwd: 'D:/a', session: '修派活按钮' })
  assert.match(ok, /派活会话已选：修派活按钮/)
  assert.match(ok, /D:\/a/)
  const fresh = formatTaskSessionPickAck('new', { name: 'agenttool', cwd: 'D:/a', session: '新会话' })
  assert.match(fresh, /已经开了个新对话/)
  assert.match(fresh, /原来那些会话都还在/, '开新的不该让人以为老的没了')
  assert.match(formatTaskSessionPickAck('gone', { index: 2, session: 'x' }), /已经不在了/)
  assert.match(formatTaskSessionPickAck('out-of-range', { index: 3, count: 2 }), /只有 2 个会话/)
  assert.match(formatTaskSessionPickAck('no-list'), /先发 \/task/)
  assert.match(formatTaskSessionPickAck('no-list'), /\/new/, '顺带告诉人可以直接开新的')
  assert.match(formatTaskSessionPickAck('no-workspace'), /先发 \/task/,
    '不知道在哪个目录时，不能猜一个目录去建会话')
  // 五句话必须互不相同 —— 混用会让人不知道该重发 /task 还是已经选好了。
  const all = [
    ok, fresh,
    formatTaskSessionPickAck('gone', { index: 1, session: 'x' }),
    formatTaskSessionPickAck('out-of-range', { index: 1, count: 2 }),
    formatTaskSessionPickAck('no-list'),
    formatTaskSessionPickAck('no-workspace'),
  ]
  assert.equal(new Set(all).size, all.length)
})

await t('★ 1.0.24：`/answer` 这条路还在（自由作答的提问靠它或引用作答）', () => {
  assert.equal(routeIncoming('/answer 用方案 B', { hasPendingQuestion: true }).kind, 'answer')
  assert.equal(routeIncoming('/answer 用方案 B', { hasPendingQuestion: true }).text, '用方案 B')
  assert.equal(routeIncoming('/answer 用方案 B').kind, 'no_question', '没人在等时说清"没有提问在等"')
  assert.match(HELP_TEXT, /\/answer/, '帮助里要留下这条路，否则没人知道怎么回答自由作答的提问')
})

await t('帮助里两条新指令都在，且都能被路由认出来', () => {
  assert.match(HELP_TEXT, /\/open 2/)
  assert.match(HELP_TEXT, /\/new/)
  assert.match(HELP_TEXT, /挑工作区里的会话|挑一个或开新对话/)
  assert.equal(routeIncoming('/open 2').kind, 'pick_task_session')
  assert.equal(routeIncoming('/new').kind, 'new_task_session')
})

await t('帮助里把 1.0.24 的新规矩写在最前面（不引用、不带 / 就是闲聊）', () => {
  assert.match(HELP_TEXT, /不引用我的消息/)
  assert.match(HELP_TEXT, /不带 \/ 开头/)
  assert.match(HELP_TEXT, /一律当闲聊/)
  assert.ok(!/我正有问题等你答的时候直接回/.test(HELP_TEXT),
    '旧文案说"直接回就是在回答它"—— 1.0.24 起这是错的')
})

// ── [7b] 引用回复路由 ──────────────────────────────────────────────────────
// 用户拍板的规则：**引用**机器人发的某条消息 → 回到那条消息对应的会话；
// **不引用** → 只是和机器人聊天，不进任何工作会话。
// 这段以前**完全没有测试**，正是「改了但没人验」的重灾区。
console.log('\n[7b] 引用回复路由（routeMessage）')

await t('不引用 → 闲聊，不进任何工作会话', () => {
  const r = routeMessage({ text: '你好呀', refIdx: '', hasPendingQuestion: false, refTarget: null })
  assert.equal(r.kind, 'chat')
  assert.equal(r.text, '你好呀')
})

await t('引用我发的通知 → 回到那条通知对应的会话', () => {
  const r = routeMessage({
    text: '继续改', refIdx: 'REFIDX_a', hasPendingQuestion: false,
    refTarget: { sessionId: 'session-abc', session: 'main', kind: 'turn-complete' },
  })
  assert.equal(r.kind, 'prompt')
  assert.equal(r.sessionId, 'session-abc')
  assert.equal(r.text, '继续改')
})

await t('引用我发的提问 → 当作那个提问的答案，并带上是哪个提问', () => {
  const r = routeMessage({
    text: '1', refIdx: 'REFIDX_q', hasPendingQuestion: true,
    refTarget: { sessionId: 'session-abc', session: 'main', kind: 'question', askId: 'ask-1' },
  })
  assert.equal(r.kind, 'answer')
  assert.equal(r.askId, 'ask-1')
})

await t('引用已结束的提问 → 明确告知，绝不把「1」当消息塞进工作会话', () => {
  const r = routeMessage({
    text: '1', refIdx: 'REFIDX_q', hasPendingQuestion: false,
    refTarget: { sessionId: 'session-abc', kind: 'question', askId: 'ask-1' },
  })
  assert.equal(r.kind, 'no_question')
})

await t('引用一条认不出来的消息 → unknown_ref（宁可问，也不乱猜会话）', () => {
  const r = routeMessage({ text: '这是啥', refIdx: 'REFIDX_x', hasPendingQuestion: false, refTarget: null })
  assert.equal(r.kind, 'unknown_ref')
})

await t('★ 不引用 + 有提问在等 → 也是闲聊（1.0.24 起不再抢消息）；回答要引用或 /answer', () => {
  // ⚠️ 方向反了：以前这里是"必须作答（防 agent 永久卡住）"。主人 2026-10-07 晚要求
  //    「不引用、不带 / 就是闲聊，无论任何情况」—— agent 卡住的风险由 qqruntime 的
  //    提示兜着（见 [7e] 那条源码守卫：提示在投递**之后**，且同一条提问只提示一次）。
  const r = routeMessage({ text: '方案A', refIdx: '', hasPendingQuestion: true, refTarget: null })
  assert.equal(r.kind, 'chat')
  assert.equal(routeMessage({
    text: '方案A', refIdx: 'REFIDX_ask', hasPendingQuestion: true,
    refTarget: { kind: 'question', askId: 'ask-9', sessionId: 's1' },
  }).kind, 'answer', '引用那条提问 → 仍然作答')
  assert.equal(routeIncoming('/answer 方案A', { hasPendingQuestion: true }).kind, 'answer')
})

await t('/task 显式指令优先级最高，压过引用', () => {
  const r = routeMessage({
    text: '/task 换个活干', refIdx: 'REFIDX_a', hasPendingQuestion: false,
    refTarget: { sessionId: 'session-abc', kind: 'turn-complete' },
  })
  assert.equal(r.kind, 'task')
})

await t('空消息一律忽略（不因为引用了就问东问西）', () => {
  assert.equal(routeMessage({ text: '   ', refIdx: 'REFIDX_a', hasPendingQuestion: false, refTarget: null }).kind, 'ignore')
})

// ── [7c] 引用索引的取与反查 ───────────────────────────────────────────────
console.log('\n[7c] 引用索引（extractRefIdx / BotState.sentRefs）')

await t('从 C2C 事件里取出 ref_msg_idx（不依赖 message_type 数字，官方改版也不会静默失效）', () => {
  assert.equal(
    extractRefIdx({ message_scene: { ext: ['ref_msg_idx=REFIDX_abc==', 'msg_idx=REFIDX_def=='] } }),
    'REFIDX_abc==',
  )
  assert.equal(extractRefIdx({ message_scene: { ext: ['msg_idx=REFIDX_def=='] } }), '')
  assert.equal(extractRefIdx({ message_scene: { ext: [] } }), '')
  assert.equal(extractRefIdx({}), '')
})

await t('发通知时登记 ref_idx，用户引用时能反查回那个会话', () => {
  const st = new BotState(path.join(tmp, 'state-refs.json'))
  st.addSentRef('REFIDX_abc==', { sessionId: 'session-abc', session: 'main', kind: 'turn-complete' })
  assert.equal(st.refTarget('REFIDX_abc==').sessionId, 'session-abc')
  assert.equal(st.refTarget('REFIDX_none=='), null)
  assert.equal(st.refTarget(''), null)
})

await t('sentRefs 有数量上限，状态文件不会无限膨胀', () => {
  const st = new BotState(path.join(tmp, 'state-refs-cap.json'))
  for (let i = 0; i < 10; i += 1) st.addSentRef(`r${i}`, { sessionId: `s${i}` }, 3)
  assert.equal(Object.keys(st.data.sentRefs).length, 3)
})

await t('老版本状态文件（没有 sentRefs 键）能平滑升级，不炸', () => {
  const p = path.join(tmp, 'state-legacy.json')
  fs.writeFileSync(p, JSON.stringify({ openId: 'o1', sessionId: null, lastSeq: 2, seen: [] }), 'utf8')
  const st = new BotState(p)
  assert.deepEqual(st.data.sentRefs, {})
  assert.equal(st.refTarget('x'), null)
})

console.log('\n[7d] 兜底路由：ref_idx 认不出时，绝不能把你的提问整条丢掉')

await t('recentTarget：刚发过通知就兜得住，并明确标记 viaFallback', () => {
  const st = new BotState(path.join(tmp, 'state-recent.json'))
  assert.equal(st.recentTarget(), null, '什么都没发过时不该有兜底')
  st.noteRecent({ sessionId: 'session-a', session: 'main', kind: 'turn-complete' })
  const tgt = st.recentTarget()
  assert.equal(tgt.sessionId, 'session-a')
  assert.equal(tgt.viaFallback, true, '必须带标记，好在日志和回复里说清楚')
})

await t('recentTarget：超过时间窗就不兜底（避免引用一条旧消息时送错会话）', () => {
  const st = new BotState(path.join(tmp, 'state-recent-old.json'))
  st.noteRecent({ sessionId: 'session-a' })
  st.data.recent[0].at = Date.now() - 10 * 60 * 1000
  assert.equal(st.recentTarget(5 * 60 * 1000), null)
})

await t('noteRecent 最新在前，且有条数上限', () => {
  const st = new BotState(path.join(tmp, 'state-recent-cap.json'))
  for (let i = 0; i < 30; i += 1) st.noteRecent({ sessionId: `s${i}` }, 5)
  assert.equal(st.data.recent.length, 5)
  assert.equal(st.data.recent[0].sessionId, 's29', '最新的必须排第一')
})

await t('state 文件里的 recent 会持久化（重启后兜底仍然有效）', () => {
  const f = path.join(tmp, 'state-recent-persist.json')
  new BotState(f).noteRecent({ sessionId: 'session-p', session: 'main' })
  assert.equal(new BotState(f).recentTarget().sessionId, 'session-p')
})

await t('真实那份老状态文件（只有 openId/sessionId/lastSeq/seen）读进来不炸且能兜底', () => {
  const f = path.join(tmp, 'state-real-legacy.json')
  fs.writeFileSync(f, JSON.stringify({
    openId: 'o', sessionId: 'session-609a29a2', lastSeq: 11, seen: ['ROBOT1.0_x'],
  }), 'utf8')
  const st = new BotState(f)
  assert.deepEqual(st.data.recent, [])
  assert.deepEqual(st.data.sentRefs, {})
  assert.equal(st.recentTarget(), null)
  st.noteRecent({ sessionId: 'session-609a29a2' })
  assert.equal(st.recentTarget().sessionId, 'session-609a29a2')
})

console.log('\n[8] 文案')
await t('完成通知说人话并带上会话名（不再是干巴巴的「任务完成」）', () => {
  const s = formatNotification({
    kind: 'turn-complete', session: 'main', project: 'agenttool', summary: '已改完',
  })
  assert.equal(s, '✅ main 跑完了\n\n已改完\n\n— agenttool')
})
await t('只有会话名、没有工作区时不补多余那行', () => {
  const s = formatNotification({ kind: 'turn-complete', session: 'main', summary: '好了' })
  assert.equal(s, '✅ main 跑完了\n\n好了')
})
await t('会话名与工作区同名时不重复显示', () => {
  const s = formatNotification({ kind: 'turn-complete', session: 'DSH', project: 'DSH' })
  assert.equal(s, '✅ DSH 跑完了')
})
await t('什么都没有时也不留空行', () => {
  const s = formatNotification({ kind: 'turn-complete' })
  assert.equal(s, '✅ 跑完了')
  assert.ok(!s.includes('\n'), '不该有任何换行')
})
await t('没有摘要但有工作区时，工作区仍然显示', () => {
  const s = formatNotification({ kind: 'turn-complete', session: 'main', project: 'agenttool' })
  assert.equal(s, '✅ main 跑完了\n\n— agenttool')
})
await t('提问通知是口语的「想问你个事」', () => {
  const s = formatNotification({ kind: 'question', session: 'main', project: 'p', summary: '选哪个' })
  assert.match(s, /^❓ main 想问你个事/)
  assert.match(s, /选哪个/)
})
await t('出错通知是口语的「出错了」', () => {
  const s = formatNotification({ kind: 'error', session: 'main', project: 'p' })
  assert.match(s, /^⚠️ main 出错了/)
})
await t('未知 kind 也不炸', () => {
  assert.match(formatNotification({ kind: 'weird' }), /weird/)
})
await t('★ 装了按钮时正文不再重复选项文字，只留编号 + 说明（1.0.26 主人要求）', () => {
  const s = formatQuestion([Q1])
  assert.match(s, /选哪个方案？/)
  assert.ok(!/方案A/.test(s), `选项名由按钮承担，正文再写一遍就是同一条信息出现两次：\n${s}`)
  assert.ok(!/方案B/.test(s))
  // 省掉的那部分必须在按钮上真的存在，而且编号与正文能对上 —— 否则就是丢信息。
  const rows = buildOptionKeyboard([Q1]).content.rows
  assert.equal(rows.length, 2, '一行一个')
  assert.equal(rows[0].buttons[0].render_data.label, '1.方案A')
  assert.equal(rows[1].buttons[0].render_data.label, '2.方案B')
  assert.match(s, /点下面的按钮/)
})

await t('★ 按钮没装上时正文一个字都不能省（多选 / 多问 / 超过 5 个选项）', () => {
  // 多问：按钮不装（一次点不完），正文里的选项名就是唯一的答案依据。
  assert.match(formatQuestion([Q1, Q2]), /1\. 方案A/)
  // 多选：同理。
  const multi = formatQuestion([{
    id: 'q', question: '要哪些？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }],
  }])
  assert.match(multi, /1\. A/)
  // 6 个选项：一行一个 ⇒ 要 6 行，超官方 5 行上限 ⇒ 整个不装按钮。
  const six = formatQuestion([{
    id: 'q', question: '选一个？', options: Array.from({ length: 6 }, (_, i) => ({ label: `选项${i + 1}` })),
  }])
  assert.match(six, /6\. 选项6/)
  assert.equal(buildOptionKeyboard([{
    id: 'q', options: Array.from({ length: 6 }, (_, i) => ({ label: `选项${i + 1}` })),
  }]), null)
})

await t('★ 选项名会被按钮切成半截、又没有说明时，正文把它补全（唯一例外）', () => {
  const long = '这一个选项名字特别长会被切'
  const s = formatQuestion([{
    id: 'q', question: '走这条？', options: [{ label: long }, { label: '短的名字' }],
  }])
  assert.match(s, new RegExp(`1\\. ${long}`), `正文必须补上会被切的那个选项名：\n${s}`)
  assert.ok(!/2\. 短的名字/.test(s), '能完整放进按钮的选项名不该再重复一遍')
  // 补全的判断依据与按钮同一个口径：按钮上放得下 8 个字，超过就补。
  assert.equal([...cleanOptionText(long)].length > optionLabelRoom(0), true)
  assert.equal([...cleanOptionText('短的名字')].length > optionLabelRoom(1), false)
})

await t('选项自带的说明也发出来（回复时更有把握）', () => {
  const s = formatQuestion([{
    id: 'q', question: '走哪条？',
    options: [{ label: 'A', description: '快但贵' }, { label: 'B' }],
  }])
  // 1.0.26：有说明 ⇒ 正文发说明（选项名在按钮上）；没说明又短 ⇒ 正文一个字都不写。
  assert.match(s, /  1\. 快但贵/)
  assert.ok(!/2\. B/.test(s), `选项名不该重复：\n${s}`)
  const rows = buildOptionKeyboard([{
    id: 'q', options: [{ label: 'A', description: '快但贵' }, { label: 'B' }],
  }]).content.rows
  assert.equal(rows[0].buttons[0].render_data.label, '1.A')
  assert.equal(rows[1].buttons[0].render_data.label, '2.B')
})

await t('标记「（推荐）」的选项：按钮上剥掉，正文那行标回来（别的字不丢）', () => {
  const s = formatQuestion([{
    id: 'q', question: '选哪个？',
    options: [{ label: 'A. 一行一个按钮（推荐）', description: '最省事' }, { label: 'B. 保持现状' }],
  }])
  assert.match(s, /1\. （推荐）最省事/)
  assert.ok(!/（推荐）.*（推荐）/.test(s))
  const rows = buildOptionKeyboard([{ id: 'q', options: [{ label: 'A. 一行一个按钮（推荐）' }, { label: 'B. 保持现状' }] }]).content.rows
  assert.deepEqual(rows.map((r) => r.buttons[0].render_data.label), ['1.一行一个按钮', '2.保持现状'])
})
await t('⚠️ 多问时问题编号与选项编号不能混：数字只留给选项', () => {
  const s = formatQuestion([Q1, Q2])
  assert.match(s, /【第 1 问】选哪个方案？/)
  assert.match(s, /【第 2 问】还有什么要补充？/)
  assert.match(s, /  1\. 方案A/)
  assert.match(s, /分 2 行/)
  assert.ok(!/^1\. /m.test(s), `问题本体不该再带 1./2. 前缀，否则和选项编号撞车：\n${s}`)
})
await t('没有选项的问题明确说"直接回答案"，不留空壳', () => {
  assert.match(formatQuestion([Q2]), /这题没有选项/)
})
await t('多选题提示可以回「1 3」', () => {
  const s = formatQuestion([{
    id: 'q', question: '要哪些？', multiSelect: true,
    options: [{ label: 'A' }, { label: 'B' }],
  }])
  assert.match(s, /可以多选/)
})
await t('questions 为空/undefined 也不炸', () => {
  assert.equal(typeof formatQuestion([]), 'string')
  assert.equal(typeof formatQuestion(undefined), 'string')
})
await t('问题渲染带会话名（口语标题）', () => {
  const s = formatQuestion([Q1], { session: 'main', project: 'agenttool' })
  assert.match(s, /^❓ main 想问你个事/)
})
await t('提问正文能单独复用：不带头部、也不带「引用这条消息」尾注', () => {
  const body = formatQuestionBody([Q1])
  assert.match(body, /选哪个方案？/)
  assert.match(body, /1\. 方案A/)
  assert.ok(!/❓/.test(body), `头部由 formatNotification 统一加，正文重复一遍就重了：\n${body}`)
  assert.ok(!/想问你个事/.test(body))
  assert.ok(!/引用这条消息/.test(body), '尾注只属于中继消息，push 兜底不该带')
})
await t('正文与完整消息共用同一套编号，不会各自漂移', () => {
  const body = formatQuestionBody([Q1, Q2])
  const full = formatQuestion([Q1, Q2])
  assert.ok(full.includes(body), '完整消息必须原样包含正文')
  assert.match(body, /【第 1 问】选哪个方案？/)
  assert.match(body, /【第 2 问】还有什么要补充？/)
})
await t('正文遇到空输入也给一句能发出去的兜底，不留空壳', () => {
  assert.match(formatQuestionBody([]), /有个问题在等你回答/)
  assert.match(formatQuestionBody(undefined), /有个问题在等你回答/)
})
await t('帮助文案说明了默认规则', () => {
  assert.match(HELP_TEXT, /直接发一句话/)
  assert.match(HELP_TEXT, /\/task/)
})

console.log('\n[9] 状态持久化与去重')
await t('写入后重新读出来还在', () => {
  const f = path.join(tmp, 'state.json')
  const a = new BotState(f)
  a.set({ openId: 'OID', sessionId: 'SID' })
  const b = new BotState(f)
  assert.equal(b.data.openId, 'OID')
  assert.equal(b.data.sessionId, 'SID')
})
await t('同一个 msg_id 第二次进来判为重复', () => {
  const f = path.join(tmp, 'seen.json')
  const s = new BotState(f)
  assert.equal(s.markSeen('M1'), false)
  assert.equal(s.markSeen('M1'), true)
  assert.equal(s.markSeen('M2'), false)
})
await t('seen 列表有上限不会无限涨', () => {
  const f = path.join(tmp, 'seen2.json')
  const s = new BotState(f)
  for (let i = 0; i < 1200; i += 1) s.markSeen(`M${i}`, 100)
  assert.ok(s.data.seen.length <= 100)
})

console.log('\n[10] DSH 本机客户端')
await t('session/prompt 的 requestId 必须放在 request 内部', async () => {
  let captured = null
  const api = new DshLocalApi({
    baseUrl: 'http://127.0.0.1:19387', authority: '127.0.0.1:19387',
    secret: FIXTURE_SECRET,
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body), headers: init.headers }
      return { status: 200, text: async () => JSON.stringify({ type: 'server-response', result: { ok: true, value: { accepted: true } } }) }
    },
  })
  await api.prompt('session-1', '干活')
  assert.equal(captured.url, 'http://127.0.0.1:19387/api/session/prompt')
  assert.equal(captured.body.method, 'session/prompt')
  const r = captured.body.payload.args.request
  assert.equal(r.sessionId, 'session-1')
  assert.equal(r.mode, 'queue')
  assert.deepEqual(r.content, [{ type: 'text', text: '干活' }])
  assert.ok(r.requestId, 'requestId 必须存在，否则 gateway/input-invalid')
  assert.equal('requestId' in captured.body.payload.args, false, 'requestId 不能放在 request 外面')
})
await t('list 用 _request，create 用 request（形参名就是 args 的 key）', async () => {
  const seen = []
  const api = new DshLocalApi({
    baseUrl: 'http://x', authority: 'a', secret: FIXTURE_SECRET,
    fetchImpl: async (url, init) => {
      seen.push(JSON.parse(init.body).payload.args)
      return { status: 200, text: async () => JSON.stringify({ result: { ok: true, value: { items: [], sessionId: 'S' } } }) }
    },
  })
  await api.rpc('session/list', { _request: {} })
  await api.createSession('D:\\tmp')
  assert.deepEqual(seen[0], { _request: {} })
  assert.deepEqual(seen[1], { request: { cwd: 'D:\\tmp' } })
})
await t('业务失败会抛出带 code 的错误', async () => {
  const api = new DshLocalApi({
    baseUrl: 'http://x', authority: 'a', secret: FIXTURE_SECRET,
    fetchImpl: async () => ({
      status: 200,
      text: async () => JSON.stringify({ result: { ok: false, error: { code: 'gateway/input-invalid', message: 'bad' } } }),
    }),
  })
  await assert.rejects(() => api.rpc('session/prompt', {}), /gateway\/input-invalid/)
})

console.log('\n[11] 杂项')
await t('logSafe 会截断并把换行压平（日志里不刷屏）', () => {
  const s = logSafe('a\nb'.repeat(500))
  assert.ok(!s.includes('\n'))
  assert.ok(s.length <= 300)
})
await t('logSafe 处理 undefined/null', () => {
  assert.equal(logSafe(undefined), '')
  assert.equal(logSafe(null), '')
})

console.log('\n[12] 通知摘要 composeChatSummary')
await t('优先用助手最终回复（那才是「做完了什么」）', () => {
  assert.equal(composeChatSummary({ userText: '帮我改个 bug', assistantText: '改好了' }, 150), '改好了')
})
await t('没有助手回复时退回用户消息', () => {
  assert.equal(composeChatSummary({ userText: '帮我改个 bug', assistantText: '' }, 150), '帮我改个 bug')
})
await t('两边都空 → 空串（调用方据此省略整段，不留空行）', () => {
  assert.equal(composeChatSummary({ userText: '', assistantText: '' }, 150), '')
})
await t('多行正文压成一行', () => {
  assert.equal(composeChatSummary({ assistantText: '第一行\n第二行\n第三行' }, 150), '第一行 第二行 第三行')
})
await t('清掉标题记号（通知里 "## " 很刺眼）', () => {
  assert.equal(composeChatSummary({ assistantText: '## 进展\n改好了' }, 150), '进展 改好了')
})
await t('清掉粗体记号', () => {
  assert.equal(composeChatSummary({ assistantText: '**重点**：改好了' }, 150), '重点：改好了')
})
await t('代码块整段去掉（通知里显示代码没意义）', () => {
  assert.equal(
    composeChatSummary({ assistantText: '看这段\n```js\nconst a = 1\n```\n就这些' }, 150),
    '看这段 就这些',
  )
})
await t('行内 code 去反引号', () => {
  assert.equal(composeChatSummary({ assistantText: '改了 `push()` 的去重键' }, 150), '改了 push() 的去重键')
})
await t('列表符号去掉但保留换行分隔', () => {
  assert.equal(composeChatSummary({ assistantText: '- 第一\n- 第二' }, 150), '第一 第二')
})
await t('链接只留文字', () => {
  assert.equal(composeChatSummary({ assistantText: '见 [官方文档](https://example.com)' }, 150), '见 官方文档')
})
await t('引用记号去掉', () => {
  assert.equal(composeChatSummary({ assistantText: '> 注意这句' }, 150), '注意这句')
})
await t('markdown 表格清理成可读文字（不留 | --- | 框线）', () => {
  const s = composeChatSummary({
    assistantText: '结果如下\n\n| 指标 | 值 |\n| --- | --- |\n| 负载 | 0.04 |\n| 内存 | 862M |',
  }, 200)
  assert.ok(!s.includes('|'), `不该残留表格竖线：${s}`)
  assert.ok(!s.includes('---'), `不该残留分隔行：${s}`)
  assert.match(s, /负载 0\.04/)
  assert.match(s, /内存 862M/)
})
await t('⚠️ 全角竖线 ｜（U+FF5C）也要清 —— 中文表格里模型常输出全角', () => {
  const s = composeChatSummary({
    assistantText: '状态如下\n｜ 指标 ｜ 值 ｜\n｜---｜---｜\n｜ 负载 ｜ 0.04 ｜\n｜ 内存 ｜ 862M ｜',
  }, 200)
  assert.ok(!s.includes('｜'), `不该残留全角竖线：${s}`)
  assert.ok(!s.includes('---'), `不该残留分隔行：${s}`)
  assert.match(s, /负载 0\.04/)
  assert.match(s, /内存 862M/)
})
await t('标题记号在行中残留时也清掉（日志文本已被压平换行）', () => {
  const s = composeChatSummary({ assistantText: '结论。 ## 进展 已完成' }, 200)
  assert.ok(!s.includes('#'), `不该残留 #：${s}`)
  assert.match(s, /进展/)
})
await t('水平分割线去掉', () => {
  assert.equal(composeChatSummary({ assistantText: '上\n\n---\n\n下' }, 150), '上 下')
})
await t('兜底：换行已被上游压平时，分隔行残留的 --- 也要清掉', () => {
  // 真实踩过的输入：agentmd 日志把换行压成了空格，分隔行就跑到了行中
  const s = composeChatSummary({
    assistantText: '服务器状态：健康 ✅ ｜ 指标 ｜ 值 ｜ ｜---｜---｜ ｜ 运行时长 ｜ 49 天 ｜',
  }, 200)
  assert.ok(!s.includes('---'), `不该残留分隔行：${s}`)
  assert.ok(!s.includes('｜'), `不该残留全角竖线：${s}`)
  assert.match(s, /运行时长 49 天/)
})
await t('不会误伤日期里的单连字符', () => {
  const s = composeChatSummary({ assistantText: '今天是 2026-10-02，跑完了' }, 150)
  assert.equal(s, '今天是 2026-10-02，跑完了')
})
await t('真实场景：报告型回复清洗后是可读的连续文字', () => {
  const s = composeChatSummary({
    assistantText: '## 体检完成\n\n**服务器全绿**，但隧道断了。\n\n- 运行时长：49 天\n- 负载：0.04\n\n```bash\nuptime\n```\n\n| 指标 | 值 |\n| --- | --- |\n| 内存 | 862M |',
  }, 200)
  assert.ok(!/[#*`|]/.test(s), `不该残留 markdown 记号：${s}`)
  assert.ok(!s.includes('---'), '不该残留分割线')
  assert.ok(!s.includes('uptime'), '代码块内容不该出现')
  assert.match(s, /体检完成/)
  assert.match(s, /服务器全绿/)
  assert.match(s, /内存 862M/)
})
await t('超长截断到指定长度并加省略号', () => {
  const s = composeChatSummary({ assistantText: '啊'.repeat(200) }, 20)
  assert.equal([...s].length, 20)
  assert.ok(s.endsWith('…'), '应以省略号结尾')
})
await t('刚好等于上限时不截断', () => {
  const s = composeChatSummary({ assistantText: '好'.repeat(20) }, 20)
  assert.equal(s, '好'.repeat(20))
  assert.ok(!s.endsWith('…'))
})
await t('maxChars 传 0 时用默认值而不是返回空', () => {
  assert.equal(composeChatSummary({ assistantText: '短的' }, 0), '短的')
})
await t('parts 为 undefined 也不炸', () => {
  assert.equal(composeChatSummary(undefined, 150), '')
})

// ── qqPreviewUrl：把链接改成「手机 QQ 里点得开」的形式 ───────────────────────
// 背景：QQ 的机器人平台会检测机器人消息里的 URL，没通过检测的会被套壳，
// 点开只剩「如需预览请使用浏览器访问」。绕过办法是**把域名整体大写**
// （koishi-plugin-qqurl-bypass 的 uppercase 模式）。主人 2026-10-02 实测可开的形式：
//   http://CYANOVO.TOP/dsh/hd882.html
await t('中枢给的链接 → 实测可开的那种形式（域名大写 + http + 默认端口）', () => {
  assert.equal(
    qqPreviewUrl('https://cyanovo.top:8444/dsh/hd882.html'),
    'http://CYANOVO.TOP/dsh/hd882.html',
  )
})
await t('⚠️ 域名必须**真的是大写** —— 专门拦 URL.hostname setter 那种静默失效写法', () => {
  // URL 规范对 http(s) 的 host 会做 domain-to-ASCII（含小写化），
  // 所以 `u.hostname = u.hostname.toUpperCase()` 赋值后再读仍是小写，等于什么都没做。
  // 这个断言存在的唯一目的就是让那种写法立刻变红，而不是安静地什么都不做。
  const out = qqPreviewUrl('https://cyanovo.top:8444/dsh/hd882.html')
  assert.match(out, /CYANOVO\.TOP/)
  assert.ok(!/cyanovo\.top/.test(out), `不该出现小写域名：${out}`)
  // 与"用 setter 写会得到什么"直接对照，钉死差异
  const u = new URL('https://cyanovo.top:8444/dsh/hd882.html')
  u.hostname = u.hostname.toUpperCase()
  assert.notEqual(u.href, out)
})
await t('路径一个字都不动（路径区分大小写，动了就是 404）', () => {
  assert.equal(
    qqPreviewUrl('https://cyanovo.top:8444/dsh/AbC-123_x.html'),
    'http://CYANOVO.TOP/dsh/AbC-123_x.html',
  )
})
await t('子域名整体大写', () => {
  assert.equal(qqPreviewUrl('https://Notes.Cyanovo.Top/dsh/x.html'), 'http://NOTES.CYANOVO.TOP/dsh/x.html')
})
await t('query / hash 保留', () => {
  assert.equal(qqPreviewUrl('https://cyanovo.top:8444/dsh/x.html?a=1#b'), 'http://CYANOVO.TOP/dsh/x.html?a=1#b')
})
await t('幂等：已经转过的链接再转一次不变', () => {
  const once = qqPreviewUrl('https://cyanovo.top:8444/dsh/hd882.html')
  assert.equal(qqPreviewUrl(once), once)
})
await t('空值/非字符串 → 空串（不炸，也不产生垃圾链接）', () => {
  for (const v of ['', '   ', null, undefined, 42, {}, []]) {
    assert.equal(qqPreviewUrl(v), '', `输入 ${JSON.stringify(v)} 应得空串`)
  }
})
await t('解析不了的字符串原样返回 —— 宁可链接没转换，也不能把推送弄丢', () => {
  assert.equal(qqPreviewUrl('not a url'), 'not a url')
  assert.equal(qqPreviewUrl('cyanovo.top/dsh/x.html'), 'cyanovo.top/dsh/x.html')
})
await t('前后空白先 trim 掉再转', () => {
  assert.equal(qqPreviewUrl('  https://cyanovo.top:8444/dsh/x.html  '), 'http://CYANOVO.TOP/dsh/x.html')
})
await t('客户端拿到的最终还是 http（不走 https:8444，那一种没实测过）', () => {
  const out = qqPreviewUrl('https://cyanovo.top:8444/dsh/x.html')
  assert.ok(out.startsWith('http://'), out)
  assert.ok(!out.includes(':8444'), out)
})

// ── 入站回执：不再复述主人自己发的那句话 ──────────────────────────────────
// 主人 2026-10-02 明确反馈：「收到开始干活的信息后边会把我的话复述一下，我不是很喜欢」。
// QQ 聊天记录里上一条就是他自己的原话，机器人再抄一遍纯属噪音。
// handlePrompt 在闭包里、对外不导出，所以这里守的是**源码字面**：
// 这条断言的唯一职责，就是让「回显」这种写法一旦被加回来立刻变红。
const qqruntimeSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'qqruntime.js'), 'utf8')
const handlePromptSrc = (() => {
  const start = qqruntimeSrc.indexOf('async function handlePrompt(')
  assert.notEqual(start, -1, 'src/qqruntime.js 里找不到 handlePrompt —— 测试已与源码脱节')
  const end = qqruntimeSrc.indexOf('\n  }', start)
  assert.notEqual(end, -1, 'handlePrompt 函数体没找到结尾 —— 测试已与源码脱节')
  return qqruntimeSrc.slice(start, end)
})()

await t('入站回执不再复述主人原话（不出现「你说的是」/ 📝 回显）', () => {
  assert.ok(!handlePromptSrc.includes('你说的是'), '回执又把主人原话抄了一遍')
  assert.ok(!handlePromptSrc.includes('📝'), '回执里不该有回显 emoji')
  assert.ok(!/\becho\b/.test(handlePromptSrc), '不该再有 echo 变量')
})

await t('入站回执保留会话名（label）—— 同时开多个会话时靠它区分送了哪个', () => {
  assert.ok(handlePromptSrc.includes('（${label}）'), `回执必须带会话名，实际：${handlePromptSrc}`)
})

await t('三种回执文案仍在（闲置 / 排队 / 插话），且都以 ✅ 开头', () => {
  assert.ok(handlePromptSrc.includes('收到，我这就开始'), '闲置文案丢了')
  assert.ok(handlePromptSrc.includes('收到，排在后面了'), '排队文案丢了')
  assert.ok(handlePromptSrc.includes('收到，已经插话给正在跑的那轮了'), '插话文案丢了')
  assert.ok(handlePromptSrc.includes('✅'), '回执应带成功标记')
})

// ── composeChatAnswer：直接回 QQ 的「闲聊回答」正文 ────────────────────────
// 主人 2026-10-02 的要求：「闲聊…思考完毕之后直接在聊天框给我回答」。
// 与 composeChatSummary 的关键差别：**换行必须保住**（摘要是压平的，回答不是）。
await t('闲聊回答保留换行 —— 绝不能像摘要那样压成一行', () => {
  const s = composeChatAnswer({ assistantText: '第一行\n第二行\n\n第四行' }, 1500)
  assert.equal(s, '第一行\n第二行\n\n第四行')
  assert.ok(s.includes('\n'), '回答里必须还有换行')
})

await t('闲聊回答保留 markdown 记号（列表 / 标题 / 代码块都原样）', () => {
  const md = '## 结论\n\n- 第一\n- 第二\n\n```js\nconst a = 1\n```'
  assert.equal(composeChatAnswer({ assistantText: md }, 1500), md)
})

await t('闲聊回答去掉笔记页脚 <sub>…</sub>（那是给网页看的，聊天框里是噪音）', () => {
  const s = composeChatAnswer({ assistantText: '正文\n\n<sub>2026-10-02 · main</sub>' }, 1500)
  assert.equal(s, '正文')
  assert.ok(!s.includes('<sub>'))
})

await t('连续空行折叠到最多 3 个（不制造大空洞，但保留段落间隔）', () => {
  const s = composeChatAnswer({ assistantText: '上\n\n\n\n\n\n下' }, 1500)
  assert.equal(s, '上\n\n\n下')
})

await t('assistantText 为空时退回 userText，两者都空则返回空串', () => {
  assert.equal(composeChatAnswer({ userText: '在吗', assistantText: '' }, 1500), '在吗')
  assert.equal(composeChatAnswer({ userText: '', assistantText: '' }, 1500), '')
  assert.equal(composeChatAnswer(undefined, 1500), '')
})

await t('超长按码点截断并加省略号（中文一字算一个）', () => {
  const s = composeChatAnswer({ assistantText: '啊'.repeat(300) }, 100)
  assert.equal([...s].length, 100)
  assert.ok(s.endsWith('…'))
})

await t('maxChars 非正数时用默认 1500，而不是返回空', () => {
  const s = composeChatAnswer({ assistantText: '啊'.repeat(1600) }, 0)
  assert.equal([...s].length, 1500)
})

// ── 闲聊会话：只读 + 回答直回 QQ（源码字面护栏）──────────────────────────
// 这条链路横跨 qqruntime（发送）与 index（路由），行为级测试代价过高，
// 所以这里守**源码字面**：任何一处被改回旧行为都会立刻变红。
const qqSrcFull = qqruntimeSrc
const indexSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'index.js'), 'utf8')

await t('qqruntime 里确实有 sendChatAnswer，且挂在 createQqRuntime 的返回值上', () => {
  assert.ok(qqSrcFull.includes('async function sendChatAnswer('), 'sendChatAnswer 没找到')
  // 它不是模块级 export，而是工厂返回对象的一个成员（index.js 通过 qq.sendChatAnswer 调用）。
  // 注意用 lastIndexOf + **行首锚点** —— 文件中间有好几个嵌套函数自己的 `return {`。
  // 2026-10-05 补：锚点必须带换行。只写 `'  return {'` 时，任意一行缩进后的 `return {}`
  // （例如某个兜底分支）都会被当成"工厂的返回对象"，护栏会假红一次 —— 量具本身骗人。
  const returnAt = qqSrcFull.lastIndexOf('\n  return {')
  assert.notEqual(returnAt, -1, '找不到 createQqRuntime 的返回对象 —— 测试已与源码脱节')
  const returned = qqSrcFull.slice(returnAt, qqSrcFull.length)
  assert.ok(returned.includes('sendChatAnswer'), `sendChatAnswer 没被返回：${returned.slice(0, 200)}`)
})

await t('回答用**纯文本**发送（markdown: false）—— 回答正文不可控，markdown 发不出去就全丢', () => {
  const start = qqSrcFull.indexOf('async function sendChatAnswer(')
  assert.notEqual(start, -1)
  const body = qqSrcFull.slice(start, start + 2600)
  assert.match(body, /markdown:\s*false/, 'sendChatAnswer 必须显式 markdown: false')
  assert.ok(body.includes('clampText'), '必须过 clampText 长度钳制')
})

await t('闲聊回答不会走「通知卡片」那条路（不产生 ref 通知、不追加链接）', () => {
  const start = qqSrcFull.indexOf('async function sendChatAnswer(')
  const body = qqSrcFull.slice(start, start + 2600)
  assert.ok(body.includes("kind: 'chat-answer'"), '回答的 ref 记录应标成 chat-answer，便于排查')
  assert.ok(!body.includes('查看完整回答'), '回答正文里不该出现链接文案')
})

await t('闲聊会话在跑之前先被切到只读权限（beforeChatPrompt 钩子）', () => {
  assert.ok(indexSrc.includes('function ensureChatReadOnly('), 'ensureChatReadOnly 没实现')
  assert.ok(indexSrc.includes('beforeChatPrompt: ensureChatReadOnly'), '钩子没接进 createQqRuntime')
  // 钩子必须在 qqruntime 里"发 prompt 之前"调用，否则本轮已经用旧权限跑完了
  assert.ok(qqSrcFull.includes('beforeChatPrompt('), 'qqruntime 里没有调用钩子')
})

await t('只读实现必须真的调用 permissionPresets.set(…, read-only)，而不是只写日志', () => {
  const start = indexSrc.indexOf('function ensureChatReadOnly(')
  assert.notEqual(start, -1)
  const body = indexSrc.slice(start, indexSrc.indexOf('\n  }', start))
  assert.ok(body.includes("'read-only'"), '没看到 read-only 这个 preset 名')
  assert.ok(/presets\.set\(/.test(body), '必须真的 set，不能只判断')
  assert.ok(body.includes('ctx.get'), '必须从 ctx 取服务，不能写死')
})

await t('闲聊回合**不做笔记上传**（回答只在聊天框里，没人点它的链接）', () => {
  const start = indexSrc.indexOf('const chatSession = agent?.id ? qq.isChatSession(')
  assert.notEqual(start, -1, '没找到闲聊回合的分支 —— 测试已与源码脱节')
  // 只取 if 分支本身 —— 后面的 else 分支里**本来就该**有 publishTurnNote
  const elseAt = indexSrc.indexOf('} else {', start)
  assert.notEqual(elseAt, -1, '没找到 if/else 分界 —— 测试已与源码脱节')
  const chatBranch = indexSrc.slice(start, elseAt)
  assert.ok(!chatBranch.includes('publishTurnNote'), '闲聊分支里不该上传笔记')
  assert.ok(chatBranch.includes('composeChatAnswer'), '闲聊分支必须用 composeChatAnswer（保住换行）')
})

await t('闲聊回合把回答交给 push，由 push 直发 QQ（不推卡片）', () => {
  assert.ok(/push\('turn-complete',[^)]*answerText/.test(indexSrc), 'push 调用没带 answerText')
  const start = indexSrc.indexOf('qq.isChatSession(quietSessionId)')
  assert.notEqual(start, -1)
  const branch = indexSrc.slice(start, start + 1400)
  assert.ok(branch.includes('qq.sendChatAnswer('), '闲聊分支没调用 sendChatAnswer')
  assert.ok(!branch.includes('pushText'), '闲聊分支不该拼通知正文')
})

await t('闲聊直回可被配置关掉（qqChatReply !== false 语义：缺省即开）', () => {
  assert.ok(indexSrc.includes('qqChatReply !== false'), '开关判定应为"缺省即开"')
  assert.ok(indexSrc.includes('qqChatAnswerChars'), '长度上限必须可配')
  assert.ok(indexSrc.includes('qqChatReadOnly'), '只读开关必须可配')
})

// ── [10] 提问中继：QQ 优先 + 桌面兜底 ─────────────────────────────────────
// 修的是 2026-10-02 报的现象：「QQ 里明明回答过了、机器人也回了 ✅，但 DSH 聊天窗口里
// 那张提问卡片一直挂着」。
// 根因在 DSH 框架侧：桌面那张卡片由 api-proxy 自己持有（pendingQuestions），
// **只有它自己的 respond()（浏览器里作答）和 abort 回调**能摘掉条目并广播
// question/resolved（源码 `packages/host/apiproxy/src/api-proxy.ts` 的 claimQuestion）。
// 插件这边 resolve 掉 ask() 只能让 agent 继续跑，**清不掉卡片**。
// 所以「两边同时等，谁先答算谁」的写法（0.7.6 及以前的 `Promise.race`）**注定留残影**：
// 哪怕插件先拿到 QQ 的答案，那张卡片也还在，还会被重连的客户端重放。
// 现在改成 QQ 优先：发得出去就先不给桌面显示卡片；只有「发不出去」或「超时没人答」
// 才把桌面提问接上来（那时卡片由桌面自己管生命周期，同样不会残留）。

/** 从源码里抠出某个函数的完整函数体（含首尾大括号），用于在受控环境里真跑。 */
function extractFunction(src, header) {
  const start = src.indexOf(header)
  assert.notEqual(start, -1, `找不到 ${header} —— 测试已与源码脱节`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`${header} 的函数体没闭合`)
}

const relaySrc = extractFunction(qqruntimeSrc, 'function relayAsk(request, original) {')

/** 把 relayAsk 放进受控环境跑：日志 / pendingAsks / askViaQq / 兜底时长全部由测试注入。 */
function makeRelay({ fallbackMs = 20, pendingAsks = new Map(), askViaQq }) {
  const logs = []
  const build = new Function(
    'l', 'pendingAsks', 'askViaQq', 'ASK_DESKTOP_FALLBACK_MS',
    `${relaySrc}\nreturn relayAsk`,
  )
  return { relay: build((m) => logs.push(String(m)), pendingAsks, askViaQq, fallbackMs), logs, pendingAsks }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ⚠️ 源码里的兜底闹钟是 **unref** 的（不许吊住 DSH 进程）。所以在测试里等它时必须
// 自己留一个 ref 的定时器保活 —— 否则 Node 发现事件循环空了，会直接以
// "unsettled top-level await" 退出，看起来像测试挂死。
const keepAlive = () => setTimeout(() => {}, 300)

await t('提问中继不许再用 Promise.race —— 那正是「卡片一直挂着」的根因写法', () => {
  const at = qqruntimeSrc.indexOf('svc.ask = (request) =>')
  assert.notEqual(at, -1, '找不到 svc.ask 的包装点 —— 测试已与源码脱节')
  // 只看**包装体本身**：文件里别处（注释里）提到 Promise.race 是说明文字，不该被误判。
  const wrapped = qqruntimeSrc.slice(at, qqruntimeSrc.indexOf('svc.__dshQqWrapped = true', at))
  assert.ok(!wrapped.includes('Promise.race'),
    '包装体里又出现 Promise.race 了：QQ 先答时桌面卡片永远清不掉')
  assert.ok(wrapped.includes('return relayAsk(request, original)'),
    'svc.ask 必须走 relayAsk（QQ 优先 + 桌面兜底）')
})

await t('askViaQq 的每条出路都要回报「发出去没有」，否则会白等一整个兜底窗口', () => {
  const start = qqruntimeSrc.indexOf('function askViaQq(')
  assert.notEqual(start, -1, '测试已与源码脱节')
  const body = qqruntimeSrc.slice(start, start + 4000)
  // ① 没有 questions、② 没连上、③ 没有 open_id、④ 发送抛异常 —— 漏掉任何一条，
  //    relayAsk 就会以为「发出去了」而傻等兜底时间，主人那边表现为提问迟迟不出现。
  const falseCount = (body.match(/delivered\(false/g) ?? []).length
  assert.ok(falseCount >= 4, `delivered(false) 出口只有 ${falseCount} 个，最少要 4 个`)
  assert.ok(body.includes('delivered(true, askId)'), '发送成功后必须回报 delivered(true)')
  assert.ok(/ASK_DESKTOP_FALLBACK_MS/.test(relaySrc) && /ASK_DESKTOP_FALLBACK_MS\s*=\s*\d+\s*\*\s*1000/.test(qqruntimeSrc),
    '兜底时长要是模块级常量（可读、可测）')
  assert.ok(relaySrc.includes('fallbackTimer.unref()'), '兜底闹钟必须 unref，否则会把进程吊着不退出')
})

await t('QQ 答完必须撤掉兜底闹钟（否则兜底时间一到，桌面冒出一张永远等不到答案的卡片）', () => {
  assert.ok(relaySrc.includes('clearTimeout(fallbackTimer)'),
    'viaQq 兑现后必须 clearTimeout —— 这是残影的第二条来源')
  assert.ok(/if \(settled \|\| desktop\) return/.test(relaySrc),
    'showDesktop 必须同时挡住「QQ 已答完」与「桌面已接管」两种情况')
})

await t('【行为】QQ 发得出去且主人答了 → 桌面提问**一次都不会出现**（且闹钟已撤）', async () => {
  let desktopCalls = 0
  const answer = { answers: [{ id: 'q1', selected: ['A'] }] }
  const { relay } = makeRelay({
    fallbackMs: 20,
    askViaQq: (request, hooks) => {
      hooks.onDelivered(true, 'ask-1')
      return Promise.resolve(answer) // 主人在 QQ 里作答
    },
  })
  const got = await relay({ questions: [{ id: 'q1' }] }, () => {
    desktopCalls += 1
    return Promise.resolve({ answers: [{ id: 'q1', selected: ['B'] }] })
  })
  assert.deepEqual(got, answer, 'agent 必须拿到 QQ 里的答案')
  await sleep(50) // 跨过兜底时刻
  assert.equal(desktopCalls, 0, '正常路径下调用桌面提问 = 聊天窗口里留一张清不掉的卡片')
})

await t('【行为】QQ 发不出去 → 立刻回到桌面提问，不等兜底窗口', async () => {
  let desktopCalls = 0
  const t0 = Date.now()
  const { relay, logs } = makeRelay({
    fallbackMs: 60_000, // 故意设长：回落只能由「发不出去」触发，不能靠超时
    askViaQq: (request, hooks) => { hooks.onDelivered(false, 'ask-2'); return new Promise(() => {}) },
  })
  const got = await relay({ questions: [{ id: 'q1' }] }, () => {
    desktopCalls += 1
    return Promise.resolve('desktop')
  })
  assert.equal(got, 'desktop')
  assert.equal(desktopCalls, 1, '发不出去时必须把桌面提问接上来，否则 agent 永远等不到回答')
  assert.ok(Date.now() - t0 < 3000, `不该等 60 秒：实测 ${Date.now() - t0}ms`)
  assert.ok(logs.some((m) => m.includes('没能把问题发到 QQ')), `日志要说明为什么回落：${logs.join('｜')}`)
})

await t('【行为】QQ 发得出去但没人答 → 过了兜底窗口桌面才出现，答完清掉 QQ 条目', async () => {
  const pendingAsks = new Map()
  let desktopCalls = 0
  let seenFlag = null
  const { relay } = makeRelay({
    fallbackMs: 20,
    pendingAsks,
    askViaQq: (request, hooks) => {
      pendingAsks.set('ask-3', { questions: request.questions, createdAt: Date.now() })
      hooks.onDelivered(true, 'ask-3')
      return new Promise(() => {}) // QQ 那边一直没人答
    },
  })
  const ka = keepAlive()
  const pending = relay({ questions: [{ id: 'q1' }] }, () => {
    desktopCalls += 1
    seenFlag = pendingAsks.get('ask-3')?.desktopShown
    return Promise.resolve('desktop')
  })
  await sleep(5)
  assert.equal(desktopCalls, 0, '兜底窗口内不许抢先显示卡片')
  assert.equal(await pending, 'desktop')
  clearTimeout(ka)
  assert.equal(desktopCalls, 1)
  assert.equal(seenFlag, true, '要打上 desktopShown，QQ 那边才能提醒主人这张卡片已经过期')
  assert.equal(pendingAsks.size, 0, '桌面答完后 QQ 条目必须删掉，否则 30 分钟后会误配到别的回复上')
})

await t('【行为】QQ 答得晚（桌面卡片已出现）→ 答案照样算数，不会把 agent 吊死', async () => {
  const pendingAsks = new Map()
  let desktopCalls = 0
  let release = null
  const { relay } = makeRelay({
    fallbackMs: 10,
    pendingAsks,
    askViaQq: (request, hooks) => {
      pendingAsks.set('ask-4', { questions: request.questions, createdAt: Date.now() })
      hooks.onDelivered(true, 'ask-4')
      return new Promise((resolve) => { release = resolve })
    },
  })
  const ka = keepAlive()
  const pending = relay({ questions: [] }, () => {
    desktopCalls += 1
    return new Promise(() => {}) // 桌面那张卡片出现了，但主人没在 DSH 里点
  })
  await sleep(30)
  assert.equal(desktopCalls, 1, '过了兜底窗口，桌面卡片应该已经出现')
  release('qq-answer')
  assert.equal(await pending, 'qq-answer', 'QQ 的答案必须仍然算数（主人答了却不算，比卡片残留更糟）')
  clearTimeout(ka)
})

await t('【行为】主人改在 DSH 里取消 → 外层 reject，且 QQ 条目被清掉', async () => {
  const pendingAsks = new Map()
  let desktopCalls = 0
  const { relay } = makeRelay({
    fallbackMs: 10,
    pendingAsks,
    askViaQq: (request, hooks) => {
      pendingAsks.set('ask-5', { questions: request.questions, createdAt: Date.now() })
      hooks.onDelivered(true, 'ask-5')
      return new Promise(() => {})
    },
  })
  const ka = keepAlive()
  const pending = relay({ questions: [] }, () => {
    desktopCalls += 1
    return Promise.reject(new Error('cancelled'))
  })
  await assert.rejects(pending, /cancelled/)
  clearTimeout(ka)
  assert.equal(desktopCalls, 1)
  assert.equal(pendingAsks.size, 0, '取消也要清条目，不能让它在 pendingAsks 里躺 30 分钟')
})

await t('QQ 作答回执：卡片已过期时补一句提示，正常路径不加噪音', () => {
  const start = qqruntimeSrc.indexOf('async function handleAnswer(')
  assert.notEqual(start, -1, '测试已与源码脱节')
  const end = qqruntimeSrc.indexOf('\n  }', start)
  const body = qqruntimeSrc.slice(start, end)
  assert.ok(body.includes('item.desktopShown'), '回执必须按 desktopShown 分两种说法')
  assert.ok(body.includes('收到，已经把你的回答带过去了'), '回答回执文案丢了')
})

// ── [11] 影子 signal：QQ 答完，让 **DSH 自己**把那张卡片收掉 ─────────────────
// 背景（2026-10-03 主人报的「QQ 里答完，DSH 那张提问卡片还挂着」）：
// 卡片条目在 api-proxy 自己的 pendingQuestions 里，插件换不掉那个 provider、也没有 settle API。
// 唯一能借的开关是 `request.signal`：UserQuestionService.ask() 把 request 原样透传给 provider
// （packages/interaction/user-questions/src/index.ts:139），api-proxy 会记下 request.signal
// 并挂 abort 监听（api-proxy.ts:1380/1382-1389）；一旦 abort，它就 claimQuestion(pending,'cancelled')
// —— 删条目 + 广播 `question/resolved`，卡片在所有客户端上消失，新连上的也不会被 mux 重放。
// 所以 relayAsk 造了一个**影子 signal**：只在真把卡片递到桌面时替代 request.signal，
// QQ 那边答完就 abort 它。两条边界必须同时成立：
//   ① 只能中止影子 signal —— 调用方那个 signal 不是插件的，动它就是越权；
//   ② 外层 signal 必须继续转发到影子上 —— 否则这轮 turn 被取消时卡片再也摘不掉。

await t('【行为】兜底卡片已出现、随后在 QQ 里作答 → 影子 signal 被中止（DSH 才会自己收掉卡片）', async () => {
  const outer = new AbortController()
  let cardSignal = null
  let release = null
  const { relay } = makeRelay({
    fallbackMs: 10,
    askViaQq: (request, hooks) => {
      hooks.onDelivered(true, 'ask-6')
      return new Promise((resolve) => { release = resolve }) // QQ 那边先晾着
    },
  })
  const ka = keepAlive()
  const pending = relay({ questions: [], signal: outer.signal }, (req) => {
    cardSignal = req.signal
    return new Promise(() => {}) // 卡片出现了，但主人没在 DSH 里点
  })
  await sleep(30)
  assert.ok(cardSignal, '过了兜底窗口，桌面卡片应该已经出现')
  assert.notEqual(cardSignal, outer.signal,
    '必须递影子 signal 的副本；把调用方的 signal 交出去，abort 就成了越权')
  assert.equal(cardSignal.aborted, false, 'QQ 还没答，卡片不该被中止')
  release('qq-answer')
  assert.equal(await pending, 'qq-answer', 'QQ 的答案必须算数')
  clearTimeout(ka)
  assert.equal(cardSignal.aborted, true,
    'QQ 答完必须中止影子 signal —— 那正是命令 DSH 自己收掉卡片的开关')
  assert.equal(outer.signal.aborted, false, '外层 signal 属于调用方，插件无权中止它')
})

await t('【行为】正常路径（卡片从未出现）→ 任何 signal 都不会被中止', async () => {
  const outer = new AbortController()
  let desktopCalls = 0
  const { relay } = makeRelay({
    fallbackMs: 10,
    askViaQq: (request, hooks) => { hooks.onDelivered(true, 'ask-7'); return Promise.resolve('qq-answer') },
  })
  const got = await relay({ questions: [], signal: outer.signal }, () => {
    desktopCalls += 1
    return Promise.resolve('desktop')
  })
  await sleep(30)
  assert.equal(got, 'qq-answer')
  assert.equal(desktopCalls, 0, '正常路径不该创建桌面 pending 记录（0.7.7 起的老性质，不能丢）')
  assert.equal(outer.signal.aborted, false, '没有卡片可收，就不该动任何 signal')
})

await t('【行为】发不出去、改为桌面提问 → 递进桌面的同样不是调用方的 signal', async () => {
  const outer = new AbortController()
  let cardSignal = null
  const { relay } = makeRelay({
    fallbackMs: 60_000,
    askViaQq: (request, hooks) => { hooks.onDelivered(false, 'ask-8'); return new Promise(() => {}) },
  })
  const got = await relay({ questions: [], signal: outer.signal }, (req) => {
    cardSignal = req.signal
    return Promise.resolve('desktop')
  })
  assert.equal(got, 'desktop')
  assert.ok(cardSignal, '发不出去时必须走桌面')
  assert.notEqual(cardSignal, outer.signal, '这条路径同样不能把调用方的 signal 交出去')
  assert.equal(outer.signal.aborted, false)
})

await t('【行为】这一轮 turn 被取消 → 影子 signal 跟着中止（否则卡片再也摘不掉）', async () => {
  const outer = new AbortController()
  let cardSignal = null
  const { relay } = makeRelay({
    fallbackMs: 10,
    askViaQq: (request, hooks) => { hooks.onDelivered(true, 'ask-9'); return new Promise(() => {}) },
  })
  const ka = keepAlive()
  relay({ questions: [], signal: outer.signal }, (req) => {
    cardSignal = req.signal
    return new Promise(() => {}) // 卡片挂着，谁也没答
  })
  await sleep(30)
  assert.ok(cardSignal, '卡片应已出现')
  assert.equal(cardSignal.aborted, false)
  outer.abort() // 等价于这一轮 turn 被取消
  await sleep(5)
  clearTimeout(ka)
  assert.equal(cardSignal.aborted, true,
    '外层中止必须转发到影子 signal，否则 turn 取消了卡片还挂在屏幕上')
})

await t('【行为】中止影子 signal ⇒ 桌面那条以 ASK_ABORTED 落定，但 QQ 的答案仍然赢且不产生 unhandledRejection', async () => {
  const rejections = []
  const onUnhandled = (err) => rejections.push(err)
  process.on('unhandledRejection', onUnhandled)
  try {
    let desktopErr = null
    let release = null
    const { relay } = makeRelay({
      fallbackMs: 10,
      askViaQq: (request, hooks) => {
        hooks.onDelivered(true, 'ask-10')
        return new Promise((resolve) => { release = resolve })
      },
    })
    const ka = keepAlive()
    const pending = relay({ questions: [] }, (req) => new Promise((_res, rej) => {
      // 复刻 api-proxy 的失败模式：signal 一 abort 就 reject ASK_ABORTED
      req.signal.addEventListener('abort', () => {
        const e = new Error('ask_user_question was aborted before the user answered')
        e.code = 'ASK_ABORTED'
        desktopErr = e
        rej(e)
      }, { once: true })
    }))
    await sleep(30)
    release('qq-answer')
    assert.equal(await pending, 'qq-answer', 'QQ 的答案必须赢（Promise 只认第一次落定）')
    await sleep(20)
    clearTimeout(ka)
    assert.equal(desktopErr?.code, 'ASK_ABORTED', '影子 signal 中止时，桌面那条应以 ASK_ABORTED 落定')
    assert.equal(rejections.length, 0,
      `不许出现 unhandledRejection：${rejections.map(String).join('｜')}`)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

await t('影子 signal 的两条铁律：只中止它自己、且落定后摘掉外层监听（源码级）', () => {
  const hideBody = extractFunction(relaySrc, 'function hideDesktopCard() {')
  assert.ok(hideBody.includes('shadow.abort()'), 'hideDesktopCard 必须中止影子 signal')
  assert.ok(!hideBody.includes('request.signal') && !/outer\.abort\(/.test(hideBody),
    '绝不能去中止调用方（外层）的 signal —— 那是越权')
  assert.ok(relaySrc.includes("outer.addEventListener('abort'"),
    '外层 signal 必须转发到影子 signal 上')
  assert.ok(!/request\??\.signal\??\.abort\(/.test(relaySrc),
    '整个 relayAsk 里都不许直接中止 request.signal')
  assert.ok(relaySrc.includes('removeEventListener'),
    '落定后必须摘掉外层监听，别长期握着一个已经结束的提问的 signal')
  assert.ok(relaySrc.includes('if (outer.aborted) onOuterAbort()'),
    '进来时外层就已经中止的话，影子必须同样是中止态，否则会挂出一张没人管的卡片')
})

// ── [12] 提问「等太久」与「被取消」：条目必须跟提问同生共死（2026-10-05 主人报的 bug）──
//
// 现场时间线（全部来自 `~/.dsh/qq-bot-state.json` 与两次会话快照，不是推测）：
//   23:51:38  提问发到 QQ（askId=ask-…-j65zsj，会话 session-edc80d93…）
//   00:21:38  30 分钟 TTL 到期，条目**静默**作废（当时日志里一个字都没有）
//   00:45:13  主人引用那条提问作答 → 路由查不到待答提问 → 回一句「这会儿没有等你回答的问题」
//             → 他的回答被丢掉，而 agent 那边还卡在这个提问上等
//
// 所以这里钉两件事：①「等 54 分钟才答」必须仍然算数；②提问结束（turn 被取消）时
// 条目必须立刻摘掉，别留下来把之后某条消息误当成它的答案。

const askTtlMs = (() => {
  const m = /const ASK_TTL_MS = ([^\n]+)/.exec(qqruntimeSrc)
  assert.ok(m, '找不到 ASK_TTL_MS —— 测试已与源码脱节')
  return new Function(`return ${m[1]}`)()
})()

await t('提问的等待上限必须是「人话尺度」：30 分钟那种会把正常作息判成没回答', () => {
  assert.ok(askTtlMs >= 6 * 60 * 60 * 1000,
    `ASK_TTL_MS 只有 ${Math.round(askTtlMs / 60000)} 分钟：主人出门/睡一觉回来再答就不算数了`)
})

/** 在受控环境里跑真的 `oldestPending()`：pendingAsks / TTL / 日志全部由测试注入。 */
function makeOldestPending(pendingAsks, ttlMs = askTtlMs) {
  const src = extractFunction(qqruntimeSrc, 'function oldestPending() {')
  const fmtSrc = extractFunction(qqruntimeSrc, 'function fmtDuration(ms) {')
  const fmtDuration = new Function(`return ${fmtSrc}`)()
  const logs = []
  const fn = new Function('l', 'pendingAsks', 'ASK_TTL_MS', 'fmtDuration', `${src}\nreturn oldestPending`)
  return { fn: fn((m) => logs.push(String(m)), pendingAsks, ttlMs, fmtDuration), logs }
}

await t('【行为】等了 54 分钟还没人答的提问**仍然算数**（就是现场那条时间线的长度）', () => {
  const pendingAsks = new Map()
  pendingAsks.set('ask-old', {
    questions: [{ id: 'q1' }], createdAt: Date.now() - 54 * 60 * 1000, resolve: () => {},
  })
  const { fn, logs } = makeOldestPending(pendingAsks)
  const hit = fn()
  assert.ok(hit, '54 分钟前发出的提问被作废了 —— 主人这时作答又会被判成「没有在等你回答的问题」')
  assert.equal(hit.askId, 'ask-old')
  assert.equal(pendingAsks.size, 1, '没超上限就不该删条目')
  assert.equal(logs.length, 0, '没作废就不该打「已作废」日志')
})

await t('【行为】超过上限的陈年提问照样要让位，而且必须留日志', () => {
  const pendingAsks = new Map()
  pendingAsks.set('ask-stale', {
    questions: [], createdAt: Date.now() - askTtlMs - 60 * 1000, resolve: () => {},
  })
  const { fn, logs } = makeOldestPending(pendingAsks)
  assert.equal(fn(), null, '超过上限的条目必须让位，否则它会永远吞掉后续消息')
  assert.equal(pendingAsks.size, 0)
  assert.ok(logs.some((m) => m.includes('ask-stale') && m.includes('作废')),
    `作废必须留痕（这次故障最难查的就是"静默消失"），实际日志：${logs.join('｜')}`)
})

// 🔴 反向校验：把口径换回 30 分钟，上一条「54 分钟仍算数」的行为必须变红。
// 这条测的是**量具本身**——如果这里也拿到条目，说明 makeOldestPending 根本没在测 TTL。
await t('【反向】口径换回 30 分钟，54 分钟那条就必须被判死（证明上面测的是真行为）', () => {
  const pendingAsks = new Map()
  pendingAsks.set('ask-old', {
    questions: [], createdAt: Date.now() - 54 * 60 * 1000, resolve: () => {},
  })
  const { fn } = makeOldestPending(pendingAsks, 30 * 60 * 1000)
  assert.equal(fn(), null, '30 分钟口径下这条提问应当被摘掉 —— 拿到条目说明测试环境是假的')
})

await t('【行为】turn 被取消 → QQ 那条待答条目必须跟着摘掉（且不再弹桌面卡片）', async () => {
  const outer = new AbortController()
  const pendingAsks = new Map()
  let desktopCalls = 0
  let release = null
  const { relay, logs } = makeRelay({
    fallbackMs: 10,
    pendingAsks,
    askViaQq: (request, hooks) => {
      pendingAsks.set('ask-cancel', {
        questions: request.questions, createdAt: Date.now(), resolve: () => {},
      })
      hooks.onDelivered(true, 'ask-cancel')
      return new Promise((resolve) => { release = resolve }) // QQ 那边还没答
    },
  })
  const ka = keepAlive()
  void relay({ questions: [], signal: outer.signal }, () => {
    desktopCalls += 1
    return new Promise(() => {})
  })
  await sleep(5)
  assert.equal(pendingAsks.size, 1, '刚发到 QQ，条目应该在里面')
  outer.abort() // 等价于这一轮 turn 被取消
  await sleep(30) // 跨过兜底窗口
  clearTimeout(ka)
  assert.equal(pendingAsks.size, 0,
    'turn 都取消了条目还留着 = 几小时后主人回一句会被错当成「它的答案」')
  assert.ok(logs.some((m) => m.includes('ask-cancel')), `摘条目要留日志，实际：${logs.join('｜')}`)
  assert.equal(desktopCalls, 0, '提问已经作废，兜底闹钟不许再把卡片弹到桌面上')
  release('late-answer') // 别留下悬着的 Promise
})

await t('【行为】signal 进来时就已中止 → 一个字都不发到 QQ，且立刻以 ASK_ABORTED 落定', async () => {
  const outer = new AbortController()
  outer.abort()
  let asked = 0
  const { relay } = makeRelay({
    fallbackMs: 5,
    askViaQq: () => { asked += 1; return new Promise(() => {}) },
  })
  let rejected = null
  await relay({ questions: [], signal: outer.signal }, () => Promise.resolve('desktop'))
    .catch((err) => { rejected = err })
  await sleep(20)
  assert.equal(asked, 0, '这轮提问早就作废了，不该再往 QQ 发一条没人等的提问')
  assert.equal(rejected?.code, 'ASK_ABORTED',
    '早中止的提问必须立刻落定（api-proxy 在同样情况下也是 ASK_ABORTED），不能把 caller 吊住')
})

await t('提问取消时摘条目的接线（源码级）：cancelAsk 必须挂在 request.signal 的中止监听上', () => {
  assert.ok(relaySrc.includes('pendingAsks.delete(askIdInFlight)'),
    'turn 取消时必须把 QQ 的待答条目摘掉（askIdInFlight 就是那条线的 askId）')
  assert.ok(/onOuterAbort = \(\) => cancelAsk\(/.test(relaySrc),
    '外层 signal 的中止监听必须接到 cancelAsk 上')
  assert.ok(relaySrc.includes('if (askId) askIdInFlight = askId'),
    'onDelivered 里必须记下 askId，否则 cancelAsk 无从下手')
})

await t('作答时提问已经结束 → 必须说清「提问结束了 / 你这句没送进去」', () => {
  // ⚠️ 不能直接扫全文里有没有那句话：**注释里也引用了旧文案**（就是为了说明它被换掉了），
  //    那样会把说明文字当成代码判红 —— 这个项目已经在"正则扫源码"上栽过好几次。
  //    所以只看真的会被发出去的那一行：`replyPassive(data, '这会儿没有…')`。
  const stillAnsweredWith = qqruntimeSrc
    .split('\n')
    .filter((line) => line.includes('replyPassive') && line.includes('这会儿没有'))
  assert.equal(stillAnsweredWith.length, 0,
    `旧文案还在往外发（主人明明刚回答了，却被告知没有提问在等）：${stillAnsweredWith.join('｜')}`)
  // 反向校验：把旧写法塞回一份假源码，这个"检查器"必须认出来 —— 否则上面那条等于没测。
  const fakeSrc = "await replyPassive(data, '这会儿没有在等你回答的问题～')\n"
  assert.equal(
    fakeSrc.split('\n').filter((line) => line.includes('replyPassive') && line.includes('这会儿没有')).length,
    1, '检查器本身失效了：旧写法放回去它也认不出来',
  )
  assert.ok(qqruntimeSrc.includes('你刚发的这句我没送进去'),
    '必须明确告诉他这句话没被送进去，并给出下一步（引用别的通知 / /task）')
})

// ── [13] 引用「机器人自己的回执 / 旧消息」不能再把主人的话丢掉 ────────────────
//
// 2026-10-05 主人报的 bug：QQ 里引用一条消息发过去，DSH 侧明明在跑（上一句进去了），
// 机器人却回「你引用的这条我认不出是哪次通知了」—— 而且**他这句话哪儿都没进去**。
// 取证（~/.dsh/qq-bot-state.json + 解压 session-edc80d93 的转录）：
//   02:28:25 收到 2 条 QQ 消息，只有 1 条进了会话（user/message 里有），另一条在
//   `user/message` 与 `agent/inbox/spliced` 里**都没有**；02:31 又丢了 2 条。
// 根因三条：①回执（✅ 收到/❌）从来不登记 ref_idx → 引用回执必然反查落空；
//          ②兜底只看 recent[] 且窗口只有 5 分钟（当时最近一条通知是 02:24:00，
//            到 02:31 早过窗了）；
//          ③两路落空就回一句「认不出」并**把消息整条丢掉**。
// 下面这几条分别钉住这三处，任何一处回退都会变红。

console.log('\n[13] 引用回执／旧消息：认不出会话也不能把主人的话丢掉（2026-10-05 报的 bug）')

// ⚠️ 这里**故意不用顶层 extractFunction**：万一函数被删掉（= 修复被回退），顶层断言会
//    让整个测试文件当场崩掉 —— 那样只会看到一句 AssertionError，看不到"哪几条行为红了"。
//    改成把源码抠取放进每条测试里失败，反向校验时才能拿到清清楚楚的红色。
//    只按函数头找（不写全参数表）：1.0.17 给它加过一个 buttons 参数，
//    守卫应该盯"函数还在不在"，而不是盯参数表 —— 参数一改就红属于假报警。
let replyPassiveSrc = ''
try { replyPassiveSrc = extractFunction(qqruntimeSrc, 'async function replyPassive(') } catch { replyPassiveSrc = '' }

/** 把 replyPassive 放进受控环境跑：日志 / bot / state 全由测试注入。 */
function makeReplyPassive({ bot, state, logs = [] }) {
  assert.notEqual(replyPassiveSrc, '',
    '源码里找不到 replyPassive 函数 —— 回执登记的修复被回退了？')
  const build = new Function('l', 'bot', 'state', `${replyPassiveSrc}\nreturn replyPassive`)
  return { replyPassive: build((m) => logs.push(String(m)), bot, state), logs }
}

const ackData = (id = 'M-ack-1') => ({ id, author: { user_openid: 'openid-a' } })

await t('【行为】回执也要登记 ref_idx —— 主人引用那句「✅ 收到」时必须认得出会话', async () => {
  const st = new BotState(path.join(tmp, 'state-ack.json'))
  const sent = []
  const bot = {
    sendC2C: async (openId, text, opts) => {
      sent.push({ openId, text, opts })
      return { id: 'S1', ext_info: { ref_idx: 'REFIDX_ACK_1' } }
    },
  }
  const { replyPassive } = makeReplyPassive({ bot, state: st })
  const res = await replyPassive(ackData(), '✅ 收到，我这就开始（插件）', { sessionId: 'session-x', session: '插件' })
  assert.equal(res?.ext_info?.ref_idx, 'REFIDX_ACK_1', '要把发送响应交回去（调用方可能还要用）')
  assert.equal(sent[0].opts.msgId, 'M-ack-1', '回执必须走被动回复（带 msg_id）')

  const tgt = st.refTarget('REFIDX_ACK_1')
  assert.equal(tgt?.sessionId, 'session-x', '回执没登记 ref_idx ⇒ 引用这句回执永远认不出会话')
  assert.equal(tgt?.session, '插件', '会话名也要记，回复文案才说得出进的是哪个会话')
  assert.equal(tgt?.kind, 'ack')

  // 端到端：拿这个 ref_idx 去路由，必须回到同一个会话 —— 而不是掉进 unknown_ref
  const route = routeMessage({
    text: '接着说一句', refIdx: 'REFIDX_ACK_1', hasPendingQuestion: false, refTarget: st.refTarget('REFIDX_ACK_1'),
  })
  assert.equal(route.kind, 'prompt', `引用回执必须回到会话，实际路由成 ${route.kind}`)
  assert.equal(route.sessionId, 'session-x')
})

await t('【行为】不知道属于哪个会话时**不许**瞎登记（否则引用它会被送错地方）', async () => {
  const st = new BotState(path.join(tmp, 'state-ack-2.json'))
  const bot = { sendC2C: async () => ({ id: 'S2', ext_info: { ref_idx: 'REFIDX_ACK_2' } }) }
  const { replyPassive } = makeReplyPassive({ bot, state: st })
  await replyPassive(ackData('M-ack-2'), '这条指令 /x 我不认识，发 /help 看看我会些什么')
  assert.deepEqual(st.data.sentRefs, {}, '没给 target 就不该登记（/help、/status 这些不属于任何会话）')
  assert.equal(st.refTarget('REFIDX_ACK_2'), null)
})

await t('【行为】被动回复发送失败：记日志、返回 null、绝不登记', async () => {
  const st = new BotState(path.join(tmp, 'state-ack-3.json'))
  const bot = { sendC2C: async () => { const e = new Error('发送单聊消息失败 code=22009: 回复次数超限'); e.code = 22009; throw e } }
  const { replyPassive, logs } = makeReplyPassive({ bot, state: st })
  const res = await replyPassive(ackData('M-ack-3'), '✅ 收到', { sessionId: 'session-x', session: '插件' })
  assert.equal(res, null, '发失败就该老实回 null，不能假装发出去了')
  assert.deepEqual(st.data.sentRefs, {}, '没发出去的东西不许登记')
  assert.ok(logs.some((m) => m.includes('被动回复失败')), `失败要留日志，实际：${logs.join('｜')}`)
})

await t('【行为】兜底要认得 sentRefs 里的记录，窗口也不止 5 分钟（40 分钟前那条仍兜得住）', () => {
  const st = new BotState(path.join(tmp, 'state-fb-sentrefs.json'))
  st.addSentRef('REFIDX_ACK_OLD', { sessionId: 'session-ack', session: '插件', kind: 'ack' })
  st.data.sentRefs.REFIDX_ACK_OLD.at = Date.now() - 40 * 60 * 1000
  assert.deepEqual(st.data.recent, [], '这条记录只在 sentRefs 里（回执不进最近通知表）')

  const tgt = st.recentTarget()
  assert.equal(tgt?.sessionId, 'session-ack',
    '精确反查落空时连 sentRefs 都不看 = 引用回执必丢（老实现就是这样）')
  assert.equal(tgt.viaFallback, true)
  assert.ok(tgt.ageMs >= 39 * 60 * 1000, `ageMs 要如实报出多久之前，好在回复里说清楚（实际 ${tgt.ageMs}）`)
})

// 🔴 反向校验：窗口换回 5 分钟，上面那条「40 分钟仍兜得住」必须变红 ——
// 否则说明测的不是窗口，只是碰巧有别的路径兜住了。
await t('【反向】窗口换回 5 分钟，40 分钟前那条就必须兜不住（证明上面测的是窗口本身）', () => {
  const st = new BotState(path.join(tmp, 'state-fb-window.json'))
  st.addSentRef('REFIDX_ACK_OLD2', { sessionId: 'session-ack', kind: 'ack' })
  st.data.sentRefs.REFIDX_ACK_OLD2.at = Date.now() - 40 * 60 * 1000
  assert.equal(st.recentTarget(5 * 60 * 1000), null)
})

await t('【行为】兜底取的是**真正最新**的那条（recent 与 sentRefs 混排）', () => {
  const st = new BotState(path.join(tmp, 'state-fb-mix.json'))
  st.addSentRef('R-old', { sessionId: 'session-old', kind: 'turn-complete' })
  st.data.sentRefs['R-old'].at = Date.now() - 30 * 60 * 1000
  st.noteRecent({ sessionId: 'session-new', kind: 'turn-complete', refIdx: 'R-new' })
  assert.equal(st.recentTarget().sessionId, 'session-new', 'recent 里那条更新，就该它赢')

  // 反过来：recent 里那条更旧，sentRefs 里那条更新 → 必须换人
  st.data.recent[0].at = Date.now() - 30 * 60 * 1000
  st.data.sentRefs['R-old'].at = Date.now() - 60 * 1000
  assert.equal(st.recentTarget().sessionId, 'session-old',
    'sentRefs 与 recent 混排要按时间取最新，不能死认 recent[0]')
})

await t('【行为】手上一条带会话的记录都没有 → 老实返回 null（截图那种不算）', () => {
  const st = new BotState(path.join(tmp, 'state-fb-none.json'))
  st.addSentRef('R-screen', { kind: 'screen' })
  assert.equal(st.recentTarget(), null, '截图没有 sessionId，不能拿它当兜底会话')
})

await t('【源码】unknown_ref 分支必须真的把消息投出去（不许再只回一句「认不出」就丢掉）', () => {
  const at = qqruntimeSrc.indexOf("case 'unknown_ref': {")
  assert.notEqual(at, -1, '找不到 unknown_ref 分支 —— 测试已与源码脱节')
  const end = qqruntimeSrc.indexOf("case 'screen_ref':", at)
  assert.notEqual(end, -1, '找不到 unknown_ref 分支的结尾')
  const block = qqruntimeSrc.slice(at, end)
  assert.ok(block.includes('handlePrompt('), '认不出的引用也必须投进一个会话（以前整条丢）')
  assert.ok(block.includes('chatTarget()'), '没有已知会话时该落到闲聊会话（只读，安全）')
  assert.ok(!block.includes("你引用的这条我认不出是哪次通知了"),
    '不许再回到「回一句就丢掉」的老写法')

  // 反向校验：把老写法塞回去，这个检查器必须认出来
  const fake = [
    "case 'unknown_ref':",
    "  await replyPassive(data, '你引用的这条我认不出是哪次通知了（可能是太久以前、被清理了）。')",
    '  break',
    "case 'screen_ref':",
  ].join('\n')
  const fakeBlock = fake.slice(fake.indexOf("case 'unknown_ref':"), fake.indexOf("case 'screen_ref':"))
  assert.ok(!fakeBlock.includes('handlePrompt(') && fakeBlock.includes('你引用的这条我认不出是哪次通知了'),
    '检查器本身失效了：老写法放回去它也认不出来')
})

await t('【源码】「✅ 收到 / ❌ 没送进」两条回执都必须带上会话（好让引用它时认得出）', () => {
  const hp = extractFunction(qqruntimeSrc, 'async function handlePrompt(sessionId, label, text, data) {')
  const okLine = hp.split('\n').find((l) => l.includes('✅ ${how}'))
  const badLine = hp.split('\n').find((l) => l.includes('❌ 这句没送进'))
  assert.ok(okLine.includes('sessionId, session: label'), `✅ 回执要带会话，实际：${okLine}`)
  assert.ok(badLine.includes('sessionId, session: label'), `❌ 回执也要带会话，实际：${badLine}`)

  const ha = extractFunction(qqruntimeSrc, 'async function handleAnswer(askId, text, data) {')
  const lines = ha.split('\n')
  const i = lines.findIndex((l) => l.includes('已经把你的回答带过去了'))
  assert.notEqual(i, -1, '找不到作答回执 —— 测试已与源码脱节')
  assert.ok(lines.slice(i, i + 3).join(' ').includes('sessionId: item.sessionId'),
    '作答回执要带上提问所属的会话')
})

await t('【源码】按兜底送进去时必须明说，并带上「那条是多久之前发的」', () => {
  const at = qqruntimeSrc.indexOf("case 'prompt': {")
  assert.notEqual(at, -1, '找不到 prompt 分支 —— 测试已与源码脱节')
  const end = qqruntimeSrc.indexOf('// 显式 /task', at)
  const block = qqruntimeSrc.slice(at, end)
  assert.ok(block.includes('refTarget?.viaFallback'), '兜底送进去必须能被识别出来')
  assert.ok(block.includes('fmtDuration(refTarget.ageMs)'), '要说清是多久之前那条通知，好让他判断猜得对不对')
  assert.ok(block.includes('如果送错了地方'), '要说清送错了怎么补救')
})

await t('【源码】pendingAsks 条目要带会话名（回执登记时才有 label 可用）', () => {
  assert.ok(qqruntimeSrc.includes('session: sessionTitleOf(request?.agent), resolve'),
    'pendingAsks 里没记会话名，作答回执只能说「那个会话」')
})

// ── [14] 官方的 `msg_elements`：被引用那条消息的**正文**，事件里本来就有 ──────
//
// 主人问了一句把我说醒的话（2026-10-05）：「我引用的消息，QQ 机器人那里不是可以正确
// 获取吗？应该有对应的接口吧？」—— 对，而且不用调接口：官方「单聊消息事件」里
// message_type=103（引用消息）时事件带 `msg_elements`，第一个元素就是被引用那条：
//   .msg_idx / .content / .author.bot
// 我们以前**只读索引、把正文扔了**。现在补上，于是引用反查多了一条完全不依赖
// 状态文件的路：我发出去的每条消息里都写着会话名（「✅ main 跑完了」「✅ 收到…（main）」），
// 从正文里就能把会话认出来 —— 状态文件被清、登记被挤出上限，都还认得。
// 文档：https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html

console.log('\n[14] 引用反查第三条路：用官方事件里的被引用正文认会话')

/** 官方「单聊消息事件」示例 3（引用消息）的形状。 */
const QUOTE_EVENT_DOC = {
  id: 'ROBOT1.0_zzzz',
  author: { id: 'C3D4E5F6', user_openid: 'C3D4E5F6', union_openid: '', username: '', bot: false },
  content: '这个建议很有帮助，谢谢你！',
  message_type: 103,
  msg_elements: [
    {
      msg_idx: 'REFIDX_aaaaaaaaaaaaaaa==',
      message_type: 103,
      content: '每天坚持阅读半小时，一个月后你会发现自己的变化',
      author: { id: 'A1B2C3D4', user_openid: 'A1B2C3D4', bot: false },
    },
  ],
  message_scene: {
    source: 'default',
    ext: ['ref_msg_idx=REFIDX_aaaaaaaaaaaaaaa==', 'msg_idx=REFIDX_zzzzzzzzzzzzzzz=='],
  },
  timestamp: '2026-07-21T10:02:00+08:00',
}

/** 引用**我发的**一条通知时的事件形状（author.bot 为 true）。 */
const quoteOfMine = (content, bot = true) => ({
  id: 'ROBOT1.0_yyy',
  author: { user_openid: 'ME', bot: false },
  content: '接着说',
  message_type: 103,
  msg_elements: [
    { msg_idx: 'REFIDX_botmsg==', message_type: 0, content, author: { user_openid: 'BOT_OPENID', bot } },
  ],
  message_scene: { source: 'default', ext: ['ref_msg_idx=REFIDX_botmsg==', 'msg_idx=REFIDX_mine=='] },
})

/** ⚠️ 运行时传给 inferSessionFromQuote / resolveQuoteTarget 的是 **extractQuoted 的产物**，
 *  不是原始事件 —— 测试也必须走这一步，否则等于在测一个不存在的调用方式。 */
const quotedOf = (content, bot = true) => extractQuoted(quoteOfMine(content, bot))

await t('【行为】extractQuoted：官方示例（引用消息）里能读出被引用那条的正文与作者', () => {
  const q = extractQuoted(QUOTE_EVENT_DOC)
  assert.equal(q.idx, 'REFIDX_aaaaaaaaaaaaaaa==')
  assert.equal(q.content, '每天坚持阅读半小时，一个月后你会发现自己的变化')
  assert.equal(q.bot, false, '那条是用户自己发的，不能当成我发的')
  assert.equal(q.authorId, 'A1B2C3D4')
})

await t('【行为】extractQuoted：我发的通知被引用时，能认出「是我发的」', () => {
  const q = extractQuoted(quoteOfMine('✅ main 跑完了'))
  assert.equal(q.content, '✅ main 跑完了')
  assert.equal(q.bot, true)
  assert.equal(q.authorId, 'BOT_OPENID')
})

await t('【行为】extractQuoted：没引用（没有 msg_elements / 空元素）→ null，不能瞎认', () => {
  assert.equal(extractQuoted({ content: '你好', message_type: 0 }), null)
  assert.equal(extractQuoted({ msg_elements: [] }), null)
  assert.equal(extractQuoted({ msg_elements: [null] }), null)
  assert.equal(extractQuoted({ msg_elements: [{ msg_idx: '', content: '' }] }), null)
  assert.equal(extractQuoted(null), null)
  // author 缺失时按"别人发的"算：宁可少一条路，也不能把别人的话当成我发的
  assert.equal(extractQuoted({ msg_elements: [{ content: 'x' }] }).bot, false)
})

await t('【行为】extractQuoted：多个元素时按 ref_idx 挑那一个（防御：官方可能有嵌套）', () => {
  const data = {
    msg_elements: [
      { msg_idx: 'REFIDX_nested==', content: '嵌套的更外一层' },
      { msg_idx: 'REFIDX_want==', content: '我要的那条' },
    ],
    message_scene: { ext: ['ref_msg_idx=REFIDX_want==', 'msg_idx=REFIDX_now=='] },
  }
  assert.equal(extractQuoted(data, 'REFIDX_want==').content, '我要的那条')
  // 挑不到就退回第一个（宁可拿错一条正文，也别整条丢掉）
  assert.equal(extractQuoted(data, 'REFIDX_nope==').content, '嵌套的更外一层')
})

await t('【行为】extractRefIdx：ext 里没有 ref_msg_idx 时，退到元素自带的 msg_idx', () => {
  const data = { msg_elements: [{ msg_idx: 'REFIDX_from_element==', content: 'x' }], message_scene: { ext: [] } }
  assert.equal(extractRefIdx(data), 'REFIDX_from_element==')
})

// 🔴 反向校验：把「按元素兜底」这条路拿掉（= 只认 ext），上面那条断言必须不成立 ——
// 证明它测的是新加的那条路，而不是别的什么地方碰巧凑出来的。
await t('【反向】只认 ext 的老写法下，同一份事件是取不到索引的', () => {
  const oldWay = (data) => {
    const ext = data?.message_scene?.ext
    if (!Array.isArray(ext)) return ''
    for (const item of ext) {
      const m = /^ref_msg_idx=(.+)$/.exec(String(item ?? '').trim())
      if (m) return m[1].trim()
    }
    return ''
  }
  const data = { msg_elements: [{ msg_idx: 'REFIDX_from_element==', content: 'x' }], message_scene: { ext: [] } }
  assert.equal(oldWay(data), '', '老写法本来就取不到 —— 所以上面那条测的确实是新路')
  assert.notEqual(extractRefIdx(data), '')
})

await t('【行为】extractMsgIdx：只认本条消息自己的 msg_idx，不会误抓 ref_msg_idx', () => {
  assert.equal(extractMsgIdx(QUOTE_EVENT_DOC), 'REFIDX_zzzzzzzzzzzzzzz==')
  assert.equal(extractMsgIdx({ message_scene: { ext: ['ref_msg_idx=REFIDX_a=='] } }), '',
    'ref_msg_idx 不是本条消息的索引，绝不能当成去重键')
  assert.equal(extractMsgIdx({}), '')
})

const SESSIONS = [
  { id: 'session-plugin', title: '插件' },
  { id: 'session-main', title: 'main' },
  { id: 'session-front', title: '前端重构' },
  { id: 'session-front2', title: '前端' },
]

await t('【行为】inferSessionFromQuote：通知首行、回执括号、提问首行都能认出会话', () => {
  const cases = [
    ['✅ 插件 跑完了\n\n改了去重键，21 项全绿。', 'session-plugin'],
    ['❓ main 想问你个事\n\n【第 1 问】…', 'session-main'],
    ['⚠️ main 出错了\n\nboom', 'session-main'],
    ['✅ 收到，我这就开始（插件）', 'session-plugin'],
    ['✅ 收到，我这就开始（前端重构）', 'session-front'],
    ['❌ 这句没送进 插件：DSH 会话密钥不可用', 'session-plugin'],
  ]
  for (const [content, want] of cases) {
    const hit = inferSessionFromQuote(quotedOf(content), SESSIONS)
    assert.equal(hit?.sessionId, want, `「${content.split('\n')[0]}」该认出 ${want}，实际 ${JSON.stringify(hit)}`)
    assert.equal(hit.session, SESSIONS.find((s) => s.id === want).title)
  }
})

await t('【行为】inferSessionFromQuote：认不出的名字绝不硬猜（猜错会话比认不出更糟）', () => {
  assert.equal(inferSessionFromQuote(quotedOf('✅ 谁谁 跑完了'), SESSIONS), null)
  assert.equal(inferSessionFromQuote(quotedOf('（某个我不认识的会话）'), SESSIONS), null)
  assert.equal(inferSessionFromQuote(quotedOf('随便一句没有会话名的话'), SESSIONS), null)
  assert.equal(inferSessionFromQuote(quotedOf('✅ 插件 跑完了'), []), null, '一个会话都没有时不能猜')
  assert.equal(inferSessionFromQuote(null, SESSIONS), null)
  assert.equal(inferSessionFromQuote({ content: '   ' }, SESSIONS), null)
})

await t('【行为】inferSessionFromQuote：我方那句「认不出」的提示被引用时不会误判', () => {
  const note = '（说一声：你引用的那条我认不出属于哪个会话 —— 没登记过、会话名也没对上，所以这句话我放进了「闲聊」：那里只能看、不能动手。）'
  assert.equal(inferSessionFromQuote(quotedOf(note), SESSIONS), null,
    '括号里是一整句话，不是会话名 —— 不能因为里面出现了「会话」两个字就认成某个会话')
})

await t('【行为】inferSessionFromQuote：按首行猜只对**我发的**消息生效，且只认第一行', () => {
  // 我发的：首行里出现会话名 → 敢认
  const mine = inferSessionFromQuote(quotedOf('前端重构这件事我想再放放'), SESSIONS)
  assert.equal(mine?.sessionId, 'session-front')
  assert.ok(!mine.how.includes('我方格式'), '这是松判据（首行），不是高置信那条')

  // 你自己发的：同样的话不敢认（你随口提到会话名，不代表话题就是它）
  assert.equal(inferSessionFromQuote(quotedOf('前端重构这件事我想再放放', false), SESSIONS), null)

  // 只有**第二行**出现会话名 → 不认（summary 里提到别的会话名是常事）
  assert.equal(inferSessionFromQuote(quotedOf('刚才那轮跑完了\n顺便说下前端重构'), SESSIONS), null)
})

await t('【行为】inferSessionFromQuote：同一行里两个标题都在时取最长的那个', () => {
  const hit = inferSessionFromQuote(quotedOf('前端重构 和 前端 都提到了'), SESSIONS)
  assert.equal(hit?.sessionId, 'session-front', '"前端重构" 比 "前端" 更具体，不能只认短的那个')
})

await t('【行为】resolveQuoteTarget：三级顺序 = 精确登记 > 引用正文 > 最近一条', () => {
  const exact = { sessionId: 'session-exact', kind: 'turn-complete' }
  const recent = { sessionId: 'session-recent', viaFallback: true, ageMs: 1000 }
  const quoted = quotedOf('✅ 插件 跑完了')

  const a = resolveQuoteTarget({ exact, quoted, sessions: SESSIONS, recent })
  assert.equal(a, exact, '精确命中就该原样返回（那是知道得最准的一路）')

  const b = resolveQuoteTarget({ quoted, sessions: SESSIONS, recent })
  assert.equal(b.sessionId, 'session-plugin', '正文认得出会话时，不该退到"最近一条"去猜')
  assert.equal(b.viaContent, true)
  assert.ok(b.how.includes('我方格式'))

  const c = resolveQuoteTarget({ quoted: quotedOf('一句认不出的话'), sessions: SESSIONS, recent })
  assert.equal(c.sessionId, 'session-recent', '正文认不出时才轮到最近一条')

  assert.equal(resolveQuoteTarget({ quoted, sessions: [] }), null, '三条路都没有就是 null（调用方会投进闲聊，绝不丢）')
})

await t('【行为】resolveQuoteTarget：认出来的会话正卡在提问上 → 这条必须按「作答」走', () => {
  const quoted = quotedOf('❓ 插件 想问你个事')
  const hit = resolveQuoteTarget({
    quoted, sessions: SESSIONS, pending: { askId: 'ask-1', sessionId: 'session-plugin' },
  })
  assert.equal(hit.kind, 'question', '否则这句话会被当普通消息注入会话，而 agent 还卡在提问上等答案')
  assert.equal(hit.askId, 'ask-1')
  // 端到端：路由出来必须是「作答」，而且带着 askId
  const route = routeMessage({ text: '1', refIdx: 'REFIDX_botmsg==', hasPendingQuestion: true, refTarget: hit })
  assert.equal(route.kind, 'answer')
  assert.equal(route.askId, 'ask-1')

  // 正等回答的是**别的**会话 → 不能挪用作答（那是别人在等）
  const other = resolveQuoteTarget({
    quoted, sessions: SESSIONS, pending: { askId: 'ask-9', sessionId: 'session-main' },
  })
  assert.equal(other.kind, 'quote-content')
  assert.equal(other.askId, undefined)
})

await t('【行为】引用了但索引丢了：靠正文认出会话后必须走引用那条路（不能当闲聊）', () => {
  const target = resolveQuoteTarget({ quoted: quotedOf('✅ 插件 跑完了'), sessions: SESSIONS })
  const withQuote = routeMessage({ text: '接着说', refIdx: '', hasPendingQuestion: false, refTarget: target, hasQuote: true })
  assert.equal(withQuote.kind, 'prompt', '索引没拿到也不该退化成闲聊 —— 那会把话送进另一个会话')
  assert.equal(withQuote.sessionId, 'session-plugin')

  // 🔴 反向校验：不显式声明 hasQuote（= 老调用方的行为）时就是闲聊 —— 证明确实是这个开关在做判断
  const oldWay = routeMessage({ text: '接着说', refIdx: '', hasPendingQuestion: false, refTarget: target })
  assert.equal(oldWay.kind, 'chat')
})

await t('【源码】onC2cMessage：三级兜底收敛到一个决策点，且只在"精确没中"时才去认正文', () => {
  const body = extractFunction(qqruntimeSrc, 'async function onC2cMessage(data) {')
  assert.ok(body.includes('resolveQuoteTarget({ exact, quoted, sessions, pending, recent })'),
    '三级顺序必须写在纯函数 resolveQuoteTarget 里（散在分支里迟早写歪），这里只负责备料')
  assert.ok(body.indexOf('if (!exact && quoted?.content)') < body.indexOf('resolveQuoteTarget({ exact'),
    '只在"精确反查没中"时才去认正文')
  assert.ok(body.includes('ensureApi(cfg)') && body.includes('await listSessions()'),
    '认正文要用会话列表（标题 → id），得先 ensureApi 再拉')
  assert.ok(body.includes('else if (!exact)'), '没有引用正文可认时，才直接用"最近一条"兜底')
})

await t('【源码】prompt 分支：靠正文认出的会话也必须明说（viaContent）', () => {
  const at = qqruntimeSrc.indexOf("case 'prompt': {")
  const end = qqruntimeSrc.indexOf('// 显式 /task', at)
  const block = qqruntimeSrc.slice(at, end)
  assert.ok(block.includes('refTarget?.viaContent'), '靠正文认的也要说一声，认错了他才知道')
  assert.ok(block.includes('refTarget?.viaFallback'), '按"最近一条"猜的那条说明也不能丢')
})

await t('【源码】unknown_ref 分支：要把你引用的那句摘出来回给你', () => {
  const at = qqruntimeSrc.indexOf("case 'unknown_ref': {")
  const end = qqruntimeSrc.indexOf("case 'screen_ref':", at)
  const block = qqruntimeSrc.slice(at, end)
  assert.ok(block.includes('quoted?.content'), '连"我看见了什么"都不说，主人只能干着急')
  assert.ok(block.includes('handlePrompt('), '认不出也必须投递')
})

await t('【源码】msg_idx 重复：只记日志，绝不 return（宁可重复一次也不能丢）', () => {
  const at = qqruntimeSrc.indexOf('const myMsgIdx = extractMsgIdx(data)')
  assert.notEqual(at, -1, '找不到 msg_idx 观测块 —— 测试已与源码脱节')
  const end = qqruntimeSrc.indexOf('const text = String(data?.content', at)
  const block = qqruntimeSrc.slice(at, end)
  const codeOnly = block.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.ok(codeOnly.includes('seenMsgIdx.has(myMsgIdx)'), '要能发现重复（否则观测就没意义）')
  assert.ok(!/\breturn\b/.test(codeOnly),
    '官方建议按 msg_idx 去重，但万一它不是每条唯一，按它去重会把正常消息永久丢掉')

  // 🔴 反向校验：把「重复就 return」写回去，上面的检查器必须报红
  const bad = [
    'const myMsgIdx = extractMsgIdx(data)',
    'if (myMsgIdx && seenMsgIdx.has(myMsgIdx)) {',
    '  l("重复")',
    '  return',
    '}',
  ].join('\n')
  const badCode = bad.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.ok(/\breturn\b/.test(badCode), '检查器失效了：重复就 return 的写法它都看不出来')
})

console.log('\n[15] agent 状态落盘（回合中途重启后还认得出"它正在跑" —— 2026-10-05 报的 bug）')

await t('markAgentStatus 落盘，另一个实例从盘上读得回来', () => {
  const f = path.join(tmp, 'state-agent.json')
  new BotState(f).markAgentStatus('session-a', 'running')
  assert.equal(new BotState(f).agentStatusMap()['session-a'].s, 'running')
})

await t('老状态文件（没有 agentStatus 键）平滑升级：读回空表、不炸', () => {
  const f = path.join(tmp, 'state-agent-legacy.json')
  fs.writeFileSync(f, JSON.stringify({ openId: 'o1', sessionId: null, lastSeq: 2, seen: [] }), 'utf8')
  const st = new BotState(f)
  assert.deepEqual(st.agentStatusMap(), {})
  assert.deepEqual(st.data.agentStatus, {})
})

await t('只认 running / idle —— 别的状态不许盖掉"它正在跑"这个事实', () => {
  const f = path.join(tmp, 'state-agent-only.json')
  const st = new BotState(f)
  st.markAgentStatus('s1', 'running')
  st.markAgentStatus('s1', 'error')
  st.markAgentStatus('', 'running')
  assert.equal(new BotState(f).agentStatusMap()['s1'].s, 'running')
  assert.equal(Object.keys(new BotState(f).agentStatusMap()).length, 1, '空 id 不该建条目')
})

await t('过期条目会被清掉（不会永远把某个 agent 当"在跑"）', () => {
  const f = path.join(tmp, 'state-agent-ttl.json')
  const st = new BotState(f)
  st.markAgentStatus('s-old', 'running', 50, 1000)
  st.data.agentStatus['s-old'].at = Date.now() - 5000
  st.markAgentStatus('s-new', 'running', 50, 1000)
  const m = new BotState(f).agentStatusMap()
  assert.equal(m['s-old'], undefined, '超过 TTL 的条目必须清掉')
  assert.equal(m['s-new'].s, 'running')
})

await t('条目数量有上限，状态文件不会无限膨胀', () => {
  const f = path.join(tmp, 'state-agent-cap.json')
  const st = new BotState(f)
  for (let i = 0; i < 10; i += 1) st.markAgentStatus(`s${i}`, 'idle', 3)
  assert.equal(Object.keys(st.agentStatusMap()).length, 3)
})

console.log(`\n${'─'.repeat(60)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`)
  process.exit(1)
}
console.log('全部通过 ✅')
fs.rmSync(tmp, { recursive: true, force: true })
