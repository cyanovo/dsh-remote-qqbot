#!/usr/bin/env node
/**
 * verify-css-vars.mjs —— 静态检查两个样式表里"用了但没定义"的自定义属性。
 *
 * 为什么需要它：`var(--faint)` 写错名字（或那个 token 被删掉了）**不会报错、不会变红**，
 * 浏览器只会静默地回落到继承值 —— 看起来"就是不太一样"，肉眼几乎发现不了。
 * 真实事故：2026-10-03 的 SPA 改版把 `--faint` 从 style.css 里删掉了（它 2.52:1，不达标），
 * 而 `admin.css` 仍在 6 处引用它（`.hint` / `.admin-head .sub` / `.tag.free` …）⇒
 * 后台页那些"次要小字"全部变成了正文色。没有一条验收会报红。
 *
 * 用法：
 *   node verify-css-vars.mjs                 # 查 public/
 *   node verify-css-vars.mjs --dir <目录>     # 查别的目录（反向校验用）
 *
 * 反向校验（确认这把尺子有牙）：随便往 `--dir` 指向的 admin.css 里塞一个 `var(--不存在)`，
 * 本脚本必须 exit 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const DIR = path.resolve(__dirname, argOf('--dir', 'public'))
const FILES = ['style.css', 'admin.css', 'docs.css']

/** 收集所有 `--name:` 形式的定义（不区分在哪个选择器里 —— 这里只查"有没有这个名字"）。 */
const definedIn = (src) => {
  const set = new Set()
  for (const m of src.matchAll(/(^|[\s;{])(--[A-Za-z0-9_-]+)\s*:/g)) set.add(m[2])
  return set
}
/** 逐行收集 `var(--name)` 的引用（带上行号，好定位）。 */
const usedIn = (src) => {
  const map = new Map()
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      if (!map.has(m[1])) map.set(m[1], [])
      map.get(m[1]).push(i + 1)
    }
  })
  return map
}

const srcs = new Map()
for (const f of FILES) {
  const p = path.join(DIR, f)
  if (!fs.existsSync(p)) { console.error(`找不到 ${p}`); process.exit(2) }
  srcs.set(f, fs.readFileSync(p, 'utf8'))
}
// 定义可以来自任一文件（admin.css 自己定义 --side-w，style.css 定义其余）
const defined = new Set()
for (const src of srcs.values()) for (const n of definedIn(src)) defined.add(n)

let bad = 0
for (const [f, src] of srcs) {
  for (const [name, lines] of usedIn(src)) {
    if (defined.has(name)) continue
    bad++
    console.log(`  ❌ ${f} 用了未定义的 ${name}（第 ${lines.join(', ')} 行）`)
  }
}
console.log(bad === 0
  ? `>>> 两个样式表里没有任何"用了但没定义"的自定义属性 ✅（${srcs.size} 个文件 / ${defined.size} 个定义 ｜ 目录 ${DIR}）`
  : `>>> 有问题的自定义属性 ${bad} 个 ❌`)
process.exit(bad === 0 ? 0 : 1)
