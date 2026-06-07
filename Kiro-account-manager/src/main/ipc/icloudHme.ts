/**
 * iCloud Hide My Email 相关 IPC handler
 *
 * 设计原则：
 *   - 渲染进程只能拿到"地址池操作"和"凭据保存/校验"，不参与 IMAP/HME API 直连，
 *     凭据永远不离开主进程；UI 只展示 mainEmail，cookie 与应用专用密码用 ●●● 占位。
 *   - 批量生成本质是循环调 reserve；考虑 Apple 限速（每 30 分钟约 5×家庭成员）与 ~700 总量，
 *     默认两个并发（避免触发风控）+ 每个失败立即停止剩余批次（防止把额度撞到墙后还在跑空）。
 *   - 注册并发场景：UI 在批量启动前先 checkout-batch(N)，主进程一次性原子分配 N 个地址；
 *     不足时按实际给的数量截断；释放/失败标记走单独的 IPC。
 */

import { ipcMain } from 'electron'
import {
  getIcloudHmeCreds,
  saveIcloudHmeCreds,
  getIcloudHmePool,
  getIcloudHmePoolStats,
  addIcloudHmeEntries,
  checkoutIcloudHmeBatch,
  releaseIcloudHmeAddresses,
  markIcloudHmeFailed,
  resetIcloudHmeFailedToFree,
  removeIcloudHmeEntries,
  clearIcloudHmePool,
  HmeApiClient,
  testIcloudImap,
  type HmePoolEntry,
  type IcloudCreds
} from '../registration'

const HME_ADDRESS_RE = /^[a-z0-9._%+-]+@(?:icloud\.com|me\.com|mac\.com)$/i

/** 把存储里的 creds 脱敏一份给 UI 展示（cookie 与应用专用密码不回传明文） */
function redactCreds(c: IcloudCreds): {
  hasCookie: boolean
  cookiePreview: string
  hasAppPassword: boolean
  mainEmail: string
  defaultLabel: string
  defaultNote: string
} {
  return {
    hasCookie: !!c.cookie.trim(),
    cookiePreview: c.cookie ? `${c.cookie.slice(0, 24)}...(${c.cookie.length} chars)` : '',
    hasAppPassword: !!c.appPassword.trim(),
    mainEmail: c.mainEmail,
    defaultLabel: c.defaultLabel || '',
    defaultNote: c.defaultNote || ''
  }
}

export function registerIcloudHmeIpcHandlers(): void {
  // 凭据：保存（cookie 为 undefined 时不覆盖，便于"只更新主邮箱"的场景）
  ipcMain.handle(
    'icloud-hme-save-creds',
    async (
      _e,
      input: {
        cookie?: string
        mainEmail?: string
        appPassword?: string
        defaultLabel?: string
        defaultNote?: string
      }
    ): Promise<{ success: boolean; redacted: ReturnType<typeof redactCreds>; error?: string }> => {
      try {
        const next = await saveIcloudHmeCreds(input)
        return { success: true, redacted: redactCreds(next) }
      } catch (err) {
        return {
          success: false,
          redacted: redactCreds(await getIcloudHmeCreds()),
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  // 凭据：读取（脱敏）
  ipcMain.handle('icloud-hme-get-creds', async () => {
    return redactCreds(await getIcloudHmeCreds())
  })

  // 测 cookie：调一次 list 看是否能拿到现有 HME（同时也能用来核对账户已用配额）
  ipcMain.handle(
    'icloud-hme-test-cookie',
    async (): Promise<{ success: boolean; existingCount?: number; error?: string }> => {
      const creds = await getIcloudHmeCreds()
      if (!creds.cookie.trim()) return { success: false, error: 'cookie 未配置' }
      const api = new HmeApiClient(creds.cookie)
      const r = await api.list()
      if (!r.success) return { success: false, error: r.error || 'list failed' }
      return { success: true, existingCount: r.entries?.length || 0 }
    }
  )

  // 测 IMAP：登录 + SELECT INBOX，返回收件箱总数证明可用
  ipcMain.handle(
    'icloud-hme-test-imap',
    async (): Promise<{ success: boolean; mailboxCount?: number; error?: string }> => {
      const creds = await getIcloudHmeCreds()
      if (!creds.mainEmail || !creds.appPassword) {
        return { success: false, error: '主邮箱或应用专用密码未配置' }
      }
      return testIcloudImap(creds.mainEmail, creds.appPassword)
    }
  )

  // 同步 Apple 现有 HME 列表到本地池（用于"我之前手动建过的也算上"场景）
  ipcMain.handle(
    'icloud-hme-sync-from-apple',
    async (): Promise<{ success: boolean; added?: number; total?: number; error?: string }> => {
      const creds = await getIcloudHmeCreds()
      if (!creds.cookie.trim()) return { success: false, error: 'cookie 未配置' }
      const api = new HmeApiClient(creds.cookie)
      const r = await api.list()
      if (!r.success || !r.entries) return { success: false, error: r.error || 'list failed' }
      const now = Date.now()
      const newEntries: HmePoolEntry[] = r.entries
        .filter((e) => e.isActive)
        .map((e) => ({
          address: e.hme.toLowerCase(),
          source: 'imported' as const,
          status: 'free' as const,
          anonymousId: e.anonymousId,
          label: e.label,
          createdAt: now,
          updatedAt: now
        }))
      const added = await addIcloudHmeEntries(newEntries)
      return { success: true, added, total: newEntries.length }
    }
  )

  // 批量生成：循环调 createOne。任意一次失败即停（多半是配额到墙），先把已得到的存进去
  ipcMain.handle(
    'icloud-hme-generate',
    async (
      _e,
      input: { count: number; label?: string; concurrency?: number }
    ): Promise<{
      success: boolean
      generated: string[]
      failed: number
      error?: string
    }> => {
      const count = Math.max(1, Math.min(input.count || 1, 200))
      const concurrency = Math.max(1, Math.min(input.concurrency || 2, 5))
      const creds = await getIcloudHmeCreds()
      if (!creds.cookie.trim()) {
        return { success: false, generated: [], failed: 0, error: 'cookie 未配置' }
      }
      const api = new HmeApiClient(creds.cookie)
      const label = (input.label || creds.defaultLabel || 'kiro-account-manager').trim()
      const note = creds.defaultNote || 'Generated by Kiro Account Manager'

      const generated: HmePoolEntry[] = []
      let failed = 0
      let lastErr = ''
      let stopped = false

      // 分批跑：每轮起 concurrency 个并发任务，任意一个失败就停整个批次
      let idx = 0
      while (idx < count && !stopped) {
        const batch = Math.min(concurrency, count - idx)
        const tasks: Array<Promise<void>> = []
        for (let i = 0; i < batch; i++) {
          tasks.push(
            (async () => {
              const r = await api.createOne(label, note)
              if (r.success && r.hme) {
                generated.push({
                  address: r.hme.toLowerCase(),
                  source: 'generated',
                  status: 'free',
                  anonymousId: r.anonymousId,
                  label,
                  createdAt: Date.now(),
                  updatedAt: Date.now()
                })
              } else {
                failed++
                lastErr = r.error || 'unknown'
                stopped = true
              }
            })()
          )
        }
        await Promise.all(tasks)
        idx += batch
      }

      // 不管成败，先把已经 reserve 成功的入池（reserve 已扣配额，不入池就浪费）
      if (generated.length > 0) {
        await addIcloudHmeEntries(generated)
      }

      return {
        success: failed === 0,
        generated: generated.map((g) => g.address),
        failed,
        error: lastErr || undefined
      }
    }
  )

  // 导入：把粘贴的地址清单入池（每行一个；忽略非 iCloud 域）
  ipcMain.handle(
    'icloud-hme-import',
    async (
      _e,
      input: { text: string; label?: string }
    ): Promise<{
      success: boolean
      added: number
      ignored: number
      total: number
      error?: string
    }> => {
      const text = String(input.text || '').trim()
      if (!text) return { success: true, added: 0, ignored: 0, total: 0 }
      const lines = text
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
      const valid: HmePoolEntry[] = []
      let ignored = 0
      const now = Date.now()
      for (const line of lines) {
        if (!HME_ADDRESS_RE.test(line)) {
          ignored++
          continue
        }
        valid.push({
          address: line,
          source: 'imported',
          status: 'free',
          label: (input.label || '').trim() || undefined,
          createdAt: now,
          updatedAt: now
        })
      }
      const added = await addIcloudHmeEntries(valid)
      return {
        success: true,
        added,
        ignored,
        total: lines.length
      }
    }
  )

  // 池状态：返回完整列表 + 统计
  ipcMain.handle(
    'icloud-hme-list-pool',
    async (): Promise<{ stats: ReturnType<typeof getIcloudHmePoolStats> extends Promise<infer R> ? R : never; entries: HmePoolEntry[] }> => {
      const [stats, entries] = await Promise.all([getIcloudHmePoolStats(), getIcloudHmePool()])
      return { stats, entries }
    }
  )

  // 批量原子 checkout（注册批量启动时调用一次）
  ipcMain.handle(
    'icloud-hme-checkout',
    async (
      _e,
      input: { count: number; consumedBy?: string }
    ): Promise<{ addresses: string[] }> => {
      const addresses = await checkoutIcloudHmeBatch(
        Math.max(1, input.count || 1),
        input.consumedBy
      )
      return { addresses }
    }
  )

  // 释放（取消批量时退还未使用的）
  ipcMain.handle(
    'icloud-hme-release',
    async (_e, input: { addresses: string[] }): Promise<{ released: number }> => {
      const released = await releaseIcloudHmeAddresses(input.addresses || [])
      return { released }
    }
  )

  // 注册失败标记
  ipcMain.handle(
    'icloud-hme-mark-failed',
    async (_e, input: { address: string; error: string }): Promise<{ success: boolean }> => {
      const ok = await markIcloudHmeFailed(input.address, input.error || 'unknown')
      return { success: ok }
    }
  )

  // 重置 failed → free
  ipcMain.handle('icloud-hme-reset-failed', async (): Promise<{ count: number }> => {
    const count = await resetIcloudHmeFailedToFree()
    return { count }
  })

  // 删除指定地址（仅本地；如需在 Apple 侧同步停用走 deactivate）
  ipcMain.handle(
    'icloud-hme-remove',
    async (_e, input: { addresses: string[] }): Promise<{ removed: number }> => {
      const removed = await removeIcloudHmeEntries(input.addresses || [])
      return { removed }
    }
  )

  // 清空池
  ipcMain.handle('icloud-hme-clear', async (): Promise<{ success: boolean }> => {
    await clearIcloudHmePool()
    return { success: true }
  })
}
