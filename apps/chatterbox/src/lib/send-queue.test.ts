import { describe, expect, mock, test } from 'bun:test'

import type { SendDanmakuResult } from './api'
import type { SentDanmaku } from './send-queue'

import { createSendTracker, pageSendStats, type SendObserver } from './send-stats'

const source = await Bun.file(new URL('./send-queue.ts', import.meta.url)).text()
const controlSource = await Bun.file(new URL('./send-control.ts', import.meta.url)).text()
let moduleId = 0

/** Fresh queue module per test, with `sendDanmaku` stubbed through globalThis. */
async function loadQueue() {
  const sendDanmaku = mock(
    async (message: string): Promise<SendDanmakuResult> => ({ success: true, message, isEmoticon: false })
  )
  const key = `__sendQueueTest${++moduleId}`
  const controlJs = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${controlSource}\n// ${key}`)
  const control: typeof import('./send-control') = await import(
    `data:text/javascript;base64,${Buffer.from(controlJs).toString('base64')}`
  )
  const apiSend = async (message: string, _roomId: number, _csrfToken: string, observer?: SendObserver) => {
    const tracker = createSendTracker(observer)
    tracker.start()
    return tracker.settle(await sendDanmaku(message))
  }
  Reflect.set(globalThis, key, { sendDanmaku: apiSend, createSendTracker, ...control })
  // Transpile first so type-only specifiers are gone before the import is swapped.
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const injected = js.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']\.\/(?:api|send-control|send-stats)["'];?/g,
    (_match, names) => `const {${names}} = globalThis[${JSON.stringify(key)}];`
  )
  try {
    const queue: typeof import('./send-queue') = await import(
      `data:text/javascript;base64,${Buffer.from(injected).toString('base64')}`
    )
    return { queue, sendDanmaku, control }
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

describe('enqueueDanmaku guard', () => {
  test('a failing guard cancels the send without posting or notifying', async () => {
    const { queue, sendDanmaku } = await loadQueue()
    const sent = mock((_sent: SentDanmaku) => {})
    queue.onDanmakuSent(sent)
    const result = await queue.enqueueDanmaku('hi', 1, 'csrf', queue.SendPriority.COPY, 'copy', () => false)
    expect(result).toMatchObject({ success: false, cancelled: true })
    expect(sendDanmaku).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
  })

  test('a throwing guard rejects only its own item and the queue keeps draining', async () => {
    const { queue, sendDanmaku } = await loadQueue()
    const broken = queue.enqueueDanmaku('broken', 1, 'csrf', queue.SendPriority.COPY, 'copy', () => {
      throw new Error('boom')
    })
    const next = queue.enqueueDanmaku('next', 1, 'csrf', queue.SendPriority.COPY, 'copy')
    await expect(broken).rejects.toThrow('boom')
    expect(await next).toMatchObject({ success: true })
    expect(sendDanmaku.mock.calls.map(call => call[0])).toEqual(['next'])
  })

  test('the guard runs at dispatch, after the rate-limit wait, not at enqueue', async () => {
    const { queue, sendDanmaku } = await loadQueue()
    let allowed = true
    const first = queue.enqueueDanmaku('first', 1, 'csrf', queue.SendPriority.MANUAL, 'manual')
    const second = queue.enqueueDanmaku('second', 1, 'csrf', queue.SendPriority.COPY, 'copy', () => allowed)
    await first
    allowed = false
    expect(await second).toMatchObject({ cancelled: true })
    expect(sendDanmaku.mock.calls.map(call => call[0])).toEqual(['first'])
  })
})

test('automatic rejection clears queued manual/STT items and notifies producer cleanup once', async () => {
  const { queue, sendDanmaku, control } = await loadQueue()
  const receipt = Promise.withResolvers<SendDanmakuResult>()
  sendDanmaku.mockImplementationOnce(() => receipt.promise)
  const stopped = mock(() => {})
  control.onAutomaticSendStop(stopped)
  const automatic = queue.enqueueDanmaku('loop', 1, 'csrf', queue.SendPriority.AUTO, 'loop')
  const manual = queue.enqueueDanmaku('manual', 1, 'csrf', queue.SendPriority.MANUAL, 'manual')
  const stt = queue.enqueueDanmaku('stt', 1, 'csrf', queue.SendPriority.STT, 'stt')
  receipt.resolve({ success: false, message: 'loop', isEmoticon: false, error: 'rejected' })
  expect(await automatic).toMatchObject({ success: false, error: 'rejected' })
  expect(await manual).toMatchObject({ cancelled: true })
  expect(await stt).toMatchObject({ cancelled: true })
  expect(stopped).toHaveBeenCalledTimes(1)
  expect(sendDanmaku.mock.calls.map(call => call[0])).toEqual(['loop'])
})

test('COPY failure stops automation but equal-priority STT failure does not', async () => {
  for (const source of ['copy', 'stt'] as const) {
    const { queue, sendDanmaku, control } = await loadQueue()
    sendDanmaku.mockImplementationOnce(async message => ({ success: false, message, isEmoticon: false, error: 'f' }))
    const stopped = mock(() => {})
    control.onAutomaticSendStop(stopped)
    await queue.enqueueDanmaku(source, 1, 'csrf', queue.SendPriority.STT, source)
    expect(stopped.mock.calls.length).toBe(source === 'copy' ? 1 : 0)
  }
})

test('automatic request exceptions stop automation and settle the unsent queue', async () => {
  const { queue, sendDanmaku, control } = await loadQueue()
  const request = Promise.withResolvers<SendDanmakuResult>()
  sendDanmaku.mockImplementationOnce(() => request.promise)
  const stopped = mock(() => {})
  control.onAutomaticSendStop(stopped)
  const first = queue.enqueueDanmaku('copy', 1, 'csrf', queue.SendPriority.COPY, 'copy')
  const rejected = first.catch((err: unknown) => err)
  const next = queue.enqueueDanmaku('next', 1, 'csrf', queue.SendPriority.AUTO, 'loop')
  request.reject(new Error('network'))
  expect(await rejected).toMatchObject({ message: 'network' })
  expect(await next).toMatchObject({ cancelled: true })
  expect(stopped).toHaveBeenCalledTimes(1)
  expect(sendDanmaku).toHaveBeenCalledTimes(1)
})

for (const source of ['ai', 'copy'] as const) {
  for (const outcome of ['rejected receipt', 'request exception'] as const) {
    test(`a stale ${source} ${outcome} preserves the raw result without stopping a restarted session`, async () => {
      const { queue, sendDanmaku, control } = await loadQueue()
      const receipt = Promise.withResolvers<SendDanmakuResult>()
      sendDanmaku.mockImplementationOnce(() => receipt.promise)
      const stopped = mock(() => {})
      control.onAutomaticSendStop(stopped)
      let session = 1
      const oldSession = session
      const priority = source === 'copy' ? queue.SendPriority.COPY : queue.SendPriority.AUTO
      const old = queue.enqueueDanmaku('old', 1, 'csrf', priority, source, () => session === oldSession)
      const oldResult = old.catch((err: unknown) => err)
      queue.cancelQueuedDanmaku(source)
      session++
      const newSession = session
      const current = queue.enqueueDanmaku('current', 1, 'csrf', priority, source, () => session === newSession)
      if (outcome === 'request exception') receipt.reject(new Error('old network failure'))
      else receipt.resolve({ success: false, message: 'old', isEmoticon: false, error: 'old rejection' })
      if (outcome === 'request exception') expect(await oldResult).toMatchObject({ message: 'old network failure' })
      else expect(await oldResult).toMatchObject({ success: false, error: 'old rejection' })
      expect(await current).toMatchObject({ success: true })
      expect(stopped).not.toHaveBeenCalled()
      expect(sendDanmaku.mock.calls.map(call => call[0])).toEqual(['old', 'current'])
    })
  }
}

test('an old automatic receipt cannot stop the new global epoch or broadcast a stale acceptance', async () => {
  for (const success of [false, true]) {
    const { queue, sendDanmaku, control } = await loadQueue()
    const receipt = Promise.withResolvers<SendDanmakuResult>()
    sendDanmaku.mockImplementationOnce(() => receipt.promise)
    const stopped = mock(() => {})
    const sent = mock((_sent: SentDanmaku) => {})
    control.onAutomaticSendStop(stopped)
    queue.onDanmakuSent(sent)
    const old = queue.enqueueDanmaku('old', 1, 'csrf', queue.SendPriority.AUTO, 'loop')
    control.stopAutomaticSends()
    const current = queue.enqueueDanmaku('current', 1, 'csrf', queue.SendPriority.AUTO, 'loop')
    receipt.resolve({ success, message: 'old', isEmoticon: false, error: success ? undefined : 'old rejection' })
    expect(await old).toMatchObject({ success, message: 'old' })
    expect(await current).toMatchObject({ success: true })
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls).toEqual([[{ message: 'current', roomId: 1, source: 'loop' }]])
  }
})

test('stop cancels an item already shifted into the rate-limit wait, without cancelling in-flight work', async () => {
  const { queue, sendDanmaku, control } = await loadQueue()
  await queue.enqueueDanmaku('first', 1, 'csrf', queue.SendPriority.MANUAL, 'manual')
  const before = pageSendStats.peek()
  const settled = mock((_result: SendDanmakuResult) => {})
  const waiting = queue.enqueueDanmaku('waiting', 1, 'csrf', queue.SendPriority.AUTO, 'loop', undefined, {
    onResult: settled,
  })
  // The drain has shifted `waiting` and entered its dispatch-gap await.
  control.stopAutomaticSends()
  control.stopAutomaticSends()
  expect(await waiting).toMatchObject({ cancelled: true })
  await Bun.sleep(1050)
  expect(sendDanmaku.mock.calls.map(call => call[0])).toEqual(['first'])
  expect(settled).toHaveBeenCalledTimes(1)
  expect(pageSendStats.peek()).toEqual({ ...before, cancelled: before.cancelled + 1 })
})

test('explicit source stop cancels only that source, including the dispatch-gap item', async () => {
  const { queue, sendDanmaku } = await loadQueue()
  await queue.enqueueDanmaku('first', 1, 'csrf', queue.SendPriority.MANUAL, 'manual')
  const waiting = queue.enqueueDanmaku('copy', 1, 'csrf', queue.SendPriority.COPY, 'copy')
  const stt = queue.enqueueDanmaku('stt', 1, 'csrf', queue.SendPriority.STT, 'stt')
  queue.cancelQueuedDanmaku('copy')
  expect(await waiting).toMatchObject({ cancelled: true })
  expect(await stt).toMatchObject({ success: true })
  expect(sendDanmaku.mock.calls.map(call => call[0])).toEqual(['first', 'stt'])
})

test('a snapshot from before stop cannot enqueue work after producers are restarted', async () => {
  const { queue, sendDanmaku, control } = await loadQueue()
  let enabled = true
  const oldGuard = control.automaticSendGuard(() => enabled)
  enabled = false
  control.stopAutomaticSends()
  enabled = true
  const newGuard = control.automaticSendGuard(() => enabled)
  expect(await queue.enqueueDanmaku('old', 1, 'csrf', queue.SendPriority.AUTO, 'loop', oldGuard)).toMatchObject({
    cancelled: true,
  })
  expect(await queue.enqueueDanmaku('new', 1, 'csrf', queue.SendPriority.AUTO, 'loop', newGuard)).toMatchObject({
    success: true,
  })
  expect(sendDanmaku.mock.calls.map(call => call[0])).toEqual(['new'])
})

test('onDanmakuSent reports accepted sends with their source', async () => {
  const { queue, sendDanmaku } = await loadQueue()
  sendDanmaku.mockImplementationOnce(async message => ({ success: false, message, isEmoticon: false, error: 'f' }))
  const sent = mock((_sent: SentDanmaku) => {})
  queue.onDanmakuSent(sent)
  await queue.enqueueDanmaku('rejected', 1, 'csrf', queue.SendPriority.MANUAL, 'manual')
  await queue.enqueueDanmaku('accepted', 1, 'csrf', queue.SendPriority.AUTO, 'loop')
  expect(sent.mock.calls).toEqual([[{ message: 'accepted', roomId: 1, source: 'loop' }]])
})

test('a cancelled guard and a throwing guard do not count as POST failures', async () => {
  const before = pageSendStats.peek()
  const { queue, sendDanmaku } = await loadQueue()
  const settled = mock((_result: SendDanmakuResult) => {})
  await queue.enqueueDanmaku('cancel', 1, 'csrf', queue.SendPriority.MANUAL, 'manual', () => false, {
    onResult: settled,
  })
  const broken = queue.enqueueDanmaku(
    'prepare',
    1,
    'csrf',
    queue.SendPriority.MANUAL,
    'manual',
    () => {
      throw new Error('broken guard')
    },
    { onResult: settled }
  )
  await expect(broken).rejects.toThrow('broken guard')
  expect(sendDanmaku).not.toHaveBeenCalled()
  expect(settled).toHaveBeenCalledTimes(2)
  expect(pageSendStats.peek()).toEqual({
    ...before,
    cancelled: before.cancelled + 1,
    preparationFailed: before.preparationFailed + 1,
  })
})

test('observer result happens before accepted broadcast, with one page request and one settlement', async () => {
  const before = pageSendStats.peek()
  const { queue } = await loadQueue()
  const events: string[] = []
  queue.onDanmakuSent(() => events.push('accepted broadcast'))
  await queue.enqueueDanmaku('one', 1, 'csrf', queue.SendPriority.AUTO, 'loop', undefined, {
    onRequestStart: () => events.push('request start'),
    onResult: () => events.push('result'),
  })
  events.push('caller continues')
  expect(events).toEqual(['request start', 'result', 'accepted broadcast', 'caller continues'])
  expect(pageSendStats.peek()).toEqual({ ...before, requests: before.requests + 1, accepted: before.accepted + 1 })
})

test('an unexpected API exception after dispatch is recorded once as a request failure', async () => {
  const before = pageSendStats.peek()
  const { queue, sendDanmaku } = await loadQueue()
  sendDanmaku.mockImplementationOnce(async () => {
    throw new Error('unexpected transport exception')
  })
  const settled = mock((_result: SendDanmakuResult) => {})
  await expect(
    queue.enqueueDanmaku('one', 1, 'csrf', queue.SendPriority.MANUAL, 'manual', undefined, {
      onResult: settled,
    })
  ).rejects.toThrow('unexpected transport exception')
  expect(settled).toHaveBeenCalledTimes(1)
  expect(pageSendStats.peek()).toEqual({ ...before, requests: before.requests + 1, failed: before.failed + 1 })
})

test('an old in-flight receipt stays in page totals and its original observer after restart', async () => {
  const before = pageSendStats.peek()
  const { queue, sendDanmaku, control } = await loadQueue()
  const receipt = Promise.withResolvers<SendDanmakuResult>()
  sendDanmaku.mockImplementationOnce(() => receipt.promise)
  let session = 1
  const oldSettled = mock((_result: SendDanmakuResult) => {})
  const newSettled = mock((_result: SendDanmakuResult) => {})
  const old = queue.enqueueDanmaku('old', 1, 'csrf', queue.SendPriority.AUTO, 'loop', () => session === 1, {
    onResult: oldSettled,
  })
  queue.cancelQueuedDanmaku('loop')
  session++
  const stopped = mock(() => {})
  control.onAutomaticSendStop(stopped)
  const current = queue.enqueueDanmaku('current', 1, 'csrf', queue.SendPriority.AUTO, 'loop', () => session === 2, {
    onResult: newSettled,
  })
  receipt.resolve({ success: false, message: 'old', isEmoticon: false, error: 'old rejection' })
  await old
  expect(oldSettled).toHaveBeenCalledTimes(1)
  expect(newSettled).not.toHaveBeenCalled()
  expect(await current).toMatchObject({ success: true })
  expect(newSettled).toHaveBeenCalledTimes(1)
  expect(stopped).not.toHaveBeenCalled()
  expect(pageSendStats.peek()).toEqual({
    ...before,
    requests: before.requests + 2,
    accepted: before.accepted + 1,
    failed: before.failed + 1,
  })
})
