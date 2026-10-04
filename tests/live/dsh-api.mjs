/**
 * 本机 DSH `/api` 命令行工具 —— 用来查/改 DSH 自身的状态。
 *
 * 为什么需要它：桌面版把 `~/.dsh/settings.yaml` 迁移走之后（留下了
 * `settings.yaml.imported`），直接改文件不再生效。DSH 自带 `settings` RPC，
 * 走它才是正路。
 *
 * 用法：
 *   node tests/live/dsh-api.mjs session/list '{"_request":{}}'
 *   node tests/live/dsh-api.mjs settings/describe '{"_request":{}}'
 *   node tests/live/dsh-api.mjs settings/describe '{"request":{"ns":"dsh-remote-qqbot"}}'
 *   node tests/live/dsh-api.mjs settings/update '{"request":{"ns":"dsh-remote-qqbot","patch":{"qqEnabled":true}}}'
 *
 * ⚠️ args 的 key 就是接口的形参名（_request / request），错一个就 arguments-invalid。
 * ⚠️ `session/prompt` 的 requestId 必须放在 request **内部**。
 */

import os from 'node:os'

import { DshLocalApi, readDshSecret } from '../../src/qqbridge.js'

const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('--'))
const positional = argv.filter((a) => !a.startsWith('--'))
const method = positional[0]
const argsJson = positional[1]

if (!method) {
  console.error('用法: node tests/live/dsh-api.mjs <method> [argsJson|-] [--ns=<name>]')
  console.error('      argsJson 传 "-" 或省略时从 stdin 读（PowerShell 会吃掉单引号里的双引号）')
  process.exit(2)
}

/** PowerShell 传 JSON 太容易坏，所以支持 stdin。 */
async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

let raw = argsJson
if (argsJson === '-' || (argsJson === undefined && !process.stdin.isTTY)) {
  raw = await readStdin()
}

let args = {}
if (raw && raw.trim()) {
  try {
    args = JSON.parse(raw)
  } catch (err) {
    console.error(`❌ argsJson 不是合法 JSON: ${err.message}\n   收到的是: ${raw.slice(0, 200)}`)
    process.exit(2)
  }
}

const home = os.homedir()
const api = new DshLocalApi({
  baseUrl: 'http://127.0.0.1:19387',
  authority: '127.0.0.1:19387',
  secret: readDshSecret(home),
})

try {
  const value = await api.rpc(method, args)
  // --ns=<name>：settings/describe 的结果很大，只看关心的 namespace。
  // （也不要让 PowerShell 重定向存盘——它会加 BOM，后面 JSON.parse 必炸。）
  const nsArg = flags.find((a) => a.startsWith('--ns='))
  if (nsArg && value && Array.isArray(value.namespaces)) {
    const want = nsArg.slice('--ns='.length)
    const found = value.namespaces.find((n) => n.ns === want)
    console.log(JSON.stringify({
      hasDocument: value.hasDocument,
      writable: value.writable,
      allNamespaces: value.namespaces.map((n) => n.ns),
      [want]: found ?? '(没有这个 namespace)',
    }, null, 2))
  } else {
    console.log(JSON.stringify(value, null, 2))
  }
} catch (err) {
  console.error(`❌ ${err.message}`)
  process.exit(1)
}
