#!/usr/bin/env bash
# 一次性：验证 deploy.sh 幂等 —— 连跑两次，单元备份不应增加、单元内容不应变化。
set -u
cd /opt/dsh-web

before_n=$(ls /etc/systemd/system/dsh-web.service.bak-* 2>/dev/null | wc -l)
before_sum=$(md5sum /etc/systemd/system/dsh-web.service | cut -d' ' -f1)

bash /opt/dsh-web/deploy.sh >/tmp/d1.log 2>&1; e1=$?
bash /opt/dsh-web/deploy.sh >/tmp/d2.log 2>&1; e2=$?

after_n=$(ls /etc/systemd/system/dsh-web.service.bak-* 2>/dev/null | wc -l)
after_sum=$(md5sum /etc/systemd/system/dsh-web.service | cut -d' ' -f1)

echo "第一次 exit=$e1  第二次 exit=$e2"
echo "单元备份份数：前=$before_n 后=$after_n（期望相等）"
echo "单元 md5：前=$before_sum 后=$after_sum（期望相等）"
echo "--- 第二次的 3/8 段 ---"
sed -n '/3\/8/,/4\/8/p' /tmp/d2.log
echo "--- 第二次的 5/8、6/8 提示 ---"
sed -n '/5\/8/,/7\/8/p' /tmp/d2.log
echo "--- 第二次结尾 ---"
tail -4 /tmp/d2.log
echo "--- 单元里的 PUBLIC_BASE ---"
grep -n 'PUBLIC_BASE' /etc/systemd/system/dsh-web.service
rm -f /tmp/d1.log /tmp/d2.log
