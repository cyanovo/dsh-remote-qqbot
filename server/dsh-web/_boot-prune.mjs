// 本地回归：启动清理「过期记录」时必须落盘（不需要服务器、不碰 /var/lib/dsh-web）
//
// 用法：
//   node _boot-prune.mjs                      # 测当前 server.mjs
//   node _boot-prune.mjs <另一个 server.mjs>   # A/B：测别处的版本
//   node _boot-prune.mjs git:<rev>            # A/B：把 <rev> 里的 dsh-web/server.mjs 取出来测
//                                             #（用 node 直接调 git，避免 PowerShell 吃引号/改编码）
//
// 判定（两条都要成立）：
//   ① 过期记录（createdAt 6 小时前）在启动后从 data.json 里消失
//   ② 未过期记录（createdAt 1 小时前）仍在
// 退出码 0 = 通过，1 = 失败。
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = process.argv[2]
let target
if (arg && arg.startsWith('git:')) {
  const rev = arg.slice(4)
  const tmp = path.join(os.tmpdir(), `dsh-web-old-${rev.replace(/[^\w.-]/g, '_')}.mjs`)
  const buf = execFileSync('git', ['show', `${rev}:dsh-web/server.mjs`],
    { cwd: path.resolve(HERE, '..'), maxBuffer: 64 * 1024 * 1024 })
  fs.writeFileSync(tmp, buf)
  target = tmp
} else {
  target = path.resolve(arg || path.join(HERE, 'server.mjs'))
}
const RETENTION_H = 5

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-prune-'))
const now = Date.now()
const stale = { id: 'stale01', userId: 'u1', title: '过期记录', text: 'x', mode: 'note', createdAt: now - 6 * 3600e3 }
const fresh = { id: 'fresh01', userId: 'u1', title: '新记录', text: 'y', mode: 'note', createdAt: now - 1 * 3600e3 }
fs.writeFileSync(path.join(dir, 'data.json'),
  JSON.stringify({ version: 1, users: {}, records: [stale, fresh], codes: {} }, null, 2), 'utf8')

const port = 8800 + Math.floor(Math.random() * 200)
const child = spawn(process.execPath, [target], {
  env: { ...process.env, DSH_WEB_PORT: String(port), DSH_WEB_DATA: dir, DSH_WEB_ROOT: path.join(HERE, 'public') },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const out = []
let ready = false
const finish = (code, msg) => {
  try { child.kill() } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  console.log(msg)
  process.exit(code)
}

const check = () => {
  let db
  try { db = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')) } catch (e) {
    return finish(1, `❌ 读不到 data.json：${e.message}`)
  }
  const ids = db.records.map((r) => r.id)
  const okStale = !ids.includes('stale01')
  const okFresh = ids.includes('fresh01')
  const lines = [
    `目标：${target}`,
    `启动日志：${out.join(' ｜ ').trim() || '（无）'}`,
    `重启后 records = [${ids.join(', ')}]`,
    `① 过期记录已清掉 = ${okStale ? '✅' : '❌ 还在'}`,
    `② 未过期记录仍保留 = ${okFresh ? '✅' : '❌ 被误删'}`,
  ]
  finish(okStale && okFresh ? 0 : 1, lines.join('\n'))
}

const onData = (b) => {
  const s = b.toString('utf8')
  out.push(s.trim().split('\n')[0])
  if (!ready && s.includes('已就绪')) {
    ready = true
    // 落盘是异步的（writeChain），给一点时间
    setTimeout(check, 500)
  }
}
child.stdout.on('data', onData)
child.stderr.on('data', (b) => out.push('[stderr] ' + b.toString('utf8').trim().split('\n')[0]))
child.on('exit', (c) => { if (!ready) finish(1, `❌ 服务没起来（exit ${c}）\n${out.join('\n')}`) })
setTimeout(() => { if (!ready) finish(1, `❌ 3 秒内没看到「已就绪」\n${out.join('\n')}`) }, 3000)
