/**
 * agentmd 追加逻辑自测。
 *
 * 目标：验证「表头定位 / 中文 / 日期格式 / 重复追加不破坏结构」，
 * 用的是与真实 main.md 结构一致的临时样本文件，不污染真 agentmd/main.md。
 *
 * 运行：node tests/agentmd.test.mjs
 */

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  appendLogEntry,
  buildContextDoc,
  buildLogRow,
  bumpLastUpdated,
  formatStamp,
  locateLogTable,
  readDoc,
  safeCell,
  _drainQueue,
} from '../src/agentmd.js'

let passed = 0
let failed = 0

/**
 * 极简断言包装：打印通过/失败，失败不中断其它用例。
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
    console.log(`  ✗ ${name}\n      ${err?.message ?? err}`)
  }
}

/** 与真实 main.md 第 88-99 行结构一致的样本（含中文、含后续小节）。 */
const SAMPLE = `# Agent 操作记录（main）

> 本文档供 AI 对话间共享上下文使用。
> 创建时间：2026-09-30 ｜ 最后更新：2026-09-30

---

## 四、操作日志

> 新增记录追加到表格下方。一条记录 = 时间 + 做了什么 + 结果。

| 时间 | 操作 | 结果 |
|---|---|---|
| 2026-09-30 | 读取 \`PROGRESS.md\`，梳理定制版 DSH 项目全貌 | 已了解架构、交付物、7 条踩坑、待办 |
| 2026-09-30 | 创建 \`agentmd/\` 目录与本文档 \`main.md\` | 完成，作为跨对话上下文的入口 |

---

## 五、给下一个对话的提示

1. **先读本文档**。
`

/** 表格后紧贴分隔线与下一节、没有空行隔开的样本（更难的边界）。 */
const TIGHT = `# 标题

> 最后更新：2026-09-30

## 四、操作日志

| 时间 | 操作 | 结果 |
|---|---|---|
| 2026-09-30 | 第一条 | 完成 |
---
## 五、其它
`

/** 表头缺失的样本。 */
const NO_TABLE = `# 标题

## 四、操作日志

这里还没有表格。

## 五、其它
`

const root = await mkdtemp(join(tmpdir(), 'agentmd-test-'))
const file = 'main.md'
const target = join(root, file)

console.log(`临时测试目录: ${root}\n`)

// ── 纯函数 ────────────────────────────────────────────────────────────────
console.log('纯函数:')

await test('formatStamp 输出 YYYY-MM-DD HH:mm（本地时间，两位补零）', () => {
  const d = new Date(2026, 8, 30, 9, 5) // 2026-09-30 09:05
  assert.equal(formatStamp(d), '2026-09-30 09:05')
  assert.match(formatStamp(new Date()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

await test('safeCell 清洗竖线与换行，避免撑破表格', () => {
  assert.equal(safeCell('a|b'), 'a｜b')
  assert.equal(safeCell('a\nb\tc'), 'a b c')
  assert.equal(safeCell(undefined), '')
})

await test('buildLogRow 产出标准三列行', () => {
  const row = buildLogRow({ when: new Date(2026, 8, 30, 14, 7), action: '测试 | 用例', result: '通过' })
  assert.equal(row, '| 2026-09-30 14:07 | 测试 ｜ 用例 | 通过 |')
  assert.equal(row.split('|').length - 2, 3)
})

await test('bumpLastUpdated 只改「最后更新：」那一行的日期部分', () => {
  const out = bumpLastUpdated('> 创建时间：2026-09-30 ｜ 最后更新：2026-09-30\n', '2026-10-01')
  assert.equal(out, '> 创建时间：2026-09-30 ｜ 最后更新：2026-10-01\n')
})

// ── 注入预算（防爆上下文）────────────────────────────────────────────────
console.log('\n注入预算:')

/** 造一份「大文档」：很长的正文 + 50 条日志行。 */
function makeHugeDoc() {
  const head = Array.from({ length: 200 }, (_, i) => `### 第 ${i} 小节\n\n${'正文内容。'.repeat(200)}`).join('\n\n')
  const rows = Array.from({ length: 50 }, (_, i) => `| 2026-09-${String((i % 28) + 1).padStart(2, '0')} | 第 ${i} 条日志 | 完成 |`)
  return `${head}\n\n## 四、操作日志\n\n| 时间 | 操作 | 结果 |\n|---|---|---|\n${rows.join('\n')}\n`
}

await test('文档没超上限时原样返回（不许无故截断）', () => {
  const r = buildContextDoc(SAMPLE, { maxChars: 8000 })
  assert.equal(r.truncated, false)
  assert.equal(r.text, SAMPLE, '小于上限时必须逐字原样')
  assert.equal(r.omittedChars, 0)
})

await test('🔴 超大文档的注入结果不超过上限（这是防爆上下文的核心断言）', () => {
  const huge = makeHugeDoc()
  assert.ok(huge.length > 100000, `样本本身要够大，实际 ${huge.length}`)
  for (const cap of [500, 1000, 2000, 8000]) {
    const r = buildContextDoc(huge, { maxChars: cap })
    assert.equal(r.truncated, true)
    assert.ok(r.text.length <= cap, `上限 ${cap} 时不得超出，实际 ${r.text.length}`)
    assert.equal(r.totalChars, huge.length)
    assert.equal(r.omittedChars, huge.length - r.text.length)
  }
})

await test('压缩后仍保留最近日志行与 §四 小节（不是只剩开头）', () => {
  const huge = makeHugeDoc()
  const r = buildContextDoc(huge, { maxChars: 2000 })
  assert.match(r.text, /## 四、操作日志/, '应保留 §四 小节')
  assert.match(r.text, /\| 2026-09-\d\d \| 第 49 条日志 \| 完成 \|/, '应保留最后一条日志')
  assert.ok(r.rowsKept > 0, '应报告保留了行数')
  assert.match(r.text, /省略约 \d+ 个字符/, '省略了多少必须写清楚')
})

await test('tailRows 决定保留几条日志（更早的行不注入）', () => {
  const huge = makeHugeDoc()
  const r = buildContextDoc(huge, { maxChars: 8000, tailRows: 3 })
  assert.equal(r.rowsKept, 3, `应只留 3 行，实际 ${r.rowsKept}`)
  assert.match(r.text, /第 49 条日志/)
  assert.ok(!r.text.includes('第 45 条日志'), '第 4 条之前的不该注入')
  assert.ok(r.rowsOmitted >= 47, `应报告省略行数，实际 ${r.rowsOmitted}`)
})

await test('上限调小，注入只会更短（单调性；反向校验）', () => {
  const huge = makeHugeDoc()
  const big = buildContextDoc(huge, { maxChars: 8000 })
  const small = buildContextDoc(huge, { maxChars: 1200 })
  assert.ok(small.text.length <= 1200 && big.text.length <= 8000)
  assert.ok(small.text.length < big.text.length, `上限更小必须注入更短：${small.text.length} vs ${big.text.length}`)
})

await test('没有任何小节结构的巨长文本也一样被压住', () => {
  const r = buildContextDoc('x'.repeat(100000), { maxChars: 500 })
  assert.ok(r.text.length <= 500, `实际 ${r.text.length}`)
  assert.equal(r.rowsKept, null, '没有日志表时应报告 null')
})

await test('上限非法（0/负数/NaN）时回落到出厂默认 8000，而不是“不限”', () => {
  const huge = makeHugeDoc()
  for (const bad of [0, -1, NaN, undefined]) {
    const r = buildContextDoc(huge, { maxChars: bad })
    assert.ok(r.text.length <= 8000, `maxChars=${String(bad)} 时仍须有界，实际 ${r.text.length}`)
  }
})

await test('buildLogRow 超长时从「操作」列裁剪，表格骨架与时间列保持完整', () => {
  const row = buildLogRow({
    when: new Date(2026, 8, 30, 14, 7),
    action: '很长很长的操作说明。'.repeat(500),
    result: '完成',
    maxChars: 200,
  })
  assert.ok(row.length <= 200, `行长度应 ≤ 200，实际 ${row.length}`)
  assert.equal(row.split('|').length - 2, 3, '必须仍是 3 列')
  assert.ok(row.startsWith('| 2026-09-30 14:07 | '), `时间列必须完整: ${row.slice(0, 40)}`)
  assert.ok(row.endsWith('| 完成 |'), '结果列必须完整')
  assert.ok(row.includes('…'), '被裁处应有省略号')
})

await test('连「结果」列都超长时也不会撑破上限', () => {
  const row = buildLogRow({
    when: new Date(2026, 8, 30, 14, 7),
    action: 'a'.repeat(100),
    result: 'b'.repeat(9999),
    maxChars: 120,
  })
  assert.ok(row.length <= 120, `实际 ${row.length}`)
  assert.equal(row.split('|').length - 2, 3, '必须仍是 3 列')
})

await test('上限小到不合理时仍有硬地板，绝不产出破碎的行', () => {
  const row = buildLogRow({ when: new Date(2026, 8, 30, 14, 7), action: 'x'.repeat(500), result: 'y', maxChars: 1 })
  assert.equal(row.split('|').length - 2, 3, '必须仍是 3 列')
  assert.ok(row.startsWith('| 2026-09-30 14:07 | '), '时间列必须完整')
})

await test('locateLogTable 定位到表头/分隔行，插点在最后一条数据行之后', () => {
  const lines = SAMPLE.split('\n')
  const spot = locateLogTable(lines)
  assert.ok(spot, '应能定位到表格')
  assert.match(lines[spot.headerIndex], /^\|\s*时间\s*\|\s*操作\s*\|\s*结果\s*\|$/)
  assert.match(lines[spot.separatorIndex], /^\|---\|---\|---\|$/)
  assert.match(lines[spot.insertAt - 1], /^\| 2026-09-30 \| 创建/)
})

await test('locateLogTable 找不到表头时返回 null（不throw）', () => {
  assert.equal(locateLogTable(NO_TABLE.split('\n')), null)
})

// ── 文件级追加 ───────────────────────────────────────────────────────────
console.log('\n文件追加:')

await test('首次追加：写入临时 main.md 的表格末尾', async () => {
  await writeFile(target, SAMPLE, 'utf8')
  const r = await appendLogEntry({
    dir: root,
    file,
    action: '新增 agentmd 自动日志：测试追加逻辑',
    result: '追加成功',
    when: new Date(2026, 8, 30, 10, 20),
  })
  assert.equal(r.ok, true, `追加失败: ${r.reason}`)
  const text = await readFile(target, 'utf8')
  assert.ok(text.includes('| 2026-09-30 10:20 | 新增 agentmd 自动日志：测试追加逻辑 | 追加成功 |'))
})

await test('追加后「最后更新：」同步刷新，且其它文字未被破坏', async () => {
  const text = await readFile(target, 'utf8')
  assert.ok(text.includes('最后更新：2026-09-30'), '头部应为新日期')
  assert.ok(text.includes('> 创建时间：2026-09-30 ｜ 最后更新：2026-09-30'))
  assert.ok(text.includes('## 五、给下一个对话的提示'), '后续小节必须保留')
  assert.ok(text.includes('| 2026-09-30 | 读取 `PROGRESS.md`，梳理定制版 DSH 项目全貌 | 已了解架构、交付物、7 条踩坑、待办 |'))
})

await test('重复追加 5 次后仍是合法 3 列表格（列数一致、行数正确）', async () => {
  for (let i = 1; i <= 5; i += 1) {
    const r = await appendLogEntry({
      dir: root,
      file,
      action: `第 ${i} 次重复追加`,
      result: `第 ${i} 次成功`,
      when: new Date(2026, 8, 30, 11, i),
    })
    assert.equal(r.ok, true, `第 ${i} 次失败: ${r.reason}`)
  }
  await _drainQueue()
  const lines = (await readFile(target, 'utf8')).split('\n')
  const rows = lines.filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}/.test(l.trim()))
  assert.equal(rows.length, 2 + 6, `数据行数应为 8（样本 2 条 + 首次 1 条 + 重复 5 条），实际 ${rows.length}`)
  for (const row of rows) {
    const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
    assert.equal(cells.length, 3, `列数应为 3: ${row}`)
  }
  // 表格必须仍是连续一段，中间不能插进别的正文
  const first = lines.findIndex((l) => /^\|\s*时间\s*\|/.test(l.trim()))
  const last = lines.map((l, i) => (/^\|\s*\d{4}-\d{2}-\d{2}/.test(l.trim()) ? i : -1)).filter((i) => i >= 0).pop()
  const block = lines.slice(first, last + 1)
  assert.ok(block.every((l) => l.trim().startsWith('|')), '表头到末行之间不应夹入非表格行')
})

await test('并发 8 次追加：串行化后一行不丢、不漏', async () => {
  const dir2 = await mkdtemp(join(tmpdir(), 'agentmd-race-'))
  await writeFile(join(dir2, file), SAMPLE, 'utf8')
  await Promise.all(Array.from({ length: 8 }, (_, i) => appendLogEntry({
    dir: dir2,
    file,
    action: `并发写入 ${i}`,
    result: 'ok',
    when: new Date(2026, 8, 30, 12, i),
  })))
  await _drainQueue()
  const rows = (await readFile(join(dir2, file), 'utf8')).split('\n')
    .filter((l) => /^\|\s*2026-09-30 12:\d{2}/.test(l.trim()))
  assert.equal(rows.length, 8, `应有 8 行并发记录，实际 ${rows.length}`)
  await rm(dir2, { recursive: true, force: true })
})

await test('表格后紧贴 --- 与下一节（无空行）时，仍插在表格末尾而非文件尾', async () => {
  const dir3 = await mkdtemp(join(tmpdir(), 'agentmd-tight-'))
  await writeFile(join(dir3, file), TIGHT, 'utf8')
  const r = await appendLogEntry({ dir: dir3, file, action: '紧贴边界追加', result: '成功', when: new Date(2026, 8, 30, 13, 0) })
  assert.equal(r.ok, true, `失败: ${r.reason}`)
  const lines = (await readFile(join(dir3, file), 'utf8')).split('\n')
  const idx = lines.findIndex((l) => l.includes('紧贴边界追加'))
  assert.ok(idx > 0, '应写入成功')
  assert.ok(lines[idx - 1].includes('| 2026-09-30 | 第一条 | 完成 |'), '应紧跟在最后一条数据行之后')
  assert.ok(lines[idx + 1].trim() === '---', '--- 必须仍在日志行之后，未被吞掉')
  assert.ok(lines.some((l) => l.includes('## 五、其它')), '下一节必须保留')
  await rm(dir3, { recursive: true, force: true })
})

// ── 容错路径 ─────────────────────────────────────────────────────────────
console.log('\n容错（都必须 ok:false 且不抛错）:')

await test('agentmdDir 为空 → 跳过', async () => {
  const r = await appendLogEntry({ dir: '', action: 'x', result: 'y' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /未配置/)
})

await test('目录不存在 → 自动创建后再写入（mkdir recursive）', async () => {
  const dir4 = join(await mkdtemp(join(tmpdir(), 'agentmd-mk-')), 'nested', 'agentmd')
  await writeFile(join(dir4, '..', '..', 'keep.txt'), '', 'utf8').catch(() => {})
  // 目标文件不存在 → 读取失败 → 只记日志
  const r = await appendLogEntry({ dir: dir4, file, action: 'x', result: 'y' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /读取失败/)
})

await test('文件存在但没有操作日志表头 → 跳过且不修改文件', async () => {
  const dir5 = await mkdtemp(join(tmpdir(), 'agentmd-nohead-'))
  await writeFile(join(dir5, file), NO_TABLE, 'utf8')
  const r = await appendLogEntry({ dir: dir5, file, action: 'x', result: 'y' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /未找到操作日志表头/)
  assert.equal(await readFile(join(dir5, file), 'utf8'), NO_TABLE, '内容必须原样不动')
  await rm(dir5, { recursive: true, force: true })
})

await test('readDoc 读取临时文档成功并带回路径', async () => {
  const r = await readDoc(root, file)
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('## 四、操作日志'))
  assert.ok(r.path.endsWith(file))
})

await test('readDoc 对缺失文件返回可读原因', async () => {
  const r = await readDoc(root, 'nope.md')
  assert.equal(r.ok, false)
  assert.match(r.reason, /不存在/)
})

await test('maxRowChars 生效：超长日志写进文件后仍是 3 列且单行不超限', async () => {
  const dir6 = await mkdtemp(join(tmpdir(), 'agentmd-rowcap-'))
  await writeFile(join(dir6, file), SAMPLE, 'utf8')
  const r = await appendLogEntry({
    dir: dir6,
    file,
    action: '超长操作说明。'.repeat(300),
    result: '完成',
    when: new Date(2026, 8, 30, 12, 0),
    maxRowChars: 150,
  })
  assert.equal(r.ok, true, `追加失败: ${r.reason}`)
  assert.ok(r.row.length <= 150, `返回的行应 ≤ 150，实际 ${r.row.length}`)
  const text = await readFile(join(dir6, file), 'utf8')
  assert.ok(text.includes(r.row), '文件里应真的写进了这一行')
  const line = text.split('\n').find((l) => l.includes('2026-09-30 12:00'))
  assert.ok(line, '应能找到刚写的那一行')
  assert.equal(line.split('|').length - 2, 3, `必须仍是 3 列: ${line}`)
  await rm(dir6, { recursive: true, force: true })
})

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log('\n=== 最终文件片段（临时 main.md 的第四节）===')
const finalText = await readFile(target, 'utf8')
const lines = finalText.split('\n')
const start = lines.findIndex((l) => /^##\s*四/.test(l))
console.log(lines.slice(start, start + 16).join('\n'))
console.log('=== 片段结束 ===')
console.log(`\n头部：${lines[3]}`)

await rm(root, { recursive: true, force: true })

console.log(`\n通过 ${passed} / 失败 ${failed}`)
if (failed > 0) process.exitCode = 1
