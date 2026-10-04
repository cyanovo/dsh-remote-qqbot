#!/bin/bash
# 只读探测：搞清楚 8444 到底是哪个 server 块在服务 /dsh/<id>.md
echo "=== 1. 含 dsh-notes 的文件 ==="
grep -rln 'dsh-notes' /etc/nginx/

echo
echo "=== 2. 含 8444 的文件 ==="
grep -rln '8444' /etc/nginx/ 2>/dev/null

echo
echo "=== 3. nginx.conf 的 include 行 ==="
grep -n 'include' /etc/nginx/nginx.conf

echo
echo "=== 4. 监听 8444 的 server 块所在文件 ==="
nginx -T 2>/dev/null | awk '/configuration file/{f=$NF} /listen/{print f" :: "$0}' | grep 8444

echo
echo "=== 5. 监听 8443 的 server 块所在文件 ==="
nginx -T 2>/dev/null | awk '/configuration file/{f=$NF} /listen/{print f" :: "$0}' | grep 8443

echo
echo "=== 6. nginx -T 里所有 dsh-notes / 8790 出现的行号 ==="
nginx -T 2>/dev/null | grep -n 'dsh-notes\|8790'

echo
echo "=== 7. 8444 站点块全文（按 server 块切分） ==="
nginx -T 2>/dev/null | awk '
  /^# configuration file/ { file=$NF }
  /^[[:space:]]*server[[:space:]]*\{/ { inblock=1; buf=""; depth=1 }
  inblock {
    buf = buf "\n" $0
    n = gsub(/\{/, "{"); depth += n
    n = gsub(/\}/, "}"); depth -= n
    if (depth <= 0) {
      if (buf ~ /8444/) print file " ----" buf "\n----"
      inblock=0
    }
  }
' | head -120
