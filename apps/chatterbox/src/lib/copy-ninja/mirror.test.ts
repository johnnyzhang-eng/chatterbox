import { afterEach, expect, mock, test } from 'bun:test'
import { signal } from '@preact/signals'

import * as sendControl from '../send-control'
import * as decisions from './decisions'

const source = await Bun.file(new URL('./mirror.ts', import.meta.url)).text()
const cleanups: (() => void)[] = []
let moduleId = 0

async function flush(): Promise<void> {
  await Bun.sleep(0)
}

async function createHarness() {
  const settings = {
    copyNinjaDelayMaxSec: signal(0),
    copyNinjaDelayMinSec: signal(0),
    copyNinjaDropPercent: signal(0),
    copyNinjaFollowRoom: signal(false),
    copyNinjaKanchi: signal(false),
    copyNinjaMasterRoomId: signal(42),
    copyNinjaPaused: signal(false),
    isCopySourceEnabled: () => true,
    SOURCE_LABELS: { manual: '常规发送' },
  }
  const enqueue = mock(
    async (_text: string, _room: number, _csrf: string, _priority: number, _source: string, guard?: () => boolean) => ({
      success: guard?.() ?? true,
      isEmoticon: false,
      error: undefined as string | undefined,
    })
  )
  const polish = mock(async (_slot: string, text: string, _options: unknown) => text)
  const dependencies = {
    '../api': { getCsrfToken: () => 'csrf' },
    '../emoticon': {
      isEmoticonUnique: () => false,
      isLockedEmoticon: () => false,
      isUnavailableEmoticon: () => false,
      looksLikeEmoticonUnique: () => false,
    },
    '../llm-tasks': { describeLlmGap: () => null, polishWithLlm: polish },
    '../log': { appendLog: mock(() => {}) },
    '../replacement': { applyReplacements: (text: string) => text },
    '../send-control': {
      automaticSendGuard: sendControl.automaticSendGuard,
      onAutomaticSendStop: (listener: () => void) => {
        const unsubscribe = sendControl.onAutomaticSendStop(listener)
        cleanups.push(unsubscribe)
        return unsubscribe
      },
    },
    '../send-queue': { enqueueDanmaku: enqueue, cancelQueuedDanmaku: mock(() => {}), SendPriority: { COPY: 1 } },
    '../store': { cachedRoomId: signal(42), maxLength: signal(40) },
    '../utils': {
      formatDanmakuError: (value: unknown) => String(value),
      processMessages: (text: string) => text.split('|'),
    },
    './decisions': decisions,
    './settings': settings,
  }
  const key = `__mirrorTest${++moduleId}`
  Reflect.set(globalThis, key, dependencies)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const injected = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(path)}];`
  })
  let engine: typeof import('./mirror')
  try {
    engine = await import(`data:text/javascript;base64,${Buffer.from(injected).toString('base64')}`)
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
  cleanups.push(() => engine.resetMirror())
  const report = mock((_id: string, _status: string, _detail?: string) => {})
  const action = (text: string) =>
    engine.handleMirrorAction(
      {
        type: 'action',
        eventId: 'event',
        from: { uid: 'test', uname: 'test' },
        action: { kind: 'danmaku', roomId: 42, text, source: 'manual' },
      },
      report
    )
  return { engine, settings, enqueue, polish, report, action }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

test('an old accepted COPY receipt cannot send remaining segments or report the restarted session as sent', async () => {
  const h = await createHarness()
  const receipt = Promise.withResolvers<{ success: boolean; isEmoticon: boolean; error: undefined }>()
  h.enqueue.mockImplementationOnce(() => receipt.promise)
  h.action('第一段|第二段')
  await flush()
  h.engine.cancelPendingCopies()
  h.engine.resumeMirror()
  receipt.resolve({ success: true, isEmoticon: false, error: undefined })
  await flush()
  expect(h.enqueue).toHaveBeenCalledTimes(1)
  expect(h.report.mock.calls.some(call => call[1] === 'sent')).toBe(false)
  expect(h.settings.copyNinjaPaused.value).toBe(false)
})

test('an actual COPY failure pauses immediately, clears later copies, and retains the failed event receipt', async () => {
  const h = await createHarness()
  const receipt = Promise.withResolvers<{ success: boolean; isEmoticon: boolean; error: string | undefined }>()
  h.enqueue.mockImplementationOnce(() =>
    receipt.promise.then(result => {
      sendControl.stopAutomaticSends()
      return result
    })
  )
  h.action('第一段|第二段')
  h.action('下一条')
  receipt.resolve({ success: false, isEmoticon: false, error: 'rejected' })
  await flush()
  expect(h.enqueue).toHaveBeenCalledTimes(1)
  expect(h.settings.copyNinjaPaused.value).toBe(true)
  expect(h.report.mock.calls).toEqual([['event', 'failed', 'rejected']])
})

test('an ignored rewrite abort cannot leak old COPY text after stop and resume', async () => {
  const h = await createHarness()
  const rewrite = Promise.withResolvers<string>()
  h.settings.copyNinjaKanchi.value = true
  h.polish.mockImplementationOnce(() => rewrite.promise)
  h.action('旧内容')
  await flush()
  sendControl.stopAutomaticSends()
  h.engine.resumeMirror()
  rewrite.resolve('旧改写结果')
  await flush()
  expect(h.enqueue).not.toHaveBeenCalled()
  h.action('新内容')
  await flush()
  expect(h.enqueue.mock.calls.map(call => call[0])).toEqual(['新内容'])
})
