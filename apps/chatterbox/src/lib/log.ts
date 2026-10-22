import { signal } from '@preact/signals'

import type { SendDanmakuResult } from './api'

import { gmSignal } from './gm-signal'
import { formatDanmakuError } from './utils'

/** Maximum number of lines kept in the rolling log buffer. */
export const maxLogLines = gmSignal('maxLogLines', 1000)

/** Rolling log buffer surfaced by the LogPanel. */
export const logLines = signal<string[]>([])

/** Appends a log entry, distinguishing API acceptance from public display. */
export function appendLog(message: string): void
export function appendLog(result: SendDanmakuResult, label: string, display: string): void
export function appendLog(arg: string | SendDanmakuResult, label?: string, display?: string): void {
  const receiptText = typeof arg !== 'string' && arg.receipt ? ` [原始回执 ${JSON.stringify(arg.receipt)}]` : ''
  const message =
    (typeof arg === 'string'
      ? arg
      : arg.cancelled
        ? `⏭ ${label}: ${display}（发送任务已取消）`
        : arg.success
          ? `🟡 ${label}: ${display}（接口接受，公开显示未验证）`
          : `❌ ${label}: ${display}，原因：${formatDanmakuError(arg.error)}`) + receiptText

  const max = maxLogLines.value
  const lines = logLines.value
  const next = lines.length >= max ? [...lines.slice(lines.length - max + 1), message] : [...lines, message]
  logLines.value = next
}
