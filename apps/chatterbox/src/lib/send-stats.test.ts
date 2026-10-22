import { expect, mock, test } from 'bun:test'

import type { SendDanmakuResult } from './api'

import { createSendTracker, pageSendStats } from './send-stats'

const result: SendDanmakuResult = { success: true, message: 'offline', isEmoticon: false }

function changeSince(before: typeof pageSendStats.value) {
  const after = pageSendStats.peek()
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, value - before[key as keyof typeof before]])
  )
}

test('one dispatched request and one result are counted once across queue/API layers', () => {
  const before = pageSendStats.peek()
  const observer = { onRequestStart: mock(() => {}), onResult: mock((_result: SendDanmakuResult) => {}) }
  const queued = createSendTracker(observer)
  const api = createSendTracker(queued)
  expect(api).toBe(queued)
  api.start()
  queued.start()
  expect(api.settle(result)).toBe(result)
  queued.settle(result)
  expect(changeSince(before)).toEqual({ requests: 1, accepted: 1, failed: 0, cancelled: 0, preparationFailed: 0 })
  expect(observer.onRequestStart).toHaveBeenCalledTimes(1)
  expect(observer.onResult).toHaveBeenCalledTimes(1)
})

test('a dispatched failure counts as a request failure, not a preparation failure', () => {
  const before = pageSendStats.peek()
  const tracker = createSendTracker()
  tracker.start()
  tracker.settle({ ...result, success: false, error: 'Failed to fetch' })
  expect(changeSince(before)).toEqual({ requests: 1, accepted: 0, failed: 1, cancelled: 0, preparationFailed: 0 })
})

test('cancellation is idempotent and cannot later start a POST', () => {
  const before = pageSendStats.peek()
  const tracker = createSendTracker()
  const cancelled = { ...result, success: false, cancelled: true }
  tracker.settle(cancelled)
  tracker.settle(cancelled)
  tracker.start()
  expect(changeSince(before)).toEqual({ requests: 0, accepted: 0, failed: 0, cancelled: 1, preparationFailed: 0 })
})

test('an error before dispatch is separate from cancellation and request failure', () => {
  const before = pageSendStats.peek()
  createSendTracker().settle({ ...result, success: false, error: 'invalid configuration' })
  expect(changeSince(before)).toEqual({ requests: 0, accepted: 0, failed: 0, cancelled: 0, preparationFailed: 1 })
})

test('throwing observers do not change the request lifecycle or result', () => {
  const before = pageSendStats.peek()
  const tracker = createSendTracker({
    onRequestStart() {
      throw new Error('observer start')
    },
    onResult() {
      throw new Error('observer result')
    },
  })
  expect(() => tracker.start()).not.toThrow()
  expect(tracker.settle(result)).toBe(result)
  expect(changeSince(before)).toEqual({ requests: 1, accepted: 1, failed: 0, cancelled: 0, preparationFailed: 0 })
})

test('reusing an external observer does not merge independent requests', () => {
  const before = pageSendStats.peek()
  const observer = { onRequestStart: mock(() => {}) }
  for (let i = 0; i < 2; i++) {
    const tracker = createSendTracker(observer)
    tracker.start()
    tracker.settle(result)
  }
  expect(observer.onRequestStart).toHaveBeenCalledTimes(2)
  expect(changeSince(before)).toEqual({ requests: 2, accepted: 2, failed: 0, cancelled: 0, preparationFailed: 0 })
})
