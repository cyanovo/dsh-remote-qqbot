/**
 * dsh-remote-qqbot 的**浏览器侧**（DSH 前端插件）。
 *
 * ## 这个文件为什么长得不像普通源码
 *
 * DSH 的 client bundle 是一个「闭包工厂」制品，不是普通 ESM 模块：
 * 整包在 factory 里，通过**注入的 require** 解析外部依赖，导出 `apply`/`inject`。
 * 官方构建器（`packages/client/tsdown.client.ts:269`）生成的正是这个形状：
 *
 * ```js
 * window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 * ```
 *
 * 所以这里保持 CJS 风格（`var module/exports`、`require(...)`），并且**手写**：
 * 插件的 UI 只用到平台模块表里已有的 `react`，不需要引入打包器 ——
 * 少一条构建链，就少一类「产物与源码不一致」的故障。
 *
 * ## 只能 require 平台共享模块
 *
 * shell 冻结的模块表只有 10 个词
 * （`packages/client/web/src/platform.ts:8`，含 `react` / `react/jsx-runtime` /
 * `@deepseek-ai/dsh-client-ui-slots` 等）。第三方插件**不能** require
 * `@deepseek-ai/dsh-client-ui-primitives` 之外的内部包（那些不在表里，
 * 运行时会 `cannot resolve`）。所以这里的样式全部是内联 style，
 * 颜色优先取 DSH 自己的设计 token（`--dsw-*`），取不到再回退到等效色值。
 *
 * ## 两块 UI
 *
 * 1. `settings.section` —— DSH 设置面板里**独立的一项**（QQ 凭证、开关、中枢、agentmd）
 * 2. `conversation.input.left` —— 聊天输入框工具行里的**两个低调小开关**
 *    （QQ 远程提醒、多会话协作模式，一键开/关）
 *
 * 两者读写同一个 host 路由 `/remote-qqbot/api`（见 src/config-api.js：
 * DSH 的 settings RPC 有硬编码白名单，第三方 namespace 不在其中）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-remote-qqbot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** 同源配置路由（host 侧 src/config-api.js 挂载）。 */
    const API = '/remote-qqbot/api'

    // ── 共享配置 store ─────────────────────────────────────────────────────
    //
    // 输入框开关是**每个会话**一份（slot scope=session），设置页又是一份。
    // 所以配置只在全页面拉一次，改动后所有实例同时刷新 —— 在设置页里关掉提醒，
    // 输入框旁那个开关立刻跟着变，不需要刷新页面。

    let snapshot = { status: 'loading', data: null, error: '' }
    const listeners = new Set()
    let inflight = null

    /** 替换快照并通知所有订阅者（引用变化即触发 useSyncExternalStore 重渲染）。 */
    function publish(next) {
      snapshot = next
      for (const listener of listeners) listener()
    }

    /** 拉一次配置；并发调用共享同一个请求。 */
    function refresh() {
      if (inflight) return inflight
      inflight = fetch(`${API}/config.get`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
        .then(async (res) => {
          const body = await res.json().catch(() => null)
          if (!res.ok || !body?.ok) {
            throw new Error(body?.error?.message ?? `配置服务返回 ${res.status}`)
          }
          publish({ status: 'ready', data: body, error: '' })
        })
        .catch((error) => {
          // 路由不存在时（headless / 无 webServer）也要优雅降级，不能把输入框搞崩。
          publish({ status: 'unavailable', data: null, error: String(error?.message ?? error) })
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    }

    /** 提交一个配置补丁；成功后用服务端返回的视图替换本地快照。 */
    async function save(patch) {
      const res = await fetch(`${API}/config.set`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ patch, expectedRevision: snapshot.data?.revision }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error?.message ?? `保存失败（HTTP ${res.status}）`)
      if (body?.ok === false) {
        // 服务端拒绝（schema 校验、revision 冲突）：把最新视图带回来，让 UI 回到真实状态。
        if (body.values) publish({ status: 'ready', data: body, error: '' })
        throw new Error(body.error?.message ?? '保存被拒绝')
      }
      publish({ status: 'ready', data: body, error: '' })
      return body
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function getSnapshot() {
      return snapshot
    }

    /** 组件里读共享快照；首次挂载时确保已经拉过一次。 */
    function useConfig() {
      const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      React.useEffect(() => {
        if (snapshot.status === 'loading' && inflight === null) void refresh()
      }, [state.status])
      return state
    }

    // ── 设计 token ─────────────────────────────────────────────────────────
    //
    // 优先用 DSH 自己的变量（浅色主题实测值取自 dsh_css_vars.json），
    // 深色主题下变量会自己变；变量缺失时回退到等效浅色值。

    const T = {
      text: 'var(--dsw-alias-brand-text, #0f1115)',
      textDim: 'color-mix(in srgb, var(--dsw-alias-brand-text, #0f1115) 55%, transparent)',
      textFaint: 'color-mix(in srgb, var(--dsw-alias-brand-text, #0f1115) 38%, transparent)',
      surface: 'var(--dsw-alias-bg-layer-1, #fff)',
      surfaceSoft: 'var(--dsw-alias-bg-module-platform, #f5f6f7)',
      border: 'var(--dsw-alias-border-l2, #0000001a)',
      borderStrong: 'var(--dsw-alias-border-l4, #00000029)',
      brand: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6)',
      // 只读状态里的告警色（与插件其它地方一致：能自己算就不依赖主题变量）
      warn: 'var(--dsw-alias-text-warning, #b26a00)',
    }

    const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif'

    /** 内联样式的小助手（避免到处写对象字面量）。 */
    function style(extra) {
      return Object.assign({ fontFamily: FONT, boxSizing: 'border-box' }, extra)
    }

    // ── 通用控件 ───────────────────────────────────────────────────────────

    /** 开关（纯 div，不依赖任何 UI 库）。 */
    function Toggle({ checked, disabled, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled,
        onClick: () => { if (!disabled) onChange(!checked) },
        style: style({
          position: 'relative',
          width: 40,
          height: 22,
          padding: 0,
          border: 'none',
          borderRadius: 11,
          cursor: disabled ? 'default' : 'pointer',
          background: checked ? T.brand : 'color-mix(in srgb, currentColor 22%, transparent)',
          opacity: disabled ? 0.5 : 1,
          transition: 'background 120ms ease',
          flex: '0 0 auto',
        }),
      }, h('span', {
        style: style({
          position: 'absolute',
          top: 2,
          left: checked ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,.22)',
          transition: 'left 120ms ease',
        }),
      }))
    }

    /**
     * 输入框工具行里的**极简**小开关（QQ 提醒 / 协作模式共用一个）。
     *
     * 设计取向是「克制」：默认只是一行 12px 的浅灰文字 + 一个 6px 的圆点，
     * **没有边框、没有底色、没有阴影**，不抢输入框的注意力；
     * 鼠标悬停时才浮出一层极淡的底色与更清楚一点的文字色。
     *
     * 之前那版是带边框的胶囊 + 品牌色圆点，被主人评为「太显眼」——
     * 提醒状态属于"知道就好"的信息，不该长成按钮的样子。
     */
    function MiniToggle({ text, dot, title, disabled, onClick }) {
      const [hover, setHover] = React.useState(false)
      const hot = hover && !disabled
      return h('button', {
        type: 'button',
        onClick,
        title,
        disabled,
        'aria-label': title,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: style({
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 24,
          padding: '0 6px',
          margin: 0,
          fontSize: 12,
          lineHeight: '24px',
          color: hot ? T.textDim : T.textFaint,
          background: hot ? 'color-mix(in srgb, currentColor 7%, transparent)' : 'transparent',
          border: 'none',
          borderRadius: 6,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          whiteSpace: 'nowrap',
          transition: 'color 120ms ease, background 120ms ease',
        }),
      },
      h('span', {
        style: style({
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dot,
          flex: '0 0 auto',
        }),
      }),
      h('span', null, text),
      )
    }

    /** 文本/数字/密码输入行。`readOnly` 用于「只能手改配置文件」的字段（见 config-api 的安全说明）。 */
    function TextField({ spec, value, onChange, secretSet, readOnly }) {
      const isSecret = spec.type === 'secret'
      return h('input', {
        type: isSecret ? 'password' : (spec.type === 'number' ? 'number' : 'text'),
        value: value ?? '',
        readOnly: readOnly === true,
        placeholder: isSecret && secretSet ? '已设置（留空表示不修改）' : (spec.placeholder ?? ''),
        onChange: (event) => onChange(spec.type === 'number' ? event.target.value : event.target.value),
        autoComplete: 'off',
        spellCheck: false,
        style: style({
          width: '100%',
          padding: '7px 10px',
          fontSize: 13,
          color: readOnly === true ? T.textDim : T.text,
          background: readOnly === true ? 'transparent' : T.surfaceSoft,
          border: `1px solid ${T.border}`,
          borderRadius: 8,
          outline: 'none',
          cursor: readOnly === true ? 'not-allowed' : 'text',
        }),
      })
    }

    // ── ① 设置面板里的独立一项 ─────────────────────────────────────────────

    /**
     * DSH 设置 → 左侧导航里的「QQ 提醒与记忆」。
     * 字段表由 host 路由返回（单一真源），这里只负责渲染与提交。
     */
    function NotifyMemorySettings() {
      const state = useConfig()
      const [draft, setDraft] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState('')

      const spec = state.data
      const dirtyKeys = Object.keys(draft)

      const valueOf = (field) => (field in draft ? draft[field] : spec?.values?.[field])

      const setField = (key, value) => {
        setDraft((prev) => Object.assign({}, prev, { [key]: value }))
        setStatus('')
      }

      const submit = async () => {
        setBusy(true)
        setStatus('')
        try {
          const result = await save(draft)
          setDraft({})
          const rejected = Array.isArray(result?.rejected) ? result.rejected : []
          if (rejected.length > 0) {
            // 被拒的键（cloudUrl / hubUrl / qqUpdateSource 只能手改配置文件）：
            // 必须说出来。后端拒了、界面却报「已保存」，等于让用户以为自己改成功了。
            setStatus(`已保存 ${result?.applied?.length ?? 0} 项；另有 ${rejected.length} 项没改`
              + `（${rejected.map((row) => row.key).join('、')} 只能手改配置文件）`)
          } else {
            setStatus(result?.applied?.length ? `已保存（${result.applied.length} 项）` : '没有改动')
          }
        } catch (error) {
          // 失败时**必须把草稿丢掉**：留着草稿就是"界面显示你点的那个值、后端还是旧值"，
          // 开关会停在你点的那一侧而与真实配置相反。save() 失败时已经 publish 了服务端视图，
          // 清掉草稿正好让界面回到真值。
          setDraft({})
          setStatus(`保存失败：${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }

      if (state.status === 'loading') {
        return h('div', { style: style({ padding: '8px 0', color: T.textDim, fontSize: 13 }) }, '正在读取插件配置…')
      }
      if (state.status === 'unavailable') {
        return h('div', { style: style({ padding: '8px 0', color: T.textDim, fontSize: 13, lineHeight: 1.7 }) },
          h('div', null, '这个界面需要 DSH 的 Web 服务（桌面版或 dsh web）。'),
          h('div', { style: { marginTop: 6, color: T.textFaint } }, state.error),
        )
      }

      const groups = spec.groups ?? []
      const fields = spec.fields ?? []
      const statusRows = Array.isArray(spec.status) ? spec.status : []
      const pushField = fields.find((field) => field.key === 'qqNotifyEnabled')
      const pushOn = valueOf('qqNotifyEnabled') !== false

      return h('div', { style: style({ maxWidth: 720, padding: '4px 2px 24px' }) },
        h('div', { style: style({ marginBottom: 18 }) },
          h('div', { style: style({ fontSize: 15, fontWeight: 600, color: T.text }) }, 'QQ 远程提醒与跨会话记忆'),
          h('div', { style: style({ marginTop: 4, fontSize: 12.5, color: T.textDim, lineHeight: 1.6 }) },
            '手机 QQ 上的完成/提问/出错提醒，以及 agentmd 操作日志与上下文注入。'),
        ),

        // ── 接收 QQ 推送（主人 2026-10-07 点名要的那个开关）─────────────────
        // 它本来就在下面「QQ 机器人通道」分组里（键 qqNotifyEnabled），但排在 qqEnabled
        // 后面、混在二十多个字段中间，不好找。这里把它单独提到最上面一张卡 ——
        // 「要不要收推送」是抬手就要按的决定，不该让人在字段表里翻。
        // 同时下面分组里不再重复渲染同一个键（同一个开关在一屏里出现两次最容易让人困惑）。
        pushField
          ? h('section', { key: 'push-switch', style: style({ marginBottom: 22 }) },
            h('div', {
              style: style({
                display: 'flex', alignItems: 'center', gap: 16, padding: '14px 16px',
                border: `1px solid ${T.border}`, borderRadius: 12, background: T.surface,
              }),
            },
            h('div', { style: style({ flex: '1 1 auto', minWidth: 0 }) },
              h('div', { style: style({ fontSize: 14, fontWeight: 600, color: T.text }) }, pushField.label),
              h('div', { style: style({ marginTop: 4, fontSize: 12, color: T.textDim, lineHeight: 1.6 }) },
                pushField.description),
              state.status === 'ready' && !pushOn
                ? h('div', { style: style({ marginTop: 6, fontSize: 12, color: T.warn }) },
                  '现在是关的：我不会主动推任何消息给你（QQ 长连接与反向对话照旧）。')
                : null,
            ),
            h(Toggle, {
              // ⚠️ 这里**不能**写成 `=== true`：host 侧没给值时 configView 回的是 null，
              //    那样界面会显示成"关"，而插件实际按"缺省视为开"在推（runtime 与运行状态
              //    那行用的都是 `=== false` 才关）。开关的显示必须跟行为用同一条判据。
              checked: pushOn,
              label: pushField.label,
              onChange: (next) => setField('qqNotifyEnabled', next),
            }),
            ),
            h('div', { style: style({ marginTop: 6, fontSize: 11.5, color: T.textFaint }) },
              '输入框旁边那个「QQ 提醒已开 / 已关」是同一个开关，两处任一处改了立刻生效。'),
          )
          : null,

        // ── 运行状态（只读）───────────────────────────────────────────────
        // 主人 2026-10-03：「除了 QQ 提醒已开、协作已开，剩下的放到设置里就行」。
        // 所以启动日志只留那两行，其余（中枢/云端/agentmd/覆盖文件…）挪到这里。
        statusRows.length > 0
          ? h('section', { key: 'status', style: style({ marginBottom: 22 }) },
            h('div', { style: style({ fontSize: 13, fontWeight: 600, color: T.text }) }, '运行状态'),
            h('div', { style: style({ marginTop: 2, marginBottom: 10, fontSize: 12, color: T.textFaint }) },
              '只读。这些以前是每次启动刷在日志里的，现在挪到这里。'),
            h('div', {
              style: style({
                border: `1px solid ${T.border}`, borderRadius: 12, background: T.surface, overflow: 'hidden',
              }),
            }, statusRows.map((row, index) => h('div', {
              key: `status-${index}`,
              style: style({
                display: 'flex', alignItems: 'flex-start', gap: 16, padding: '10px 14px',
                borderTop: index === 0 ? 'none' : `1px solid ${T.border}`,
              }),
            },
            h('div', { style: style({ flex: '0 0 auto', width: 110, fontSize: 12.5, color: T.textDim }) }, row.label),
            h('div', {
              style: style({
                flex: '1 1 auto', minWidth: 0, fontSize: 12.5, lineHeight: 1.6,
                color: row.warn === true ? T.warn : T.text, wordBreak: 'break-all',
              }),
            }, row.value),
            ))),
          )
          : null,

        ...groups.map((group) => {
          // `qqNotifyEnabled` 已经在最上面那张「接收 QQ 推送」卡里渲染过了 ——
          // 同一个开关在一屏里出现两次最容易让人以为"改了没生效"。
          const rows = fields.filter((field) => field.group === group.id && field.key !== 'qqNotifyEnabled')
          if (rows.length === 0) return null
          return h('section', { key: group.id, style: style({ marginBottom: 22 }) },
            h('div', { style: style({ fontSize: 13, fontWeight: 600, color: T.text }) }, group.title),
            group.hint
              ? h('div', { style: style({ marginTop: 2, marginBottom: 10, fontSize: 12, color: T.textFaint }) }, group.hint)
              : h('div', { style: { height: 10 } }),
            h('div', {
              style: style({
                border: `1px solid ${T.border}`,
                borderRadius: 12,
                background: T.surface,
                overflow: 'hidden',
              }),
            }, rows.map((field, index) => h('div', {
              key: field.key,
              style: style({
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '11px 14px',
                borderTop: index === 0 ? 'none' : `1px solid ${T.border}`,
              }),
            },
            h('div', { style: style({ flex: '1 1 auto', minWidth: 0 }) },
              h('div', {
                style: style({ fontSize: 13, color: T.text }),
                title: `settings.yaml 字段：${field.key}`,
              }, field.label,
              // 「只能手改配置文件」的字段（cloudUrl / hubUrl / qqUpdateSource）：
              // 这是一条**安全边界**，不是权限偏好 —— 见 config-api.js 文件头「越权防护」。
              // 界面上照样显示当前值，但输入框只读、保存时不带它。
              field.manualOnly === true
                ? h('span', {
                  style: style({
                    marginLeft: 8, padding: '1px 6px', fontSize: 11, borderRadius: 6,
                    color: T.warn, border: `1px solid ${T.warn}`, whiteSpace: 'nowrap',
                  }),
                }, '只能手改配置文件')
                : null),
              field.description
                ? h('div', { style: style({ marginTop: 3, fontSize: 11.5, color: T.textFaint, lineHeight: 1.55 }) }, field.description)
                : null,
            ),
            h('div', { style: style({ flex: '0 0 auto', width: field.type === 'boolean' ? 'auto' : 280 }) },
              field.type === 'boolean'
                ? h(Toggle, {
                  checked: valueOf(field.key) === true,
                  label: field.label,
                  onChange: (next) => setField(field.key, next),
                })
                : h(TextField, {
                  spec: field,
                  value: valueOf(field.key),
                  secretSet: spec.secretsSet?.[field.key] === true,
                  readOnly: field.manualOnly === true,
                  onChange: (next) => setField(field.key, next),
                }),
            ),
            ))),
          )
        }),

        h('div', { style: style({ display: 'flex', alignItems: 'center', gap: 12 }) },
          h('button', {
            type: 'button',
            disabled: busy || dirtyKeys.length === 0,
            onClick: submit,
            style: style({
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 500,
              color: '#fff',
              background: busy || dirtyKeys.length === 0 ? 'color-mix(in srgb, currentColor 30%, transparent)' : T.brand,
              border: 'none',
              borderRadius: 8,
              cursor: busy || dirtyKeys.length === 0 ? 'default' : 'pointer',
              opacity: busy ? 0.7 : 1,
            }),
          }, busy ? '保存中…' : (dirtyKeys.length > 0 ? `保存（${dirtyKeys.length} 项）` : '保存')),
          status
            ? h('span', { style: style({ fontSize: 12.5, color: status.startsWith('保存失败') ? '#d93025' : T.textDim }) }, status)
            : h('span', { style: style({ fontSize: 12, color: T.textFaint }) }, '改动立即生效（无需重启）'),
        ),
      )
    }

    // ── ② 输入框下方的远程提醒开关 ─────────────────────────────────────────

    /**
     * 聊天输入框工具行里的**低调**小开关，**只有两个**：QQ 远程提醒 + 协作模式。
     *
     * - 关掉 QQ 提醒只停「主动提醒」，**不断开** QQ 长连接：
     *   你在 QQ 里引用旧通知继续说话、或发 /task 派活都照常。
     * - 关掉协作模式：同一工作区里的会话不再互相通报文件占用与留言。
     *
     * ⚠️ 2026-10-03：这里**曾经有 4 个开关**（多出「完整回答怎么给」的三档循环 + 「允许上传正文」总闸）。
     * 主人明确要求「除了 QQ 提醒已开、协作已开，剩下的全部收到设置里」——
     * 这两个开关是**抬手就要按**的（开了/关了必须一眼看到），而三档全文去向属于「配置」，
     * 一年也改不了几次，摆在输入框旁边只是噪音。它们**没有丢**：
     * 「设置 → QQ 提醒与记忆 → QQ 机器人通道」里的 `qqFulltextMode` / `cloudEnabled`
     * 与这里原本的功能完全等价（同一个 `config-api` 字段表，同一套白名单校验）。
     * 撤掉这两个开关**不减少任何能力**，只是把它们挪回了它们该在的地方。
     *
     * 外观上刻意做成"一行浅灰小字"而不是按钮（见 MiniToggle 注释）。
     */
    function InputDockControls() {
      const state = useConfig()
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')

      // 配置服务不可用（headless / 无 webServer）时干脆不占位，别把输入框搞乱。
      if (state.status === 'unavailable') return null

      const values = state.data?.values ?? {}
      const ready = state.status === 'ready'
      const channelOn = values.qqEnabled === true
      const notifyOn = values.qqNotifyEnabled !== false
      const collabOn = values.collabEnabled !== false

      const qqText = !ready
        ? 'QQ 提醒'
        : !channelOn
          ? 'QQ 未连接'
          : notifyOn ? 'QQ 提醒已开' : 'QQ 提醒已关'
      const qqTitle = !ready
        ? '正在读取配置…'
        : !channelOn
          ? 'QQ 没连上：到「设置 → QQ 提醒与记忆」填 AppID / ClientSecret'
          : notifyOn
            ? '点击关闭远程提醒（不会断开 QQ 连接）'
            : '点击开启远程提醒'

      const collabText = !ready ? '协作模式' : collabOn ? '协作已开' : '协作已关'
      const collabTitle = !ready
        ? '正在读取配置…'
        : collabOn
          ? '点击关闭协作：同一工作区下的会话不再互相通报占用与留言'
          : '点击开启协作：同一工作区下的会话互相通报占用与留言'

      const toggle = async (key, next) => {
        if (!ready || busy) return
        setBusy(key)
        setError('')
        try {
          await save({ [key]: next })
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy('')
        }
      }

      return h('div', {
        style: style({ display: 'inline-flex', alignItems: 'center', gap: 2, margin: 0 }),
      },
      h(MiniToggle, {
        text: qqText,
        dot: !ready || !channelOn || !notifyOn ? T.textFaint : T.brand,
        title: error ? `切换失败：${error}` : qqTitle,
        disabled: !ready || !channelOn || busy === 'qqNotifyEnabled',
        onClick: () => toggle('qqNotifyEnabled', !notifyOn),
      }),
      h(MiniToggle, {
        text: collabText,
        dot: !ready || !collabOn ? T.textFaint : T.brand,
        title: error ? `切换失败：${error}` : collabTitle,
        disabled: !ready || busy === 'collabEnabled',
        onClick: () => toggle('collabEnabled', !collabOn),
      }),
      // 「完整回答怎么给」和「允许上传正文」这两件事**不在这里** —— 它们在
      // 「设置 → QQ 提醒与记忆 → QQ 机器人通道」里（字段 `qqFulltextMode` / `cloudEnabled`）。
      // 2026-10-03 主人明确要求：输入框下面只留「抬手就要按」的两个开关。
      // ⚠️ 别再把它们加回来 —— `scripts/verify-ui-installed.mjs` 有一条断言数着这里的开关个数。
      // 失败必须**看得见**。2026-10-02 那次事故里，错误只写在 `title` 里（要悬停才出现），
      // 而路由又把失败误报成成功 —— 于是主人眼里就是"点了没反应、开关一直开着"。
      // 现在把原因直接摊在旁边：一行小字、不抢眼，但一眼能看到。
      error
        ? h('span', {
            style: style({
              fontSize: 12,
              color: '#d93025',
              marginLeft: 8,
              maxWidth: 360,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }),
            title: error,
          }, `切换失败：${error}`)
        : null,
      )
    }

    // ── 注册 ───────────────────────────────────────────────────────────────

    /**
     * 两个 slot 都用 `ctx.slots.inject(name, ...)` 注册：
     * 这些 slot 由别的插件（ui-settings / ui-conversation）在运行时**声明**，
     * 声明之前 register 会因「未声明的 slot」直接抛错，inject 会等到声明出现再回调。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'remote-qqbot',
        order: 30,
        label: () => 'QQ 提醒与记忆',
      }, NotifyMemorySettings))

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'remote-qqbot-qq',
        order: 0,
      }, InputDockControls))
    }

    exports.apply = apply
    // 只依赖 slot 注册表；多声明一个不存在的服务会让这个 entry 卡在 pending（前端会报失败）。
    exports.inject = ['slots']

    return module.exports
  },
})
