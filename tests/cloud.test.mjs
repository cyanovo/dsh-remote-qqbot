/**
 * src/cloud.js 的单测：**不打真网络**，用假 fetch 把请求逐字检查一遍。
 *
 * 这里刻意把"发出去的请求长什么样"钉死（URL / 方法 / Authorization / body 字段），
 * 因为云端那边是**按账号隔离**的：Authorization 少了或者 body 里多带一个 username，
 * 表现可能是"发出一堆别人的记录"或"401 却不知道为什么"——在 QQ 里都看不出来。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLOUD_DEVICE_TTL_MS,
  CLOUD_POLL_INTERVAL_S,
  cloudDevicePoll,
  cloudDeviceStart,
  cloudMe,
  cloudPublishNote,
  cloudRecordUrl,
  describeAccount,
  normalizeCloudUrl,
  qqLinkWarning,
} from '../src/cloud.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
const t = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

/** 假 fetch：记录请求，按脚本回响应。 */
function fakeFetch(script) {
  const calls = []
  const impl = async (url, opt = {}) => {
    calls.push({ url: String(url), method: opt.method ?? 'GET', headers: opt.headers ?? {}, body: opt.body ? JSON.parse(opt.body) : undefined, signal: opt.signal })
    const r = typeof script === 'function' ? script(String(url), opt, calls.length) : script
    if (r instanceof Error) throw r
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      json: async () => { if (r.raw !== undefined) throw new Error('not json'); return r.data },
    }
  }
  impl.calls = calls
  return impl
}

console.log('── normalizeCloudUrl ──')
t('空值/空白 → 未配置', () => {
  assert.equal(normalizeCloudUrl(''), '')
  assert.equal(normalizeCloudUrl('   '), '')
  assert.equal(normalizeCloudUrl(undefined), '')
  assert.equal(normalizeCloudUrl(null), '')
})
t('非 http(s) 一律判为未配置（ftp/file/javascript）', () => {
  for (const bad of ['ftp://x.com', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
    assert.equal(normalizeCloudUrl(bad), '', bad)
  }
})
t('去掉末尾斜杠与多余路径', () => {
  assert.equal(normalizeCloudUrl('http://cyanovo.top'), 'http://cyanovo.top')
  assert.equal(normalizeCloudUrl('http://cyanovo.top/'), 'http://cyanovo.top')
  assert.equal(normalizeCloudUrl('  https://a.example/dsh-web/  '), 'https://a.example/dsh-web')
})
t('保留端口', () => {
  assert.equal(normalizeCloudUrl('http://127.0.0.1:8795/'), 'http://127.0.0.1:8795')
})

console.log('\n── cloudRecordUrl ──')
t('拼出 /n/<id>', () => {
  assert.equal(cloudRecordUrl('http://cyanovo.top', 'k3f9a'), 'http://cyanovo.top/n/k3f9a')
  assert.equal(cloudRecordUrl('http://cyanovo.top/', 'abc123'), 'http://cyanovo.top/n/abc123')
})
t('地址或 id 不合法 → 空串（宁可不给链接，也不给个坏链接）', () => {
  assert.equal(cloudRecordUrl('', 'k3f9a'), '')
  assert.equal(cloudRecordUrl('http://x.top', ''), '')
  assert.equal(cloudRecordUrl('http://x.top', 'ab'), '')          // 太短
  assert.equal(cloudRecordUrl('http://x.top', 'a'.repeat(33)), '') // 太长
  assert.equal(cloudRecordUrl('http://x.top', 'has space'), '')
})
t('★ 生成的路径必须能被 dsh-web 前端 app.js 的深链正则接受', () => {
  const appJs = path.join(HERE, '..', '..', 'dsh-web', 'public', 'app.js')
  const url = cloudRecordUrl('http://cyanovo.top', 'k3f9a')
  if (!existsSync(appJs)) {
    console.log('      ⚠️ 工作区里没有 dsh-web/public/app.js —— 这条跳过（打包后发布版会跳过）')
    return
  }
  const src = readFileSync(appJs, 'utf8')
  const m = src.match(/location\.pathname\.match\((\/\^\\\/n\\\/.*?\/i)\)/)
  assert.ok(m, '没在 app.js 里找到深链正则 —— 前端改过了？这条断言需要跟着改')
  const re = eval(m[1]) // eslint-disable-line no-eval
  const p = new URL(url).pathname
  assert.ok(re.test(p), `app.js 的正则不认这个路径：${p} vs ${m[1]}`)
  assert.ok(re.test(`${p}/`), '带末尾斜杠也要认（QQ 客户端可能补斜杠）')
})

console.log('\n── cloudPublishNote ──')
t('★ 请求逐字正确：POST /api/publish + Bearer 令牌 + 不带 username', async () => {
  const f = fakeFetch({ data: { ok: true, id: 'k3f9a', plan: 'free', retentionText: '5 小时' } })
  const r = await cloudPublishNote({ cloudUrl: 'http://cyanovo.top/', token: 'tok-abc', text: '  正文  ', title: '标题', fetchImpl: f })
  assert.deepEqual(r, { ok: true, id: 'k3f9a', url: 'http://cyanovo.top/n/k3f9a', plan: 'free', retentionText: '5 小时' })
  assert.equal(f.calls.length, 1)
  const c = f.calls[0]
  assert.equal(c.url, 'http://cyanovo.top/api/publish')
  assert.equal(c.method, 'POST')
  assert.equal(c.headers.Authorization, 'Bearer tok-abc')
  assert.equal(c.body.text, '正文', '正文要去掉首尾空白')
  assert.equal(c.body.title, '标题')
  assert.equal(c.body.mode, 'note')
  assert.equal('username' in c.body, false, '🔴 绝不能带 username —— 那是在给服务器留冒名的口子')
})
t('服务器给了 url 就用服务器的（可能配了对外域名）', async () => {
  const f = fakeFetch({ data: { ok: true, id: 'k3f9a', url: 'https://public.example/n/k3f9a' } })
  const r = await cloudPublishNote({ cloudUrl: 'http://inner:8795', token: 't', text: 'x', fetchImpl: f })
  assert.equal(r.url, 'https://public.example/n/k3f9a')
})
t('没有正文 / 没有令牌 → 直接拒绝，不发请求', async () => {
  const f = fakeFetch({ data: {} })
  assert.equal((await cloudPublishNote({ cloudUrl: 'http://x.top', token: 't', text: '   ', fetchImpl: f })).ok, false)
  assert.equal((await cloudPublishNote({ cloudUrl: 'http://x.top', token: '', text: 'x', fetchImpl: f })).ok, false)
  assert.equal(f.calls.length, 0)
})
t('服务器 401 → 把服务器的话原样带回来（好让人知道是令牌不对）', async () => {
  const f = fakeFetch({ status: 401, data: { ok: false, error: '发布令牌不对（这串令牌不属于任何账号，可能已被吊销）' } })
  const r = await cloudPublishNote({ cloudUrl: 'http://x.top', token: 'bad', text: 'x', fetchImpl: f })
  assert.equal(r.ok, false)
  assert.equal(r.status, 401)
  assert.match(r.error, /令牌/)
})
t('服务器 429（配额用完）也要能把原话带回来', async () => {
  const f = fakeFetch({ status: 429, data: { ok: false, error: '今天的 100 次已经用完了' } })
  const r = await cloudPublishNote({ cloudUrl: 'http://x.top', token: 't', text: 'x', fetchImpl: f })
  assert.equal(r.ok, false)
  assert.match(r.error, /100 次/)
})
t('返回了非 JSON → 明确报出来，不是静默成功', async () => {
  const f = fakeFetch({ raw: true, data: null })
  const r = await cloudPublishNote({ cloudUrl: 'http://x.top', token: 't', text: 'x', fetchImpl: f })
  assert.equal(r.ok, false)
  assert.match(r.error, /非 JSON/)
})
t('没配 cloudUrl → 不发请求', async () => {
  const f = fakeFetch({ data: {} })
  const r = await cloudPublishNote({ cloudUrl: '', token: 't', text: 'x', fetchImpl: f })
  assert.equal(r.ok, false)
  assert.match(r.error, /cloudUrl/)
  assert.equal(f.calls.length, 0)
})
t('服务器没给 id → 报错（否则链接会指向一个不存在的地方）', async () => {
  const f = fakeFetch({ data: { ok: true } })
  const r = await cloudPublishNote({ cloudUrl: 'http://x.top', token: 't', text: 'x', fetchImpl: f })
  assert.equal(r.ok, false)
  assert.match(r.error, /id/)
})
t('网络异常/超时 → 不抛异常，返回 ok:false', async () => {
  const boom = fakeFetch(() => { throw new Error('socket hang up') })
  const r = await cloudPublishNote({ cloudUrl: 'http://x.top', token: 't', text: 'x', fetchImpl: boom })
  assert.equal(r.ok, false)
  assert.match(r.error, /socket hang up/)
})

console.log('\n── 设备码绑定 ──')
t('start：拿到短码与长码，默认间隔 3 秒', async () => {
  const f = fakeFetch({ data: { ok: true, userCode: 'ABCD-EFGH', deviceCode: 'd'.repeat(40), interval: 3, expiresIn: 600000 } })
  const r = await cloudDeviceStart({ cloudUrl: 'http://x.top', fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.userCode, 'ABCD-EFGH')
  assert.equal(r.deviceCode, 'd'.repeat(40))
  assert.equal(r.interval, 3)
  assert.equal(f.calls[0].url, 'http://x.top/api/device/start')
  assert.equal(f.calls[0].method, 'POST')
})
t('start：服务器少给字段 → 报错而不是返回半截数据', async () => {
  const f = fakeFetch({ data: { ok: true, userCode: 'ABCD-EFGH' } })
  const r = await cloudDeviceStart({ cloudUrl: 'http://x.top', fetchImpl: f })
  assert.equal(r.ok, false)
  assert.match(r.error, /设备码/)
})
t('poll：pending 时没有令牌', async () => {
  const f = fakeFetch({ data: { ok: true, status: 'pending' } })
  const r = await cloudDevicePoll({ cloudUrl: 'http://x.top', deviceCode: 'dc', fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'pending')
  assert.equal(r.token, undefined)
  assert.equal(f.calls[0].body.deviceCode, 'dc')
})
t('poll：approved 时拿到令牌与账号', async () => {
  const f = fakeFetch({ data: { ok: true, status: 'approved', token: 'tok', username: 'cyan', me: { username: 'cyan', quota: { limit: 100, remaining: 99, retentionText: '5 小时' } } } })
  const r = await cloudDevicePoll({ cloudUrl: 'http://x.top', deviceCode: 'dc', fetchImpl: f })
  assert.equal(r.status, 'approved')
  assert.equal(r.token, 'tok')
  assert.equal(r.username, 'cyan')
})
t('poll：码过期（410）→ 说清要重新申请', async () => {
  const f = fakeFetch({ status: 410, data: { ok: false, error: '这组码过期了，重新申请一组' } })
  const r = await cloudDevicePoll({ cloudUrl: 'http://x.top', deviceCode: 'dc', fetchImpl: f })
  assert.equal(r.ok, false)
  assert.match(r.error, /过期/)
})
t('poll：缺 deviceCode → 不发请求', async () => {
  const f = fakeFetch({ data: {} })
  const r = await cloudDevicePoll({ cloudUrl: 'http://x.top', deviceCode: '', fetchImpl: f })
  assert.equal(r.ok, false)
  assert.equal(f.calls.length, 0)
})

console.log('\n── 查账号与说人话 ──')
t('me：免费版与付费版都能读出来', async () => {
  const f = fakeFetch({ data: { ok: true, me: { username: 'u', quota: { limit: 100, remaining: 42, retentionText: '5 小时' } } } })
  const r = await cloudMe({ cloudUrl: 'http://x.top', token: 't', fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.me.username, 'u')
  assert.equal(f.calls[0].method, 'GET')
  assert.equal(f.calls[0].headers.Authorization, 'Bearer t')
})
t('describeAccount：免费版 / 付费版 / 无账号', () => {
  assert.equal(describeAccount(null), '')
  const free = describeAccount({ username: 'u', quota: { limit: 100, remaining: 42, retentionText: '5 小时', upgraded: false } })
  assert.match(free, /免费版/)
  assert.match(free, /42 \/ 100/)
  assert.match(free, /5 小时/)
  const pro = describeAccount({ username: 'u', quota: { limit: 1000, remaining: 999, retentionText: '48 小时', upgraded: true, proUntil: Date.UTC(2026, 10, 2) } })
  assert.match(pro, /付费版/)
  assert.match(pro, /48 小时/)
  assert.match(pro, /2026-11-02/)
})

console.log('\n── QQ 链接警告（cloudUrl 现在用户可配了）──')
t('实测能点开的形式（http + 默认端口）不报警', () => {
  assert.equal(qqLinkWarning('http://cyanovo.top'), '')
  assert.equal(qqLinkWarning('http://cyanovo.top/'), '')
  assert.equal(qqLinkWarning('http://a.example:80'), '')
  assert.equal(qqLinkWarning(''), '')
})
t('★ https 只给"提示"（API 加密是好事），且明确要人确认 80 端口也在服务', () => {
  const w = qqLinkWarning('https://example.com')
  assert.match(w, /https/)
  assert.match(w, /http/)
  assert.match(w, /80 端口/, '必须点明"该域名的 80 端口也要能访问"')
  assert.ok(!/点不开。/.test(w), '不能一口咬定点不开 —— 80 也在服务时它完全正常')
})
t('★ 带非 80 端口是**硬警告**（端口会被丢掉，链接必然打不开）', () => {
  const w = qqLinkWarning('http://example.com:8444')
  assert.match(w, /8444/)
  assert.match(w, /端口/)
  assert.match(w, /点不开/)
})
t('路径前缀不在警告范围内（路径本身原样保留）', () => {
  assert.equal(qqLinkWarning('http://example.com/dsh-web'), '')
})

console.log('\n── 常量一致性 ──')
t('轮询间隔与设备码有效期与服务器约定一致', () => {
  assert.equal(CLOUD_POLL_INTERVAL_S, 3)
  assert.equal(CLOUD_DEVICE_TTL_MS, 10 * 60 * 1000)
})

console.log(`\ncloud.js 单测：${pass} 通过${process.exitCode ? ' / 有失败' : ' / 0 失败'}`)
