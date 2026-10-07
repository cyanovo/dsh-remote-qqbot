/* DSH 通知插件 · 网页端（零依赖，无构建步骤）
   设计原则：所有失败都必须在界面上说出来，绝不静默 —— 这是本项目被静默失败坑过多次后定下的规矩。 */
'use strict';

const state = {
  meta: null,
  me: null,
  records: [],
  tokens: [],
  view: 'overview',
  busy: false,
  reader: null,
  pendingRecord: '',
  // 人机验证：{ login: {id, image}, reg: {id, image} }
  // 🔴 存着**图和 id**，不是只存 id：render() 每次都会重建表单元素，
  //    只存 id 的话重建出来的 <img> 是空白的，用户看到的是"图没了"。
  captcha: { login: null, reg: null },
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 5200 : 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res, data;
  try {
    res = await fetch(path, opt);
  } catch (err) {
    throw new Error('连不上服务器：' + err.message);
  }
  try {
    data = await res.json();
  } catch {
    throw new Error(`服务器返回了非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || data.ok === false) {
    const e = new Error(data.error || `请求失败（HTTP ${res.status}）`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

/* ── 时间 ──────────────────────────────────────────────────────────────── */
function ago(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  return Math.floor(d / 3600e3) + ' 小时前';
}
function clock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 只要日期（付费版到期时间用，格式 2026-11-02） */
function dateOnly(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function left(ts) {
  const m = Math.max(0, Math.round((ts - Date.now()) / 60e3));
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
}

/* ── 视图切换 ──────────────────────────────────────────────────────────── */
const TITLES = { overview: '首页', docs: '教程文档', records: '我的记录', account: '账号', about: '使用说明' };
function goto(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((s) => { s.hidden = s.dataset.view !== view; });
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('is-on', b.dataset.view === view));
  $('viewTitle').textContent = TITLES[view] || 'DSH 通知插件';
  closeDrawer();
  $('scroll').scrollTop = 0;
}
function openDrawer() { $('side').classList.add('is-open'); $('scrim').hidden = false; }
function closeDrawer() { $('side').classList.remove('is-open'); $('scrim').hidden = true; }

/* ── 渲染：额度 ────────────────────────────────────────────────────────── */
function quotaBlock() {
  const q = state.me && state.me.quota;
  if (!state.me) {
    return `<h2>今天的次数</h2>
      <div class="q-line"><div class="q-big">—<span>次</span></div></div>
      <p class="hint">登录后每天有 <b>${state.meta ? state.meta.freeDaily : 100}</b> 次免费完整查看。当前未登录。</p>
      <div class="row" style="margin-top:14px"><button class="btn primary" data-go="account">去登录</button></div>`;
  }
  if (q.upgraded) {
    // 🔴 付费版**不是不限次数**：承诺是「一天 1000 次、记录留 48 小时」。
    //    以前这里写的是「不限」，那是服务端把升级做成布尔且永不过期时的老口径。
    const limit = q.limit || 1000;
    const pct = Math.min(100, Math.round((q.used / limit) * 100));
    const cls = q.remaining === 0 ? ' full' : '';
    return `<h2>今天的次数</h2>
      <div class="q-line">
        <div class="q-big">${q.remaining}<span>/ ${limit} 次</span></div>
        <div class="hint">${clock(q.resetAt)} 重置</div>
      </div>
      <div class="q-track"><div class="q-fill${cls}" style="width:${pct}%"></div></div>
      <p class="hint">付费版：每天 <b>${limit}</b> 次，记录保留 <b>${esc(q.retentionText || '48 小时')}</b>。
        ${q.proUntil ? `有效期到 ${esc(dateOnly(q.proUntil))}。` : ''}</p>`;
  }
  const limit = q.limit || 100;
  const pct = Math.min(100, Math.round((q.used / limit) * 100));
  const cls = q.remaining === 0 ? ' full' : '';
  return `<h2>今天的次数</h2>
    <div class="q-line">
      <div class="q-big">${q.remaining}<span>/ ${limit} 次</span></div>
      <div class="hint">${clock(q.resetAt)} 重置</div>
    </div>
    <div class="q-track"><div class="q-fill${cls}" style="width:${pct}%"></div></div>
    <p class="hint">${q.remaining === 0
      ? '今天的次数用完了，北京时间 0 点自动重置。'
      : `已经看了 ${q.used} 次，还剩 ${q.remaining} 次。`}</p>`;
}

/* ── 渲染：三档模式 ────────────────────────────────────────────────────── */
function modesBlock() {
  const modes = (state.meta && state.meta.modes) || [];
  const cur = (state.me && state.me.mode) || null;
  const rows = modes.map((m) => `
    <div class="mode${cur === m.id ? ' is-on' : ''}" data-mode="${esc(m.id)}">
      <button class="mode-radio" aria-label="选择 ${esc(m.name)}"></button>
      <div class="mode-body">
        <strong>${esc(m.name)}</strong>
        <span>${esc(m.detail)}</span>
        <span class="mode-tag">${m.cost === 0 ? '不占次数' : '每次扣 1 次'}${m.link ? ' · 带链接' : ''}</span>
      </div>
    </div>`).join('');
  return `<h2>全文的发送方式</h2>
    <p class="hint" style="margin-bottom:14px">选择后，插件下一轮按这种方式发送回答。</p>
    ${rows}
    <p class="hint" style="margin-top:14px">${state.me
      ? '点击即可切换，立即保存。'
      : '登录后可以在这里切换，设置会同步给插件。'}</p>`;
}

/* ── 渲染：付费版 ──────────────────────────────────────────────────────── */
function payBlock() {
  const pro = (state.meta && state.meta.plans && state.meta.plans.pro) || {};
  const price = (state.meta && state.meta.priceCny) || '2.99';
  const free = (state.meta && state.meta.plans && state.meta.plans.free) || {};
  return `<div class="pay">
    <div class="pay-l">
      <h2>付费版</h2>
      <p><b>¥${esc(price)}</b> 开通 <b>${esc(String(pro.days || 30))} 天</b>：
        每天 <b>${esc(String(pro.daily || 1000))} 次</b>完整查看（免费版 ${esc(String(free.daily || 100))} 次），
        记录保留 <b>${esc(pro.retentionText || '48 小时')}</b>（免费版 ${esc(free.retentionText || '5 小时')}）。</p>
      <p class="hint">没有接在线支付。这笔钱用于分摊服务器成本。
        再次兑换时，天数在原到期时间上<b>累加</b>。</p>
    </div>
    <div class="pay-r" style="min-width:250px">
      <label class="f"><span>兑换码</span><input type="text" id="codeInput" placeholder="DSH-XXXX-XXXX" autocomplete="off"></label>
      <div class="row"><button class="btn primary" id="redeemBtn">兑换</button></div>
      <div class="msg" id="payMsg"></div>
      <p class="hint">兑换码由作者手工发放，兑换后立即生效。</p>
    </div>
  </div>`;
}

/* ── 渲染：记录 ────────────────────────────────────────────────────────── */
function recordsBlock() {
  if (!state.me) {
    return `<h2>我的记录</h2><div class="empty">登录后才能看到自己的记录</div>
      <div class="row" style="justify-content:center"><button class="btn primary" data-go="account">去登录</button></div>`;
  }
  // 保留期按当前账号的档位显示（免费版 5 小时 / 付费版 48 小时）。
  // 以前这里写死「5 小时」，付费版登录进来看见的也是 5 小时 —— 与额度卡自相矛盾。
  const ret = (state.me && state.me.quota && state.me.quota.retentionText) || '';
  if (!state.records.length) {
    return `<h2>我的记录</h2><div class="empty">${ret ? `最近 ${esc(ret)} 还没有记录。` : '还没有记录。'}<br>插件用「存服务器」方式推送一次回答，这里就有记录。</div>`;
  }
  const rows = state.records.map((r) => `
    <div class="rec">
      <div class="rec-main">
        <strong title="${esc(r.title)}">${esc(r.title)}</strong>
        <span>${esc(clock(r.createdAt))} · ${esc(ago(r.createdAt))} · ${esc(r.chars)} 字 · 还能留 ${esc(left(r.expiresAt))}</span>
      </div>
      <button class="btn" data-open="${esc(r.id)}">查看全文</button>
    </div>`).join('');
  return `<h2>我的记录${ret ? `<span class="hint" style="font-weight:400"> · 保留 ${esc(ret)}，过期自动删除</span>` : ''}</h2>${rows}`;
}

/* ── 渲染：账号 ────────────────────────────────────────────────────────── */
/** 令牌列表：只显示前缀（明文只在创建那一次出现，服务端也只有 sha256）。 */
function tokensBlock() {
  const items = state.tokens || [];
  const rows = items.length
    ? items.map((t) => `<div class="rec">
        <div>
          <b>${esc(t.prefix)}…</b>
          <div class="hint">${esc(t.label || '未命名')} · 建于 ${esc(clock(t.createdAt))} · ${t.lastUsedAt ? `最近使用 ${esc(ago(t.lastUsedAt))}` : '还没用过'}</div>
        </div>
        <button class="btn" data-revoke="${esc(t.id)}">吊销</button>
      </div>`).join('')
    : '<p class="hint">还没有令牌。DSH 插件用设备码绑定时会自动建一把。</p>';
  return `<h2>我的令牌<span class="hint" style="font-weight:400"> · 给 DSH 插件上传用</span></h2>
    <p class="hint">令牌只保存 sha256，服务端看不到明文；丢了就吊销重发。它可以发布记录、读取配额，<b>读不到</b>记录正文。</p>
    ${rows}
    <div class="row" style="margin-top:12px">
      <button class="btn" id="newTokenBtn">新建一把（手动填插件用）</button>
    </div>
    <div id="newTokenBox"></div>
    <div class="msg" id="tokenMsg"></div>`;
}

function accountBlock() {
  if (state.me) {
    const q = state.me.quota;
    return `<h2>已登录</h2>
      <p>用户名：<b>${esc(state.me.username)}</b></p>
      <p>方案：<b>${q.upgraded ? `付费版（每天 ${q.limit} 次 · 记录留 ${esc(q.retentionText || '48 小时')}）` : `免费版（每天 ${q.limit} 次 · 记录留 ${esc(q.retentionText || '5 小时')}）`}</b></p>
      <p>今天已用：<b>${q.used}</b> 次，还剩 <b>${q.remaining}</b> 次${q.proUntil ? `　·　付费版有效期到 ${esc(dateOnly(q.proUntil))}` : ''}</p>
      <p class="hint">注册于 ${esc(clock(state.me.createdAt))}</p>
      <div class="row" style="margin-top:16px">
        <button class="btn" id="logoutBtn">退出登录</button>
      </div>
      <div class="msg" id="acctMsg"></div>
      <hr style="border:0;border-top:1px solid var(--line-2);margin:24px 0">
      <h2>绑定 DSH 插件<span class="hint" style="font-weight:400"> · 设备码</span></h2>
      <p class="hint">在 DSH 里调用一次 <code>cloud_bind</code>，会得到一组 8 位码。在这里确认后，回到 DSH 再调用一次 <code>cloud_bind</code> 即可完成绑定。</p>
      <label class="f"><span>设备码</span><input type="text" id="deviceCode" placeholder="ABCD-EFGH" autocomplete="off" spellcheck="false"></label>
      <div class="row"><button class="btn primary" id="bindDeviceBtn">确认绑定</button></div>
      <div class="msg" id="bindMsg"></div>
      <hr style="border:0;border-top:1px solid var(--line-2);margin:24px 0">
      ${tokensBlock()}`;
  }
  // ⚠️ 这两个块是**字面写死的 id**（不是拼出来的）：verify-dom-ids.mjs 靠字面 id 判断
  //    "脚本要用的元素有没有人提供"，拼出来的 id 它看不见 —— 而看不见就等于没验。
  // 要不要显示，看服务端 /api/meta 怎么说的（本机直连/带后台口令时是 false）。
  const capLogin = captchaNeeded() ? `
    <div class="cap">
      <img class="cap-img" id="capImg_login" alt="人机验证图片" width="132" height="44">
      <input type="text" id="capText_login" autocomplete="off" spellcheck="false" inputmode="latin"
             maxlength="8" placeholder="图里的 4 位" aria-label="人机验证">
      <button type="button" class="btn" id="capNew_login">换一张</button>
    </div>` : '';
  const capReg = captchaNeeded() ? `
    <div class="cap">
      <img class="cap-img" id="capImg_reg" alt="人机验证图片" width="132" height="44">
      <input type="text" id="capText_reg" autocomplete="off" spellcheck="false" inputmode="latin"
             maxlength="8" placeholder="图里的 4 位" aria-label="人机验证">
      <button type="button" class="btn" id="capNew_reg">换一张</button>
    </div>` : '';
  return `<h2>登录</h2>
    <label class="f"><span>用户名</span><input type="text" id="loginName" autocomplete="username" placeholder="2–24 位，中文/字母/数字"></label>
    <label class="f"><span>密码</span><input type="password" id="loginPass" autocomplete="current-password"></label>
    ${capLogin}
    <div class="row"><button class="btn primary" id="loginBtn">登录</button></div>
    <div class="msg" id="loginMsg"></div>
    <hr style="border:0;border-top:1px solid var(--line-2);margin:24px 0">
    <h2>还没有账号</h2>
    <p class="hint">注册只需用户名和密码，注册后每天有 100 次免费完整查看。</p>
    <label class="f"><span>用户名</span><input type="text" id="regName" autocomplete="username"></label>
    <label class="f"><span>密码（至少 6 位）</span><input type="password" id="regPass" autocomplete="new-password"></label>
    ${capReg}
    <div class="row"><button class="btn" id="regBtn">注册并登录</button></div>
    <div class="msg" id="regMsg"></div>`;
}

/* ── 人机验证（登录 / 注册的图形码）────────────────────────────────────────
   图片是服务端现画的 SVG，走 /api/captcha 拿 data URL —— 这里只负责「取一张、显示、连同输入一起提交」。
   ⚠️ 不能在 render() 里无条件重取：那张图就是用户正在看的题目，重取等于把题换掉、还让他白填一次。
   ⚠️ 表单里那两个块是**字面写死的 id**（不是拼出来的）：verify-dom-ids.mjs 靠字面 id 判断
      "脚本要用的元素有没有人提供"，拼出来的 id 它看不见 —— 而看不见就等于没验。 */
/** 把已有的图贴回新元素上；没有就取一张。 */
function paintCaptcha(which) {
  const img = $('capImg_' + which);
  if (!img) return;
  const c = state.captcha[which];
  if (c && c.image) img.src = c.image;
  else loadCaptcha(which);
}
/** 这次要不要验证码 —— **由服务端说了算**（/api/meta 的 captcha.required）。
 *  本机直连（回环）与带后台口令的请求服务端会免掉，前端也就不该拿一张必被忽略的图去烦人；
 *  拿不到 meta 时按"要"处理：宁可多要一张，不可放过。 */
function captchaNeeded() {
  return !(state.meta && state.meta.captcha && state.meta.captcha.required === false);
}
async function loadCaptcha(which) {
  const img = $('capImg_' + which);
  state.captcha[which] = null;
  if (img) { img.classList.add('is-loading'); img.removeAttribute('src'); }
  try {
    const r = await api('/api/captcha');
    state.captcha[which] = { id: r.id, image: r.image };
    const el = $('capImg_' + which);   // 重新取一次：await 期间表单可能已被 render() 重建
    if (el) { el.src = r.image; el.classList.remove('is-loading'); }
    const box = $('capText_' + which);
    if (box) box.value = '';
  } catch (e) {
    const el = $('capImg_' + which);
    if (el) el.classList.remove('is-loading');
    // 取不到图就说清楚，别让人对着一张空白图反复点登录 —— 本项目不许静默失败。
    toast('验证码没加载出来：' + e.message + '（点「换一张」重试）', 'err');
  }
}

/* ── 渲染入口 ──────────────────────────────────────────────────────────── */
function render() {
  $('quotaMini').innerHTML = !state.meta ? '正在连接…'
    : state.me
      ? `${esc(state.me.username)}<br>${state.me.quota.upgraded ? `付费版 · 今天还剩 ${state.me.quota.remaining} 次` : `今天还剩 ${state.me.quota.remaining} 次`}`
      : '未登录<br>登录后每天 100 次免费';
  $('topRight').innerHTML = state.me
    ? `<span class="hint">${esc(state.me.username)}</span>`
    // 尺寸交给 CSS（.btn 恒为 44px 高）。旧版在这里内联 min-height:36px，
    // 实测页头这个「登录」按钮就是 59×36 —— 整站唯一一个不达 44px 触摸线的主按钮。
    : `<button class="btn" data-go="account">登录</button>`;
  $('recCount').textContent = state.me ? (state.records.length || '') : '';

  $('quotaCard').innerHTML = quotaBlock();
  $('modesCard').innerHTML = modesBlock();
  $('payCard').innerHTML = payBlock();
  $('recordsCard').innerHTML = recordsBlock();
  $('accountCard').innerHTML = accountBlock();
  $('aboutModes').innerHTML = ((state.meta && state.meta.modes) || [])
    .map((m) => `<li><b>${esc(m.name)}</b>：${esc(m.detail)}</li>`).join('');
  bindDynamic();
  // 没登录时表单里就有验证码：元素是刚重建的，把上一张图贴回去；没有才去取。
  if (!state.me) { paintCaptcha('login'); paintCaptcha('reg'); }
}

function bindDynamic() {
  document.querySelectorAll('[data-go]').forEach((el) => {
    el.onclick = () => goto(el.dataset.go);
  });
  document.querySelectorAll('.mode').forEach((el) => {
    el.onclick = () => pickMode(el.dataset.mode);
  });
  document.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => openRecord(el.dataset.open);
  });
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  const msg = (id, text, kind) => {
    const el = $(id);
    if (el) { el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }
  };

  // 人机验证：点图或点按钮都换一张
  on('capNew_login', () => loadCaptcha('login'));
  on('capImg_login', () => loadCaptcha('login'));
  on('capNew_reg', () => loadCaptcha('reg'));
  on('capImg_reg', () => loadCaptcha('reg'));

  on('loginBtn', async () => {
    // 服务端说不用（本机直连/带后台口令）时就别拦人；说要，就必须图、id、答案三样齐全
    const need = captchaNeeded();
    const cap = need ? state.captcha.login : null;
    if (need && (!cap || !cap.id)) { msg('loginMsg', '验证码还没加载出来，点「换一张」重试', 'err'); loadCaptcha('login'); return; }
    const capText = need ? $('capText_login').value.trim() : '';
    // 空着就别白跑一趟服务端（服务端那边也会拒，但那是一次没必要的往返）
    if (need && !capText) { msg('loginMsg', '请填写图中的 4 位验证码', 'err'); return; }
    msg('loginMsg', '正在登录…');
    try {
      const r = await api('/api/login', {
        method: 'POST',
        body: {
          username: $('loginName').value.trim(),
          password: $('loginPass').value,
          ...(need ? { captchaId: cap.id, captchaText: capText } : {}),
        },
      });
      state.me = r.me; toast('登录成功'); await refresh(); await afterAuth();
    } catch (e) {
      msg('loginMsg', e.message, 'err');
      // 失败就换一张：这张要么已被这次提交用掉，要么已作废 —— 留着它只会让人反复撞一张废图
      if (need) loadCaptcha('login');
    }
  });
  on('regBtn', async () => {
    const need = captchaNeeded();
    const cap = need ? state.captcha.reg : null;
    if (need && (!cap || !cap.id)) { msg('regMsg', '验证码还没加载出来，点「换一张」重试', 'err'); loadCaptcha('reg'); return; }
    const capText = need ? $('capText_reg').value.trim() : '';
    if (need && !capText) { msg('regMsg', '请填写图中的 4 位验证码', 'err'); return; }
    msg('regMsg', '正在注册…');
    try {
      const r = await api('/api/register', {
        method: 'POST',
        body: {
          username: $('regName').value.trim(),
          password: $('regPass').value,
          ...(need ? { captchaId: cap.id, captchaText: capText } : {}),
        },
      });
      state.me = r.me; toast('注册成功，已登录'); await refresh(); await afterAuth();
    } catch (e) {
      msg('regMsg', e.message, 'err');
      if (need) loadCaptcha('reg');
    }
  });
  on('logoutBtn', async () => {
    try { await api('/api/logout', { method: 'POST' }); state.me = null; state.records = []; state.tokens = []; toast('已退出'); render(); }
    catch (e) { msg('acctMsg', e.message, 'err'); }
  });

  // ── 设备码确认（DSH 插件 cloud_bind 的第一步就在这里完成）──────────────
  on('bindDeviceBtn', async () => {
    const code = ($('deviceCode').value || '').trim();
    if (!code) { msg('bindMsg', '先把 DSH 里给你的那组 8 位码填上', 'err'); return; }
    msg('bindMsg', '正在确认…');
    try {
      const r = await api('/api/device/approve', { method: 'POST', body: { userCode: code } });
      // 说清"还没完"：确认只是批准，令牌要 DSH 那边再 poll 一次才拿到 ——
      // 只回一句"成功"会让人以为已经绑好了，然后对着没反应的插件发呆。
      msg('bindMsg', `已确认这组码（${r.userCode}）。回到 DSH 再调用一次 cloud_bind 即可完成绑定。`, 'ok');
      toast('设备码已确认，回 DSH 再调一次 cloud_bind');
    } catch (e) {
      msg('bindMsg', e.message, 'err');
    }
  });

  // ── 我的令牌 ────────────────────────────────────────────────────────────
  on('newTokenBtn', async () => {
    msg('tokenMsg', '正在创建…');
    try {
      const r = await api('/api/tokens', { method: 'POST', body: { label: 'manual' } });
      state.tokens = (await api('/api/tokens')).items || [];
      // ⚠️ 顺序要紧：render() 会重建整块 accountCard（`#newTokenBox` 跟着被清空），
      //    所以必须**先 render 再放明文框**。反过来写就是"新建成功但看不到令牌"。
      render();
      $('newTokenBox').innerHTML = `<label class="f"><span>新令牌（只显示这一次）</span>
        <input type="text" id="newTokenValue" readonly value="${esc(r.token)}"></label>
        <p class="hint">这串只显示一次，服务端只存了 sha256。把它填进 DSH 插件配置的「云端账号令牌」，或者干脆用设备码绑定。</p>`;
      const box = $('newTokenValue');
      if (box && box.select) { box.focus(); box.select(); }
      toast('令牌已创建，只显示这一次');
    } catch (e) { msg('tokenMsg', e.message, 'err'); }
  });
  // 吊销按钮用**事件委托**：列表每次 render() 都会重建，逐元素绑要在每次渲染后重来，
  // 而委托只绑一次，且"点了哪一行"由 data-revoke 决定。（也让无头桩能真的点一下。）
  const card = $('accountCard');
  if (card) {
    card.onclick = (ev) => {
      const btn = ev && ev.target && typeof ev.target.closest === 'function'
        ? ev.target.closest('[data-revoke]') : null;
      if (btn) revokeToken(btn.dataset.revoke);
    };
  }
  on('redeemBtn', async () => {
    if (!state.me) { toast('先登录再兑换', 'err'); goto('account'); return; }
    msg('payMsg', '正在兑换…');
    try {
      const r = await api('/api/redeem', { method: 'POST', body: { code: $('codeInput').value } });
      state.me = r.me;
      // 把"到底加到了什么时候"说清楚：叠加时只回一句「成功」会让人以为从今天重新算
      const until = r.me && r.me.proUntil ? dateOnly(r.me.proUntil) : '';
      toast(r.stacked
        ? `兑换成功，有效期在原到期时间上加了 ${r.days} 天，到 ${until}`
        : `兑换成功：付费版 ${r.days} 天，有效期到 ${until}`);
      render();
    } catch (e) { msg('payMsg', e.message, 'err'); }
  });
}

/** 吊销一把发布令牌（插件里那把会**立刻**失效 —— 所以按钮要说明这件事）。 */
async function revokeToken(id) {
  if (!id) return;
  try {
    const r = await api('/api/tokens/revoke', { method: 'POST', body: { id } });
    toast(`已吊销 ${r.revoked}…（插件里那把立刻失效）`);
    state.tokens = (await api('/api/tokens')).items || [];
    render();
  } catch (e) {
    const el = $('tokenMsg');
    if (el) { el.textContent = e.message; el.className = 'msg err'; }
  }
}

async function pickMode(mode) {  if (!state.me) { toast('先登录才能记住你的选择', 'err'); goto('account'); return; }
  if (state.busy) return;
  state.busy = true;
  try {
    const r = await api('/api/prefs', { method: 'POST', body: { mode } });
    state.me = r.me;
    render();
    toast('已切换为：' + ((state.meta.modes.find((m) => m.id === mode) || {}).name || mode));
  } catch (e) {
    toast('切换失败：' + e.message, 'err');   // 失败绝不静默
  } finally { state.busy = false; }
}

/* ── 「完整回答」的 Markdown 渲染（零依赖） ────────────────────────────── */
/* 阅读器原来把正文直接塞进 textContent，于是 QQ 里点开看到的是字面量 `##`、`|---|`、围栏。
   这里自己渲染。三条不可动摇的规矩：
   ① 先 esc() 再解析 —— 正文永远当数据、绝不当结构（这是唯一的 XSS 防线）；
   ② 只返回 HTML 字符串（验收用的无头 DOM 桩只有 innerHTML/textContent，没有 createElement/DocumentFragment）；
   ③ 认不出来的语法原样保留，宁可少渲染，也不吞字符。
   刻意不支持：缩进式代码块、图片、HTML 透传、脚注。 */
const MD_HEAD = /^(#{1,6})\s+(.*)$/;
const MD_FENCE = /^\s*(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/;
const MD_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const MD_QUOTE = /^\s*&gt;\s?(.*)$/;   /* 正文已 esc()，行首的 > 在这里就是 &gt; */
const MD_LIST = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/** 表格行拆格（去掉首尾竖线）；`|` 不在 esc 的转义表里，所以原样可拆 */
function mdSplitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}
/** 表格的分隔行：每个格子都长成 `---` / `:--:` 这种 */
function mdIsTableSep(line) {
  if (!line.includes('|') || !line.includes('-')) return false;
  const cells = mdSplitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** 行内语法：先摘出代码段（里面不许再解析），再链接、粗体、删除线、斜体 */
function mdInline(s) {
  const codes = [];
  let out = String(s).replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push(c);
    return '\u0001' + (codes.length - 1) + '\u0001';
  });
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (m, label, href) => {
    const bare = href.replace(/&amp;/g, '&');
    if (!/^(?:https?:\/\/|\/)/i.test(bare)) return m;   /* 只放行 http(s) 与站内相对路径 */
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out.replace(/\u0001(\d+)\u0001/g, (m, n) => '<code>' + codes[+n] + '</code>');
}

/** 列表：缩进多出 2 格的算子列表（嵌在父项 <li> 里） */
function mdList(items) {
  const base = items[0].indent;
  const top = [];
  for (const it of items) {
    if (!top.length || it.indent <= base + 1) top.push({ text: it.text, sub: [] });
    else top[top.length - 1].sub.push(it);
  }
  const tag = items[0].ordered ? 'ol' : 'ul';
  return '<' + tag + '>' + top.map((it) =>
    '<li>' + mdInline(it.text) + (it.sub.length ? mdList(it.sub) : '') + '</li>').join('') + '</' + tag + '>';
}

function mdTable(head, rows, aligns) {
  const cell = (tag, text, i) =>
    '<' + tag + (aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '') + '>' + mdInline(text) + '</' + tag + '>';
  const body = rows.map((r) =>
    '<tr>' + head.map((_, i) => cell('td', r[i] == null ? '' : r[i], i)).join('') + '</tr>').join('');
  return '<div class="md-table"><table><thead><tr>'
    + head.map((c, i) => cell('th', c, i)).join('')
    + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

/** 整篇渲染。正文已被 esc()，所以这里拿到的每个字符都已经是安全的 */
function renderMarkdown(text) {
  const lines = esc(String(text == null ? '' : text).replace(/\r\n?/g, '\n')).split('\n');
  const out = [];
  let para = [];
  let i = 0;
  const flushPara = () => {
    if (!para.length) return;
    out.push('<p>' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { flushPara(); i += 1; continue; }

    const fence = line.match(MD_FENCE);
    if (fence) {
      flushPara();
      const closer = new RegExp('^\\s*' + fence[1].charAt(0) + '{3,}\\s*$');
      const body = [];
      i += 1;
      while (i < lines.length && !closer.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;   /* 跳掉收尾围栏；没写收尾时也只是走到末尾，不会死循环 */
      out.push('<pre class="md-pre"' + (fence[2] ? ' data-lang="' + fence[2] + '"' : '')
        + '><code>' + body.join('\n') + '</code></pre>');
      continue;
    }

    if (MD_HR.test(line)) { flushPara(); out.push('<hr>'); i += 1; continue; }

    const head = line.match(MD_HEAD);
    if (head) {
      flushPara();
      /* 阅读器里不产出 h1：全站唯一的 h1 是落地页的品牌标题，验收脚本钉着它 */
      const tag = 'h' + Math.min(Math.min(head[1].length, 4) + 1, 4);
      out.push('<' + tag + '>' + mdInline(head[2].replace(/\s*#+\s*$/, '').trim()) + '</' + tag + '>');
      i += 1; continue;
    }

    if (MD_QUOTE.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length) {
        const m = lines[i].match(MD_QUOTE);
        if (!m) break;
        buf.push(m[1]); i += 1;
      }
      out.push('<blockquote>' + buf.map((t) => (t.trim() ? '<p>' + mdInline(t) + '</p>' : '')).join('') + '</blockquote>');
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && mdIsTableSep(lines[i + 1])) {
      flushPara();
      const cols = mdSplitRow(line);
      const aligns = mdSplitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'center' : (r ? 'right' : (l ? 'left' : ''));
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(mdSplitRow(lines[i])); i += 1; }
      out.push(mdTable(cols, rows, aligns));
      continue;
    }

    if (MD_LIST.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(MD_LIST);
        if (!m) break;
        items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: !!m[3], text: m[4] });
        i += 1;
      }
      out.push(mdList(items));
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushPara();
  return out.join('\n');
}

/* ── 全文字阅读器 ──────────────────────────────────────────────────────── */
/** 从 `/n/<id>` 里取出记录 id（QQ 里那个可点链接就是这个形状） */
function deepLinkId() {
  const m = location.pathname.match(/^\/n\/([a-z0-9]{4,32})\/?$/i);
  return m ? m[1] : '';
}

async function openRecord(id) {
  if (state.busy) return;
  state.busy = true;
  try {
    const r = await api(`/api/records/${encodeURIComponent(id)}/view`, { method: 'POST' });
    state.reader = r.record;
    $('readerTitle').textContent = r.record.title;
    $('readerMeta').innerHTML = `<span class="hint">${esc(clock(r.record.createdAt))} · ${esc(r.record.chars)} 字 · 保留 ${esc(r.record.retentionText || '')}</span>`;
    /* 这里是唯一一处把记录正文交给界面的地方：渲染成 HTML，而不是把 Markdown 记号原样显示 */
    $('readerBody').innerHTML = renderMarkdown(r.record.text);
    $('reader').hidden = false;
    document.body.style.overflow = 'hidden';
    state.me = { ...state.me, quota: r.quota };
    render();
  } catch (e) {
    if (e.status === 429) {
      const q = (e.data && e.data.quota) || {};
      toast(`今天的 ${q.limit || ''} 次用完了。北京时间 0 点重置，也可以用兑换码转为付费版（每天 1000 次）。`, 'err');
    } else if (e.status === 401) {
      toast('这条记录需要登录后查看。登录后会回到这个链接。', 'err');
    } else if (e.status === 404) {
      toast('这条记录不存在。免费版保留 5 小时，付费版保留 48 小时。', 'err');
    } else {
      toast('打不开：' + e.message, 'err');
    }
  } finally { state.busy = false; }
}
function closeReader() {
  $('reader').hidden = true;
  document.body.style.overflow = '';
  state.reader = null;
}

/* ── 启动 ──────────────────────────────────────────────────────────────── */
/** 登录/注册成功之后：如果是从 `/n/<id>` 过来的，接着把那条记录打开 */
async function afterAuth() {
  if (!state.pendingRecord) return;
  const id = state.pendingRecord;
  state.pendingRecord = '';
  goto('records');
  await openRecord(id);
}
async function refresh() {
  const me = await api('/api/me');
  state.me = me.me;
  if (state.me) {
    const rec = await api('/api/records?limit=100');
    // `|| []`：响应形状不对时不能把 records 弄成 undefined ——
    // 否则 render() 会二次崩，于是"错误提示"自己先白屏（无头桩验收就是这么抓到的）。
    state.records = rec.items || [];
    // 令牌列表：拉不到也不能让整页崩（它是附加信息，不是主内容）
    try {
      const tk = await api('/api/tokens');
      state.tokens = tk.items || [];
    } catch { state.tokens = []; }
  } else {
    state.records = [];
    state.tokens = [];
  }
  render();
}

async function boot() {
  $('hamb').onclick = () => ($('side').classList.contains('is-open') ? closeDrawer() : openDrawer());
  $('scrim').onclick = closeDrawer;
  $('readerClose').onclick = closeReader;
  document.querySelectorAll('.nav-item').forEach((b) => { b.onclick = () => goto(b.dataset.view); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeReader(); closeDrawer(); } });
  window.addEventListener('resize', () => { if (innerWidth > 860) closeDrawer(); });

  try {
    state.meta = await api('/api/meta');
    await refresh();
    // 深链：QQ 里点「查看完整回答」过来的就是 /n/<id>
    // 没登录时把人送到登录页，并**记住这个 id**，登录后自动接着打开 —— 不需要再点一次链接。
    const deep = deepLinkId();
    if (deep) {
      state.pendingRecord = deep;
      if (!state.me) {
        goto('account');
        toast('登录后就会自动打开这条记录', 'err');
      } else {
        goto('records');
        await openRecord(deep);
        state.pendingRecord = '';
      }
      return;
    }
    // 深链 #docs / #docs/<章节>：教程文档页（内容由 /docs.js 渲染，这里只负责切视图）。
    // 注意这行必须等 await 之后跑 —— 它是「谁最终决定显示哪一栏」的最后一句话。
    const h = location.hash || '';
    if (h.indexOf('#docs') === 0) goto('docs');
    else goto(h === '#records' ? 'records' : 'overview');
  } catch (e) {
    // 出错也要能把话说出来：render() 依赖的字段先补齐，否则"报错"这步自己会崩
    state.records = state.records || [];
    state.meta = state.meta || { modes: [], plans: {}, priceCny: '2.99', freeDaily: 100 };
    render();
    toast('加载失败：' + e.message, 'err');
  }
}
boot();
