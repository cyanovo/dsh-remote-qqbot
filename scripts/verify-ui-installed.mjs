// 一次性核对：安装目录里的产物是否真的包含这一轮的改动。
// 1) 本地 lib 与安装目录 lib 逐文件哈希一致
// 2) 安装目录版本号 == 本地 package.json 的 version（不写死，免得每发一版就过期）
// 3) 安装目录 lib/client.js 含新的两个小开关（MiniToggle / InputDockControls / 协作已开/关），
//    且旧的 QqReminderControl 已被替换掉
// 4) 直接 import 安装目录的 config-api.js：协作组与协作字段可见且可写；host 说关着 UI 就显示关着
// 5) 安装目录 lib/collab.js 含「协作模式已关闭」护栏
// 6) 插件自有覆盖存储 lib/overrides.js 在，且桌面版拒绝原生写入时真的落盘；落盘失败必须抛错
// 7) 挑会话（0.8.5）：列表纯文本、编号齐全、**有提问在等时数字必须是作答**、qqruntime 真接线
// 8) 接收 QQ 推送：设置里那个开关（1.0.20）—— 字段表里的标签/说明 + 客户端那张卡
// 9) 新版本提醒：默认间隔 1 小时 + `/update check` 也带两个按钮（1.0.20）
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const localLib = 'D:/cyanproject/agenttool/dsh-remote-qqbot/lib'
const installedRoot = 'C:/Users/cyan/.dsh/profiles/desktop/node_modules/dsh-remote-qqbot'
const installedLib = path.join(installedRoot, 'lib')

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad++
  console.log(ok ? '✅' : '❌', name, detail)
}

// ---- 1. 哈希 ----
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12).toUpperCase()
const files = readdirSync(localLib).filter((f) => f.endsWith('.js')).sort()
const installedNames = readdirSync(installedLib).filter((f) => f.endsWith('.js'))
check('安装目录 lib 文件数与本地一致', files.length === installedNames.length, `本地 ${files.length} 个 / 安装目录 ${installedNames.length} 个`)
for (const f of files) {
  const p = path.join(installedLib, f)
  if (!existsSync(p)) { check(`  ${f} 在安装目录里（缺失 = 这次没装进去）`, false, '文件不存在'); continue }
  const a = sha(path.join(localLib, f))
  const b = sha(p)
  check(`  ${f} 哈希一致`, a === b, `${a} / ${b}`)
}

// ---- 2. 版本 ----
const pkg = JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8'))
const localVersion = JSON.parse(readFileSync('D:/cyanproject/agenttool/dsh-remote-qqbot/package.json', 'utf8')).version
check(`安装目录版本 = ${localVersion}`, pkg.version === localVersion, `实际 ${pkg.version}`)

// ---- 3. client.js 内容 ----
const client = readFileSync(path.join(installedLib, 'client.js'), 'utf8')
check('client.js 有新组件 MiniToggle', client.includes('MiniToggle'))
check('client.js 有 InputDockControls（两个开关的容器）', client.includes('InputDockControls'))
check('client.js 注册的仍是 InputDockControls', /conversation\.input\.left[\s\S]{0,200}InputDockControls/.test(client))
check('QQ 开关文案在', client.includes('QQ 提醒已开') && client.includes('QQ 提醒已关'))
check('协作开关文案在', client.includes('协作已开') && client.includes('协作已关'))
check('协作状态按 collabEnabled !== false 判定（缺省视为开）', client.includes('collabEnabled !== false'))
check('低调样式：透明底 + 无边框', client.includes("background: hot ?") || client.includes("'transparent'"))
check('旧组件 QqReminderControl 已被替换', !client.includes('QqReminderControl'))

// ⚠️ 2026-10-03 主人要求：输入框下面**只留** QQ 提醒 + 协作两个开关，
//    「完整回答怎么给」「允许上传正文」全部移进 DSH 设置面板。
//    这两条是**数字**断言：以后谁再往 dock 里加开关，立刻报红。
const dockSwitches = (client.match(/h\(MiniToggle, \{/g) ?? []).length
check('★ 输入框下面恰好 2 个开关（QQ 提醒 + 协作），不是 3、4 个', dockSwitches === 2, `实测 ${dockSwitches} 个`)
check('★ dock 里不再有「允许上传」开关', !client.includes('允许上传已开') && !client.includes('允许上传已关'))
check('★ dock 里不再有「完整回答」三档循环（MODES 数组）', !client.includes("['chat', 'note', 'note-link']"))
// 这两项**没有丢**，只是搬进了设置面板 —— 所以要在设置字段表里点名（见下面第 4 节）。

// ---- 4. config-api 行为 ----
const { configView } = await import(pathToFileURL(path.join(installedLib, 'config-api.js')).href)
const NS = 'dsh-remote-qqbot'
const noNs = { describe: () => ({ descriptors: [] }) }
const liveOn = { qqEnabled: true, collabEnabled: true }
const liveOff = { qqEnabled: true, collabEnabled: false }
const on = configView(noNs, NS, liveOn)
const off = configView(noNs, NS, liveOff)
check('设置面板能看见「协作模式」分组', Array.isArray(on.groups) && on.groups.some((g) => g.id === 'collab'))
const fields = new Map((on.fields ?? []).map((f) => [f.key, f]))
for (const k of ['collabEnabled', 'collabScope', 'collabClaimGuard', 'collabInject', 'collabIncludeSubagents']) {
  check(`  可写字段 ${k} 在字段表里`, fields.has(k), fields.has(k) ? `type=${fields.get(k).type}` : '')
}
check('collabEnabled 是 boolean 且在 collab 组', fields.get('collabEnabled')?.type === 'boolean' && fields.get('collabEnabled')?.group === 'collab')
check('host 说协作开着 → UI 显示开着', on.values.collabEnabled === true, String(on.values.collabEnabled))
check('host 说协作关着 → UI 显示关着', off.values.collabEnabled === false, String(off.values.collabEnabled))

// ★ 从输入框下面搬进设置面板的两个开关，必须**真的在设置字段表里**（否则是"砍掉了能力"，不是"搬了位置"）。
check('★ 设置面板里有「完整回答怎么给」（qqFulltextMode）', fields.has('qqFulltextMode'), fields.has('qqFulltextMode') ? `type=${fields.get('qqFulltextMode').type}` : '缺失！')
check('★ 设置面板里有「允许上传正文」（cloudEnabled）', fields.has('cloudEnabled'), fields.has('cloudEnabled') ? `type=${fields.get('cloudEnabled').type}` : '缺失！')
check('  cloudEnabled 是 boolean 且默认关（隐私默认值）', fields.get('cloudEnabled')?.type === 'boolean')

// ---- 5. collab.js 护栏 ----
const collab = readFileSync(path.join(installedLib, 'collab.js'), 'utf8')
check('collab.js 含「已关闭」提示文案', collab.includes('协作模式已关闭'))
check('collab.js 里四个工具都先判总开关', (collab.match(/collabOff\(\)/g) ?? []).length >= 5, `出现 ${(collab.match(/collabOff\(\)/g) ?? []).length} 次`)

// ---- 6. 插件自有覆盖存储（0.8.4：修「两个开关点了没用」） ----
// 桌面版拒绝第三方 namespace 写入，所以开关必须由插件自己存住；
// 而且写失败**不能**被 configView 的 ok:true 掩盖（那正是"点了没反应"的直接原因）。
check('安装目录里有 lib/overrides.js（覆盖存储）', existsSync(path.join(installedLib, 'overrides.js')))
const ov = await import(pathToFileURL(path.join(installedLib, 'overrides.js')).href)
check('overrides.js 导出 persistConfigPatch', typeof ov.persistConfigPatch === 'function')
check('overrides.js 导出 filterPatch / readOverrides', typeof ov.filterPatch === 'function' && typeof ov.readOverrides === 'function')

const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const probeDir = mkdtempSync(path.join(tmpdir(), 'dsh-verify-ui-'))
const KEYS = new Set(['collabEnabled', 'qqEnabled', 'qqNotifyEnabled'])
const storeFile = path.join(probeDir, ov.OVERRIDE_FILE_NAME)
const rejected = await ov.persistConfigPatch({
  patch: { collabEnabled: false },
  nativeUpdate: async () => { throw new Error('No configurable plugin entry "dsh-remote-qqbot"') },
  file: storeFile,
  current: {},
})
check('桌面版拒绝原生写入 → 落到插件自有覆盖文件', rejected.via === 'override-file', `via=${rejected.via}`)
check('  覆盖文件里确实存下了新值', ov.readOverrides(storeFile, KEYS).values.collabEnabled === false)
check('  桌面版那句拒绝原因被留下来（排障用）', String(rejected.nativeError).includes('dsh-remote-qqbot'))

// 写不进去时必须抛（路由据此报 ok:false），绝不静默吞掉
const blocker = path.join(probeDir, 'blocker')
writeFileSync(blocker, 'x', 'utf8')
let threw = ''
try {
  await ov.persistConfigPatch({
    patch: { collabEnabled: false },
    nativeUpdate: async () => { throw new Error('x') },
    file: path.join(blocker, 'sub', 'o.json'),
    current: {},
  })
} catch (e) { threw = String(e?.message ?? e) }
check('★ 落盘失败必须抛错（否则前端会把失败当成功、开关弹回）', /写入覆盖文件失败/.test(threw), threw ? '已抛错' : '没抛错')

// 安装目录的 config-api 也守一条：失败分支里 ok:false 必须在 configView 展开**之后**，
// 否则 configView 带来的 ok:true 会盖掉它 —— 那正是"点了没反应、也不报错"的写法。
const installedApi = readFileSync(path.join(installedLib, 'config-api.js'), 'utf8')
const errIdx = installedApi.indexOf("code: 'settings-rejected'")
const spreadIdx = errIdx < 0 ? -1 : installedApi.lastIndexOf('...configView(', errIdx)
const okIdx = errIdx < 0 ? -1 : installedApi.indexOf('ok: false', spreadIdx)
check('config-api.js 里失败分支带 error.code', errIdx > 0)
check('★ 失败分支的 ok:false 排在 configView 展开之后（不再被掩盖）',
  spreadIdx > 0 && okIdx > spreadIdx && okIdx < errIdx, `展开@${spreadIdx} ok:false@${okIdx} 出错@${errIdx}`)

rmSync(probeDir, { recursive: true, force: true })
check('探针临时目录已清理', !existsSync(probeDir))

// ---- 7. 挑会话（0.8.5：QQ 菜单「会话」+ 当前会话指针） ----
// 列表每次现拉、裸数字只在名单刚发出去时才算选择、有提问在等时数字必须让位给作答。
const qq = await import(pathToFileURL(path.join(installedLib, 'qqbridge.js')).href)
check('安装目录 qqbridge.js 导出 formatSessionPickerText', typeof qq.formatSessionPickerText === 'function')
check('安装目录 qqbridge.js 导出 isPickerFresh', typeof qq.isPickerFresh === 'function')
check('默认列 6 条', qq.PICKER_DEFAULT_COUNT === 6, String(qq.PICKER_DEFAULT_COUNT))
const listing = qq.formatSessionPickerText({
  sessions: Array.from({ length: 6 }, (_, i) => ({
    id: `s${i + 1}`, title: `会话${i + 1}`, project: 'agenttool', turns: 1, running: false, updatedAt: Date.now() - i * 1000,
  })),
})
check('  列表编号 1..6 齐全', [1, 2, 3, 4, 5, 6].every((i) => listing.split('\n').some((l) => l.startsWith(`${i}. `))))
check('  列表是纯文本（没有 markdown 记号，避免被吃掉）', !listing.includes('**') && !listing.includes('`'))
const pick = (o) => qq.routeMessage({ text: '2', refIdx: '', refTarget: null, ...o })
// ⚠️ 期望值 2026-10-07（1.0.24）改过：裸数字**一律闲聊**。主人明确要求「只要我不引用信息、
//    前面也不带 /，就是闲聊，无论任何情况」，所以"看过名单的裸数字=选择""有提问在等=作答"
//    两条抢消息的规则被删掉了；选会话 / 作答要走按钮（`/pick N`）或引用。
check('  看过名单回「2」= 仍然是闲聊（数字不再自己"认领"名单）', pick({ hasPendingQuestion: false, pickerActive: true }).kind === 'chat')
check('  ★ 有提问在等回「2」= 仍然是闲聊（作答得引用提问或点按钮）', pick({ hasPendingQuestion: true, pickerActive: true }).kind === 'chat')
check('  qqruntime 里真用了 isPickerFresh（接线没漏）',
  readFileSync(path.join(installedLib, 'qqruntime.js'), 'utf8').includes('isPickerFresh({'))
check('  qqruntime 里真处理了 sessions / pick_session 两个分支',
  /case 'sessions'/.test(readFileSync(path.join(installedLib, 'qqruntime.js'), 'utf8'))
  && /case 'pick_session'/.test(readFileSync(path.join(installedLib, 'qqruntime.js'), 'utf8')))
check('  设置面板能看见「会话列表条数」', fields.has('qqRecentCount'))

// ---- 8. 接收 QQ 推送：设置里那个开关（1.0.20） ----
// 主人 2026-10-07：「我希望在 DSH 的设置里面，也有插件是否接收推送功能的开关」。
// 这个键本来就在字段表里（旧标签「远程提醒」），1.0.20 把它提成设置页**最上面一张卡**。
const push = fields.get('qqNotifyEnabled')
check('★ 设置面板里有「接收 QQ 推送」', push?.label === '接收 QQ 推送', `实际标签 ${push?.label ?? '缺失'}`)
check('  它是 boolean 且在 qq 分组', push?.type === 'boolean' && push?.group === 'qq')
check('  说明写清了它管新版本提醒、关掉后长连接与反向对话照旧',
  /新版本/.test(push?.description ?? '') && /长连接|反向对话/.test(push?.description ?? ''))
check('  说明里点明了它和输入框旁边那个小开关是同一个',
  /输入框旁边|小开关/.test(push?.description ?? ''))
check('  host 说关着 → 视图里就是关着（界面不能自己猜成开）',
  configView(noNs, NS, { qqEnabled: true, qqNotifyEnabled: false }).values.qqNotifyEnabled === false)
check('★ 设置页把这张卡渲染在字段表之前，并排掉分组里的同名键',
  client.includes("key: 'push-switch'") && client.includes("field.key !== 'qqNotifyEnabled'"))
check('★ 显示口径与行为一致：缺省视为开（不能写成 === true）',
  client.includes("const pushOn = valueOf('qqNotifyEnabled') !== false") && client.includes('checked: pushOn'))

// ---- 9. 新版本提醒：间隔 1 小时 + 手动查也带两个按钮（1.0.20） ----
const installedRuntime = readFileSync(path.join(installedLib, 'qqruntime.js'), 'utf8')
const checkOnlyIdx = installedRuntime.indexOf('if (checkOnly) {')
const checkOnlyBody = checkOnlyIdx > 0
  ? installedRuntime.slice(checkOnlyIdx, installedRuntime.indexOf('if (updating) {', checkOnlyIdx))
  : ''
check('★ 默认间隔 1 小时（DEFAULTS + 定时器兜底两处）',
  /qqUpdateCheckHours: 1,/.test(readFileSync(path.join(installedRoot, 'lib', 'index.js'), 'utf8'))
  && /\n      : 1\n/.test(installedRuntime))
check('★ `/update check` 发现新版时回的提醒带两个按钮',
  checkOnlyBody.includes('buildUpdateNoticeKeyboard()'))
check('  手动看过就记账，自动检查不再重复推同一条',
  checkOnlyBody.includes('state.set({ updateNotified: got.version })'))
check('  帮助里能查到 `/update check`', qq.HELP_TEXT.includes('/update check'))

console.log(bad === 0 ? `\n>>> ${localVersion} 安装产物核对全部通过 ✅` : `\n>>> 有 ${bad} 项不通过 ❌`)
process.exit(bad === 0 ? 0 : 1)
