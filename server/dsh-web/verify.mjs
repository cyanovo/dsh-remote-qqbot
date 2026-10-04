#!/usr/bin/env node
// 网页端端到端验收 —— 直接打真实服务，不用 mock。
// 用法（在服务器上）： node /opt/dsh-web/verify.mjs [baseUrl]
// 覆盖：公开元数据 / 注册 / 登录 / 会话隔离 / 发布令牌 / 配额 100 次上限 / 兑换码 / 跨用户越权 / 401
import fs from 'node:fs';

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8795';
const TOKEN = fs.readFileSync('/var/lib/dsh-web/publish-token', 'utf8').trim();
const FREE_DAILY = 100;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

let cookie = '';
async function req(path, { method = 'GET', body, token, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Publish-Token'] = token;
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const setc = sc.length ? sc[0] : res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (raw) return { status: res.status, data, text };
  return { status: res.status, data };
}
const login = async (u, p) => {
  const r = await req('/api/login', { method: 'POST', body: { username: u, password: p } });
  if (r.status !== 200) throw new Error('登录失败: ' + JSON.stringify(r.data));
  return r.data.me;
};

const uA = 'vf' + Math.random().toString(36).slice(2, 8);
const uB = 'vf' + Math.random().toString(36).slice(2, 8);
const PW = 'verify-pass-123';

console.log(`\n== 网页端端到端验收 @ ${BASE} ==\n`);

console.log('[1] 公开元数据');
{
  const r = await req('/api/meta');
  ok('GET /api/meta 200', r.status === 200);
  ok('三档模式齐全且 id 正确', JSON.stringify((r.data.modes || []).map((m) => m.id)) === '["chat","note","note-link"]');
  ok('免费额度 100', r.data.freeDaily === FREE_DAILY);
  ok('保留 5 小时', r.data.retentionMs === 5 * 3600 * 1000);
  ok('价格 2.99', r.data.priceCny === '2.99');
  ok('chat 档不占次数 / 其余各占 1', r.data.modes[0].cost === 0 && r.data.modes[1].cost === 1 && r.data.modes[2].cost === 1);
  ok('只有 note-link 带链接', r.data.modes.filter((m) => m.link).map((m) => m.id).join() === 'note-link');
}

console.log('\n[2] 未登录时的行为');
{
  cookie = '';
  const r1 = await req('/api/me');
  ok('GET /api/me 未登录返回 me=null', r1.status === 200 && r1.data.me === null);
  const r2 = await req('/api/records');
  ok('GET /api/records 未登录 401', r2.status === 401);
  const r3 = await req('/api/records/abcdef/view', { method: 'POST' });
  ok('POST /api/records/:id/view 未登录 401', r3.status === 401);
}

console.log('\n[3] 注册与登录');
{
  const r = await req('/api/register', { method: 'POST', body: { username: uA, password: PW } });
  ok('注册 A 200', r.status === 200, uA);
  ok('注册即登录（带 me）', r.data.me && r.data.me.username === uA);
  ok('初始额度 = 100/已用 0', r.data.me.quota.limit === 100 && r.data.me.quota.used === 0 && r.data.me.quota.remaining === 100);

  const dup = await req('/api/register', { method: 'POST', body: { username: uA, password: PW } });
  ok('重复注册 409', dup.status === 409);

  const short = await req('/api/register', { method: 'POST', body: { username: uA + 'x', password: '123' } });
  ok('密码过短被拒 400', short.status === 400);

  const bad = await req('/api/login', { method: 'POST', body: { username: uA, password: 'wrong-pass-x' } });
  ok('错误密码 401', bad.status === 401);

  const me = await login(uA, PW);
  ok('正确密码能登录', me.username === uA);
  ok('每日重置时间在未来', me.quota.resetAt > Date.now());
}

console.log('\n[4] 发布令牌（插件侧入口）');
{
  const noTok = await req('/api/publish', { method: 'POST', body: { username: uA, text: 'x' } });
  ok('无令牌 401', noTok.status === 401);
  const badTok = await req('/api/publish', { method: 'POST', token: 'nope', body: { username: uA, text: 'x' } });
  ok('错令牌 401', badTok.status === 401);

  const r = await req('/api/publish', {
    method: 'POST', token: TOKEN,
    body: { username: uA, title: '验收用的完整回答', text: '第一行\n第二行 中文测试 ✅\n' + 'x'.repeat(500), mode: 'note-link' },
  });
  ok('带令牌发布 200', r.status === 200 && /^[a-z0-9]{6}$/.test(r.data.id || ''), 'id=' + r.data.id);
  ok('过期时间 = 发布时间 + 5 小时', Math.abs((r.data.expiresAt - Date.now()) - 5 * 3600 * 1000) < 5000);
  global.__rid = r.data.id;

  const unknown = await req('/api/publish', { method: 'POST', token: TOKEN, body: { username: 'no-such-user-x', text: 'y' } });
  ok('给不存在的账号发布 404', unknown.status === 404);

  const empty = await req('/api/publish', { method: 'POST', token: TOKEN, body: { username: uA, text: '' } });
  ok('空正文 400', empty.status === 400);
}

console.log('\n[5] 记录可见性与越权');
{
  await login(uA, PW);
  const list = await req('/api/records');
  ok('A 能看到自己的记录', list.status === 200 && list.data.items.length === 1);
  ok('列表是元数据：不含正文', list.status === 200 && list.data.items[0].text === undefined);
  ok('头像字段齐全（title/chars/expiresAt）', !!(list.data.items[0].title && list.data.items[0].chars && list.data.items[0].expiresAt));

  // 换 B 登录，试图读 A 的记录
  const regB = await req('/api/register', { method: 'POST', body: { username: uB, password: PW } });
  ok('注册 B 200', regB.status === 200);
  const bList = await req('/api/records');
  ok('B 看不到 A 的记录', bList.data.items.length === 0);
  const steal = await req(`/api/records/${global.__rid}/view`, { method: 'POST' });
  ok('B 直接按 id 取 A 的全文 → 404（不是 403，不泄露存在性）', steal.status === 404);
  const bq = await req('/api/me');
  ok('越权尝试没有消耗 B 的额度', bq.data.me.quota.used === 0);
}

console.log('\n[6] 取全文消耗额度');
{
  await login(uA, PW);
  const r = await req(`/api/records/${global.__rid}/view`, { method: 'POST' });
  ok('取全文 200', r.status === 200);
  ok('正文逐字返回（含中文）', typeof r.data.record.text === 'string' && r.data.record.text.startsWith('第一行\n第二行 中文测试 ✅'));
  ok('额度已用 1 / 剩 99', r.data.quota.used === 1 && r.data.quota.remaining === 99);
}

console.log('\n[7] 每日 100 次上限（真跑 100 次）');
{
  await login(uA, PW);
  let last429 = null, okCount = 0;
  for (let i = 0; i < 99; i++) {
    const r = await req(`/api/records/${global.__rid}/view`, { method: 'POST' });
    if (r.status === 200) okCount++;
    else last429 = r;
  }
  ok('后续 99 次全部成功（累计 100）', okCount === 99 && last429 === null, `成功 ${okCount}`);
  const me = await req('/api/me');
  ok('已用 = 100 / 剩余 0', me.data.me.quota.used === 100 && me.data.me.quota.remaining === 0);
  const over = await req(`/api/records/${global.__rid}/view`, { method: 'POST' });
  ok('第 101 次 429', over.status === 429, JSON.stringify(over.data.error));
  ok('429 里带回额度信息', over.data.quota && over.data.quota.remaining === 0);
  const still = await req('/api/me');
  ok('被拒后额度没有继续增长（仍是 100）', still.data.me.quota.used === 100);
}

console.log('\n[8] 兑换码：解除上限');
{
  const gen = await req('/api/codes', { method: 'POST', token: TOKEN, body: { count: 1, note: 'verify' } });
  ok('生成兑换码 200', gen.status === 200 && /^DSH-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(gen.data.codes[0]), gen.data.codes && gen.data.codes[0]);
  const code = gen.data.codes[0];
  const bad = await req('/api/redeem', { method: 'POST', body: { code: 'DSH-XXXX-XXXX' } });
  ok('错兑换码 404', bad.status === 404);
  const r = await req('/api/redeem', { method: 'POST', body: { code } });
  ok('兑换成功，档位变 pro', r.status === 200 && r.data.me.upgraded === true && r.data.me.plan === 'pro');
  ok('兑换后到期时间 ≈ 30 天后', Math.abs((r.data.me.proUntil - Date.now()) / 86400000 - 30) < 0.1,
    new Date(r.data.me.proUntil).toISOString());
  // ★ 2026-10-04 安全审计 P0-2：**同一个用户**重放同一张码也算重放。
  //   下面第 182 行只测了"B 用 A 用过的码 → 409"，**从没测过"A 自己再用一次"** ——
  //   判定过去写成 `rec.usedBy && rec.usedBy !== who`，于是自己重放一路 200、天数无限叠加
  //   （审计实测 30 天码连兑 3 次叠成 60 天）。漏洞能活下来，就是因为这里少了一条极性。
  const replay = await req('/api/redeem', { method: 'POST', body: { code } });
  ok('★ 同一张码自己再兑一次 → 409（不许重复叠加）', replay.status === 409, `HTTP ${replay.status}`);
  const meAfterReplay = await req('/api/me');
  ok('★ 重放被拒后 proUntil 一个字没变', meAfterReplay.data.me.proUntil === r.data.me.proUntil,
    `${r.data.me.proUntil} → ${meAfterReplay.data.me.proUntil}`);
  const v = await req(`/api/records/${global.__rid}/view`, { method: 'POST' });
  ok('兑换后第 101 次也能看（额度变成 1000）', v.status === 200);
  // 🔴 这两条在 0.8.x 的 P1 里**故意改了语义**：支持者档不再是"不限次数"，
  //    而是「一天 1000 次、记录留 48 小时」，并且**照样计数**（否则"1000 次/天"是句空话）。
  ok('支持者档额度是 1000（不再是 null）', v.data.quota.limit === 1000, JSON.stringify(v.data.quota));
  ok('支持者档也记账（used 从 100 继续往上走）', v.data.quota.used === 101, String(v.data.quota.used));
  ok('支持者档剩余 = 1000 - 已用', v.data.quota.remaining === 899, String(v.data.quota.remaining));
  ok('支持者档保留期是 48 小时', v.data.quota.retentionText === '48 小时', String(v.data.quota.retentionText));

  // 同一个码不能被别人再用
  await login(uB, PW);
  const again = await req('/api/redeem', { method: 'POST', body: { code } });
  ok('B 想用 A 用过的码 → 409', again.status === 409);
  const bb = await req('/api/me');
  ok('B 没有被升级', bb.data.me.upgraded === false);
}

console.log('\n[9] 偏好与杂项');
{
  await login(uA, PW);
  const r = await req('/api/prefs', { method: 'POST', body: { mode: 'chat' } });
  ok('保存模式 chat 200', r.status === 200 && r.data.me.mode === 'chat');
  const bad = await req('/api/prefs', { method: 'POST', body: { mode: 'nope' } });
  ok('未知模式 400', bad.status === 400);
  const health = await req('/health');
  ok('/health 200', health.status === 200);
  const nf = await req('/api/nope');
  ok('未知 API 404', nf.status === 404);
}

console.log('\n[10] 登出');
{
  const r = await req('/api/logout', { method: 'POST' });
  ok('登出 200', r.status === 200);
  const me = await req('/api/me');
  ok('登出后 me=null', me.data.me === null);
}

console.log(`\n== 结果：通过 ${pass} / 失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
