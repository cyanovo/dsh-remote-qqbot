/**
 * 浏览器侧设置页的**真渲染**冒烟测试（1.0.20 新增）。
 *
 * 为什么要有这一组：`src/client.js` 到 1.0.19 为止只有「正则扫源码」这一种护栏 ——
 * 而设置页要是渲染时抛错，主人看到的是**整页空白**，扫源码一个 ❌ 都不会报。
 * 这里把真正的 client bundle 跑起来：给它一个假 `window.__ModuleLoader__`、一个假 React
 * 和一个假 `fetch`（返回**真的** `configView()` 产物），然后把 `NotifyMemorySettings`
 * 当普通函数调（loading → ready）并遍历它返回的元素树。
 *
 * 刻意用 `lib/client.js`（产物）而不是 `src/`：产物才是浏览器真正加载的那一份，
 * 与 `tests/config-view.test.mjs` 读 `lib/config-api.js` 同一个道理。
 *
 * 跑法：node tests/client-render.test.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.dirname(here)
const LIB = path.join(pluginDir, 'lib')

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── 假 React：只实现 client.js 用到的 4 个 API ─────────────────────────────
// 元素就是普通对象；useState 只给初值（这一组只渲染，不点按钮）；
// useEffect 的回调**收集起来**，由测试决定什么时候跑 —— 这样才能把 loading 与 ready 两态都渲染到。
function makeReact(effects) {
  const createElement = (type, props, ...children) => ({
    type,
    props: {
      ...(props ?? {}),
      children: children.length === 0 ? undefined : (children.length === 1 ? children[0] : children),
    },
  })
  return {
    createElement,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: (fn) => { effects.push(fn) },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

/** 遍历元素树，收集所有节点（含字符串子节点）。 */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ text: String(node) })
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out)
    return out
  }
  if (typeof node === 'object' && 'type' in node) {
    out.push(node)
    walk(node.props?.children, out)
  }
  return out
}

const textOf = (node) => walk(node).filter((n) => n.text !== undefined).map((n) => n.text).join('\n')
const togglesWithLabel = (node, label) => walk(node).filter((n) => n.type && n.props?.label === label)
const findByKey = (node, key) => walk(node).find((n) => n.type && n.props?.key === key)

// ── 真 bundle ───────────────────────────────────────────────────────────────
let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) { definition = def },
  },
}

/** 设置页要的数据由 lib/config-api.js 的 configView 生成（跟 host 返回的是同一份形状）。 */
const { configView } = await import(pathToFileURL(path.join(LIB, 'config-api.js')).href)
const NS = 'dsh-remote-qqbot'
const noNs = { describe: () => ({ descriptors: [] }) }
const statusRows = () => [
  { label: '配置来源', value: 'settings.yaml 的 "dsh-remote-qqbot" 段' },
  { label: 'QQ 远程提醒', value: '开启' },
]

await import(pathToFileURL(path.join(LIB, 'client.js')).href)

/**
 * 装一份**独立**的客户端模块实例（每个实例有自己的 store / snapshot），
 * 返回一个 render() 与它注册出来的设置页组件。
 */
function mount({ live, fetchImpl }) {
  const effects = []
  const registered = []
  const module = definition.factory((name) => {
    assert.equal(name, 'react', '只允许 require react（平台模块表里没有别的）')
    return makeReact(effects)
  })
  module.apply({
    slots: {
      inject: (_name, cb) => cb(),
      register: (meta, component) => { registered.push({ meta, component }) },
    },
  })
  globalThis.fetch = fetchImpl(live)
  const settings = registered.find((r) => r.meta.name === 'settings.section')
  const render = () => {
    const tree = settings.component()
    for (const fn of effects.splice(0)) fn()      // 跑掉本轮收集的 useEffect
    return tree
  }
  return { render, registered, settings }
}

const okFetch = (live) => async (url) => {
  assert.match(String(url), /\/remote-qqbot\/api\/config\.get$/, '客户端只该打这条同源路由')
  return { ok: true, status: 200, json: async () => configView(noNs, NS, () => live, statusRows) }
}
const boomFetch = () => async () => { throw new Error('offline') }

/** 渲染到「不再变化」为止：把 useEffect 触发的异步拉取等出来。 */
async function settle(mounted, want, tries = 50) {
  let tree = mounted.render()
  for (let i = 0; i < tries; i += 1) {
    await tick()
    tree = mounted.render()
    if (!want || textOf(tree).includes(want)) return tree
  }
  return tree
}

console.log('客户端设置页 · 真渲染冒烟\n')

await t('client bundle 能被装起来，并注册出两个挂点（设置页 + 输入框）', () => {
  assert.ok(definition, 'bundle 没有调用 window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-remote-qqbot')
  const mounted = mount({ live: { qqEnabled: true, qqNotifyEnabled: true }, fetchImpl: okFetch })
  assert.equal(mounted.registered.length, 2)
  const settings = mounted.settings
  assert.equal(settings.meta.id, 'remote-qqbot')
  assert.equal(settings.meta.order, 30)
  assert.equal(settings.meta.label(), 'QQ 提醒与记忆')
})

await t('★ ready 状态下渲染不抛错，最上面那张卡真的画出来了', async () => {
  const mounted = mount({ live: { qqEnabled: true, qqNotifyEnabled: true }, fetchImpl: okFetch })
  const tree = await settle(mounted, '接收 QQ 推送')
  const card = findByKey(tree, 'push-switch')
  assert.ok(card, '没有 key=push-switch 的那张卡（设置页还是老样子）')
  const text = textOf(card)
  assert.match(text, /接收 QQ 推送/, '卡片标题必须是「接收 QQ 推送」')
  assert.match(text, /新版本/, '卡片说明要说清它也管新版本提醒')
  assert.match(text, /输入框旁边/, '卡片要说清它和输入框旁那个小开关是同一个')
  assert.doesNotMatch(text, /现在是关的/, '开着的时候不该出现"现在是关的"')
})

await t('★ 卡片上的开关跟着 host 走：开着 = checked true', async () => {
  const mounted = mount({ live: { qqEnabled: true, qqNotifyEnabled: true }, fetchImpl: okFetch })
  const tree = await settle(mounted, '接收 QQ 推送')
  const toggle = togglesWithLabel(tree, '接收 QQ 推送')[0]
  assert.ok(toggle, '卡片里没有那个开关')
  assert.equal(toggle.props.checked, true)
})

await t('★ host 说关着 → 开关是关的，并且卡片上多一行"现在是关的"', async () => {
  const mounted = mount({ live: { qqEnabled: true, qqNotifyEnabled: false }, fetchImpl: okFetch })
  const tree = await settle(mounted, '接收 QQ 推送')
  const card = findByKey(tree, 'push-switch')
  assert.equal(togglesWithLabel(card, '接收 QQ 推送')[0].props.checked, false)
  assert.match(textOf(card), /现在是关的/, '关着时必须有一句能一眼看到的说明')
})

await t('★ 缺省（host 没给这个键）也按"开"显示 —— 不能显示成关着却在推', async () => {
  const mounted = mount({ live: { qqEnabled: true }, fetchImpl: okFetch })
  const tree = await settle(mounted, '接收 QQ 推送')
  assert.equal(togglesWithLabel(tree, '接收 QQ 推送')[0].props.checked, true)
})

await t('★ 同一个开关在整页里只出现一次（分组表里必须排掉它）', async () => {
  const mounted = mount({ live: { qqEnabled: true, qqNotifyEnabled: true }, fetchImpl: okFetch })
  const tree = await settle(mounted, '接收 QQ 推送')
  const all = togglesWithLabel(tree, '接收 QQ 推送')
  assert.equal(all.length, 1, `整页出现了 ${all.length} 个「接收 QQ 推送」开关 —— 同一个键不该渲染两次`)
  // 字段表里仍然有它：卡片是"提上来"，不是"另写一份"
  const payload = configView(noNs, NS, () => ({ qqEnabled: true, qqNotifyEnabled: true }), statusRows)
  assert.ok(payload.fields.some((f) => f.key === 'qqNotifyEnabled'), '字段表里少了这个键')
})

await t('loading 状态不抛错（还没拉到配置时先显示"正在读取"）', () => {
  const mounted = mount({ live: { qqEnabled: true, qqNotifyEnabled: true }, fetchImpl: okFetch })
  const tree = mounted.render()   // 只渲染一次：useEffect 还没跑，快照仍是 loading
  assert.match(textOf(tree), /正在读取插件配置/)
})

await t('★ 配置服务不可用时不白屏：给一句人话 + 原因', async () => {
  const mounted = mount({ live: { qqEnabled: true }, fetchImpl: boomFetch })
  const tree = await settle(mounted, '这个界面需要')
  const text = textOf(tree)
  assert.match(text, /这个界面需要 DSH 的 Web 服务/, '要告诉用户为什么没有配置项')
  assert.match(text, /offline/, '把原因带上（否则排查只能靠猜）')
})

console.log(`\n${fail === 0 ? '✅' : '❌'} client-render 组：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  for (const f of failures) console.log(`\n--- ${f.name}\n${f.err?.stack ?? f.err}`)
}
process.exit(fail === 0 ? 0 : 1)
