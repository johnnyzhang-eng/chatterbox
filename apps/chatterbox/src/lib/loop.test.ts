import { afterEach, expect, mock, test } from 'bun:test'
import { effect, signal, untracked } from '@preact/signals'

import type { SendDanmakuResult } from './api'
import type { SendPriority, SendSource } from './send-queue'
import type { SendObserver } from './send-stats'

import * as sendControl from './send-control'
import { createSendTracker } from './send-stats'

const source = await Bun.file(new URL('./loop.ts', import.meta.url)).text()
const cleanups: (() => void)[] = []
let moduleId = 0

async function flush(): Promise<void> {
  await Bun.sleep(0)
}

async function createHarness(options: { limit?: number; enabled?: boolean } = {}) {
  const settings = {
    activeTemplateIndex: signal(0),
    autoSendMaxMessages: signal(options.limit ?? 0),
    autoSendYolo: signal(false),
    availableDanmakuColors: signal<string[]>([]),
    cachedRoomId: signal(42),
    forceScrollDanmaku: signal(false),
    invisibleChar: signal(''),
    maxLength: signal(40),
    msgSendInterval: signal(2),
    msgTemplates: signal(['旧内容']),
    randomChar: signal(false),
    randomColor: signal(false),
    randomInterval: signal(false),
    sendMsg: signal(options.enabled ?? true),
  }
  const color = mock(async (_room: number, _csrf: string) => {})
  const polish = mock(async (_slot: string, text: string, _options?: { signal: AbortSignal }) => text)
  const enqueue = mock(
    async (
      _text: string,
      _room: number,
      _csrf: string,
      _priority: SendPriority,
      _source: SendSource,
      guard?: () => boolean,
      observer?: SendObserver
    ): Promise<SendDanmakuResult> => {
      const result: SendDanmakuResult = { success: !guard || guard(), message: _text, isEmoticon: false }
      if (!result.success) result.cancelled = true
      else observer?.onRequestStart?.()
      observer?.onResult?.(result)
      return result
    }
  )
  const log = mock((..._args: unknown[]) => {})
  const cancelQueued = mock((_source?: string) => {})
  const split = mock((text: string, _max: number, _char?: string) => [text])
  const timers = new Map<number, () => void>()
  let timerId = 0
  const dependencies = {
    '@preact/signals': {
      signal,
      untracked,
      effect: (fn: () => void) => {
        const dispose = effect(fn)
        cleanups.push(dispose)
        return dispose
      },
    },
    './api': {
      ensureRoomId: async () => 42,
      fetchEmoticons: async () => {},
      getCsrfToken: () => 'csrf',
      getSpmPrefix: () => '',
      setDanmakuMode: async () => {},
      setRandomDanmakuColor: color,
    },
    './const': { BASE_URL: {} },
    './emoticon': {
      formatLockedEmoticonReject: () => '',
      formatUnavailableEmoticonReject: () => '',
      isEmoticonUnique: () => false,
      isLockedEmoticon: () => false,
      isUnavailableEmoticon: () => false,
    },
    './llm-tasks': { isLlmReady: () => true, polishWithLlm: polish },
    './log': { appendLog: log },
    './replacement': { applyReplacements: (text: string) => text, buildReplacementMap: () => {} },
    './send-control': {
      automaticSendGuard: sendControl.automaticSendGuard,
      onAutomaticSendStop: (listener: () => void) => {
        const unsubscribe = sendControl.onAutomaticSendStop(listener)
        cleanups.push(unsubscribe)
        return unsubscribe
      },
    },
    './send-queue': { enqueueDanmaku: enqueue, cancelQueuedDanmaku: cancelQueued, SendPriority: { AUTO: 0 } },
    './store': settings,
    './utils': { processMessages: split, resolveSendDelayMs: () => 2000 },
    './wbi': { cachedWbiKeys: null, encodeWbi: () => '', waitForWbiKeys: async () => {} },
    clock: {
      setTimeout: (callback: () => void) => {
        const id = ++timerId
        timers.set(id, callback)
        return id
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  }
  const key = `__loopTest${++moduleId}`
  Reflect.set(globalThis, key, dependencies)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const injected = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(path)}];`
  })
  let engine: typeof import('./loop')
  try {
    const code = `const {setTimeout, clearTimeout} = globalThis[${JSON.stringify(key)}].clock;\n${injected}`
    engine = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
  cleanups.push(() => {
    settings.sendMsg.value = false
    engine.cancelLoop()
  })
  return {
    engine,
    cancelQueued,
    settings,
    color,
    polish,
    enqueue,
    log,
    split,
    advance: async () => {
      const next = timers.entries().next().value
      if (!next) throw new Error('No loop timer to advance')
      timers.delete(next[0])
      next[1]()
      await flush()
    },
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

test('parking during the color request prevents the old round sending after restart', async () => {
  const h = await createHarness()
  const oldColor = Promise.withResolvers<void>()
  const currentColor = Promise.withResolvers<void>()
  h.settings.randomColor.value = true
  h.color.mockImplementationOnce(() => oldColor.promise).mockImplementationOnce(() => currentColor.promise)
  void h.engine.loop()
  await flush()
  h.engine.cancelLoop()
  h.settings.sendMsg.value = false
  h.settings.msgTemplates.value = ['新内容']
  h.settings.sendMsg.value = true
  oldColor.resolve()
  await flush()
  expect(h.color).toHaveBeenCalledTimes(2)
  expect(h.enqueue).not.toHaveBeenCalled()
  h.settings.sendMsg.value = false
  currentColor.resolve()
  await flush()
})

test('a failure from another automatic producer prevents a late polish from enqueuing', async () => {
  const h = await createHarness()
  const oldPolish = Promise.withResolvers<string>()
  const currentPolish = Promise.withResolvers<string>()
  h.settings.autoSendYolo.value = true
  h.polish.mockImplementationOnce(() => oldPolish.promise).mockImplementationOnce(() => currentPolish.promise)
  void h.engine.loop()
  await flush()
  sendControl.stopAutomaticSends()
  expect(h.settings.sendMsg.value).toBe(false)
  h.settings.msgTemplates.value = ['新内容']
  h.settings.sendMsg.value = true
  oldPolish.resolve('过期润色')
  await flush()
  expect(h.polish).toHaveBeenCalledTimes(2)
  expect(h.enqueue).not.toHaveBeenCalled()
  h.settings.sendMsg.value = false
  currentPolish.resolve('已停止')
  await flush()
})

test('an actual rejection stops the round without a completion log or another segment', async () => {
  const h = await createHarness()
  h.settings.msgTemplates.value = ['第一段\n第二段']
  h.enqueue.mockImplementationOnce(async (text, _room, _csrf, _priority, _source, _guard, observer) => {
    observer?.onRequestStart?.()
    const result = { success: false, isEmoticon: false, message: text, error: 'rejected' }
    observer?.onResult?.(result)
    sendControl.stopAutomaticSends()
    return result
  })
  void h.engine.loop()
  await flush()
  expect(h.enqueue).toHaveBeenCalledTimes(1)
  expect(h.settings.sendMsg.value).toBe(false)
  expect(h.log.mock.calls.some(call => typeof call[0] === 'string' && call[0].includes('轮发送完成'))).toBe(false)
})

for (const limit of [1, 2]) {
  test(`a limit of ${limit} stops after actual requests across template rounds`, async () => {
    const h = await createHarness({ limit })
    void h.engine.loop()
    await flush()
    for (let i = 1; i < limit; i++) await h.advance()
    expect(h.enqueue).toHaveBeenCalledTimes(limit)
    expect(h.engine.autoSendRun.value).toMatchObject({
      limit,
      requests: limit,
      accepted: limit,
      failed: 0,
      active: false,
      stopReason: 'limit',
    })
    expect(h.settings.sendMsg.value).toBe(false)
    await h.advance()
    expect(h.enqueue).toHaveBeenCalledTimes(limit)
  })
}

test('zero retains unlimited valid sending and counter updates do not start new batches', async () => {
  const h = await createHarness()
  const runId = h.engine.autoSendRun.value.runId
  void h.engine.loop()
  await flush()
  await h.advance()
  await h.advance()
  expect(h.engine.autoSendRun.value).toMatchObject({ runId, requests: 3, accepted: 3, active: true, limit: 0 })
  h.engine.cancelLoop()
  expect(h.settings.sendMsg.value).toBe(false)
  expect(h.engine.autoSendRun.value.stopReason).toBe('manual')
})

test('YOLO overlength output consumes the limit per actual segment and stops before more preparation', async () => {
  const h = await createHarness({ limit: 2 })
  h.settings.autoSendYolo.value = true
  h.settings.randomColor.value = true
  h.settings.msgTemplates.value = ['草稿\n不应继续润色']
  h.polish.mockImplementation(async () => '甲|乙|丙')
  h.split.mockImplementation((text: string) => text.split('|'))
  void h.engine.loop()
  await flush()
  await h.advance()
  expect(h.enqueue.mock.calls.map(call => call[0])).toEqual(['甲', '乙'])
  expect(h.polish).toHaveBeenCalledTimes(1)
  expect(h.color).toHaveBeenCalledTimes(2)
  expect(h.engine.autoSendRun.value).toMatchObject({ requests: 2, accepted: 2, stopReason: 'limit' })
})

test('the Nth dispatch guard remains valid for its acceptance notification', async () => {
  const h = await createHarness({ limit: 1 })
  const acceptedNotifications: string[] = []
  h.enqueue.mockImplementation(async (text, _room, _csrf, _priority, _source, guard, observer) => {
    expect(guard?.()).toBe(true)
    observer?.onRequestStart?.()
    const result = { success: true, message: text, isEmoticon: false }
    observer?.onResult?.(result)
    expect(h.engine.autoSendRun.value.requests).toBe(1)
    if (guard?.()) acceptedNotifications.push(text)
    return result
  })
  void h.engine.loop()
  await flush()
  expect(acceptedNotifications).toEqual(['旧内容'])
  expect(h.engine.autoSendRun.value.stopReason).toBe('limit')
})

test('old in-flight receipts neither count toward nor stop a rapidly restarted batch', async () => {
  const h = await createHarness({ limit: 1 })
  const oldReceipt = Promise.withResolvers<SendDanmakuResult>()
  h.enqueue.mockImplementationOnce(async (text, _room, _csrf, _priority, _source, _guard, observer) => {
    observer?.onRequestStart?.()
    const result = await oldReceipt.promise
    observer?.onResult?.(result)
    return { ...result, message: text }
  })
  void h.engine.loop()
  await flush()
  const oldRunId = h.engine.autoSendRun.value.runId
  h.engine.cancelLoop()
  h.settings.autoSendMaxMessages.value = 2
  h.settings.sendMsg.value = true
  const newRunId = h.engine.autoSendRun.value.runId
  expect(newRunId).toBeGreaterThan(oldRunId)
  expect(h.engine.autoSendRun.value).toMatchObject({ requests: 0, accepted: 0, active: true, limit: 2 })
  oldReceipt.resolve({ success: false, message: 'old', isEmoticon: false, error: 'old rejection' })
  await flush()
  expect(h.engine.autoSendRun.value).toMatchObject({
    runId: newRunId,
    requests: 1,
    accepted: 1,
    failed: 0,
    active: true,
    stopReason: null,
  })
  await h.advance()
  expect(h.engine.autoSendRun.value).toMatchObject({ requests: 2, accepted: 2, failed: 0, stopReason: 'limit' })
})

test('restored enabled state starts a batch without using the UI button and the limit is a snapshot', async () => {
  const h = await createHarness({ enabled: false, limit: 2 })
  expect(h.engine.autoSendRun.value.runId).toBe(0)
  h.settings.sendMsg.value = true
  const restoredRun = h.engine.autoSendRun.value
  expect(restoredRun).toMatchObject({ runId: 1, limit: 2, active: true, requests: 0 })
  h.settings.autoSendMaxMessages.value = 7
  expect(h.engine.autoSendRun.value).toEqual(restoredRun)
  h.settings.sendMsg.value = false
  h.settings.sendMsg.value = true
  expect(h.engine.autoSendRun.value).toMatchObject({ runId: 2, limit: 7, active: true, requests: 0 })
})

test('preparation errors and empty polish stop without consuming a request', async () => {
  for (const emptyPolish of [false, true]) {
    const h = await createHarness({ limit: 2 })
    if (emptyPolish) {
      h.settings.autoSendYolo.value = true
      h.polish.mockImplementationOnce(async () => '')
    } else {
      h.settings.randomColor.value = true
      h.color.mockImplementationOnce(async () => {
        throw new Error('color preparation failed')
      })
    }
    void h.engine.loop()
    await flush()
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.engine.autoSendRun.value).toMatchObject({
      requests: 0,
      accepted: 0,
      preparationFailed: 1,
      active: false,
      stopReason: 'preparation-error',
    })
  }
})

test('a cancelled queue item stops the batch without counting a POST', async () => {
  const h = await createHarness({ limit: 2 })
  h.enqueue.mockImplementationOnce(async (text, _room, _csrf, _priority, _source, _guard, observer) => {
    const result = { success: false, cancelled: true, message: text, isEmoticon: false, error: 'cancelled' }
    observer?.onResult?.(result)
    return result
  })
  void h.engine.loop()
  await flush()
  expect(h.engine.autoSendRun.value).toMatchObject({
    requests: 0,
    accepted: 0,
    failed: 0,
    cancelled: 1,
    preparationFailed: 0,
    active: false,
    stopReason: 'cancelled',
  })
})

test('a queue preparation exception is counted once without pretending it was a request', async () => {
  const h = await createHarness({ limit: 2 })
  h.enqueue.mockImplementationOnce(async (text, _room, _csrf, _priority, _source, _guard, observer) => {
    observer?.onResult?.({ success: false, message: text, isEmoticon: false, error: 'prepare' })
    throw new Error('prepare')
  })
  void h.engine.loop()
  await flush()
  expect(h.engine.autoSendRun.value).toMatchObject({
    requests: 0,
    failed: 0,
    preparationFailed: 1,
    stopReason: 'preparation-error',
  })
})

for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`invalid limit ${limit} refuses to run instead of becoming unlimited`, async () => {
    const h = await createHarness({ limit })
    void h.engine.loop()
    await flush()
    expect(h.settings.sendMsg.value).toBe(false)
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.engine.autoSendRun.value).toMatchObject({
      requests: 0,
      preparationFailed: 1,
      active: false,
      stopReason: 'preparation-error',
    })
  })
}

test('duplicate loop startup cannot create concurrent producers for one batch', async () => {
  const h = await createHarness({ limit: 1 })
  void h.engine.loop()
  void h.engine.loop()
  await flush()
  expect(h.enqueue).toHaveBeenCalledTimes(1)
  expect(h.engine.autoSendRun.value.requests).toBe(1)
})

test('the real queue broadcasts the Nth acceptance before the loop stops at its hard cap', async () => {
  const h = await createHarness({ limit: 1 })
  const sendDanmaku = mock(async (message: string, _room: number, _csrf: string, observer?: SendObserver) => {
    const tracker = createSendTracker(observer)
    tracker.start()
    return tracker.settle({ success: true, message, isEmoticon: false })
  })
  const key = `__loopQueueTest${++moduleId}`
  const dependencies = {
    './api': { sendDanmaku },
    './send-control': {
      ...sendControl,
      onAutomaticSendStop: (listener: () => void) => {
        const unsubscribe = sendControl.onAutomaticSendStop(listener)
        cleanups.push(unsubscribe)
        return unsubscribe
      },
    },
    './send-stats': { createSendTracker },
  }
  Reflect.set(globalThis, key, dependencies)
  const queueSource = await Bun.file(new URL('./send-queue.ts', import.meta.url)).text()
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(queueSource)
  const injected = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked queue import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(path)}];`
  })
  let queue: typeof import('./send-queue')
  try {
    queue = await import(`data:text/javascript;base64,${Buffer.from(injected).toString('base64')}`)
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
  h.enqueue.mockImplementation(queue.enqueueDanmaku)
  h.cancelQueued.mockImplementation(source => {
    if (source === 'loop') queue.cancelQueuedDanmaku('loop')
  })
  const sent = mock(() => {
    expect(h.engine.autoSendRun.value).toMatchObject({ requests: 1, accepted: 1, active: true })
    expect(h.settings.sendMsg.value).toBe(true)
  })
  queue.onDanmakuSent(sent)
  void h.engine.loop()
  await flush()
  expect(sendDanmaku).toHaveBeenCalledTimes(1)
  expect(sent).toHaveBeenCalledTimes(1)
  expect(h.engine.autoSendRun.value).toMatchObject({ requests: 1, accepted: 1, active: false, stopReason: 'limit' })
})

test('draft edits apply next round without changing the already snapshotted round', async () => {
  const h = await createHarness({ limit: 3 })
  h.settings.msgTemplates.value = ['旧一\n旧二']
  void h.engine.loop()
  await flush()
  h.settings.msgTemplates.value = ['新模板']
  await h.advance()
  await h.advance()
  expect(h.enqueue.mock.calls.map(call => call[0])).toEqual(['旧一', '旧二', '新模板'])
  expect(h.engine.autoSendRun.value).toMatchObject({ requests: 3, accepted: 3, stopReason: 'limit' })
})

for (const [limit, expectedRounds] of [
  [3, 1],
  [6, 2],
  [2, 0],
]) {
  test(`limit ${limit} records ${expectedRounds} completed rounds and stops immediately`, async () => {
    const h = await createHarness({ limit })
    h.settings.msgTemplates.value = ['第一句\n第二句\n第三句']
    void h.engine.loop()
    await flush()
    for (let i = 1; i < limit; i++) await h.advance()
    const completionLogs = () =>
      h.log.mock.calls.map(call => call[0]).filter(entry => typeof entry === 'string' && entry.includes('轮发送完成'))
    expect(completionLogs()).toEqual(Array.from({ length: expectedRounds }, (_, i) => `🔵第 ${i + 1} 轮发送完成`))
    expect(h.engine.autoSendRun.value).toMatchObject({
      requests: limit,
      accepted: limit,
      active: false,
      stopReason: 'limit',
    })
    expect(h.settings.sendMsg.value).toBe(false)
    await h.advance()
    expect(h.enqueue).toHaveBeenCalledTimes(limit)
    expect(completionLogs()).toHaveLength(expectedRounds)
  })
}

test('a limit ending on the final YOLO output segment completes exactly one round', async () => {
  const h = await createHarness({ limit: 3 })
  h.settings.autoSendYolo.value = true
  h.polish.mockImplementationOnce(async () => '甲|乙|丙')
  h.split.mockImplementation((text: string) => text.split('|'))
  void h.engine.loop()
  await flush()
  await h.advance()
  expect(h.log.mock.calls.some(call => typeof call[0] === 'string' && call[0].includes('轮发送完成'))).toBe(false)
  await h.advance()
  expect(h.log.mock.calls.filter(call => typeof call[0] === 'string' && call[0].includes('轮发送完成'))).toEqual([
    ['🔵第 1 轮发送完成'],
  ])
  expect(h.engine.autoSendRun.value).toMatchObject({ requests: 3, active: false, stopReason: 'limit' })
})
