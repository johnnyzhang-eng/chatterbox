import { expect, test } from 'bun:test'
import * as signals from '@preact/signals'

import type { SendDanmakuReceipt } from './api'

import { formatDanmakuError } from './utils'

const source = await Bun.file(new URL('./log.ts', import.meta.url)).text()
let moduleId = 0

async function loadLog() {
  const key = `__danmakuLogTest${++moduleId}`
  const dependencies: Record<string, unknown> = {
    '@preact/signals': signals,
    './gm-signal': { gmSignal: (_name: string, fallback: number) => signals.signal(fallback) },
    './utils': { formatDanmakuError },
  }
  Reflect.set(globalThis, key, dependencies)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const injected = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(path)}];`
  })
  try {
    const log: typeof import('./log') = await import(
      `data:text/javascript;base64,${Buffer.from(injected).toString('base64')}`
    )
    return log
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

const receipt: SendDanmakuReceipt = { http_status: 200, code: 0, message: '', msg: '', id_str: 'message-id' }

test('accepted receipts are yellow and explicitly leave public display unverified', async () => {
  const log = await loadLog()
  log.appendLog({ success: true, message: 'text', isEmoticon: false, receipt }, '手动', 'text')
  expect(log.logLines.value).toEqual([
    `🟡 手动: text（接口接受，公开显示未验证） [原始回执 ${JSON.stringify(receipt)}]`,
  ])
})

test('rejected receipts retain the original rejection and selected raw fields', async () => {
  const log = await loadLog()
  const rejected = { ...receipt, message: 'max limit exceeded', msg: 'max limit exceeded' }
  log.appendLog(
    { success: false, message: 'text', isEmoticon: false, error: rejected.message, receipt: rejected },
    '自动',
    'text'
  )
  expect(log.logLines.value[0]).toBe(`❌ 自动: text，原因：max limit exceeded [原始回执 ${JSON.stringify(rejected)}]`)
})

test('legacy results remain supported and cancellations do not claim a manual interruption', async () => {
  const log = await loadLog()
  log.appendLog({ success: false, cancelled: true, message: 'text', isEmoticon: false }, '自动', 'text')
  log.appendLog({ success: false, message: 'text', isEmoticon: false, error: 'Failed to fetch' }, '手动', 'text')
  expect(log.logLines.value).toEqual(['⏭ 自动: text（发送任务已取消）', '❌ 手动: text，原因：Failed to fetch'])
})

test('plain log messages and the buffer limit keep their existing behavior', async () => {
  const log = await loadLog()
  log.maxLogLines.value = 2
  log.appendLog('first')
  log.appendLog('second')
  log.appendLog('third')
  expect(log.logLines.value).toEqual(['second', 'third'])
})
