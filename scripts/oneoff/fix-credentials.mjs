/**
 * 把 ~/.dsh/.credentials.yaml 从**旧嵌套格式**转换成 credentials-local 要求的**扁平格式**。
 *
 * 背景（实测）：
 *   dsh-credentials-local 的 parseCredentialsDocument（src/index.ts:170-179）要求文档是
 *   一个「凭据引用 → 字符串值」的扁平映射；顶层任何非字符串值都会报
 *     `credentials-local: the value for "version" in <file> must be a string`
 *   （因为顶层 version: 1 是数字）。
 *   而本机文件是旧格式：顶层 { version, refs: {...}, records: {...} }，直接启动必炸。
 *
 * 转换规则：
 *   - refs 下的每个 `KEY: <secret>` 原样提升为顶层 `KEY: <secret>`；
 *   - 丢弃 version / records（records 是 client-connection、device、account 等运行时授权态，
 *     不是 LLM API 凭据；缺失时 DSH 会在需要时重新生成）。
 *
 * 安全：脚本**只按需读取值用于重写，绝不打印任何密钥值**；
 * 只打印键名与长度，便于核对。备份须先行完成（.credentials.yaml.bak）。
 *
 * 运行：node scripts/oneoff/fix-credentials.mjs
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const FILE = 'C:/Users/cyan/.dsh/.credentials.yaml'
const BAK = `${FILE}.bak`

if (!existsSync(BAK)) {
  console.error(`拒绝执行：未找到备份 ${BAK}，请先备份。`)
  process.exit(1)
}

const require = createRequire('C:/Users/cyan/.dsh/profiles/desktop/node_modules/')
const YAML = require('js-yaml')

const doc = YAML.load(readFileSync(FILE, 'utf8'))

/** 值是否为非空字符串。 */
const isSecret = (v) => typeof v === 'string' && v.length > 0

// 已经是扁平格式就直接退出。
const topKeys = Object.keys(doc ?? {})
if (topKeys.length > 0 && topKeys.every((k) => isSecret(doc[k]))) {
  console.log('已是扁平格式，无需修改。')
  process.exit(0)
}

const flat = {}
// 1) 优先取 refs（旧格式里 LLM 凭据的所在）
for (const [k, v] of Object.entries(doc?.refs ?? {})) {
  if (isSecret(v)) flat[k] = v
}
// 2) 兼容：顶层若已有合法的 KEY: value 也保留
for (const [k, v] of Object.entries(doc ?? {})) {
  if (isSecret(v)) flat[k] = v
}

if (Object.keys(flat).length === 0) {
  console.error('未从文档中提取到任何凭据，已放弃修改（原文件未动）。')
  process.exit(1)
}

// 用序列化而非手拼，确保特殊字符被正确转义。
const out = Object.entries(flat)
  .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  .join('\n') + '\n'

// 保险：再备份一次转换前的状态
copyFileSync(FILE, `${FILE}.preflat`)
writeFileSync(FILE, out, 'utf8')

console.log('已把 .credentials.yaml 转换为扁平格式。')
console.log('保留的凭据引用（只显示键名与长度，不显示值）：')
for (const [k, v] of Object.entries(flat)) {
  console.log(`  ${k.padEnd(22)} 长度 ${v.length}`)
}
console.log('丢弃的内容：version、records（运行时授权态，非 API 凭据）')
console.log(`\n回退方法：copy "${BAK}" "${FILE}"`)

// 复核：重新解析，确认顶层全是字符串
const check = YAML.load(readFileSync(FILE, 'utf8'))
const allStr = Object.values(check).every(isSecret)
console.log(`复核：顶层 ${Object.keys(check).length} 个键，全部为非空字符串 = ${allStr}`)
if (!allStr) process.exit(1)
