// super-wechat-bridge —— 微信 iLink ClawBot 远程桥接插件（自建）
// 协议与 dsh API 均经实测：
//   - iLink: GET get_bot_qrcode / get_qrcode_status（登录）、POST getupdates（长轮询收）、POST sendmessage（msg 包裹 + text_item 发）
//   - dsh 0.1.0-rc.6: ctx.agents.create({ sessionId, meta }) → handle.agent；agent.followup(message)
import Schema from '@deepseek-ai/schemastery'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import QRCode from 'qrcode'

export const name = 'wechat-bridge'

// 可移植默认状态目录：DSH_HOME（无则 ~/.dsh）下的 channels/wechat
const DEFAULT_STATE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'channels', 'wechat')

// iLink 登录/轮询端点（与 login.mjs 一致）
const ILINK_BASE = 'https://ilinkai.weixin.qq.com'

// iLink 会话有效期约 24h（服务端限制，无法延长）。
// 到期前自动生成新二维码并推送到微信，用户扫码后新 token 原子替换，全程不断线。
const RECONNECT = {
  ttlMs: 24 * 3600 * 1000, // 会话总时长（服务端限制）
  warnBeforeMs: 2 * 3600 * 1000, // 提前 2h 首次推送续期二维码
  remindMs: 30 * 60 * 1000, // 未扫码则 30 分钟后再提醒
  forceMs: 30 * 60 * 1000, // 最后 30 分钟不再等提醒间隔，直接再推
  checkIntervalMs: 5 * 60 * 1000, // 到期检测周期
}

export const Config = Schema.object({
  stateDir: Schema.string().default(DEFAULT_STATE_DIR),
  dmPolicy: Schema.union(['pairing', 'allowlist', 'disabled']).default('pairing'),
  allowFrom: Schema.array(Schema.string()).default([]),
  textChunkLimit: Schema.number().default(2000),
  pollTimeoutMs: Schema.number().default(40000),
})

// 运行时设置（设置 → 微信桥接 页面可调，持久化到 settings.yaml；无 settings 服务时回退组合配置）
const SETTINGS_SCHEMA = Schema.object({
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  reasoningEffort: Schema.union(['', 'off', 'low', 'medium', 'high', 'max']).default(''),
  agentPreset: Schema.string().default(''),
  dmPolicy: Schema.union(['pairing', 'allowlist', 'disabled']).default('pairing'),
  allowFrom: Schema.array(Schema.string()).default([]),
})

export const inject = ['tools', 'agents', 'webServer']

// ---------- 小工具 ----------
function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
function saveJson(path, data) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}
function sanitizeId(s) { return s.replace(/[^a-zA-Z0-9._-]/g, '-') }
function randomUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}
function extractAssistantText(message) {
  if (!message?.content) return ''
  const blocks = Array.isArray(message.content) ? message.content : [message.content]
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
}

// ---------- 微信频道（iLink ClawBot） ----------
class WechatChannel {
  constructor(ctx, config, onMessage, getSettings) {
    this.ctx = ctx
    this.config = config
    this.onMessage = onMessage
    this.getSettings = getSettings || (() => ({}))
    this.logger = ctx.logger('wechat-bridge')
    this.stopped = false
    this.polling = false
    this.syncBuf = ''
    this.contextTokens = new Map()
    mkdirSync(config.stateDir, { recursive: true })
    this.creds = loadJson(join(config.stateDir, 'credentials.json'), null)
    const tokens = loadJson(join(config.stateDir, 'context-tokens.json'), {})
    if (tokens && typeof tokens === 'object') this.contextTokens = new Map(Object.entries(tokens))
    this.syncBuf = existsSync(join(config.stateDir, 'sync_buf.txt'))
      ? readFileSync(join(config.stateDir, 'sync_buf.txt'), 'utf8').trim() : ''
    if (this.creds?.loginTime) {
      const ageHours = (Date.now() - new Date(this.creds.loginTime).getTime()) / 3600000
      if (ageHours > 20) this.logger.warn(`凭据已使用 ${ageHours.toFixed(1)}h，iLink 会话约 24h 过期；到期前插件会自动推送续期二维码到微信`)
    }
  }

  get ready() { return !!(this.creds?.token && this.creds?.baseUrl) }

  /** 登录成功后写入凭据并（在未轮询时）启动长轮询 */
  setCredentials(creds) {
    this.creds = creds
    saveJson(join(this.config.stateDir, 'credentials.json'), creds)
    this.logger.info('登录成功，凭据已更新，channel 就绪')
    if (!this.polling) this.start()
  }

  start() {
    if (this.polling) return
    if (!this.ready) {
      this.logger.warn('凭据缺失，跳过启动。请先运行: node <pkg>/login.mjs <stateDir>')
      return
    }
    this.stopped = false
    void this.pollLoop()
  }

  stop() { this.stopped = true; this.persistTokens() }

  async pollLoop() {
    this.polling = true
    this.logger.info('开始 iLink 长轮询')
    try {
      while (!this.stopped) {
        try {
          const data = await this.apiFetch('ilink/bot/getupdates', {
            get_updates_buf: this.syncBuf,
            longpolling_timeout: 35000,
          }, this.config.pollTimeoutMs)
          if (data.get_updates_buf) {
            this.syncBuf = data.get_updates_buf
            writeFileSync(join(this.config.stateDir, 'sync_buf.txt'), this.syncBuf, 'utf8')
          }
          for (const msg of data.msgs || []) {
            await this.processMessage(msg)
          }
        } catch (error) {
          if (this.stopped) break
          this.logError('poll', error)
          await new Promise((r) => setTimeout(r, 5000))
        }
      }
    } finally {
      this.polling = false
    }
    this.logger.info('iLink 长轮询已停止')
  }

  async processMessage(msg) {
    const userId = msg.from_user_id
    if (!userId || userId.endsWith('@im.bot')) return
    if (!this.isAllowed(userId)) return
    const text = this.extractText(msg)
    if (msg.context_token) {
      this.contextTokens.set(userId, msg.context_token)
      this.persistTokens()
    }
    await this.onMessage({ userId, text, contextToken: msg.context_token, timestamp: Date.now() })
  }

  isAllowed(userId) {
    const s = this.getSettings() || {}
    const policy = s.dmPolicy ?? this.config.dmPolicy ?? 'pairing'
    if (policy === 'disabled') return false
    if (policy === 'allowlist') {
      const allow = s.allowFrom?.length ? s.allowFrom : this.config.allowFrom || []
      return allow.includes(userId)
    }
    return true // pairing：放行所有（个人使用）
  }

  extractText(msg) {
    if (msg.text_item?.text) return msg.text_item.text
    for (const item of msg.item_list || []) {
      if (item.type === 1 && item.text_item?.text) return item.text_item.text
    }
    return '[非文本消息]'
  }

  async sendText(userId, text) {
    if (!this.ready) throw new Error('凭据未配置')
    const contextToken = this.contextTokens.get(userId) || ''
    const limit = this.config.textChunkLimit ?? 2000
    const chunks = []
    for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit))
    for (const chunk of chunks) {
      await this.apiFetch('ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: userId,
          client_id: `dsh-${randomUUID()}`,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: chunk } }],
        },
      })
    }
  }

  async apiFetch(endpoint, body, timeoutMs = 15000) {
    const base = this.creds.baseUrl.endsWith('/') ? this.creds.baseUrl : `${this.creds.baseUrl}/`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // 关键：所有 POST 必须带 base_info.channel_version，否则服务器接受消息但不投递（实测）
      const payload = { ...body, base_info: { channel_version: '1.0.2' } }
      const res = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'AuthorizationType': 'ilink_bot_token',
          'Authorization': `Bearer ${this.creds.token}`,
          'X-WECHAT-UIN': randomUin(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.ret !== 0 && data.ret !== undefined) {
        throw new Error(`iLink ${endpoint}: ${data.errmsg || data.error_message || `ret=${data.ret}`}`)
      }
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  persistTokens() {
    saveJson(join(this.config.stateDir, 'context-tokens.json'), Object.fromEntries(this.contextTokens))
  }

  logError(phase, error) {
    this.logger.error(`[${phase}] ${error.message}`)
    try {
      appendFileSync(join(this.config.stateDir, 'errors.log'),
        `${new Date().toISOString()} [${phase}] ${error.stack || error.message}\n`)
    } catch { /* 诊断写入失败不影响主流程 */ }
  }
}

// ---------- 插件入口 ----------
export function apply(ctx, config) {
  const logger = ctx.logger('wechat-bridge')
  const sessions = new Map() // userId -> { sessionId, agent, lastActivityAt }
  const wechatBySession = new Map() // sessionId -> userId（自动转发用）
  const pendingReplies = new Map() // sessionId -> { userId, text, toolSent }
  let loginState = null // 扫码登录状态 { qrcode, link, startedAt }

  // ---------- 运行时设置：注册 namespace（持久化 settings.yaml），无 settings 服务时回退组合配置 ----------
  let settingsScope = undefined
  let currentSettings = () => config
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('wechat-bridge', SETTINGS_SCHEMA, { base: config })
    settingsScope = scope
    currentSettings = () => scope.get()
    sctx.effect(() => () => {
      currentSettings = () => config
      settingsScope = undefined
    })
  })

  async function getOrCreateAgent(userId) {
    let entry = sessions.get(userId)
    if (entry) { entry.lastActivityAt = Date.now(); return entry }
    const sessionId = sanitizeId(`wechat-${userId}-${Date.now()}`)
    // cwd：优先取主 agent 的工作区（与本 GUI 会话同组），否则回退 sandboxPolicy 根
    let cwd
    try {
      const root = ctx.get('agents')?.roots?.()?.[0]
      cwd = root?.session?.header?.cwd
    } catch { /* ignore */ }
    if (!cwd) {
      const sp = ctx.get('sandboxPolicy')
      cwd = sp && typeof sp.workspaceRoot === 'string' ? sp.workspaceRoot : undefined
    }
    // 模型：优先取设置里的 provider/model（留空则跟随全局默认模型选择），思考强度同样来自设置
    const s = currentSettings()
    const selection = ctx.get('agentDefaultModel')
    const selected = selection && typeof selection.currentSelection === 'function'
      ? selection.currentSelection() : undefined
    const agentOptions = {}
    if (s.provider && s.model) {
      agentOptions.provider = s.provider
      agentOptions.model = s.model
    } else if (selected?.provider && selected?.model) {
      agentOptions.provider = selected.provider
      agentOptions.model = selected.model
    }
    if (s.reasoningEffort) agentOptions.reasoningEffort = s.reasoningEffort
    // 预设：创建时通过 setup 钩子加入 agent 预设，
    // 否则 agent 只有全局工具（工具/提示词/技能目录几乎为空，能力严重受限）。
    // 设置里指定了 agentPreset → 挂载该预设；否则继承主 GUI 会话的组合，无主会话时挂载默认预设。
    const agentPresets = ctx.get('agentPresets')
    let setup
    if (agentPresets && typeof agentPresets.composeFrom === 'function') {
      setup = async (agentCtx) => {
        const presetId = currentSettings().agentPreset
        if (presetId) {
          await agentPresets.mount(agentCtx, presetId)
          return
        }
        try {
          const roots = ctx.get('agents')?.roots?.() || []
          const parent = roots.find((r) => r?.ctx && !String(r.id).startsWith('wechat-')) || roots[0]
          if (parent?.ctx) {
            const joined = agentPresets.composeFrom(agentCtx, parent.ctx)
            if (joined !== undefined) return
          }
        } catch { /* 回退默认预设 */ }
        await agentPresets.mount(agentCtx)
      }
    }
    const handle = await ctx.agents.create({
      sessionId,
      ...(cwd ? { meta: { cwd } } : {}),
      ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
      ...(setup ? { setup } : {}),
    })
    const agent = handle.agent
    entry = { sessionId, agent, handle, lastActivityAt: Date.now() }
    sessions.set(userId, entry)
    wechatBySession.set(sessionId, userId)
    const modelDesc = agentOptions.provider
      ? `${agentOptions.provider}/${agentOptions.model}${agentOptions.reasoningEffort ? ` (effort=${agentOptions.reasoningEffort})` : ''}`
      : '默认模型'
    logger.info(`创建会话: ${userId} → ${sessionId} (${cwd || 'cwd=默认'}, ${modelDesc})`)
    return entry
  }

  async function handleInbound(userId, text) {
    try {
      const { agent, sessionId } = await getOrCreateAgent(userId)
      const message = {
        id: `wx-${Date.now()}-${randomBytes(4).toString('hex')}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }
      agent.followup(message)
      logger.info(`消息已注入 ${sessionId}: ${text.slice(0, 60)}`)
    } catch (error) {
      logger.error(`消息注入失败: ${error.message}`)
      try {
        appendFileSync(join(config.stateDir, 'errors.log'),
          `${new Date().toISOString()} [inject] ${error.stack || error.message}\n`)
      } catch { /* ignore */ }
    }
  }

  const channel = new WechatChannel(ctx, config, (m) => handleInbound(m.userId, m.text), () => currentSettings())

  // ---------- 登录二维码生成 / 状态查询（login.start / login.status 与自动续期共用） ----------
  async function startLogin() {
    const res = await fetch(`${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`)
    const d = await res.json().catch(() => null)
    if (!d || (d.ret !== 0 && d.ret !== undefined) || !d.qrcode || !d.qrcode_img_content) {
      const err = new Error('获取登录二维码失败' + (d ? `: ${JSON.stringify(d).slice(0, 200)}` : ''))
      err.code = 'login-failed'
      err.status = 502
      throw err
    }
    const link = d.qrcode_img_content
    const qrDataUrl = await QRCode.toDataURL(link, { width: 240, margin: 1 })
    loginState = { qrcode: d.qrcode, link, startedAt: Date.now() }
    logger.info('已生成登录二维码，等待扫码')
    return { link, qrDataUrl }
  }

  async function checkLoginStatus() {
    if (!loginState) return 'idle'
    const elapsed = Date.now() - loginState.startedAt
    if (elapsed > 6 * 60 * 1000) {
      loginState = null
      return 'expired'
    }
    try {
      const res = await fetch(`${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(loginState.qrcode)}`)
      const d = await res.json().catch(() => null)
      if (d?.bot_token || d?.status === 'confirmed') {
        channel.setCredentials({ token: d.bot_token, baseUrl: ILINK_BASE, loginTime: new Date().toISOString() })
        loginState = null
        return 'confirmed'
      }
      if (d?.status === 'expired') {
        loginState = null
        return 'expired'
      }
      return d?.status === 'scaned' ? 'scanned' : 'waiting'
    } catch (error) {
      const err = new Error(`登录状态查询失败: ${error?.message ?? String(error)}`)
      err.code = 'login-failed'
      err.status = 502
      throw err
    }
  }

  // ---------- 自动续期：iLink 会话约 24h（服务端限制），到期前推新二维码到微信，扫码后原子替换 token ----------
  const relogin = { lastAskAt: 0, timer: null }
  function stopReloginPolling() {
    if (relogin.timer) { clearInterval(relogin.timer); relogin.timer = null }
  }
  function startReloginPolling() {
    if (relogin.timer) return
    relogin.timer = setInterval(async () => {
      try {
        const s = await checkLoginStatus()
        if (s === 'confirmed') {
          logger.info('自动续期成功：新凭据已生效')
          stopReloginPolling()
        } else if (s === 'expired') {
          stopReloginPolling()
        }
      } catch { /* 单次失败忽略，下轮重试 */ }
    }, 3000)
  }
  async function maybeAutoRelogin() {
    if (!channel.ready || !channel.creds?.loginTime) return
    const ageMs = Date.now() - new Date(channel.creds.loginTime).getTime()
    const remaining = RECONNECT.ttlMs - ageMs
    if (remaining > RECONNECT.warnBeforeMs) return // 未到预警时间
    // 目标用户：最近活跃的微信会话
    let target = null
    let lastAt = 0
    for (const [userId, entry] of sessions) {
      if (entry.lastActivityAt > lastAt) { lastAt = entry.lastActivityAt; target = userId }
    }
    if (!target) return // 无可推送用户，跳过（仍可在设置页手动扫码）
    const urgent = remaining <= RECONNECT.forceMs
    if (!urgent && relogin.lastAskAt && Date.now() - relogin.lastAskAt < RECONNECT.remindMs) return // 提醒间隔未到
    relogin.lastAskAt = Date.now()
    try {
      const { link } = await startLogin()
      const hours = Math.max(0.5, Math.round(remaining / 3600000 * 10) / 10)
      const text = `【微信桥接】登录凭据将于约 ${hours} 小时后过期${urgent ? '（即将过期，请尽快扫码）' : ''}。点击链接扫码即可续期，全程不断线：\n${link}`
      await channel.sendText(target, text)
      logger.info(`已向 ${target} 推送续期二维码（剩余约 ${hours}h）`)
      startReloginPolling()
    } catch (error) {
      logger.error(`自动续期推送失败: ${error?.message ?? String(error)}`)
    }
  }

  ctx.effect(() => {
    channel.start()
    void maybeAutoRelogin()
    const ticker = setInterval(() => void maybeAutoRelogin(), RECONNECT.checkIntervalMs)
    return () => {
      stopReloginPolling()
      clearInterval(ticker)
      channel.stop()
    }
  })

  // 回复工具：agent 用 wechat_reply 主动推送消息（每轮文字回复已由插件自动转发）
  ctx.tools.register(defineTool({
    name: 'wechat_reply',
    description: '发送微信消息给用户（iLink ClawBot 通道）。注意：当前对话若来自微信用户，你每轮的文字回复会被自动转发回该用户的微信，无需调用本工具；本工具用于主动推送消息（例如任务完成通知、异步提醒）。',
    parameters: {
      user_id: { type: 'string', required: true, description: '目标微信用户 ID（来自收到的消息）' },
      text: { type: 'string', required: true, description: '消息文本' },
    },
    output: {
      schema: {
        type: 'object',
        // DSH 值 schema DSL：必填用属性级 required: true，不支持 JSON Schema 的
        // 对象级 required: [...]（否则启动时报 UNSUPPORTED_SCHEMA）。
        properties: { success: { type: 'boolean', required: true } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.success ? '消息已发送 ✓' : '发送失败 ✗' }],
    },
    async execute(args) {
      if (!channel.ready) throw new Error('微信凭据未配置')
      await channel.sendText(args.user_id, args.text)
      return { success: true }
    },
  }))

  if (!channel.ready) {
    logger.warn('未检测到凭据。登录方法: node <pkg>/login.mjs <stateDir>')
  }

  // 会话级提示：告诉微信会话里的 agent 它正通过微信与用户对话
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'wechat-bridge',
      order: 60,
      text: (context) => {
        const session = context?.agent?.session
        const sid = typeof session?.id === 'string' ? session.id : session?.header?.id
        if (!sid || !sid.startsWith('wechat-')) return ''
        return '你是通过微信（iLink ClawBot）与用户对话的 AI 助手。\n'
          + '- 你拥有与 dsh 桌面会话相同的完整能力（文件读写、命令执行、联网搜索、图像分析等），请放手使用工具完成任务。\n'
          + '- 用户的每条微信消息都会注入本会话；你每轮的最终文字回复会自动发回用户的微信，无需额外操作。\n'
          + '- 如果你想主动推送消息给用户（例如任务完成通知、异步提醒），使用 wechat_reply 工具。\n'
          + '- 用户发送的图片/语音等非文本消息会以占位文本 [非文本消息] 呈现，当前通道暂不支持接收媒体内容，请礼貌地向用户说明。'
      },
    })
  }

  // 自动转发：把 wechat 会话每轮 agent 的最终文字回复发回微信
  // 事件流里区分真实用户消息（source.kind === 'user'）与系统注入的上下文快照（source.kind === 'plugin'），
  // 避免快照事件把待转发内容清掉。
  ctx.on('session/event', (subject, event) => {
    const sid = typeof subject?.id === 'string' ? subject.id : subject?.header?.id
    if (!sid || !wechatBySession.has(sid)) return
    const userId = wechatBySession.get(sid)
    try {
      if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
        pendingReplies.set(sid, { userId, text: '', toolSent: false })
      } else if (event.type === 'assistant/message') {
        const text = extractAssistantText(event.data?.message)
        if (text) {
          const prev = pendingReplies.get(sid) ?? { userId, text: '', toolSent: false }
          pendingReplies.set(sid, { ...prev, text })
        }
      } else if (event.type === 'tool/call' && event.data?.name === 'wechat_reply') {
        const prev = pendingReplies.get(sid)
        if (prev) pendingReplies.set(sid, { ...prev, toolSent: true })
      } else if (event.type === 'turn/end') {
        const pending = pendingReplies.get(sid)
        if (pending?.text && !pending.toolSent) {
          channel.sendText(userId, pending.text).catch((error) => {
            logger.error(`自动转发回复失败: ${error.message}`)
          })
        }
        pendingReplies.delete(sid)
      }
    } catch (error) {
      logger.error(`会话事件处理失败: ${error.message}`)
    }
  })

  // ---------- 设置界面 HTTP API（浏览器端同源 fetch 调用） ----------
  // 模式对照 dsh-better-sidebar：插件自有 fenced routes → 进程内调用 settings seam，
  // 不依赖 api-proxy 的暴露白名单，也不污染模型提供方目录。
  ctx.effect(() => {
      const writeJson = (res, status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      const writeOk = (res, value) => writeJson(res, 200, { ok: true, value })
      const writeError = (res, status, code, message) => writeJson(res, status, { ok: false, error: { code, message } })
      const readBody = (req) => new Promise((resolve) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve(text ? JSON.parse(text) : {})
          } catch {
            resolve({})
          }
        })
      })
      // 浏览器信任围栏（对照 dsh-client-connection 的栅栏语义）：loopback Host +
      // 同源标记；跨站页面无法触达。
      const fence = (req) => {
        const host = req.headers?.host
        if (!host) return false
        let hostname
        try { hostname = new URL(`http://${host}`).hostname } catch { return false }
        const loopback = hostname === 'localhost' || hostname === '[::1]'
          || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
        if (!loopback) return false
        if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
        const origin = req.headers?.origin
        if (origin === undefined) return true
        try { return new URL(origin).host === host } catch { return false }
      }
      const handlers = {
        'settings.get': () => {
          const s = currentSettings()
          const creds = channel.creds
          return {
            values: {
              provider: s.provider ?? '',
              model: s.model ?? '',
              reasoningEffort: s.reasoningEffort ?? '',
              agentPreset: s.agentPreset ?? '',
              dmPolicy: s.dmPolicy ?? 'pairing',
              allowFrom: s.allowFrom ?? [],
            },
            writable: settingsScope !== undefined,
            credentials: creds?.token
              ? {
                  ready: true,
                  loginTime: creds.loginTime ?? null,
                  ageHours: creds.loginTime
                    ? (Date.now() - new Date(creds.loginTime).getTime()) / 3600000
                    : null,
                  remainingHours: creds.loginTime
                    ? Math.max(0, (RECONNECT.ttlMs - (Date.now() - new Date(creds.loginTime).getTime())) / 3600000)
                    : null,
                  ttlHours: 24,
                }
              : { ready: false },
            sessionCount: sessions.size,
          }
        },
        'settings.update': async (payload) => {
          if (!settingsScope) {
            const err = new Error('设置服务不可用（settings 未挂载）')
            err.code = 'settings-unavailable'
            err.status = 503
            throw err
          }
          const patch = payload?.patch
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            const err = new Error('patch 必须是普通对象')
            err.code = 'bad-request'
            err.status = 400
            throw err
          }
          await settingsScope.update(patch)
          return { updated: true }
        },
        'sessions.list': async () => {
          const query = ctx.get('sessionQuery')
          const tokens = loadJson(join(config.stateDir, 'context-tokens.json'), {})
          // 已归档（被删除）的会话从列表隐藏
          let archived = null
          try {
            const ws = ctx.get('workspaceRegistry')
            if (ws && Array.isArray(ws.archivedSessionIds)) archived = new Set(ws.archivedSessionIds)
          } catch { /* 归档服务不可用时不过滤 */ }
          const hidden = (id) => archived !== null && archived.has(id)
          const rows = []
          try {
            if (query && typeof query.listSessions === 'function') {
              const records = await query.listSessions()
              for (const rec of records) {
                const id = rec?.header?.id
                if (!id || !id.startsWith('wechat-') || hidden(id)) continue
                const rest = id.slice('wechat-'.length)
                const dash = rest.lastIndexOf('-')
                const sanitized = dash > 0 ? rest.slice(0, dash) : rest
                const userId = typeof tokens === 'object' && tokens
                  ? Object.keys(tokens).find((u) => sanitizeId(u) === sanitized) || sanitized
                  : sanitized
                rows.push({
                  sessionId: id,
                  userId,
                  cwd: rec.header?.cwd ?? null,
                  createdAt: rec.header?.createdAt ?? null,
                  live: !!rec.live,
                  persisted: !!rec.persisted,
                })
              }
            }
          } catch (error) {
            logger.error(`会话列表失败: ${error?.message ?? String(error)}`)
          }
          // 补充内存中活跃但尚未持久化的
          for (const [userId, entry] of sessions) {
            if (!rows.some((r) => r.sessionId === entry.sessionId) && !hidden(entry.sessionId)) {
              rows.push({
                sessionId: entry.sessionId,
                userId,
                cwd: null,
                createdAt: null,
                live: true,
                persisted: false,
              })
            }
          }
          rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
          return { sessions: rows }
        },
        'sessions.remove': async (payload) => {
          const sessionId = payload?.sessionId
          if (typeof sessionId !== 'string' || !sessionId) {
            const err = new Error('sessionId 必填')
            err.code = 'bad-request'
            err.status = 400
            throw err
          }
          // 1) 活跃会话：拆卸 agent（停止循环、注销、从 store 移除会话）
          const userId = wechatBySession.get(sessionId)
          if (userId !== undefined) {
            const entry = sessions.get(userId)
            if (entry && entry.handle && typeof entry.handle.dispose === 'function') {
              try {
                await entry.handle.dispose()
                logger.info(`已拆卸会话 ${sessionId}（${userId}）`)
              } catch (error) {
                logger.error(`拆卸会话失败: ${error?.message ?? String(error)}`)
              }
            }
            sessions.delete(userId)
            wechatBySession.delete(sessionId)
            pendingReplies.delete(sessionId)
          }
          // 2) 持久化会话：归档（dsh 删除会话的标准机制，从侧栏等界面隐藏）
          try {
            const ws = ctx.get('workspaceRegistry')
            if (ws && typeof ws.archiveSession === 'function') {
              await ws.archiveSession(sessionId)
            }
          } catch (error) {
            // 会话可能从未持久化（纯内存），归档报 UnknownSession 属预期，忽略
            logger.debug(`归档会话 ${sessionId} 跳过: ${error?.message ?? String(error)}`)
          }
          return { removed: true }
        },
        'login.start': () => startLogin(),
        'login.status': () => checkLoginStatus().then((status) => ({ status })),
      }
      return ctx.webServer.register({
        kind: 'prefix',
        path: '/_dsh/wechat-bridge/api',
        handler: async (req, res) => {
          if (!fence(req)) {
            writeError(res, 403, 'forbidden', 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            writeError(res, 405, 'method-error', 'method not allowed')
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith('/_dsh/wechat-bridge/api/')
            ? pathname.slice('/_dsh/wechat-bridge/api/'.length)
            : undefined
          if (method === undefined || method.includes('/')) {
            writeError(res, 404, 'not-found', 'unknown method')
            return
          }
          try {
            const payload = await readBody(req)
            const handler = handlers[method]
            if (handler === undefined) {
              writeError(res, 404, 'not-found', `unknown method "${method}"`)
              return
            }
            writeOk(res, await handler(payload))
          } catch (error) {
            writeError(res, error?.status ?? 400, error?.code ?? 'internal', error?.message ?? String(error))
          }
        },
      })
    }, 'wechat-bridge: settings api route')
}
