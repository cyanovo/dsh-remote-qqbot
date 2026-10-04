/**
 * 一次性实测：QQ 官方机器人的「主动消息 + markdown（msg_type=2）」到底能不能用。
 *
 * 结论要靠眼睛看，不靠文档猜 —— 所以它会真的给你的 QQ 发两条对照消息：
 *   A. msg_type=2 + markdown.content（含 [文字](链接)）
 *   B. msg_type=0 + 纯文本（含同样的裸 URL）
 * 你手机上对比一下，就知道「折叠」到底能不能做。
 *
 * 跑完即删。不打印任何凭据值。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dsh = join(homedir(), '.dsh')
// ⚠️ 实测时发现 `settings.yaml` 这个名字不在（只剩 settings.yaml.imported），
//    所以按候选顺序找第一个存在的 —— 顺便把"实际用了哪个文件"打出来。
let yaml = ''
let usedName = ''
for (const name of ['settings.yaml', 'settings.yaml.imported', 'settings.yaml.bak-20260906-154116']) {
  try { yaml = readFileSync(join(dsh, name), 'utf8'); usedName = name; break } catch { /* 试下一个 */ }
}
if (!yaml) {
  console.log('❌ ~/.dsh 下找不到任何 settings 文件')
  process.exit(1)
}
console.log('配置来源:', usedName)
const grab = (k) => {
  const m = yaml.match(new RegExp(`^[ \\t]*${k}:[ \\t]*(.+)$`, 'm'))
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''
}
const appId = grab('qqAppId')
const clientSecret = grab('qqClientSecret')
if (!appId || !clientSecret) {
  console.log('❌ settings.yaml 里没有 qqAppId / qqClientSecret')
  process.exit(1)
}
const state = JSON.parse(readFileSync(join(dsh, 'qq-bot-state.json'), 'utf8'))
const openId = state.openId
if (!openId) {
  console.log('❌ qq-bot-state.json 里没有 openId（先给机器人发过消息才有）')
  process.exit(1)
}
console.log(`凭据就绪：appId=${appId.slice(0, 4)}… openId=${openId.slice(0, 8)}…`)

// ⚠️ 官方文档：这个接口失败时 HTTP 仍是 200，必须看响应体的 code
const tk = await (await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId, clientSecret }),
})).json()
if (!tk.access_token) {
  console.log('❌ 取 access_token 失败:', JSON.stringify(tk).slice(0, 300))
  process.exit(1)
}
console.log('✅ access_token 已获取')

const LINK = 'https://cyanovo.top:8444/dsh/TEST1.md'

async function send(label, payload) {
  const res = await fetch(`https://api.bot.qq.com/v2/users/${encodeURIComponent(openId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${tk.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  console.log(`\n【${label}】HTTP ${res.status}`)
  console.log(text.slice(0, 500))
}

await send('A. 主动消息 + markdown（msg_type=2）', {
  msg_type: 2,
  markdown: {
    content: [
      '# 折叠测试 A（markdown）',
      '',
      '这是一条 **markdown 主动消息**。',
      '',
      `[👉 查看完整回答](${LINK})`,
      '',
      '- 若上面显示成**蓝色文字**而不是长链接 → 折叠成功',
    ].join('\n'),
  },
})

await send('B. 主动消息 + 纯文本（msg_type=0，对照组）', {
  msg_type: 0,
  content: `折叠测试 B（纯文本）\n\n完整回答：${LINK}\n\n（对照 A 看哪种更省地方）`,
})
