/**
 * iCloud Hide My Email 集成
 *
 * 两块功能：
 *   1. HmeApiClient —— 调用 Apple p68-maildomainws.icloud.com 的 /v1/hme/{generate,reserve,list}
 *      原理参考 hidemyemail-generator，核心是用 iCloud 网页版导出的 cookie 串做鉴权，
 *      generate 拿到候选地址，reserve 把地址锁定到当前 Apple ID 名下；
 *   2. IcloudImapClient —— 直连 imap.mail.me.com:993 (TLS+LOGIN)，
 *      用 Apple 应用专用密码读主邮箱里的 HME 转发邮件，按 To/Delivered-To/X-Original-To
 *      头匹配指定 HME 地址，提取验证码。
 *
 * 不引入新 npm 依赖：HTTP 走 undici + 现有 systemProxy；IMAP 用 node:tls 裸 socket 实现，
 * 自己解析 IMAP 字面量 ({N} 块) 以正确拿到 HEADER.FIELDS 与 TEXT。
 */

import * as tls from 'tls'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { getSystemProxy, safeCreateProxyAgent } from '../proxy/systemProxy'

// ============ Apple HME HTTP API ============

const HME_BASE_V1 = 'https://p68-maildomainws.icloud.com/v1/hme'
const HME_BASE_V2 = 'https://p68-maildomainws.icloud.com/v2/hme'

/**
 * Apple HME 调用必带的查询参数。clientId/dsid 留空即可（cookie 自带身份），
 * clientBuildNumber/clientMasteringNumber 沿用 hidemyemail-generator 的常量；
 * 这套常量随 Apple 网页改版需要更新，但目前可用。
 */
const HME_PARAMS = {
  clientBuildNumber: '2536Project32',
  clientMasteringNumber: '2536B20',
  clientId: '',
  dsid: ''
}

function getRegistrationProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    getSystemProxy() ||
    undefined
  )
}

function buildHmeHeaders(cookie: string): Record<string, string> {
  return {
    Connection: 'keep-alive',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Content-Type': 'text/plain',
    Accept: '*/*',
    'Sec-GPC': '1',
    Origin: 'https://www.icloud.com',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: 'https://www.icloud.com/',
    'Accept-Language': 'en-US,en-GB;q=0.9,en;q=0.8,cs;q=0.7',
    'sec-ch-ua': '"Brave";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    Cookie: cookie.trim()
  }
}

function appendParams(url: string): string {
  const usp = new URLSearchParams(HME_PARAMS as unknown as Record<string, string>)
  return `${url}?${usp.toString()}`
}

async function hmeFetch(
  url: string,
  init: UndiciRequestInit & { cookie: string }
): Promise<{ status: number; data: Record<string, unknown> }> {
  const { cookie, ...rest } = init
  const agent = safeCreateProxyAgent(getRegistrationProxyUrl())
  const opts: UndiciRequestInit = {
    ...rest,
    headers: { ...(rest.headers as Record<string, string> | undefined), ...buildHmeHeaders(cookie) },
    dispatcher: agent || undefined
  }
  const resp = await undiciFetch(url, opts)
  let data: Record<string, unknown> = {}
  try {
    data = (await resp.json()) as Record<string, unknown>
  } catch {
    /* ignore JSON parse errors — surface raw status */
  }
  return { status: resp.status, data }
}

export interface GenerateResult {
  success: boolean
  hme?: string
  error?: string
}

export interface ReserveResult {
  success: boolean
  /** anonymousId 用于后续 deactivate */
  anonymousId?: string
  hme?: string
  error?: string
}

export interface ListEntry {
  hme: string
  label: string
  note?: string
  anonymousId: string
  isActive: boolean
  createTimestamp: number
}

/** Apple HME 错误结构（已观察到三种形态）→ 统一摘成单行可读字串 */
function pickErrorMessage(data: Record<string, unknown>, status: number): string {
  if (typeof data.reason === 'string') return data.reason
  const err = data.error
  if (err && typeof err === 'object') {
    const errObj = err as Record<string, unknown>
    if (typeof errObj.errorMessage === 'string') return errObj.errorMessage
  }
  if (typeof data.errorMessage === 'string') return data.errorMessage
  return `HTTP ${status}`
}

export class HmeApiClient {
  constructor(private readonly cookie: string) {
    if (!cookie || !cookie.trim()) throw new Error('iCloud cookie 为空')
  }

  /** 仅生成候选地址（未占用），不会消耗配额 */
  async generate(): Promise<GenerateResult> {
    try {
      const { status, data } = await hmeFetch(appendParams(`${HME_BASE_V1}/generate`), {
        method: 'POST',
        cookie: this.cookie,
        body: JSON.stringify({ langCode: 'en-us' }),
        signal: AbortSignal.timeout(30000)
      })
      if (data.success !== true) {
        return { success: false, error: pickErrorMessage(data, status) }
      }
      const result = data.result as Record<string, unknown> | undefined
      const hme = (result?.hme as string) || ''
      if (!hme) return { success: false, error: 'response missing result.hme' }
      return { success: true, hme }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 把 generate 得到的地址锁定到账户名下，开始消耗配额（每 30 分钟 5×家庭成员） */
  async reserve(hme: string, label: string, note: string): Promise<ReserveResult> {
    try {
      const { status, data } = await hmeFetch(appendParams(`${HME_BASE_V1}/reserve`), {
        method: 'POST',
        cookie: this.cookie,
        body: JSON.stringify({ hme, label, note }),
        signal: AbortSignal.timeout(30000)
      })
      if (data.success !== true) {
        return { success: false, error: pickErrorMessage(data, status), hme }
      }
      const result = data.result as Record<string, unknown> | undefined
      const hmeObj = result?.hme as Record<string, unknown> | undefined
      const anonymousId = (hmeObj?.anonymousId as string) || ''
      return { success: true, hme, anonymousId }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        hme
      }
    }
  }

  /** 一次性 generate+reserve；失败时尽量给出可读原因 */
  async createOne(label: string, note: string): Promise<ReserveResult> {
    const gen = await this.generate()
    if (!gen.success || !gen.hme) {
      return { success: false, error: gen.error || 'generate failed' }
    }
    const res = await this.reserve(gen.hme, label, note)
    return res
  }

  /** 列出账户下所有 HME（用于校验 cookie 有效性 / 同步） */
  async list(): Promise<{ success: boolean; entries?: ListEntry[]; error?: string }> {
    try {
      const { status, data } = await hmeFetch(appendParams(`${HME_BASE_V2}/list`), {
        method: 'GET',
        cookie: this.cookie,
        signal: AbortSignal.timeout(30000)
      })
      if (data.success !== true) {
        return { success: false, error: pickErrorMessage(data, status) }
      }
      const result = data.result as Record<string, unknown> | undefined
      const raw = (result?.hmeEmails as Array<Record<string, unknown>>) || []
      const entries: ListEntry[] = raw.map((r) => ({
        hme: String(r.hme || ''),
        label: String(r.label || ''),
        note: r.note ? String(r.note) : undefined,
        anonymousId: String(r.anonymousId || ''),
        isActive: r.isActive === true,
        createTimestamp: Number(r.createTimestamp) || 0
      }))
      return { success: true, entries }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 把 HME 标记为停用（不返还配额，但不再接收转发）。
   * 用于"注册失败的 HME 不复用"场景：先标 failed 留在池里防再分配，
   * 再可选异步调本接口在 Apple 侧关掉。
   */
  async deactivate(anonymousId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { status, data } = await hmeFetch(appendParams(`${HME_BASE_V1}/deactivateEmail`), {
        method: 'POST',
        cookie: this.cookie,
        body: JSON.stringify({ anonymousId }),
        signal: AbortSignal.timeout(30000)
      })
      if (data.success !== true) return { success: false, error: pickErrorMessage(data, status) }
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ============ iCloud IMAP 取码 ============

const IMAP_HOST = 'imap.mail.me.com'
const IMAP_PORT = 993

/** 把 Date 格式化为 IMAP SEARCH SINCE 接受的 "DD-Mon-YYYY" 形式（GMT） */
function formatImapDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}

/**
 * iCloud IMAP 客户端：手写最小 IMAP4rev1 子集，覆盖 LOGIN / SELECT / SEARCH / FETCH。
 * 不依赖 imap-tools 或 node-imap 等第三方包，避免引入额外原生依赖。
 *
 * 关键点：FETCH 响应包含字面量块 ({N}\r\n + N 字节)，需要自己识别字面量并按字节数读取，
 * 不能纯按 \r\n 切行。`readLogicalLine()` 是核心。
 */
export class IcloudImapClient {
  private socket: tls.TLSSocket | null = null
  private buffer = Buffer.alloc(0)
  private waiters: Array<() => void> = []
  private endError: Error | null = null
  private tagCounter = 0

  /** 建立 TLS 连接并消费服务器 greeting (`* OK ...`) */
  async connect(timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(IMAP_PORT, IMAP_HOST, { servername: IMAP_HOST })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('iCloud IMAP 连接超时'))
      }, timeoutMs)

      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      socket.once('secureConnect', () => {
        clearTimeout(timer)
        this.socket = socket
        // 持久化数据监听：所有读操作都从 this.buffer 取，事件只负责喂数据
        socket.on('data', (chunk: Buffer) => {
          this.buffer = Buffer.concat([this.buffer, chunk])
          this.drainWaiters()
        })
        socket.once('error', (err) => {
          this.endError = err
          this.drainWaiters()
        })
        socket.once('end', () => {
          this.endError = this.endError || new Error('iCloud IMAP 连接已关闭')
          this.drainWaiters()
        })
        // 读 greeting，再 resolve（greeting 失败也算连接失败）
        this.readLineRaw(timeoutMs)
          .then((line) => {
            if (!line.startsWith('* OK')) {
              reject(new Error(`iCloud IMAP greeting 异常: ${line.slice(0, 120)}`))
              return
            }
            resolve()
          })
          .catch(reject)
      })
    })
  }

  close(): void {
    if (this.socket) {
      try {
        this.socket.write('A999 LOGOUT\r\n')
      } catch {
        /* ignore */
      }
      try {
        this.socket.destroy()
      } catch {
        /* ignore */
      }
      this.socket = null
    }
  }

  /** 应用专用密码登录（必须 2FA 后从 appleid.apple.com 生成） */
  async login(email: string, appPassword: string, timeoutMs = 15000): Promise<void> {
    // 用户名密码内可能包含空格（很少见），全部加引号比较稳；引号内的 " 用 \" 转义
    const u = quoteImap(email)
    const p = quoteImap(appPassword)
    const tag = await this.sendCommand(`LOGIN ${u} ${p}`)
    const { result } = await this.readUntilTag(tag, timeoutMs)
    if (!/^[A-Z]\d+\s+OK\b/.test(result)) {
      throw new Error(`iCloud IMAP 登录失败: ${result}`)
    }
  }

  /** 选 INBOX，返回 EXISTS（用作"已有邮件总数"基准） */
  async selectInbox(timeoutMs = 15000): Promise<{ exists: number }> {
    const tag = await this.sendCommand('SELECT INBOX')
    const { lines, result } = await this.readUntilTag(tag, timeoutMs)
    if (!/^[A-Z]\d+\s+OK\b/.test(result)) throw new Error(`SELECT INBOX 失败: ${result}`)
    let exists = 0
    for (const line of lines) {
      const m = line.match(/\*\s+(\d+)\s+EXISTS/)
      if (m) {
        exists = parseInt(m[1], 10)
        break
      }
    }
    return { exists }
  }

  /** SEARCH SINCE <date>，返回符合条件的邮件序号（按 SEQ 不是 UID）升序 */
  async searchSince(since: Date, timeoutMs = 15000): Promise<number[]> {
    const tag = await this.sendCommand(`SEARCH SINCE ${formatImapDate(since)}`)
    const { lines, result } = await this.readUntilTag(tag, timeoutMs)
    if (!/^[A-Z]\d+\s+OK\b/.test(result)) throw new Error(`SEARCH 失败: ${result}`)
    for (const line of lines) {
      const m = line.match(/^\*\s+SEARCH\s*(.*)$/)
      if (m) {
        const ids = m[1]
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((s) => parseInt(s, 10))
          .filter((n) => !Number.isNaN(n))
        return ids.sort((a, b) => a - b)
      }
    }
    return []
  }

  /**
   * 一次取邮件的（HEADER 子集 + TEXT），返回原始字符串。
   * 用 BODY.PEEK 不会改变 \Seen 状态；TEXT 可能很大，因此调用方有责任筛选目标邮件后再 fetch。
   *
   * HEADER.FIELDS 同时拉 CONTENT-TYPE / CONTENT-TRANSFER-ENCODING：单段邮件（非 multipart）的
   * BODY[TEXT] 不带任何元信息，必须用 message-level 头才知道怎么解码；multipart 也需要从 message
   * 头提取 boundary。AWS 投递到 iCloud HME 的邮件是 multipart/alternative，boundary 形如
   * `----=_Part_xxxx.yyyy`，靠 body 第一行启发式识别会被开头的多个 `-` 干扰，header 抓最稳。
   */
  async fetchHeaderAndText(
    seq: number,
    timeoutMs = 30000
  ): Promise<{ headers: string; text: string } | null> {
    const cmd =
      `FETCH ${seq} (BODY.PEEK[HEADER.FIELDS ` +
      `(TO CC DELIVERED-TO X-ORIGINAL-TO X-FORWARDED-TO X-APPLE-ORIGINAL-TO SUBJECT FROM ` +
      `CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] ` +
      `BODY.PEEK[TEXT])`
    const tag = await this.sendCommand(cmd)
    const { lines, result } = await this.readUntilTag(tag, timeoutMs)
    if (!/^[A-Z]\d+\s+OK\b/.test(result)) return null

    // 把 untagged 行拼回完整的 FETCH 响应文本，再用正则切出 HEADER 和 TEXT 字面量
    const joined = lines.join('\n')
    const headerMatch = joined.match(
      /BODY\[HEADER\.FIELDS [^\]]*\]\s*\{(\d+)\}\r?\n([\s\S]*?)(?=\s+BODY\[TEXT\]|\)\s*$|\)\r?\n)/
    )
    const textMatch = joined.match(/BODY\[TEXT\]\s*\{(\d+)\}\r?\n([\s\S]*?)(?=\)\s*$|\)\r?\n|$)/)
    const grabLiteral = (m: RegExpMatchArray | null): string => {
      if (!m) return ''
      const n = parseInt(m[1], 10)
      const content = m[2] || ''
      return content.length >= n ? content.slice(0, n) : content
    }
    return {
      headers: grabLiteral(headerMatch),
      text: grabLiteral(textMatch)
    }
  }

  // ---------- 私有：协议层读写 ----------

  private async sendCommand(cmd: string): Promise<string> {
    if (!this.socket) throw new Error('IMAP 未连接')
    this.tagCounter++
    const tag = `A${String(this.tagCounter).padStart(4, '0')}`
    this.socket.write(`${tag} ${cmd}\r\n`)
    return tag
  }

  /**
   * 读到形如 `<tag> OK/NO/BAD ...` 的 tagged 响应为止，
   * 中间所有 untagged (`* ...`) 与字面量块都收集起来。
   */
  private async readUntilTag(
    tag: string,
    timeoutMs: number
  ): Promise<{ lines: string[]; result: string }> {
    const lines: string[] = []
    const deadline = Date.now() + timeoutMs
    while (true) {
      const remain = Math.max(1000, deadline - Date.now())
      const line = await this.readLogicalLine(remain)
      if (line.startsWith(`${tag} `)) {
        return { lines, result: line }
      }
      lines.push(line)
    }
  }

  /**
   * 读一条"逻辑行"——若行尾出现 `{N}` 则读后续 N 字节作为字面量，
   * 拼接后继续看下一段是否还有更多字面量，直到遇到不带 {N} 的尾巴。
   */
  private async readLogicalLine(timeoutMs: number): Promise<string> {
    let acc = ''
    const deadline = Date.now() + timeoutMs
    while (true) {
      const remain = Math.max(500, deadline - Date.now())
      const line = await this.readLineRaw(remain)
      acc += line
      const m = line.match(/\{(\d+)\}\s*$/)
      if (!m) return acc
      const n = parseInt(m[1], 10)
      const literal = await this.readBytes(n, Math.max(500, deadline - Date.now()))
      acc += '\r\n' + literal.toString('utf-8')
    }
  }

  private async readLineRaw(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (this.endError) throw this.endError
      const idx = this.buffer.indexOf('\r\n')
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx).toString('utf-8')
        this.buffer = this.buffer.slice(idx + 2)
        return line
      }
      const remain = deadline - Date.now()
      if (remain <= 0) throw new Error('IMAP readLine 超时')
      await this.waitForData(remain)
    }
  }

  private async readBytes(n: number, timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs
    while (this.buffer.length < n) {
      if (this.endError) throw this.endError
      const remain = deadline - Date.now()
      if (remain <= 0) throw new Error('IMAP readBytes 超时')
      await this.waitForData(remain)
    }
    const out = this.buffer.slice(0, n)
    this.buffer = this.buffer.slice(n)
    return out
  }

  private waitForData(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        const i = this.waiters.indexOf(notify)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error('IMAP wait 超时'))
      }, timeoutMs)
      const notify = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      this.waiters.push(notify)
    })
  }

  private drainWaiters(): void {
    const w = this.waiters.shift()
    if (w) w()
  }
}

/** IMAP LOGIN 接受 quoted string；用引号包起来并把 " 与 \ 转义，防止用户名/密码含空格 */
function quoteImap(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// ============ 验证码定位（按 HME 收件人筛选 + 提取 6 位码） ============

/**
 * IMAP `BODY[TEXT]` 拉到的是原始 message body，AWS 验证码邮件常见两种结构：
 *   A) multipart/alternative：text/plain 段（OTP 明文）+ text/html 段（base64/QP）
 *   B) 单段 text/html quoted-printable（AWS 投递到 iCloud HME 时见过这种）
 *
 * 直接全文 regex 扫 6 位数字会把 HTML/CSS/base64 里的随机数字片段（颜色、像素、年份、长 ID）
 * 当成 OTP，导致拿到一个像 OTP 但实际错的 6 位串提交给 AWS → INVALID_OTP。
 *
 * 这里做最小可用的 MIME 解析：
 *   - boundary 优先从 message-level Content-Type 头取（最可靠）
 *   - 若无 boundary 则按单段处理，根据 message-level transfer-encoding 解码
 *   - 按 part 拆分后按各 part 自己的 transfer-encoding 解码
 *   - text/html 段做 HTML 标签剥离（保留 OTP 周围的中英文标签词）
 */
function decodeMimeBody(rawBody: string, messageHeaders?: string): string[] {
  if (!rawBody) return []
  const lowerMsgHeaders = (messageHeaders || '').toLowerCase()

  // 优先从 message header 抓 boundary（最可靠）；没有再从 body 第一行启发式找
  let boundary: string | null = null
  const headerBoundary = lowerMsgHeaders.match(
    /content-type:\s*multipart\/[^\r\n]*?boundary\s*=\s*"?([^"\r\n;]+)"?/i
  )
  if (headerBoundary) {
    boundary = headerBoundary[1]
  } else {
    // body 第一段非空行如果是 `--<token>` 形式，token 可包含 - / = / _ 等任意 boundary 字符
    const m = rawBody.match(/^--([A-Za-z0-9'()+_,./:=?-]+?)\s*$/m)
    if (m) boundary = m[1]
  }

  if (!boundary) {
    // 单段邮件：根据 message-level CTE 解码整体
    return [decodeOnePart(rawBody, lowerMsgHeaders)]
  }

  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sep = new RegExp(`--${escaped}(?:--)?\\r?\\n?`, 'g')
  const segments = rawBody.split(sep).filter((s) => s && s.trim() && s.trim() !== '--')

  const out: string[] = []
  for (const seg of segments) {
    const headerEndIdx = seg.search(/\r?\n\r?\n/)
    if (headerEndIdx < 0) continue
    const partHeaders = seg.slice(0, headerEndIdx).toLowerCase()
    const partBody = seg.slice(headerEndIdx).replace(/^\r?\n\r?\n/, '')

    const ct = (partHeaders.match(/content-type:\s*([^\r\n;]+)/) || [, 'text/plain'])[1]!.trim()
    if (ct.startsWith('multipart/') || !ct.startsWith('text/')) continue

    const decoded = decodeOnePart(partBody, partHeaders)
    if (decoded.trim()) out.push(decoded)
  }
  return out
}

function decodeOnePart(body: string, lowerHeaders: string): string {
  const ct = (lowerHeaders.match(/content-type:\s*([^\r\n;]+)/) || [, 'text/plain'])[1]!.trim()
  const cte = (lowerHeaders.match(/content-transfer-encoding:\s*([^\r\n]+)/) || [, '7bit'])[1]!
    .trim()
    .toLowerCase()

  let decoded = body
  if (cte === 'base64') {
    try {
      decoded = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8')
    } catch {
      decoded = ''
    }
  } else if (cte === 'quoted-printable') {
    decoded = body
      .replace(/=\r?\n/g, '') // 软换行
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  }

  if (ct === 'text/html') {
    // 标签换空格而非删除：避免 `<span>36px</span><span>740808</span>` 拼成 `36px740808` 出现假 6 位
    decoded = decoded
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&\w+;/g, ' ')
      .replace(/\s+/g, ' ')
  }

  return decoded
}

/** 默认匹配 4-8 位独立数字；前后都不挨数字，避免误命中订单号 */
const DEFAULT_OTP_PATTERN = /(?<!\d)(\d{4,8})(?!\d)/g

/**
 * 从邮件正文里找 6 位 AWS 验证码。
 * 优先级：
 *   1. 紧贴关键词的 6 位（中英文：`Verification code` / `验证码：` / `code is` / `Your code`）
 *   2. 任一解码段里第一个独立 6 位数字（AWS 标准长度）
 *   3. 第一个 4-8 位独立数字（兜底）
 *
 * 关键修正：
 *   - 取"第一个匹配"而不是"最后一个"——AWS 邮件里 OTP 几乎总在正文上半段；
 *     后面的数字（CSS 像素、客服电话、版权年份、消息 ID）反而是噪声。
 *   - 关键词覆盖中文，因为投递给中国 IP 的 iCloud 邮箱，AWS 会发中文邮件。
 *   - 接收 headers 参数：单段邮件必须用 message-level Content-Type/Encoding 才能解码。
 */
export function extractOtpFromText(text: string, headers?: string): string {
  if (!text) return ''
  const segments = decodeMimeBody(text, headers)
  const candidates = segments.length > 0 ? segments : [text]

  // 1) 关键词附近的 6 位（中英文都覆盖；冒号支持英文 `:` 与中文 `：`）
  const labeledRe =
    /(?:verification[\s\w]{0,20}code|验证码|your\s+code|code\s+(?:is|:))[\s:：.\-]*\s*(\d{6})\b/i
  for (const seg of candidates) {
    const m = seg.match(labeledRe)
    if (m) return m[1]
  }
  // 2) 第一个独立 6 位
  for (const seg of candidates) {
    const m = seg.match(/(?<!\d)(\d{6})(?!\d)/)
    if (m) return m[1]
  }
  // 3) 第一个 4-8 位
  for (const seg of candidates) {
    const m = seg.match(DEFAULT_OTP_PATTERN)
    if (m && m.length > 0) return m[0]
  }
  return ''
}

/**
 * 解析"原始 RFC 822 头字符串"里所有可能出现 HME 地址的字段，返回小写邮箱集合。
 * 关注：To, Cc, Delivered-To, X-Original-To, X-Forwarded-To, X-Apple-Original-To
 */
export function extractRecipientsFromHeaders(headers: string): Set<string> {
  const out = new Set<string>()
  if (!headers) return out
  // 头域可能跨行折叠，先把折行还原
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ')
  const lines = unfolded.split(/\r?\n/)
  const interesting = /^(to|cc|delivered-to|x-original-to|x-forwarded-to|x-apple-original-to)\s*:/i
  for (const line of lines) {
    if (!interesting.test(line)) continue
    const value = line.slice(line.indexOf(':') + 1)
    const matches = value.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g)
    if (matches) {
      for (const m of matches) out.add(m.toLowerCase())
    }
  }
  return out
}

/**
 * 在已建立连接的 IMAP client 上轮询找一封发到 hmeAddress 的邮件，提取验证码。
 * 注：这是历史实现（只看 SEARCH SINCE 范围内任意匹配收件人的邮件），会拉到该 HME 此前注册过的旧码。
 * 注册流程请改用 waitForIcloudOtpFromBaseline（基线模式，仅看 send-otp 之后到达的新邮件）。
 */
export async function findOtpInIcloudInbox(
  email: string,
  appPassword: string,
  hmeAddress: string,
  sinceMin: number,
  signal: AbortSignal | undefined,
  log: (msg: string) => void
): Promise<string> {
  const target = hmeAddress.trim().toLowerCase()
  if (!target) throw new Error('hmeAddress 为空')
  const client = new IcloudImapClient()
  try {
    await client.connect()
    await client.login(email, appPassword)
    const { exists } = await client.selectInbox()
    // SEARCH 需要 since 日期；UTC 减 1 天保证跨日不漏
    const since = new Date(Date.now() - Math.max(sinceMin, 60) * 60 * 1000 - 24 * 3600 * 1000)
    const ids = await client.searchSince(since)

    const candidates = ids.length > 0 ? ids.slice().reverse() : exists > 0 ? [exists] : []
    if (candidates.length === 0) return ''

    const SCAN_LIMIT = 25
    const toScan = candidates.slice(0, SCAN_LIMIT)

    for (const seq of toScan) {
      if (signal?.aborted) throw new Error('注册已取消')
      const msg = await client.fetchHeaderAndText(seq, 30000)
      if (!msg) continue
      const recips = extractRecipientsFromHeaders(msg.headers)
      if (!recips.has(target)) continue
      const code = extractOtpFromText(msg.text, msg.headers)
      if (code) {
        log(`[iCloud IMAP] seq=${seq} 收件人匹配，验证码: ${code}`)
        return code
      }
      log(`[iCloud IMAP] seq=${seq} 收件人匹配但暂未提取到验证码，继续扫描`)
    }
    return ''
  } finally {
    client.close()
  }
}

/** 测连：登录成功并 SELECT INBOX 就算通过 */
export async function testIcloudImap(
  email: string,
  appPassword: string
): Promise<{ success: boolean; mailboxCount?: number; error?: string }> {
  const client = new IcloudImapClient()
  try {
    await client.connect()
    await client.login(email, appPassword)
    const { exists } = await client.selectInbox()
    return { success: true, mailboxCount: exists }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    client.close()
  }
}

/** 取一次 INBOX 的 EXISTS 数，作为"send-otp 之前"的基线，与 step10 等待新邮件配套用 */
export async function getIcloudInboxCount(email: string, appPassword: string): Promise<number> {
  const client = new IcloudImapClient()
  try {
    await client.connect()
    await client.login(email, appPassword)
    const { exists } = await client.selectInbox()
    return exists
  } finally {
    client.close()
  }
}

/**
 * 基线模式取码：与 Outlook 现有 waitForOTP 同款设计。
 *   - 把 send-otp 之前的 EXISTS 数当 baseline；
 *   - 轮询时只扫 baseline+1 .. current 这批"新邮件"，避免拉到该 HME 历史里的旧 AWS 邮件
 *     （HME 是真实可复用地址，之前注册过的话收件箱里会有旧码，按收件人匹配是命中不过滤的）；
 *   - 收件人精确匹配 + 提取出 6 位码 才算成功；EXISTS 不增长则继续等。
 */
export async function waitForIcloudOtpFromBaseline(
  email: string,
  appPassword: string,
  hmeAddress: string,
  baselineCount: number,
  timeoutSec: number,
  intervalSec: number,
  signal: AbortSignal | undefined,
  log: (m: string) => void
): Promise<string> {
  const target = hmeAddress.trim().toLowerCase()
  if (!target) throw new Error('hmeAddress 为空')
  const interval = Math.max(1, intervalSec)
  const maxRetries = Math.max(1, Math.floor(timeoutSec / interval))

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('注册已取消')
    // 起步先停一拍：AWS 邮件投递通常 5-15s，避免第一秒就空跑
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval * 1000)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new Error('注册已取消'))
      }
      if (signal?.aborted) {
        clearTimeout(timer)
        reject(new Error('注册已取消'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })

    const client = new IcloudImapClient()
    try {
      await client.connect()
      await client.login(email, appPassword)
      const { exists } = await client.selectInbox()

      if (exists <= baselineCount) {
        if (attempt % 5 === 0) {
          log(
            `[iCloud IMAP] [${attempt}/${maxRetries}] 暂无新邮件 (当前 ${exists} 封, baseline ${baselineCount})`
          )
        }
        continue
      }

      // 倒序扫描"新到的邮件"，最多 baseline+1 ..= exists
      // 通常 AWS 验证码邮件就 1 封，立即命中
      for (let seq = exists; seq > baselineCount; seq--) {
        if (signal?.aborted) throw new Error('注册已取消')
        const msg = await client.fetchHeaderAndText(seq, 30000)
        if (!msg) continue
        const recips = extractRecipientsFromHeaders(msg.headers)
        if (!recips.has(target)) continue
        const code = extractOtpFromText(msg.text, msg.headers)
        if (code) {
          log(
            `[iCloud IMAP] seq=${seq} (baseline 后第 ${seq - baselineCount} 封) 收件人匹配，验证码: ${code}`
          )
          return code
        }
        // 收件人匹配但提取不到码：dump 一段正文便于诊断（比如 AWS 改了邮件结构 / boundary 异常）
        const preview = msg.text.replace(/\s+/g, ' ').slice(0, 300)
        log(`[iCloud IMAP] seq=${seq} 收件人匹配但未提取到 OTP，正文片段: ${preview}`)
      }
      if (attempt % 5 === 0) {
        log(
          `[iCloud IMAP] [${attempt}/${maxRetries}] ${exists - baselineCount} 封新邮件中未找到匹配码`
        )
      }
    } catch (err) {
      if (attempt % 5 === 0) log(`[iCloud IMAP] [${attempt}/${maxRetries}] 查询失败: ${err}`)
    } finally {
      client.close()
    }
  }
  throw new Error(`等待验证码超时 (${timeoutSec}s)`)
}
