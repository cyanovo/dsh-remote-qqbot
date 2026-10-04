/**
 * 测试用凭据解析：**优先从 ~/.dsh/settings.yaml 读**，其次环境变量，最后 --token 参数。
 *
 * 为什么这样做：令牌会在交付时轮换。硬编码进测试脚本的话，用户轮换后脚本就挂了，
 * 反而制造困惑。从 settings.yaml 读则永远跟着真实配置走。
 *
 * 解析顺序（先命中先用）：
 *   1. 命令行 --token=xxx / --token xxx
 *   2. 环境变量 DSH_NOTIFY_TOKEN
 *   3. ~/.dsh/settings.yaml 里 dsh-remote-qqbot.{token,hubUrl}
 *
 * 读不到就返回 null，由调用方决定「跳过该测试并给出中文提示」，而不是抛错。
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 从 settings.yaml 里抠出 dsh-remote-qqbot 段的某个键。
 *  只做极简解析（缩进 + key: value），避免为测试脚本引入 yaml 依赖。 */
function readFromSettings(key) {
  const candidates = [
    join(homedir(), '.dsh', 'settings.yaml'),
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'settings.yaml') : null,
  ].filter(Boolean)

  for (const file of candidates) {
    if (!existsSync(file)) continue
    const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    let inSection = false
    for (const line of lines) {
      const sectionMatch = /^(\S[^:]*):\s*$/.exec(line)
      if (sectionMatch) {
        inSection = sectionMatch[1].trim() === 'dsh-remote-qqbot'
        continue
      }
      if (!inSection) continue
      const m = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
      if (m && m[1] === key) {
        // 去掉可能的引号
        return m[2].trim().replace(/^["']|["']$/g, '')
      }
    }
  }
  return null
}

/** 命令行参数里找 --token。 */
function readFromArgv() {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--token=')) return a.slice('--token='.length)
    if (a === '--token' && argv[i + 1]) return argv[i + 1]
  }
  return null
}

/**
 * 解析中枢连接信息。
 * @returns {{hubUrl: string, token: string, source: string} | null} 读不到返回 null
 */
export function resolveHub() {
  const argToken = readFromArgv()
  const envToken = process.env.DSH_NOTIFY_TOKEN || null
  const fileToken = readFromSettings('token')
  const token = argToken || envToken || fileToken

  const hubUrl = process.env.DSH_NOTIFY_HUB_URL
    || readFromSettings('hubUrl')
    || null

  if (!token || !hubUrl) {
    const missing = [!token && 'token', !hubUrl && 'hubUrl'].filter(Boolean).join('、')
    console.log(`跳过：未能解析到中枢${missing ? `（缺 ${missing}）` : ''}。`)
    console.log('请任选一种方式提供：')
    console.log('  1. 在 ~/.dsh/settings.yaml 的 dsh-remote-qqbot 段配置 token 与 hubUrl')
    console.log('  2. 设置环境变量 DSH_NOTIFY_TOKEN / DSH_NOTIFY_HUB_URL')
    console.log('  3. 运行命令时加 --token=xxx')
    return null
  }

  const source = argToken ? '命令行 --token' : envToken ? '环境变量' : '~/.dsh/settings.yaml'
  return { hubUrl: hubUrl.replace(/\/+$/, ''), token, source }
}
