#!/usr/bin/env node
/**
 * _admin-shots.mjs —— 给**线上**后台管理页拍图（真浏览器 headless Edge + CDP）。
 *
 * 为什么要单独有它：`verify-admin-ui.mjs` 跑的是**本地临时实例**（里面只有造出来的测试账号），
 * 拍出来的图对主人没意义。这里指向**真入口**，用**真口令**登录，看到的就是主人自己的数据。
 *
 * 用法：
 *   node _admin-shots.mjs --token <后台口令> [--base https://cyanovo.top] [--out shots]
 *
 * 产物：`<out>/admin-<view>.png`（概览 / 用户 / 记录 / 兑换码 / 设备码）
 * 零依赖：CDP 走 node 22 自带的全局 WebSocket。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const TOKEN = argOf('--token', '')
const BASE = argOf('--base', 'https://cyanovo.top').replace(/\/$/, '')
const OUT = path.resolve(argOf('--out', 'shots'))
if (!TOKEN) { console.error('用法: node _admin-shots.mjs --token <后台口令> [--base <地址>] [--out <目录>]'); process.exit(2) }

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p))
if (!EDGE) { console.error('找不到 msedge.exe'); process.exit(2) }

const VIEWS = [
  ['overview', '概览'], ['users', '用户'], ['records', '记录'],
  ['codes', '兑换码'], ['devices', '设备码'],
]
const DEBUG_PORT = 9700 + Math.floor(Math.random() * 200)
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-shot-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let edge = null
let ws = null
const cleanup = async () => {
  try { ws?.close() } catch {}
  try { edge?.kill() } catch {}
  await sleep(300)
  await fs.promises.rm(PROFILE, { recursive: true, force: true }).catch(() => {})
}

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('ws 连不上')) })
        let id = 0
        const pending = new Map()
        sock.onmessage = (ev) => {
          const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
          if (!m.id) return
          const p = pending.get(m.id)
          pending.delete(m.id)
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
        }
        const send = (method, params = {}) => new Promise((res, rej) => {
          const i = ++id
          pending.set(i, { res, rej })
          sock.send(JSON.stringify({ id: i, method, params }))
        })
        return { sock, send }
      }
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error(`Edge 调试端口 ${DEBUG_PORT} 连不上`)
}

async function main() {
  console.log(`后台拍图：${BASE}/admin.html`)
  console.log(`输出目录：${OUT}`)
  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--window-size=1360,940',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`, `${BASE}/admin.html`,
  ], { stdio: 'ignore' })

  const { sock, send } = await connect()
  ws = sock
  await send('Runtime.enable')
  await send('Page.enable')

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
  const ready = async (ms = 1500) => {
    for (let i = 0; i < 60; i++) {
      const s = await evaluate('document.readyState').catch(() => 'loading')
      if (s === 'complete') break
      await sleep(200)
    }
    await sleep(ms)
  }
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`

  await ready(1200)
  // 先塞口令再刷新（与页面自己的流程一致：口令只存 sessionStorage）
  await evaluate(`sessionStorage.setItem('dsw_admin_token', ${JSON.stringify(TOKEN)}); true`)
  await send('Page.reload', {})
  await ready(1800)

  const gateHidden = (await evaluate(`getComputedStyle(${q('#gate')}).display`)) === 'none'
  const appShown = (await evaluate(`getComputedStyle(${q('#app')}).display`)) !== 'none'
  console.log(`  登录状态：闸门收起=${gateHidden} 后台可见=${appShown}`)
  if (!appShown) { console.error('  后台没进去（口令不对？）—— 不拍图'); await cleanup(); process.exit(1) }

  fs.mkdirSync(OUT, { recursive: true })
  for (const [view, name] of VIEWS) {
    const sel = `.admin-nav button[data-aview="${view}"]`
    if (!(await evaluate(`!!${q(sel)}`))) { console.log(`  ⏭ 没有「${name}」这一页`); continue }
    await evaluate(`${q(sel)}.click(); true`)
    await sleep(1000)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(shot.data, 'base64')
    const file = path.join(OUT, `admin-${view}.png`)
    fs.writeFileSync(file, buf)
    const text = (await evaluate(`${q(`section[data-aview="${view}"]`)}.innerText`)).trim().split('\n').slice(0, 3).join(' ｜ ')
    console.log(`  📸 ${file}（${name}，${buf.length} B）`)
    console.log(`     首几行：${text.slice(0, 160)}`)
  }
  // 额外一张：用户页里点开「管理」之后的样子。
  // 主人 2026-10-04 报的原话是「没有看到真正的用户管理」—— 这张图正是他该看到的那个状态，
  // 所以单独拍一张，光有"列表页"不足以证明管理入口真的在。
  await evaluate(`${q('.admin-nav button[data-aview="users"]')}.click(); true`)
  await sleep(900)
  const opened = await evaluate(`(() => { const b = document.querySelector('#uList tbody td.act button'); if (!b) return false; b.click(); return true })()`)
  await sleep(1000)
  if (opened) {
    const shot2 = await send('Page.captureScreenshot', { format: 'png' })
    const b2 = Buffer.from(shot2.data, 'base64')
    const f2 = path.join(OUT, 'admin-user-detail.png')
    fs.writeFileSync(f2, b2)
    const d = (await evaluate(`${q('#uDetail')}.innerText`)).trim().split('\n').slice(0, 6).join(' ｜ ')
    console.log(`  📸 ${f2}（用户·点开「管理」之后，${b2.length} B）`)
    console.log(`     详情首几行：${d.slice(0, 200)}`)
  } else {
    console.log('  ⏭ 用户表里没找到「管理」按钮 —— 这一版还没修好？')
  }
  await cleanup()
  console.log('\n✅ 拍图完成')
}

main().catch(async (e) => { console.error('崩了：', e && e.message); await cleanup(); process.exit(1) })
