# ✅ main 跑完了

本轮把 QQ 通知的**引用回复路由**改成了「引用=回会话，不引用=纯聊天」，并修掉了配置读取的第三个坑。

## 一、改了什么

| 项 | 之前 | 现在 |
|---|---|---|
| 引用通知回复 | 当成普通提问 | **投递到对应会话**（queue 模式，和输入框一样） |
| 不引用直接聊 | 投递到会话 | 纯 AI 对话，不碰会话 |
| 子智能体跑完 | 也推送 | **不推送**（`origin` 判定） |

## 二、关键代码

```js
export function pickPromptMode(running, preferred = 'queue') {
  if (preferred === 'steer' && running) return 'steer'
  return 'queue'
}
```

## 三、待办

1. 重启 DSH 让新插件生效
2. 验证设置面板能看到 19 个字段
   - 其中 `qqPromptMode` 只能改 YAML（面板没有 select 类型）
   - 其余 18 个都能在面板里改

> ⚠️ `DEFAULTS` 必须永远保持全空 —— 它和单元测试共用，一旦塞进真实 hubUrl，测试就会真的发网络请求。

## 四、链接

- 完整回答：[查看](https://cyanovo.top:8444/dsh/bstx2.md)
- 裸链接 https://cyanovo.top:8444/dsh/7zyjx.md
- ~~已废弃的写法~~

---

行内元素测试：**粗体**、*斜体*、`inline code`、~~删除线~~、[链接](https://example.com)。

<script>alert('xss 必须被转义')</script>

<sub>由 dsh-notify-memory 自动记录 · 这里是未删节的原文，不是摘要</sub>
