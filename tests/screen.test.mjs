/**
 * 屏幕截图（QQ 菜单「屏幕」）离线自测 —— **不抓真屏、不发真请求**。
 *
 * 主人 2026-10-02 的要求：*"有时候不方便远控，可以在机器人下边的菜单加一个屏幕按钮吗，
 * 点一下就是给我发一张电脑的截图"*。
 *
 * 这一组守五件事：
 *   1. 抓屏命令**真的组得对**（Windows 走 powershell + 脚本文件，Linux 必须明确失败）；
 *   2. 抓屏脚本里**不许出现会被 Windows Defender 的 AMSI 拦下的构造**
 *      （`GetImageEncoders` / `EncoderParameter` —— 2026-10-02 实测，见 `src/screenshot.js` 文件头）；
 *   2.5 临时目录里的脚本与图片**无论成败都被删掉**（截图是隐私，这条不许回归）；
 *   3. `/screen` 及其同义词真的路由到 `{kind:'screen'}`，且**引用截图**不会被
 *      误判成"引用某次通知"；
 *   4. 图片上行/下发两个接口的 body 形状与实测抓包逐字一致
 *      （`msg_type:7`、`content` 必须是一个空格、`file_data` 走 base64）。
 *
 * 设计纪律：**跑函数验行为，不正则扫源码**。
 * 只有最后第 [7] 节守的是源码字面（`liveConfig()` 在 `src/index.js` 内部、不导出，
 * 行为测试代价过高），且那几条断言在把它改坏之后必然报红。
 *
 * 跑法：node tests/screen.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  SHOT_MAX_WIDTH, SHOT_TIMEOUT_MS,
  buildPowerShellScript, captureCommand, captureScreen, isAvBlocked, parseRawOutput, parseShotOutput,
} from '../src/screenshot.js'
import { HELP_TEXT, routeIncoming, routeMessage } from '../src/qqbridge.js'
import { QqBotClient } from '../src/qqbot.js'

let pass = 0
let fail = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✅ ${name}`)
  } catch (err) {
    fail += 1
    failures.push({ name, err })
    console.log(`  ❌ ${name}\n     ${err?.message ?? err}`)
  }
}

/** 当前系统 temp 里还没被删掉的 dsh-shot-* 目录（用于断言"现场已清理"）。 */
function leftoverShotDirs(root = os.tmpdir()) {
  return fs.readdirSync(root).filter((n) => n.startsWith('dsh-shot-'))
}

/** 从 `captureCommand` 的 args 里取 `-Out <path>` 的值（win32）。 */
function outArg(args) {
  const i = args.indexOf('-Out')
  return i >= 0 ? args[i + 1] : args[args.length - 1]
}

/** 一段**真实**的脚本 stdout（2026-10-02 本机跑 work/shot.ps1 抓到的原文形状）。 */
const REAL_OK_LINE = 'OK 1440x900 -> C:\\Users\\cyan\\AppData\\Local\\Temp\\dsh-shot-ab12cd\\screen.jpg'

console.log('\n[1] buildPowerShellScript —— 抓屏脚本是纯函数，能直接断言')

await t('默认限宽写进 param() 默认值', () => {
  const s = buildPowerShellScript()
  assert.match(s, new RegExp(`\\[int\\]\\$MaxWidth = ${SHOT_MAX_WIDTH}\\b`), '默认限宽必须进脚本')
})

await t('自定义限宽被真实插值（不是残留占位符）', () => {
  const s = buildPowerShellScript({ maxWidth: 800 })
  assert.match(s, /\[int\]\$MaxWidth = 800\b/)
  assert.ok(!s.includes('undefined'), '脚本里不许出现 undefined（参数漏传的经典指纹）')
  assert.ok(!s.includes('NaN'), '脚本里不许出现 NaN')
})

await t('抓的是整个虚拟桌面（多屏合成）而不是主屏', () => {
  const s = buildPowerShellScript()
  assert.match(s, /SystemInformation\]::VirtualScreen/, '必须用 VirtualScreen，否则双屏会截不全')
  assert.match(s, /CopyFromScreen/, '必须真抓屏')
  assert.match(s, /\$b\.X, \$b\.Y/, '虚拟桌面原点可能不是 0,0，必须带上偏移')
})

// ★ 本组最重要的一条。2026-10-02 实测：抓屏脚本里只要出现「枚举/构造 JPEG 编码器参数」，
//   Windows Defender 的 AMSI 就会把**整份脚本**判定为恶意内容并拦下
//   （`ScriptContainedMaliciousContent`），而且报错位置指向第 1 行注释，极具误导性。
//   二分表格见 src/screenshot.js 文件头。这条断言就是那次事故的墓碑。
await t('★ 脚本不含任何会被 AMSI 拦下的构造（抓屏 + 编码器参数 = 恶意脚本特征）', () => {
  const s = buildPowerShellScript()
  assert.ok(!/GetImageEncoders/.test(s), 'GetImageEncoders 与抓屏同现会被 Defender 拦')
  assert.ok(!/EncoderParameter/.test(s), 'EncoderParameters/EncoderParameter 与抓屏同现会被 Defender 拦')
  assert.ok(!/ImageCodecInfo/.test(s), '不要碰编码器枚举那一族 API')
  assert.ok(!/-Quality/.test(s), '命令行里也不许再传 -Quality（参数没了，留着只会误导）')
})

await t('存的是 JPEG，且走的是 ImageFormat::Jpeg 这条不会被拦的重载', () => {
  const s = buildPowerShellScript({ maxWidth: 800 })
  assert.match(s, /\$target\.Save\(\$Out, \[System\.Drawing\.Imaging\.ImageFormat\]::Jpeg\)/,
    '必须是 ImageFormat::Jpeg 直接存 —— 这是绕开 AMSI 的唯一写法')
  assert.match(s, /HighQualityBicubic/, '缩小时用高质量插值，否则字会糊')
})

await t('缩放是"条件触发"：MaxWidth 为 0 时不缩放', () => {
  const s = buildPowerShellScript({ maxWidth: 0 })
  assert.match(s, /\$MaxWidth -gt 0 -and \$b\.Width -gt \$MaxWidth/, '必须同时判 MaxWidth>0 与超宽')
})

await t('脚本全是 ASCII（杜绝 BOM / 本地代码页把脚本写坏）', () => {
  const s = buildPowerShellScript()
  assert.ok(/^[\x00-\x7F]*$/.test(s), `脚本里出现了非 ASCII 字符：${s.match(/[^\x00-\x7F]/g)?.join('')}`)
})

// ★ 本组第二重要的一条。2026-10-02 主人实测：截图只有屏幕左上角一块。
//   根因是 DPI 虚拟化——非 DPI 感知的 powershell.exe 看到的是「虚拟化桌面」
//   （2880x1800 的屏、200% 缩放 ⇒ 它只看到 1440x900），而 CopyFromScreen 却按物理像素 1:1 拷贝，
//   于是存下来的图恰好是真实桌面的左上四分之一。像素级证据见 src/screenshot.js 文件头。
//   **顺序就是全部**：必须先在 VirtualScreen 之前认领 DPI 感知。这条断言钉的就是这个顺序。
await t('★ 认领 DPI 感知必须早于读 VirtualScreen（顺序反了 = 截图只剩左上角）', () => {
  const s = buildPowerShellScript()
  const iDpi = s.indexOf('SetProcessDPIAware')
  const iVs = s.indexOf('SystemInformation]::VirtualScreen')
  assert.ok(iDpi >= 0, '脚本必须调用 SetProcessDPIAware，否则 200% 缩放下只能截到左上四分之一')
  assert.ok(iVs >= 0, '必须读 VirtualScreen（上一条测试已覆盖）')
  assert.ok(iDpi < iVs,
    `SetProcessDPIAware 的下标(${iDpi}) 必须小于 VirtualScreen 的下标(${iVs}) —— 这就是那个 bug 的全部`)
  assert.match(s, /\[DllImport\("user32\.dll"\)\]\s*public static extern bool SetProcessDPIAware\(\)/,
    '必须是 user32.dll 的 SetProcessDPIAware（.NET Framework 没有 Application.SetHighDpiMode）')
})

await t('脚本回执里额外打印缩放前的物理尺寸 RAW WxH（供上层核对有没有被虚拟化）', () => {
  const s = buildPowerShellScript()
  assert.match(s, /Write-Output \("RAW \{0\}x\{1\}" -f \$rawW, \$rawH\)/,
    'RAW 行是"抓屏尺寸对不对"的唯一自证，缺了就只剩眼睛可依赖')
  // RAW 必须在保存之后才打印（此时 $target 已定稿），且缩放分支不能改掉 $b.Width。
  assert.ok(s.indexOf('$rawW = $b.Width') < s.indexOf('RAW {0}x{1}'), 'RAW 取值必须早于打印')
  assert.ok(s.indexOf('$rawW = $b.Width') > s.indexOf('CopyFromScreen'), 'RAW 取的必须是抓屏之后的虚拟桌面尺寸')
})

console.log('\n[2] parseShotOutput —— 解析脚本回执，拿不到也不能崩')

await t('真实回执行：宽/高/路径三个都解析出来', () => {
  const r = parseShotOutput(REAL_OK_LINE)
  assert.deepEqual(r, {
    width: 1440,
    height: 900,
    path: 'C:\\Users\\cyan\\AppData\\Local\\Temp\\dsh-shot-ab12cd\\screen.jpg',
  })
})

await t('末尾带换行/回车也能解析（PowerShell 一定带换行）', () => {
  assert.equal(parseShotOutput(`${REAL_OK_LINE}\r\n`)?.width, 1440)
  assert.equal(parseShotOutput(`\n${REAL_OK_LINE}`)?.height, 900)
})

await t('路径里有空格也不会被截断', () => {
  const r = parseShotOutput('OK 2560x1440 -> C:\\Users\\cy an\\My Shots\\a b.jpg')
  assert.equal(r?.path, 'C:\\Users\\cy an\\My Shots\\a b.jpg')
})

await t('垃圾输入一律返回 null（不抛错、不返回半个对象）', () => {
  for (const bad of ['', '   ', 'ERROR: 抓屏失败', 'OK 1440 -> x.jpg', 'OK axb -> x.jpg', null, undefined]) {
    assert.equal(parseShotOutput(bad), null, `输入 ${JSON.stringify(bad)} 应为 null`)
  }
})

console.log('\n[2b] parseRawOutput —— 缩放前的物理尺寸（判"有没有被 DPI 虚拟化"的唯一自证）')

await t('真实回执：RAW 行解析出抓屏瞬间的物理尺寸', () => {
  const stdout = `${REAL_OK_LINE}\r\nRAW 2880x1800\r\n`
  assert.deepEqual(parseRawOutput(stdout), { width: 2880, height: 1800 })
})

await t('RAW 行缺失（旧版脚本）返回 null，不抛错、不瞎猜', () => {
  for (const bad of [REAL_OK_LINE, '', null, undefined, 'RAW ?', 'RAW 2880x', 'RAW 2880']) {
    assert.equal(parseRawOutput(bad), null, `输入 ${JSON.stringify(bad)} 应为 null`)
  }
})

await t('RAW 与 OK 同时存在时各取各的（缩放后 1600x1000 / 缩放前 2880x1800 不串味）', () => {
  const stdout = 'OK 1600x1000 -> C:\\t\\s.jpg\nRAW 2880x1800\n'
  assert.equal(parseShotOutput(stdout)?.width, 1600)
  assert.equal(parseRawOutput(stdout)?.width, 2880)
})

console.log('\n[3] captureCommand —— 平台差异只在这一处')

await t('win32：powershell.exe + 脚本文件 + 具名参数，顺序固定', () => {
  const cmd = captureCommand({ platform: 'win32', script: 'C:\\t\\shot.ps1', out: 'C:\\t\\s.jpg' })
  assert.equal(cmd.file, 'powershell.exe')
  assert.deepEqual(cmd.args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\t\\shot.ps1'])
  assert.equal(cmd.args[cmd.args.indexOf('-Out') + 1], 'C:\\t\\s.jpg')
  assert.equal(cmd.args[cmd.args.indexOf('-MaxWidth') + 1], String(SHOT_MAX_WIDTH))
  assert.ok(!cmd.args.includes('-Quality'), '-Quality 随 qqScreenQuality 一起废除，不许再传')
  // -NonInteractive 不能少：抓屏脚本若弹交互框，桌面版进程会永久挂住。
  assert.ok(cmd.args.includes('-NonInteractive'), '必须 -NonInteractive，否则可能卡住等输入')
})

await t('win32：限宽被取整成整数（PowerShell 的 [int] 不接受小数）', () => {
  const cmd = captureCommand({ platform: 'win32', script: 's.ps1', out: 'o.jpg', maxWidth: 1600.4 })
  assert.equal(cmd.args[cmd.args.indexOf('-MaxWidth') + 1], '1600')
  // 只查这个数值参数：脚本路径 `s.ps1` / 图片路径 `o.jpg` 本来就带点，不能一起查。
  const v = cmd.args[cmd.args.indexOf('-MaxWidth') + 1]
  assert.ok(/^\d+$/.test(v), `-MaxWidth 的值必须是纯整数，实际是 ${v}`)
})

await t('darwin：screencapture（⚠️ 未在 mac 上验证过，但参数组合必须稳定）', () => {
  const cmd = captureCommand({ platform: 'darwin', script: '/tmp/shot.ps1', out: '/tmp/s.jpg' })
  assert.equal(cmd.file, 'screencapture')
  assert.deepEqual(cmd.args, ['-x', '-t', 'jpg', '/tmp/s.jpg'])
})

await t('linux/其他：返回 null（故意不支持，不假装成功）', () => {
  for (const p of ['linux', 'freebsd', 'aix', '', null]) {
    assert.equal(captureCommand({ platform: p, script: 's', out: 'o' }), null, `${p} 应返回 null`)
  }
})

console.log('\n[4] captureScreen —— 注入执行器跑真流程（含隐私清理）')

await t('成功路径：拿到字节 + 尺寸，且原样透传超时', async () => {
  let sawTimeout = null
  let sawFile = null
  const shot = await captureScreen({
    platform: 'win32',
    run: async (file, args, { timeoutMs }) => {
      sawFile = file
      sawTimeout = timeoutMs
      fs.writeFileSync(outArg(args), Buffer.alloc(4321, 7))
      return REAL_OK_LINE
    },
  })
  assert.equal(sawFile, 'powershell.exe')
  assert.equal(sawTimeout, SHOT_TIMEOUT_MS)
  assert.equal(shot.bytes, 4321)
  assert.equal(shot.buffer.length, 4321)
  assert.equal(shot.width, 1440)
  assert.equal(shot.height, 900)
  assert.equal(shot.rawWidth, null, '旧脚本没有 RAW 行 ⇒ rawWidth 必须是 null，不能拿缩放尺寸冒充')
  assert.equal(shot.rawHeight, null)
  assert.ok(Number.isFinite(shot.ms) && shot.ms >= 0, '耗时必须是数字')
})

await t('★ 新脚本：rawWidth/rawHeight 是缩放前的物理尺寸（真被虚拟化时这里会露馅）', async () => {
  const shot = await captureScreen({
    platform: 'win32',
    run: async (file, args) => {
      fs.writeFileSync(outArg(args), Buffer.alloc(2048, 3))
      return `${REAL_OK_LINE}\r\nRAW 2880x1800\r\n`
    },
  })
  // OK 行说的是"缩放后"（也是老脚本的口径），RAW 行才是抓屏当时的真实桌面尺寸。
  assert.equal(shot.width, 1440)
  assert.equal(shot.rawWidth, 2880)
  assert.equal(shot.rawHeight, 1800)
  assert.notEqual(shot.rawWidth, shot.width, '这两者必须能区分，否则这个字段就没有意义')
})

await t('成功路径跑完后：临时目录（脚本 + 图片）已被删除', async () => {
  const before = leftoverShotDirs().length
  let outPath = null
  await captureScreen({
    platform: 'win32',
    run: async (file, args) => {
      outPath = outArg(args)
      fs.writeFileSync(outPath, Buffer.alloc(64, 1))
      return REAL_OK_LINE
    },
  })
  assert.ok(outPath, '应当拿到输出路径')
  assert.equal(fs.existsSync(outPath), false, '截图文件必须被删掉（隐私）')
  assert.equal(fs.existsSync(path.dirname(outPath)), false, '临时目录必须被整个删掉')
  assert.equal(leftoverShotDirs().length, before, '不许留下 dsh-shot-* 残留目录')
})

await t('脚本文件真的写进了临时目录（win32 用 -File，不做 -Command 字符串）', async () => {
  let scriptPath = null
  let scriptBody = null
  await captureScreen({
    platform: 'win32',
    run: async (file, args) => {
      const i = args.indexOf('-File')
      scriptPath = args[i + 1]
      scriptBody = fs.readFileSync(scriptPath, 'utf8')
      fs.writeFileSync(outArg(args), Buffer.alloc(32, 2))
      return REAL_OK_LINE
    },
  })
  assert.ok(scriptPath.endsWith('shot.ps1'), `脚本路径应为 shot.ps1，实际 ${scriptPath}`)
  assert.match(scriptBody, /CopyFromScreen/, '执行前脚本内容必须已经落盘且完整')
})

await t('自定义 maxWidth 走到脚本与命令行两项里', async () => {
  let body = null
  let args = null
  await captureScreen({
    platform: 'win32',
    maxWidth: 640,
    run: async (file, a) => {
      args = a
      body = fs.readFileSync(a[a.indexOf('-File') + 1], 'utf8')
      fs.writeFileSync(outArg(a), Buffer.alloc(16, 3))
      return REAL_OK_LINE
    },
  })
  assert.match(body, /\[int\]\$MaxWidth = 640\b/)
  assert.equal(args[args.indexOf('-MaxWidth') + 1], '640')
  assert.ok(!args.includes('-Quality'), '命令行不该再带 -Quality')
})

// ★ AMSI 拦截必须被翻译成人话：主人手机上看到的不能是一串英文 ParserError。
await t('★ 被 Defender/AMSI 拦下时：报 BLOCKED_BY_AV，并给出中文放行办法', async () => {
  const before = leftoverShotDirs().length
  const blocked = new Error(
    'Command failed: powershell.exe -File shot.ps1\n'
    + 'ParserError: (:) [], ParentContainsErrorRecordException\n'
    + 'This script contains malicious content and has been blocked by your antivirus software.\n'
    + 'FullyQualifiedErrorId : ScriptContainedMaliciousContent',
  )
  await assert.rejects(
    () => captureScreen({ platform: 'win32', run: async () => { throw blocked } }),
    (err) => {
      assert.equal(err.code, 'BLOCKED_BY_AV')
      assert.match(err.message, /Defender|杀毒/, '要说清是谁拦的')
      assert.match(err.message, /排除项|实时保护/, '要给放行办法，不能只说失败了')
      assert.ok(!/FullyQualifiedErrorId/.test(err.message), '不要把英文报错原样甩给用户')
      assert.equal(err.cause, blocked, '原始错误挂在 cause 上，方便日志排查')
      return true
    },
  )
  assert.equal(leftoverShotDirs().length, before, '被拦也要清掉临时目录')
})

await t('isAvBlocked：认得 Defender 的几种说法，且不误伤普通报错', () => {
  assert.equal(isAvBlocked('FullyQualifiedErrorId : ScriptContainedMaliciousContent'), true)
  assert.equal(isAvBlocked('This script contains malicious content and has been blocked by your antivirus software.'), true)
  assert.equal(isAvBlocked('操作已被防病毒软件阻止'), true)
  assert.equal(isAvBlocked('Command failed: powershell.exe'), false)
  assert.equal(isAvBlocked(''), false)
  assert.equal(isAvBlocked(undefined), false)
  assert.equal(isAvBlocked(null), false)
})

await t('maxWidth=0（不限宽）透传成 -MaxWidth 0，而不是被换成默认值', async () => {
  let args = null
  await captureScreen({
    platform: 'win32',
    maxWidth: 0,
    run: async (file, a) => {
      args = a
      fs.writeFileSync(outArg(a), Buffer.alloc(16, 4))
      return REAL_OK_LINE
    },
  })
  assert.equal(args[args.indexOf('-MaxWidth') + 1], '0', '0 = 明确表示不缩放')
})

await t('不支持的平台：报 UNSUPPORTED_PLATFORM，且临时目录照样被清掉', async () => {
  const before = leftoverShotDirs().length
  await assert.rejects(
    () => captureScreen({ platform: 'linux', run: async () => { throw new Error('不该被调用') } }),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_PLATFORM')
      assert.match(err.message, /linux/, '报错要说清是哪台机器')
      return true
    },
  )
  assert.equal(leftoverShotDirs().length, before, '失败路径也不许留残留')
})

await t('抓屏命令失败：原样抛出，同时清掉临时目录', async () => {
  const before = leftoverShotDirs().length
  const boom = new Error('powershell 挂了｜some stderr')
  await assert.rejects(
    () => captureScreen({ platform: 'win32', run: async () => { throw boom } }),
    (err) => err === boom,
  )
  assert.equal(leftoverShotDirs().length, before, '失败路径也不许留残留')
})

await t('命令跑完但没生成文件：报 NO_OUTPUT（不返回空字节假装成功）', async () => {
  const before = leftoverShotDirs().length
  await assert.rejects(
    () => captureScreen({ platform: 'win32', run: async () => REAL_OK_LINE }),
    (err) => {
      assert.equal(err.code, 'NO_OUTPUT')
      return true
    },
  )
  assert.equal(leftoverShotDirs().length, before)
})

await t('生成了一个空文件：报 EMPTY_OUTPUT', async () => {
  const before = leftoverShotDirs().length
  await assert.rejects(
    () => captureScreen({
      platform: 'win32',
      run: async (file, args) => {
        fs.writeFileSync(outArg(args), Buffer.alloc(0))
        return REAL_OK_LINE
      },
    }),
    (err) => {
      assert.equal(err.code, 'EMPTY_OUTPUT')
      return true
    },
  )
  assert.equal(leftoverShotDirs().length, before)
})

await t('回执解析不出来时，字节照给、尺寸为 null（不因解析失败丢掉图）', async () => {
  const shot = await captureScreen({
    platform: 'win32',
    run: async (file, args) => {
      fs.writeFileSync(outArg(args), Buffer.alloc(99, 5))
      return '有些无关的输出\n（没有 OK 行）'
    },
  })
  assert.equal(shot.bytes, 99)
  assert.equal(shot.width, null)
  assert.equal(shot.height, null)
})

console.log('\n[5] 入站路由 —— 菜单点「屏幕」= 发一条 /screen 过来')

await t('/screen 与全部同义词都路由到 screen', () => {
  for (const cmd of ['/screen', '/screenshot', '/shot', '/截图', '/屏幕']) {
    assert.deepEqual(routeIncoming(cmd), { kind: 'screen' }, `${cmd} 应路由到 screen`)
  }
})

await t('大小写/多余空白也认（手机输入法会自动首字母大写）', () => {
  assert.equal(routeIncoming('/SCREEN').kind, 'screen')
  assert.equal(routeIncoming('  /Screen  ').kind, 'screen')
})

await t('不许过度匹配：/scre 仍是未知指令，/status 仍是 status', () => {
  assert.equal(routeIncoming('/scre').kind, 'unknown')
  assert.equal(routeIncoming('/status').kind, 'status', '加 screen 不能碰坏 status')
  assert.equal(routeIncoming('截图').kind, 'task', '不带斜杠的"截图"是派活，不是截图')
})

await t('截图指令不吃参数：后面跟的字被安静忽略（不报错、不串到别的分支）', () => {
  // 记录真实行为：/screen 没有参数，解析器把尾巴切掉后指令名照旧是 screen。
  assert.deepEqual(routeIncoming('/screen 2'), { kind: 'screen' })
  assert.deepEqual(routeIncoming('/屏幕 现在'), { kind: 'screen' })
})

await t('引用我发的截图：走 screen_ref（不塞进任何会话）', () => {
  const r = routeMessage({ text: '这是啥', refIdx: 'r1', refTarget: { kind: 'screen' } })
  assert.equal(r.kind, 'screen_ref')
  assert.equal(r.text, '这是啥')
})

await t('截图 ref 上**同时**带 sessionId 时，也必须优先判成 screen_ref', () => {
  // 这是真的踩点：addSentRef 若哪天顺手带上 sessionId，就会掉进"引用通知"分支，
  // 把一句闲聊塞进某个工作会话里。截图不属于任何会话。
  const r = routeMessage({
    text: '看看这个',
    refIdx: 'r2',
    refTarget: { kind: 'screen', sessionId: 'session-abc' },
  })
  assert.equal(r.kind, 'screen_ref', 'kind=screen 必须先于 sessionId 判定')
  assert.equal(r.sessionId, undefined)
})

await t('引用提问/通知的既有分支未被影响', () => {
  const q = routeMessage({
    text: '1',
    refIdx: 'r3',
    hasPendingQuestion: true,
    refTarget: { kind: 'question', sessionId: 'session-a', askId: 'ask-1' },
  })
  assert.equal(q.kind, 'answer')
  assert.equal(q.askId, 'ask-1')

  const p = routeMessage({ text: '干活', refIdx: 'r4', refTarget: { kind: 'notice', sessionId: 'session-b' } })
  assert.equal(p.kind, 'prompt')
  assert.equal(p.sessionId, 'session-b')

  const u = routeMessage({ text: '嗯', refIdx: 'r5', refTarget: null })
  assert.equal(u.kind, 'unknown_ref')
})

await t('/screen 走完整 routeMessage 也是 screen（显式指令优先级最高）', () => {
  assert.equal(routeMessage({ text: '/screen' }).kind, 'screen')
  assert.equal(routeMessage({ text: '/屏幕' }).kind, 'screen')
})

await t('帮助文案里列出了 /screen（用户得知道有这个按钮）', () => {
  assert.match(HELP_TEXT, /\/screen/, '/help 里必须有 /screen')
  // 光有指令名不够，得让人知道它是干什么的（真实文案：/screen      给我截一张你电脑的屏幕）
  assert.match(HELP_TEXT, /\/screen\s+\S*.*(截|屏幕)/, '/screen 那行要说清是"截图/看屏幕"')
})

console.log('\n[6] QQ 图片上行/下发 —— body 形状与实测抓包逐字一致')

/**
 * 造一个只走内存的 QqBotClient：fetch 被替换掉，token 直接预置（跳过换 token 那一跳）。
 * @param {Array<{status?: number, body: object}>} responses - 依次返回的响应。
 * @returns {{bot: QqBotClient, calls: Array<{url: string, init: object}>}}
 */
function fakeBot(responses) {
  const calls = []
  const bot = new QqBotClient({
    appId: 'app', clientSecret: 'secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      const r = responses.shift()
      if (!r) throw new Error('fakeBot: 没有预备更多响应了')
      return { status: r.status ?? 200, text: async () => JSON.stringify(r.body) }
    },
  })
  // 预置 token，免得先去打 getAppAccessToken
  bot._token = 'TOK'
  bot._tokenExpireAt = Date.now() + 3600 * 1000
  return { bot, calls }
}

await t('uploadC2CFile：POST /v2/users/{openId}/files，只上传不发送', async () => {
  const { bot, calls } = fakeBot([{ body: { file_uuid: 'u1', file_info: 'FI', ttl: 600 } }])
  const data = await bot.uploadC2CFile('OPENID', 'QUJD')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.bot.qq.com/v2/users/OPENID/files')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'QQBot TOK')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    file_type: 1,
    srv_send_msg: false, // 关键：只上传，发送另走 messages 才能带 msg_id 做被动回复
    file_data: 'QUJD',
  })
  assert.equal(data.file_info, 'FI')
})

await t('uploadC2CFile：openId 被 URL 编码（openId 里出现怪字符也不会拼坏路径）', async () => {
  const { bot, calls } = fakeBot([{ body: { file_info: 'FI' } }])
  await bot.uploadC2CFile('a/b c', 'x')
  assert.equal(calls[0].url, 'https://api.bot.qq.com/v2/users/a%2Fb%20c/files')
})

await t('uploadC2CFile：fileType 可换（2=视频 3=语音 4=文件）', async () => {
  const { bot, calls } = fakeBot([{ body: { file_info: 'FI' } }])
  await bot.uploadC2CFile('O', 'x', { fileType: 2 })
  assert.equal(JSON.parse(calls[0].init.body).file_type, 2)
})

await t('uploadC2CFile：没有 file_info 就抛带 code 的错，绝不返回半成品', async () => {
  const { bot } = fakeBot([{ status: 200, body: { code: 40034, message: '文件太大' } }])
  await assert.rejects(
    () => bot.uploadC2CFile('O', 'x'),
    (err) => {
      assert.equal(err.code, 40034)
      assert.match(err.message, /上传图片失败 code=40034/)
      assert.match(err.message, /文件太大/, '要把平台的原始说明带出来')
      return true
    },
  )
})

await t('uploadC2CFile：HTTP 非 2xx 但 body 里没有 code 时，用 HTTP 状态码兜底', async () => {
  const { bot } = fakeBot([{ status: 502, body: {} }])
  await assert.rejects(() => bot.uploadC2CFile('O', 'x'), (err) => {
    assert.equal(err.code, 502)
    return true
  })
})

await t('sendC2CImage：msg_type=7 + content 恰好一个空格 + media.file_info', async () => {
  const { bot, calls } = fakeBot([{ body: { id: 'ROBOT1.0_x', timestamp: 't', ext_info: { ref_idx: 'REF' } } }])
  const res = await bot.sendC2CImage('OPENID', 'FI', { msgId: 'M1', msgSeq: 1 })
  assert.equal(calls[0].url, 'https://api.bot.qq.com/v2/users/OPENID/messages')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.msg_type, 7)
  // 实测：content 传 '' 会被平台判参数错误；这个空格不会显示出来。这条断言防止有人"顺手清空"。
  assert.equal(body.content, ' ')
  assert.equal(body.content.length, 1, "content 必须是**一个空格**，不能是空串")
  assert.deepEqual(body.media, { file_info: 'FI' })
  assert.equal(body.msg_id, 'M1')
  assert.equal(body.msg_seq, 1)
  assert.equal(res.ext_info.ref_idx, 'REF', 'ref_idx 要被带回来（引用这张图时靠它反查）')
})

await t('sendC2CImage：给了 msgId 但没给 msgSeq 时补 1（被动回复必须带序号）', async () => {
  const { bot, calls } = fakeBot([{ body: { id: 'x' } }])
  await bot.sendC2CImage('O', 'FI', { msgId: 'M9' })
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.msg_id, 'M9')
  assert.equal(body.msg_seq, 1)
})

await t('sendC2CImage：没有 msgId 且 isWakeup → 走主动消息字段', async () => {
  const { bot, calls } = fakeBot([{ body: { id: 'x' } }])
  await bot.sendC2CImage('O', 'FI', { isWakeup: true })
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.is_wakeup, true)
  assert.equal(body.msg_id, undefined)
})

await t('sendC2CImage：两个都不传 → 不带任何回复字段（干净 body）', async () => {
  const { bot, calls } = fakeBot([{ body: { id: 'x' } }])
  await bot.sendC2CImage('O', 'FI')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(Object.keys(body).sort(), ['content', 'media', 'msg_type'])
})

await t('sendC2CImage：失败也抛带 code 的错（供上层翻译成中文提示）', async () => {
  const { bot } = fakeBot([{ status: 200, body: { code: 40034005, message: 'msg_id 过期' } }])
  await assert.rejects(() => bot.sendC2CImage('O', 'FI', { msgId: 'M' }), (err) => {
    assert.equal(err.code, 40034005)
    return true
  })
})

await t('explainError 能把这些码翻译成人话（用户看到的不是数字）', () => {
  assert.match(QqBotClient.explainError(40034005), /过期|60 分钟/)
  assert.match(QqBotClient.explainError(40034100), /频控|超频/)
})

console.log('\n[7] 配置接线（源码字面护栏，附反向校验说明）')

const indexSrc = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
const runtimeSrc = fs.readFileSync(new URL('../src/qqruntime.js', import.meta.url), 'utf8')

// ⚠️ 这一节守的是**源码字面**，不是行为 —— liveConfig() 在 src/index.js 内部不导出，
// 要用真 ctx 驱动它得复制一大坨 mock。之所以还能接受：两条键任意一条被删/被改名，
// 下面必然报红（已实测：把 qqScreenEnabled 改名后这几条全红）。
await t('src/index.js：两个截图配置键在 DEFAULTS 里有默认值', () => {
  assert.match(indexSrc, /qqScreenEnabled:\s*true/, '默认允许截图（主人要的就是点一下就有图）')
  assert.match(indexSrc, /qqScreenMaxWidth:\s*\d+/, '限宽要有数字默认值')
})

await t('src/index.js：qqScreenQuality 已作为配置键删除（留个点了没用的开关比没有更糟）', () => {
  // 只断言"作为配置键"的形态（后面跟冒号）—— DEFAULTS 上方的说明注释里还会提到这个名字，
  // 那是给人看的改动原因，不该被这条护栏误伤。（量具被注释骗过一次，这次先绕开。）
  assert.ok(!/qqScreenQuality\s*:/.test(indexSrc), 'DEFAULTS / schema / liveConfig 里都不该再有这个键')
})

await t('src/index.js：两个键进了 settings schema（否则设置面板里看不到、改不了）', () => {
  assert.match(indexSrc, /qqScreenEnabled:\s*z\.boolean\(\)/)
  assert.match(indexSrc, /qqScreenMaxWidth:\s*z\.number\(\)/)
})

await t('src/index.js：liveConfig 会归一化这两个键（关掉判定是 !== false）', () => {
  assert.match(indexSrc, /qqScreenEnabled:\s*merged\.qqScreenEnabled !== false/,
    '缺省视为开；只有明确 false 才算关')
  // 归一化写成了多行三元表达式，所以这里要跨行匹配（别用 [^\n]*，会漏）。
  assert.match(indexSrc, /qqScreenMaxWidth:[\s\S]{0,240}?Math\.floor/,
    '限宽要取整（0 是有意义的：不缩放）')
})

await t('src/qqruntime.js：/screen 有独立的处理函数，并在路由里被调用', () => {
  assert.match(runtimeSrc, /async function handleScreen\(data\)/, '必须有 handleScreen')
  assert.match(runtimeSrc, /case 'screen':\s*\n\s*await handleScreen\(data\)/, 'switch 里必须真的调用它')
  assert.match(runtimeSrc, /import \{ captureScreen \} from '\.\/screenshot\.js'/, '必须 import 抓屏实现')
})

await t('src/qqruntime.js：关掉截图时给出"去哪儿打开"的提示，而不是静默失败', () => {
  assert.match(runtimeSrc, /qqScreenEnabled === false/, '必须判关')
  assert.match(runtimeSrc, /设置 → QQ 提醒与记忆/, '要告诉用户去哪儿打开')
})

console.log(`\n${fail === 0 ? '✅' : '❌'} screen 组：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  for (const f of failures) console.log(`\n--- ${f.name}\n${f.err?.stack ?? f.err}`)
}
process.exit(fail === 0 ? 0 : 1)
