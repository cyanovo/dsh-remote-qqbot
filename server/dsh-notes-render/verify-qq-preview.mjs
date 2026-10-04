#!/usr/bin/env node
/**
 * 验证「QQ 内预览」修复是否真的通了 —— 全程打**公网域名**，不走 127.0.0.1，
 * 因为要证明的正是"QQ 点开这个 URL 会拿到什么"。
 *
 * 四个必须同时成立的点：
 *   1. .html 后缀的链接返回 text/html 且是真渲染过的网页   ← 本次修复的核心
 *   2. .md 旧链接仍然可用（04:40 那版已经发到 QQ 里的链接不能断）
 *   3. 80 端口（不带端口号的短链）也能用                    ← 万一 QQ 嫌 8444 非标端口
 *   4. /dsh/raw/<id>.md 还能拿到未渲染的原文
 */

const ID = process.argv[2] || '4e7t1'

const targets = [
  ['8444 / .html  ← 新链接（QQ 用这个）', `https://cyanovo.top:8444/dsh/${ID}.html`],
  ['8444 / .md    ← 旧链接兼容', `https://cyanovo.top:8444/dsh/${ID}.md`],
  ['80   / .html  ← 无端口备选', `http://cyanovo.top/dsh/${ID}.html`],
  ['8444 / raw    ← 未渲染原文', `https://cyanovo.top:8444/dsh/raw/${ID}.md`],
]

const row = (a, b, c, d) => `  ${String(a).padEnd(30)} ${String(b).padEnd(6)} ${String(c).padEnd(28)} ${d}`

console.log(row('链路', '状态', 'content-type', '正文体检'))
console.log('  ' + '─'.repeat(96))

let pass = 0
let fail = 0

for (const [label, url] of targets) {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 15000)
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' })
    clearTimeout(t)
    const ct = res.headers.get('content-type') || '(无)'
    const body = await res.text()

    const checks = []
    if (label.includes('raw')) {
      checks.push(body.includes('#') ? '含 markdown 记号 ✔' : '不像原文 ✘')
      checks.push(ct.includes('text/markdown') ? '类型对 ✔' : `类型是 ${ct} ✘`)
    } else {
      checks.push(body.includes('<html') ? '是网页 ✔' : '不是网页 ✘')
      checks.push(body.includes('<h1') ? '有渲染标题 ✔' : '无渲染标题 ✘')
      checks.push(ct.includes('text/html') ? '类型对 ✔' : `类型是 ${ct} ✘`)
    }
    const ok = res.status === 200 && !checks.some((c) => c.includes('✘'))
    ok ? pass++ : fail++
    console.log(row(label, res.status, ct, checks.join('  ')))
  } catch (err) {
    fail++
    console.log(row(label, 'ERR', '-', String(err.message || err)))
  }
}

console.log('  ' + '─'.repeat(96))
console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
