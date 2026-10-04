#!/bin/bash
# 部署渲染服务 + 把 /dsh/<id>.md 切到渲染服务。任何一步失败都停下来，不硬闯。
set -e

echo "=== 1. 重启渲染服务（装载新 server.mjs） ==="
systemctl restart dsh-notes-render
sleep 1.5
echo -n "is-active: "; systemctl is-active dsh-notes-render
echo -n "本地直连: "; curl -s -o /tmp/r.html -w "%{http_code} %{content_type} %{size_download}B\n" http://127.0.0.1:8790/dsh/bstx2.md

echo
echo "=== 2. 备份并改写 nginx ==="
cp -a /etc/nginx/sites-available/dsh-remote /root/dsh-remote.pre-patch
echo "已备份 → /root/dsh-remote.pre-patch"
node /opt/dsh-notes-render/patch-nginx.mjs

echo
echo "=== 3. nginx 配置校验 ==="
if nginx -t 2>&1; then
  systemctl reload nginx
  echo ">>> RELOADED OK"
else
  echo ">>> nginx -t 失败，自动回滚"
  cp -a /root/dsh-remote.pre-patch /etc/nginx/sites-available/dsh-remote
  nginx -t
  echo ">>> 已回滚到改动前状态"
  exit 1
fi

echo
echo "=== 4. 经 nginx 本地回环验证（走 8444 + Host 头） ==="
echo -n "渲染页  : "; curl -sk -o /tmp/n.html -w "%{http_code}  %{content_type}  %{size_download}B\n" -H "Host: cyanovo.top" https://127.0.0.1:8444/dsh/bstx2.md
echo -n "原文页  : "; curl -sk -o /tmp/raw.md -w "%{http_code}  %{content_type}  %{size_download}B\n" -H "Host: cyanovo.top" https://127.0.0.1:8444/dsh/raw/bstx2.md
echo -n "不存在的: "; curl -sk -o /dev/null -w "%{http_code}\n" -H "Host: cyanovo.top" https://127.0.0.1:8444/dsh/zzzz9.md

echo
echo "=== 5. 渲染页关键要素 ==="
grep -o "<title>[^<]*</title>" /tmp/n.html || echo "(没找到 title)"
echo -n "代码块数: "; grep -c "code-block" /tmp/n.html || true
grep -o "中文、emoji ✅" /tmp/n.html || echo "(中文丢了！)"
grep -o "<sub>由 dsh-notify-memory 自动记录" /tmp/n.html || echo "(sub 标签没放行)"
echo -n "是否 HTML: "; head -c 15 /tmp/n.html

echo
echo "=== 6. 面板链路未受影响（回归） ==="
echo -n "首页 8444 : "; curl -sk -o /dev/null -w "%{http_code}\n" -H "Host: cyanovo.top" https://127.0.0.1:8444/
echo -n "首页 80   : "; curl -s -o /dev/null -w "%{http_code}\n" -H "Host: cyanovo.top" http://127.0.0.1/
echo -n "hub health: "; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/health
echo -n "hub 公网  : "; curl -sk -o /dev/null -w "%{http_code}\n" -H "Host: cyanovo.top" https://127.0.0.1:8444/dsh-hub/health

echo
echo "=== 7. 服务清单 ==="
for s in dsh-notes-render dsh-hub dsh-remote-panel nginx frps; do
  echo "$s: $(systemctl is-active $s)"
done
