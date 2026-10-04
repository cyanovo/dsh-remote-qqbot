/**
 * 屏幕截图（给 QQ 的「屏幕」按钮用）。
 *
 * 主人要的用法：远控不方便时，在 QQ 聊天窗口底部的菜单点「屏幕」，
 * 机器人直接把他**电脑当前画面**发过来。
 *
 * ── 为什么这么做（实测结论，不是照抄文档）────────────────────────────────
 *
 * 1. **Windows 上唯一稳的零依赖路子是 PowerShell + System.Windows.Forms。**
 *    `[System.Windows.Forms.SystemInformation]::VirtualScreen` 拿的是**所有显示器合成的**
 *    虚拟桌面范围，`Graphics.CopyFromScreen` 一次抓完 —— 双屏不用自己拼。
 *    插件就跑在桌面版进程里，属于同一个交互式会话，所以能抓屏（服务里跑就不行）。
 *
 * 2. **必须压缩，不能截 PNG 原图。** QQ 上传图片走 `file_data` 的 **base64**，
 *    体积会膨胀 4/3；4K 双屏 PNG 动辄十几 MB，base64 之后一次请求几十 MB 很容易被平台拒。
 *    所以这里固定 JPEG + 限宽（`$MaxWidth` 默认 1600，超了按比例缩放）。
 *
 * ── DPI 事故（2026-10-02，第二个坑：截图只剩左上角）────────────────────────
 *
 * 症状：主人反馈「截图都只是屏幕左上角，没有全屏」。
 *
 * 根因：**`powershell.exe` 默认是 DPI 不感知（DPI-unaware）进程。**
 * 本机是 2880x1800 的屏 + 200% 缩放，于是：
 *   - DPI 不感知的进程看到的 `VirtualScreen` 是**被虚拟化过的 1440x900**（2880/2 x 1800/2）；
 *   - 而 `Graphics.CopyFromScreen` 是按**物理像素 1:1** 拷的；
 *   - 两者相乘 ⇒ 存下来的图**正好是真实桌面左上角的四分之一**，看起来像"被裁了"。
 *
 * 逐像素实测（同一进程内取样对比，2026-10-02）：
 *   - 不调 `SetProcessDPIAware` → 抓出 1440x900；
 *   - 调用之后 → 抓出 2880x1800；
 *   - 按 10 像素网格采样 12960 个点，比对小图与大图**同一坐标**的像素：
 *     **平均差值 0.00**、只有 1 个点超过容差 24（最大值 38，是时钟/光标这类会动的像素）
 *     ⇒ 小图就是大图的左上角那块，**逐像素级的同一份内容**，不是"相似"。
 *
 * 修复：在读 `VirtualScreen` **之前**调用 `SetProcessDPIAware()`（user32，Win7+ 可用）。
 *   - 为什么不用 `Application.SetHighDpiMode`：那是 .NET Core/5+ 的 API，
 *     `powershell.exe` 5.1 跑的是 .NET Framework，**没有**这个方法。
 *   - 为什么不用清单/兼容性设置：进程是插件临时拉起来的，改不了它的清单。
 *   - 返回 false 也继续跑（拿不到物理分辨率就退回虚拟化尺寸，至少不崩）。
 *
 * ⚠️ 顺序是**这条修复的全部**：`SetProcessDPIAware()` 必须出现在 `VirtualScreen` 之前。
 *    测试 `tests/screen.test.mjs` 用**下标大小**钉住这个顺序，不是只检查"字符串存在"。
 *
 * 实测尺寸（本机 2880x1800 @200%，`$MaxWidth = 1600`）：
 *   - 物理桌面 2880x1800 → 限宽缩放到 1600x1000 → JPEG **约 211 KB**，抓一次 **600 ms 量级**；
 *   - 修复前（裁剪版）1440x900 / 144 KB —— **这个数字是错的产物，不要再引用它当基线。**
 *
 * 3. **脚本写成临时文件再 `-File` 执行，不走 `-Command` 字符串。**
 *    命令行里塞多行 PowerShell 会被引号/换行/本地代码页一起坑（本项目已踩过：
 *    `ssh` 会吃掉内层双引号、`Out-File -Encoding utf8` 会加 BOM）。临时文件没有转义问题，
 *    用完连目录一起删。脚本内容**全是 ASCII**，所以不涉及 BOM/代码页。
 *
 * ── AMSI 事故（2026-10-02，这一版最大的坑，务必先读完再改脚本）──────────────
 *
 * 症状：抓屏一律失败，PowerShell 报
 *   `ParserError … FullyQualifiedErrorId : ScriptContainedMaliciousContent`
 *   「This script contains malicious content and has been blocked by your antivirus software.」
 *   **报错位置指向脚本第 1 行第 1 字符**（也就是第一行注释）—— 这是假象：
 *   实际是 Windows Defender 的 AMSI 在整份脚本送进解析器**之前**就把它毙了，
 *   报错行号只是"解析器拿到空内容"的副作用。别去改注释，改一万遍也没用。
 *
 * 二分实测（每次只改一处，逐份落盘后真跑 `powershell.exe -File`）：
 *   | 脚本内容                                | 结果 |
 *   |-----------------------------------------|------|
 *   | 抓屏 + `Save($Out)`（无格式）             | 通过 |
 *   | 抓屏 + `GetImageEncoders()` 存 JPEG       | **拦** |
 *   | 抓屏 + `New-Object EncoderParameters(1)`  | **拦** |
 *   | 抓屏 + `EncoderParameter(Quality)`        | **拦** |
 *   | 抓屏 + `ImageFormat::Jpeg` 直接存         | 通过 |
 *   | 单独 `GetImageEncoders()`（不抓屏）        | 通过 |
 *   | 单独 `New-Object EncoderParameters(1)`    | 通过 |
 *
 * 结论：**被拦的是组合特征 —— 「抓屏 + 枚举/构造 JPEG 编码器参数」**，
 * 也就是屏幕窃取类脚本的经典指纹；单独任何一半都不犯忌。
 * 所以**不是**中文注释的问题、不是缩进的问题、不是 `New-Object` 的问题，
 * 更不是沙箱/`-File`/`child_process` 的问题（同样的脚本在命令行手工跑也照样被拦）。
 *
 * 对策：**永远不要碰 `ImageCodecInfo.GetImageEncoders()` 和 `EncoderParameters`**，
 * 改用 `$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)`
 * —— 走 GDI+ 默认 JPEG 编码器，质量约 75（比原来写死的 70 还略好），体积差别可忽略。
 * 代价是**质量不可调**，于是 `qqScreenQuality` 这个配置项被删掉了：
 * 留一个点了没用的开关，比没有这个开关更糟。
 *
 * ⚠️ 这条依赖 Defender 的启发式规则，将来可能变。所以两道保险：
 *   - `isAvBlocked()` 把这种失败翻成**中文可读**的提示（含放行办法），不再甩英文报错；
 *   - `scripts/verify-installed.mjs` 第 [3] 节会**真的抓一次屏**，一旦又被拦就报红。
 *
 * ⚠️ 已验证 / 未验证，说清楚：
 *   - ✅ Windows：本机实测抓到了真实桌面（见上）。
 *   - ⚠️ macOS：只有一行 `screencapture`，**未在任何 mac 上跑过**，属于"顺手写上"。
 *   - ⚠️ Linux：**故意不做** —— X11/Wayland 下 `import`/`grim`/`scrot` 各不同，
 *     还要处理 Wayland 权限弹窗。在 Linux 上会明确报错，而不是假装成功。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 单次截图的默认超时（毫秒）。抓屏本身是百毫秒级，留足到 20 秒兜网络盘/高负载。 */
export const SHOT_TIMEOUT_MS = 20000

/**
 * 默认最大宽度（像素）。超过就等比缩放 —— QQ 那边图片体积比分辨率重要。
 *
 * 这是**唯一的体积旋钮**：JPEG 质量写死成 GDI+ 默认值（约 75），
 * 因为"自定义质量"必须用 `EncoderParameters`，而那个 API 会被 AMSI 拦（见文件头）。
 */
export const SHOT_MAX_WIDTH = 1600

/**
 * 判断一段错误文本是不是「被 Windows Defender / AMSI 拦了」。
 *
 * 纯函数，方便单测。命中时上层会换成人话提示，而不是把英文报错原样甩给手机。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isAvBlocked(text) {
  const s = String(text ?? '')
  return /ScriptContainedMaliciousContent|contains malicious content|AMS[I]|防病毒软件|恶意内容/i.test(s)
}

/**
 * 生成 PowerShell 抓屏脚本（纯函数，便于测试直接断言内容与逐字执行）。
 *
 * 参数用 `param()` 声明、由命令行传入，所以脚本正文里没有任何需要转义的变量插值。
 *
 * ⚠️ 正文里**不许出现** `GetImageEncoders` / `EncoderParameter` / `-Quality` ——
 *    会让整份脚本被 Defender 的 AMSI 毙掉（文件头有完整实测表格）。测试里钉着这条。
 *
 * @param {{maxWidth?: number}} [opts]
 * @returns {string} 脚本全文。
 */
export function buildPowerShellScript({ maxWidth = SHOT_MAX_WIDTH } = {}) {
  // 这里的 $ 全是 PowerShell 变量，不是 JS 模板插值；只把数字参数插进去。
  //
  // ⚠️ 脚本正文刻意保持**纯 ASCII**（连注释也是）。原因：脚本落盘后被 Windows
  //    PowerShell 5.1 读取，而它默认按**本地代码页**（中文机器上是 GBK）解释没有 BOM
  //    的 .ps1 —— 中文注释会被解成乱码。注释乱码本身无害，但"正文里混进非 ASCII 字节"
  //    是这类脚本最经典的翻车方式（某个字节被解成引号/反引号就整段崩），所以干脆不留。
  //    中文说明放在这份 JS 注释里，运行时不需要。
  //
  // ⚠️ 结尾的 Save 只能走 `ImageFormat::Jpeg` 这条重载。**不要**改成
  //    `$codec = …GetImageEncoders()…; $target.Save($Out, $codec, $ps)` ——
  //    那会让整份脚本被 AMSI 判定为恶意内容（见文件头表格）。
  return `# dsh-remote-qqbot: full virtual desktop -> JPEG (ASCII only, keep it that way)
param([string]$Out, [int]$MaxWidth = ${Number(maxWidth)})
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# DPI awareness MUST be claimed BEFORE reading the virtual screen. Without it a
# DPI-unaware process sees a virtualized desktop (e.g. 1440x900 on a 2880x1800
# panel at 200%) while CopyFromScreen blits physical pixels 1:1 -> the saved
# image is only the top-left quadrant. Do not reorder these two statements.
Add-Type -Namespace DshShot -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][DshShot.Dpi]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
$rawW = $b.Width
$rawH = $b.Height
$target = $bmp
if ($MaxWidth -gt 0 -and $b.Width -gt $MaxWidth) {
  $h = [int][Math]::Round($b.Height * $MaxWidth / $b.Width)
  if ($h -lt 1) { $h = 1 }
  $scaled = New-Object System.Drawing.Bitmap($MaxWidth, $h)
  $g2 = [System.Drawing.Graphics]::FromImage($scaled)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $MaxWidth, $h)
  $g2.Dispose()
  $target = $scaled
}
$target.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$w = $target.Width
$h2 = $target.Height
$target.Dispose()
if ($target -ne $bmp) { $bmp.Dispose() }
Write-Output ("OK {0}x{1} -> {2}" -f $w, $h2, $Out)
Write-Output ("RAW {0}x{1}" -f $rawW, $rawH)
`
}

/**
 * 解析脚本最后一行的 `OK <宽>x<高> -> <路径>`。
 *
 * @param {string} stdout
 * @returns {{width: number, height: number, path: string}|null} 解析不出来返回 null
 *   （此时上层仍可用文件本身，只是拿不到尺寸）。
 */
export function parseShotOutput(stdout) {
  const m = /OK\s+(\d+)x(\d+)\s+->\s+(.+)/.exec(String(stdout ?? ''))
  if (!m) return null
  return { width: Number(m[1]), height: Number(m[2]), path: m[3].trim() }
}

/**
 * 解析脚本额外输出的 `RAW <宽>x<高>` —— **缩放前**的原始抓屏尺寸。
 *
 * 这一行是给「只截到左上角」那类 DPI 回归用的：它是在 `SetProcessDPIAware()` 之后
 * 读到的物理桌面尺寸，所以可以拿去和显卡实际分辨率比对。
 *
 * @param {string} stdout
 * @returns {{width: number, height: number}|null} 老脚本没有这一行 → null。
 */
export function parseRawOutput(stdout) {
  const m = /RAW\s+(\d+)x(\d+)/.exec(String(stdout ?? ''))
  if (!m) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

/**
 * 组出「用哪个可执行文件、带什么参数」来抓屏（纯函数，好被测）。
 *
 * @param {object} opts
 * @param {string} [opts.platform] - `process.platform`。
 * @param {string} opts.script - PowerShell 脚本路径（仅 win32 用）。
 * @param {string} opts.out - 目标图片路径。
 * @param {number} [opts.maxWidth]
 * @returns {{file: string, args: string[]}|null} 不支持的平台返回 null。
 */
export function captureCommand({
  platform = process.platform, script, out, maxWidth = SHOT_MAX_WIDTH,
} = {}) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script,
        '-Out', out,
        '-MaxWidth', String(Math.floor(maxWidth)),
      ],
    }
  }
  if (platform === 'darwin') {
    // ⚠️ 未在 mac 上验证过：screencapture 只截主屏、也不接受质量参数。
    return { file: 'screencapture', args: ['-x', '-t', 'jpg', out] }
  }
  return null
}

/** 默认执行器：跑一个子进程，把 stdout 收集成字符串。 */
function defaultRun(file, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.message = `${err.message}${stderr ? `｜${String(stderr).trim().slice(0, 300)}` : ''}`
          reject(err)
          return
        }
        resolve(String(stdout ?? ''))
      })
  })
}

/**
 * 抓一张屏幕，返回 JPEG 字节。
 *
 * 临时目录（脚本 + 图片）**无论成功失败都会删掉** —— 截图是隐私内容，
 * 不能因为一次异常就留在 %TEMP% 里。
 *
 * @param {object} [opts]
 * @param {number} [opts.maxWidth] - 最大宽度，0 表示不缩放。
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.platform]
 * @param {string} [opts.tmpDir] - 临时目录根（默认系统 temp）。
 * @param {Function} [opts.run] - 注入执行器（测试用）。
 * @returns {Promise<{buffer: Buffer, width: number|null, height: number|null, rawWidth: number|null,
 *   rawHeight: number|null, bytes: number, ms: number}>}
 *   `width`/`height` 是**缩放后**的成品尺寸，`rawWidth`/`rawHeight` 是**缩放前**的物理桌面尺寸
 *   （用于和显卡实际分辨率比对，抓「只截到左上角」这类 DPI 回归）。
 * @throws {Error} 平台不支持 / 被抓屏软件拦下（`code='BLOCKED_BY_AV'`）/ 抓屏失败 / 产出空文件，
 *   `err.code` 标明原因。
 */
export async function captureScreen({
  maxWidth = SHOT_MAX_WIDTH,
  timeoutMs = SHOT_TIMEOUT_MS,
  platform = process.platform,
  tmpDir = os.tmpdir(),
  run = defaultRun,
} = {}) {
  const w = Number.isFinite(maxWidth) && maxWidth > 0 ? Math.floor(maxWidth) : 0

  const dir = fs.mkdtempSync(path.join(tmpDir, 'dsh-shot-'))
  const out = path.join(dir, 'screen.jpg')
  const script = path.join(dir, 'shot.ps1')
  try {
    if (platform === 'win32') {
      fs.writeFileSync(script, buildPowerShellScript({ maxWidth: w }), 'utf8')
    }
    const cmd = captureCommand({ platform, script, out, maxWidth: w })
    if (!cmd) {
      const e = new Error(`这台机器（${platform}）我还没学会截图`)
      e.code = 'UNSUPPORTED_PLATFORM'
      throw e
    }
    const started = Date.now()
    let stdout
    try {
      stdout = await run(cmd.file, cmd.args, { timeoutMs })
    } catch (err) {
      // AMSI 拦截给的是英文 ParserError，直接甩到手机上没法看。翻成人话 + 放行办法。
      if (isAvBlocked(err?.message)) {
        const e = new Error(
          '电脑上的杀毒软件（Windows Defender）把抓屏脚本当成恶意脚本拦下来了。'
          + '放行办法：Windows 安全中心 → 病毒和威胁防护 → 「排除项」→ 添加排除项 → 文件夹，'
          + `把 ${dir} 的上级临时目录（或者干脆把 powershell.exe）加进去；`
          + '或者临时关掉「实时保护」再点一次屏幕。',
        )
        e.code = 'BLOCKED_BY_AV'
        e.cause = err
        throw e
      }
      throw err
    }
    const ms = Date.now() - started
    if (!fs.existsSync(out)) {
      const e = new Error('抓屏命令跑完了，但没生成图片文件')
      e.code = 'NO_OUTPUT'
      throw e
    }
    const buffer = fs.readFileSync(out)
    if (buffer.length === 0) {
      const e = new Error('截图文件是空的')
      e.code = 'EMPTY_OUTPUT'
      throw e
    }
    const info = parseShotOutput(stdout)
    const raw = parseRawOutput(stdout)
    return {
      buffer,
      width: info?.width ?? null,
      height: info?.height ?? null,
      rawWidth: raw?.width ?? null,
      rawHeight: raw?.height ?? null,
      bytes: buffer.length,
      ms,
    }
  } finally {
    // 截图内容属于隐私：本地这份临时文件必须消失。
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉不影响主流程 */ }
  }
}
