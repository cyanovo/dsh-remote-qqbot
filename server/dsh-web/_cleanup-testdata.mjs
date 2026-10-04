/**
 * 清掉验收脚本在生产数据里留下的测试账号。
 *
 * 为什么必须清：那些脚本是**对着线上服务**跑的（真实 data.json），每次都会建出
 * `vf******`（旧 verify.mjs）或 `p1live******`（verify-live.mjs）这样的临时账号，
 * 正常跑完会自己注销；但**脚本中途崩掉**时（例如 TypeError）就留在那儿了。
 *
 * 只认这两个前缀 —— 不做"清空全部"这种危险动作，宁可留下看不懂的东西让人来查。
 * 用法（在服务器上）：node _cleanup-testdata.mjs
 */
import fs from 'node:fs'

const P = '/var/lib/dsh-web/data.json'
const PREFIXES = ['vf', 'p1live']
const isTest = (n) => PREFIXES.some((p) => String(n).startsWith(p))
const db = JSON.parse(fs.readFileSync(P, 'utf8'))

const before = {
  users: Object.keys(db.users),
  records: db.records.map((r) => r.user),
  codes: Object.keys(db.codes).length,
  devices: Object.keys(db.devices || {}).length,
}
console.log('清理前：', JSON.stringify(before))

const kept = new Set(Object.keys(db.users).filter((n) => !isTest(n)))
const dropped = Object.keys(db.users).filter((n) => isTest(n))
db.users = Object.fromEntries(Object.entries(db.users).filter(([n]) => kept.has(n)))
const recBefore = db.records.length
db.records = db.records.filter((r) => kept.has(r.user))
for (const [c, v] of Object.entries(db.codes)) {
  if (v.usedBy && !kept.has(v.usedBy)) delete db.codes[c]
}
db.devices = db.devices || {}
for (const [k, d] of Object.entries(db.devices)) {
  if (d.username && !kept.has(d.username)) delete db.devices[k]
}

fs.writeFileSync(P, JSON.stringify(db), { mode: 0o600 })
console.log(`删掉测试账号 ${dropped.length} 个：${dropped.join(', ') || '(无)'}`)
console.log(`删掉它们名下的记录 ${recBefore - db.records.length} 条`)
console.log('清理后：', JSON.stringify({
  users: Object.keys(db.users),
  records: db.records.length,
  codes: Object.keys(db.codes).length,
  devices: Object.keys(db.devices).length,
}))
