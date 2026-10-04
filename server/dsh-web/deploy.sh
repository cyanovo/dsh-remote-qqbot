#!/usr/bin/env bash
# DSH 通知插件 · 网页端部署脚本（在服务器上以 root 执行）
#
#   bash /opt/dsh-web/deploy.sh
#
# 做六件事：数据目录与三把钥匙 → 装 systemd 服务 → 80 端口 nginx → 443 端口 nginx
#            → 本机/公网自检
# 幂等：重复执行不会叠加配置；每一步都留备份。
#
# ⚠️ 这个脚本必须能**从零复现出现在的线上状态**，否则下次重装就会悄悄丢掉东西。
#    2026-10-03 补进来的三样（此前只在服务器上手工做过一次）：
#      ① 单元里的 `DSH_WEB_PUBLIC_BASE`（设备码提示语里的域名，丢了只会显示"网页"）
#      ② 后台管理口令文件 `$DATA/admin-token`（丢了服务会自己生成一把**你不知道的**口令）
#      ③ 443 站点 `dsh-web-https`（没有它，浏览器地址栏先试 https 就是"网站打不开"）
#      ④ 单元里的 `DSH_WEB_OWNER`（服务启动时把**这个账号**提升成管理员；丢了就只剩口令通道，
#         站点主人的账号会悄悄失去管理员身份）
set -euo pipefail

APP=/opt/dsh-web
DATA=/var/lib/dsh-web
UNIT=/etc/systemd/system/dsh-web.service
SITE=/etc/nginx/sites-available/agentrover
SITE443=/etc/nginx/sites-available/dsh-web-https
PUBLIC_BASE=${DSH_WEB_PUBLIC_BASE:-https://cyanovo.top}
# 站点主人的账号名：服务启动时把它提升成管理员（账号级管理员，与后台口令是两条并列通道）。
# 换主人只需改这里或导出 DSH_WEB_OWNER，然后重跑本脚本。
OWNER=${DSH_WEB_OWNER:-cyanovo}
STAMP=$(date +%Y%m%d-%H%M%S)

echo "=== 1/8 目录与权限 ==="
mkdir -p "$DATA"
chmod 750 "$DATA"
# secret / publish-token / admin-token 由服务自己生成（0600）
[ -f "$DATA/secret" ] || echo "(secret 待服务生成)"
[ -f "$DATA/publish-token" ] || echo "(publish-token 待服务生成)"

echo "=== 2/8 三把钥匙（互不通用：登录 cookie / 用户发布令牌 / 全局发布令牌 / 后台口令）==="
# 后台口令：**先写文件**，这样它由你决定，而不是服务启动时随机生成一把你不知道的。
# 服务侧读的是同一个文件（readOrCreate），所以预写即生效。
if [ -s "$DATA/admin-token" ]; then
  echo "后台口令已存在：$DATA/admin-token（想换就删掉它再跑一次本脚本）"
else
  head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-32 > "$DATA/admin-token"
  chmod 600 "$DATA/admin-token"
  echo "已生成后台口令 → $DATA/admin-token"
  echo "  内容：$(cat "$DATA/admin-token")"
  echo "  ⚠️ 只在这里显示一次，请自己存好（后台页面 /admin.html 要用它登录）"
fi
chmod 600 "$DATA/admin-token"

echo "=== 3/8 systemd 单元 ==="
# 先写到临时文件，再和现有单元比内容 —— 内容一样就跳过（否则每跑一次 deploy 都会多一份 .bak-<stamp>）
UNIT_TMP="$(mktemp)"
cat > "$UNIT_TMP" <<'EOF'
[Unit]
Description=DSH 通知插件 · 网页端（静态页 + 账号/配额/记录 API）
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/dsh-web
ExecStart=/usr/bin/node /opt/dsh-web/server.mjs
Environment=NODE_ENV=production
Environment=DSH_WEB_HOME=/opt/dsh-web
Environment=DSH_WEB_PUBLIC_BASE=__PUBLIC_BASE__
Environment=DSH_WEB_OWNER=__OWNER__
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dsh-web
MemoryMax=180M

[Install]
WantedBy=multi-user.target
EOF
# 占位符必须在**引号 heredoc 之外**替换（引号 heredoc 不做变量展开，这样写更安全：
# 单元内容里的 $ 不会意外被 shell 吃掉）
sed -i "s|__PUBLIC_BASE__|$PUBLIC_BASE|" "$UNIT_TMP"
sed -i "s|__OWNER__|$OWNER|" "$UNIT_TMP"
grep -q "^Environment=DSH_WEB_PUBLIC_BASE=$PUBLIC_BASE$" "$UNIT_TMP" \
  || { rm -f "$UNIT_TMP"; echo "❌ 单元里没写进 DSH_WEB_PUBLIC_BASE"; exit 1; }
# 占位符没被替换掉就会留下字面量 __OWNER__，服务读到的是一个不存在的账号名 —— 必须挡住
grep -q "^Environment=DSH_WEB_OWNER=$OWNER$" "$UNIT_TMP" \
  || { rm -f "$UNIT_TMP"; echo "❌ 单元里没写进 DSH_WEB_OWNER"; exit 1; }
if grep -q '__OWNER__' "$UNIT_TMP"; then
  rm -f "$UNIT_TMP"; echo "❌ 单元里还留着 __OWNER__ 占位符"; exit 1
fi
if [ -f "$UNIT" ] && cmp -s "$UNIT_TMP" "$UNIT"; then
  echo "单元内容没变，跳过备份与写入"
  rm -f "$UNIT_TMP"
else
  if [ -f "$UNIT" ]; then cp -a "$UNIT" "$UNIT.bak-$STAMP"; echo "旧单元已备份：$UNIT.bak-$STAMP"; fi
  install -m 644 "$UNIT_TMP" "$UNIT"
  rm -f "$UNIT_TMP"
fi
# 每次都重启：server.mjs 的内容可能变了而单元没变，只有重启才会加载新代码
systemctl daemon-reload
systemctl enable dsh-web.service >/dev/null 2>&1 || true
systemctl restart dsh-web.service
sleep 1
systemctl is-active --quiet dsh-web.service || { echo "❌ 服务没起来"; journalctl -u dsh-web -n 30 --no-pager; exit 1; }
echo "服务：$(systemctl is-active dsh-web.service)"

echo "=== 4/8 本机自检 ==="
curl -sS -m 5 http://127.0.0.1:8795/health || { echo "❌ 健康检查失败"; exit 1; }
echo

echo "=== 5/8 nginx：80 端口 / 反代到 127.0.0.1:8795 ==="
if grep -q 'proxy_pass http://127.0.0.1:8795;' "$SITE"; then
  echo "已经改过了，跳过"
else
  cp -a "$SITE" "$SITE.bak-dshweb-$STAMP"
  # 定点替换：只动 80 端口那个 server 块里的 `location /`（缩进 4 空格、单独一行）
  # 8443 块里那行是 `location / { proxy_pass ...; }` 写在一行，不会命中这个多行图案
  node - "$SITE" <<'NODE'
const fs = require('fs');
const f = process.argv[2];
const src = fs.readFileSync(f, 'utf8');
const from = '    location / {\n        proxy_pass http://127.0.0.1:8080;';
const to   = '    location / {\n        proxy_pass http://127.0.0.1:8795;';
const n = src.split(from).length - 1;
if (n !== 1) {
  console.error(`❌ 期望恰好命中 1 处，实际 ${n} 处 —— 不修改，请人工确认`);
  process.exit(1);
}
fs.writeFileSync(f, src.replace(from, to));
console.log(`已替换 1 处（原文件已备份为 ${f}.bak-dshweb-STAMP）`);
NODE
fi

# 80 站点的 `/dsh/<id>.md`（老链接形态）。幂等：已经有了就跳过。
# 2026-10-03 实测：80 上原来只有 .html，于是 http 的 .md 是 404、https 的却是 200。
if grep -qF 'A-Za-z0-9_-]{4,32})\.md' "$SITE"; then
  echo "  /dsh/*.md 路由已存在"
else
  cp -a "$SITE" "$SITE.bak-md-$STAMP"
  node - "$SITE" <<'NODE'
const fs = require('fs');
const f = process.argv[2];
const src = fs.readFileSync(f, 'utf8');
const anchor = '    location ~ "^/dsh/([A-Za-z0-9_-]{4,32})\\.html$" {';
const block = [
  '    # 老链接的 .md 形态（2026-10-02 之前发的链接长这样）。',
  '    location ~ "^/dsh/([A-Za-z0-9_-]{4,32})\\.md$" {',
  '        proxy_pass http://127.0.0.1:8790;',
  '        proxy_http_version 1.1;',
  '        proxy_set_header Host $host;',
  '        proxy_set_header X-Real-IP $remote_addr;',
  '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '        proxy_set_header X-Forwarded-Proto $scheme;',
  '        proxy_read_timeout 15s;',
  '        proxy_connect_timeout 5s;',
  '    }',
  '',
].join('\n') + '\n';
const n = src.split(anchor).length - 1;
if (n !== 1) {
  console.error(`❌ 期望锚点恰好 1 处，实际 ${n} 处 —— 不修改，请人工确认`);
  process.exit(1);
}
fs.writeFileSync(f, src.replace(anchor, block + anchor));
console.log('  已补 /dsh/<id>.md 路由');
NODE
fi

echo "=== 6/8 nginx：443 端口（给浏览器用；80 继续留给 QQ 里的链接）==="
if [ -f "$SITE443" ]; then
  echo "已经存在：$SITE443（不覆盖，想重写请先手工删掉它）"
else
  cat > "$SITE443" <<'EOF'
# 443：给**浏览器**用。
#
# 为什么必须有：Chrome / Edge / Safari 的地址栏默认先试 https，443 没人听就直接报
# 「无法访问此网站」。
#
# ⚠️ 为什么**不**把 80 重定向到 443：
#   QQ 里的链接必须保持 `http://大写域名/路径` 这种形式 —— 那是唯一实测能在 QQ 里点开的形式。
#   把 80 重定向掉 = QQ 里所有「查看完整回答」全部点不开。
#   所以 80 与 443 **同时对外**：80 给 QQ，443 给浏览器。
#
# ⚠️ 也**不**加 HSTS：浏览器会永久强制 https，可能把 QQ 内置浏览器的 http 链接顶走。
server {
    listen 443 ssl;
    server_name cyanovo.top;

    ssl_certificate     /etc/letsencrypt/live/cyanovo.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cyanovo.top/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
        charset utf-8;
        add_header Cache-Control "no-store";
    }

    # ── 「完整回答」的网页形态（与 80 端口同源、同内容）────────────────────
    # 80 上只有 .html 一条（QQ 用）；这里两条都给，这样把 http 链接换成 https、
    # 或者浏览器把地址栏升到 https，也能正常渲染（2026-10-03 前这里是 404）。
    # ⚠️ 这里**故意**不写 add_header Cache-Control：渲染服务自己已经回了一条，
    #    nginx 的 add_header 是追加语义，再加一条会变成重复值。
    location ~ "^/dsh/([A-Za-z0-9_-]{4,32})\.md$" {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 15s;
        proxy_connect_timeout 5s;
    }

    location ~ "^/dsh/([A-Za-z0-9_-]{4,32})\.html$" {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 15s;
        proxy_connect_timeout 5s;
    }

    location / {
        proxy_pass http://127.0.0.1:8795;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        client_max_body_size 4m;
    }
}
EOF
  echo "已写入 $SITE443"
fi
# 证书不在就别说"部署成功"——443 会直接握手失败
[ -f /etc/letsencrypt/live/cyanovo.top/fullchain.pem ] \
  || echo "⚠️ 没找到证书 /etc/letsencrypt/live/cyanovo.top/fullchain.pem，443 起不来"
ln -sfn "$SITE443" /etc/nginx/sites-enabled/dsh-web-https

echo "=== 7/8 nginx 语法检查并重载 ==="
nginx -t
systemctl reload nginx

echo "=== 8/8 公网入口自检（走 nginx，不走 8795）==="
code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 -H 'Host: cyanovo.top' http://127.0.0.1/)
echo "http  GET / → HTTP $code"
[ "$code" = "200" ] || { echo "❌ 首页不是 200"; exit 1; }
code443=$(curl -s -k -o /dev/null -w '%{http_code}' -m 8 --resolve "cyanovo.top:443:127.0.0.1" https://cyanovo.top/ || echo 000)
echo "https GET / → HTTP $code443"
[ "$code443" = "200" ] || echo '⚠️ https 不是 200（浏览器会报「无法访问」）—— 检查 443 站点与证书'
acode=$(curl -s -o /dev/null -w '%{http_code}' -m 8 -H 'Host: cyanovo.top' http://127.0.0.1/api/admin/overview)
echo "http  GET /api/admin/overview（不带口令）→ HTTP $acode（期望 401）"
curl -s -m 8 -H 'Host: cyanovo.top' http://127.0.0.1/api/meta | head -c 300; echo

echo
echo "✅ 部署完成"
echo "发布令牌（插件发布记录要用）：$DATA/publish-token"
echo "后台口令（/admin.html 登录用）：$DATA/admin-token"
