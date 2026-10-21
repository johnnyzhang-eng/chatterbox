import type { ActionDeliveryMessage, CopyStatus } from '@laplace.live/kakashi-protocol'

import { getCsrfToken } from '../api'
import { isEmoticonUnique, isLockedEmoticon, isUnavailableEmoticon } from '../emoticon'
import { appendLog } from '../log'
import { enqueueDanmaku, SendPriority } from '../send-queue'
import { cachedRoomId, maxLength } from '../store'
import { formatDanmakuError, processMessages } from '../utils'
import { pickDelayMs, planCopy } from './decay'
import {
  copyNinjaDelayMaxSec,
  copyNinjaDelayMinSec,
  copyNinjaDropPercent,
  copyNinjaFollowRoom,
  copyNinjaPaused,
  isCopySourceEnabled,
  SOURCE_LABELS,
} from './settings'

export type ReportResult = (eventId: string, status: CopyStatus, detail?: string) => void

/** A copy firing this long after its planned time (throttled background tab, long queue) is dropped as stale. */
const STALE_MS = 10_000
const MAX_PENDING = 20
const PAUSE_AFTER_FAILURES = 3
const FOLLOW_DELAY_MIN_SEC = 2
const FOLLOW_DELAY_MAX_SEC = 5

const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
let followTimer: ReturnType<typeof setTimeout> | null = null
let consecutiveFailures = 0

/** Apply this mirror's source filter and decay to a master action, then copy it after the planned delay. */
export function handleMirrorAction(msg: ActionDeliveryMessage, report: ReportResult): void {
  const { eventId, action } = msg
  if (copyNinjaPaused.value) {
    report(eventId, 'skipped', '分身已暂停')
    return
  }
  const plan = planCopy({
    sourceEnabled: isCopySourceEnabled(action.source),
    dropPercent: copyNinjaDropPercent.value,
    delayMinSec: copyNinjaDelayMinSec.value,
    delayMaxSec: copyNinjaDelayMaxSec.value,
  })
  if (plan.kind === 'skip') {
    report(eventId, 'skipped', plan.reason)
    return
  }
  if (plan.kind === 'drop') {
    appendLog(`🍃 跟随·${SOURCE_LABELS[action.source]}：衰减忽略 ${action.text}`)
    report(eventId, 'dropped', '衰减忽略')
    return
  }
  if (pendingTimers.size >= MAX_PENDING) {
    report(eventId, 'skipped', '待发送队列已满')
    return
  }
  const plannedAt = Date.now() + plan.delayMs
  const timer = setTimeout(() => {
    pendingTimers.delete(timer)
    void copyAction(msg, plannedAt, report)
  }, plan.delayMs)
  pendingTimers.add(timer)
}

async function copyAction({ eventId, action }: ActionDeliveryMessage, plannedAt: number, report: ReportResult) {
  if (copyNinjaPaused.value) return report(eventId, 'skipped', '分身已暂停')
  if (Date.now() - plannedAt > STALE_MS) return report(eventId, 'skipped', '已过期')
  const roomId = cachedRoomId.value
  if (roomId !== action.roomId) return report(eventId, 'skipped', '不在同一直播间')
  const csrfToken = getCsrfToken()
  if (!csrfToken) return report(eventId, 'failed', '未登录')

  // Re-check emotes and length against THIS account: its unlocks and length cap can differ from the master's.
  const isEmote = isEmoticonUnique(action.text)
  if (isEmote && (isLockedEmoticon(action.text) || isUnavailableEmoticon(action.text))) {
    return report(eventId, 'skipped', '该账号无法使用此表情')
  }
  const segments = isEmote ? [action.text] : processMessages(action.text, maxLength.value)
  const label = `跟随·${SOURCE_LABELS[action.source]}`
  for (const segment of segments) {
    const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.COPY, 'copy')
    appendLog(result, label, segment)
    if (!result.success) {
      recordFailure()
      return report(eventId, 'failed', formatDanmakuError(result.error))
    }
  }
  consecutiveFailures = 0
  report(eventId, 'sent')
}

function recordFailure(): void {
  consecutiveFailures++
  if (consecutiveFailures < PAUSE_AFTER_FAILURES || copyNinjaPaused.value) return
  copyNinjaPaused.value = true
  cancelPendingCopies()
  appendLog(`⏸️ 拷贝忍者：连续 ${PAUSE_AFTER_FAILURES} 次跟随失败（可能被禁言或触发风控），已暂停，可在「忍者」页恢复`)
}

/** Clear the pause and failure streak. */
export function resumeMirror(): void {
  consecutiveFailures = 0
  copyNinjaPaused.value = false
}

/** Navigate to the master's room after a short random delay; a newer follow replaces a pending one. */
export function handleFollow(roomId: number): void {
  if (!copyNinjaFollowRoom.value || copyNinjaPaused.value) return
  const current = cachedRoomId.value
  if (current === null || current === roomId) return
  if (followTimer) clearTimeout(followTimer)
  const delayMs = pickDelayMs(FOLLOW_DELAY_MIN_SEC, FOLLOW_DELAY_MAX_SEC)
  appendLog(`🥷 主控前往直播间 ${roomId}，${Math.round(delayMs / 1000)} 秒后跟随`)
  followTimer = setTimeout(() => {
    followTimer = null
    location.assign(`https://live.bilibili.com/${roomId}`)
  }, delayMs)
}

/** Drop scheduled copies and any pending follow (disconnect, stop, pause). */
export function cancelPendingCopies(): void {
  for (const timer of pendingTimers) clearTimeout(timer)
  pendingTimers.clear()
  if (followTimer) clearTimeout(followTimer)
  followTimer = null
}
