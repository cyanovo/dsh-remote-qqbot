/**
 * 查腾讯网址安全中心对某域名的判定。
 * 只读，不修改任何文件。
 *
 * 用法：node check-urlsec.mjs [域名...]
 */
const targets = process.argv.slice(2)
if (targets.length === 0) targets.push('cyanovo.top', 'baidu.com')

const ENDPOINT = 'https://cgi.urlsec.qq.com/index.php?m=check&a=check'

async function check(url) {
  const body = new URLSearchParams({ url, _: String(Date.now()) }).toString()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      Referer: 'https://urlsec.qq.com/check.html',
      Origin: 'https://urlsec.qq.com',
    },
    body,
  })
  const text = await res.text()
  return { status: res.status, text }
}

for (const t of targets) {
  try {
    const { status, text } = await check(t)
    // 返回通常是 JSONP：callback({...})
    const json = text.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '')
    let parsed = null
    try { parsed = JSON.parse(json) } catch { /* 保留原文 */ }
    console.log(`\n=== ${t} === HTTP ${status}`)
    if (parsed) {
      console.log(JSON.stringify(parsed, null, 2).slice(0, 1200))
    } else {
      console.log('原始返回（前 600 字）：')
      console.log(text.slice(0, 600))
    }
  } catch (err) {
    console.log(`\n=== ${t} === 查询失败：${err.message}`)
  }
}
