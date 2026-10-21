import type { ActionDeliveryMessage, CopyStatus } from '@laplace.live/kakashi-protocol'

import { getCsrfToken } from '../api'
import { isEmoticonUnique, isLockedEmoticon, isUnavailableEmoticon } from '../emoticon'
import { appendLog } from '../log'
import { enqueueDanmaku, SendPriority } from '../send-queue'
import { cachedRoomId, maxLength } from '../store'
import { formatDanmakuError, processMessages } from '../utils'
import { pickDelayMs, planCopy, shouldFollow } from './decisions'
import {
  copyNinjaDelayMaxSec,
  copyNinjaDelayMinSec,
  copyNinjaDropPercent,
  copyNinjaFollowRoom,
  copyNinjaMasterRoomId,
  copyNinjaPaused,
  isCopySourceEnabled,
  SOURCE_LABELS,
} from './settings'

export type ReportResult = (eventId: string, status: CopyStatus, detail?: string) => void

interface PendingCopy {
  msg: ActionDeliveryMessage
  plannedAt: number
  report: ReportResult
}

/** A copy still unsent this long after its planned time (throttled background tab, long queue) is dropped as stale. */
const STALE_MS = 10_000
const MAX_PENDING = 20
const PAUSE_AFTER_FAILURES = 3
const FOLLOW_DELAY_MIN_SEC = 2
const FOLLOW_DELAY_MAX_SEC = 5

// Copies run one at a time in arrival order, so a master message split into segments can't be copied out of order.
const pending: PendingCopy[] = []
let draining = false
let lastPlannedAt = 0
/** Bumped by {@link cancelPendingCopies}; a copy from an older generation never posts, even from the send queue. */
let generation = 0
let wakeDrain: (() => void) | null = null
let drainTimer: ReturnType<typeof setTimeout> | null = null
let consecutiveFailures = 0

let followTimer: ReturnType<typeof setTimeout> | null = null
let followTimerRoom: number | null = null

/** Apply this mirror's source filter and decay to a master action, then queue the copy after its delay. */
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
  if (pending.length >= MAX_PENDING) {
    report(eventId, 'skipped', '待发送队列已满')
    return
  }
  // Never earlier than the copy before it, so random delays can't reorder copies.
  lastPlannedAt = Math.max(Date.now() + plan.delayMs, lastPlannedAt)
  pending.push({ msg, plannedAt: lastPlannedAt, report })
  void drain()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    wakeDrain = resolve
    drainTimer = setTimeout(resolve, ms)
  })
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (pending.length > 0) {
      const next = pending[0]
      const wait = next.plannedAt - Date.now()
      if (wait > 0) await sleep(wait)
      // A cancel while sleeping empties the queue (and may refill it for a new session).
      if (pending[0] !== next) continue
      pending.shift()
      try {
        await copyAction(next, generation)
      } catch (err) {
        console.error('[LAPLACE Chatterbox] Copy Ninja copy failed:', err)
      }
    }
  } finally {
    draining = false
  }
}

async function copyAction({ msg: { eventId, action }, plannedAt, report }: PendingCopy, gen: number) {
  if (gen !== generation) return
  if (copyNinjaPaused.value) return report(eventId, 'skipped', '分身已暂停')
  if (Date.now() - plannedAt > STALE_MS) return report(eventId, 'skipped', '已过期')
  const roomId = cachedRoomId.value
  if (roomId !== action.roomId) return report(eventId, 'skipped', '不在同一直播间')
  const csrfToken = getCsrfToken()
  if (!csrfToken) return report(eventId, 'failed', '未登录')

  // Re-check emotes and length against THIS account: its unlocks and length cap can differ from the master's.
  if (isUnavailableEmoticon(action.text) || isLockedEmoticon(action.text)) {
    return report(eventId, 'skipped', '该账号无法使用此表情')
  }
  const segments = isEmoticonUnique(action.text) ? [action.text] : processMessages(action.text, maxLength.value)
  const stillWanted = () => gen === generation && !copyNinjaPaused.value && Date.now() - plannedAt <= STALE_MS
  const label = `跟随·${SOURCE_LABELS[action.source]}`
  for (const segment of segments) {
    const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.COPY, 'copy', stillWanted)
    if (result.cancelled) return report(eventId, 'skipped', '已取消')
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

/** Drop queued and in-queue copies (disconnect, stop, pause). */
export function cancelPendingCopies(): void {
  generation++
  pending.length = 0
  lastPlannedAt = 0
  if (drainTimer) clearTimeout(drainTimer)
  drainTimer = null
  wakeDrain?.()
  wakeDrain = null
}

function wantsFollow(target: number): boolean {
  return shouldFollow({
    enabled: copyNinjaFollowRoom.value,
    paused: copyNinjaPaused.value,
    target,
    masterRoomId: copyNinjaMasterRoomId.value,
    currentRoomId: cachedRoomId.value,
  })
}

/** Move to `roomId` after a short random delay; the server only sends this to one following tab per account. */
export function handleFollow(roomId: number): void {
  if (!wantsFollow(roomId) || followTimerRoom === roomId) return
  cancelFollow()
  const delayMs = pickDelayMs(FOLLOW_DELAY_MIN_SEC, FOLLOW_DELAY_MAX_SEC)
  appendLog(`🥷 主控在直播间 ${roomId}，${Math.round(delayMs / 1000)} 秒后跟随`)
  followTimerRoom = roomId
  followTimer = setTimeout(() => {
    followTimer = null
    followTimerRoom = null
    // Re-checked at fire time: the master may have come back, or following may have been turned off.
    if (wantsFollow(roomId)) location.assign(`https://live.bilibili.com/${roomId}`)
  }, delayMs)
}

/**
 * Cancel a pending move once it no longer applies. Reads every input signal before bailing so an `effect` around it
 * re-runs when following is toggled, the master moves, or the pause changes.
 */
export function refreshFollow(): void {
  const enabled = copyNinjaFollowRoom.value
  const paused = copyNinjaPaused.value
  const masterRoomId = copyNinjaMasterRoomId.value
  const currentRoomId = cachedRoomId.value
  if (followTimerRoom === null) return
  if (!shouldFollow({ enabled, paused, target: followTimerRoom, masterRoomId, currentRoomId })) cancelFollow()
}

function cancelFollow(): void {
  if (followTimer) clearTimeout(followTimer)
  followTimer = null
  followTimerRoom = null
}

/** Forget all mirror state when Copy Ninja stops. */
export function resetMirror(): void {
  cancelPendingCopies()
  cancelFollow()
}
