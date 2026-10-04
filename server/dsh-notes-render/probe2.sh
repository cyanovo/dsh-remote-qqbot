#!/bin/bash
echo "########## A. 实际加载的 location 顺序（8444 块） ##########"
nginx -T 2>/dev/null | grep -n 'location\|listen\|server_name\|proxy_pass http://127.0.0.1\|alias /var/www' | sed -n '1,80p'

echo
echo "########## B. /dsh/bstx2.md 的响应头 ##########"
curl -sk -D /tmp/h1 -o /tmp/a.out -H "Host: cyanovo.top" https://127.0.0.1:8444/dsh/bstx2.md
cat /tmp/h1
echo "--- body 前 40 字节 ---"
head -c 40 /tmp/a.out; echo
echo "--- body 字节数 ---"; wc -c < /tmp/a.out

echo
echo "########## C. /dsh/raw/bstx2.md 的响应头 ##########"
curl -sk -D /tmp/h2 -o /tmp/b.out -H "Host: cyanovo.top" https://127.0.0.1:8444/dsh/raw/bstx2.md
cat /tmp/h2
echo "--- body 前 40 字节 ---"; head -c 40 /tmp/b.out; echo

echo
echo "########## D. 直连渲染服务 8790 ##########"
curl -s -D /tmp/h3 -o /tmp/c.out http://127.0.0.1:8790/dsh/bstx2.md
cat /tmp/h3
echo "--- body 前 60 字节 ---"; head -c 60 /tmp/c.out; echo
echo "--- body 字节数 ---"; wc -c < /tmp/c.out

echo
echo "########## E. /var/www/dsh-notes 实际文件 ##########"
ls -l /var/www/dsh-notes/
echo "bstx2.md 字节数: $(wc -c < /var/www/dsh-notes/bstx2.md)"

echo
echo "########## F. 渲染服务进程 ##########"
systemctl status dsh-notes-render --no-pager -n 5 | head -20
ss -ltnp | grep 8790
