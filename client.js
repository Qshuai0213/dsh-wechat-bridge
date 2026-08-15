// dsh-wechat-bridge —— 浏览器端：设置页（设置 → 微信桥接）
// 自包含手工编写（无打包器）：client 模块系统以 CJS factory 包裹，内核采纳 { apply, inject }。
// 数据通道：同源 fetch → 宿主 webServer fenced routes（/_dsh/wechat-bridge/api/*），
// 信封 { ok, value } / { ok: false, error: { code, message } }，模式对照 dsh-better-sidebar。
// 模型目录：与 dsh「设置 → 模型」同源（connection.api.llm.providers / llm.models）。
// 界面无任何入口：全部功能（扫码登录 / 会话管理 / 通道设置）都在设置页内。
window.__ModuleLoader__.load({
  id: 'dsh-wechat-bridge',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useEffect, useCallback } = React

    const EFFORT_OPTIONS = [
      ['', '跟随默认'],
      ['off', '关闭（off）'],
      ['low', '低（low）'],
      ['medium', '中（medium）'],
      ['high', '高（high）'],
      ['max', '最高（max）'],
    ]
    const POLICY_OPTIONS = [
      ['pairing', 'pairing — 放行所有（个人使用）'],
      ['allowlist', 'allowlist — 仅允许列表内用户'],
      ['disabled', 'disabled — 关闭通道'],
    ]

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      font: 'inherit',
      fontSize: 13,
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-strong, #cbd2dc)',
      background: 'var(--dsw-alias-bg, #fff)',
      color: 'inherit',
    }
    const labelStyle = { display: 'block', marginBottom: 4, fontSize: 12, opacity: 0.85 }
    const fieldStyle = { marginBottom: 14 }
    const sectionTitleStyle = { fontSize: 12, fontWeight: 600, opacity: 0.75, margin: '16px 0 8px' }

    const apiCall = async (method, payload) => {
      const r = await fetch(`/_dsh/wechat-bridge/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      const parsed = await r.json().catch(() => null)
      if (!r.ok || !parsed || parsed.ok !== true) {
        throw new Error(parsed?.error?.message ?? `HTTP ${r.status}`)
      }
      return parsed.value
    }
    const apiGet = () => apiCall('settings.get', {})
    const apiSave = (patch) => apiCall('settings.update', { patch })

    /** 与 dsh「设置 → 模型」同源的模型目录 + agent 预设列表；失败返回 null（回退自由文本输入）。 */
    const loadCatalog = async (getConnection) => {
      try {
        const conn = getConnection()
        if (!conn?.api?.llm) return null
        const [provResp, modelResp, presetResp] = await Promise.all([
          conn.api.llm.providers({}),
          conn.api.llm.models({}),
          typeof conn.api.agentPresets?.list === 'function'
            ? conn.api.agentPresets.list({}).catch(() => null)
            : Promise.resolve(null),
        ])
        if (!provResp?.result?.ok || !modelResp?.result?.ok) return null
        const providers = provResp.result.value.providers || []
        const groups = modelResp.result.value.groups || []
        const presets = presetResp?.result?.ok ? presetResp.result.value.presets || [] : null
        return { providers, groups, presets }
      } catch {
        return null
      }
    }

    /** SVG 微信图标（双气泡，fill 跟随 currentColor） */
    function WechatIcon({ size = 18 }) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'currentColor',
        'aria-hidden': true,
      },
        React.createElement('path', { d: 'M8.6 2.9C4.7 2.9 1.5 5.7 1.5 9.2c0 1.9 1 3.6 2.7 4.7L3.3 16l3-1.6c.7.2 1.4.3 2.2.3h.3c-.1-.5-.1-1-.1-1.5 0-3.6 3.1-6.5 7.2-6.5.3 0 .7 0 1 .1C16.5 4.6 12.9 2.9 8.6 2.9z' }),
        React.createElement('path', { d: 'M21.7 13.4c0-2.9-2.5-5.2-5.6-5.2s-5.6 2.3-5.6 5.2 2.5 5.2 5.6 5.2c.6 0 1.2-.1 1.8-.3l2.5 1.3-.5-2c1.1-.8 1.8-2 1.8-3.2z' }),
      )
    }

    /** SVG 状态图标：成功（圆圈对勾） */
    function CheckIcon({ size = 13 }) {
      return React.createElement('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': true },
        React.createElement('circle', { cx: 8, cy: 8, r: 7, fill: 'currentColor', opacity: 0.15 }),
        React.createElement('path', { d: 'M4.6 8.3l2.3 2.3 4.5-5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** SVG 状态图标：警告（三角感叹号） */
    function WarnIcon({ size = 13 }) {
      return React.createElement('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': true },
        React.createElement('path', { d: 'M8 1.9L15 14H1L8 1.9z', fill: 'currentColor', opacity: 0.2 }),
        React.createElement('path', { d: 'M8 6v3.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        React.createElement('circle', { cx: 8, cy: 11.7, r: 0.9, fill: 'currentColor' }),
      )
    }

    /** SVG 状态图标：失败（圆圈叉） */
    function ErrorIcon({ size = 13 }) {
      return React.createElement('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': true },
        React.createElement('circle', { cx: 8, cy: 8, r: 7, fill: 'currentColor', opacity: 0.15 }),
        React.createElement('path', { d: 'M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    /** 状态行渲染：kind = ok | warn | error | info */
    function StatusLine({ kind, text, extra }) {
      const icon = kind === 'ok'
        ? React.createElement(CheckIcon, null)
        : kind === 'warn'
          ? React.createElement(WarnIcon, null)
          : kind === 'error'
            ? React.createElement(ErrorIcon, null)
            : null
      return React.createElement('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 12,
          opacity: 0.8,
          color: kind === 'error' ? 'var(--dsw-alias-danger, #e5484d)' : 'inherit',
          marginBottom: 6,
        },
      },
        icon,
        React.createElement('span', null, text),
        extra || null,
      )
    }

    /** 登录区块：生成二维码 → 轮询 login.status → 展示结果（扫码成功自动写入凭据） */
    function WechatLoginSection({ onChanged }) {
      const [phase, setPhase] = React.useState('idle') // idle | waiting | scanned | confirmed | expired | error
      const [qrDataUrl, setQrDataUrl] = React.useState(null)
      const [errorText, setErrorText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const timerRef = React.useRef(null)

      const stopPolling = () => {
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
      }
      React.useEffect(() => stopPolling, [])

      const start = async () => {
        setBusy(true)
        setErrorText('')
        stopPolling()
        try {
          const r = await apiCall('login.start', {})
          setQrDataUrl(r.qrDataUrl)
          setPhase('waiting')
          timerRef.current = setInterval(async () => {
            try {
              const s = await apiCall('login.status', {})
              if (s.status === 'confirmed') {
                setPhase('confirmed')
                stopPolling()
                if (typeof onChanged === 'function') onChanged()
              } else if (s.status === 'expired') {
                setPhase('expired')
                stopPolling()
              } else if (s.status === 'scanned') {
                setPhase('scanned')
              } else {
                setPhase('waiting')
              }
            } catch { /* 单次轮询失败忽略，等待下一轮 */ }
          }, 2500)
        } catch (error) {
          setPhase('error')
          setErrorText(error && error.message ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const qrStatus = phase === 'scanned'
        ? { kind: 'ok', text: '已扫码，请在手机上确认登录' }
        : phase === 'confirmed'
          ? { kind: 'ok', text: '登录成功，凭据已保存（约 24h 有效，到期前微信会自动推送续期二维码）' }
          : phase === 'expired'
            ? { kind: 'warn', text: '二维码已过期，请重新获取' }
            : phase === 'error'
              ? { kind: 'error', text: errorText }
              : null

      return React.createElement('div', { style: { padding: '4px 2px', maxWidth: 320 } },
        phase === 'idle' || phase === 'expired' || phase === 'error'
          ? React.createElement('button', {
              type: 'button',
              onClick: () => void start(),
              disabled: busy,
              style: {
                padding: '6px 16px',
                font: 'inherit',
                fontSize: 13,
                borderRadius: 6,
                cursor: 'pointer',
                border: 'none',
                background: 'var(--dsw-alias-brand-primary, #4c8bf5)',
                color: '#fff',
              },
            }, busy ? '获取中…' : '获取登录二维码')
          : null,
        qrStatus ? React.createElement(StatusLine, { kind: qrStatus.kind, text: qrStatus.text }) : null,
        qrDataUrl && phase !== 'idle' && phase !== 'error'
          ? React.createElement('div', { style: { marginTop: 8 } },
              React.createElement('img', {
                src: qrDataUrl,
                alt: '微信登录二维码',
                width: 240,
                height: 240,
                style: { borderRadius: 8, border: '1px solid var(--dsw-alias-border-strong, #cbd2dc)' },
              }))
          : null,
        phase === 'waiting' || phase === 'scanned'
          ? React.createElement('div', { style: { marginTop: 8, fontSize: 12, opacity: 0.7 } },
              '用微信扫描二维码，并在手机上确认（约 6 分钟有效）')
          : null,
        (phase === 'confirmed' || phase === 'expired')
          ? React.createElement('button', {
              type: 'button',
              onClick: () => void start(),
              disabled: busy,
              style: {
                marginTop: 10,
                padding: '4px 12px',
                font: 'inherit',
                fontSize: 12,
                borderRadius: 6,
                cursor: 'pointer',
                border: '1px solid var(--dsw-alias-border-strong, #cbd2dc)',
                background: 'none',
                color: 'inherit',
              },
            }, busy ? '获取中…' : '重新获取二维码')
          : null,
      )
    }

    /** 设置页：凭据状态 + 扫码登录 + 微信会话 + 通道设置 */
    function WechatBridgeSettingsPage({ getConnection, sessionsService }) {
      const [values, setValues] = useState(null)
      const [status, setStatus] = useState({ kind: 'info', text: '加载中…' })
      const [message, setMessage] = useState(null)
      const [saving, setSaving] = useState(false)
      const [catalog, setCatalog] = useState(null)
      const [rows, setRows] = useState(null)
      const [busy, setBusy] = useState(false)
      const [confirmDeleteId, setConfirmDeleteId] = useState(null)

      const load = useCallback(async () => {
        setStatus({ kind: 'info', text: '加载中…' })
        setBusy(true)
        try {
          const [r, cat, list] = await Promise.all([apiGet(), loadCatalog(getConnection), apiCall('sessions.list', {})])
          setCatalog(cat)
          setRows(list?.sessions || [])
          if (r && r.values) {
            setValues({ ...r.values, allowFromText: (r.values.allowFrom || []).join('\n') })
            const c = r.credentials
            if (c && c.ready) {
              const login = c.loginTime ? new Date(c.loginTime).toLocaleString() : '未知'
              const remain = typeof c.remainingHours === 'number'
                ? `，剩余约 ${c.remainingHours < 1 ? Math.round(c.remainingHours * 60) + ' 分钟' : Math.round(c.remainingHours) + ' 小时'}`
                : ''
              setStatus({ kind: 'ok', text: `凭据有效（登录于 ${login}${remain}）｜ 微信会话 ${r.sessionCount ?? 0} 个` })
            } else {
              setStatus({ kind: 'warn', text: '凭据未配置：请在本页「扫码登录」区块扫码' })
            }
            setMessage(r.writable ? null : { kind: 'warn', text: '设置服务不可用：修改仅展示，不会持久化' })
          } else {
            setStatus({ kind: 'error', text: '获取设置失败（接口无数据）' })
          }
        } catch (error) {
          setStatus({ kind: 'error', text: '获取设置失败: ' + (error && error.message ? error.message : String(error)) })
        } finally {
          setBusy(false)
        }
      }, [getConnection])

      useEffect(() => { void load() }, [load])

      // 删除确认计时器（hooks 必须在条件 return 之前无条件调用）
      const deletingIdRef = React.useRef(null)
      React.useEffect(() => () => {
        if (deletingIdRef.current) clearTimeout(deletingIdRef.current)
      }, [])

      if (!values) {
        return React.createElement('div', { style: { padding: 16, fontSize: 13 } }, status.text)
      }

      const set = (key) => (e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))
      const onProviderChange = (e) => {
        const provider = e.target.value
        setValues((prev) => ({ ...prev, provider, model: '' }))
      }

      // 目录可用 → 下拉选择；目录不可用 → 自由文本输入
      const catalogOk = catalog && catalog.providers && catalog.providers.length > 0
      const providerOptions = catalogOk
        ? catalog.providers.map((p) => ({ value: p.provider, label: `${p.displayName || p.provider}${p.active === false ? '（未激活）' : ''}` }))
        : []
      // 当前已保存的提供方/模型不在目录里时也要保留可选项，避免保存时被清掉
      if (catalogOk && values.provider && !providerOptions.some((o) => o.value === values.provider)) {
        providerOptions.push({ value: values.provider, label: `${values.provider}（目录外）` })
      }
      const group = catalogOk ? catalog.groups.find((g) => g.id === values.provider) : undefined
      const modelOptions = group
        ? group.models.map((m) => ({ value: m.id, label: m.name || m.id }))
        : []
      if (catalogOk && values.model && !modelOptions.some((o) => o.value === values.model)) {
        modelOptions.push({ value: values.model, label: `${values.model}（目录外）` })
      }

      // agent 预设列表（与 dsh 预设选择器同源）
      const presetsOk = catalog && Array.isArray(catalog.presets) && catalog.presets.length > 0
      const presetOptions = presetsOk
        ? catalog.presets.map((p) => ({
            value: p.id,
            label: `${p.name || p.id}${p.isDefault ? '（默认）' : ''}${p.broken ? '（损坏）' : ''}`,
          }))
        : []
      if (presetsOk && values.agentPreset && !presetOptions.some((o) => o.value === values.agentPreset)) {
        presetOptions.push({ value: values.agentPreset, label: `${values.agentPreset}（目录外）` })
      }

      const save = async () => {
        setSaving(true)
        setMessage(null)
        try {
          const patch = {
            provider: String(values.provider || '').trim(),
            model: String(values.model || '').trim(),
            reasoningEffort: values.reasoningEffort || '',
            agentPreset: String(values.agentPreset || '').trim(),
            dmPolicy: values.dmPolicy || 'pairing',
            allowFrom: String(values.allowFromText || '')
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          }
          await apiSave(patch)
          setMessage({ kind: 'ok', text: '已保存（权限策略即时生效；模型/思考强度/预设对新建的微信会话生效）' })
        } catch (error) {
          setMessage({ kind: 'error', text: '保存失败: ' + (error && error.message ? error.message : String(error)) })
        } finally {
          setSaving(false)
        }
      }

      const openSession = (id) => {
        try {
          if (sessionsService && typeof sessionsService.open === 'function') sessionsService.open(id)
        } catch { /* ignore */ }
      }
      const copyId = (id) => {
        try {
          navigator.clipboard.writeText(id)
        } catch { /* ignore */ }
      }
      const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—')

      // 删除：第一次点击进入确认态（3 秒后复位），再次点击才真正删除
      const requestDelete = (id) => {
        if (confirmDeleteId === id) {
          setConfirmDeleteId(null)
          void (async () => {
            setMessage(null)
            try {
              await apiCall('sessions.remove', { sessionId: id })
              setMessage({ kind: 'ok', text: '会话已删除' })
              await load()
            } catch (error) {
              setMessage({ kind: 'error', text: '删除失败: ' + (error && error.message ? error.message : String(error)) })
            }
          })()
        } else {
          setConfirmDeleteId(id)
          if (deletingIdRef.current) clearTimeout(deletingIdRef.current)
          deletingIdRef.current = setTimeout(() => setConfirmDeleteId((cur) => (cur === id ? null : cur)), 3000)
        }
      }

      const rowStyle = {
        padding: '8px 0',
        borderBottom: '1px solid var(--dsw-alias-border-weak, rgba(128,128,128,0.18))',
      }

      const modelSelect = catalogOk
        ? React.createElement('select', {
            style: inputStyle,
            value: values.model || '',
            onChange: set('model'),
            disabled: !values.provider,
          },
          React.createElement('option', { value: '' }, values.provider ? '跟随默认' : '请先选择模型提供方'),
          modelOptions.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label)))
        : React.createElement('input', {
            style: inputStyle,
            value: values.model || '',
            onChange: set('model'),
            placeholder: '例如 deepseek-v4-flash（目录不可用，手动输入）',
          })

      return React.createElement('div', { style: { padding: '4px 2px', maxWidth: 560 } },
        React.createElement('div', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
        },
          React.createElement('strong', { style: { fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement(WechatIcon, { size: 16 }),
            '微信桥接'),
          React.createElement('button', {
            type: 'button',
            onClick: () => void load(),
            disabled: busy,
            style: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'none', color: 'var(--dsw-alias-brand-primary, #4c8bf5)', padding: 0 },
          }, busy ? '刷新中…' : '刷新')),
        React.createElement(StatusLine, { kind: status.kind, text: status.text }),
        React.createElement('div', { style: sectionTitleStyle }, '扫码登录'),
        React.createElement(WechatLoginSection, { onChanged: () => void load() }),
        React.createElement('div', { style: sectionTitleStyle }, '微信会话'),
        rows === null
          ? React.createElement('div', { style: { fontSize: 13, padding: '4px 0', opacity: 0.6 } }, '加载中…')
          : rows.length === 0
            ? React.createElement('div', { style: { fontSize: 13, padding: '4px 0', opacity: 0.6 } }, '暂无微信会话')
            : React.createElement('div', null,
                rows.map((r) => React.createElement('div', { key: r.sessionId, style: rowStyle },
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                    React.createElement('span', { style: { fontWeight: 600, fontSize: 13, wordBreak: 'break-all' } }, r.userId),
                    React.createElement('span', { style: { fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap' } }, fmtTime(r.createdAt))),
                  React.createElement('div', { style: { fontSize: 11, opacity: 0.55, fontFamily: 'monospace', wordBreak: 'break-all', margin: '2px 0 4px' } }, r.sessionId),
                  React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    React.createElement('span', { style: { fontSize: 11, padding: '1px 6px', borderRadius: 4, background: r.live ? 'rgba(52,199,89,0.15)' : 'rgba(128,128,128,0.12)', color: r.live ? '#34c759' : 'inherit' } }, r.live ? '活跃' : '空闲'),
                    React.createElement('button', {
                      type: 'button',
                      onClick: () => openSession(r.sessionId),
                      style: { fontSize: 12, cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-brand-primary, #4c8bf5)', color: '#fff', borderRadius: 4, padding: '2px 10px' },
                    }, '打开'),
                    React.createElement('button', {
                      type: 'button',
                      onClick: () => copyId(r.sessionId),
                      style: { fontSize: 12, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-strong, #cbd2dc)', background: 'none', color: 'inherit', borderRadius: 4, padding: '2px 8px' },
                    }, '复制ID'),
                    React.createElement('button', {
                      type: 'button',
                      onClick: () => requestDelete(r.sessionId),
                      style: {
                        fontSize: 12,
                        cursor: 'pointer',
                        border: 'none',
                        borderRadius: 4,
                        padding: '2px 8px',
                        background: confirmDeleteId === r.sessionId ? 'var(--dsw-alias-danger, #e5484d)' : 'none',
                        color: confirmDeleteId === r.sessionId ? '#fff' : 'var(--dsw-alias-danger, #e5484d)',
                      },
                    }, confirmDeleteId === r.sessionId ? '确认删除' : '删除'))))),
        React.createElement('div', { style: sectionTitleStyle }, '通道设置'),
        React.createElement('div', { style: fieldStyle },
          React.createElement('label', { style: labelStyle }, '模型提供方（留空 = 跟随全局默认模型）'),
          catalogOk
            ? React.createElement('select', { style: inputStyle, value: values.provider || '', onChange: onProviderChange },
                React.createElement('option', { value: '' }, '跟随默认'),
                providerOptions.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label)))
            : React.createElement('input', {
                style: inputStyle,
                value: values.provider || '',
                onChange: set('provider'),
                placeholder: '例如 opencode-go（目录不可用，手动输入）',
              })),
        React.createElement('div', { style: fieldStyle },
          React.createElement('label', { style: labelStyle }, '模型（留空 = 跟随全局默认模型）'),
          modelSelect),
        React.createElement('div', { style: fieldStyle },
          React.createElement('label', { style: labelStyle }, '预设模式（留空 = 继承主会话/默认预设）'),
          presetsOk
            ? React.createElement('select', {
                style: inputStyle,
                value: values.agentPreset || '',
                onChange: set('agentPreset'),
              },
              React.createElement('option', { value: '' }, '跟随主会话（默认）'),
              presetOptions.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label)))
            : React.createElement('input', {
                style: inputStyle,
                value: values.agentPreset || '',
                onChange: set('agentPreset'),
                placeholder: '例如 standard（预设列表不可用，手动输入）',
              })),
        React.createElement('div', { style: fieldStyle },
          React.createElement('label', { style: labelStyle }, '思考强度'),
          React.createElement('select', {
            style: inputStyle,
            value: values.reasoningEffort || '',
            onChange: set('reasoningEffort'),
          }, EFFORT_OPTIONS.map(([v, l]) => React.createElement('option', { key: v, value: v }, l)))),
        React.createElement('div', { style: fieldStyle },
          React.createElement('label', { style: labelStyle }, '权限模式'),
          React.createElement('select', {
            style: inputStyle,
            value: values.dmPolicy || 'pairing',
            onChange: set('dmPolicy'),
          }, POLICY_OPTIONS.map(([v, l]) => React.createElement('option', { key: v, value: v }, l)))),
        React.createElement('div', { style: fieldStyle },
          React.createElement('label', { style: labelStyle }, '允许列表（allowlist 模式下生效，每行一个微信用户 ID）'),
          React.createElement('textarea', {
            style: { ...inputStyle, minHeight: 80, resize: 'vertical' },
            value: values.allowFromText || '',
            onChange: set('allowFromText'),
            placeholder: 'o9cq80wwZLaIrJEBTW3TCRCVVyt8@im.wechat',
          })),
        React.createElement('button', {
          type: 'button',
          onClick: () => void save(),
          disabled: saving,
          style: {
            padding: '6px 16px',
            font: 'inherit',
            fontSize: 13,
            borderRadius: 6,
            cursor: 'pointer',
            border: 'none',
            background: 'var(--dsw-alias-brand-primary, #4c8bf5)',
            color: '#fff',
          },
        }, saving ? '保存中…' : '保存设置'),
        message
          ? React.createElement('div', { style: { marginTop: 10 } },
              React.createElement(StatusLine, { kind: message.kind, text: message.text }))
          : null,
      )
    }

    function apply(ctx) {
      const getConnection = () => {
        try {
          return ctx.get('connection')
        } catch {
          return undefined
        }
      }
      const getSessions = () => {
        try {
          return ctx.get('sessions')
        } catch {
          return undefined
        }
      }
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', function* () {
            yield ctx.slots.register(
              {
                name: 'settings.section',
                id: 'wechat-bridge',
                order: 25,
                label: '微信桥接',
                inject: () => ({ getConnection, sessionsService: getSessions() }),
              },
              WechatBridgeSettingsPage,
            )
          }),
        'dsh-wechat-bridge: settings page',
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
