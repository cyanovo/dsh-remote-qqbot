/**
 * 一次性脚本：把「修好后的 .html 链接」通过 QQ 主动消息推给机主，
 * 用于在真实 QQ 客户端里验证「点开是内置浏览器预览，而不是『请用浏览器打开』」。
 *
 * 只读插件配置 + 触发一次真实 QQ 发送，不改任何项目文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()
const NS = 'dsh-notify-memory'

// ── 1. 从 settings.yaml 的 dsh-notify-memory 段里取配置 ────────────────────
const settingsRaw = fs.readFileSync(path.join(HOME, '.dsh', 'settings.yaml'), 'utf8')
const at = settingsRaw.indexOf(`${NS}:`)
if (at < 0) throw new Error(`settings.yaml 里没有 ${NS} 段`)
const rest = settingsRaw.slice(at)
const end = rest.slice(1).search(/\n\S/)
const block = end < 0 ? rest : rest.slice(0, end + 1)

function pick(key) {
  const m = block.match(new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, 'm'))
  if (!m) return ''
  const v = m[1].trim()
  return /^['"].*['"]$/.test(v) ? v.slice(1, -1) : v
}

const hubUrl = pick('hubUrl')
const token = pick('token')
const appId = pick('qqAppId')
const clientSecret = pick('qqClientSecret')
const idLength = Number(pick('notesIdLength')) || 5

console.log(`hubUrl       = ${hubUrl}`)
console.log(`appId        = ${appId}`)
console.log(`token        = ${token ? token.slice(0, 8) + '…(' + token.length + ')' : '(空)'}`)
console.log(`idLength     = ${idLength}`)
if (!hubUrl || !appId || !clientSecret) throw new Error('配置不全，终止')

// ── 2. 发布一篇真实笔记（顺便验证 Markdown 渲染质量） ──────────────────────
const { publishNote } = await import('../dsh-notify-memory/src/notes.js')

const markdown = `# QQ 内预览修复验证

## 问题是什么

QQ 里点「查看完整回答」，弹出的是 **如需预览请用浏览器打开**。

根因不在渲染服务：页面早就是排好版的 HTML 了。真正的原因是 **URL 后缀**——
QQ 客户端按后缀判定 \`.md\` 是一个**文件**，于是拒绝用内置浏览器渲染，
直接甩给系统浏览器。

## 怎么修的

| 环节 | 改动 |
| --- | --- |
| 渲染服务 | \`PATH_RE\` 同时接受 \`.md\` 与 \`.html\` |
| nginx | 新增一条 \`^/dsh/<id>\\.html$\` 的 location，原有 \`.md\` / \`raw\` 不动 |
| 中枢 | 生成链接的后缀 \`.md\` → \`.html\` |

\`\`\`js
// 中枢 /opt/dsh-hub/server.mjs
const url = \`\${NOTES_PUBLIC_BASE}/\${id}.html\`
\`\`\`

## 这意味着什么

- **新推送**的「查看完整回答」链接，后缀是 \`.html\`，QQ 会当成网页 → 内置浏览器直接渲染。
- **旧链接**（历史消息里的 \`.md\`）依然能打开、排版也正常，但 QQ 仍按后缀把它当文件，
  所以**只有新的通知才会在 QQ 里直接预览**。

> 如果你现在看到这一页排版正常，说明渲染服务没问题；
> 回到聊天窗口点上面那条链接，才是本次修复真正要验证的东西。

<sub>由 dsh-notify-memory 自动记录 · 这里是未删节的原文，不是摘要</sub>
`

const note = await publishNote({
  hubUrl,
  token,
  markdown,
  idLength,
  session: 'QQ 内预览修复验证',
  log: (m) => console.log(`[notes] ${m}`),
})
if (!note) throw new Error('发布笔记失败')
console.log(`\n已发布笔记：id=${note.id} bytes=${note.bytes}`)
console.log(`URL = ${note.url}`)
if (!note.url.endsWith('.html')) console.log('⚠️ 中枢返回的 URL 后缀不是 .html！')

// ── 3. 取收件人 openId（插件从你发来的消息里学到的）────────────────────────
const stateFile = path.join(HOME, '.dsh', 'qq-bot-state.json')
const stateRaw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
function findOpenId(node) {
  if (!node || typeof node !== 'object') return ''
  for (const [k, v] of Object.entries(node)) {
    if (/^open_?id$/i.test(k) && typeof v === 'string' && v) return v
    const nested = findOpenId(v)
    if (nested) return nested
  }
  return ''
}
const openId = findOpenId(stateRaw)
if (!openId) throw new Error(`在 ${stateFile} 里找不到 openId`)
console.log(`收件人 openId = ${openId.slice(0, 8)}…${openId.slice(-4)}（共 ${openId.length} 字符）`)

// ── 4. 发一条真实通知格式的 QQ 主动消息 ────────────────────────────────────
const { QqBotClient } = await import('../dsh-notify-memory/src/qqbot.js')

const bot = new QqBotClient({
  appId,
  clientSecret,
  log: (level, msg) => console.log(`[qq:${level}] ${msg}`),
})

const text = [
  '✅ QQ 内预览已修好',
  '',
  '点下面的链接试试：现在应该直接在 QQ 里打开排版好的网页，不再提示「如需预览请用浏览器打开」。',
  '',
  `[查看完整回答](${note.url})`,
  '',
  note.url,
].join('\n')

const res = await bot.sendC2C(openId, text, { markdown: true })
console.log('\n发送结果：')
console.log(JSON.stringify(res, null, 2).slice(0, 800))
console.log('\n✅ 已发出。请到 QQ 里点那条链接。')
