/**
 * 验证 `verify-live.mjs` 遇到**设备码限流（429）**时的行为：
 * 必须**一条话说清 + 退出码 3**，而不是让后面 10 条断言级联变红。
 *
 * 为什么要专门验这条：2026-10-03 真实发生过 —— 我连跑两次验收，第二次被自己的限流
 * 顶成 429，结果 10 条断言全红，看上去像产品坏了。后来给脚本加了 fail-fast，
 * 但"加了分支"和"分支真的会走"是两件事，所以这里用一个只会 429 的桩服务把它走一遍。
 *
 * 用法：node verify-live-429.mjs
 *
 * ⚠️ 2026-10-05 补：子脚本现在还有一道"公网要人机验证"的前置断言，桩必须**照真服务的形状**
 *    回（/api/meta 带 captcha.required=true；不带 x-admin-token 的注册回 400+captcha:true，
 *    带了就豁免）—— 否则子脚本会先在第 111 行说"被验证码拦下了"并退 3，
 *    这条 429 分支压根走不到，而两条路径的退出码都是 3，看起来还会"全绿"。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const check = (name, okk, detail = '') => {
  if (okk) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `　${detail}` : ''}`) }
}

// 桩服务：/api/device/start 一律 429；其余接口要给**形状正确**的响应，
// 否则脚本会先崩在前面的断言上（第一版就是这样，压根走不到 429 分支）。
const hits = []
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    hits.push(`${req.method} ${req.url}`)
    const u = req.url
    if (u.includes('/api/device/start')) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: '请求太频繁，请 10 分钟后再试' }))
      return
    }
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>桩</title></head><body>ok</body></html>')
      return
    }
    let body = { ok: true, items: [] }
    if (u.startsWith('/api/meta')) {
      body = {
        ok: true, modes: [], freeDaily: 100, priceCny: '2.99',
        plans: { free: { daily: 100, retentionText: '5 小时' }, pro: { daily: 1000, days: 30, retentionText: '48 小时' } },
        device: { ttlMs: 600000, interval: 3 },
        // 公网这一份要人机验证（桩要跟真服务一个形状，否则 verify-live.mjs 前面的断言先红）
        captcha: { required: true, chars: 4, ttlMs: 180000 },
      }
    } else if (u.startsWith('/api/register')) {
      // 真服务的规矩：不带验证码 → 400 + captcha:true；带对后台口令 → 豁免。
      // 桩照这个形状回，子脚本才能走到我们要验的那条 429 分支（否则它会先在第 111 行退出）。
      if (!req.headers['x-admin-token']) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, captcha: true, error: '请先填写图片里的验证码' }))
        return
      }
      body = { ok: true, me: { username: 'p1livestub', plan: 'free', quota: { limit: 100, used: 0, remaining: 100 } } }
    } else if (u.startsWith('/api/me')) {
      body = { ok: true, me: { username: 'p1livestub', plan: 'free', quota: { limit: 100, used: 0, remaining: 100 } } }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const outFile = path.join(os.tmpdir(), `verify-live-429-${Date.now()}.log`)
const out = fs.openSync(outFile, 'w')
/**
 * ⚠️ 必须用**异步** spawn，不能用 spawnSync：桩服务就跑在本进程里，
 *    spawnSync 会把本进程的事件循环**整个堵住** —— 于是子进程的请求没人应答，
 *    表现成"子进程卡住不退出、状态码 null"（第一版就是这么骗了我一次）。
 * stdio 用文件描述符而不是管道：管道在本机沙箱下可能直接 EPERM。
 */
const child = spawn(process.execPath, ['verify-live.mjs', base], {
  // 子脚本要求"公网注册要么带验证码要么带后台口令"。桩服务不校验口令的值（它只是个桩），
  // 所以这里塞一个占位值让它走豁免通道 —— 不然它会先在第 111 行退 3，这条 429 分支就验不到了。
  cwd: HERE, stdio: ['ignore', out, out], env: { ...process.env, ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'stub-token' },
})
const status = await new Promise((resolve) => {
  const timer = setTimeout(() => { child.kill(); resolve('timeout') }, 25000)
  child.on('exit', (code) => { clearTimeout(timer); resolve(code) })
})
fs.closeSync(out)
const log = fs.readFileSync(outFile, 'utf8')
fs.unlinkSync(outFile)
// ⚠️ 只 close() 不够：子进程用完的 keep-alive 连接还挂在服务器上，父进程会因为
//    "有活着的 socket"而不退出。连接也要断掉。
server.closeAllConnections?.()
server.close()
server.unref()

console.log('── 桩服务只会 429，看脚本怎么写这件事 ──')
check('★ 退出码是 3（专门的"被限流了，不是产品坏了"）', status === 3, `实际 ${status}`)
check('★ 说清了是限流、而不是报一堆断言失败', log.includes('设备码被限流了'), log.slice(-300))
check('★ 把服务端原话带出来了', log.includes('请求太频繁，请 10 分钟后再试'))
check('★ 告诉了人要怎么办（等 10 分钟 / 重启服务清限流）', log.includes('10 分钟') && log.includes('重启'))
check('★ 没有级联打印一堆 ✗（最多一条）', (log.match(/✗/g) || []).length <= 1, `✗ 出现 ${(log.match(/✗/g) || []).length} 次`)
check('确实请求了 /api/device/start', hits.some((u) => u.includes('/api/device/start')), hits.join(', '))
check('并且尝试了自清（注销临时账号）', hits.some((u) => u.includes('/api/me/purge')), hits.join(', '))

console.log(`\n限流分支验收：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
