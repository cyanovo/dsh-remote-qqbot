/* DSH 通知插件 · 网页端 —— 教程文档的「插图库」（零依赖、经典脚本）
   ─────────────────────────────────────────────────────────────────────────────
   为什么单独一个文件：教程页要有大量插图，插图占掉大半体积。
   把「图」与「文」分开，改文案时不用碰图，改图时不用碰文案。

   三类图：
     ① 内联 SVG 示意图（架构 / 安装流程 / 绑定时序 / 三档去向 / 三道闸 / 额度梯度）
        —— 用 CSS 变量上色，所以**跟随浅色/深色主题自动变色**，
           不引任何图片文件、不引 CDN、不引外链字体（整站零外链是硬约束）。
     ② 真截图（/docs-img/*.png）—— 由 docs.js 用 <img> 引用，是真正跑出来的页面。
     ③ DOM 模拟图（QQ 聊天气泡 / DSH 输入框开关 / QQ 菜单）—— 用真实 HTML+CSS 画出来，
        文字清晰、可选中、放大不糊，比截图更能说明「长什么样、点哪里」。
        它不是截图，每张的图注里都写明「示意图」。

   ⚠️ 模型读不了图，所以这些图「对不对」只能靠：几何（viewBox / 元素数）、
      真截图非空白（字节数 + 像素统计）、DOM 模拟图的可读文字。见 verify-docs.mjs。
   ───────────────────────────────────────────────────────────────────────────── */
'use strict';

/** 箭头标记只定义一次（docs.js 把它渲染在教程页顶部，所有图共用这两个 id） */
const DEFS = '<svg class="doc-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>'
  + '<marker id="df-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"'
  + ' orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--muted)"/></marker>'
  + '<marker id="df-arrow-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"'
  + ' orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--brand-ink)"/></marker>'
  + '</defs></svg>';

/** SVG 外壳（统一 viewBox / 角色 / 无障碍标题） */
function svg(box, label, inner) {
  return '<svg viewBox="' + box + '" role="img" aria-label="' + label + '">' + inner + '</svg>';
}
/** 一个方块：x/y/w/h + 主文字 +（可选）副文字 +（可选）样式类 */
function box(x, y, w, h, title, sub, cls) {
  const cx = x + w / 2;
  return '<rect class="' + (cls || 'df-box') + '" x="' + x + '" y="' + y + '" width="' + w
    + '" height="' + h + '" rx="10"/>'
    + '<text class="df-t" x="' + cx + '" y="' + (sub ? y + h / 2 - 5 : y + h / 2 + 4)
    + '" text-anchor="middle">' + title + '</text>'
    + (sub ? '<text class="df-s" x="' + cx + '" y="' + (y + h / 2 + 14) + '" text-anchor="middle">' + sub + '</text>' : '');
}
/** 一条（可带说明文字的）箭头 */
function line(x1, y1, x2, y2, label, accent, labelDy) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 + (labelDy == null ? -7 : labelDy);
  return '<line class="' + (accent ? 'df-la' : 'df-l') + '" x1="' + x1 + '" y1="' + y1
    + '" x2="' + x2 + '" y2="' + y2 + '" marker-end="url(#' + (accent ? 'df-arrow-a' : 'df-arrow') + ')"/>'
    + (label ? '<text class="df-s" x="' + mx + '" y="' + my + '" text-anchor="middle">' + label + '</text>' : '');
}
/** 统一包成 figure */
function figure(body, caption) {
  return '<figure class="doc-fig">' + body + '<figcaption>' + caption + '</figcaption></figure>';
}

const FIG = {};
FIG.defs = DEFS;

/* ── ① 整体架构 ─────────────────────────────────────────────────────────── */
FIG.arch = figure(svg('0 0 640 236', '整体架构：DSH 本机插件 → 云端服务器 → 手机 QQ',
  box(16, 66, 176, 104, '你的电脑 · DSH', 'dsh-remote-qqbot 插件')
  + box(232, 42, 176, 152, '这台服务器', '通知中枢 + 网页端 cyanovo.top')
  + box(448, 66, 176, 104, '手机 · QQ', '通知 / 截图 / 提问')
  + line(194, 118, 228, 118, '推送事件', true)
  + line(410, 118, 444, 118, '主动消息', true)
  + '<path class="df-l" d="M 500 172 C 470 214, 380 224, 322 200" fill="none" stroke-dasharray="5 4"'
  + ' marker-end="url(#df-arrow)"/>'
  + '<text class="df-s" x="412" y="226" text-anchor="middle">点「查看完整回答」即打开网页端</text>'),
  '插件负责推送，服务器负责存储，手机负责查看。完整回答默认直接发到 QQ，不上传；'
  + '也可以存在这台服务器上，之后点开查看。');

/* ── ② 安装四步 ─────────────────────────────────────────────────────────── */
/* 2026-10-05 改：① 不再是「打包」—— 仓库里带了构建好的 lib/，也可以让 DSH 自己装，
   所以第 ① 格改成「装插件 / GitHub 一条命令」，并补一行说明"让 DSH 自己装"的办法。 */
FIG.install = figure(svg('0 0 640 170', '安装插件的四步',
  box(8, 34, 140, 84, '① 装插件', 'GitHub 一条命令')
  + box(166, 34, 140, 84, '② 装进 profile', 'dsh plugin … add')
  + box(324, 34, 140, 84, '③ 填 QQ 凭证', '设置 → QQ 提醒', 'df-box2')
  + box(482, 34, 150, 84, '④ 重启 DSH', '不重启不生效', 'df-box2')
  + line(150, 76, 164, 76, '')
  + line(308, 76, 322, 76, '')
  + line(466, 76, 480, 76, '')
  + '<text class="df-s" x="320" y="136" text-anchor="middle">第 ① 步也可以把教程里那段文字发给 DSH，让它自己装</text>'
  + '<text class="df-s" x="320" y="154" text-anchor="middle">第 ③ 步可以跳过：不填凭证时只使用网页端，QQ 相关功能不启用</text>'),
  '四步中唯一<b>不能省略</b>的是第 ④ 步。DSH 是长驻进程，安装后不重启，内存里运行的仍是旧代码。');
  

/* ── ③ 设备码绑定 ───────────────────────────────────────────────────────── */
FIG.bind = figure(svg('0 0 640 268', '设备码绑定：DSH 与浏览器来回一次',
  box(28, 16, 244, 52, '① 在 DSH 里调用 cloud_bind', '返回一组 8 位码，例如 7QK4-M2PD')
  + box(28, 100, 244, 52, '③ 再调用一次 cloud_bind', '这次换取令牌，绑定后记录挂在你的账号下')
  + box(368, 100, 244, 52, '② 网页端「账号」页输入这组码', '确认之后令牌才允许被取走', 'df-box2')
  + line(150, 68, 150, 98, '', true)
  + line(274, 126, 364, 126, '同一个 8 位码', true)
  + line(150, 154, 150, 186, '', true)
  + box(28, 186, 244, 66, '④ 记录挂在你的账号下', '按账号计数，按档位决定保留期', 'df-accent')
  + '<text class="df-s" x="320" y="253" text-anchor="middle">令牌只在浏览器确认之后才签发；明文只出现一次，服务端只保存 sha256</text>'),
  '需要调用两次 <code>cloud_bind</code>：第一次<b>申请</b>一组码，第二次<b>换取令牌</b>。'
  + '中间必须在浏览器里确认，只有一组码换不到任何权限。');

/* ── ④ 三档去向 ─────────────────────────────────────────────────────────── */
FIG.modes = figure(svg('0 0 640 312', '完整回答的三种去向',
  '<text class="df-s" x="16" y="20">三种方式在 DSH 设置里选择，默认第 1 档</text>'
  + box(16, 40, 120, 60, '本轮正文', '', 'df-box2')
  + line(138, 70, 196, 70, '', true)
  + box(200, 40, 200, 60, '直接发到 QQ', '切成几条消息，纯文本', 'df-accent')
  + '<text class="df-s" x="420" y="66">不上传 · 不占次数</text>'
  + box(16, 130, 120, 60, '本轮正文', '', 'df-box2')
  + line(138, 160, 196, 160, '', true)
  + box(200, 130, 200, 60, '存服务器', '记录挂你名下', 'df-box2')
  + '<path class="df-l" d="M 404 160 L 452 160" marker-end="url(#df-arrow)"/>'
  + '<text class="df-s" x="468" y="156">QQ 只给一句摘要</text>'
  + '<text class="df-s" x="468" y="174">在网页端查看</text>'
  + box(16, 220, 120, 60, '本轮正文', '', 'df-box2')
  + line(138, 250, 196, 250, '', true)
  + box(200, 220, 200, 60, '存服务器', '记录挂你名下', 'df-box2')
  + '<path class="df-la" d="M 404 250 L 452 250" marker-end="url(#df-arrow-a)"/>'
  + '<text class="df-s" x="468" y="246">QQ 多一条「查看完整回答」</text>'
  + '<text class="df-s" x="468" y="264">点开是排版好的原文</text>'
  + '<rect class="df-warn" x="190" y="196" width="4" height="104" rx="2"/>'
  + '<text class="df-s" x="16" y="302">↑ 后两种方式都要先打开「允许上传正文」开关（默认关闭）</text>'),
  '第 1 档是<b>默认</b>方式，也是唯一不上传的一档。'
  + '后两档必须同时满足三个条件：方式选对、上传开关已打开、服务器已配置；缺少任何一条都会自动退回第 1 档。');

/* ── ⑤ 隐私三道闸 ───────────────────────────────────────────────────────── */
FIG.gates = figure(svg('0 0 640 172', '上传前的三道闸，缺一不可',
  '<text class="df-s" x="16" y="30">三条依次满足才会真正传输</text>'
  + box(8, 46, 168, 74, '① 模式', 'chat / note / note-link', 'df-box2')
  + line(178, 83, 200, 83, '')
  + box(204, 46, 168, 74, '② 允许上传正文', '开关，默认关闭', 'df-box2')
  + line(374, 83, 396, 83, '')
  + box(400, 46, 168, 74, '③ 服务器已配好', '云端账号 或 中枢地址', 'df-box2')
  + '<path class="df-la" d="M 570 83 L 604 83" marker-end="url(#df-arrow-a)"/>'
  + '<text class="df-s" x="16" y="150">任一条不满足 ⇒ 自动按第 1 档处理：正文发到 QQ，不上传</text>'),
  '这三条是<b>串行</b>的。如果选了存服务器却仍然发到 QQ，'
  + '先检查设置面板里第 ② 条是否打开。');

/* ── ⑥ 额度与保留期 ────────────────────────────────────────────────────── */
FIG.quota = figure(svg('0 0 640 236', '免费版与付费版的额度、保留期对比',
  '<line class="df-l" x1="70" y1="180" x2="600" y2="180"/>'
  + '<line class="df-l" x1="70" y1="26" x2="70" y2="180"/>'
  + '<text class="df-s" x="62" y="34" text-anchor="end">1000</text>'
  + '<text class="df-s" x="62" y="106" text-anchor="end">500</text>'
  + '<text class="df-s" x="62" y="184" text-anchor="end">0</text>'
  + '<line class="df-grid" x1="70" y1="100" x2="600" y2="100"/>'
  + '<text class="df-s" x="70" y="20">每天可查看次数</text>'
  + '<rect class="df-bar" x="120" y="164" width="104" height="16" rx="4"/>'
  + '<text class="df-t" x="172" y="158" text-anchor="middle">100 次</text>'
  + '<text class="df-t" x="172" y="200" text-anchor="middle">免费版</text>'
  + '<text class="df-s" x="172" y="218" text-anchor="middle">记录留 5 小时</text>'
  + '<rect class="df-bar2" x="360" y="48" width="104" height="132" rx="4"/>'
  + '<text class="df-t" x="412" y="42" text-anchor="middle">1000 次</text>'
  + '<text class="df-t" x="412" y="200" text-anchor="middle">付费版 · ¥2.99 / 30 天</text>'
  + '<text class="df-s" x="412" y="218" text-anchor="middle">记录留 48 小时</text>'),
  '两档的差别是<b>每天可查看次数</b>与<b>记录保留期</b>。'
  + '续费在原到期时间上<b>累加</b>，不重新计算。');

/* ── ⑦ DOM 模拟图：QQ 聊天 ──────────────────────────────────────────────── */
FIG.qqchat =
  '<figure class="doc-fig">'
  + '<div class="mock mock-phone">'
  + '<div class="mock-bar"><span>QQ · 我的机器人</span><em>示意图</em></div>'
  + '<div class="mock-body">'
  + '<div class="bubble bot"><b>✅ 主会话 跑完了</b>'
  + '<span class="muted">这轮把教程文档页补上了，顺带给每章配了图。</span>'
  + '<span class="link">查看完整回答</span></div>'
  + '<div class="bubble me"><span>1</span></div>'
  + '<div class="bubble bot sm">✅ 收到，已经把你的回答带过去了（主会话）</div>'
  + '</div></div>'
  + '<figcaption>QQ 里的示意图：机器人发一条带摘要的通知。<b>引用它</b>回复数字即回答该提问，引用后说话即回到对应会话继续。'
  + '（这是<b>示意图</b>，不是截图；真机字体与气泡圆角由 QQ 决定。）</figcaption></figure>';

/* ── ⑧ DOM 模拟图：DSH 输入框下面那两个开关 ─────────────────────────────── */
FIG.dock =
  '<figure class="doc-fig">'
  + '<div class="mock mock-dock">'
  + '<div class="mock-note">DSH 会话输入框（示意图）</div>'
  + '<div class="mock-input">说说你想让它做什么…</div>'
  + '<div class="mock-dockrow">'
  + '<span class="mini"><i class="dot on"></i>QQ 提醒已开</span>'
  + '<span class="mini"><i class="dot on"></i>协作已开</span>'
  + '<span class="mock-tail">← 只有这两个开关</span>'
  + '</div></div>'
  + '<figcaption>输入框下方<b>只有两个开关</b>：QQ 提醒、协作。其余配置（上传开关、全文去向、凭证、agentmd 等）'
  + '都在 <b>设置 → QQ 提醒与跨会话记忆</b> 里。</figcaption></figure>';

/* ── ⑨ DOM 模拟图：QQ 自定义菜单 ────────────────────────────────────────── */
FIG.qmenu =
  '<figure class="doc-fig">'
  + '<div class="mock mock-menu">'
  + '<div class="mock-bar"><span>QQ 聊天窗口底部的机器人菜单</span><em>示意图</em></div>'
  + '<div class="menu-row">'
  + '<span class="mbtn">看状态</span><span class="mbtn">会话</span><span class="mbtn">屏幕</span>'
  + '<span class="mbtn">帮助</span><span class="mbtn">派活</span>'
  + '</div>'
  + '<div class="menu-tip">点「屏幕」→ 输入框出现 <code>/screen</code> → <b>还需按一次发送</b></div>'
  + '</div>'
  + '<figcaption>五个一级菜单项都在线上核对过（version 43）。菜单<b>只把命令填入输入框，不会代为发送</b>，'
  + '因此每个菜单项需要点一下再按发送；直接手打 <code>/screen</code> 效果相同。</figcaption></figure>';

/* ── ⑩ DOM 模拟图：发一句 /status 会收到什么（排障第一现场）───────────── */
FIG.status =
  '<figure class="doc-fig">'
  + '<div class="mock mock-phone">'
  + '<div class="mock-bar"><span>QQ · 发一句 /status 收到的回复</span><em>示意图</em></div>'
  + '<div class="mock-body">'
  + '<div class="bubble bot">'
  + '<b>📊 现在的状态</b>'
  + '<span class="muted">QQ 连着，有事我立刻能收到</span>'
  + '<span class="muted">没有在等你回答的问题</span>'
  + '<span class="muted">▶ 正在跑 2 个会话</span>'
  + '<span class="muted">1. 主会话 · agenttool · 第 16 轮</span>'
  + '<span class="muted">2. 插件优化 · agenttool · 第 9 轮</span>'
  + '<span class="muted">💤 另外 112 个闲着</span>'
  + '<span class="muted">🎯 你说的话现在进：主会话（正在跑）（想换就发 /sessions）</span>'
  + '</div></div></div>'
  + '<figcaption>排查问题时先发这一句：它一次给出 QQ 连接状态、是否有提问在等回答、哪些会话在运行、当前消息会进入哪个会话。'
  + '<b>通道未连接时会明确说明。</b></figcaption></figure>';

window.DOCS_FIGS = FIG;
