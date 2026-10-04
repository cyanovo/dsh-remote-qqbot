/* DSH 通知插件 · 网页端 —— 自建教程文档页（零依赖、经典脚本）
   ─────────────────────────────────────────────────────────────────────────────
   为什么自建而不外链：参照站（zzzxin.xin）的「文档」是指向 docs.newapi.pro 的外链，
   我们要的是**打开自己的域名就能看完整教程**，所以教程就长在这个 SPA 里。

   结构：三栏 —— 左「章节」/ 中「正文」/ 右「本页目录」，窄屏自动折成一栏。
   路由：#docs            → 第 1 章
         #docs/<章节 id>  → 指定章节（可分享、可刷新、可收藏）

   ⚠️ 与 app.js 的分工（不要互相越权）：
     · 视图切换（哪一栏亮、`.view` 显隐）仍由 app.js 的 goto() 负责；
       本文件只「点一下文档导航」，**不重复实现切视图**。
     · 现有 URL（`/`、`/n/<id>`、`#records`）行为一个字都不能变。
   ⚠️ 全部内容都是本地内联：没有 CDN、没有外链字体、没有第三方脚本。
   ───────────────────────────────────────────────────────────────────────────── */
'use strict';

(function () {
  const F = window.DOCS_FIGS || {};
  const V = '1.0.0';   // 教程对应的插件版本（每次发版要跟着改）

  /** 真截图（图片文件在 /docs-img/，由 _docs-shots.mjs 真跑出来） */
  function shot(name, alt) {
    return '<figure class="doc-fig doc-shot"><img src="/docs-img/' + name + '.png" alt="' + alt
      + '" loading="lazy" decoding="async"><figcaption>' + alt + '</figcaption></figure>';
  }
  const fig = (k) => F[k] || '';
  function code(text) {
    return '<pre class="doc-code"><code>' + text + '</code></pre>';
  }

  /* ═════════════════════ 章节内容 ═════════════════════ */
  const CH = [
    /* ── 第 1 章 ───────────────────────────────────────────────────────── */
    {
      id: 'what',
      nav: '这是什么',
      lead: '一个 DSH 插件 + 一个网页端。插件负责把 DSH 里的消息推送到 QQ，'
        + '网页端负责存放排版好的完整回答。',
      html:
        '<h2 id="%ID%-a">功能</h2>'
        + '<ul>'
        + '<li><b>完成后通知</b>：一轮结束，QQ 收到一条消息，含会话名和本轮做了什么。</li>'
        + '<li><b>需要你决定时提问</b>：把问题和选项推到 QQ，在手机上引用那条消息回一个数字。</li>'
        + '<li><b>远程派活</b>：直接说话进入闲聊会话；引用通知说话回到对应会话继续。</li>'
        + '<li><b>查看屏幕</b>：在菜单里选「屏幕」，手机会收到一张电脑桌面截图。</li>'
        + '<li><b>完整回答存在服务器</b>：QQ 里带一条链接，点开是排版好的原文（标题、表格、代码块）。</li>'
        + '<li><b>跨会话记忆</b>：不同会话共用一份记忆，换会话不需要重新交代背景。</li>'
        + '</ul>'
        + '<p>默认方式最保守：正文<b>只发到 QQ，不经过服务器</b>。'
        + '要存到服务器，需要先打开上传开关。</p>'
        + fig('arch')
        + '<h2 id="%ID%-b">三步开始使用</h2>'
        + '<div class="doc-steps">'
        + '<div class="doc-step"><b>①</b><div><b>装插件</b><span>一条命令装进 desktop profile。'
        + '<a href="#docs/install">见第 2 章</a></span></div></div>'
        + '<div class="doc-step"><b>②</b><div><b>接 QQ 机器人</b><span>填入 AppID 与密钥，把机器人加为好友。'
        + '<b>这两步做完即可使用</b>。'
        + '<a href="#docs/qq">见第 3 章</a></span></div></div>'
        + '<div class="doc-step"><b>③</b><div><b>重启 DSH</b><span><b>这一步不能省</b>。'
        + '不重启，插件改动不生效。</span></div></div>'
        + '</div>'
        + '<div class="doc-callout"><b>第 4 章「绑定账号」是可选的。</b>'
        + '不绑定也能用：完整回答不经过服务器，也没有短链接，'
        + '正文会切成几条直接发到 QQ。</div>'
        + '<h2 id="%ID%-c">网页端界面</h2>'
        + '<p>首页说明这是什么、怎么安装、免费额度多少。'
        + '登录后增加「我的记录」和「账号」两个页面；桌面与手机使用同一套页面，窄屏自动折成一栏。</p>'
        + shot('home-desktop', '网页端首页（桌面 1280 宽）')
        + shot('home-mobile', '网页端首页（手机 390 宽）')
        + '<div class="doc-callout">当前页就是教程文档，'
        + '可以通过左侧导航随时回到这里。</div>'
    },

    /* ── 第 2 章 ───────────────────────────────────────────────────────── */
    {
      id: 'install',
      nav: '装上插件',
      lead: '插件<b>没有发布到 npm</b>。需要安装包可以加 QQ <b>1103416608</b> 索取 tgz，'
        + '有源码也可以自己打包；两种方式都用一条命令装进 desktop profile。',
      html:
        '<h2 id="%ID%-a">安装步骤</h2>'
        + fig('install')
        + '<h3 id="%ID%-a1">第 1 步 · 装进 desktop profile</h3>'
        + code('npm run pack                                          # 有源码才需要，产出 dsh-remote-qqbot-<版本>.tgz\n'
          + 'dsh plugin --profile desktop add ./dsh-remote-qqbot-<版本>.tgz')
        + '<p>包内已包含构建好的 <code>lib/</code>，<b>安装后即可使用，不需要本地构建</b>。'
        + '桌面版用 <code>--profile desktop</code>，<code>dsh web</code> 启动的用 <code>--profile web</code>；'
        + '装到错误的 profile 不会生效。</p>'
        + '<div class="doc-warn"><b>安装本地 tgz 时的两个常见错误</b>'
        + '<ul>'
        + '<li><b>文件名前必须加 <code>./</code></b>。写成裸文件名，pnpm 会按 npm 上的包名下载，'
        + '报 <code>ERR_PNPM_FETCH_404</code>。</li>'
        + '<li><b>重新打包前，先移除 profile 里的旧依赖</b>。'
        + '旧 tgz 被覆盖或删除后，<code>add</code> 会因指向旧文件名而报 ENOENT，'
        + '容易被误读为包名写错。顺序是<b>先 <code>remove</code> 再 <code>add</code></b>；'
        + '安装后回读 <code>dsh.profile.bundles</code> 确认插件仍在列表中（'
        + '<code>remove</code> 会一并移除该条目）。</li>'
        + '</ul></div>'
        + '<h3 id="%ID%-a2">第 2 步 · 填 QQ 凭证</h3>'
        + '<p>在 <b>设置 → QQ 远程提醒与跨会话记忆</b> 里打开「QQ 机器人通道」，填入 <b>AppID</b> 与 '
        + '<b>ClientSecret</b>。<b>这是插件的必要条件</b>：不填，提醒、反向对话、'
        + '截图、会话切换都无法使用，网页端不受影响。</p>'
        + '<h3 id="%ID%-a3">第 3 步 · 重启 DSH</h3>'
        + '<p><b>不重启则不生效</b>，这是最常见的错误。DSH 是长驻进程，'
        + '插件代码只在启动时加载；磁盘上的文件更新后，内存里运行的仍是旧版本。</p>'
        + '<div class="doc-callout">判断当前运行的是哪一版，比较 '
        + '<b>安装目录里 <code>package.json</code> 的时间</b>与<b>主进程启动时间</b>。'
        + '不要看 <code>lib/*.js</code> 的时间：pnpm 解包不保留安装时刻。</div>'
        + '<h2 id="%ID%-b">确认安装成功</h2>'
        + '<ul>'
        + '<li>在 QQ 里给机器人发 <code>/status</code>，会回复 QQ 的连接状态。</li>'
        + '<li>设置面板左侧出现「<b>QQ 远程提醒与跨会话记忆</b>」这一项。</li>'
        + '<li>会话输入框下方出现两个开关（QQ 提醒 / 协作）。</li>'
        + '<li>启动日志里有两行状态：<code>QQ 提醒：已开</code>、<code>协作：已开</code>；'
        + '出现故障时会额外打印警告。</li>'
        + '<li>仓库里附了验收脚本，安装后可以直接核对：'
        + '<code>node scripts/verify-installed.mjs</code>、<code>node scripts/verify-ui-installed.mjs</code>，'
        + '两个脚本都返回 0 才算正常。</li>'
        + '</ul>'
        + shot('docs-desktop', '本教程页本身（桌面 1280 宽）：左章节 / 中正文 / 右目录')
    },

    /* ── 第 3 章 ───────────────────────────────────────────────────────── */
    {
      id: 'qq',
      nav: '接上 QQ',
      lead: '需要一个 <b>QQ 机器人</b>（在 q.qq.com 申请，个人开发者身份即可）。'
        + '整个流程约十分钟，其中「把机器人加为好友并发一条消息」不能省略。',
      html:
        '<h2 id="%ID%-a">申请与配置</h2>'
        + '<div class="doc-steps">'
        + '<div class="doc-step"><b>1</b><div><b>在 q.qq.com 建一个机器人应用</b>'
        + '<span>拿到 <b>AppID</b> 和 <b>ClientSecret</b>。</span></div></div>'
        + '<div class="doc-step"><b>2</b><div><b>把这两个值填入 DSH 设置</b>'
        + '<span>设置 → QQ 远程提醒与跨会话记忆 → QQ 机器人通道。</span></div></div>'
        + '<div class="doc-step"><b>3</b><div><b>把机器人加为好友，并给它发一条消息</b>'
        + '<span>这一步<b>不能省</b>：机器人的 <code>open_id</code> 只能从你发给它的消息中获取，'
        + '不先发一条，它无法主动给你发消息。</span></div></div>'
        + '<div class="doc-step"><b>4</b><div><b>重启 DSH</b><span>然后随便让一个会话跑完，QQ 应该收到通知。</span></div></div>'
        + '</div>'
        + '<h2 id="%ID%-b">菜单与指令</h2>'
        + fig('qmenu')
        + '<table class="doc-table"><thead><tr><th>指令</th><th>作用</th></tr></thead><tbody>'
        + '<tr><td><code>/status</code></td><td>查看状态：QQ 是否连通、是否有提问在等回答、<b>哪些会话在运行</b>、当前消息会进入哪个会话</td></tr>'
        + '<tr><td><code>/sessions</code></td><td>列出最近 6 个会话，回一个数字切过去（5 分钟内有效）</td></tr>'
        + '<tr><td><code>/use 3</code></td><td>直接切到名单里的第 3 个</td></tr>'
        + '<tr><td><code>/screen</code></td><td>把当前电脑桌面截一张图发到 QQ</td></tr>'
        + '<tr><td><code>/task</code></td><td>把这句话派给专属会话执行</td></tr>'
        + '<tr><td><code>/answer</code></td><td>回答当前挂着的问题</td></tr>'
        + '<tr><td><code>/help</code></td><td>重新列出以上指令</td></tr>'
        + '</tbody></table>'
        + '<p>中文别名也认：<code>/会话</code>、<code>/截图</code>、<code>/切</code>…</p>'
        + '<h2 id="%ID%-c">DSH 界面</h2>'
        + fig('dock')
        + '<p>输入框下方<b>只有这两个开关</b>。关闭 QQ 提醒不影响网页端；'
        + '关闭协作后，四个协作工具会回复「协作模式已关闭」，不报错，也不会消失。</p>'
    },

    /* ── 第 4 章 ───────────────────────────────────────────────────────── */
    {
      id: 'cloud',
      nav: '绑定账号',
      lead: '绑定之后，存在服务器上的完整回答才<b>挂在你的账号下</b>：'
        + '按你的账号计数，按你的档位决定保留期，也只有登录后才能看到。',
      html:
        '<h2 id="%ID%-a">为什么要绑定</h2>'
        + '<ul>'
        + '<li>不绑定：按免费版计，100 次/天、记录保留 5 小时，记录存在公共位置。</li>'
        + '<li>绑定后：按你的账号计数，付费版 1000 次/天、记录保留 48 小时。</li>'
        + '<li>记录正文<b>只认登录 cookie</b>：发布用的令牌读不到任何一条正文。</li>'
        + '</ul>'
        + fig('bind')
        + '<h2 id="%ID%-b">操作步骤</h2>'
        + '<div class="doc-steps">'
        + '<div class="doc-step"><b>1</b><div><b>在 DSH 里让 agent 调用 <code>cloud_bind</code></b>'
        + '<span>它会返回一组 8 位码，形如 <code>7QK4-M2PD</code>。</span></div></div>'
        + '<div class="doc-step"><b>2</b><div><b>在网页端「账号」页输入这组码并确认</b>'
        + '<span>这一步告诉服务器：这组码的申请人是你的账号。</span></div></div>'
        + '<div class="doc-step"><b>3</b><div><b>回到 DSH 再调用一次 <code>cloud_bind</code></b>'
        + '<span>这一次才换取令牌。<b>绑定完成</b>后用 <code>cloud_status</code> 可以看到剩余次数与当前档位。</span></div></div>'
        + '</div>'
        + '<div class="doc-warn"><b>必须调用两次。</b>第一次只是申请一组码，'
        + '第二次才是换取令牌。中间在浏览器里确认这一步不能少，只有一组码换不到任何权限。</div>'
        + shot('account-bind', '账号页：绑定插件区块（输入 8 位码）与「我的令牌」列表')
        + '<h2 id="%ID%-c">关于令牌</h2>'
        + '<ul>'
        + '<li>插件的令牌<b>只显示一次</b>（创建时），服务端只保存 <code>sha256</code>。</li>'
        + '<li>丢失后不用重建账号：在账号页吊销它、再建一个新的，回到 DSH 重新绑定一次即可。</li>'
        + '<li>权限边界：令牌能读你的配额、能替你发布记录，<b>但读不到任何一条记录正文</b>。</li>'
        + '<li>不再需要就点「注销账号」，它会连同记录一起删除，不可恢复。</li>'
        + '</ul>'
    },

    /* ── 第 5 章 ───────────────────────────────────────────────────────── */
    {
      id: 'daily',
      nav: 'QQ 用法',
      lead: '日常有两种用法：<b>引用</b>某条通知后说话，或者<b>不引用</b>直接说话。'
        + '两者含义不同。',
      html:
        fig('qqchat')
        + '<h2 id="%ID%-a">引用与不引用的区别</h2>'
        + '<table class="doc-table"><thead><tr><th>你的动作</th><th>它的行为</th></tr></thead><tbody>'
        + '<tr><td><b>引用</b>一条「提问」通知回数字</td><td>当作<b>回答那个问题</b>，AI 接着往下跑</td></tr>'
        + '<tr><td><b>引用</b>一条「跑完了」通知说话</td><td>回到<b>那条通知对应的会话</b>，继续交代事情</td></tr>'
        + '<tr><td><b>不引用</b>直接说话</td><td>进入一个<b>独立的闲聊会话</b>：能看状态，但不开工具、不碰文件</td></tr>'
        + '<tr><td>引用一条无法识别的旧通知</td><td>明确回复「认不出是哪次通知」，不会猜测后投递</td></tr>'
        + '</tbody></table>'
        + '<p>优先级固定：<b>引用 &gt; 有提问在等 &gt; 选会话 &gt; 闲聊</b>。'
        + '因此当 AI 在等你回答提问时，回复的 <code>1</code> 是<b>答案</b>，'
        + '不会被当作切换到第 1 个会话。</p>'
        + '<h2 id="%ID%-b">三个远程操作</h2>'
        + '<h3 id="%ID%-b1">查看运行中的会话</h3>'
        + '<p>发 <code>/status</code>，会显示哪些会话在运行、进行到第几轮，'
        + '以及<b>当前消息会进入哪个会话</b>。</p>'
        + '<h3 id="%ID%-b2">切换会话</h3>'
        + '<p>发 <code>/sessions</code> 会列出最近 6 个会话，回复数字即可切换。'
        + '名单<b>每次重新获取</b>，切换后有回执；指定的会话不存在时会明确说明，'
        + '不会把消息投到其他会话。</p>'
        + '<h3 id="%ID%-b3">获取屏幕截图</h3>'
        + '<p>在菜单里选「屏幕」，或直接发 <code>/screen</code>。'
        + '返回一张<b>整块桌面</b>的 JPEG（按宽度等比缩到 1600 以内，约 200 KB）。</p>'
        + '<div class="doc-warn"><b>截图报错或提示被安全软件拦截：</b>'
        + '抓屏会调用 Windows 图形接口，部分安全软件（实测 Windows Defender 的 AMSI）'
        + '会对「抓屏 + 构造 JPEG 编码器参数」这个组合报警。'
        + '插件已改为最朴素的保存方式，避开该特征；'
        + '如果仍然被拦截，把 DSH 的抓屏动作加入安全软件的排除项。'
        + '截图是<b>临时文件</b>，发送后即删除。</div>'
    },

    /* ── 第 6 章 ───────────────────────────────────────────────────────── */
    {
      id: 'fulltext',
      nav: '全文去向',
      lead: 'QQ 一条消息放不下整轮回答，因此有三种处理方式。'
        + '<b>默认方式最保守：正文切成几条消息直接发到 QQ，不经过服务器。</b>',
      html:
        fig('modes')
        + '<h2 id="%ID%-a">三种方式对比</h2>'
        + '<table class="doc-table"><thead><tr><th>方式</th><th>正文去哪</th><th>要上传吗</th><th>适合谁</th></tr></thead><tbody>'
        + '<tr><td><b>直接发到 QQ</b>（默认）</td><td>切成几条纯文本消息发给你</td><td><b>不需要</b>，不上传</td><td>只想马上看到、在意隐私</td></tr>'
        + '<tr><td><b>存服务器，不带链接</b></td><td>存成一条记录，QQ 只给摘要</td><td>需要，占一次额度</td><td>想自己去网页端翻</td></tr>'
        + '<tr><td><b>存服务器 + 带链接</b></td><td>存成记录，QQ 多一条「查看完整回答」</td><td>需要，占一次额度</td><td>想直接在 QQ 里点开看</td></tr>'
        + '</tbody></table>'
        + '<h2 id="%ID%-b">在哪里修改</h2>'
        + '<p><b>设置 → QQ 提醒与跨会话记忆</b> 里有「完整回答去哪」，'
        + '还有一个独立的「允许上传正文」开关（<b>默认关闭</b>，见第 7 章）。</p>'
        + '<h2 id="%ID%-c">点开后的效果</h2>'
        + shot('records', '「我的记录」页：每条记录一行，点开就是排版好的原文')
        + shot('reader', '点开一条记录：标题 / 列表 / 表格 / 代码块都已排版，不再是原始的 Markdown 记号')
        + '<h2 id="%ID%-d">为什么链接域名是大写的</h2>'
        + '<p>QQ 里那条链接形如 <code>http://CYANOVO.TOP/n/&lt;id&gt;</code>：'
        + '<b>http</b>（不是 https）、<b>域名全大写</b>。这是实测结果：'
        + '只有这种形式能在 QQ 里直接点开，小写或带端口会被平台拦截并提示'
        + '「如需预览请用浏览器打开」。</p>'
        + '<p>因此 80 端口一直保留，<b>故意不做 80→443 跳转</b>、<b>不加 HSTS</b>；'
        + '插件调用服务器的接口本身走 https，被改写的只有链接的显示形式。</p>'
    },

    /* ── 第 7 章 ───────────────────────────────────────────────────────── */
    {
      id: 'quota',
      nav: '额度与隐私',
      lead: '这一章说明正文何时会传到服务器，以及上传后多久删除。',
      html:
        fig('quota')
        + '<h2 id="%ID%-a">额度怎么算</h2>'
        + '<ul>'
        + '<li><b>免费版</b>：每天 100 次「查看完整回答」，记录保留 <b>5 小时</b>。登录即可，不需要其他操作。</li>'
        + '<li><b>付费版</b>：每天 1000 次，记录保留 <b>48 小时</b>。¥2.99 / 30 天。</li>'
        + '<li>续费<b>叠加</b>：在原到期时间上继续往后加 30 天，不重新计算。</li>'
        + '<li>第 1 档（直接发到 QQ）<b>不占额度</b>，它不经过服务器。</li>'
        + '</ul>'
        + '<h2 id="%ID%-b">上传的三个前提</h2>'
        + fig('gates')
        + '<p>这三条是<b>串行</b>的：任何一条不满足，就自动按第 1 档处理，'
        + '正文发到 QQ，<b>不上传</b>，也不占额度。</p>'
        + '<h2 id="%ID%-c">「不上传」的含义</h2>'
        + '<ul>'
        + '<li>服务器上不会出现这一轮回答的任何片段。</li>'
        + '<li>不上传就不占次数、不产生记录，也不涉及保留期。</li>'
        + '<li>通知本身（「跑完了」加一句摘要）仍然会经过通知中枢，'
        + '这是提醒功能的前提；<b>正文</b>与<b>摘要</b>是两件事。</li>'
        + '</ul>'
        + '<h2 id="%ID%-d">删除记录</h2>'
        + '<p>账号页有「清空我的记录」和「注销账号」两个操作：'
        + '前者删除记录、保留账号；后者连账号一起删除，<b>不可恢复</b>。</p>'
        + '<div class="doc-callout">服务器上没有任何记录会永久保留：'
        + '免费版 5 小时、付费版 48 小时后自动清理。'
        + '过期清理会<b>写入磁盘</b>，重启服务不会让过期记录恢复。</div>'
    },

    /* ── 第 8 章 ───────────────────────────────────────────────────────── */
    {
      id: 'faq',
      nav: '常见问题',
      lead: '按现象查找。以下每条都在实际使用中遇到过。',
      html:
        '<h2 id="%ID%-a">QQ 相关</h2>'
        + '<dl class="doc-faq">'
        + '<dt>QQ 里一直没收到通知</dt>'
        + '<dd>先在 QQ 里发 <code>/status</code>，'
        + '它会直接回复 QQ 是否连通。没连上通常是三种原因：'
        + 'AppID 或密钥填错；<b>没有把机器人加为好友并发过消息</b>（拿不到 open_id）；'
        + '安装后没有重启 DSH。</dd>'
        + '</dl>'
        + fig('status')
        + '<dl class="doc-faq">'
        + '<dt>链接点开是空白 / 提示「如需预览请用浏览器打开」</dt>'
        + '<dd>QQ 按<b>域名信任级别</b>拦截链接。使用消息里那条原文链接（大写域名 + http）即可；'
        + '在别处手打小写域名被拦是正常的。</dd>'
        + '<dt>点菜单「屏幕」没反应</dt>'
        + '<dd>菜单<b>只把 <code>/screen</code> 填入输入框，不会代为发送</b>，'
        + '还需要按一次发送。直接手打 <code>/screen</code> 效果相同。</dd>'
        + '<dt>截图只有左上角</dt>'
        + '<dd>旧版本的缺陷：抓屏脚本缺少一行 DPI 声明，已在 0.8.3 修复。'
        + '仍在旧版本上就安装新版本，并<b>重启 DSH</b>。</dd>'
        + '</dl>'
        + '<h2 id="%ID%-b">DSH 相关</h2>'
        + '<dl class="doc-faq">'
        + '<dt>设置里改了值，过一会儿又变回去了</dt>'
        + '<dd>桌面版对第三方插件的设置写入有限制，插件会退回自己的覆盖文件。'
        + '写入失败时开关旁边会显示红色原因，<b>失败不会静默</b>。'
        + '需要一键还原，删除 <code>~/.dsh/remote-qqbot-overrides.json</code>。</dd>'
        + '<dt>开关点了没反应</dt>'
        + '<dd>先确认安装后重启过 DSH。另外，输入框下方只有两个开关，'
        + '其余配置都在设置面板里，这是有意设计的。</dd>'
        + '<dt>输入框下面的开关状态显示「未连接」</dt>'
        + '<dd>它读取插件实际使用的配置。显示未连接但 QQ 能收消息，'
        + '通常是 QQ 凭证没配齐（缺少 AppID 或密钥）。</dd>'
        + '</dl>'
        + '<h2 id="%ID%-c">服务器相关</h2>'
        + '<dl class="doc-faq">'
        + '<dt>提示「今天次数用完了」</dt>'
        + '<dd>免费版 100 次/天、付费版 1000 次/天，按<b>自然日</b>重置。'
        + '第 1 档（正文直接发到 QQ）不占额度，不需要计数。</dd>'
        + '<dt>记录找不到了</dt>'
        + '<dd>过期后会从「我的记录」里消失：免费版 5 小时、付费版 48 小时。'
        + '需要更长的保留期见第 6 章。</dd>'
        + '<dt>网页端打开还是旧样子</dt>'
        + '<dd>静态资源有 5 分钟缓存，按一次 <b>Ctrl+F5</b>（手机上是清除缓存）。</dd>'
        + '</dl>'
        + '<div class="doc-callout">以上都解决不了，就把现象、发生时间、'
        + '以及 <code>/status</code> 的输出一起发过来，便于定位。</div>'
    }
  ];

  /* ═════════════════════ 渲染 ═════════════════════ */
  const LINK = (href, cls, text) =>
    '<a class="' + cls + '" href="' + href + '">' + text + '</a>';

  const state = { ch: null, toc: [], headings: [] };
  const $ = (id) => document.getElementById(id);

  function chapter(id) {
    for (let i = 0; i < CH.length; i++) if (CH[i].id === id) return CH[i];
    return null;
  }
  /** 把内容里的 %ID% 占位符换成章节 id（锚点因此天然唯一且可分享） */
  function fill(html, id) { return html.split('%ID%').join(id); }

  function renderNav(cur) {
    const nav = $('docsNav');
    if (!nav) return;
    let h = '<div class="docs-nav-title">教程文档</div>';
    for (let i = 0; i < CH.length; i++) {
      const c = CH[i];
      h += '<a class="docs-nav-item' + (c.id === cur ? ' on' : '') + '" href="#docs/' + c.id + '"'
        + ' data-ch="' + c.id + '"><span class="n">' + (i + 1) + '</span>' + c.nav + '</a>';
    }
    h += '<div class="docs-nav-foot">对应插件版本 <b>' + V + '</b></div>';
    nav.innerHTML = h;
  }

  function renderToc() {
    const toc = $('docsToc');
    if (!toc) return;
    if (!state.toc.length) { toc.innerHTML = ''; return; }
    let h = '<div class="docs-toc-title">本页目录</div>';
    for (let i = 0; i < state.toc.length; i++) {
      const t = state.toc[i];
      h += '<button type="button" class="docs-toc-link lv' + t.lv + '" data-sec="' + t.id + '">'
        + t.text + '</button>';
    }
    toc.innerHTML = h;
  }

  function renderPager(cur) {
    const pager = $('docsPager');
    if (!pager) return;
    const i = CH.map((c) => c.id).indexOf(cur);
    const prev = i > 0 ? CH[i - 1] : null;
    const next = i >= 0 && i < CH.length - 1 ? CH[i + 1] : null;
    pager.innerHTML = (prev
      ? LINK('#docs/' + prev.id, 'docs-pager-btn', '<span>上一章</span>' + prev.nav)
      : '<span class="docs-pager-btn is-off"><span>上一章</span>已经是第一章</span>')
      + (next
        ? LINK('#docs/' + next.id, 'docs-pager-btn next', '<span>下一章</span>' + next.nav)
        : '<span class="docs-pager-btn is-off"><span>下一章</span>已经是最后一章</span>');
  }

  /** 从正文里抽出 h2/h3 作为「本页目录」 */
  function collectToc(body) {
    const out = [];
    const hs = body.querySelectorAll('h2[id],h3[id]');
    for (let i = 0; i < hs.length; i++) {
      out.push({ id: hs[i].id, text: hs[i].textContent, lv: hs[i].tagName === 'H3' ? 2 : 1 });
    }
    state.toc = out;
    state.headings = out;
  }

  /* ── 谁在滚？────────────────────────────────────────────────────────────
     ⚠️ 这里踩过一个真坑（2026-10-04 实测，不是推测）：
     `.app{height:100dvh}` 里的 `.scroll{flex:1;overflow-y:auto}` **只在内容比视口矮时**
     才真的滚。教程页有 1700+ px 高，把 grid 行撑破了 ⇒ 实测
        #scroll  clientHeight=1837 scrollHeight=1837   ← 它自己一格都滚不动
        html     clientHeight= 803 scrollHeight=1893   ← 真正在滚的是文档
     若只认 `#scroll`，目录点了不动、跟随高亮也永远停在第一条（实测偏差 1352px、scrollTop 恒为 0）。
     所以这里**两条路都走**：谁真能滚就用谁。 */
  function scroller() {
    const sc = $('scroll');
    if (sc && sc.scrollHeight > sc.clientHeight + 1) {
      return {
        el: sc,
        top: function () { return sc.scrollTop; },
        base: function () { return sc.getBoundingClientRect().top; },  /* 容器顶部相对视口 */
      };
    }
    const de = document.scrollingElement || document.documentElement;
    return {
      el: de,
      top: function () { return de.scrollTop; },
      base: function () { return 0; },   /* 文档滚动时，视口顶就是基准 */
    };
  }
  function scrollToY(y) {
    const s = scroller();
    if (s.el === document.documentElement || s.el === document.scrollingElement) window.scrollTo(0, y);
    else s.el.scrollTop = y;
  }

  function open(id, opts) {
    const c = chapter(id) || CH[0];
    state.ch = c.id;
    if (typeof opts === 'undefined') opts = {};
    /* activate:false = 只把内容渲染好，**不**切视图。
       启动时要用它：否则一进首页就被切成教程页了。 */
    const nav = document.querySelector('.nav-item[data-view="docs"]');
    if (nav && opts.activate !== false && !nav.classList.contains('is-on')) nav.click();   // 切视图交给 app.js
    renderNav(c.id);
    const body = $('docsBody');
    if (!body) return;
    body.innerHTML = '<div class="docs-lead">' + c.lead + '</div>'
      + fill(c.html, c.id)
      + '<div class="docs-pager" id="docsPager"></div>';
    collectToc(body);
    renderToc();
    renderPager(c.id);
    if (opts.keepScroll !== true) scrollToY(0);
    if (opts.updateHash !== false) {
      try { history.replaceState(null, '', '#docs/' + c.id); } catch (e) { /* 忽略 */ }
    }
    spy();
  }

  /** 启动时先把一章渲染进那个（还藏着的）section。
      不做这件事的话，点顶部「教程文档」看到的是**只有静态兜底文字的空壳** ——
      章节、正文、目录全是空的（2026-10-04 验收脚本抓到的真缺陷）。
      刻意不切视图、不动地址栏。 */
  function ensureRendered() {
    const body = $('docsBody');
    if (body && body.querySelector('h2[id]')) return;    // 已经渲染过
    open(state.ch || CH[0].id, { activate: false, keepScroll: true, updateHash: false });
  }

  /** 高亮当前读到的位置（用真实矩形算，不依赖 IntersectionObserver） */
  let ticking = false;
  function spy() {
    const toc = $('docsToc');
    if (!toc || !state.headings.length) return;
    const s = scroller();
    const base = s.base();
    let hit = state.headings[0].id;
    for (let i = 0; i < state.headings.length; i++) {
      const el = document.getElementById(state.headings[i].id);
      if (!el) continue;
      if (el.getBoundingClientRect().top - base <= 28) hit = state.headings[i].id;
      else break;
    }
    const links = toc.querySelectorAll('.docs-toc-link');
    /* 到底了就把最后一条点亮：章节在视口里的位置本来就是"最后一条顶不到最上面"
       （它下面没有内容可撑了），若还按 28px 阈值算，读到页面最底部时高亮的会是倒数第三条，
       而用户明明已经读到最后了。（2026-10-04 实测：滚到底时高亮停在 quota-b，而最后一条是 quota-d） */
    const atBottom = s.el.scrollHeight - s.el.clientHeight - s.top() <= 2;
    if (atBottom) hit = state.headings[state.headings.length - 1].id;
    for (let i = 0; i < links.length; i++) {
      links[i].classList.toggle('on', links[i].getAttribute('data-sec') === hit);
    }
  }
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; spy(); });
  }

  function goSec(secId) {
    const el = document.getElementById(secId);
    if (!el) return;
    const s = scroller();
    scrollToY(s.top() + (el.getBoundingClientRect().top - s.base()) - 14);
    spy();
  }

  function route() {
    const h = location.hash || '';
    if (h.indexOf('#docs') !== 0) return;      // 不是我管的路由，别插手
    const id = h.replace(/^#docs\/?/, '');
    open(id || CH[0].id);
  }

  /* ── 事件（全部用委托，避免内容重渲染后丢监听） ── */
  function bind() {
    document.addEventListener('click', function (ev) {
      const t = ev.target;
      if (!t || !t.closest) return;
      const tocBtn = t.closest('.docs-toc-link');
      if (tocBtn) { ev.preventDefault(); goSec(tocBtn.getAttribute('data-sec')); return; }
      const navItem = t.closest('.docs-nav-item');
      if (navItem) { ev.preventDefault(); open(navItem.getAttribute('data-ch')); return; }
      const pagerBtn = t.closest('.docs-pager-btn[href]');
      if (pagerBtn) {
        const href = pagerBtn.getAttribute('href') || '';
        if (href.indexOf('#docs/') === 0) { ev.preventDefault(); open(href.slice(6)); }
      }
      /* 点顶部「教程文档」这里**故意不做任何事**：内容由启动时的 ensureRendered() 一次渲染好
         （同一文件里的两条路互为备份 = 谁也验不出来，反向校验也切不出红）。
         少一条路，反而多一分确定。 */
    }, false);
    const sc = $('scroll');
    if (sc) sc.addEventListener('scroll', onScroll, { passive: true });
    /* 两条路都要听：`#scroll` 能滚时听它，撑破被文档接管时听 window（见 scroller() 的说明） */
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('hashchange', route, false);
  }

  window.DOCS = { chapters: CH, open: open, route: route, version: V };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(); ensureRendered(); route(); }, false);
  } else { bind(); ensureRendered(); route(); }
})();
