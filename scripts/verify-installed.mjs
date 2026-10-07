// 装完之后的**独立复验**：直接 import 安装目录里的真函数跑一遍，看它实际输出什么。
// （教训：验行为要跑函数，不要正则扫源码 —— 上一节的正则版本曾把注释里的说明文字当成回归。）
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DIR = 'C:/Users/cyan/.dsh/profiles/desktop/node_modules/dsh-remote-qqbot/lib/'
const LIB = DIR + 'qqbridge.js'
const mod = await import(pathToFileURL(LIB).href)
const { qqPreviewUrl, summarizeSession, formatStatusText } = mod

let bad = 0
// 打印长串时截断（底图 base64 有 38 万字符，整行打出来会把后面所有结论冲出屏幕）
const show = (v) => {
  const s = JSON.stringify(v)
  if (s === undefined) return String(v)
  return s.length > 96 ? `${s.slice(0, 60)}…（共 ${s.length} 字符，已截断）` : s
}
const check = (label, got, want) => {
  const ok = got === want
  if (!ok) bad++
  console.log(ok ? '✅' : '❌', label, '→', show(got), ok ? '' : `（期望 ${show(want)}）`)
}

// ── 一、域名大写绕过（v0.7.3） ─────────────────────────────────────────────
console.log('── 一、QQ 链接预览：域名大写绕过 ──')
const cases = [
  ['https://cyanovo.top:8444/dsh/hd882.html', 'http://CYANOVO.TOP/dsh/hd882.html'],
  ['https://cyanovo.top:8444/dsh/AbC-123_x.html', 'http://CYANOVO.TOP/dsh/AbC-123_x.html'],
  ['', ''],
  ['not a url', 'not a url'],
]
for (const [input, want] of cases) check(`qqPreviewUrl(${JSON.stringify(input)})`, qqPreviewUrl(input), want)
// 主人实测可开的那一条，一字不差比对
const shipped = qqPreviewUrl('https://cyanovo.top:8444/dsh/hd882.html')
const exact = shipped === 'http://CYANOVO.TOP/dsh/hd882.html'
if (!exact) bad++
console.log('\n与主人实测可开的形式逐字相同 :', exact, shipped)

// ── 二、/status 能列出「哪些会话正在运行」（本轮需求） ────────────────────────
// 这段用的是**真实 session/list 的形状**（2026-10-02 实测抓的），不是编的。
console.log('\n── 二、看状态 /status：列出正在运行的会话 ──')
if (typeof summarizeSession !== 'function' || typeof formatStatusText !== 'function') {
  console.log('❌ 安装目录里的 qqbridge.js 没有 summarizeSession / formatStatusText')
  console.log('   ⇒ 这次安装的产物**不含**「看状态列出运行中会话」这个改动，需要重新 pack + install')
  console.log('\n>>> 有问题 ❌')
  process.exit(1)
}

const raw = [
  {
    sessionId: 'session-072743da-778f-4b6c-98f7-517e86072f83',
    updatedAt: 1790909297617,
    running: true,
    blank: false,
    cwd: 'D:\\cyanproject\\agenttool',
    projections: { kind: 'sequenced', values: { title: '主会话', sessionStats: { turns: 16, steps: 40 } } },
  },
  {
    sessionId: 'session-37466a09-7f7d-4a8e-a5ac-2da16b4a5564',
    updatedAt: 1790909111549,
    running: false,
    blank: false,
    cwd: 'D:\\cyanproject\\agenttool',
    projections: { kind: 'sequenced', values: { title: '插件优化', sessionStats: { turns: 9, steps: 22 } } },
  },
  // 老会话没有 sessionStats；标题为 null 的空会话 —— 真实数据里两种都存在
  { sessionId: 'session-old-0001', updatedAt: 1790907213026, running: false, blank: false, cwd: 'D:\\cyanproject\\agenttool', projections: { values: { title: '旧会话' } } },
  { sessionId: 'session-blank-0002', updatedAt: 1790907000000, running: false, blank: true, cwd: 'D:\\other', projections: { values: { title: null } } },
]

const sessions = raw.map(summarizeSession)
const text = formatStatusText({
  channelOn: true,
  pending: 0,
  sessions,
  taskId: 'session-37466a09-7f7d-4a8e-a5ac-2da16b4a5564',
  chatId: 'session-072743da-778f-4b6c-98f7-517e86072f83',
  listError: '',
})

console.log(text.split('\n').map((l) => '  │ ' + l).join('\n'))

const s = sessions[0]
check('运行中会话：标题', s.title, '主会话')
check('运行中会话：项目（取 cwd 末段）', s.project, 'agenttool')
check('运行中会话：轮数', s.turns, 16)
check('运行中会话：running', s.running, true)
check('老会话缺 sessionStats → turns 为 null（不是 NaN）', sessions[2].turns, null)
check('blank 且 title 为 null → 「（空会话）」', sessions[3].title, '（空会话）')
check('在跑的被逐个列出（第 1 行）', text.includes('1. 主会话 · agenttool · 第 16 轮'), true)
check('空闲数 = 总数 − 在跑数', text.includes('💤 另外 3 个闲着'), true)
check('专属/闲聊会话显示名字而不是 sessionId', /📌 用 \/task 派活.*插件优化/.test(text), true)
check('纯文本：无 markdown 记号（被动回复不带 markdown）', /(\*\*|```|^\s*#{1,6}\s|\]\(\s*http)/m.test(text), false)
check('无 undefined 泄漏', text.includes('undefined'), false)

// 拿不到会话列表时必须明说，绝不能假装「没有在跑」——那是最误导人的失败方式
const errText = formatStatusText({ sessions: [], listError: 'boom' })
check('listError 时显式告警而不是假装空闲', /⚠️/.test(errText) && !/现在没有会话在跑/.test(errText), true)

console.log('\n指令「/status」应回复的内容：')
console.log(text)

// ── 三、/screen 截图（v0.8.1） ──────────────────────────────────────────────
// 这一节**真的抓一次屏**（读的是安装目录里的 screenshot.js），不是跑 mock。
// v0.8.1 起额外守一件事：脚本里不许出现会被 Windows Defender AMSI 拦下的构造。
console.log('\n── 三、/screen 截图：抓屏 + 上行形状 ──')
const shot = await import(pathToFileURL(DIR + 'screenshot.js').href)
const { QqBotClient } = await import(pathToFileURL(DIR + 'qqbot.js').href)

const ps = shot.buildPowerShellScript({})
check('生成的 PowerShell 脚本是纯 ASCII（否则 5.1 会按本地代码页解出乱码）', /[^\x00-\x7F]/.test(ps), false)
check('脚本用 VirtualScreen（多屏合成，不是只抓主屏）', ps.includes('SystemInformation]::VirtualScreen'), true)
check('脚本把限宽写进 param() 默认值（体积旋钮真的在）', /\[int\]\$MaxWidth = \d+/.test(ps), true)
check('脚本的 Save 重载不再传编码器参数（只剩两个入参）',
  /\$target\.Save\(\$Out, \[System\.Drawing\.Imaging\.ImageFormat\]::Jpeg\)/.test(ps), true)
check('★ 脚本不含 GetImageEncoders / EncoderParameter（会触发 AMSI 整份拦截）',
  /GetImageEncoders|EncoderParameter|ImageCodecInfo|-Quality/.test(ps), false)
check('★ 存图走 ImageFormat::Jpeg 这条不会被拦的重载',
  ps.includes('$target.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)'), true)

check('parseShotOutput 认得 OK 行', JSON.stringify(shot.parseShotOutput('OK 1440x900 -> C:\\t\\a.jpg')), JSON.stringify({ width: 1440, height: 900, path: 'C:\\t\\a.jpg' }))
check('parseShotOutput 对垃圾输出返回 null（不瞎猜）', shot.parseShotOutput('nonsense'), null)

const cmd = shot.captureCommand({ platform: 'win32', script: 'C:\\t\\shot.ps1', out: 'C:\\t\\a.jpg', maxWidth: 1600 })
check('captureCommand：win32 用 powershell.exe + -File + -NoProfile（且不再传 -Quality）',
  cmd.file === 'powershell.exe' && cmd.args.includes('-File') && cmd.args.includes('-NoProfile')
  && cmd.args.includes('C:\\t\\shot.ps1') && !cmd.args.includes('-Quality'), true)

check('isAvBlocked 认得 Defender 的报错原文', shot.isAvBlocked('FullyQualifiedErrorId : ScriptContainedMaliciousContent'), true)
check('isAvBlocked 不误伤普通报错', shot.isAvBlocked('Command failed: powershell.exe'), false)

// 真抓一张（这是本节的主证据：安装目录里的实现此刻真的能截到屏）
const t0 = Date.now()
const cap = await shot.captureScreen({})
const jpeg = cap.buffer.subarray(0, 3).toString('hex')
console.log(`  真实抓屏：${cap.width}x${cap.height}，${cap.bytes} 字节，耗时 ${cap.ms} ms（墙钟 ${Date.now() - t0} ms）`)
console.log(`  首 3 字节：${jpeg}（JPEG 的 SOI+APP0 应是 ffd8ff）`)
check('抓屏尺寸为正整数', cap.width > 0 && cap.height > 0, true)
check('产物确实是 JPEG（ffd8ff）', jpeg, 'ffd8ff')
check('体积像张真图（> 10 KB）', cap.bytes > 10000, true)
check('buffer 长度与 bytes 一致', cap.buffer.length, cap.bytes)

// ── 三之二、DPI：截图不许只剩左上角（2026-10-02 第二个坑） ────────────────────
// 根因：DPI 不感知的 powershell.exe（5.1）眼里桌面是**虚拟化**的（本机 2880x1800 面板按
// 200% 缩放 ⇒ 它看到 1440x900），而 Graphics.CopyFromScreen 是按物理像素 1:1 拷贝的
// ⇒ 存下来的图只有真实桌面的左上角那 1/4。修法只有一条：**在读 VirtualScreen 之前**
// 先 [DshShot.Dpi]::SetProcessDPIAware()，顺序就是全部。
// 守门办法：拿脚本自己打印的**缩放前** raw 尺寸，跟一个**独立来源**（WMI 报的驱动层分辨率）
// 对撞。旧代码 raw=1440x900，跟任何一块真实显示器都对不上 ⇒ 立刻报红；光看图片尺寸（缩放后
// 恒为 1600x1000）是**看不出**这个 bug 的，这就是它当初能溜过验收的原因。
// ⚠️ 量具陷阱（本轮亲历）：本机有 3 个适配器 —— AMD Radeon 780M（真屏 2880x1800）、
// GameViewer 虚拟显示器（3840x2160）、OrayIddDriver（0x0）。第一版护栏写成
// 「raw == WMI 第一条」，取到的偏偏是虚拟显示器的 3840x2160，于是**在已经修好的代码上误报红**。
// 正确做法：把**所有**有效分辨率收集起来，判定 raw 命中其中之一。
console.log('\n── 三之二、DPI：抓到的是整块物理桌面，不是左上角 ──')
check('★ 脚本在读 VirtualScreen 之前先认领 DPI 感知（顺序是修复的全部）',
  ps.includes('SetProcessDPIAware') && ps.indexOf('SetProcessDPIAware') < ps.indexOf('SystemInformation]::VirtualScreen'), true)
check('★ P/Invoke 声明的是 SetProcessDPIAware（.NET Framework 没有 SetHighDpiMode）',
  /\[DllImport\("user32\.dll"\)\]\s*public static extern bool SetProcessDPIAware\(\)/.test(ps), true)
check('★ 脚本回执里额外打印缩放前的 RAW WxH（否则无从判断有没有被虚拟化）',
  /Write-Output \("RAW \{0\}x\{1\}" -f \$rawW, \$rawH\)/.test(ps), true)
// 缺函数时**点名报红**，而不是抛一个看不懂的栈（旧产物上就是这么表现的）
const canRaw = typeof shot.parseRawOutput === 'function'
check('★ 安装目录里的 screenshot.js 导出了 parseRawOutput', canRaw, true)
check('★ parseRawOutput 认得 RAW 行',
  JSON.stringify(canRaw ? shot.parseRawOutput('OK 1600x1000 -> C:\\t\\a.jpg\r\nRAW 2880x1800\r\n') : '（安装目录里没这个函数）'),
  JSON.stringify({ width: 2880, height: 1800 }))
check('★ parseRawOutput 对没有 RAW 行的旧输出返回 null',
  canRaw ? shot.parseRawOutput('OK 1440x900 -> C:\\t\\a.jpg') : '（安装目录里没这个函数）', null)
check('★ captureScreen 透出 rawWidth/rawHeight', cap.rawWidth > 0 && cap.rawHeight > 0, true)
check('★ 缩放后 1600x1000 且 raw ≠ 缩放后（确实缩过，不是没缩）',
  cap.width === 1600 && cap.height === 1000 && cap.rawWidth !== cap.width, true)

// 独立物理尺寸来源：Win32_VideoController 报的是驱动层分辨率，不经过 DPI 虚拟化。
// ⚠️ 必须收集**全部**适配器：本机有 3 个（AMD Radeon 780M = 真屏、GameViewer 虚拟显示器、
// OrayIddDriver 空值），只取第一条会拿到虚拟显示器 ⇒ 在修好的代码上误报红（本轮亲历）。
let physSizes = []
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)" }'],
  { encoding: 'utf8', timeout: 30000 })
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?)\|(\d{3,5})x(\d{3,5})\s*$/.exec(line.trim())
    if (m) physSizes.push(`${Number(m[2])}x${Number(m[3])}`)
  }
} catch { /* 读不到就跳过，不误判 */ }
if (physSizes.length) {
  console.log(`  独立来源的物理分辨率（WMI Win32_VideoController，共 ${physSizes.length} 块）：${physSizes.join(' / ')}`)
  check('★ raw 尺寸命中其中一块真实显示器的分辨率（"没被 DPI 虚拟化"的硬证据）',
    `${cap.rawWidth}x${cap.rawHeight}`, physSizes.includes(`${cap.rawWidth}x${cap.rawHeight}`) ? `${cap.rawWidth}x${cap.rawHeight}` : `以上任一（实际 ${cap.rawWidth}x${cap.rawHeight} 一块都没命中）`)
  console.log(`  （虚拟显示器也在这份列表里，所以判定的是"命中任意一块"而不是"等于第一条"）`)
} else {
  console.log('  ⚠️ WMI 读不到物理分辨率，本轮跳过 raw vs 物理 的对比（宁可少验，不误报）')
}

// 上行形状：真跑 QqBotClient（只换掉 fetch，请求体逐字核对）
const calls = []
const bot = new QqBotClient({
  appId: 'app', clientSecret: 'secret',
  fetchImpl: async (url, init) => {
    calls.push({ url, init })
    const body = calls.length === 1
      ? { file_uuid: 'u1', file_info: 'FILEINFO', ttl: 600 }
      : { id: 'ROBOT1.0_x', timestamp: 't', ext_info: { ref_idx: 'REF' } }
    return { status: 200, text: async () => JSON.stringify(body) }
  },
})
bot._token = 'TOK'
bot._tokenExpireAt = Date.now() + 3600 * 1000

const up = await bot.uploadC2CFile('OPENID', cap.buffer.toString('base64'))
check('上传地址 /v2/users/{openId}/files', calls[0].url, 'https://api.bot.qq.com/v2/users/OPENID/files')
const upBody = JSON.parse(calls[0].init.body)
check('上传体 file_type=1 / srv_send_msg=false（只上传不发送）', upBody.file_type === 1 && upBody.srv_send_msg === false, true)
check('上传体 file_data 就是刚才那张 JPEG 的 base64', upBody.file_data, cap.buffer.toString('base64'))

const sent = await bot.sendC2CImage('OPENID', up.file_info, { msgId: 'MSGID', msgSeq: 1 })
check('发图地址 /v2/users/{openId}/messages', calls[1].url, 'https://api.bot.qq.com/v2/users/OPENID/messages')
const sBody = JSON.parse(calls[1].init.body)
check('发图 msy_type=7 + media.file_info 透传', sBody.msg_type === 7 && sBody.media.file_info === 'FILEINFO', true)
check('content 必须是单个空格（空串平台会拒）', sBody.content, ' ')
check('带 msg_id/msg_seq 走被动回复', sBody.msg_id === 'MSGID' && sBody.msg_seq === 1, true)
check('返回值透出 ref_idx（供引用回复路由用）', sent?.ext_info?.ref_idx, 'REF')

// ── 四、两个开关真的存得住（v0.8.4） ────────────────────────────────────────
// 这一节复现的正是主人报的故障：点「QQ 提醒 / 协作模式」没反应，永远显示已开。
// 桌面版拒绝第三方 namespace 写入（settings-rejected），插件必须自己落盘；
// 而且**写失败绝不能被掩盖成 ok:true**（旧代码把 configView 的 ok:true 铺在错误对象后面，
// 前端于是把"被拒绝"当成功，开关弹回原位、用户看不到任何报错）。
// 这里真跑安装目录里的 overrides.js + config-api.js，不看源码字面。
console.log('\n── 四、QQ 提醒 / 协作模式：开关写失败不掩盖、且真的落盘 ──')
if (!existsSync(DIR + 'overrides.js')) {
  console.log('❌ 安装目录里没有 lib/overrides.js')
  console.log('   ⇒ 这次安装的产物**不含**「开关点位存不住」这个修复，需要重新 pack + install')
  console.log('\n>>> 有问题 ❌')
  process.exit(1)
}
const api = await import(pathToFileURL(DIR + 'config-api.js').href)
const ov = await import(pathToFileURL(DIR + 'overrides.js').href)

check('安装目录导出了 overrides.js 的 persistConfigPatch', typeof ov.persistConfigPatch === 'function', true)
check('安装目录导出了 filterPatch / readOverrides', typeof ov.filterPatch === 'function' && typeof ov.readOverrides === 'function', true)
check('安装目录导出了 mountConfigApi', typeof api.mountConfigApi === 'function', true)

const KEYS = new Set(['qqEnabled', 'qqNotifyEnabled', 'collabEnabled', 'hubUrl'])
const DESKTOP_REJECTION = 'No configurable plugin entry "dsh-remote-qqbot"'
const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-verify-persist-'))
const storeFile = path.join(tmp, ov.OVERRIDE_FILE_NAME)

// 4.1 原生写入被桌面版拒绝时，必须落到插件自有的覆盖文件
const r1 = await ov.persistConfigPatch({
  patch: { collabEnabled: false },
  nativeUpdate: async () => { throw new Error(DESKTOP_REJECTION) },
  file: storeFile,
  current: {},
})
check('原生写入被拒 → via 落到 override-file', r1.via, 'override-file')
check('原生写入被拒 → nativeError 里留着桌面版原文', String(r1.nativeError).includes(DESKTOP_REJECTION), true)
check('覆盖文件真的写出来了', existsSync(storeFile), true)
check('覆盖文件里就是刚才那个值', ov.readOverrides(storeFile, KEYS).values.collabEnabled, false)

// 4.2 整条路由真跑（mock 只有 DSH 的 settings 服务与 node 的 req/res）
const boot = (update, file) => {
  let handler
  let uiOverrides = ov.readOverrides(file, KEYS).values
  const settings = { describe: () => [], update }
  const ctx = {
    inject(deps, cb) {
      cb({
        get: (name) => (name === 'settings' ? settings : undefined),
        webServer: { register: (opts) => { handler = opts.handler } },
        webRuntime: { trustedHosts: [] },
      })
    },
    effect: (fn) => fn(),
  }
  const persist = async (patch, expectedRevision) => {
    const result = await ov.persistConfigPatch({
      patch: ov.filterPatch(patch, KEYS),
      expectedRevision,
      nativeUpdate: (next, revision) => settings.update('dsh-remote-qqbot', next, revision),
      file,
      current: uiOverrides,
    })
    if (result.via === 'override-file') uiOverrides = result.values
    return result
  }
  api.mountConfigApi(ctx, {
    ns: 'dsh-remote-qqbot',
    log: () => {},
    getLiveConfig: () => ({ ...uiOverrides }),
    persist,
  })
  return { handler, overrides: () => uiOverrides }
}
const req = (method, url, body) => {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method, url, headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (text !== '') yield Buffer.from(text, 'utf8') },
  }
}
const callRoute = async (handler, method, url, body) => {
  const res = { status: 0, body: undefined, writeHead(s) { res.status = s }, end(t) { res.body = JSON.parse(t) } }
  await handler(req(method, url, body), res)
  return res
}

const route = boot(async () => { throw new Error(DESKTOP_REJECTION) }, storeFile)
const setRes = await callRoute(route.handler, 'POST', '/remote-qqbot/api/config.set', { patch: { collabEnabled: true } })
check('桌面版拒绝写入时，路由仍报 ok:true（因为已经落到覆盖文件）', setRes.body.ok, true)
check('路由回执里 via = override-file（事后可查走了哪条路）', setRes.body.via, 'override-file')
check('回执里的值已是新值', setRes.body.values.collabEnabled, true)
const getRes = await callRoute(route.handler, 'GET', '/remote-qqbot/api/config.get')
check('重新读一遍：界面看到的就是刚写进去的值（开关不再弹回）', getRes.body.values.collabEnabled, true)

// 4.3 写失败必须暴露（旧代码把它掩盖成 ok:true —— 这就是"点了没用"的直接原因）
const blocker = path.join(tmp, 'blocker')
writeFileSync(blocker, 'x', 'utf8')
const badRoute = boot(async () => { throw new Error(DESKTOP_REJECTION) }, path.join(blocker, 'sub', 'o.json'))
const failRes = await callRoute(badRoute.handler, 'POST', '/remote-qqbot/api/config.set', { patch: { collabEnabled: false } })
check('★ 落盘失败时 ok 必须是 false（不许被 configView 的 ok:true 掩盖）', failRes.body.ok, false)
check('★ 失败时带 error.code = settings-rejected', failRes.body.error?.code, 'settings-rejected')
check('★ 失败原因说人话（含「写入覆盖文件失败」）', /写入覆盖文件失败/.test(String(failRes.body.error?.message)), true)

// 4.4 secret 仍不回显明文
const secRes = await callRoute(route.handler, 'POST', '/remote-qqbot/api/config.set', { patch: { qqClientSecret: 'super-secret' } })
const after = await callRoute(route.handler, 'GET', '/remote-qqbot/api/config.get')
check('secret 字段只回报空串（明文绝不出现在正文里）',
  after.body.values.qqClientSecret === '' && !JSON.stringify(after.body).includes('super-secret'), true)

rmSync(tmp, { recursive: true, force: true })
check('临时覆盖文件已清理（不留下探针残渣）', existsSync(tmp), false)

// ── 五、QQ 菜单「会话」：挑一个会话说话（v0.8.5） ────────────────────────────
// 主人 2026-10-03：「我希望在机器人菜单栏这里可以选择最近的六条会话进行对话」。
// 这里直接 import 安装目录产物跑真函数，三条要害各一条断言。
console.log('\n── 五、挑会话（/sessions）与「当前会话」指针 ──')
const { formatSessionPickerText, isPickerFresh, routeMessage, PICKER_DEFAULT_COUNT } = mod
for (const [n, f] of Object.entries({ formatSessionPickerText, isPickerFresh, routeMessage })) {
  check(`安装目录导出了 ${n}`, typeof f, 'function')
}
check('默认列 6 条（主人要的条数）', PICKER_DEFAULT_COUNT, 6)

const pickSix = Array.from({ length: 6 }, (_, i) => ({
  id: `s${i + 1}`,
  title: `会话${i + 1}`,
  project: 'agenttool',
  turns: 3,
  running: i === 0,
  updatedAt: Date.now() - i * 60000,
}))
const pickText = formatSessionPickerText({ sessions: pickSix })
check('列表出现「最近在聊的 6 个会话」', pickText.includes('最近在聊的 6 个会话'), true)
check('编号是 1..6（回数字才能对得上）',
  [1, 2, 3, 4, 5, 6].every((i) => pickText.split('\n').some((l) => l.startsWith(`${i}. `))), true)
check('列表里说明「回 0 = 不指定」', pickText.includes('回 0 = 不指定'), true)
check('列表里说明「引用通知仍然优先」', pickText.includes('引用我某条通知'), true)

const digit = (opts) => routeMessage({ text: '3', refIdx: '', refTarget: null, ...opts })
// ⚠️ 这三条（下同）2026-10-07 被**改过两次期望**，别再改回去：
//    第一次是「没看过名单就拦下来问一句」（stray_number）；当天主人明确要求
//    「只要我不引用信息、前面也不带 /，就是闲聊，**无论任何情况**」—— 于是三条抢消息的规则
//    （有提问在等就自动当作答 / 刚看过名单的裸数字就是选择 / 别的裸数字拦下来问）全删，
//    裸数字现在**一律闲聊**。作答与选名单改成显式：引用那条提问，或点按钮
//    （提问按钮发 `/answer N`、名单按钮发 `/pick N` `/open N` `/use N`）。
//    所以这里断言的是"它必须是 chat"，而不是以前那种"必须被某条规则接管"。
check('刚看过名单 + 回「3」→ 仍然是闲聊（数字不再自己"认领"名单）',
  digit({ hasPendingQuestion: false, pickerActive: true }).kind, 'chat')
check('★ 有提问在等 + 回「3」→ 仍然是闲聊（作答得引用提问或点按钮）',
  digit({ hasPendingQuestion: true, pickerActive: true }).kind, 'chat')
check('★ 没看过名单 + 回「3」→ 闲聊（1.0.24 删掉了"拦下来问一句"）',
  digit({ hasPendingQuestion: false, pickerActive: false }).kind, 'chat')
check('★ 光秃秃的数字绝不当成派活正文（它是闲聊，不是派活内容）',
  digit({ hasPendingQuestion: false, pickerActive: false, workspacePickerActive: false }).kind === 'chat', true)
check('/sessions → 列名单', routeMessage({ text: '/sessions', refIdx: '', hasPendingQuestion: false, refTarget: null }).kind, 'sessions')
check('/use 2 → 切到第 2 个', routeMessage({ text: '/use 2', refIdx: '', hasPendingQuestion: false, refTarget: null }).index, 2)
check('名单有效期：刚发的算有效', isPickerFresh({ pickerAt: Date.now() - 1000, pickerIds: ['a'] }), true)
check('名单失效：一小时前发的不算', isPickerFresh({ pickerAt: Date.now() - 3600 * 1000, pickerIds: ['a'] }), false)
check('/status 里能看到「你说的话现在进哪儿」',
  formatStatusText({ channelOn: true, sessions: pickSix, activeId: 's2' }).includes('你说的话现在进'), true)

// ── 五之二、派活第二步：在工作区里挑会话 / 开新对话（1.0.19）────────────────
// 主人 2026-10-07：「我不仅需要挑工作区，还需要在工作区里挑选会话或者新对话」。
console.log('\n── 五之二、派活第二步（工作区里挑会话 / 开新对话） ──')
const { routeIncoming, formatTaskSessionPickerText, formatTaskSessionPickAck, buildNumberButtons, makeCmdButton } = mod
check('/open 2 → 选本工作区第 2 个会话', routeIncoming('/open 2').kind, 'pick_task_session')
check('/open 0 → 也是这条路（0 = 新对话）', routeIncoming('/open 0').index, 0)
check('/new → 开新对话', routeIncoming('/new').kind, 'new_task_session')
check('★ /open 与 /use 不是一回事（作用域不同）',
  routeIncoming('/open 2').kind !== routeIncoming('/use 2').kind, true)
const taskKb = buildNumberButtons('/open ', 6, { extra: [makeCmdButton('新对话', '/new')] })
check('第二步的按钮：6 个数字两行 + 「新对话」一行',
  taskKb.content.rows.length === 3 && taskKb.content.rows[2].buttons[0].render_data.label === '新对话', true)
check('★ 数字按钮点出来真的能选（不是画着好看）',
  routeIncoming(taskKb.content.rows[0].buttons[0].action.data).kind === 'pick_task_session', true)
check('「新对话」按钮点出来真的能开', routeIncoming(taskKb.content.rows[2].buttons[0].action.data).kind, 'new_task_session')
check('第二步的名单写清了「回 0 = 开新对话」',
  formatTaskSessionPickerText({ cwd: 'D:/a', name: 'a', sessions: pickSix }).includes('回 0 = 在这个工作区开一个新对话'), true)
check('★ 不知道哪个工作区时不猜目录（让你先发 /task）',
  formatTaskSessionPickAck('no-workspace').includes('先发 /task'), true)
check('★ 没有会话名单时不拿此刻的列表顶上',
  formatTaskSessionPickAck('no-list').includes('先发 /task'), true)
// 裸数字在第二步（工作区挑会话）同样不再自己认领：选择只能来自按钮（`/open N`）或显式指令。
// （按钮那条路由由上一条断言钉住：`taskKb` 按钮的 data 走 routeIncoming → pick_task_session。）
check('第二步的裸数字也是闲聊（只有按钮 / 显式 `/open N` 才算选择）',
  routeMessage({ text: '2', refIdx: '', hasPendingQuestion: false, refTarget: null, taskSessionPickerActive: true }).kind,
  'chat')

// ── 五之三、新版本提醒（1.0.20）：手动查一次也带两个按钮 + 推送开关在设置里 ──────
// 现场（2026-10-07）：主人知道有 1.0.19，QQ 里却一直没提醒，也没处点「忽略本次 / 立即更新」。
// 根因是**时机**：自动提醒只在"启动时 + 每 qqUpdateCheckHours 小时"发，而 1.0.19 是在
// 启动之后 50 分钟才发布的，默认 6 小时的间隔让提醒排到了 6 小时以后（见 docs/ARCHITECTURE.md 3.6g）。
console.log('\n── 五之三、新版本提醒：手动要一次也带两个按钮（1.0.20） ──')
const upd = await import(pathToFileURL(DIR + 'update.js').href)
const { formatUpdateAvailable } = upd
const { HELP_TEXT, buildUpdateNoticeKeyboard, routeIncoming: route2 } = mod
const notice = formatUpdateAvailable({ latest: '1.0.20', current: '1.0.19' })
check('安装的那份产物里，提醒正文说清了「点按钮」和「发 /update」',
  /按钮/.test(notice) && /\/update/.test(notice), true)
const kb2 = buildUpdateNoticeKeyboard().content.rows.flatMap((r) => r.buttons)
check('提醒底下的两个按钮：忽略本次 / 立即更新',
  kb2.map((b) => b.render_data.label).join('|'), '忽略本次|立即更新')
check('★ 这两个按钮点出来真的能执行',
  route2(kb2[0].action.data).kind === 'update_skip' && route2(kb2[1].action.data).kind === 'update', true)
check('帮助里能查到 `/update check`', HELP_TEXT.includes('/update check'), true)
check('`/update check` 真的走"只查不装"', route2('/update check').check, true)

// handleUpdate 的 checkOnly 分支不是导出函数，这里只能扫**安装产物**的字面
// （行为由 tests/update.test.mjs 的 [7] 组跑形状钉住；这条只确认装进去的字节里有它）。
const rtSrc = readFileSync(DIR + 'qqruntime.js', 'utf8')
const checkOnlyAt = rtSrc.indexOf('if (checkOnly) {')
const checkOnlyBody = checkOnlyAt > 0 ? rtSrc.slice(checkOnlyAt, rtSrc.indexOf('if (updating) {', checkOnlyAt)) : ''
check('★ 装进去的 handleUpdate：checkOnly 分支把带按钮的提醒回给你',
  checkOnlyBody.includes('buildUpdateNoticeKeyboard()'), true)
check('★ 并且记了"这一版已经提醒过"（自动检查不会重复推同一条）',
  checkOnlyBody.includes('state.set({ updateNotified: got.version })'), true)
check('查新版本的默认间隔是 1 小时（DEFAULTS 与 startUpdateCheck 兜底两处）',
  /qqUpdateCheckHours: 1,/.test(readFileSync(DIR + 'index.js', 'utf8'))
    && /\n      : 1\n/.test(rtSrc), true)

// 设置页那张卡：字段表（host 单一真源）+ client 渲染，都要在**安装产物**里。
const pushSpec = (api.FIELD_SPECS ?? []).find((f) => f.key === 'qqNotifyEnabled')
check('★ 安装产物的设置字段表里有「接收 QQ 推送」（qqNotifyEnabled / boolean）',
  pushSpec?.label === '接收 QQ 推送' && pushSpec?.type === 'boolean', true)
check('  说明里写清了它管新版本提醒、关掉后长连接照旧',
  /新版本/.test(pushSpec?.description ?? '') && /长连接/.test(pushSpec?.description ?? ''), true)
const clientSrc = readFileSync(DIR + 'client.js', 'utf8')
check('★ 安装产物的设置页把这张卡渲染在最上面，且分组表里不重复',
  clientSrc.includes("key: 'push-switch'") && clientSrc.includes("field.key !== 'qqNotifyEnabled'"), true)

// ── 六、QQ 答完，DSH 那张提问卡片必须自己收掉（v0.9.1） ──────────────────────
// 主人报的现象：「我用 QQ 机器人把回答带过去之后，DSH 里那张提问卡片还挂着」。
// 根因在框架侧，不在插件：卡片条目在 api-proxy 自己的 pendingQuestions 里，
// **只有它自己的 claimQuestion()** 能删条目并广播 question/resolved
// （三个调用点：respond / request.signal 中止 / teardown）。
// 插件能借的开关就是 request.signal —— UserQuestionService.ask() 把 request **原样透传**给
// provider，api-proxy 会为 request.signal 挂 abort 监听，一旦 abort 就 claimQuestion(pending,'cancelled')。
// 所以 relayAsk 造了一个**影子 signal**：只在真把卡片递到桌面时替代 request.signal，
// QQ 那边答完就 abort 它 —— 卡片在所有客户端上消失，且调用方自己的 signal 一个字没动。
//
// 这条护栏**真跑安装目录里的函数本体**（把 relayAsk 从产物里抠出来，在受控环境里执行），
// 不是正则扫源码 —— 本项目已被「注释里的字面量」骗过三次。
console.log('\n── 六、QQ 答完自动收掉桌面卡片（影子 signal） ──')
const relaySrc = (() => {
  const src = readFileSync(DIR + 'qqruntime.js', 'utf8')
  const header = 'function relayAsk(request, original) {'
  const start = src.indexOf(header)
  if (start === -1) return null
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
})()
check('安装目录的 qqruntime.js 里抠得出 relayAsk', typeof relaySrc === 'string', true)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 跑一遍「兜底卡片已出现 → 随后在 QQ 里作答」：返回卡片那条 signal 的最终状态。 */
const answerAfterCard = async (body) => {
  const outer = new AbortController()
  let cardSignal = null
  let release = null
  const build = new Function('l', 'pendingAsks', 'askViaQq', 'ASK_DESKTOP_FALLBACK_MS', `${body}\nreturn relayAsk`)
  const relay = build(() => {}, new Map(), (request, hooks) => {
    hooks.onDelivered(true, 'ask-verify')
    return new Promise((resolve) => { release = resolve })   // QQ 那边先晾着
  }, 10)
  // ⚠️ 源码里的兜底闹钟是 unref 的（不许吊住 DSH 进程），测试等它时必须自己留一个 ref 的定时器保活
  const keepAlive = setTimeout(() => {}, 300)
  const pending = relay({ questions: [], signal: outer.signal }, (req) => {
    cardSignal = req.signal
    return new Promise(() => {})   // 卡片出现了，但主人没在 DSH 里点
  })
  await sleep(40)
  const appeared = Boolean(cardSignal)
  const isShadow = appeared && cardSignal !== outer.signal
  release('qq-answer')
  const answer = await pending
  clearTimeout(keepAlive)
  return { appeared, isShadow, answer, cardAborted: Boolean(cardSignal && cardSignal.aborted), outerAborted: outer.signal.aborted }
}

if (typeof relaySrc === 'string') {
  const real = await answerAfterCard(relaySrc)
  check('兜底窗口过后卡片真的出现了（场景成立，不是空跑）', real.appeared, true)
  check('递给桌面的不是调用方的 signal（是影子 signal）', real.isShadow, true)
  check('★ QQ 答完 → 影子 signal 被中止（DSH 才会自己收掉卡片）', real.cardAborted, true)
  check('调用方的 signal 没被插件动过（不越权）', real.outerAborted, false)
  check('QQ 的答案仍然赢', real.answer, 'qq-answer')
  // 反向校验：只抠掉**调用点**。
  // ⚠️ `hideDesktopCard()` 这个词也出现在函数声明的名字里（`function hideDesktopCard() {`），
  //    用 String.replace 会把声明改成 `function void 0 {` 直接语法错 —— 必须取最后一处（调用点在声明之后）。
  const callAt = relaySrc.lastIndexOf('hideDesktopCard()')
  check('反向校验的对照组确实改动了产物源码', callAt !== -1, true)
  const broken = callAt === -1 ? relaySrc : relaySrc.slice(0, callAt) + 'void 0' + relaySrc.slice(callAt + 'hideDesktopCard()'.length)
  const rev = broken === relaySrc ? { cardAborted: true } : await answerAfterCard(broken)
  check('反向校验：抠掉调用点后卡片不再被中止（证明上一条不是空断言）', rev.cardAborted, false)
}

if (bad === 0 && exact) console.log('\n>>> 安装目录里的实现行为正确 ✅')
console.log(bad === 0 && exact ? '>>> 每一节全部通过 ✅' : `>>> 有问题 ❌（错 ${bad} 项 / 尺寸不符 ${exact ? 0 : 1} 项）`)
process.exit(bad === 0 && exact ? 0 : 1)
