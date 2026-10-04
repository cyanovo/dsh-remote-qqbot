/**
 * 插件自有的「界面改动落盘」层。
 *
 * ## 为什么需要这个文件（真事故，不是设计洁癖）
 *
 * 2026-10-02 主人报：「点击 QQ 提醒或者协作模式这两个按钮，点了没有用，它们永远保持开启」。
 *
 * 根因有两条，缺一不可：
 *
 * 1. **桌面版写不进去**。UI 走的是本插件自己的路由 `/remote-qqbot/api/config.set`，
 *    路由内部调 `settings.update(ns, patch)`。但桌面版的
 *    `SettingsService.write()`（app.asar 内 subclass）有一道硬门槛：
 *    ```js
 *    const entry = this.ownerContext.configEditor.entries().find(row => row.options.id === ns)
 *    if (entry === undefined || schema === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
 *    const form = volatileForm(schema)
 *    if (form === undefined) throw new Error(`Plugin entry "${ns}" has no volatile fields`)
 *    ```
 *    而本插件的 profile 条目 id 是 `remote-qqbot`（不是 `dsh-remote-qqbot`），
 *    且 `Config` 里**没有任何字段声明 `meta.volatile`** ⇒ 桌面版每次写都抛错。
 *    （实测报错原文：`No configurable plugin entry "dsh-remote-qqbot"`）
 *
 * 2. **路由把这个错误掩盖成了成功**。`config-api.js` 的失败分支写成
 *    `{ ok: false, error, ...configView(...) }` —— 展开在后面，而 `configView` 返回的
 *    `ok: true` 把前面的 `ok: false` **覆盖掉**了。于是浏览器看到 `ok: true`、
 *    以为保存成功、把开关状态重置成服务端返回的旧值 ⇒ **开关弹回原位，且一个字的提示都没有**。
 *
 * ## 为什么不用「给 Config 加 volatile 字段 + 把 ns 改成 remote-qqbot」这条路
 *
 * 那条路要在 app.asar 里翻出 schemastery 标记 volatile 的确切 API
 * （`Config.set('volatile', true)`？`meta.volatile = true`？），改完还得重启一次才知道对不对，
 * 且成功之后**写的是 cordis.patch.yml**（用户每次手工维护的那份），
 * 而桌面版会不会因此重新装配整个插件（进而重连 QQ 长连接）也无法离线确认。
 * 风险与收益不成比例 —— 界面上的两个开关不该拿"插件可能被重挂"去赌。
 *
 * ## 所以：插件自己存自己的
 *
 * 界面改动的值存进 `~/.dsh/remote-qqbot-overrides.json`，由 `liveConfig()` 以**最高优先级**
 * 叠加（DEFAULTS → settings scope → cordis 补丁的显式键 → 本文件）。
 * host 侧每一次都现读 `cfg()`，所以关掉协作/提醒**立刻生效，不需要重启**。
 *
 * 写入仍是「先试 DSH 原生 settings，失败才落本文件」——将来 DSH 若允许第三方命名空间写入，
 * 会自动回到原生路径，这个文件自然不再被使用。
 *
 * ## 边界
 *
 * - 只存**白名单内**的键（`allowedKeys`，由调用方给出，实际就是 `Config` 的键集合）：
 *   文件被手工塞进乱七八糟的键也不会污染配置。
 * - secret 字段同样会落在这里（明文 JSON）。这与现状一致 ——
 *   `cordis.patch.yml` 里的 `qqClientSecret` 本来就是明文。
 * - 读失败（文件不存在 / 半截 JSON / 权限）**一律不抛**：界面显示旧值总好过插件起不来。
 *   写失败**必须抛**：让路由如实报 `ok: false`，用户至少能看到"没存上"。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 文件名（放在 `~/.dsh/` 下，与 `qq-bot-state.json` 同级）。 */
export const OVERRIDE_FILE_NAME = 'remote-qqbot-overrides.json'

/**
 * 覆盖文件的默认路径。
 *
 * 与插件其余部分保持一致：优先 `DSH_HOME`（DSH 自己的家目录变量，测试/多实例用），
 * 否则 `~/.dsh/`。
 */
export function overrideFilePath(dshHome) {
  const home = typeof dshHome === 'string' && dshHome.trim() !== '' ? dshHome.trim() : '.dsh'
  return join(home, OVERRIDE_FILE_NAME)
}

/**
 * 只保留白名单内的键，并丢掉 `undefined`。
 *
 * `undefined` 必须丢：JSON.stringify 会把它吃掉，但内存里若留着，
 * `{ ...base, ...patch }` 这一步就会用一个 undefined 覆盖掉真实值。
 */
export function filterPatch(patch, allowedKeys) {
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys ?? [])
  const out = {}
  if (patch === null || typeof patch !== 'object') return out
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (allowed.size > 0 && !allowed.has(key)) continue
    out[key] = value
  }
  return out
}

/**
 * 读覆盖文件。**任何异常都吞掉**并返回空对象 —— 见文件头「边界」。
 *
 * @returns {{ values: Record<string, unknown>, error: string }}
 */
export function readOverrides(file, allowedKeys) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    // 文件不存在是**正常状态**（还没人从界面改过任何东西），不当成错误。
    const missing = err?.code === 'ENOENT'
    return { values: {}, error: missing ? '' : `读取失败：${String(err?.message ?? err)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { values: {}, error: `不是合法 JSON（已忽略，界面会显示配置文件里的值）：${String(err?.message ?? err)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { values: {}, error: '内容不是对象（已忽略）' }
  }
  return { values: filterPatch(parsed, allowedKeys), error: '' }
}

/**
 * 原子写：先写 `.tmp` 再 rename。
 *
 * 直接 `writeFileSync` 到目标路径的话，**写一半崩掉就得到一份半截 JSON**，
 * 下次启动读不出来 —— 而这份文件正是"用户点过的开关"，丢了就等于开关白点了。
 * 失败一律抛出（调用方要如实报错）。
 */
export function writeOverrides(file, values) {
  const text = `${JSON.stringify(values ?? {}, null, 2)}\n`
  const dir = dirname(file)
  const tmp = `${file}.tmp`
  // ⚠️ `mkdirSync` 也必须在 try 里：父路径被一个**同名文件**占住时抛的是 ENOTDIR/EEXIST，
  // 同样属于"写不进去"。如果只包 writeFile/rename，调用方拿到的会是 Node 的原始错误，
  // 中文提示与 `写入覆盖文件失败` 前缀都没了 —— 界面就只能显示英文 errno。
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 清理失败不影响主错误 */ }
    throw new Error(`写入覆盖文件失败（${file}）：${String(err?.message ?? err)}`)
  }
  return file
}

/** 叠加补丁，返回新对象（不改原对象）。 */
export function applyPatch(values, patch) {
  return { ...(values ?? {}), ...(patch ?? {}) }
}

/**
 * 落盘一条界面改动。
 *
 * 顺序：**先试 DSH 原生 settings**（`nativeUpdate` 存在时），失败才写本插件的覆盖文件。
 * 原生成功时**不写覆盖文件** —— 两条路同时生效会让"到底以谁为准"变成玄学。
 *
 * @param {object}   args
 * @param {object}   args.patch            已过白名单/类型校验的补丁
 * @param {*}        args.expectedRevision 透传给原生 settings（revision 冲突检测用）
 * @param {Function} [args.nativeUpdate]   `(patch, expectedRevision) => Promise<void>`
 * @param {string}   args.file             覆盖文件路径
 * @param {object}   args.current          当前覆盖值（内存里的那一份）
 * @param {Function} [args.onNativeError]  原生失败时的回调（只用来打日志，避免刷屏由调用方控制）
 * @returns {Promise<{ via: 'dsh-settings'|'override-file', values: object, applied: string[], nativeError: string }>}
 */
export async function persistConfigPatch({ patch, expectedRevision, nativeUpdate, file, current, onNativeError } = {}) {
  const applied = Object.keys(patch ?? {})
  let nativeError = ''

  if (typeof nativeUpdate === 'function') {
    try {
      await nativeUpdate(patch, expectedRevision)
      return { via: 'dsh-settings', values: current ?? {}, applied, nativeError: '' }
    } catch (err) {
      nativeError = String(err?.message ?? err)
      // 桌面版**必然**走到这里（见文件头），所以这里不是"异常路径"而是常规路径；
      // 日志由调用方决定打不打（只在第一次打，避免每点一下刷一行）。
      try { onNativeError?.(nativeError) } catch { /* 日志失败不能影响保存 */ }
    }
  }

  const next = applyPatch(current, patch)
  writeOverrides(file, next)
  return { via: 'override-file', values: next, applied, nativeError }
}
