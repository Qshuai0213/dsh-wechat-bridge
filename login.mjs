// 微信 iLink ClawBot 登录工具（真实端点，实测可用）
// 用法: node login.mjs [stateDir]
// 默认: $DSH_HOME/channels/wechat（无 DSH_HOME 时 ~/.dsh/channels/wechat）
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const stateDir = process.argv[2]
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'channels', 'wechat')

const base = 'https://ilinkai.weixin.qq.com'

console.log(`目标目录: ${stateDir}\n`)

// 1. 获取登录二维码（真实端点）
const r1 = await fetch(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`)
const d1 = await r1.json()
if (d1.ret !== 0) throw new Error(`获取二维码失败: ${JSON.stringify(d1)}`)
console.log('📱 手机微信打开以下链接，扫码并确认授权：\n')
console.log(d1.qrcode_img_content)
console.log('')

// 2. 轮询扫码状态（最长 6 分钟）
for (let i = 0; i < 72; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  try {
    const r2 = await fetch(`${base}/ilink/bot/get_qrcode_status?qrcode=${d1.qrcode}`)
    const d2 = await r2.json()
    if (d2.bot_token || d2.status === 'confirmed') {
      const credentials = { token: d2.bot_token, baseUrl: base, loginTime: new Date().toISOString() }
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, 'credentials.json'), JSON.stringify(credentials, null, 2), { mode: 0o600 })
      console.log('\n✅ 登录成功，凭据已保存:', join(stateDir, 'credentials.json'))
      process.exit(0)
    }
  } catch { /* 继续轮询 */ }
  process.stdout.write('.')
}
console.log('\n❌ 超时（6 分钟），请重新运行')
process.exit(1)
