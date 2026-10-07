#!/usr/bin/env node
/**
 * _reverse-docs.mjs —— 「教程文档页」验收脚本的**反向校验**：证明这把尺子有牙。
 *
 * 做法：把 `public/` 拷成一份副本，**每一刀只切一处**（切点必须恰好命中 1 次，否则中止 ——
 * 否则可能拿着一份没改过的文件跑出全绿，然后误以为"校验过了"），
 * 然后 `node verify-docs.mjs --dir <副本>`，要求：
 *   ① 预期会红的那几条**确实红了**（按断言名字精确匹配）
 *   ② exit code == 1（不是 0、也不是 2"脚本自己崩了"）
 *
 * 四刀（每一刀对应本轮修掉的一个真东西）：
 *   A 删掉 <script src="/docs.js">          → 整页根本没渲染
 *   B 去掉启动时的 ensureRendered()          → 点「教程文档」看到的是一块空壳（本轮修的真缺陷）
 *   C scroller() 只认 #scroll               → 目录点击 / 跟随失效（本轮修的真缺陷）
 *   D 去掉"到底了点亮最后一条"                → 读到最后高亮却停在倒数第三条
 *
 * 用法：node _reverse-docs.mjs          退出码 0 = 尺子有牙且全部符合预期
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, 'public')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-docs-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 只切一处：命中数不等于 expect 就抛（防止"切了空气"） */
function cut(file, from, to, expect = 1) {
  const p = path.join(file)
  const s = fs.readFileSync(p, 'utf8')
  const n = s.split(from).length - 1
  if (n !== expect) throw new Error(`切点命中 ${n} 次（期望 ${expect}）：${p}\n  ${from.slice(0, 80)}`)
  fs.writeFileSync(p, s.split(from).join(to), 'utf8')
}

function runVerify(dir) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'verify-docs.mjs'), '--dir', dir], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

const CASES = [
  {
    name: 'A 删掉 <script src="/docs.js">（整页没渲染）',
    expect: ['★ 左栏列出 8 个章节（点进来不能是一块空壳）', '★ 右栏目录有锚点（≥2 条）',
      '★ 正文真的渲染了（h2 ≥ 2 个）', 'window.DOCS 暴露了 8 章'],
    apply: (dir) => cut(path.join(dir, 'index.html'), '<script src="/docs.js"></script>', ''),
  },
  {
    name: 'B 去掉启动时的 ensureRendered()（点导航看到空壳）',
    expect: ['★ 左栏列出 8 个章节（点进来不能是一块空壳）', '★ 右栏目录有锚点（≥2 条）',
      '★ 正文真的渲染了（h2 ≥ 2 个）'],
    apply: (dir) => cut(path.join(dir, 'docs.js'), 'bind(); ensureRendered(); route();', 'bind(); route();', 2),
  },
  {
    name: 'C scroller() 只认 #scroll（目录点击/跟随失效）',
    /* 注意：高亮那两条**不会**红 —— 因为 atBottom 分支（#scroll 的 sh==ch）会把最后一条点亮，
       算是歪打正着。这正好说明"预期是什么"必须实测，不能想当然。 */
    expect: ['滚动位置真的动了（scrollTop > 0）', '★ 点目录后目标标题真的滚进了视野（落在视口上半部）',
      '★ 没到页尾时必须精确顶到容器顶部附近（偏差 ≤ 40px）'],
    apply: (dir) => cut(path.join(dir, 'docs.js'),
      'if (sc && sc.scrollHeight > sc.clientHeight + 1) {', 'if (sc) {'),
  },
  {
    name: 'D 去掉「到底了点亮最后一条」',
    expect: ['滚到底后高亮的是最后一条（跟随生效）'],
    apply: (dir) => cut(path.join(dir, 'docs.js'),
      'if (atBottom) hit = state.headings[state.headings.length - 1].id;', ''),
  },
  /* 2026-10-05 新增两刀：一键安装的复制块 */
  {
    name: 'E 拆掉复制按钮的接线（点了没反应）',
    expect: ['★ 点一下复制按钮，界面上有明确反馈（按钮文案变了，或弹了提示）',
      '反馈是三级兜底里真的落地的那一级（已复制 / 长按选中复制）'],
    apply: (dir) => cut(path.join(dir, 'docs.js'),
      "      const copyBtn = t.closest('.doc-copy-btn');\n"
      + "      if (copyBtn) { ev.preventDefault(); doCopy(copyBtn); return; }\n", ''),
  },
  {
    name: 'F 要复制的那段文字里没有安装命令（复制出去是空话）',
    expect: ['★ 要复制的那段文字里就是 GitHub 安装命令'],
    apply: (dir) => cut(path.join(dir, 'docs.js'),
      "+ 'dsh plugin --profile desktop add github:cyanovo/dsh-remote-qqbot\\n'", ''),
  },
  /* 2026-10-07 新增一刀：第 2 章里的**插件仓库地址**（主人要求官网上要能看到仓库） */
  {
    name: 'G 去掉第 2 章的插件仓库地址（想先看代码的人没地方去）',
    expect: ['★ 第 2 章「从 GitHub 装」里给了插件仓库地址'],
    apply: (dir) => cut(path.join(dir, 'docs.js'),
      "        + '<p>插件仓库：<a href=\"https://github.com/cyanovo/dsh-remote-qqbot\" target=\"_blank\" rel=\"noopener noreferrer\">github.com/cyanovo/dsh-remote-qqbot</a>'\n"
      + "        + '（想先看代码再装、装完想提问题、或想自己改，都从这里进；上面的命令就是从这个仓库装的）。</p>'\n", ''),
  },
]

async function main() {
  let bad = 0
  const rows = []
  for (const c of CASES) {
    const dir = path.join(TMP, c.name.slice(0, 1))
    fs.cpSync(SRC, dir, { recursive: true })
    c.apply(dir)
    const r = await runVerify(dir)
    const red = r.out.split('\n').filter((l) => l.trim().startsWith('❌')).map((l) => l.trim().slice(2).split(' — ')[0].trim())
    const missed = c.expect.filter((e) => !red.includes(e))
    const exitOk = r.code === 1
    const okCase = exitOk && missed.length === 0
    if (!okCase) bad++
    rows.push({ 刀: c.name, 退出码: r.code, 红项: red.length, 预期命中: `${c.expect.length - missed.length}/${c.expect.length}`, 判定: okCase ? '✅' : '❌' })
    console.log(`\n【${c.name}】exit=${r.code} 红项 ${red.length} 条`)
    console.log('  红项：' + (red.length ? red.map((x) => x.slice(0, 46)).join(' ｜ ') : '（一条都没红！）'))
    if (!exitOk) console.log(`  ❌ 期望 exit=1，实测 ${r.code}${r.code === 2 ? '（脚本自己崩了，不是断言变红）' : ''}${r.err ? '  stderr: ' + r.err.slice(0, 200) : ''}`)
    if (missed.length) console.log('  ❌ 这几条没红：' + missed.join(' ｜ '))
  }
  await fs.promises.rm(TMP, { recursive: true, force: true }).catch(() => {})
  await sleep(100)
  console.log('\n================ 反向校验汇总 ================')
  for (const r of rows) console.log(`${r.判定} ${r.刀}  exit=${r.退出码}  红项=${r.红项}  预期命中=${r.预期命中}`)
  console.log(bad === 0
    ? '>>> 尺子有牙 ✅（每一刀都让预期的那几条红了，且退出码都是 1）'
    : `>>> 尺子有问题 ❌（${bad} 刀不符合预期）`)
  process.exit(bad === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error('反向校验脚本自己崩了：', e); await fs.promises.rm(TMP, { recursive: true, force: true }).catch(() => {}); process.exit(2) })
