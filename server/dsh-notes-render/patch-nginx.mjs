// 把 /dsh/<id>.md 从「静态返回 .md」改成「反代到渲染服务」，URL 完全不变。
// 只做精确字符串替换：找不到目标特征就报错退出，绝不整文件重写 ——
// 服务器上这个文件同时可能有别的会话在改，动得越少越安全。
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'

const FILE = '/etc/nginx/sites-available/dsh-remote'

const OLD = `    # ── 会话完整回答（notes）：公网只读（本段由 deploy-notes.sh 追加）──────
    # 插件把「本轮完整回答」POST 到中枢，中枢落成 /var/www/dsh-notes/<id>.md，
    # 这里按 <id>.md 直接静态返回 —— 不经过 Node，所以中枢挂了链接照样能打开。
    #
    # 为什么用**正则 location** 而不是 location /dsh/ ：
    #   只有严格符合 id 形状的路径才匹配得上，其余（含 ../ 之类）根本进不来，
    #   从匹配层面就杜绝了目录穿越，而不是靠事后过滤。
    # 为什么不会影响面板：
    #   它优先于下面的 location / ，而 location / 里的 rewrite 用的是 break
    #   （break 不会跳出当前 location 重新匹配），所以 /api/* → /dsh/api/* 的
    #   面板链路完全不受影响。
    # ⚠️ 正则两头的引号**不能省**：nginx 会把 \`{4,32}\` 的花括号当成块起始，
    #    报 "missing closing parenthesis in ^/dsh/([A-Za-z0-9_-]"（实测踩过）。
    location ~ "^/dsh/([A-Za-z0-9_-]{4,32})\\.md$" {
        alias /var/www/dsh-notes/$1.md;
        default_type text/markdown;
        # charset 指令只对 charset_types 里列出的类型生效，而 text/markdown
        # 不在默认表里 —— 不写这行中文会按 latin1 发出去，浏览器一片乱码。
        charset_types text/markdown;
        charset utf-8;
        add_header Cache-Control "no-store";
    }`

const NEW = `    # ── 会话完整回答（notes）：公网只读 ────────────────────────────────
    # 插件把「本轮完整回答」POST 到中枢，中枢落成 /var/www/dsh-notes/<id>.md。
    # 同一个 URL（/dsh/<id>.md）现在由本机的 dsh-notes-render 服务渲染成 HTML：
    #   · QQ 推送里的旧链接不用改，点开就是排版好的网页，不再是等宽纯文本
    #   · 渲染服务零依赖、不连外网，中枢挂了也不影响（只是链接打不开而已）
    #   · 渲染服务万一挂了，nginx 会 502；原文仍可用下面的 /dsh/raw/ 取
    #
    # 为什么用**正则 location** 而不是 location /dsh/ ：
    #   只有严格符合 id 形状的路径才匹配得上，其余（含 ../ 之类）根本进不来，
    #   从匹配层面就杜绝了目录穿越，而不是靠事后过滤。
    #   注意 id 字符集不含 "/"，所以 /dsh/raw/<id>.md 不会被下面那条吃掉。
    # 为什么不会影响面板：
    #   它优先于下面的 location / ，而 location / 里的 rewrite 用的是 break
    #   （break 不会跳出当前 location 重新匹配），所以 /api/* → /dsh/api/* 的
    #   面板链路完全不受影响。
    # ⚠️ 正则两头的引号**不能省**：nginx 会把 \`{4,32}\` 的花括号当成块起始，
    #    报 "missing closing parenthesis in ^/dsh/([A-Za-z0-9_-]"（实测踩过）。
    # ⚠️ 正则 location 里的 proxy_pass **不能带 URI**（nginx 直接拒绝），
    #    不带 URI 才会透传原始路径，由渲染服务自己解析 /dsh/<id>.md。

    # 原文：想看未渲染的 markdown 走这里
    location ~ "^/dsh/raw/([A-Za-z0-9_-]{4,32})\\.md$" {
        alias /var/www/dsh-notes/$1.md;
        default_type text/markdown;
        # charset 指令只对 charset_types 里列出的类型生效，而 text/markdown
        # 不在默认表里 —— 不写这行中文会按 latin1 发出去，浏览器一片乱码。
        charset_types text/markdown;
        charset utf-8;
        add_header Cache-Control "no-store";
    }

    # 渲染后的网页（URL 与旧链接完全一致）
    location ~ "^/dsh/([A-Za-z0-9_-]{4,32})\\.md$" {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 15s;
        proxy_connect_timeout 5s;
        add_header Cache-Control "public, max-age=300";
    }`

const src = readFileSync(FILE, 'utf8')

if (!src.includes(OLD)) {
  if (src.includes('proxy_pass http://127.0.0.1:8790')) {
    console.log('SKIP: 已经改过了，无需重复修改')
    process.exit(0)
  }
  console.error('FAIL: 找不到待替换的原始 location 块 —— 文件可能已被其他会话改动，放弃修改')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync('/etc/nginx/backups', { recursive: true })
copyFileSync(FILE, `/etc/nginx/backups/dsh-remote.bak-${stamp}`)
copyFileSync(FILE, `/root/dsh-remote.bak-${stamp}`)

const out = src.replace(OLD, NEW)
if (out === src) {
  console.error('FAIL: 替换未产生变化')
  process.exit(1)
}
writeFileSync(FILE, out, 'utf8')
console.log(`OK: 已改写 ${FILE}（备份 /etc/nginx/backups/dsh-remote.bak-${stamp}）`)
console.log(`    原文件 ${src.length} 字节 → 新文件 ${out.length} 字节`)
