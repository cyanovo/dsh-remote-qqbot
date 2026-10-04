/**
 * QQ「看状态」(/status) 离线自测 —— **不发任何真实请求**。
 *
 * 主人 2026-10-02 的要求：*"在我使用 QQ 的看状态的时候，能看到哪些会话正在运行"*。
 * 这一组守的就是这件事：**正在运行的会话必须被列出来**，而且拿不到列表时
 * 要如实报错、不能假装"没有在跑"。
 *
 * 设计上刻意把排版逻辑抽成 qqbridge.js 里的纯函数 `formatStatusText()` /
 * `summarizeSession()`，于是这里**跑函数验行为**，而不是正则扫源码
 * （本项目踩过"正则扫源码把注释当代码"的坑，见 agentmd）。
 *
 * 跑法：node tests/status.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { formatStatusText, summarizeSession } from '../src/qqbridge.js'

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

/** 一条**真实形状**的 session/list item（字段路径照抄 2026-10-02 的实测抓包）。 */
function item({
  id = 'session-00000000-0000-0000-0000-000000000000',
  title = '主会话',
  cwd = 'D:\\cyanproject\\agenttool',
  turns = 16,
  running = false,
  blank = false,
  updatedAt = 1790909297617,
} = {}) {
  const values = { title }
  if (turns !== null) values.sessionStats = { turns, steps: turns * 3 }
  return { sessionId: id, cwd, running, blank, updatedAt, projections: { kind: 'sequenced', values } }
}

console.log('\n[1] summarizeSession —— 字段路径只在一处，形状变了只改一个函数')

await t('真实 session/list 形状：标题 / 项目 / 轮数 / 运行状态都取到', () => {
  const s = summarizeSession(item())
  assert.equal(s.title, '主会话')
  assert.equal(s.project, 'agenttool', 'cwd 只留最后一段')
  assert.equal(s.turns, 16)
  assert.equal(s.running, false)
  assert.equal(s.id, 'session-00000000-0000-0000-0000-000000000000')
})

await t('老会话没有 sessionStats → turns 为 null，不抛错、不显示 NaN', () => {
  const s = summarizeSession(item({ turns: null }))
  assert.equal(s.turns, null)
  const text = formatStatusText({ sessions: [{ ...s, running: true, turns: null }] })
  assert.ok(!text.includes('NaN'), `不该出现 NaN：\n${text}`)
  assert.ok(!text.includes('第 null 轮'), `不该出现"第 null 轮"：\n${text}`)
})

await t('title 为 null：blank 会话叫「空会话」，非 blank 叫「未命名会话」', () => {
  assert.equal(summarizeSession(item({ title: null, blank: true, turns: null })).title, '（空会话）')
  assert.equal(summarizeSession(item({ title: null, blank: false })).title, '未命名会话')
  // 纯空白也算没有标题
  assert.equal(summarizeSession(item({ title: '   ' })).title, '未命名会话')
})

await t('超长标题按**码点**截断（中文一字算一个）并补省略号', () => {
  const s = summarizeSession(item({ title: '啊'.repeat(80) }))
  assert.ok([...s.title].length <= 22, `截断后仍是 ${[...s.title].length} 码点`)
  assert.ok(s.title.endsWith('…'))
})

await t('标题里的换行/制表符被压成单空格 —— 否则 QQ 排版会被一条标题搅乱', () => {
  const s = summarizeSession(item({ title: '第一行\n第二行\t第三行' }))
  assert.equal(s.title, '第一行 第二行 第三行')
  assert.ok(!s.title.includes('\n') && !s.title.includes('\t'))
})

await t('cwd 缺失/为空 → project 空串，不出现 undefined', () => {
  assert.equal(summarizeSession(item({ cwd: '' })).project, '')
  // ⚠️ 这里**不能**用 item({cwd: undefined})：解构默认值只认 undefined，
  // 那样会拿到默认路径而不是"字段缺失"。故意传一个真的没有 cwd 的裸对象。
  const noCwd = { sessionId: 'session-a', projections: { values: { title: 'x' } } }
  assert.equal(summarizeSession(noCwd).project, '')
  const text = formatStatusText({ sessions: [{ ...summarizeSession(noCwd), running: true }] })
  assert.ok(!text.includes('undefined'), `不该出现 undefined：\n${text}`)
  // 缺 cwd 时那条描述不该多出一个空的项目段（"主会话 ·  · 第 16 轮"）
  assert.ok(!text.includes(' ·  · '), `不该出现空的项目段：\n${text}`)
})

await t('反斜杠与正斜杠路径都能取出最后一段', () => {
  assert.equal(summarizeSession(item({ cwd: 'D:\\a\\b\\proj' })).project, 'proj')
  assert.equal(summarizeSession(item({ cwd: '/srv/app/proj' })).project, 'proj')
  assert.equal(summarizeSession(item({ cwd: 'D:\\a\\b\\proj\\' })).project, 'proj', '结尾斜杠不该变成空段')
})

console.log('\n[2] formatStatusText —— 在跑的会话是主角')

await t('★ 核心需求：正在运行的会话被逐个列出来，带项目与轮数', () => {
  const text = formatStatusText({
    channelOn: true,
    pending: 0,
    sessions: [
      { ...summarizeSession(item({ title: '主会话', turns: 16 })), running: true },
      { ...summarizeSession(item({ title: '插件优化', turns: 9 })), running: true },
    ],
  })
  assert.ok(text.includes('正在跑 2 个会话'), `没报数量：\n${text}`)
  assert.ok(text.includes('1. 主会话 · agenttool · 第 16 轮'), `第 1 条不对：\n${text}`)
  assert.ok(text.includes('2. 插件优化 · agenttool · 第 9 轮'), `第 2 条不对：\n${text}`)
})

await t('没有会话在跑时**明说**没有，而不是留一片空白', () => {
  const text = formatStatusText({ sessions: [{ ...summarizeSession(item()), running: false }] })
  assert.ok(text.includes('现在没有会话在跑'), `应该明说没有：\n${text}`)
  assert.ok(!text.includes('正在跑 0 个'))
})

await t('★ 拿不到会话列表时**显式告警**，绝不假装"没有在跑"', () => {
  const text = formatStatusText({ channelOn: true, listError: 'connect ECONNREFUSED' })
  assert.ok(text.includes('⚠️'), `必须有告警标记：\n${text}`)
  assert.ok(text.includes('ECONNREFUSED'), '要把真实原因带上，便于排查')
  assert.ok(!text.includes('现在没有会话在跑'), '读不到 ≠ 没有在跑，这两件事不能混')
  assert.ok(!text.includes('💤'), '读不到列表时不该报空闲数（那个数也是假的）')
})

await t('空闲数 = 总数 − 在跑数', () => {
  const mk = (running) => ({ ...summarizeSession(item()), running })
  const text = formatStatusText({ sessions: [mk(true), mk(false), mk(false), mk(false)] })
  assert.ok(text.includes('💤 另外 3 个闲着'), `空闲数不对：\n${text}`)
  const only = formatStatusText({ sessions: [mk(true)] })
  assert.ok(only.includes('没有闲着的会话'), `全是运行中时应这么说：\n${only}`)
})

await t('超过上限时折叠成一行"还有 N 个"，不把 QQ 刷屏', () => {
  const many = Array.from({ length: 13 }, (_, i) => ({
    ...summarizeSession(item({ title: `会话${i + 1}` })), running: true,
  }))
  const text = formatStatusText({ sessions: many })
  const numbered = text.split('\n').filter((l) => /^\d+\. /.test(l))
  assert.equal(numbered.length, 10, `最多列 10 条，实际 ${numbered.length}`)
  assert.ok(text.includes('… 另外还有 3 个在跑'), `缺折叠行：\n${text}`)
})

await t('专属/闲聊会话显示**名字**与状态，而不是一串 sessionId', () => {
  const taskId = 'session-609a29a2-e74f-44a7-bf97-74ffcb8940d8'
  const chatId = 'session-37466a09-7f7d-4a8e-a5ac-2da16b4a5564'
  const text = formatStatusText({
    taskId,
    chatId,
    sessions: [
      { ...summarizeSession(item({ id: taskId, title: '派活专用' })), running: true },
      { ...summarizeSession(item({ id: chatId, title: '闲聊专用', turns: 3 })), running: false },
    ],
  })
  assert.ok(text.includes('用 /task 派活，会进这里：派活专用（正在跑）'), `专属会话那行不对：\n${text}`)
  assert.ok(text.includes('不引用消息地聊天，会进这里：闲聊专用（空闲）'), `闲聊会话那行不对：\n${text}`)
  assert.ok(!text.includes(taskId), '不该把完整 sessionId 甩给用户')
})

await t('会话还没建 / 已经不在了：分别是两句明确的话', () => {
  const text = formatStatusText({
    taskId: '',
    chatId: 'session-37466a09-7f7d-4a8e-a5ac-2da16b4a5564',
    sessions: [],
  })
  assert.ok(text.includes('用 /task 派活，会进这里：还没建，第一次用到时我会自己建'), text)
  assert.ok(text.includes('不引用消息地聊天，会进这里：已经不在了，下次用到时重建'), text)
})

await t('★ 纯文本：正文里不能出现 markdown 记号（被动回复不带 markdown 标志）', () => {
  const text = formatStatusText({
    channelOn: true,
    pending: 2,
    taskId: 'session-x',
    chatId: 'session-y',
    sessions: [
      { ...summarizeSession(item({ id: 'session-x', title: '主会话' })), running: true },
      { ...summarizeSession(item({ id: 'session-y', title: '插件优化' })), running: false },
    ],
  })
  for (const marker of ['**', '```', '](', '## ']) {
    assert.ok(!text.includes(marker), `不该出现 markdown 记号 ${JSON.stringify(marker)}：\n${text}`)
  }
})

await t('QQ 通道状态与待答提问数都在', () => {
  assert.ok(formatStatusText({ channelOn: true, pending: 0 }).includes('QQ 连着'))
  assert.ok(formatStatusText({ channelOn: false, pending: 0 }).includes('QQ 没连上'))
  assert.ok(formatStatusText({ channelOn: true, pending: 3 }).includes('有 3 个问题在等你回答'))
})

await t('★ 注入腿（引用回复）单独报，别被"QQ 连着"盖过去 —— 2026-10-04 就是这么误诊的', () => {
  const ok = formatStatusText({ channelOn: true })
  assert.ok(ok.includes('引用回复能送进会话'), ok)

  const bad = formatStatusText({ channelOn: true, injectError: '读不到会话密钥（没有 browser-session 记录）' })
  assert.ok(bad.includes('⚠️'), bad)
  assert.ok(bad.includes('引用回复送不进会话'), bad)
  assert.ok(bad.includes('browser-session'), '要把真实原因带上：\n' + bad)
  assert.ok(bad.includes('QQ 连着'), '两条腿互不掩盖')

  const noted = formatStatusText({ channelOn: true, injectNote: '已补回签名记录，重启一次桌面版' })
  assert.ok(noted.includes('已补回签名记录'), noted)
})

await t('入参全空也不崩（防御性：session/list 返回空 items）', () => {
  const text = formatStatusText()
  assert.ok(text.startsWith('📊 现在的状态'), text)
  assert.ok(text.includes('现在没有会话在跑'), text)
  const text2 = formatStatusText({ sessions: null })
  assert.ok(text2.includes('现在没有会话在跑'), text2)
})

console.log('\n[3] qqruntime.statusText —— 源码护栏（它不导出，只能守字面）')

const qqSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'qqruntime.js'), 'utf8')

/** 抠出某个函数的函数体，后面的断言都只看这一块。 */
function bodyOf(signature) {
  const start = qqSrc.indexOf(signature)
  assert.notEqual(start, -1, `找不到 ${signature} —— 测试已与源码脱节`)
  const end = qqSrc.indexOf('\n  }', start)
  assert.notEqual(end, -1, `找不到 ${signature} 的结尾 —— 测试已与源码脱节`)
  return qqSrc.slice(start, end)
}

const statusBody = () => bodyOf('async function statusText(')

await t('statusText 真的去拉 session/list（不是继续写死）', () => {
  const body = statusBody()
  // 0.8.5 把"拉列表"抽成了 listSessions()（/sessions 也要用同一份），
  // 所以这里守的是**委托关系**，真正打接口的那段由下一条断言守。
  assert.ok(body.includes('listSessions('), '必须拉会话列表')
  assert.ok(body.includes('formatStatusText'), '排版必须委托给纯函数，别在这里手拼')
})

await t('listSessions 才是真正打 session/list 的地方（且过 summarizeSession 归一）', () => {
  const body = bodyOf('async function listSessions(')
  assert.ok(body.includes("api.rpc('session/list'"), '必须真的调 session/list')
  assert.ok(body.includes('summarizeSession'), '必须过 summarizeSession（字段路径归一）')
  assert.ok(body.includes('sort('), '必须按最近活动倒序：这就是"最近在聊"的语义')
  // 列表**不许缓存**：会话随时会新建/删除，缓存只会让人挑到一个不存在的东西。
  assert.ok(!/=\s*\[\s*\]\s*\/\/\s*cache|cachedSessions/.test(body), '列表不许做缓存')
})

await t('statusText 把失败原因传出去（listError），而不是静默吞掉', () => {
  const body = statusBody()
  assert.ok(body.includes('listError'), '必须有 listError 通道')
  assert.ok(/catch\s*\(/.test(body), '必须有 catch：接口挂了也要给用户一句人话')
})

await t('api 未就绪也要给一句人话，不能 TypeError 崩掉整条 QQ 回复', () => {
  const body = statusBody()
  assert.ok(/if\s*\(!api\)/.test(body), '必须先判 api 是否存在')
})

await t('旧写法（只报两个固定会话）已经不在 statusText 里', () => {
  const body = statusBody()
  for (const old of ['专属会话：', '闲聊会话：', 'sessionId.slice(0, 24)']) {
    assert.ok(!body.includes(old), `statusText 里不该再有旧写法 ${JSON.stringify(old)}：\n${body}`)
  }
})

await t('qqruntime 顶部确实 import 了新函数', () => {
  // 注意：不能拿"第一个空行之前"当 import 块 —— 文件开头是一大段 JSDoc 注释，
  // 第一个空行在注释之后就结束了，那样断言永远失败（这是本测试第一版踩的坑）。
  const block = /import\s*\{([\s\S]*?)\}\s*from\s*'\.\/qqbridge\.js'/.exec(qqSrc)
  assert.ok(block, '找不到 from ./qqbridge.js 的 import 语句')
  assert.ok(block[1].includes('formatStatusText'), `import 块里没有 formatStatusText：\n${block[1]}`)
  assert.ok(block[1].includes('summarizeSession'), `import 块里没有 summarizeSession：\n${block[1]}`)
})

console.log(`\n${'─'.repeat(60)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`)
  process.exit(1)
}
console.log('全部通过 ✅')
