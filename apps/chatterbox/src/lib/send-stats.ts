import { signal } from '@preact/signals'

import type { SendDanmakuResult } from './api'

export interface SendObserver {
  onRequestStart?: () => void
  onResult?: (result: SendDanmakuResult) => void
}

interface SendTracker extends SendObserver {
  start: () => void
  settle: (result: SendDanmakuResult) => SendDanmakuResult
}

export const pageSendStats = signal({ requests: 0, accepted: 0, failed: 0, cancelled: 0, preparationFailed: 0 })

const sharedTrackers = new WeakMap<SendObserver, SendTracker>()

/** A tracker passed as an observer keeps one operation across queue and API layers. */
export function createSendTracker(observer?: SendObserver): SendTracker {
  const shared = observer && sharedTrackers.get(observer)
  if (shared) return shared
  let started = false
  let settled = false
  const start = () => {
    if (started || settled) return
    started = true
    const stats = pageSendStats.peek()
    pageSendStats.value = { ...stats, requests: stats.requests + 1 }
    try {
      observer?.onRequestStart?.()
    } catch {
      // Observer errors cannot change the send result.
    }
  }
  const settle = (result: SendDanmakuResult): SendDanmakuResult => {
    if (settled) return result
    settled = true
    const field = started
      ? result.success
        ? 'accepted'
        : 'failed'
      : result.cancelled
        ? 'cancelled'
        : 'preparationFailed'
    const stats = pageSendStats.peek()
    pageSendStats.value = { ...stats, [field]: stats[field] + 1 }
    try {
      observer?.onResult?.(result)
    } catch {
      // Observer errors cannot change the send result.
    }
    return result
  }
  const tracker: SendTracker = { start, settle, onRequestStart: start, onResult: settle }
  sharedTrackers.set(tracker, tracker)
  return tracker
}
