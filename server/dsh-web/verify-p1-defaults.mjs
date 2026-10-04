/**
 * 生产默认值核对：**不设任何环境变量**，把 server.mjs 跑起来，读 `/api/meta`。
 *
 * 为什么要单独一个文件：`verify-p1.mjs` 为了能测 TTL 会把保留期调成 2 秒/5 秒，
 * 于是它只能证明「机制对」。**「线上到底是多少」必须在不改任何变量的进程里读**，
 * 否则就是拿调过的值去证明默认值 —— 那正是"量具自己骗人"。
 *
 * 用法：node verify-p1-defaults.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-def-'))
const PORT = 18796
const BASE = `http://127.0.0.1:${PORT}`

process.env.DSH_WEB_DATA = path.join(TMP, 'data')
process.env.DSH_WEB_PORT = String(PORT)
process.env.DSH_WEB_HOST = '127.0.0.1'
process.env.DSH_WEB_ROOT = path.join(HERE, 'public')
delete process.env.DSH_WEB_RETENTION_MS
delete process.env.DSH_WEB_PRO_RETENTION_MS

for (const k of ['DSH_WEB_RETENTION_MS', 'DSH_WEB_PRO_RETENTION_MS']) {
  if (process.env[k] !== undefined) throw new Error(`这个脚本不该带 ${k}`)
}

await import(pathToFileURL(path.join(HERE, 'server.mjs')).href)
let meta = null
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${BASE}/api/meta`); if (r.ok) { meta = await r.json(); break } } catch { /* 等 */ }
  await new Promise((r) => setTimeout(r, 100))
}
if (!meta) { console.log('✗ 服务没起来'); process.exit(1) }

const checks = [
  ['免费：每天 100 次', meta.plans.free.daily, 100],
  ['免费：保留 5 小时', meta.plans.free.retentionMs, 5 * 3600 * 1000],
  ['免费保留文案', meta.plans.free.retentionText, '5 小时'],
  ['支持者：每天 1000 次', meta.plans.pro.daily, 1000],
  ['支持者：保留 48 小时', meta.plans.pro.retentionMs, 48 * 3600 * 1000],
  ['支持者保留文案', meta.plans.pro.retentionText, '48 小时'],
  ['一次贡献 = 30 天', meta.plans.pro.days, 30],
  ['价格 2.99 元', meta.plans.pro.priceCny, '2.99'],
  ['顶层 retentionMs 仍是免费档', meta.retentionMs, 5 * 3600 * 1000],
  ['设备码 10 分钟有效', meta.device.ttlMs, 10 * 60 * 1000],
  ['插件轮询 3 秒一次', meta.device.interval, 3],
  ['三档全文模式齐全', meta.modes.map((m) => m.id).join(','), 'chat,note,note-link'],
]

let fail = 0
for (const [name, got, want] of checks) {
  const okk = got === want
  if (!okk) fail++
  console.log(`${okk ? '  ✓' : '  ✗'} ${name}${okk ? '' : `　实测 ${JSON.stringify(got)} ≠ 期望 ${JSON.stringify(want)}`}`)
}
console.log(`\n生产默认值核对：${checks.length - fail} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
