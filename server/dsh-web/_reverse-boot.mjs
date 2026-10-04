/**
 * 反向校验：证明 verify-account-ui.mjs 的「boot() 没抛异常」这条断言**有牙**。
 *
 * 做法：把 app.js 复制一份，在 boot() 最前面插一句**没有守卫**的坏查找
 * （`$('这个元素根本不存在').onclick = ...`），真实浏览器里这会直接抛 TypeError、
 * 整页 JS 不执行。验收必须因此变红 —— 如果它照样全绿，说明那条断言是空的。
 *
 * 用法：node _reverse-boot.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, 'public', 'app.js'), 'utf8')

// 找 boot() 的入口（app.js 最后那句启动调用），在它前面插一句坏的
const anchor = 'boot()'
const at = src.lastIndexOf(anchor)
if (at < 0) { console.error('找不到 boot() 调用，脚本要改'); process.exit(2) }
const broken = src.slice(0, at)
  + "document.getElementById('这个元素根本不存在').onclick = () => {}\n"
  + src.slice(at)

const tmp = path.join(HERE, '_reverse-boot-app.js')
fs.writeFileSync(tmp, broken, 'utf8')

const r = spawnSync(process.execPath, ['verify-account-ui.mjs'], {
  cwd: HERE, env: { ...process.env, APP_JS: tmp }, encoding: 'utf8',
})
const out = `${r.stdout || ''}${r.stderr || ''}`
fs.unlinkSync(tmp)

const reds = (out.match(/✗/g) || []).length
console.log(out.split('\n').filter((l) => /✗|通过 \/ /.test(l)).join('\n'))
console.log('')
console.log(`注入坏查找后：${reds} 条红（期望 ≥1，且必须包含 boot 抛异常那条）`)
const caughtBoot = /✗ ★ boot\(\) 全程没抛异常/.test(out)
const caughtCards = /✗ ★ 账号页的额度卡/.test(out)
console.log(`  boot 抛异常那条变红：${caughtBoot ? '是' : '否'}`)
console.log(`  空卡片那条也变红：${caughtCards ? '是' : '否'}`)
console.log(caughtBoot && caughtCards ? '\n反向校验通过：断言有牙。' : '\n反向校验失败：断言是空的，得修。')
process.exit(caughtBoot && caughtCards ? 0 : 1)
