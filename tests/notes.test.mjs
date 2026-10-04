/**
 * 会话「完整回答」（notes.js）单测。
 *
 * 全程**纯逻辑、不需要 DSH、不需要服务器**：notes.js 只用内置 fetch，
 * 测试自己注入假的 fetch —— 所以这些用例跑得飞快，也不会真往公网发东西。
 *
 * 重点锁死三类"静默失效"（本项目吃过太多亏）：
 *   1. 渲染出的 markdown 必须**自洽**：标题、元信息、两段正文都在；
 *      截断时必须**说明清楚**，不能让人以为这就是全部。
 *   2. 上传**任何失败都不许抛异常** —— 推送不能因为服务器抽风而丢通知。
 *   3. 超时必须真的生效：服务器卡住时不能把通知一直挂在那里等。
 *
 * 运行：node tests/notes.test.mjs（需先 node scripts/build.mjs）
 */

import assert from 'node:assert/strict'

const M = await import('../lib/notes.js')

let passed = 0
let failed = 0

/**
 * 极简断言包装。
 * @param {string} name - 用例名。
 * @param {() => void | Promise<void>} fn - 用例体。
 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${name}\n      ${err?.stack ?? err}`)
  }
}

/** 造一个假 fetch 响应。 */
function fakeRes({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  }
}

console.log('\n[1] makeNoteId —— 短链接里那串随机字符')

await test('默认 5 位，且只用 [a-z0-9]', () => {
  const id = M.makeNoteId()
  assert.equal(id.length, 5)
  assert.match(id, /^[a-z0-9]{5}$/)
})

await test('长度可配，且非法长度会退回默认值', () => {
  assert.equal(M.makeNoteId(9).length, 9)
  assert.equal(M.makeNoteId(4, () => 0).length, 4)
  assert.equal(M.makeNoteId(0).length, M.DEFAULT_ID_LENGTH, '0 应退回默认')
  assert.equal(M.makeNoteId(Number.NaN).length, M.DEFAULT_ID_LENGTH, 'NaN 应退回默认')
})

await test('随机源可注入（random()=0 → 全是字符表第一位 a）', () => {
  assert.equal(M.makeNoteId(6, () => 0), 'aaaaaa')
})

await test('random() 接近 1 时也取得到最后一个字符（不越界、不 undefined）', () => {
  const id = M.makeNoteId(8, () => 0.999999)
  assert.equal(id.length, 8)
  assert.ok(!id.includes('undefined'), `不该出现 undefined：${id}`)
  assert.match(id, /^[a-z0-9]{8}$/)
})

console.log('\n[2] renderNote —— 渲染出的 markdown')

await test('formatStamp 稳定补零（不依赖 ICU，页面上的时间必须整齐）', () => {
  const s = M.formatStamp(new Date(2026, 9, 2, 4, 30, 5)) // 2026-10-02 04:30:05 本地时间
  assert.equal(s, '2026-10-02 04:30:05')
  assert.equal(M.formatStamp(new Date(2026, 0, 9, 23, 5, 0)), '2026-01-09 23:05:00')
})

await test('标题、工作区、会话 id、用户消息、回答都在', () => {
  const { markdown } = M.renderNote({
    session: 'main',
    sessionId: 'session-abc',
    cwd: 'D:\\cyanproject\\agenttool',
    at: new Date('2026-10-02T04:30:00+08:00'),
    user: '这个协作功能很重要',
    assistant: '已经写进插件了。',
  })
  assert.match(markdown, /^# main$/m)
  assert.ok(markdown.includes('D:\\cyanproject\\agenttool'), '要带工作区')
  assert.ok(markdown.includes('session-abc'), '要带会话 id')
  assert.ok(markdown.includes('这个协作功能很重要'), '要带用户原文')
  assert.ok(markdown.includes('已经写进插件了。'), '要带回答原文')
  assert.ok(markdown.includes('## 完整回答'), '要有「完整回答」小节')
})

await test('缺会话名时标题有兜底（不会渲染出 "# " 空标题）', () => {
  const { markdown } = M.renderNote({ assistant: 'x' })
  assert.ok(!/^#\s*$/m.test(markdown), '不该出现空标题')
  assert.match(markdown, /^# DSH 会话$/m)
})

await test('没有回答 / 没有提问时给占位文案，不崩也不留空段', () => {
  const a = M.renderNote({ session: 's', user: '你好' })
  assert.ok(a.markdown.includes('这一轮没有产生文本回答'))
  const b = M.renderNote({ session: 's', assistant: '嗨' })
  assert.ok(b.markdown.includes('这一轮没有新的用户输入'))
})

await test('超过上限时截断，并且**明确写出**这是截断（不能让人以为这就是全部）', () => {
  const long = 'x'.repeat(5000)
  const r = M.renderNote({ session: 's', assistant: long, maxChars: 100 })
  assert.equal(r.truncated, true)
  assert.equal(r.totalChars, 5000)
  assert.match(r.markdown, /已截断/, '必须说明被截断了')
  assert.ok(r.markdown.includes('完整 5000 字符'), '要告诉人原文有多长')
  assert.ok(r.markdown.length < 1000, '截断要真的生效')
})

await test('没超上限时 marked 未截断且原文逐字保留', () => {
  const body = '第一行\n\n```js\nconst a = 1\n```\n\n最后一行'
  const r = M.renderNote({ session: 's', assistant: body, maxChars: 20000 })
  assert.equal(r.truncated, false)
  assert.ok(r.markdown.includes(body), 'markdown 原文必须原样保留（含代码块）')
})

console.log('\n[3] publishNote —— 上传（一条都不能抛）')

await test('hubUrl 为空 → 返回 null，且不发请求', async () => {
  let called = false
  const r = await M.publishNote({
    hubUrl: '',
    markdown: '# x',
    fetchImpl: async () => { called = true; return fakeRes() },
  })
  assert.equal(r, null)
  assert.equal(called, false, '没配中枢就不该发请求')
})

await test('正文为空 → 返回 null，不浪费一次请求', async () => {
  let called = false
  const r = await M.publishNote({
    hubUrl: 'https://h',
    markdown: '   \n  ',
    fetchImpl: async () => { called = true; return fakeRes() },
  })
  assert.equal(r, null)
  assert.equal(called, false)
})

await test('拿不到 fetch 时返回 null（不抛）', async () => {
  // 传 0 而不是 null：`0 ?? globalThis.fetch` 仍是 0（?? 只对 null/undefined 回退），
  // 于是命中「环境里没有 fetch」那条分支 —— 不会真的出网。
  const r = await M.publishNote({ hubUrl: 'https://h', markdown: '# x', fetchImpl: 0, log: () => {} })
  assert.equal(r, null)
})

await test('成功路径：拿到 id/url，请求带 Bearer 与正确的 body', async () => {
  let seen = null
  const r = await M.publishNote({
    hubUrl: 'https://cyanovo.top:8444/dsh-hub/',
    token: 'tk_test',
    markdown: '# 标题\n\n正文',
    idLength: 6,
    session: 'main',
    fetchImpl: async (url, opts) => { seen = { url, opts }; return fakeRes({ body: { ok: true, id: 'abc123', url: 'https://cyanovo.top:8444/dsh/abc123.md', bytes: 42 } }) },
  })
  assert.equal(r.id, 'abc123')
  assert.equal(r.url, 'https://cyanovo.top:8444/dsh/abc123.md')
  assert.equal(seen.url, 'https://cyanovo.top:8444/dsh-hub/api/notes', '末尾斜杠要被规范掉')
  assert.equal(seen.opts.method, 'POST')
  assert.equal(seen.opts.headers.Authorization, 'Bearer tk_test')
  const body = JSON.parse(seen.opts.body)
  assert.equal(body.markdown, '# 标题\n\n正文')
  assert.equal(body.idLength, 6)
  assert.equal(body.session, 'main')
})

await test('没配 token 时不带 Authorization 头（中枢可能没开鉴权）', async () => {
  let seen = null
  await M.publishNote({
    hubUrl: 'https://h',
    markdown: '# x',
    fetchImpl: async (url, opts) => { seen = opts; return fakeRes({ body: { ok: true, id: 'a', url: 'https://h/a.md' } }) },
  })
  assert.equal(seen.headers.Authorization, undefined)
})

await test('服务器 500 → 返回 null（绝不抛）', async () => {
  const r = await M.publishNote({
    hubUrl: 'https://h',
    markdown: '# x',
    log: () => {},
    fetchImpl: async () => fakeRes({ ok: false, status: 500, body: { error: 'boom' } }),
  })
  assert.equal(r, null)
})

await test('200 但响应体不是 JSON → 返回 null（绝不抛）', async () => {
  const r = await M.publishNote({
    hubUrl: 'https://h',
    markdown: '# x',
    log: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json') } }),
  })
  assert.equal(r, null)
})

await test('网络异常（DNS/连接被拒）→ 返回 null（绝不抛）', async () => {
  const r = await M.publishNote({
    hubUrl: 'https://h',
    markdown: '# x',
    log: () => {},
    fetchImpl: async () => { throw new TypeError('fetch failed') },
  })
  assert.equal(r, null)
})

await test('★ 超时真的生效：服务器一直不响应时，到点就放弃（不挂住通知）', async () => {
  const t0 = Date.now()
  const r = await M.publishNote({
    hubUrl: 'https://h',
    markdown: '# x',
    timeoutMs: 400,
    log: () => {},
    // 模拟真实 fetch：只在 signal.abort 时拒绝
    fetchImpl: (url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('This operation was aborted')
        e.name = 'AbortError'
        reject(e)
      })
    }),
  })
  const spent = Date.now() - t0
  assert.equal(r, null)
  assert.ok(spent >= 300, `不该提前放弃（实际 ${spent}ms）`)
  assert.ok(spent < 3000, `必须在超时附近返回，实际 ${spent}ms`)
})

console.log(`\n通过 ${passed} / 失败 ${failed}\n`)
process.exit(failed === 0 ? 0 : 1)
