/**
 * QQ「会话列表」(/sessions) + 「当前会话」指针的离线自测 —— **不发任何真实请求**。
 *
 * 主人 2026-10-03 的要求：*"我希望在机器人菜单栏这里可以选择最近的六条会话进行对话"*。
 * 拍板的方案是「菜单只放一个固定入口 + 当前会话指针」：
 *   菜单「会话」→ 发 `/sessions` → 机器人列出最近 6 个会话 → 你回一个数字 →
 *   **那句话以后都进那个会话**，直到你再切（`/use 0` 取消）。
 *
 * 这一组守的就是这条链路的三个要害：
 *   ① **挑会话不许盖过回答提问** —— agent 卡在提问上等一个「1」时，
 *      那个「1」是在回答它，不是在说"切到第 1 个会话"。顺序反了 agent 永远等不到答案。
 *   ② **裸数字只在名单刚发出去的那几分钟内才算"选择"** —— 否则你随口说的「2」
 *      会被莫名其妙地解释成"切会话"。
 *   ③ **指定的会话不在了绝不许静默回落到别的会话** —— 悄悄换个会话，
 *      等于你的话进了你不知道的地方，这是这个功能最坏的失败方式。
 *
 * 跑法：node tests/session-picker.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  BotState, PICKER_DEFAULT_COUNT, PICK_WINDOW_MS, formatPickAck,
  formatSessionPickerText, formatStatusText, isPickerFresh, routeMessage, summarizeSession,
} from '../src/qqbridge.js'

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
  updatedAt = Date.now(),
} = {}) {
  const values = { title }
  if (turns !== null) values.sessionStats = { turns, steps: turns * 3 }
  return { sessionId: id, cwd, running, blank, updatedAt, projections: { kind: 'sequenced', values } }
}

const NOW = Date.now()
const SIX = [
  summarizeSession(item({ id: 's1', title: '主会话', running: true, updatedAt: NOW - 60 * 1000 })),
  summarizeSession(item({ id: 's2', title: '插件优化', updatedAt: NOW - 3600 * 1000 })),
  summarizeSession(item({ id: 's3', title: 'SSH连接服务器操作', cwd: 'D:\\other', updatedAt: NOW - 2 * 86400 * 1000 })),
  summarizeSession(item({ id: 's4', title: '未命名会话', blank: true, turns: null, updatedAt: NOW - 30 * 1000 })),
  summarizeSession(item({ id: 's5', title: '手机端', updatedAt: NOW - 5 * 60 * 1000 })),
  summarizeSession(item({ id: 's6', title: '备注页', updatedAt: NOW - 12 * 60 * 1000 })),
]

console.log('\n[1] formatSessionPickerText —— 列表怎么排，编号就是怎么来的')

await t('编号从 1 开始、条数正好 6、顺序照传入（已按最近活动倒序）', () => {
  const text = formatSessionPickerText({ sessions: SIX })
  const lines = text.split('\n')
  assert.equal(lines[0], '🗂 最近在聊的 6 个会话（回个数字切过去）', lines[0])
  for (let i = 1; i <= 6; i += 1) {
    assert.ok(lines.some((l) => l.startsWith(`${i}. `)), `缺少第 ${i} 行：\n${text}`)
  }
  const numbered = lines.filter((l) => /^\d+\. /.test(l))
  assert.equal(numbered.length, 6, '编号行数必须与条数一致')
  assert.ok(numbered[0].includes('主会话'), `第 1 个应是主会话：${numbered[0]}`)
  assert.ok(numbered[5].includes('备注页'), `第 6 个应是备注页：${numbered[5]}`)
})

await t('每行带上「正在跑 / 闲着」和多久以前（挑会话时要能分清机器在忙什么）', () => {
  const lines = formatSessionPickerText({ sessions: SIX }).split('\n')
  const one = lines.find((l) => l.startsWith('1. '))
  assert.ok(one.includes('正在跑'), one)
  assert.ok(one.includes('刚刚') || one.includes('分钟前'), one)
  const two = lines.find((l) => l.startsWith('2. '))
  assert.ok(two.includes('闲着'), two)
  assert.ok(two.includes('小时前'), two)
  const three = lines.find((l) => l.startsWith('3. '))
  assert.ok(three.includes('2 天前'), three)
  assert.ok(!lines.some((l) => l.includes('undefined') || l.includes('NaN')), '不许漏出 undefined/NaN')
})

await t('count 生效：传 3 就只列 3 个（设置里的 qqRecentCount 走这里）', () => {
  const text = formatSessionPickerText({ sessions: SIX, count: 3 })
  assert.ok(text.includes('最近在聊的 3 个会话'), text.split('\n')[0])
  assert.equal(text.split('\n').filter((l) => /^\d+\. /.test(l)).length, 3)
  assert.ok(!text.includes('4. '), text)
})

await t('默认条数就是主人要的 6', () => {
  assert.equal(PICKER_DEFAULT_COUNT, 6)
  assert.ok(formatSessionPickerText({ sessions: SIX }).includes('最近在聊的 6 个会话'))
})

await t('已经指定的那个会话标出来（免得你重复切同一个）', () => {
  const text = formatSessionPickerText({ sessions: SIX, currentId: 's2' })
  const two = text.split('\n').find((l) => l.startsWith('2. '))
  assert.ok(two.includes('现在就是它'), two)
  const one = text.split('\n').find((l) => l.startsWith('1. '))
  assert.ok(!one.includes('现在就是它'), one)
})

await t('列表读不到时如实报错，绝不假装"没有可以挑的会话"', () => {
  const text = formatSessionPickerText({ sessions: [], listError: 'boom' })
  assert.ok(text.includes('没读出来'), text)
  assert.ok(text.includes('boom'), text)
  assert.ok(!text.includes('还没有可以挑的会话'), '读失败与真的没有会话是两件事，不能混')
})

await t('真的一个会话都没有时，给一句人话而不是空白', () => {
  const text = formatSessionPickerText({ sessions: [] })
  assert.ok(text.includes('还没有可以挑的会话'), text)
  assert.ok(text.length < 80, '这种消息不该长')
})

await t('纯文本：不许出现 markdown 记号（replyPassive 不带 markdown，混进去会吃字符）', () => {
  const text = formatSessionPickerText({ sessions: SIX, currentId: 's1', listError: '' })
  for (const mark of ['**', '__', '`', '##']) {
    assert.ok(!text.includes(mark), `列表正文里不该有 ${mark}：\n${text}`)
  }
  // 会话标题里的下划线/星号也必须被"当成普通字符"发出去 —— DSH 标题里很常见。
  const weird = summarizeSession(item({ id: 'w', title: 'fix_bug *hot*', updatedAt: NOW }))
  const weirdText = formatSessionPickerText({ sessions: [weird] })
  assert.ok(weirdText.includes('fix_bug *hot*'), weirdText)
})

await t('超长标题按 summarizeSession 截断到 22 字（不能把一屏塞满）', () => {
  const long = summarizeSession(item({ id: 'L', title: '这是一个非常非常长的会话标题'.repeat(4), updatedAt: NOW }))
  const text = formatSessionPickerText({ sessions: [long] })
  const line = text.split('\n').find((l) => l.startsWith('1. '))
  const title = line.replace(/^1\. /, '').split(' · ')[0]
  assert.ok([...title].length <= 23, `标题过长：${title}`)
  assert.ok(title.endsWith('…'), title)
})

await t('入参全空也不崩（防御性）', () => {
  assert.ok(formatSessionPickerText().includes('还没有可以挑的会话'))
  assert.ok(formatSessionPickerText({ sessions: null }).includes('还没有可以挑的会话'))
})

console.log('\n[2] isPickerFresh —— 裸数字什么时候才算"选会话"')

await t('刚发过名单 + 在时间窗内 → 有效', () => {
  assert.equal(isPickerFresh({ pickerAt: NOW - 1000, ids: ['a', 'b'] }, NOW), true)
})

await t(`超过 ${PICK_WINDOW_MS / 60000} 分钟 → 失效（此后数字恢复成普通文本）`, () => {
  assert.equal(isPickerFresh({ pickerAt: NOW - PICK_WINDOW_MS - 1, ids: ['a'] }, NOW), false)
})

await t('没发过名单 / 名单是空的 → 失效（名单与时刻缺一不可）', () => {
  assert.equal(isPickerFresh({ pickerAt: NOW, ids: [] }, NOW), false)
  assert.equal(isPickerFresh({ pickerAt: 0, ids: ['a'] }, NOW), false)
  assert.equal(isPickerFresh({}, NOW), false)
  assert.equal(isPickerFresh(null, NOW), false)
})

console.log('\n[3] routeMessage 优先级 —— 这里是整条链路最容易出错的地方')

await t('★ 有提问在等 + 回「1」→ 作答，**不是**选会话', () => {
  const r = routeMessage({
    text: '1', refIdx: '', hasPendingQuestion: true, refTarget: null, pickerActive: true,
  })
  assert.equal(r.kind, 'answer', 'agent 卡在提问上等这个 1，绝不能拿去切会话')
  assert.equal(r.text, '1')
})

await t('★ 有引用 + 回「2」→ 回到被引用的那个会话，选会话让位', () => {
  const r = routeMessage({
    text: '2',
    refIdx: 'REFIDX_x',
    hasPendingQuestion: false,
    refTarget: { sessionId: 's9', session: '主会话', kind: 'prompt' },
    pickerActive: true,
  })
  assert.equal(r.kind, 'prompt')
  assert.equal(r.sessionId, 's9')
})

await t('刚看过名单 + 回「3」→ 选第 3 个会话', () => {
  const r = routeMessage({
    text: '3', refIdx: '', hasPendingQuestion: false, refTarget: null, pickerActive: true,
  })
  assert.equal(r.kind, 'pick_session')
  assert.equal(r.index, 3)
})

await t('回「0」→ 也是一次选择（0 = 取消指定）', () => {
  const r = routeMessage({
    text: '0', refIdx: '', hasPendingQuestion: false, refTarget: null, pickerActive: true,
  })
  assert.equal(r.kind, 'pick_session')
  assert.equal(r.index, 0)
})

await t('没看过名单时回「3」→ 还是闲聊（数字不能凭空变成选会话）', () => {
  const r = routeMessage({
    text: '3', refIdx: '', hasPendingQuestion: false, refTarget: null, pickerActive: false,
  })
  assert.equal(r.kind, 'chat')
})

await t('名单有效期内回一句非数字 → 仍然是闲聊', () => {
  const r = routeMessage({
    text: '在吗', refIdx: '', hasPendingQuestion: false, refTarget: null, pickerActive: true,
  })
  assert.equal(r.kind, 'chat')
})

await t('/sessions → 列名单；/sessions 3 与 /use 3 等价；都不是"闲聊"', () => {
  const a = routeMessage({ text: '/sessions', refIdx: '', hasPendingQuestion: false, refTarget: null })
  assert.equal(a.kind, 'sessions')
  for (const [raw, idx] of [['/sessions 3', 3], ['/use 3', 3], ['/use 0', 0], ['/切换 2', 2]]) {
    const r = routeMessage({ text: raw, refIdx: '', hasPendingQuestion: false, refTarget: null })
    assert.equal(r.kind, 'pick_session', `${raw} → ${r.kind}`)
    assert.equal(r.index, idx, raw)
  }
})

await t('/use 后面没跟数字 → 给用法，不静默当闲聊', () => {
  const r = routeMessage({ text: '/use', refIdx: '', hasPendingQuestion: false, refTarget: null })
  assert.equal(r.kind, 'usage')
  assert.ok(r.text.includes('/use 3'), r.text)
})

await t('显式指令优先于"有提问在等"（/sessions 不会被当成作答）', () => {
  const r = routeMessage({ text: '/sessions', refIdx: '', hasPendingQuestion: true, refTarget: null })
  assert.equal(r.kind, 'sessions')
})

console.log('\n[4] formatStatusText —— 当前会话必须看得见')

await t('指定过会话时，/status 里有一行明确说"你说的话现在进哪儿"', () => {
  const text = formatStatusText({ channelOn: true, sessions: SIX, activeId: 's2' })
  assert.ok(text.includes('你说的话现在进'), text)
  assert.ok(text.includes('插件优化'), text)
  assert.ok(text.includes('/sessions'), '要告诉主人怎么换回来')
})

await t('没指定过就不加这一行（默认状态不该多一行噪音）', () => {
  const text = formatStatusText({ channelOn: true, sessions: SIX })
  assert.ok(!text.includes('你说的话现在进'), text)
})

await t('指定的会话已经不在了 → 如实说，不显示一串 sessionId', () => {
  const text = formatStatusText({ channelOn: true, sessions: SIX, activeId: 'gone-id' })
  assert.ok(text.includes('已经不在了'), text)
})

console.log('\n[5] formatPickAck —— 四种结果都要说清楚')

await t('成功：会话名 + 怎么换回来', () => {
  const s = formatPickAck('ok', { title: '插件优化' })
  assert.ok(s.includes('插件优化'), s)
  assert.ok(s.includes('/sessions'), s)
  assert.ok(s.startsWith('✅'), s)
})

await t('★ 会话没了：明说"已经不在了"，绝不静默换一个', () => {
  const s = formatPickAck('gone', { index: 2, title: '插件优化' })
  assert.ok(s.includes('已经不在了'), s)
  assert.ok(s.includes('插件优化'), s)
  assert.ok(s.includes('2'), s)
})

await t('编号越界：带上实际条数（而不是只说一句"错了"）', () => {
  const s = formatPickAck('out-of-range', { index: 9, count: 6 })
  assert.ok(s.includes('9'), s)
  assert.ok(s.includes('6'), s)
})

await t('取消指定 / 没有名单：各有一句人话', () => {
  assert.ok(formatPickAck('cleared').includes('闲聊'), formatPickAck('cleared'))
  assert.ok(formatPickAck('out-of-range', { index: 1, count: 0 }).includes('/sessions'))
  assert.ok(formatPickAck('nonsense').length > 0)
})

console.log('\n[6] BotState —— 指针真的落盘，老状态文件也不会崩')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pick-'))
const file = path.join(dir, 'qq-bot-state.json')

await t('新状态：默认没指定会话、名单为空', () => {
  const st = new BotState(file)
  assert.equal(st.data.activeSessionId, null)
  assert.deepEqual(st.data.pickerIds, [])
  assert.equal(st.data.pickerAt, 0)
})

await t('set 之后**真的写进了文件**，重新打开还在（重启 DSH 也不丢）', () => {
  const st = new BotState(file)
  st.set({ activeSessionId: 's2', pickerAt: NOW, pickerIds: ['s1', 's2'] })
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.activeSessionId, 's2', '指针必须落盘')
  assert.deepEqual(raw.pickerIds, ['s1', 's2'], '名单也要落盘：编号要按你看到的那份解析')
  const again = new BotState(file)
  assert.equal(again.data.activeSessionId, 's2')
  assert.deepEqual(again.data.pickerIds, ['s1', 's2'])
  assert.equal(isPickerFresh(again.data, NOW + 1000), true)
})

await t('老版本状态文件（没有这几个键）读进来补默认值，不崩', () => {
  const legacy = path.join(dir, 'legacy.json')
  fs.writeFileSync(legacy, JSON.stringify({ openId: 'o', sessionId: 'x', seen: [] }), 'utf8')
  const st = new BotState(legacy)
  assert.equal(st.data.activeSessionId, null)
  assert.deepEqual(st.data.pickerIds, [])
  assert.equal(st.data.pickerAt, 0)
  assert.equal(isPickerFresh(st.data, NOW), false)
})

await t('取消指定就是把它置空（覆盖掉旧值，不是删键）', () => {
  const st = new BotState(file)
  st.set({ activeSessionId: null })
  assert.equal(new BotState(file).data.activeSessionId, null)
})

fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n${'─'.repeat(60)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`)
  process.exit(1)
}
console.log('全部通过 ✅')
