/* 后台管理页的前端逻辑。
 *
 * 几条刻意的约束（都是这个项目踩过坑之后定下来的）：
 *   ① 口令只放 sessionStorage（关掉标签页就没了，不写 localStorage 长期留痕）；
 *   ② 所有数据一律走 textContent / createElement 渲染 —— 用户名、备注、标题都是用户可控的，
 *      绝不用 innerHTML 拼字符串（这是 XSS 的标准入口）；
 *   ③ 不引任何第三方脚本／图表库：后台页零依赖，口令页不该多一个外部请求；
 *   ④ 失败一律显式说出来（本项目的老教训：「失败被静默吞掉」比失败更难查）。
 *
 * 两条**并列**的进法（服务端也是两条并列的通道，谁都没把谁削弱）：
 *   · mode='account' —— 用管理员账号登录（/api/login 发 cookie），之后所有请求靠 cookie 走，
 *                       服务端认得出"是谁在操作"（封禁记录里的 bannedBy 就是它）。
 *   · mode='token'   —— 服务器上的后台口令，走 x-admin-token 头。CLI／应急通道，永远有效。
 * ⚠️ 口令为空时**绝不能**发那个头：空字符串在服务端会被当成"带了口令但不对"，
 *    每刷一次页面就白记一次失败，10 次之后主人的 IP 会被锁 10 分钟。
 */
'use strict';

const TOKEN_KEY = 'dsw_admin_token';
const $ = (id) => document.getElementById(id);

let token = '';
let mode = 'token';        // 'token' | 'account'
let who = '';              // 谁在操作（账号模式下是用户名，口令模式下是「服务器口令」）
let view = 'overview';
let lastOverview = null;
let currentUser = null;

/* ── 小工具 ────────────────────────────────────────────────────────────── */

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  return node;
}

function fmtTime(ts) {
  const n = Number(ts);
  if (!n) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtAgo(ts) {
  const n = Number(ts);
  if (!n) return '从没';
  const s = Math.max(0, Date.now() - n) / 1000;
  if (s < 90) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} 天前`;
  return fmtTime(n).slice(0, 10);
}

function msg(id, text, kind) {
  const box = $(id);
  if (!box) return;
  box.textContent = text || '';
  box.className = `msg${kind ? ' ' + kind : ''}`;
}

function fillTable(node, headers, rows) {
  node.replaceChildren();
  // h.num = 右对齐数字；h.act = 钉在右侧的操作列（样式见 admin.css 的 .tbl td.act）
  const headClass = (h) => [h.num ? 'num' : '', h.act ? 'act' : ''].filter(Boolean).join(' ');
  const thead = el('thead', null, el('tr', null, ...headers.map((h) => el('th', { class: headClass(h), text: h.label }))));
  const tbody = el('tbody');
  if (!rows.length) {
    tbody.append(el('tr', null, el('td', { colspan: headers.length, class: 'mini', text: '（没有数据）' })));
  } else {
    for (const row of rows) {
      const tr = el('tr');
      for (const cell of row) tr.append(el('td', { class: cell && cell.cls ? cell.cls : '' }, cell && cell.node ? cell.node : String(cell == null ? '—' : cell)));
      tbody.append(tr);
    }
  }
  node.append(thead, tbody);
}

function tag(text, kind) {
  return el('span', { class: `tag${kind ? ' ' + kind : ''}`, text });
}

/* ── 与后台接口说话 ────────────────────────────────────────────────────── */

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  // 🔴 只在**真有口令**时才发这个头。空字符串会被服务端当成"带了口令但不对"（bad-token），
  //    走账号通道时每次请求都白记一次失败 → 10 次之后主人的 IP 被锁 10 分钟。
  if (token) headers['x-admin-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    throw new Error(`连不上服务器（${err.message}）`);
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 下面按状态码报错 */ }
  if (r.status === 401) {
    lockGate(mode === 'account' ? '登录已失效，请重新登录' : '口令不对（连错太多次会被锁 10 分钟）');
    throw new Error(mode === 'account' ? '登录已失效' : '口令不对');
  }
  if (r.status === 429) { lockGate((json && json.error) || '口令错太多次，暂时锁住了'); throw new Error('被限流'); }
  if (!r.ok || !json || json.ok === false) throw new Error((json && json.error) || `请求失败（HTTP ${r.status}）`);
  return json;
}

/* ── 人机验证（后台的「账号登录」这条通道）──────────────────────────────
   和前台登录页同一道闸：后台账号密码更值钱，没有理由只在前台拦机器。
   「后台口令」那条通道不受影响（口令本身就是全权凭证，服务端直接免验证码）。
   🔴 带对 x-admin-token 的请求**免验证码**（见 server.mjs「人机验证」一节）——
      所以 _live-*.mjs 这类线上验收脚本仍能登录；而前台浏览器请求一律要过这一关。 */
let capId = '';
// 拿不到 /api/meta 时按"要验证码"来：宁可多要一张，不可放过。真值由 probeCaptcha() 填。
let capRequired = true;
let capProbed = false;

/** 问服务端"这次要不要验证码"（/api/meta 的 captcha.required）：
 *  本机直连（回环）与带对后台口令的请求服务端一律免掉 —— 前端也就不该拿一张必被忽略的图去烦人。
 *  ⚠️ 不问就一律要，会让本机验收（verify-admin-ui.mjs：真浏览器打 127.0.0.1）卡在一张
 *     服务端根本不看的图上，而且那种"红"看着像产品坏了。 */
async function probeCaptcha() {
  try {
    // 同样不走 api()：这一句在闸门还没开的时候跑，api() 遇 401 会去调 lockGate
    const r = await fetch('/api/meta', { headers: { Accept: 'application/json' } })
    const j = await r.json()
    capRequired = !(j && j.captcha && j.captcha.required === false)
  } catch { capRequired = true }
  capProbed = true;
  const box = $('capBox_admin');
  if (box) box.hidden = !capRequired;
  if (capRequired) loadCaptcha();
}

async function loadCaptcha() {
  const img = $('capImg_admin');
  capId = '';
  if (img) { img.classList.add('is-loading'); img.removeAttribute('src'); }
  try {
    // ⚠️ 这里刻意**不走 api()**：api() 遇到 401/429 会调 lockGate，而 lockGate 结尾又会调回本函数 ——
    //    验证码接口一旦被限流，就成了无限递归。所以这里用裸 fetch。
    const r = await fetch('/api/captcha', { headers: { Accept: 'application/json' } });
    let j = null;
    try { j = await r.json(); } catch { /* 下面按状态码报错 */ }
    if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || `HTTP ${r.status}`);
    capId = j.id;
    const el = $('capImg_admin');
    if (el) { el.src = j.image; el.classList.remove('is-loading'); }
    const box = $('capText_admin');
    if (box) box.value = '';
  } catch (e) {
    const el = $('capImg_admin');
    if (el) el.classList.remove('is-loading');
    msg('gateMsg', '验证码没加载出来：' + e.message + '（点「换一张」重试）', 'err');
  }
}

/* ── 闸门（两条通道） ──────────────────────────────────────────────────── */

function showPane(which) {
  const account = which !== 'token';
  $('gatePaneAccount').hidden = !account;
  $('gatePaneToken').hidden = account;
  $('gateTabAccount').setAttribute('aria-current', account ? 'true' : 'false');
  $('gateTabToken').setAttribute('aria-current', account ? 'false' : 'true');
  msg('gateMsg', '');
  // 切到账号通道时保证手上有一张没被用掉的验证码（每次进来一张新图）
  if (account && capProbed && capRequired && !capId) loadCaptcha();
  const focus = account ? $('gateUser') : $('gateToken');
  if (focus && !$('gate').hidden) focus.focus();
}

function sideWhoText() {
  if (mode === 'account') return `已登录：${who}${who ? '（管理员）' : ''}`;
  return who === '服务器口令' ? '口令通道（应急）' : '未登录';
}

function paintWho() {
  const box = $('sideWho');
  if (box) box.textContent = sideWhoText();
}

function lockGate(reason) {
  // 账号通道退出时把服务端的会话也一起丢掉 —— 只清前端状态的话，
  // 别人再打开这个页面会**发现自己还是登录着的**。
  if (mode === 'account') {
    try { fetch('/api/logout', { method: 'POST', headers: { Accept: 'application/json' } }).catch(() => {}); } catch { /* 尽力而为 */ }
  }
  token = '';
  mode = 'token';
  who = '';
  sessionStorage.removeItem(TOKEN_KEY);
  $('app').hidden = true;
  $('gate').hidden = false;
  paintWho();
  const g = $('gatePass');
  if (g) g.value = '';
  // 闸门重新亮出来时换一张新验证码：旧的那张多半已经用掉/作废了
  if (!$('gatePaneAccount').hidden && capRequired) loadCaptcha();
  if (reason) msg('gateMsg', reason, 'err');
}

async function tryEnter(candidate) {
  // HTTP 头只能放 ASCII —— 口令里带中文/空格时 fetch 会在**发出请求之前**就抛
  // TypeError（"String contains non ISO-8859-1 code point"）。那种英文报错对主人毫无意义，
  // 而且如果不在这里拦下，它会走进下面的 catch 被当成"连不上服务器"。
  if (/[^\x21-\x7e]/.test(candidate)) {
    sessionStorage.removeItem(TOKEN_KEY);
    msg('gateMsg', '口令里不能有中文、空格或全角符号（后台口令是一串十六进制字符）', 'err');
    return;
  }
  mode = 'token';
  who = '服务器口令';
  token = candidate;
  try {
    const ov = await api('/api/admin/overview');
    sessionStorage.setItem(TOKEN_KEY, token);
    $('gate').hidden = true;
    $('app').hidden = false;
    msg('gateMsg', '');
    paintWho();
    renderOverview(ov);
  } catch (err) {
    token = '';
    mode = 'token';
    who = '';
    // 🔴 失败必须把存下来的口令**删掉**：否则每次刷新都会拿它再试一次，
    //    界面卡在"输了口令却进不去"的循环里（本轮验收就是这么发现的）。
    sessionStorage.removeItem(TOKEN_KEY);
    paintWho();
    msg('gateMsg', err.message === '口令不对' ? '口令不对' : err.message, 'err');
  }
}

/* 账号通道：先真登录（拿 cookie），再用 cookie 探一次后台接口确认"这个人确实是管理员"。
   两步缺一不可 —— 只登录不探权的话，普通账号会进入一个每个接口都 403 的空壳界面。 */
async function tryLogin() {
  const name = $('gateUser').value.trim();
  const pass = $('gatePass').value;
  if (!name || !pass) { msg('gateMsg', '用户名和密码都要填', 'err'); return; }
  if (capRequired) {
    if (!capId) { msg('gateMsg', '验证码还没加载出来，点「换一张」重试', 'err'); loadCaptcha(); return; }
    // 空着就别白跑一趟（服务端也会拒，但那是一次没必要的往返）
    if (!($('capText_admin').value || '').trim()) { msg('gateMsg', '请照图填写这 4 位验证码（看不清就点「换一张」）', 'err'); return; }
  }
  mode = 'account';
  who = name;
  token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  const btn = $('gateLoginBtn');
  if (btn) btn.disabled = true;
  try {
    let r;
    try {
      r = await fetch('/api/login', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: name,
          password: pass,
          ...(capRequired ? { captchaId: capId, captchaText: ($('capText_admin').value || '').trim() } : {}),
        }),
      });
    } catch (err) {
      throw new Error(`连不上服务器（${err.message}）`);
    }
    let j = null;
    try { j = JSON.parse(await r.text()); } catch { /* 下面按状态码报错 */ }
    if (!r.ok || !j || j.ok === false) {
      // 被封禁的账号登录时服务端会回 403 + banned:true —— 这里要把原因原样说出来
      throw new Error((j && j.error) || (r.status === 401 ? '用户名或密码不对' : `登录失败（HTTP ${r.status}）`));
    }
    const ov = await api('/api/admin/overview');
    $('gatePass').value = '';
    $('gate').hidden = true;
    $('app').hidden = false;
    msg('gateMsg', '');
    paintWho();
    renderOverview(ov);
  } catch (err) {
    // 普通账号：服务端会明确回「这个账号不是管理员」，但我们刚给它建了一个真会话，
    // 必须**主动注销**，不能把"登录着但不是管理员"的状态留在浏览器里。
    if (mode === 'account' && !$('gate').hidden) {
      try { fetch('/api/logout', { method: 'POST', headers: { Accept: 'application/json' } }).catch(() => {}); } catch { /* 尽力而为 */ }
    }
    // 被拒就把密码框清掉：拒绝之后没有理由继续把口令留在输入框里
    try { $('gatePass').value = ''; } catch { /* 元素不在就算了 */ }
    mode = 'token';
    who = '';
    paintWho();
    // 失败一律换一张：这张不是被用掉了就是作废了，留着只会让人抱着废图反复点
    if (capRequired) loadCaptcha();
    msg('gateMsg', err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* 刷新页面时的静默探测：先前用账号登录过的话，cookie 还在，直接进去（不用重新打字）。
   ⚠️ 这里**不能**走 api()：api() 遇到 401 会调 lockGate 并写一句「登录已失效」——
      一个从没登录过的人第一次打开页面，不该看到"失效"这种吓人的报错。 */
async function trySession() {
  mode = 'account';
  who = '';
  token = '';
  // 顺手把"我是谁"取回来（服务端的 overview 里没有操作人字段）。
  // 取不到也不影响进后台，只是侧栏显示成空名字。
  let meName = '';
  try {
    const mr = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    if (mr.ok) {
      const mj = JSON.parse(await mr.text());
      if (mj && mj.me && mj.me.username) meName = String(mj.me.username);
    }
  } catch { /* 忽略 */ }
  let r;
  try {
    r = await fetch('/api/admin/overview', { headers: { Accept: 'application/json' } });
  } catch { r = null; }
  if (!r || !r.ok) {
    mode = 'token';
    who = '';
    paintWho();
    $('gate').hidden = false;
    $('app').hidden = true;
    return false;
  }
  let ov = null;
  try { ov = JSON.parse(await r.text()); } catch { ov = null; }
  if (!ov || ov.ok !== true) {
    mode = 'token';
    who = '';
    paintWho();
    $('gate').hidden = false;
    $('app').hidden = true;
    return false;
  }
  $('gate').hidden = true;
  $('app').hidden = false;
  msg('gateMsg', '');
  who = meName;
  paintWho();
  renderOverview(ov);
  return true;
}

/* ── 概览 ──────────────────────────────────────────────────────────────── */

function renderOverview(ov) {
  lastOverview = ov;
  const t = ov.totals || {};
  const c = ov.config || {};
  $('ovWhen').textContent = `服务器时间 ${fmtTime(ov.now)} ｜ 已运行 ${Math.floor((ov.uptimeSec || 0) / 3600)} 小时 ｜ 占用内存 ${ov.memoryMB} MB`;

  const stats = [
    ['用户', t.users], ['管理员', t.adminUsers], ['已封禁', t.bannedUsers], ['付费版', t.proUsers],
    ['记录', t.records],
    ['今日查看', t.viewsToday], ['7 天查看', t.views7d], ['24 小时新记录', t.records24h],
    ['待批准设备', t.devices], ['未用兑换码', t.codes && t.codes.unused],
  ];
  $('ovStats').replaceChildren(...stats.map(([label, value]) =>
    el('div', { class: 'stat' }, el('b', { text: value == null ? '—' : value }), el('span', { text: label }))));

  const cfgLines = [
    `免费版：每天 ${c.freeDaily} 次 · 记录保留 ${c.retentionText}`,
    `付费版：每天 ${c.proDaily} 次 · 记录保留 ${c.proRetentionText} · 兑换一次 ${c.proDays} 天`,
    `标价：¥${c.priceCny}（没有在线支付，靠兑换码手工发）`,
    `设备码有效期：${c.deviceTtlMin} 分钟`,
    `口令文件：${c.adminFile}`,
  ];
  $('ovConfig').replaceChildren(...cfgLines.map((line) => el('div', { text: line })));

  const trend = ov.trend || [];
  const max = Math.max(1, ...trend.map((d) => d.views));
  $('ovTrend').replaceChildren(...trend.map((d) => el('div', { class: 'bar-row' },
    el('span', { text: d.day.slice(5) }),
    el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', style: `width:${Math.round((d.views / max) * 100)}%` })),
    el('span', { class: 'v', text: String(d.views) }),
  )));

  $('nUsers').textContent = t.users == null ? '-' : t.users;
  $('nRecords').textContent = t.records == null ? '-' : t.records;
  $('nCodes').textContent = t.codes ? t.codes.unused : '-';
  $('nDevices').textContent = t.devices == null ? '-' : t.devices;
  $('sideInfo').textContent = `${sideWhoText()} ｜ 刷新于 ${new Date().toLocaleTimeString('zh-CN')}`;
  paintWho();
}

async function refreshOverview(silent) {
  try {
    renderOverview(await api('/api/admin/overview'));
    if (!silent) msg('ovMsg', '已刷新', 'ok');
  } catch (err) {
    if (!silent) msg('ovMsg', err.message, 'err');
  }
}

/* ── 用户 ──────────────────────────────────────────────────────────────── */

async function loadUsers() {
  const q = $('uSearch').value.trim();
  const sort = $('uSort').value;
  msg('uMsg', '读取中…');
  try {
    const res = await api(`/api/admin/users?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}`);
    renderUsers(res);
    msg('uMsg', `共 ${res.total} 个账号${q ? `（搜到 ${res.items.length} 个）` : ''}`);
  } catch (err) {
    msg('uMsg', err.message, 'err');
  }
}

function renderUsers(res) {
  const openName = currentUser && currentUser.user ? currentUser.user.username : null;
  const rows = res.items.map((u) => [
    { node: el('span', { class: 'who' },
      el('button', { class: 'btn ghost', text: u.username, title: `看 ${u.username} 的详情`, onclick: () => openUser(u.username) }),
      u.admin === true ? tag('管理员', 'warn') : null,
      u.banned ? tag('已封禁', 'danger') : null) },
    { node: u.plan === 'pro' ? tag(u.proForever ? '永久付费版' : `付费版 ${u.proDaysLeft} 天`, 'pro') : tag('免费版', 'free') },
    { cls: 'num', node: String(u.limit) },
    { cls: 'num', node: String(u.usedToday) },
    { cls: 'num', node: String(u.viewsTotal) },
    { cls: 'num', node: String(u.records) },
    { cls: 'num', node: String(u.tokens) },
    { node: fmtAgo(u.lastSeenAt) },
    { node: fmtTime(u.createdAt) },
    // 🔴 这一列是 2026-10-04 补的。之前表里**一个操作按钮都没有**，唯一入口是"点用户名"，
    //    而用户名长得就是一行普通文字（btn ghost = 无边框无底色）—— 主人因此以为"没有用户管理"。
    //    光靠"点用户名"这种隐式入口不够，必须有一个写明了用途的按钮。
    { cls: 'act', node: el('button', { class: 'btn', text: '管理',
      title: `给 ${u.username}：加 Pro / 取消 Pro / 封禁 / 解封 / 重置密码 / 删除`,
      onclick: () => openUser(u.username) }) },
  ]);
  fillTable($('uList'), [
    { label: '用户名' }, { label: '档位' }, { label: '额度/天', num: true }, { label: '今日', num: true },
    { label: '累计查看', num: true }, { label: '记录', num: true }, { label: '令牌', num: true },
    { label: '最近活跃' }, { label: '注册时间' }, { label: '操作', act: true },
  ], rows);
  // 详情面板在表格**上方**：滚到下面点某一行时，得让主人看得出正在看谁
  const trs = $('uList').querySelectorAll('tbody tr');
  res.items.forEach((u, i) => { if (trs[i]) trs[i].dataset.user = u.username; });
  markActiveRow(openName);
}

/* 高亮正在看的那一行；没有打开的详情就全不高亮。 */
function markActiveRow(name) {
  for (const tr of $('uList').querySelectorAll('tbody tr')) {
    tr.classList.toggle('on', !!name && tr.dataset.user === name);
  }
}

async function openUser(name) {
  try {
    const res = await api(`/api/admin/users/${encodeURIComponent(name)}`);
    currentUser = res;
    renderUserDetail(res);
    markActiveRow(name);
  } catch (err) {
    msg('uMsg', err.message, 'err');
  }
}

function renderUserDetail(res) {
  const u = res.user;
  const wrap = $('uDetail');
  const actions = el('div');

  const daysInput = el('input', { type: 'number', value: '30', min: '1', max: '36500', title: '给多少天' });
  const pwInput = el('input', { type: 'text', placeholder: '新的密码（≥6 位）' });
  const banInput = el('input', { type: 'text', placeholder: '比如：薅羊毛 / 发垃圾内容' });

  const doGrant = async (payload, note) => {
    try {
      const r = await api('/api/admin/user/grant', { method: 'POST', body: { username: u.username, ...payload } });
      msg('uMsg', `${note}：${describePlan(r.user)}`, 'ok');
      await openUser(u.username);
      refreshOverview(true);
    } catch (err) { msg('uMsg', err.message, 'err'); }
  };

  const doBan = async () => {
    if (u.banned) {
      if (!confirm(`解封 ${u.username}？记录、令牌、档位全部原样回来。`)) return;
      try {
        await api('/api/admin/user/ban', { method: 'POST', body: { username: u.username, banned: false } });
        msg('uMsg', `已解封 ${u.username}`, 'ok');
        await openUser(u.username);
        loadUsers();
        refreshOverview(true);
      } catch (err) { msg('uMsg', err.message, 'err'); }
      return;
    }
    if (!confirm(`封禁 ${u.username}？TA 立刻登录不了、也发不出记录。\n封禁只是标记，一条数据都不删，随时能解封。`)) return;
    try {
      await api('/api/admin/user/ban', { method: 'POST', body: { username: u.username, reason: banInput.value.trim() } });
      msg('uMsg', `已封禁 ${u.username}：TA 现在登录不了、也发不出记录（数据都还在，随时能解封）`, 'ok');
      await openUser(u.username);
      loadUsers();
      refreshOverview(true);
    } catch (err) { msg('uMsg', err.message, 'err'); }
  };

  const doAdmin = async () => {
    const want = u.admin !== true;
    if (!confirm(want
      ? `把 ${u.username} 设为管理员？TA 登录后就能进这个后台。`
      : `取消 ${u.username} 的管理员身份？`)) return;
    try {
      await api('/api/admin/user/admin', { method: 'POST', body: { username: u.username, admin: want } });
      msg('uMsg', want ? `${u.username} 现在是管理员了` : `${u.username} 的管理员身份已取消`, 'ok');
      await openUser(u.username);
      loadUsers();
      refreshOverview(true);
    } catch (err) { msg('uMsg', err.message, 'err'); }
  };

  // 🔴 封禁原因用**页面里的输入框**，不用 window.prompt ——
  //    原生弹窗会卡住无头浏览器的验收脚本（本项目已经为 confirm 踩过一次），
  //    而且原生框长得跟这个深色后台完全不搭。
  //
  // 🔴 2026-10-04：这里原来是一坨没有标题的按钮（两行 mini-form + 一行 actions），
  //    主人看不出"这页能干什么"，而且「取消 Pro」当时挂着「退出该账号登录」的牌子
  //    —— 想取消 Pro 的人永远找不到它。现在按能力分三组，每组带 h3 标题。
  actions.append(
    el('h3', { class: 'act-h', text: '付费版（Pro）' }),
    el('div', { class: 'mini-form' },
      el('span', { class: 'mini', text: '给 ' }), daysInput, el('span', { class: 'mini', text: '天' }),
      el('button', { class: 'btn', text: '叠加这么多天', onclick: () => doGrant({ days: Number(daysInput.value) || 30 }, `+${Number(daysInput.value) || 30} 天`) }),
      el('button', { class: 'btn', text: '设为永久', onclick: () => doGrant({ forever: true }, '设为永久付费版') }),
      el('button', { class: 'btn', text: '取消 Pro（改回免费版）', onclick: async () => {
        if (!confirm(`把 ${u.username} 改回免费版？记录不会删。`)) return;
        await doGrant({ revoke: true }, '已改回免费版');
      } }),
    ),
    el('p', { class: 'hint', text: '加天数是「叠加」：从 TA 现在的到期时间往后加，不从今天重算。取消 Pro 只掉档，记录一条都不删。' }),

    el('h3', { class: 'act-h', text: u.banned ? '封禁（现在封着）' : '封禁' }),
    el('div', { class: 'mini-form' },
      el('span', { class: 'mini', text: u.banned ? '封禁原因：' : '封禁原因（可留空）：' }),
      u.banned ? null : banInput,
      el('button', { class: 'btn', text: u.banned ? '解封账号' : '封禁账号', onclick: doBan }),
      el('span', { class: 'mini', text: u.banned ? '解封后记录 / 令牌 / 档位原样回来' : '只标记，不删数据' }),
    ),

    el('h3', { class: 'act-h', text: '账号管理' }),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', text: u.admin === true ? '取消管理员' : '设为管理员', onclick: doAdmin }),
      el('button', { class: 'btn', text: '清空今日额度', onclick: async () => {
        try {
          const r = await api('/api/admin/user/quota', { method: 'POST', body: { username: u.username } });
          msg('uMsg', `今日额度已清零（累计查看仍是 ${r.user.viewsTotal} 次，清不掉）`, 'ok');
          await openUser(u.username);
        } catch (err) { msg('uMsg', err.message, 'err'); }
      } }),
      el('button', { class: 'btn', text: '删除账号', onclick: async () => {
        if (!confirm(`删除 ${u.username}？会连同 TA 的记录一起删掉，不能撤销。`)) return;
        try {
          const r = await api('/api/admin/user/delete', { method: 'POST', body: { username: u.username } });
          currentUser = null;
          $('uDetail').replaceChildren();
          await loadUsers();
          msg('uMsg', `已删除 ${r.deleted}（连记录 ${r.recordsDeleted} 条）`, 'ok');
          refreshOverview(true);
        } catch (err) { msg('uMsg', err.message, 'err'); }
      } }),
    ),
    el('div', { class: 'mini-form' },
      pwInput,
      el('button', { class: 'btn', text: '重置密码', onclick: async () => {
        try {
          await api('/api/admin/user/password', { method: 'POST', body: { username: u.username, password: pwInput.value } });
          msg('uMsg', `已重置 ${u.username} 的密码（旧密码立刻失效）`, 'ok');
          pwInput.value = '';
        } catch (err) { msg('uMsg', err.message, 'err'); }
      } }),
    ),
  );

  const usageBars = (() => {
    const list = res.usage || [];
    if (!list.length) return el('p', { class: 'hint', text: '这个账号还没有查看过任何记录。' });
    const max = Math.max(1, ...list.map((d) => d.views));
    return el('div', { class: 'bars' }, ...list.slice(0, 30).map((d) => el('div', { class: 'bar-row' },
      el('span', { text: d.day.slice(5) }),
      el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', style: `width:${Math.round((d.views / max) * 100)}%` })),
      el('span', { class: 'v', text: String(d.views) }),
    )));
  })();

  const tokenTable = el('table', { class: 'tbl' });
  fillTable(tokenTable, [{ label: '前缀' }, { label: '标签' }, { label: '创建' }, { label: '最近使用' }, { label: '' }],
    (res.tokens || []).map((t) => [
      { cls: 'mono', node: t.prefix },
      t.label || '—',
      fmtTime(t.createdAt),
      t.lastUsedAt ? fmtTime(t.lastUsedAt) : '没用过',
      { node: el('button', { class: 'btn ghost', text: '吊销', onclick: async () => {
        if (!confirm(`吊销令牌 ${t.prefix}…？用它的插件会立刻发不出记录。`)) return;
        try {
          await api('/api/admin/token/revoke', { method: 'POST', body: { username: u.username, id: t.prefix } });
          msg('uMsg', `已吊销 ${t.prefix}…`, 'ok');
          await openUser(u.username);
        } catch (err) { msg('uMsg', err.message, 'err'); }
      } }) },
    ]));

  const recTable = el('table', { class: 'tbl' });
  fillTable(recTable, [{ label: 'id' }, { label: '标题' }, { label: '模式' }, { label: '字数', num: true }, { label: '发布' }, { label: '到期' }, { label: '' }],
    (res.records || []).map((r) => [
      { cls: 'mono', node: r.id },
      { cls: 'wrap', node: r.title || '（无标题）' },
      r.mode || '—',
      { cls: 'num', node: String(r.chars == null ? '—' : r.chars) },
      fmtTime(r.createdAt),
      fmtTime(r.expiresAt),
      { node: el('button', { class: 'btn ghost', text: '删除', onclick: async () => {
        try {
          await api('/api/admin/records/delete', { method: 'POST', body: { id: r.id } });
          msg('uMsg', `已删除记录 ${r.id}`, 'ok');
          await openUser(u.username);
        } catch (err) { msg('uMsg', err.message, 'err'); }
      } }) },
    ]));

  wrap.replaceChildren(el('div', { class: 'detail' },
    el('h2', { text: u.username }),
    el('div', { class: 'row' },
      u.plan === 'pro' ? tag(u.proForever ? '永久付费版' : `付费版（还剩 ${u.proDaysLeft} 天）`, 'pro') : tag('免费版', 'free'),
      u.admin === true ? tag('管理员', 'warn') : null,
      u.banned ? tag('已封禁', 'danger') : null,
      el('span', { class: 'mini', text: `每天 ${u.limit} 次 ｜ 今日已用 ${u.usedToday} ｜ 累计 ${u.viewsTotal} 次 ｜ 保留 ${u.retentionText}` }),
    ),
    el('p', { class: 'hint', text: `注册 ${fmtTime(u.createdAt)} ｜ 最近活跃 ${fmtAgo(u.lastSeenAt)} ｜ 记录 ${u.records} 条 ｜ 令牌 ${u.tokens} 个` }),
    u.banned
      ? el('p', { class: 'hint err', text: `这个账号正在封禁中：${fmtTime(u.bannedAt)}${u.banReason ? `（原因：${u.banReason}）` : '（没写原因）'}${u.bannedBy ? ` ｜ 操作人：${u.bannedBy}` : ''}。记录、令牌、档位都还在。` })
      : null,
    actions,
    el('h3', { text: '按天用量' }), usageBars,
    el('h3', { text: '发布令牌（只给前缀；后台也看不到明文）' }), el('div', { class: 'tbl-wrap' }, tokenTable),
    el('h3', { text: '记录（只有元信息，没有正文）' }), el('div', { class: 'tbl-wrap' }, recTable),
    el('p', { class: 'hint', text: '后台读不到任何人的正文：服务端在列表接口里就没返回 text 字段。' }),
    el('div', { class: 'row', style: 'margin-top:12px' },
      el('button', { class: 'btn', text: '收起', onclick: () => { $('uDetail').replaceChildren(); markActiveRow(null); } })),
  ));

  // 🔴 2026-10-04：详情面板（#uDetail）在用户列表**上方**。列表长起来以后，
  //    主人是从下面某一行的「管理」点进来的，面板会在**视野之外**被渲染出来 ——
  //    表现就是"点了没反应"。所以每次渲染完必须把它拉到视野里。
  //    用 scrollIntoView 而不是 window.scrollTo(abs) —— 不写死任何坐标，布局改了也不会失效。
  try { wrap.scrollIntoView({ block: 'start' }); } catch { /* 老浏览器没有这个方法，忽略 */ }
}

function describePlan(user) {
  return user.plan === 'pro'
    ? (user.proForever ? '现在是永久付费版' : `现在是付费版，还剩 ${user.proDaysLeft} 天`)
    : '现在是免费版';
}

async function createUser() {
  const username = $('uCreateUser').value.trim();
  const password = $('uCreatePass').value;
  const forever = $('uCreateForever').checked;
  const days = Number($('uCreateDays').value) || 0;
  if (!username || !password) return msg('uMsg', '用户名和密码都要填', 'err');
  try {
    const body = { username, password };
    if (forever) body.forever = true;
    else if (days > 0) body.days = days;
    const r = await api('/api/admin/user/create', { method: 'POST', body });
    $('uCreateUser').value = '';
    $('uCreatePass').value = '';
    // ⚠️ 回执必须写在 loadUsers() **之后**：loadUsers 会把 #uMsg 改成「共 N 个账号」，
    //    写在前面就会被它盖掉（本轮真浏览器验收抓到的，主人将看不到"建了什么档"）。
    await loadUsers();
    msg('uMsg', `已建号 ${r.user.username}：${describePlan(r.user)}`, 'ok');
    refreshOverview(true);
  } catch (err) {
    msg('uMsg', err.message, 'err');
  }
}

/* ── 记录 / 兑换码 / 设备 ──────────────────────────────────────────────── */

async function loadRecords() {
  const user = $('rUser').value.trim();
  const limit = Number($('rLimit').value) || 50;
  msg('rMsg', '读取中…');
  try {
    const res = await api(`/api/admin/records?limit=${limit}${user ? `&user=${encodeURIComponent(user)}` : ''}`);
    fillTable($('rList'), [{ label: 'id' }, { label: '用户' }, { label: '标题' }, { label: '模式' }, { label: '字数', num: true }, { label: '发布' }, { label: '到期' }, { label: '' }],
      res.items.map((r) => [
        { cls: 'mono', node: r.id },
        r.user,
        { cls: 'wrap', node: r.title || '（无标题）' },
        r.mode || '—',
        { cls: 'num', node: String(r.chars == null ? '—' : r.chars) },
        fmtTime(r.createdAt),
        fmtTime(r.expiresAt),
        { node: el('button', { class: 'btn ghost', text: '删除', onclick: async () => {
          if (!confirm(`删除记录 ${r.id}？`)) return;
          try {
            await api('/api/admin/records/delete', { method: 'POST', body: { id: r.id } });
            await loadRecords();
          } catch (err) { msg('rMsg', err.message, 'err'); }
        } }) },
      ]));
    msg('rMsg', `共 ${res.total} 条${user ? `（属于 ${user}）` : ''}，显示前 ${res.items.length} 条`);
  } catch (err) {
    msg('rMsg', err.message, 'err');
  }
}

async function loadCodes() {
  msg('cMsg', '读取中…');
  try {
    const res = await api('/api/admin/codes');
    fillTable($('cList'), [{ label: '兑换码' }, { label: '天数', num: true }, { label: '生成时间' }, { label: '谁用了' }, { label: '用掉时间' }, { label: '备注' }, { label: '' }],
      res.items.map((c) => [
        { cls: 'mono', node: c.code },
        { cls: 'num', node: String(c.days) },
        fmtTime(c.createdAt),
        c.usedBy ? c.usedBy : tag('还没人用', 'ok'),
        c.usedAt ? fmtTime(c.usedAt) : '—',
        c.note || '—',
        { node: c.usedBy
          ? tag('已使用')
          : el('button', { class: 'btn ghost', text: '删除', onclick: async () => {
            try {
              await api('/api/admin/codes/delete', { method: 'POST', body: { code: c.code } });
              await loadCodes();
            } catch (err) { msg('cMsg', err.message, 'err'); }
          } }) },
      ]));
    msg('cMsg', `共 ${res.items.length} 个，其中 ${res.unused} 个还没用`);
  } catch (err) {
    msg('cMsg', err.message, 'err');
  }
}

async function genCodes() {
  const count = Number($('cCount').value) || 1;
  const days = Number($('cDays').value) || 30;
  const note = $('cNote').value.trim();
  try {
    const r = await api('/api/admin/codes', { method: 'POST', body: { count, days, note } });
    // 回执里带**明文兑换码**，是主人唯一的复制入口 ⇒ 必须写在 loadCodes() 之后（否则被「共 N 个」盖掉）
    await loadCodes();
    msg('cMsg', `已生成 ${r.codes.length} 个 ${r.days} 天兑换码：${r.codes.join('  ')}`, 'ok');
    refreshOverview(true);
  } catch (err) {
    msg('cMsg', err.message, 'err');
  }
}

async function loadDevices() {
  msg('dMsg', '读取中…');
  try {
    const res = await api('/api/admin/devices');
    fillTable($('dList'), [{ label: '短码（给人看的）' }, { label: '状态' }, { label: '长码指纹' }, { label: '发起时间' }, { label: '过期时间' }, { label: '已绑定账号' }],
      res.items.map((d) => [
        { cls: 'mono', node: d.userCode },
        d.status === 'approved' ? tag('已批准，等插件取回', 'ok') : tag('等待批准', 'warn'),
        { cls: 'mono', node: d.hash },
        fmtTime(d.createdAt),
        fmtTime(d.expiresAt),
        d.username || '—',
      ]));
    msg('dMsg', `共 ${res.items.length} 条${res.items.length ? '' : '，现在没有人在绑插件'}`);
  } catch (err) {
    msg('dMsg', err.message, 'err');
  }
}

/* ── 导航与启动 ────────────────────────────────────────────────────────── */

const LOADERS = { overview: () => refreshOverview(true), users: loadUsers, records: loadRecords, codes: loadCodes, devices: loadDevices };

function show(next) {
  view = next;
  for (const s of document.querySelectorAll('section[data-aview]')) s.hidden = s.getAttribute('data-aview') !== next;
  for (const b of document.querySelectorAll('.admin-nav button')) b.setAttribute('aria-current', String(b.getAttribute('data-aview') === next));
  const loader = LOADERS[next];
  if (loader) loader();
}

function boot() {
  for (const b of document.querySelectorAll('.admin-nav button')) b.addEventListener('click', () => show(b.getAttribute('data-aview')));
  $('gateBtn').addEventListener('click', () => tryEnter($('gateToken').value.trim()));
  $('gateToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryEnter($('gateToken').value.trim()); });
  $('gateTabAccount').addEventListener('click', () => showPane('account'));
  $('gateTabToken').addEventListener('click', () => showPane('token'));
  $('gateLoginBtn').addEventListener('click', tryLogin);
  // 人机验证：点图或点按钮都换一张
  $('capNew_admin').addEventListener('click', loadCaptcha);
  $('capImg_admin').addEventListener('click', loadCaptcha);
  for (const id of ['gateUser', 'gatePass']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
  }
  $('logoutBtn').addEventListener('click', () => {
    const wasAccount = mode === 'account';
    lockGate(wasAccount ? '已退出登录' : '已退出，请输入口令');
  });
  $('ovRefresh').addEventListener('click', () => refreshOverview(false));
  $('uReload').addEventListener('click', loadUsers);
  $('uSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUsers(); });
  $('uSort').addEventListener('change', loadUsers);
  $('uCreateBtn').addEventListener('click', createUser);
  $('rReload').addEventListener('click', loadRecords);
  $('cGen').addEventListener('click', genCodes);
  $('dReload').addEventListener('click', loadDevices);

  // 进来先按优先级试：①存下来的后台口令（应急通道，能进就一定进）
  //                    ②浏览器里已有的登录 cookie（上次用账号登录过，不用重新打字）
  //                    ③都不行才显示闸门。
  const saved = sessionStorage.getItem(TOKEN_KEY);
  if (saved) { showPane('token'); tryEnter(saved); return; }
  showPane('account');
  // 先问清"这次要不要验证码"再决定画不画那张图（本机直连时服务端会免掉）
  probeCaptcha();
  trySession().then((ok) => { if (!ok) $('gate').hidden = false; });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
