/** Global send queue: one POST in flight; cancellation affects only unsent work. */

import type { ActionSource } from '@laplace.live/kakashi-protocol'

import { type SendDanmakuResult, sendDanmaku } from './api'
import { automaticSendGuard, onAutomaticSendStop, stopAutomaticSends } from './send-control'
import { createSendTracker, type SendObserver } from './send-stats'

/** Higher number = higher priority. Manual user actions jump ahead of automation. */
export const SendPriority = {
  AUTO: 0,
  STT: 1,
  /** Copy Ninja shares STT's priority, but remains an automatic source. */
  COPY: 1,
  MANUAL: 2,
} as const

export type SendPriority = (typeof SendPriority)[keyof typeof SendPriority]

/** Feature that produced a send; `copy` = a Copy Ninja mirror copy, which is never re-broadcast. */
export type SendSource = ActionSource | 'copy'

/** A send Bilibili accepted. */
export interface SentDanmaku {
  message: string
  roomId: number
  source: SendSource
}

interface QueueItem {
  message: string
  roomId: number
  csrfToken: string
  priority: SendPriority
  source: SendSource
  guard?: () => boolean
  tracker: ReturnType<typeof createSendTracker>
  resolve: (result: SendDanmakuResult) => void
  reject: (err: unknown) => void
  cancelled: boolean
}

/** Floor gap between sends: Bilibili enforces ~1s/account, +10ms safety. Features may pace slower on top. */
const HARD_MIN_GAP_MS = 1010

const queue: QueueItem[] = []
let processing = false
let lastSendCompletedAt = 0
let waitingItem: QueueItem | null = null
const sentListeners = new Set<(sent: SentDanmaku) => void>()

function cancelItem(item: QueueItem, error = 'cancelled'): void {
  if (item.cancelled) return
  item.cancelled = true
  item.resolve(
    item.tracker.settle({ success: false, cancelled: true, message: item.message, isEmoticon: false, error })
  )
}

/** Cancel unsent items, including one waiting for the dispatch gap; an in-flight POST is unaffected. */
export function cancelQueuedDanmaku(source?: SendSource): void {
  for (const item of queue) {
    if (source === undefined || item.source === source) cancelItem(item)
  }
  if (waitingItem && (source === undefined || waitingItem.source === source)) cancelItem(waitingItem)
}

onAutomaticSendStop(() => cancelQueuedDanmaku())

function isAutomatic(item: QueueItem): boolean {
  return item.priority === SendPriority.AUTO || item.source === 'copy'
}

function isCurrent(item: QueueItem): boolean {
  if (item.cancelled) return false
  try {
    return item.guard?.() ?? true
  } catch {
    return false
  }
}

/** Subscribe to accepted sends (Copy Ninja broadcasts from here); returns the unsubscribe. */
export function onDanmakuSent(listener: (sent: SentDanmaku) => void): () => void {
  sentListeners.add(listener)
  return () => sentListeners.delete(listener)
}

function notifySent(item: QueueItem): void {
  const sent: SentDanmaku = { message: item.message, roomId: item.roomId, source: item.source }
  for (const listener of sentListeners) {
    try {
      listener(sent)
    } catch (err) {
      console.error('[LAPLACE Chatterbox] onDanmakuSent listener failed:', err)
    }
  }
}

/** Insert after all items with priority >= its own (FIFO within a level, highest level first). */
function insertByPriority(item: QueueItem): void {
  let i = queue.length
  while (i > 0 && queue[i - 1].priority < item.priority) i--
  queue.splice(i, 0, item)
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (queue.length > 0) {
      while (queue.length > 0 && queue[0].cancelled) queue.shift()
      const item = queue.shift()
      if (!item) break
      waitingItem = item

      if (lastSendCompletedAt > 0) {
        const sinceLast = Date.now() - lastSendCompletedAt
        if (sinceLast < HARD_MIN_GAP_MS) {
          await new Promise(r => setTimeout(r, HARD_MIN_GAP_MS - sinceLast))
        }
      }
      waitingItem = null
      if (item.cancelled) continue
      if (item.guard) {
        let allowed: boolean
        try {
          allowed = item.guard()
        } catch (err) {
          item.tracker.settle({ success: false, message: item.message, isEmoticon: false, error: String(err) })
          item.reject(err)
          continue
        }
        if (!allowed) {
          cancelItem(item)
          continue
        }
      }
      try {
        const result = item.tracker.settle(await sendDanmaku(item.message, item.roomId, item.csrfToken, item.tracker))
        lastSendCompletedAt = Date.now()
        if (!result.success && !result.cancelled && isAutomatic(item) && isCurrent(item)) stopAutomaticSends()
        if (result.success && (!isAutomatic(item) || isCurrent(item))) notifySent(item)
        item.resolve(result)
      } catch (err) {
        item.tracker.settle({ success: false, message: item.message, isEmoticon: false, error: String(err) })
        lastSendCompletedAt = Date.now()
        if (isAutomatic(item) && isCurrent(item)) stopAutomaticSends()
        item.reject(err)
      }
    }
  } finally {
    processing = false
  }
}

/**
 * Enqueue a danmaku send; resolves with the same {@link SendDanmakuResult} as raw {@link sendDanmaku}.
 * A preempted item (only AUTO, only by MANUAL) resolves with `cancelled: true` rather than a fake send.
 * @param guard Runs right before the POST, after any wait in the queue; `false` resolves `cancelled: true` unsent.
 */
export function enqueueDanmaku(
  message: string,
  roomId: number,
  csrfToken: string,
  priority: SendPriority,
  source: SendSource,
  guard?: () => boolean,
  observer?: SendObserver
): Promise<SendDanmakuResult> {
  if (priority === SendPriority.AUTO || source === 'copy') guard = automaticSendGuard(guard)
  return new Promise((resolve, reject) => {
    const item: QueueItem = {
      message,
      roomId,
      csrfToken,
      priority,
      source,
      guard,
      tracker: createSendTracker(observer),
      resolve,
      reject,
      cancelled: false,
    }
    insertByPriority(item)

    if (priority === SendPriority.MANUAL) {
      if (waitingItem?.priority === SendPriority.AUTO) cancelItem(waitingItem, 'preempted')
      for (const q of queue) {
        if (q !== item && !q.cancelled && q.priority === SendPriority.AUTO) {
          cancelItem(q, 'preempted')
        }
      }
    }

    void processQueue()
  })
}

/** Number of pending (non-cancelled) items. */
export function getQueueDepth(): number {
  return queue.reduce((n, q) => (q.cancelled ? n : n + 1), 0)
}
