#!/usr/bin/env bash
# 验收：5 小时保留期在「进程重启」后依然生效（启动清理必须落盘，不能只清内存）
# 做法：停服务 → 塞两条记录（6 小时前 / 1 小时前，都是真实代码用的数字型 createdAt）→ 启动 → 查磁盘
#
# 两条互相独立的量具（本项目铁律：量具本身也会骗人）：
#   ① 直接读 /var/lib/dsh-web/data.json 的字节
#   ② 打服务自己的 GET /health（它报的是内存里记录数）
# 两者都必须是 1 条，才算通过。
#
# 注：全新部署时 data.json 并不存在（0 用户 0 记录时服务从不落盘），
#     所以本脚本自己负责建库，并在收尾时把「本来不存在」这个原状还原回去。
set -u
DB=/var/lib/dsh-web/data.json
STAMP=$(date +%Y%m%d-%H%M%S)
BAK=/root/dsh-web-accept-$STAMP.json
HAD=0
[ -f "$DB" ] && HAD=1

echo "=== 0) 现状 ==="
echo "data.json 是否存在: $([ "$HAD" = 1 ] && echo 是 || echo '否（全新部署，服务从未落盘）')"
node -e '
const fs=require("fs");
let d=null;
try { d=JSON.parse(fs.readFileSync("/var/lib/dsh-web/data.json","utf8")); } catch(e){}
console.log(d ? `用户 ${Object.keys(d.users||{}).length} ｜记录 ${(d.records||[]).length}` : "（空库）");
'

echo
echo "=== 1) 停服务，造两条记录（6 小时前应被清 / 1 小时前应保留）==="
systemctl stop dsh-web.service
if [ -f "$DB" ]; then cp "$DB" "$BAK"; echo "已备份到 $BAK"; else echo "无需备份（文件本来就不存在）"; fi
node -e '
const fs=require("fs"), p="/var/lib/dsh-web/data.json";
let d;
try { d=JSON.parse(fs.readFileSync(p,"utf8")); } catch(e){ d=null; }
if (!d || typeof d!=="object" || !d.users) d={version:1,users:{},records:[],codes:{}};
d.records=d.records||[];
const mk=(id,ageH)=>({id,createdAt:Date.now()-ageH*3600e3,user:"acceptance",title:"保留期验收",mode:"note",text:"acceptance",url:null});
d.records.push(mk("stale-accept",6));
d.records.push(mk("fresh-accept",1));
fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});
const last=d.records.slice(-2);
console.log("写入后记录数 =",d.records.length);
console.log("两条 createdAt 都是数字型（与真实代码一致）=",last.every(r=>typeof r.createdAt==="number"));
console.log("stale 距今小时数 =",((Date.now()-last[0].createdAt)/3600e3).toFixed(2));
'

echo
echo "=== 2) 启动服务：启动清理必须把过期记录写回磁盘 ==="
systemctl start dsh-web.service
sleep 1.5
echo "服务状态: $(systemctl is-active dsh-web.service)"
echo "--- 启动日志（只看「启动清理」那一行，它在这次改动之前根本不存在）---"
journalctl -u dsh-web.service -n 20 --no-pager | grep -F "启动清理" | sed 's/^/    /' || echo "    （没有「启动清理」这行）"

echo "--- 量具①：直接读磁盘上的 data.json ---"
node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync("/var/lib/dsh-web/data.json","utf8"));
const ids=(d.records||[]).map(r=>r.id);
const stale=ids.includes("stale-accept");
const fresh=ids.includes("fresh-accept");
console.log("重启后磁盘记录数 =",ids.length,"｜",JSON.stringify(ids));
console.log("① 过期记录已从磁盘清掉 =", stale?"❌ 还在":"✅");
console.log("② 未过期记录仍在 =", fresh?"✅":"❌ 被误删");
process.exit((!stale&&fresh&&ids.length===1)?0:1);
'
rc=$?

echo "--- 量具②：打服务自己的 GET /health/detail（它报的是内存里的记录数）---"
# 2026-10-04 安全审计 H5：/health 不再免鉴权报 counts（那本身是信息披露），
# 数字挪到 /health/detail，要后台口令。这里读的就是服务自己那把 admin-token。
node -e '
const need=1;
const fs=require("fs");
const tok=fs.readFileSync("/var/lib/dsh-web/admin-token","utf8").trim();
fetch("http://127.0.0.1:8795/health/detail",{headers:{"x-admin-token":tok}}).then(r=>r.json()).then(j=>{
  console.log("health/detail =",JSON.stringify(j));
  const ok = j.ok===true && j.records===need;
  console.log("③ 服务自报的记录数也是 1 条 =", ok?"✅":"❌");
  process.exit(ok?0:1);
}).catch(e=>{ console.log("health/detail 读取失败:",e.message); process.exit(1); });
'
rc2=$?
[ "$rc" = 0 ] && [ "$rc2" = 0 ] && rc=0 || rc=1

echo
echo "=== 3) 清理本次验收造的记录，并还原「文件本来存不存在」的原状 ==="
systemctl stop dsh-web.service
node -e '
const fs=require("fs"), p="/var/lib/dsh-web/data.json";
const had=process.argv[1]==="1";
const d=JSON.parse(fs.readFileSync(p,"utf8"));
const before=(d.records||[]).length;
d.records=(d.records||[]).filter(r=>r.id!=="fresh-accept"&&r.id!=="stale-accept");
const bad=(d.records||[]).filter(r=>typeof r.createdAt!=="number").map(r=>r.id);
console.log("记录数",before,"→",d.records.length);
console.log("仍有非数字 createdAt 的记录 =",bad.length?bad.join(","):"无");
if (had===false && d.records.length===0 && Object.keys(d.users||{}).length===0) {
  fs.unlinkSync(p);
  console.log("原状还原：删除了本次验收新建的 data.json（部署时它本来就不存在）");
} else {
  fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});
}
' "$HAD"
systemctl start dsh-web.service
sleep 1
echo "服务状态: $(systemctl is-active dsh-web.service)"
if [ "$HAD" = 1 ]; then cp "$BAK" "$DB" && echo "已从备份还原 $DB"; fi
rm -f "$BAK" && echo "已删除备份 $BAK"
node -e 'const fs=require("fs");const tok=fs.readFileSync("/var/lib/dsh-web/admin-token","utf8").trim();fetch("http://127.0.0.1:8795/health/detail",{headers:{"x-admin-token":tok}}).then(r=>r.json()).then(j=>console.log("收尾 health/detail =",JSON.stringify(j)))'
echo
echo "验收退出码 = $rc （0 = 全部通过）"
exit $rc
