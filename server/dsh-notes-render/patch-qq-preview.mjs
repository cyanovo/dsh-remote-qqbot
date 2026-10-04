#!/usr/bin/env node
/**
 * 一次性补丁：让「查看完整回答」的链接能在 **QQ 内置浏览器里直接渲染**。
 *
 * 背景（用户 2026-10-02 反馈）：
 *   QQ 里点 /dsh/<id>.md 那个链接，QQ 弹「如需预览请用浏览器打开」。
 *   原因不是渲染服务坏了 —— 8790 已经能把 markdown 渲染成排版好的 HTML ——
 *   而是 QQ 客户端**按 URL 后缀判定"这是网页还是文件"**：
 *   以 .md 结尾的一律当文件，即使服务端返回 text/html 也不在内置浏览器里渲染。
 *
 * 所以修法是**换后缀**，内容和服务都不动：
 *   · nginx 新增 ^/dsh/<id>.html$ → proxy 到 8790（与 .md 那条同一个后端、同一份内容）
 *   · 中枢把新生成的链接后缀从 .md 改成 .html
 *   · .md 那条 location **保持原样**，老链接继续可用（向后兼容）
 *
 * 设计约束（1.6G 无 swap 的机器 + 线上跑着面板，必须可回滚）：
 *   · 幂等：重复执行只提示"已有"，不会插第二份
 *   · 每个文件先备份成 <file>.bak-<时间戳>，返回码带上备份路径
 *   · nginx 配置改完先 `nginx -t`，**失败就把两个站点文件都还原**，不留半成品
 *   · 只做精确字符串插入/替换，不重写整份配置
 *
 * 用法：node patch-qq-preview.mjs            # 打补丁
 *       node patch-qq-preview.mjs --revert   # 回滚到最近的备份
 */

import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, basename } from 'node:path'

const NX_8444 = '/etc/nginx/sites-available/dsh-remote'
const NX_80 = '/etc/nginx/sites-available/agentrover'
const HUB = '/opt/dsh-hub/server.mjs'
const RENDER = '/opt/dsh-notes-render/server.mjs'

const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const log = []
const say = (m) => { log.push(m); console.log(m) }

const backup = (p) => {
  const b = `${p}.bak-${STAMP}`
  copyFileSync(p, b)
  return b
}

/** 与 8444 上那条 .md location 完全同构，只是后缀换成 .html。 */
function htmlLocation() {
  return `
    # ── 「完整回答」的 .html 形态（2026-10-02 加，专为 QQ）────────────────
    # 为什么必须换后缀：QQ 客户端按 URL 后缀判定「网页 / 文件」。
    # /dsh/<id>.md 即使由 8790 返回 text/html，QQ 仍按 .md 当成文件，
    # 弹「如需预览请用浏览器打开」，不在内置浏览器里渲染。换成 .html 后
    # QQ 才当普通网页直接打开。两条路径指向同一个服务、同一份内容。
    # 为什么新加一条而不是改上面那条 .md：.md 已经被 04:40 那版链接用了，
    # 改动它会断开旧链接；两条并存是零风险的向后兼容做法。
    location ~ "^/dsh/([A-Za-z0-9_-]{4,32})\\.html$" {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 15s;
        proxy_connect_timeout 5s;
        add_header Cache-Control "public, max-age=300";
    }
`
}

function patchNginx(path, label) {
  let s = readFileSync(path, 'utf8')
  if (s.includes('\\.html$')) {
    say(`· ${label}：已经有 .html location，跳过`)
    return null
  }
  const anchor = '    location / {'
  const i = s.indexOf(anchor)
  if (i < 0) throw new Error(`${label}：找不到锚点 "    location / {"，拒绝盲插`)
  const b = backup(path)
  // 插在 location / 之前 —— 正则 location 优先于前缀 location，放哪儿都能命中，
  // 但放在一起便于以后阅读这段 notes 相关配置。
  writeFileSync(path, s.slice(0, i) + htmlLocation() + '\n' + s.slice(i), 'utf8')
  say(`· ${label}：已插入 .html location（备份 ${basename(b)}）`)
  return b
}

/**
 * 渲染服务：原本只认 /dsh/<id>.md，现在让 .html 也走同一条路。
 * 只做两处精确子串替换，**不整体覆盖文件** —— 这份文件可能同时有别的会话在写，
 * 整份 cp 上去会把对方的改动一起抹掉。
 */
function patchRenderer() {
  let s = readFileSync(RENDER, 'utf8')
  if (s.includes('\\.(?:md|html)$')) {
    say('· 渲染服务：已支持 .html 后缀，跳过')
    return null
  }
  const BS = '\\' // 一个反斜杠，用来拼出源码里的正则字面量
  const OLD_PATH = `const PATH_RE = /^${BS}/dsh${BS}/([A-Za-z0-9_-]{3,32})${BS}.md$/`
  const NEW_PATH = `const PATH_RE = /^${BS}/dsh${BS}/([A-Za-z0-9_-]{3,32})${BS}.(?:md|html)$/`
  const OLD_ALT = `(?:${BS}.md)?$/.exec((req.url ?? '').split('?')[0])`
  const NEW_ALT = `(?:${BS}.(?:md|html))?$/.exec((req.url ?? '').split('?')[0])`

  if (!s.includes(OLD_PATH)) throw new Error('渲染服务：没找到 PATH_RE 那一行，拒绝盲改')
  let next = s.replace(OLD_PATH, NEW_PATH)
  if (next.includes(OLD_ALT)) next = next.replace(OLD_ALT, NEW_ALT)

  const b = backup(RENDER)
  writeFileSync(RENDER, next, 'utf8')
  say(`· 渲染服务：PATH_RE / 路由正则现在同时接受 .md 与 .html（备份 ${basename(b)}）`)
  return b
}

function patchHub() {
  let s = readFileSync(HUB, 'utf8')
  if (s.includes('${NOTES_PUBLIC_BASE}/${id}.html')) {
    say('· 中枢：链接后缀已是 .html，跳过')
    return null
  }
  const next = s.replace(/(\$\{NOTES_PUBLIC_BASE\}\/\$\{id\})\.md/, '$1.html')
  if (next === s) throw new Error('中枢：没找到 `url = ...${id}.md` 那一行，拒绝盲改')
  const b = backup(HUB)
  writeFileSync(HUB, next, 'utf8')
  say(`· 中枢：新链接后缀 .md → .html（备份 ${basename(b)}）`)
  return b
}

// ── 回滚 ────────────────────────────────────────────────────────────────
function latestBackup(p) {
  const dir = dirname(p)
  const prefix = `${basename(p)}.bak-`
  const hits = readdirSync(dir).filter((n) => n.startsWith(prefix)).sort()
  return hits.length ? `${dir}/${hits[hits.length - 1]}` : null
}

if (process.argv.includes('--revert')) {
  for (const p of [NX_8444, NX_80, HUB, RENDER]) {
    const b = latestBackup(p)
    if (!b) { say(`· ${p}：没有备份可回滚`); continue }
    copyFileSync(b, p)
    say(`· ${p}：已回滚到 ${basename(b)}`)
  }
  process.exit(0)
}

// ── 打补丁 ──────────────────────────────────────────────────────────────
const touched = []
try {
  const r = patchRenderer()
  if (r) touched.push([RENDER, r])
  const a = patchNginx(NX_8444, 'nginx 8444 站点')
  if (a) touched.push([NX_8444, a])
  const b = patchNginx(NX_80, 'nginx 80 站点')
  if (b) touched.push([NX_80, b])
} catch (err) {
  console.error(`补丁失败：${err.message}`)
  for (const [p, b] of touched) { copyFileSync(b, p); console.log(`已回滚 ${p}`) }
  process.exit(1)
}

// nginx -t 是**唯一**能证明配置合法的办法；不通过就整体还原，绝不 reload。
try {
  const out = execFileSync('nginx', ['-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  say(`· nginx -t 通过：${out.trim().split('\n').pop()}`)
} catch (err) {
  console.error('nginx -t 不通过，回滚两个站点文件：')
  console.error(String(err.stderr || err.stdout || err.message))
  for (const [p, b] of touched) { copyFileSync(b, p); console.log(`已回滚 ${p}`) }
  process.exit(1)
}

try {
  const h = patchHub()
  if (h) touched.push([HUB, h])
} catch (err) {
  console.error(`中枢改动失败（nginx 已改好，可单独重试）：${err.message}`)
  process.exit(1)
}

console.log('\n完成，接下来需要（顺序不能反：先让服务认 .html，再放行路由）：')
console.log('  systemctl restart dsh-notes-render   # 渲染服务加载 .html 路径')
console.log('  systemctl reload nginx               # 放行 /dsh/<id>.html')
console.log('  systemctl restart dsh-hub            # 新链接后缀变 .html')
