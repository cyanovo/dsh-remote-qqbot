/**
 * QQ 机器人自定义菜单 / 指令面板 读写工具（零依赖）。
 *
 * 用法（在 dsh-notify-memory 目录下）：
 *   node work/qq-menu.mjs get                      # 读当前菜单（并自动存一份备份）
 *   node work/qq-menu.mjs set <menu.json>          # 用文件里的菜单整体覆盖（PUT 是全量覆盖！）
 *   node work/qq-menu.mjs clear-menu               # 清空自定义菜单
 *   node work/qq-menu.mjs panels [scope]           # 读指令面板（scope 默认 c2c，必须带）
 *
 * 🔴 铁律（都是实测踩出来的）：
 *   1. **PUT /v2/menu 是整体覆盖**，写之前一定先 `get` 存备份，写坏了能退回去；
 *   2. `GET /v2/panels` **必须带 `?scope=c2c|group|channel|dm`**，不带直接 400 `40030011`；
 *   3. 菜单项的 `send_message` **保留前导斜杠**（面板 `PanelItem.name` 会被平台剥掉斜杠）；
 *   4. 凭据从 profile 的 `cordis.patch.yml` 读（优先），读不到再退 `settings.yaml.imported`；
 *      **任何情况下都不打印明文凭据**。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const DSH = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const PROFILE = process.env.DSH_PROFILE || 'desktop'
const CANDIDATES = [
  path.join(DSH, 'profiles', PROFILE, 'cordis.patch.yml'),
  path.join(DSH, 'settings.yaml.imported'),
  path.join(DSH, 'settings.yaml'),
]
const API = 'https://api.bot.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

/** 从 YAML 文本里抠出某个键的标量值（够用即可，不引依赖、不打印值）。 */
function yamlValue(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm'))
  if (!m) return ''
  return m[1].replace(/^["']|["']$/g, '').trim()
}

function readCreds() {
  for (const file of CANDIDATES) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const appId = yamlValue(text, 'qqAppId')
    const secret = yamlValue(text, 'qqClientSecret')
    if (appId && secret) return { appId, secret, from: file }
  }
  throw new Error(`没找到 qqAppId / qqClientSecret，找过：\n  ${CANDIDATES.join('\n  ')}`)
}

async function token() {
  const { appId, secret, from } = readCreds()
  console.log(`凭据来源：${from}（appId ${appId.slice(0, 4)}…，secret 已隐藏）`)
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: secret }),
  })
  const j = await res.json()
  if (!j.access_token) throw new Error(`取 access_token 失败：${JSON.stringify(j)}`)
  return j.access_token
}

async function api(tok, method, urlPath, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: { Authorization: `QQBot ${tok}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

function backup(tag, data) {
  const dir = path.join(process.cwd(), 'work')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `qq-menu-backup-${tag}-${stamp}.json`)
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  return file
}

const [cmd, arg] = process.argv.slice(2)

if (cmd === 'get') {
  const tok = await token()
  const r = await api(tok, 'GET', '/v2/menu')
  console.log('HTTP', r.status)
  console.log(JSON.stringify(r.json, null, 2))
  if (r.status === 200) console.log('\n备份：', backup('get', r.json))
} else if (cmd === 'set') {
  if (!arg) { console.error('用法：node work/qq-menu.mjs set <menu.json>'); process.exit(2) }
  const payload = JSON.parse(readFileSync(arg, 'utf8'))
  const tok = await token()
  const before = await api(tok, 'GET', '/v2/menu')
  console.log('写入前：', JSON.stringify(before.json))
  const bak = backup('preset', before.json)
  console.log('写入前已备份：', bak)
  const r = await api(tok, 'PUT', '/v2/menu', payload)
  console.log('PUT HTTP', r.status, JSON.stringify(r.json))
  const after = await api(tok, 'GET', '/v2/menu')
  console.log('回读：', JSON.stringify(after.json, null, 2))
  if (r.status !== 200) {
    console.error('\n❌ 写入被拒。旧菜单备份在：', bak)
    process.exit(1)
  }
} else if (cmd === 'clear-menu') {
  const tok = await token()
  const before = await api(tok, 'GET', '/v2/menu')
  console.log('清空前已备份：', backup('clear', before.json))
  const r = await api(tok, 'PUT', '/v2/menu', { version: (before.json?.version ?? 0) + 1, menu: {} })
  console.log('PUT HTTP', r.status, JSON.stringify(r.json))
} else if (cmd === 'panels') {
  const scope = arg || 'c2c'
  const tok = await token()
  const r = await api(tok, 'GET', `/v2/panels?scope=${scope}`)
  console.log(`scope=${scope} HTTP ${r.status}`, JSON.stringify(r.json))
} else {
  console.log('用法：get | set <json> | clear-menu | panels [scope]')
  process.exit(2)
}
