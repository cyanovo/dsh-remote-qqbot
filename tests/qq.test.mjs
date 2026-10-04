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
  BotState, DshLocalApi, HELP_TEXT, buildAnswers, buildOneAnswer,
  extractRefIdx, formatNotification, formatQuestion, formatQuestionBody, pickPromptMode,
  qqPreviewUrl, readDshSecret,
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
await t('无提问 → 当新任务', () => {
  assert.deepEqual(routeIncoming('帮我跑一下测试', { hasPendingQuestion: false }),
    { kind: 'task', text: '帮我跑一下测试' })
})
await t('有提问 → 当回答', () => {
  assert.deepEqual(routeIncoming('方案A', { hasPendingQuestion: true }),
    { kind: 'answer', text: '方案A' })
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
await t('/task 不带内容给用法', () => {
  assert.equal(routeIncoming('/task').kind, 'usage')
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

await t('不引用但正好有提问在等 → 仍然作答（防 agent 永久卡住）', () => {
  const r = routeMessage({ text: '方案A', refIdx: '', hasPendingQuestion: true, refTarget: null })
  assert.equal(r.kind, 'answer')
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
await t('问题渲染带编号选项，能直接回数字', () => {
  const s = formatQuestion([Q1])
  assert.match(s, /选哪个方案？/)
  assert.match(s, /1\. 方案A/)
  assert.match(s, /2\. 方案B/)
  assert.match(s, /回数字/)
})
await t('选项自带的说明也发出来（回复时更有把握）', () => {
  const s = formatQuestion([{
    id: 'q', question: '走哪条？',
    options: [{ label: 'A', description: '快但贵' }, { label: 'B' }],
  }])
  assert.match(s, /1\. A\n\s+快但贵/)
  assert.match(s, /2\. B/)
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
  // 注意用 lastIndexOf —— 文件中间有好几个嵌套函数自己的 `return {`，第一个不是工厂的返回对象。
  const returnAt = qqSrcFull.lastIndexOf('  return {')
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

console.log(`\n${'─'.repeat(60)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`)
  process.exit(1)
}
console.log('全部通过 ✅')
fs.rmSync(tmp, { recursive: true, force: true })
