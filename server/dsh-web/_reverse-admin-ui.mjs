// 一次性反向校验：把 admin.js 的三处行为**故意改坏**，确认 verify-admin-ui.mjs 会报红。
// 每处替换都必须**恰好命中 1 次**，否则中止（否则可能拿一份没改过的文件跑出"全绿"却以为验过了）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, 'public')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adminui-broken-'))

for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(DIR, f))

const file = path.join(DIR, 'admin.js')
let js = fs.readFileSync(file, 'utf8')

// ① lockGate 不再清 sessionStorage（失效口令会赖着不走）
// ② tryEnter 失败也不清 sessionStorage（刷新即死循环）
// ③ 切页时不隐藏其它 section（一份数据同时铺在所有页上）
// ④ 把「管理」列上的按钮改名（模拟"用户管理入口又不见了"）
// ⑤ 把「取消 Pro」退回那个挂错牌子的名字（模拟主人找不到取消 Pro 的那一版）
const cuts = [
  ["  sessionStorage.removeItem(TOKEN_KEY);\n  $('app').hidden = true;", "  $('app').hidden = true;"],
  ["    sessionStorage.removeItem(TOKEN_KEY);\n    paintWho();", "    paintWho();"],
  ["  for (const s of document.querySelectorAll('section[data-aview]')) s.hidden = s.getAttribute('data-aview') !== next;",
    "  for (const s of document.querySelectorAll('section[data-aview]')) s.hidden = false;"],
  ["el('button', { class: 'btn', text: '管理',", "el('button', { class: 'btn', text: '打开',"],
  ["text: '取消 Pro（改回免费版）'", "text: '退出该账号登录'"],
]
for (const [from, to] of cuts) {
  const n = js.split(from).length - 1
  if (n !== 1) { console.error(`替换命中 ${n} 次（要求 1 次），中止：${from.slice(0, 50)}…`); process.exit(2) }
  js = js.replace(from, to)
}
fs.writeFileSync(file, js, 'utf8')
console.log(`坏副本：${DIR}`)

const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-admin-ui.mjs'), '--dir', DIR], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
})
const out = (r.stdout || '') + (r.stderr || '')
for (const line of out.split(/\r?\n/)) {
  if (line.includes('❌') || line.startsWith('>>>') || line.includes('失败项')) console.log(line)
}
const m = out.match(/通过 (\d+) \/ 失败 (\d+)/)
console.log(`\n探针退出码 = ${r.status} ｜ 通过/失败 = ${m ? m[1] + '/' + m[2] : '未解析'}`)

// 每条"预期必须变红"的断言都只写够识别的片段。
const wantRed = [
  '切到用户页后只有它可见（section 只有一个）',
  '换口令后 sessionStorage 里的口令被清掉',
  '失效口令被清掉了',
  // ④⑤：2026-10-04 补的两条反向校验 —— 证明"可发现性"那组断言不是空断言
  '每一行都有一个写明了用途的「管理」按钮',
  '详情里有「取消 Pro（改回免费版）」',
]
const red = [...new Set(out.match(/❌ ([^—\n]+)/g) || [])]   // 去重：脚本末尾的"失败项"清单会再列一遍
const hit = wantRed.filter((w) => red.some((x) => x.includes(w)))
// 一个坏改动会连带影响后面的断言（比如撤不掉 Pro，后面"档位回到免费"自然也红）——
// 那是正常的连带，不说明尺子有问题。判据只认"预期的每一条都红了" + 退出码 1。
const extra = red.filter((x) => !wantRed.some((w) => x.includes(w))).length
console.log(`命中的预期红项 ${hit.length}/${wantRed.length}：${hit.join(' ｜ ')}`)
console.log(`连带红项 ${extra} 条（正常现象，不计入判据）`)
console.log(hit.length === wantRed.length && r.status === 1 ? '>>> 尺子有牙 ✅' : '>>> 尺子没牙 ❌')
fs.rmSync(DIR, { recursive: true, force: true })
