import { afterEach, expect, mock, test } from 'bun:test'
import * as signals from '@preact/signals'

import * as sendControl from './send-control'

const source = await Bun.file(new URL('./ai-chat.ts', import.meta.url)).text()
const cleanups: (() => void)[] = []
let moduleId = 0

async function flush(): Promise<void> {
  await Bun.sleep(0)
}

async function createHarness() {
  const { signal } = signals
  const settings = {
    activeLlmProvider: signal({ id: 'test', apiBase: 'https://example.invalid', apiKey: 'test-only', model: 'test' }),
    aiChatEnabled: signal(true),
    aiChatAutoSend: signal(true),
    aiChatContextMaxChars: signal(1000),
    aiChatMaxMessageLength: signal(40),
    aiChatTemperature: signal(0.5),
    aiChatViewerInterval: signal(5),
    aiChatViewerWindow: signal(10),
    sttEndpointReached: signal(false),
    sttTranscriptBuffer: signal(''),
  }
  const llm = mock(async (_options: { signal: AbortSignal }) =>
    JSON.stringify({ send: true, message: '当前结果', reason: 'test' })
  )
  const room = mock(async () => 42)
  const enqueue = mock(
    async (_text: string, _room: number, _csrf: string, _priority: number, _source: string, guard?: () => boolean) => ({
      success: guard?.() ?? true,
      isEmoticon: false,
    })
  )
  const timers = new Set<() => void>()
  const dependencies = {
    '@preact/signals': signals,
    './api': { ensureRoomId: room, getCsrfToken: () => 'csrf' },
    './copy-ninja/settings': { isCopyNinjaMember: () => false },
    './danmaku-stream': { subscribeDanmaku: () => () => {} },
    './llm': { chatCompletion: llm },
    './llm-tasks': { isLlmReady: () => true },
    './log': { appendLog: mock(() => {}) },
    './prompts': { getActiveLlmPrompt: () => 'Test prompt' },
    './send-control': {
      automaticSendGuard: sendControl.automaticSendGuard,
      onAutomaticSendStop: (listener: () => void) => {
        const unsubscribe = sendControl.onAutomaticSendStop(listener)
        cleanups.push(unsubscribe)
        return unsubscribe
      },
    },
    './send-queue': { enqueueDanmaku: enqueue, cancelQueuedDanmaku: mock(() => {}), SendPriority: { AUTO: 0 } },
    './store': settings,
    './utils': { isRecord: (value: unknown) => value !== null && typeof value === 'object' },
    clock: {
      setTimeout: (callback: () => void) => {
        timers.add(callback)
        return callback
      },
      clearTimeout: (callback: () => void) => timers.delete(callback),
    },
  }
  const key = `__aiChatTest${++moduleId}`
  Reflect.set(globalThis, key, dependencies)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const injected = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(path)}];`
  })
  let engine: typeof import('./ai-chat')
  try {
    const code = `const {setTimeout, clearTimeout} = globalThis[${JSON.stringify(key)}].clock;\n${injected}`
    engine = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
  engine.startAiChatEngine()
  cleanups.push(() => engine.stopAiChatEngine())
  return { engine, settings, llm, room, enqueue }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const decision = (message: string) => JSON.stringify({ send: true, message, reason: 'test' })

test('a late AI completion cannot send or release a restarted generation mutex', async () => {
  const h = await createHarness()
  const old = Promise.withResolvers<string>()
  const current = Promise.withResolvers<string>()
  h.llm.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise)
  h.engine.triggerNow()
  await flush()
  h.engine.stopAiChatEngine()
  h.engine.startAiChatEngine()
  h.engine.triggerNow()
  await flush()
  expect(h.llm).toHaveBeenCalledTimes(2)
  old.resolve(decision('过期结果'))
  await flush()
  expect(h.enqueue).not.toHaveBeenCalled()
  expect(h.engine.aiChatStatus.value).toBe('generating')
  h.engine.triggerNow()
  expect(h.llm).toHaveBeenCalledTimes(2)
  current.resolve(decision('当前结果'))
  await flush()
  expect(h.enqueue.mock.calls.map(call => call[0])).toEqual(['当前结果'])
  expect(h.engine.aiChatStatus.value).toBe('idle')
})

test('stopping aborts the old AI request and a late format rejection cannot retry or clear the new controller', async () => {
  const h = await createHarness()
  const old = Promise.withResolvers<string>()
  const current = Promise.withResolvers<string>()
  h.llm.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise)
  h.engine.triggerNow()
  await flush()
  const oldSignal = h.llm.mock.calls[0]?.[0].signal
  h.engine.stopAiChatEngine()
  expect(oldSignal?.aborted).toBe(true)
  h.engine.startAiChatEngine()
  h.engine.triggerNow()
  await flush()
  const currentSignal = h.llm.mock.calls[1]?.[0].signal
  old.reject(new Error('HTTP 400: response_format not supported'))
  await flush()
  expect(h.llm).toHaveBeenCalledTimes(2)
  expect(h.enqueue).not.toHaveBeenCalled()
  expect(h.engine.aiChatStatus.value).toBe('generating')
  expect(currentSignal?.aborted).toBe(false)
  h.engine.stopAiChatEngine()
  expect(currentSignal?.aborted).toBe(true)
  current.resolve(decision('已停止'))
  await flush()
  expect(h.llm).toHaveBeenCalledTimes(2)
  expect(h.enqueue).not.toHaveBeenCalled()
})

test('an automatic failure aborts AI generation and blocks a late format fallback', async () => {
  const h = await createHarness()
  const pending = Promise.withResolvers<string>()
  h.llm.mockImplementationOnce(() => pending.promise)
  h.engine.triggerNow()
  await flush()
  const requestSignal = h.llm.mock.calls[0]?.[0].signal
  sendControl.stopAutomaticSends()
  expect(requestSignal?.aborted).toBe(true)
  pending.reject(new Error('HTTP 422: response_format unsupported'))
  await flush()
  expect(h.llm).toHaveBeenCalledTimes(1)
  expect(h.enqueue).not.toHaveBeenCalled()
})

test('an active AI session still falls back once when the provider rejects the format', async () => {
  const h = await createHarness()
  h.llm.mockImplementationOnce(async () => {
    throw new Error('HTTP 400: response_format unsupported')
  })
  h.engine.triggerNow()
  await flush()
  expect(h.llm).toHaveBeenCalledTimes(2)
  expect(h.enqueue).toHaveBeenCalledTimes(1)
})

test('an automatic failure invalidates AI work waiting for room resolution across restart', async () => {
  const h = await createHarness()
  const oldRoom = Promise.withResolvers<number>()
  h.room.mockImplementationOnce(() => oldRoom.promise)
  h.engine.triggerNow()
  await flush()
  sendControl.stopAutomaticSends()
  expect(h.settings.aiChatEnabled.value).toBe(false)
  h.engine.stopAiChatEngine()
  h.settings.aiChatEnabled.value = true
  h.engine.startAiChatEngine()
  oldRoom.resolve(42)
  await flush()
  expect(h.enqueue).not.toHaveBeenCalled()
  h.engine.triggerNow()
  await flush()
  expect(h.enqueue).toHaveBeenCalledTimes(1)
})

test('a failed send in the same AI session releases inflight for the next generation', async () => {
  const h = await createHarness()
  h.enqueue.mockImplementationOnce(async () => ({ success: false, isEmoticon: false }))
  h.engine.triggerNow()
  await flush()
  expect(h.engine.aiChatStatus.value).toBe('idle')
  h.engine.triggerNow()
  await flush()
  expect(h.llm).toHaveBeenCalledTimes(2)
  expect(h.enqueue).toHaveBeenCalledTimes(2)
})

test('stopping after an AI send is queued invalidates its dispatch guard', async () => {
  const h = await createHarness()
  const receipt = Promise.withResolvers<{ success: boolean; isEmoticon: boolean }>()
  h.enqueue.mockImplementationOnce(() => receipt.promise)
  h.engine.triggerNow()
  await flush()
  const guard = h.enqueue.mock.calls[0]?.[5]
  expect(guard?.()).toBe(true)
  h.engine.stopAiChatEngine()
  h.engine.startAiChatEngine()
  expect(guard?.()).toBe(false)
  receipt.resolve({ success: false, isEmoticon: false })
  await flush()
})
