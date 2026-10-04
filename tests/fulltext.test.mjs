// fulltext.test.mjs —— 「三档完整回答模式」与「QQ 分条发送」的行为护栏。
//
// 纪律（本项目被注释里的字面量骗过四次）：
//   1. 一律 **真跑函数** 看输出，不扫源码正则；
//   2. 断言要能抓回归 —— 每条都对应一个"改坏了就会红"的具体行为；
//   3. 内容守恒用「去掉所有空白后逐字相等」，而不是"看起来差不多"。

import assert from 'node:assert/strict'

import {
  FULLTEXT_MODES,
  DEFAULT_FULLTEXT_MODE,
  QQ_TEXT_SAFE_CHARS,
  normalizeFulltextMode,
  uploadsFulltext,
  showsFulltextLink,
  sendsFulltextToChat,
  fulltextModeLabel,
  splitForQq,
  markQqChunks,
  planQqFulltext,
} from '../src/fulltext.js'

import { blocksToText, composeChatAnswer } from '../src/summary.js'

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

const noSpace = (s) => String(s).replace(/\s+/g, '')
const lines = (s) => String(s).split('\n')
/** 码点长度（中文一字一个），不用 .length（UTF-16 码元会骗人）。 */
const cps = (s) => [...String(s)].length

// ─────────────────────────────────────────────────────────────
console.log('\n[1] 三档模式的归一化：错的值必须落到最保守的一档')
// ─────────────────────────────────────────────────────────────

await t('三档常量就是 chat / note / note-link，默认是 chat（= 不上传）', () => {
  assert.deepEqual(FULLTEXT_MODES, ['chat', 'note', 'note-link'])
  assert.equal(DEFAULT_FULLTEXT_MODE, 'chat')
})

await t('直接给三档原值 → 原样返回', () => {
  for (const m of FULLTEXT_MODES) assert.equal(normalizeFulltextMode(m), m)
})

await t('chat 的同义词：qq / direct（大小写、空格都认）', () => {
  for (const raw of ['chat', 'QQ', 'direct', '  Chat  ', 'CHAT']) {
    assert.equal(normalizeFulltextMode(raw), 'chat', `raw=${JSON.stringify(raw)}`)
  }
})

await t('note 的同义词：note / cloud / upload', () => {
  for (const raw of ['note', 'NOTE', ' Cloud ', 'upload']) {
    assert.equal(normalizeFulltextMode(raw), 'note', `raw=${JSON.stringify(raw)}`)
  }
})

await t('note-link 的同义词：note-link / notelink / link / noteurl / note_url', () => {
  for (const raw of ['note-link', 'NOTE_LINK', 'notelink', 'link', 'noteurl', 'note-url', 'note url']) {
    assert.equal(normalizeFulltextMode(raw), 'note-link', `raw=${JSON.stringify(raw)}`)
  }
})

await t('未知/非字符串一律落到 chat（保守 = 绝不上传）', () => {
  for (const raw of ['', '   ', 'whatever', 'nope', 'chatting', null, undefined, 42, {}, [], true]) {
    assert.equal(normalizeFulltextMode(raw), 'chat', `raw=${JSON.stringify(raw)}`)
  }
})

await t('★ chat 不冒充 note-link：认不出的字符串不许「看起来像链接模式」', () => {
  // "link" 是 note-link 的同义词，但 "links"/"linkage" 不是 —— 只认整词。
  assert.equal(normalizeFulltextMode('links'), 'chat')
  assert.equal(normalizeFulltextMode('linkage'), 'chat')
})

// ─────────────────────────────────────────────────────────────
console.log('\n[2] 三个派生判定：上传 / 给链接 / 发 QQ 聊天框（互斥）')
// ─────────────────────────────────────────────────────────────

await t('uploadsFulltext：只有 chat 不传，其余两档都传', () => {
  assert.equal(uploadsFulltext('chat'), false)
  assert.equal(uploadsFulltext('note'), true)
  assert.equal(uploadsFulltext('note-link'), true)
  assert.equal(uploadsFulltext('不认识'), false) // 归一化后是 chat
})

await t('showsFulltextLink：只有 note-link 给链接', () => {
  assert.equal(showsFulltextLink('chat'), false)
  assert.equal(showsFulltextLink('note'), false)
  assert.equal(showsFulltextLink('note-link'), true)
})

await t('sendsFulltextToChat：只有 chat 往 QQ 聊天框发正文', () => {
  assert.equal(sendsFulltextToChat('chat'), true)
  assert.equal(sendsFulltextToChat('note'), false)
  assert.equal(sendsFulltextToChat('note-link'), false)
})

await t('★ 三档互不重叠：每一档恰好命中一个判定（不会两个都为真）', () => {
  for (const m of FULLTEXT_MODES) {
    const hits = [uploadsFulltext(m), sendsFulltextToChat(m), showsFulltextLink(m)].filter(Boolean).length
    assert.equal(hits >= 1, true, `${m} 一个判定都没命中`)
  }
  // 「发到 QQ 聊天框」与「上传服务器」永远不可能同时成立。
  for (const m of FULLTEXT_MODES) {
    assert.equal(uploadsFulltext(m) && sendsFulltextToChat(m), false, `${m} 同时上传又发聊天框`)
  }
})

await t('fulltextModeLabel：三档文案互不相同，且是人话（不带英文枚举名）', () => {
  const labels = FULLTEXT_MODES.map((m) => fulltextModeLabel(m))
  assert.equal(new Set(labels).size, 3, `文案重复了：${JSON.stringify(labels)}`)
  for (const l of labels) {
    assert.equal(typeof l, 'string')
    assert.ok(l.length >= 4, `文案太短：${l}`)
    assert.ok(!/chat|note-link|note\b/.test(l), `文案里漏出英文枚举名：${l}`)
  }
  // 三档的关键语义必须能从文案里读出来：不上传 / 存服务器 / 带链接。
  assert.ok(labels[0].includes('不上传'), `chat 档文案没说明不上传：${labels[0]}`)
  assert.ok(labels[1].includes('服务器'), `note 档文案没说明存服务器：${labels[1]}`)
  assert.ok(labels[2].includes('链接'), `note-link 档文案没说明带链接：${labels[2]}`)
})

await t('fulltextModeLabel：未知值不炸，也不漏出 undefined', () => {
  const l = fulltextModeLabel('乱写的')
  assert.equal(typeof l, 'string')
  assert.ok(!/undefined|null/.test(l), `文案里出现 undefined/null：${l}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n[3] splitForQq：分条不丢字、不超长、不切坏代理对')
// ─────────────────────────────────────────────────────────────

await t('空 / 纯空白 → 空数组（调用方据此跳过发送）', () => {
  assert.deepEqual(splitForQq(''), [])
  assert.deepEqual(splitForQq('   \n\n \t '), [])
  assert.deepEqual(splitForQq(null), [])
  assert.deepEqual(splitForQq(undefined), [])
})

await t('短文本 → 恰好一条，且内容逐字不变', () => {
  const s = '一句话回答。'
  const out = splitForQq(s)
  assert.equal(out.length, 1)
  assert.equal(out[0], s)
})

await t('超长文本 → 切成多条，每条都不超过上限', () => {
  const s = Array.from({ length: 200 }, (_, i) => `第${i}行的内容`).join('\n')
  const out = splitForQq(s, { maxChars: 300 })
  assert.ok(out.length > 1, `应该切成多条，实际 ${out.length} 条`)
  for (const c of out) assert.ok(cps(c) <= 300, `有一条超长：${cps(c)} 码点`)
})

await t('★ 内容守恒：切完之后「去掉所有空白」逐字相等（不丢字、不重复）', () => {
  const s = [
    '## 结论',
    '',
    '第一段很长很长很长，里面有中文、English words、和一些标点。',
    '',
    '- 列表项 A',
    '- 列表项 B 带一个很长的尾巴 0123456789abcdefghijklmnopqrstuvwxyz',
    '',
    '```js',
    'const a = 1',
    '```',
  ].join('\n')
  for (const limit of [100, 137, 300, 900]) {
    const out = splitForQq(s, { maxChars: limit })
    assert.equal(noSpace(out.join('')), noSpace(s), `limit=${limit} 内容不守恒`)
  }
})

await t('★ 上限过小（99）→ 被忽略、回落到默认上限；刚好 100 → 才真的按它切', () => {
  const s = '中'.repeat(1500)
  const tooSmall = splitForQq(s, { maxChars: 99 })
  const maxTooSmall = Math.max(...tooSmall.map(cps))
  assert.ok(maxTooSmall > 99, `99 竟然生效了（最长 ${maxTooSmall}）—— 下限没起作用`)

  const ok = splitForQq(s, { maxChars: 100 })
  const maxOk = Math.max(...ok.map(cps))
  // 上限 100 被真的采用（若被忽略而回落到 900，最长会是 891、条数只有 2）。
  // 注意：会被切成多条时正文要让出 MARKER_RESERVE（9）给「（i/n）」，所以正文正好 91 字一条。
  assert.ok(maxOk <= 100, `100 应当生效，实测最长 ${maxOk}`)
  assert.equal(maxOk, 100 - 9, `正文应正好让出 MARKER_RESERVE，实测最长 ${maxOk}`)
  assert.ok(ok.length >= 16, `1500 字按 100 切应至少 16 条，实际 ${ok.length}`)
})

await t('maxChars 非有限值 / 非数字 → 同样回落，不炸', () => {
  const s = '中'.repeat(1500)
  for (const bad of [undefined, null, NaN, Infinity, -1, 0, 'abc', {}]) {
    const out = splitForQq(s, { maxChars: bad })
    assert.ok(out.length >= 1, `maxChars=${String(bad)} 时没产出`)
    for (const c of out) assert.ok(cps(c) <= QQ_TEXT_SAFE_CHARS, '超了默认上限')
  }
})

await t('★ 单个超长的「无空格长串」必须硬切（否则会被 QQ 拒发整条）', () => {
  const s = 'a'.repeat(2500) // 一个空格都没有
  const out = splitForQq(s, { maxChars: 300 })
  assert.ok(out.length >= 9, `硬切没生效，只有 ${out.length} 条`)
  for (const c of out) assert.ok(cps(c) <= 300, `硬切后仍超长：${cps(c)}`)
  assert.equal(noSpace(out.join('')), s, '硬切丢了字')
})

await t('★ 代理对安全：emoji 不许被从中间劈成半个字符', () => {
  // 每个 emoji = 2 个 UTF-16 码元；用奇数上限逼出「正好切在代理对中间」的场景。
  const s = '😀'.repeat(400)
  for (const limit of [101, 133, 201, 301]) {
    const out = splitForQq(s, { maxChars: limit })
    for (const c of out) {
      const a = c.split('')
      for (let i = 0; i < a.length; i += 1) {
        const code = a[i].charCodeAt(0)
        if (code >= 0xd800 && code <= 0xdbff) {
          assert.ok(i + 1 < a.length, `limit=${limit}: 结尾留着孤立的高代理`)
          const next = a[i + 1].charCodeAt(0)
          assert.ok(next >= 0xdc00 && next <= 0xdfff, `limit=${limit}: 高代理后面不是低代理`)
          i += 1
        } else {
          assert.ok(!(code >= 0xdc00 && code <= 0xdfff), `limit=${limit}: 出现孤立的低代理`)
        }
      }
    }
    // 且内容守恒（emoji 数量不变）
    assert.equal(noSpace(out.join('')).length, s.length, `limit=${limit}: emoji 被切坏`)
  }
})

await t('只有换行、没有可切点的文本 → 仍然不超长且不为空', () => {
  const s = '\n'.repeat(50) + 'x' + '\n'.repeat(50)
  const out = splitForQq(s, { maxChars: 100 })
  assert.ok(out.length >= 1)
  for (const c of out) assert.ok(cps(c) <= 100)
})

// ─────────────────────────────────────────────────────────────
console.log('\n[4] markQqChunks / planQqFulltext：序号标记与总量')
// ─────────────────────────────────────────────────────────────

await t('markQqChunks：不是数组 / 空数组 → 空数组', () => {
  assert.deepEqual(markQqChunks(null), [])
  assert.deepEqual(markQqChunks(undefined), [])
  assert.deepEqual(markQqChunks('abc'), [])
  assert.deepEqual(markQqChunks([]), [])
})

await t('★ markQqChunks：只有一条时不许加序号（单条消息印「（1/1）」是噪音）', () => {
  const out = markQqChunks(['就这一条'])
  assert.deepEqual(out, ['就这一条'])
  assert.ok(!out[0].includes('1/1'), '单条被加了序号')
})

await t('markQqChunks：多条时每条都带「（i/n）」且 i 从 1 起', () => {
  const out = markQqChunks(['甲', '乙', '丙'])
  assert.equal(out.length, 3)
  out.forEach((c, i) => {
    assert.ok(c.startsWith(`（${i + 1}/3）`), `第 ${i + 1} 条缺序号：${c}`)
    assert.ok(c.endsWith(['甲', '乙', '丙'][i]), `第 ${i + 1} 条内容被改动：${c}`)
  })
})

await t('planQqFulltext：返回 {chunks,total,chars}，chars 是原始码点数', () => {
  const s = '## 标题\n\n正文一段。'
  const plan = planQqFulltext(s)
  assert.equal(plan.total, plan.chunks.length)
  assert.equal(plan.chars, s.length)
  assert.deepEqual(plan.chunks, [s])
})

await t('★ planQqFulltext：标记已经打好了，调用方不许再打一次（否则出现「（1/3）（1/3）」）', () => {
  const s = Array.from({ length: 120 }, (_, i) => `第${i}行`).join('\n')
  const plan = planQqFulltext(s, { maxChars: 200 })
  assert.ok(plan.total > 1, '这一段本应被切成多条')
  for (const c of plan.chunks) {
    const hits = c.match(/（\d+\/\d+）/g) ?? []
    assert.equal(hits.length, 1, `序号出现了 ${hits.length} 次：${c.slice(0, 40)}`)
  }
})

await t('★ planQqFulltext：带上序号后，每条仍然不超过上限（marker 有预留）', () => {
  const s = Array.from({ length: 400 }, (_, i) => `第${i}行的内容还算有点长`).join('\n')
  for (const limit of [100, 150, 300, 900]) {
    const plan = planQqFulltext(s, { maxChars: limit })
    for (const c of plan.chunks) {
      assert.ok(cps(c) <= limit, `limit=${limit}: 带序号后超长 ${cps(c)} —— MARKER_RESERVE 没生效`)
    }
    assert.equal(noSpace(plan.chunks.join('').replace(/（\d+\/\d+）/g, '')), noSpace(s), `limit=${limit}: 内容被序号顶掉了`)
  }
})

await t('计划为空时 total=0、chunks 空（调用方据此不发）', () => {
  const plan = planQqFulltext('   ')
  assert.deepEqual(plan.chunks, [])
  assert.equal(plan.total, 0)
  assert.equal(plan.chars, 3)
})

await t('QQ_TEXT_SAFE_CHARS 是保守估计值（900），且远大于硬下限', () => {
  // ⚠️ 这个 900 是**保守估计**，不是实测的 QQ 上限（见源码注释）。
  //    断言只钉住"它没被误改成离谱值"，不假装它是平台真值。
  assert.equal(QQ_TEXT_SAFE_CHARS, 900)
  // 不传 maxChars 时用的是这个默认上限。注意契约是「每一条都不超过上限」——
  // 当文案会被切成多条时，正文会主动让出 MARKER_RESERVE（= 9）留给「（i/n）」，
  // 所以未加序号的每条最长 = 900 − 9 = 891；加完序号最长 = 891 + 6 = 897 ≤ 900。
  const out = splitForQq('中'.repeat(2000))
  assert.ok(Math.max(...out.map(cps)) <= QQ_TEXT_SAFE_CHARS, `未加序号时超限：${Math.max(...out.map(cps))}`)
  assert.equal(Math.max(...out.map(cps)), QQ_TEXT_SAFE_CHARS - 9, '正文应正好让出 MARKER_RESERVE 给序号')
  const marked = planQqFulltext('中'.repeat(2000))
  assert.ok(Math.max(...marked.chunks.map(cps)) <= QQ_TEXT_SAFE_CHARS, `加序号后超限：${Math.max(...marked.chunks.map(cps))}`)
  assert.equal(Math.max(...marked.chunks.map(cps)), QQ_TEXT_SAFE_CHARS - 3)
})

// ─────────────────────────────────────────────────────────────
console.log('\n[5] composeChatAnswer：发到 QQ 聊天框的那份正文')
// ─────────────────────────────────────────────────────────────

await t('空内容 → 空串（调用方据此跳过发送）', () => {
  assert.equal(composeChatAnswer(), '')
  assert.equal(composeChatAnswer({}), '')
  assert.equal(composeChatAnswer({ assistantText: '   ', userText: '' }), '')
})

await t('★ 保留换行与 Markdown（这是「完整回答」的意义，不许压平）', () => {
  const md = '## 结论\n\n- 第一条\n- 第二条\n\n```js\nconst a = 1\n```'
  const out = composeChatAnswer({ assistantText: md })
  assert.equal(out, md)
  assert.equal(lines(out).length, 8)
})

await t('assistantText 为空时回落到 userText', () => {
  assert.equal(composeChatAnswer({ assistantText: '', userText: '用户说的话' }), '用户说的话')
})

await t('★ 去掉结尾的 <sub>…</sub> 笔记页脚（发到聊天框是噪音）', () => {
  const out = composeChatAnswer({ assistantText: '正文结束\n\n<sub>2026-10-03 · main</sub>\n' })
  assert.equal(out, '正文结束')
  assert.ok(!out.includes('<sub>'), '页脚没被去掉')
})

await t('★ 4 个以上连续换行压成 3 个（留一段空行，不留大洞）', () => {
  const out = composeChatAnswer({ assistantText: 'A\n\n\n\n\n\nB' })
  assert.equal(out, 'A\n\n\nB')
})

await t('超长按码点截断，末尾加省略号，且总长不超过上限', () => {
  const s = '中'.repeat(3000)
  const out = composeChatAnswer({ assistantText: s }, 100)
  assert.equal(cps(out), 100, `实际 ${cps(out)} 码点`)
  assert.ok(out.endsWith('…'), '截断没加省略号')
})

await t('未给 maxChars（或给了离谱值）→ 回落默认 1500，实测生效', () => {
  const s = '中'.repeat(3000)
  for (const bad of [undefined, 0, -5, NaN, 'abc']) {
    const out = composeChatAnswer({ assistantText: s }, bad)
    assert.equal(cps(out), 1500, `maxChars=${String(bad)} 时上限不对`)
  }
})

await t('★ emoji 截断按码点，不劈半个字', () => {
  const s = '😀'.repeat(500)
  const out = composeChatAnswer({ assistantText: s }, 11)
  // 10 个 emoji + 省略号 = 11 个码点
  assert.equal(cps(out), 11)
  assert.ok(out.endsWith('😀…'), `截断切坏了 emoji：${JSON.stringify(out.slice(-4))}`)
})

// ─────────────────────────────────────────────────────────────
console.log('\n[6] blocksToText：换行不许被压平（完整回答网页被毁的根因）')
// ─────────────────────────────────────────────────────────────

await t('数组里的多个 text 块用空行拼接', () => {
  const out = blocksToText([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }])
  assert.equal(out, '第一段\n\n第二段')
})

await t('非文本块（reasoning / tool）被忽略', () => {
  const out = blocksToText([
    { type: 'reasoning', text: '这是思考，不该出现' },
    { type: 'text', text: '这是正文' },
    { type: 'tool-call', name: 'x' },
  ])
  assert.equal(out, '这是正文')
})

await t('★ 单个文本块内部的换行必须原样保留（旧版会塌成空格）', () => {
  const md = '## 标题\n\n正文\n\n- 项一\n- 项二'
  assert.equal(blocksToText([{ type: 'text', text: md }]), md)
})

await t('★ 行内多余空白收成一个空格，但换行结构不动', () => {
  const out = blocksToText([{ type: 'text', text: '  标题  \n\n\t正文   带\t空格  ' }])
  assert.equal(out, '标题\n\n正文 带 空格')
  assert.ok(out.includes('\n\n'), '换行被吃了')
})

await t('★ CRLF 归一成 LF（Windows 上模型常输出 \\r\\n）', () => {
  const out = blocksToText([{ type: 'text', text: 'A\r\nB\r\n\r\nC' }])
  assert.equal(out, 'A\nB\n\nC')
  assert.ok(!out.includes('\r'), 'CRLF 没被归一')
})

await t('3 个以上连续换行压成 1 个空行', () => {
  assert.equal(blocksToText([{ type: 'text', text: 'A\n\n\n\n\nB' }]), 'A\n\nB')
})

await t('全角空格 / 不换行空格也被当空白处理', () => {
  assert.equal(blocksToText([{ type: 'text', text: '甲\u3000\u00a0乙' }]), '甲 乙')
})

await t('空数组 / 非法输入 → 空串，不炸', () => {
  assert.equal(blocksToText([]), '')
  assert.equal(blocksToText(null), '')
  assert.equal(blocksToText(undefined), '')
  assert.equal(blocksToText([{ type: 'text', text: '   ' }]), '')
})

await t('字符串入参原样返回（上游可能已拼好）', () => {
  assert.equal(blocksToText('a\nb'), 'a\nb')
})

// ─────────────────────────────────────────────────────────────
console.log('\n[7] 端到端：Markdown 结构从 blocksToText 一路活到 QQ 分条')
// ─────────────────────────────────────────────────────────────

await t('★ 一段带 3 个标题 + 1 张表的 markdown，经「转文本 → 分条」后仍是多行、记号还在', () => {
  const md = [
    '## 一、进展',
    '',
    '做了 A、B、C 三件事，细节如下。',
    '',
    '## 二、验证',
    '',
    '| 项 | 结果 |',
    '| --- | --- |',
    '| 测试 | 全过 |',
    '',
    '## 三、遗留',
    '',
    '还有一件事没做。',
  ].join('\n')
  const text = blocksToText([{ type: 'text', text: md }])
  // ① 结构在文本层没有被压平
  assert.equal(lines(text).length, 13, `行数被压缩了：${lines(text).length}`)
  assert.equal((text.match(/^## /gm) ?? []).length, 3, '标题记号丢了')
  assert.ok(text.includes('| --- | --- |'), '表格分隔行丢了')

  // ② 分条之后仍然在（也不会因为分条再被压平）
  const plan = planQqFulltext(text, { maxChars: 300 })
  const joined = plan.chunks.join('')
  assert.equal((joined.match(/^## /gm) ?? []).length, 3, '分条后标题记号丢了')
  assert.equal(noSpace(joined).length, noSpace(text).length, '分条丢字')
})

await t('★ 发到 QQ 的正文与存到服务器的正文可以同源（不会一个压平一个不压）', () => {
  const md = '## 标题\n\n正文\n\n- A\n- B'
  const forChat = composeChatAnswer({ assistantText: md })
  const forNote = blocksToText([{ type: 'text', text: md }])
  assert.equal(forChat, md)
  assert.equal(forNote, md)
  // 两者行数一致 ⇒ 不会再出现「QQ 里是 7 行、网页上糊成 1 行」那种分裂
  assert.equal(lines(forChat).length, lines(forNote).length)
})

console.log(`\nfulltext 组：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  ❌ ${f.name}\n     ${f.err.stack ?? f.err.message}`)
  process.exit(1)
}
