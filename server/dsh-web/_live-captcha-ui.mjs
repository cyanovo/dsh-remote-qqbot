// 线上「登录页人机验证」真浏览器验收（headless Edge + CDP，只读：不注册、不登录、不改任何数据）
//
// 为什么必须有这一把尺子：`verify-captcha.mjs` 验的是**接口**，`verify-account-ui.mjs` 验的是
// 桩里的**代码路径** —— 两者都证明不了"用户打开 https://cyanovo.top，点「账号」，
// 那张图画得出来、点「换一张」真的会换"。这正是主人会看到的那一步。
//
// 用法：
//   $env:ADMIN_PASS 不需要；本脚本不登录
//   node _live-captcha-ui.mjs                        # 打线上 https://cyanovo.top
//   $env:BASE_URL='http://127.0.0.1:8795'; node _live-captcha-ui.mjs   # 走回环豁免（调试用）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const BASE = (process.env.BASE_URL || 'https://cyanovo.top').replace(/\/+$/, '')
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p))
if (!EDGE) { console.error('找不到 msedge.exe'); process.exit(2) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dshweb-capui-'))
const DEBUG_PORT = 9900 + Math.floor(Math.random() * 90)

let pass = 0, fail = 0
const ok = (t, c, extra = '') => { if (c) { pass++; console.log(`  ✅ ${t}`) } else { fail++; console.log(`  ❌ ${t}${extra ? ' ｜ ' + extra : ''}`) } }

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1326,900', `${BASE}/`,
], { stdio: 'ignore' })

const cleanup = async () => {
  try { await cdp?.ws.close() } catch { /* ignore */ }
  try { edge.kill() } catch { /* ignore */ }
  await sleep(200)
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.on('uncaughtException', async (e) => { console.error('崩了：', e); await cleanup(); process.exit(2) })

let cdp = null
async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连不上')) })
        let id = 0
        const pending = new Map()
        const events = []
        ws.onmessage = (ev) => {
          const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
          if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
          else events.push(m)
        }
        const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
        return { ws, send, events }
      }
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('Edge 调试端口连不上')
}

const evaluate = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || ''))
  return r.result.value
}
const click = (sel) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`)
const type = (sel, v) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
async function waitFor(expr, ms = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await evaluate(`(()=>{try{return !!(${expr})}catch{return false}})()`)) return true; await sleep(200) }
  return false
}
/** 等 <img> 真的解码出图（data URL 赋给 src 是异步的，光看 src 非空证明不了"画出来了"） */
async function waitDecoded(sel, ms = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const r = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?{w:e.naturalWidth,h:e.naturalHeight,src:String(e.src).slice(0,40)}:null})()`)
    if (r && r.w > 0) return r
    await sleep(200)
  }
  return null
}

try {
  console.log(`\n=== 线上登录页·人机验证验收 @ ${BASE} ===`)
  cdp = await connect()
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable')
  ok('页面加载完成', await waitFor(`document.readyState==='complete'`))
  await sleep(400)

  // 进「账号」页（未登录 ⇒ 登录/注册表单）
  await click('.nav-item[data-view="account"]')
  ok('「账号」页里渲染出了登录表单', await waitFor(`document.querySelector('#loginBtn')`))
  ok('登录表单里有验证码图与输入框',
    (await evaluate(`!!document.querySelector('#capImg_login') && !!document.querySelector('#capText_login')`)) === true)
  ok('注册表单里也各有一张（同一页两个表单）',
    (await evaluate(`!!document.querySelector('#capImg_reg') && !!document.querySelector('#capText_reg')`)) === true)
  ok('两个表单都有「换一张」按钮',
    (await evaluate(`!!document.querySelector('#capNew_login') && !!document.querySelector('#capNew_reg')`)) === true)

  // ★ 图真的画出来了：naturalWidth=132（服务端画的尺寸）
  const d1 = await waitDecoded('#capImg_login')
  ok('★ 验证码图真的解码出来了（不是空白框/裂图）', !!d1 && d1.w === 132 && d1.h === 44,
    d1 ? `naturalWidth=${d1.w} naturalHeight=${d1.h}` : '等了 12 秒仍没有图')

  // ★ 点「换一张」必须换到**另一张图**
  const before = await evaluate(`String(document.querySelector('#capImg_login').src)`)
  await click('#capNew_login')
  let after = before
  for (let i = 0; i < 40 && after === before; i++) { await sleep(200); after = await evaluate(`String(document.querySelector('#capImg_login').src)`) }
  ok('★ 点「换一张」会换成另一张图（data URL 变了）', after !== before && after.startsWith('data:image/svg+xml'),
    `换前 ${String(before).slice(0, 34)}… 换后 ${String(after).slice(0, 34)}…`)
  ok('换图之后输入框被清空（不让人拿着旧答案撞新题）',
    (await evaluate(`document.querySelector('#capText_login').value`)) === '')

  // 空着就提交：必须在**本地**拦住，不许白跑一次服务端
  const reqs = []
  cdp.events.length = 0
  await click('#loginBtn')
  await sleep(600)
  for (const e of cdp.events) if (e.method === 'Network.requestWillBeSent') reqs.push(e.params.request.url)
  const hitLogin = reqs.some((u) => u.endsWith('/api/login'))
  ok('★ 验证码空着点登录：本地就拦住，不发 /api/login（省一次白跑）', !hitLogin, `本轮请求：${reqs.map((u) => u.replace(BASE, '')).join(' ') || '无'}`)
  ok('并且说清了要填什么',
    /验证码/.test(String(await evaluate(`document.querySelector('#loginMsg').textContent`))),
    JSON.stringify(await evaluate(`document.querySelector('#loginMsg').textContent`)))

  // 页面上绝不能出现答案（生产没开 TEST 模式）
  ok('★ 页面源码里搜不到验证码答案（生产没开 DSH_WEB_CAPTCHA_TEST）',
    !/DSH_WEB_CAPTCHA_TEST|captchaAnswer/.test(await evaluate('document.documentElement.outerHTML')),
    '（答案若出现在前端，这道闸就白做了）')

  console.log(`\n线上登录页人机验证：${pass} 通过 / ${fail} 失败`)
  await cleanup()
  process.exit(fail ? 1 : 0)
} catch (e) {
  console.error('崩了：', e)
  await cleanup()
  process.exit(2)
}
