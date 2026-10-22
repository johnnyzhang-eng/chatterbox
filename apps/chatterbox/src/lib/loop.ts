import { effect, signal, untracked } from '@preact/signals'

import type { DanmakuConfigResponse } from '../types'
import type { SendObserver } from './send-stats'

import {
  ensureRoomId,
  fetchEmoticons,
  getCsrfToken,
  getSpmPrefix,
  type SendDanmakuResult,
  setDanmakuMode,
  setRandomDanmakuColor,
} from './api'
import { BASE_URL } from './const'
import {
  formatLockedEmoticonReject,
  formatUnavailableEmoticonReject,
  isEmoticonUnique,
  isLockedEmoticon,
  isUnavailableEmoticon,
} from './emoticon'
import { isLlmReady, polishWithLlm } from './llm-tasks'
import { appendLog } from './log'
import { applyReplacements, buildReplacementMap } from './replacement'
import { automaticSendGuard, onAutomaticSendStop } from './send-control'
import { cancelQueuedDanmaku, enqueueDanmaku, SendPriority } from './send-queue'
import {
  activeTemplateIndex,
  autoSendMaxMessages,
  autoSendYolo,
  availableDanmakuColors,
  cachedRoomId,
  forceScrollDanmaku,
  invisibleChar,
  maxLength,
  msgSendInterval,
  msgTemplates,
  randomChar,
  randomColor,
  randomInterval,
  sendMsg,
} from './store'
import { processMessages, resolveSendDelayMs } from './utils'
import { cachedWbiKeys, encodeWbi, waitForWbiKeys } from './wbi'

let currentAbort: AbortController | null = null
let loopRunning = false

export type AutoSendStopReason = 'manual' | 'limit' | 'failure' | 'cancelled' | 'preparation-error' | null

export interface AutoSendRun {
  runId: number
  limit: number
  requests: number
  accepted: number
  failed: number
  cancelled: number
  preparationFailed: number
  active: boolean
  stopReason: AutoSendStopReason
}

export const autoSendRun = signal<AutoSendRun>({
  runId: 0,
  limit: 0,
  requests: 0,
  accepted: 0,
  failed: 0,
  cancelled: 0,
  preparationFailed: 0,
  active: false,
  stopReason: null,
})
let nextRunId = 0

function cancelRound(): void {
  currentAbort?.abort()
  currentAbort = null
  cancelQueuedDanmaku('loop')
}

function stopRun(runId: number, reason: AutoSendStopReason): void {
  const run = autoSendRun.peek()
  if (run.runId !== runId) return
  autoSendRun.value = { ...run, active: false, stopReason: reason }
  cancelRound()
  sendMsg.value = false
}

/** Stop this loop batch; an already dispatched request keeps its original receipt. */
export function cancelLoop(reason: AutoSendStopReason = 'manual'): void {
  stopRun(autoSendRun.peek().runId, reason)
}

effect(() => {
  const enabled = sendMsg.value
  untracked(() => {
    cancelRound()
    const previous = autoSendRun.peek()
    if (enabled) {
      const configured = autoSendMaxMessages.peek()
      const valid = Number.isSafeInteger(configured) && configured >= 0
      const limit = valid ? configured : 0
      autoSendRun.value = {
        runId: ++nextRunId,
        limit,
        requests: 0,
        accepted: 0,
        failed: 0,
        cancelled: 0,
        preparationFailed: 0,
        active: true,
        stopReason: null,
      }
      if (!valid) {
        appendLog('❌ 本次请求上限必须是非负安全整数，已停止，未发送')
        recordPreparationFailure(autoSendRun.peek().runId)
      }
    } else if (previous.active) {
      autoSendRun.value = { ...previous, active: false, stopReason: 'manual' }
    }
  })
})

function recordPreparationFailure(runId: number): void {
  const run = autoSendRun.peek()
  if (run.runId !== runId) return
  autoSendRun.value = { ...run, preparationFailed: run.preparationFailed + 1 }
  stopRun(runId, 'preparation-error')
}

function hasBudget(runId: number): boolean {
  const run = autoSendRun.peek()
  return run.runId === runId && run.active && (run.limit === 0 || run.requests < run.limit)
}

function runObserver(runId: number, isCurrent: () => boolean): { observer: SendObserver; guard: () => boolean } {
  let requested = false
  let settled = false
  const observer: SendObserver = {
    onRequestStart: () => {
      if (requested) return
      requested = true
      const run = autoSendRun.peek()
      if (run.runId === runId) autoSendRun.value = { ...run, requests: run.requests + 1 }
    },
    onResult: result => {
      if (settled) return
      settled = true
      const run = autoSendRun.peek()
      if (run.runId !== runId) return
      if (requested) {
        autoSendRun.value = {
          ...run,
          accepted: run.accepted + Number(result.success),
          failed: run.failed + Number(!result.success),
        }
      } else if (result.cancelled) {
        autoSendRun.value = { ...run, cancelled: run.cancelled + 1 }
      } else {
        autoSendRun.value = { ...run, preparationFailed: run.preparationFailed + 1 }
      }
    },
  }
  return { observer, guard: () => isCurrent() && (requested || hasBudget(runId)) }
}

onAutomaticSendStop(() => {
  const run = autoSendRun.peek()
  if (run.active) cancelLoop(run.preparationFailed > 0 ? 'preparation-error' : 'failure')
  else cancelRound()
  appendLog('⏸️ 自动发送已停止：请求失败或被拒绝，未发内容已取消，不会自动改写重试')
})

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => resolve(true), ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve(false)
      },
      { once: true }
    )
  })
}

/** Main loop: auto-send (独轮车), room init, danmaku config, message sending. */
export async function loop(): Promise<void> {
  if (loopRunning) return
  loopRunning = true
  try {
    await runLoop()
  } finally {
    loopRunning = false
  }
}

async function runLoop(): Promise<void> {
  let count = 0
  const preparingRun = autoSendRun.peek()

  let roomId = cachedRoomId.value
  if (roomId === null) {
    try {
      roomId = await ensureRoomId()
      buildReplacementMap()

      await waitForWbiKeys()
      if (cachedWbiKeys) {
        try {
          const configQuery = encodeWbi(
            {
              room_id: String(cachedRoomId.value),
              web_location: getSpmPrefix(),
            },
            cachedWbiKeys
          )
          const configUrl = `${BASE_URL.BILIBILI_GET_DM_CONFIG}?${configQuery}`
          const configResp: DanmakuConfigResponse = await fetch(configUrl, {
            method: 'GET',
            credentials: 'include',
          }).then(r => r.json())

          if (configResp?.data?.group) {
            const colors: string[] = []
            for (const group of configResp.data.group) {
              for (const color of group.color) {
                if (color.status === 1) {
                  colors.push(`0x${color.color_hex}`)
                }
              }
            }
            if (colors.length > 0) {
              availableDanmakuColors.value = colors
              console.log('[LAPLACE Chatterbox] Available colors:', colors)
            }
          }
        } catch {
          // non-critical
        }
      }

      try {
        await fetchEmoticons(roomId)
      } catch {
        // non-critical
      }

      if (forceScrollDanmaku.value) {
        const initCsrfToken = getCsrfToken()
        if (initCsrfToken) {
          await setDanmakuMode(roomId, initCsrfToken, '1')
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      appendLog(`❌ 获取房间ID失败: ${message}`)
      if (preparingRun.active) recordPreparationFailure(preparingRun.runId)
      await new Promise(r => setTimeout(r, 5000))
      return
    }
  }

  let lastRunId = 0
  while (true) {
    const run = autoSendRun.peek()
    if (!sendMsg.value || !run.active) {
      await new Promise(r => setTimeout(r, 1000))
      continue
    }
    if (run.runId !== lastRunId) {
      lastRunId = run.runId
      count = 0
    }
    currentAbort = new AbortController()
    const controller = currentAbort
    const { signal } = controller
    const isCurrent = automaticSendGuard(
      () =>
        currentAbort === controller &&
        !signal.aborted &&
        sendMsg.value &&
        autoSendRun.peek().runId === run.runId &&
        autoSendRun.peek().active
    )
    const canContinue = () => {
      if (!isCurrent()) return false
      if (!hasBudget(run.runId)) {
        stopRun(run.runId, 'limit')
        return false
      }
      return true
    }
    const preparationFailuresBefore = autoSendRun.peek().preparationFailed

    try {
      if (!canContinue()) continue
      const csrfToken = getCsrfToken()
      if (!csrfToken) throw new Error('未找到登录信息，请先登录 Bilibili')
      const currentTemplate = msgTemplates.value[activeTemplateIndex.value] ?? ''
      if (!currentTemplate.trim()) throw new Error('当前模板为空')
      const interval = msgSendInterval.value
      const enableRandomColor = randomColor.value
      const enableRandomInterval = randomInterval.value
      const randomCharToInsert = randomChar.value ? invisibleChar.value : undefined
      const yolo = autoSendYolo.value
      if (yolo && !isLlmReady('autoSend')) throw new Error('YOLO 已开启，但 LLM 配置不完整')

      type SendTask = { polish: boolean; text: string }
      const tasks: SendTask[] = []
      for (const line of currentTemplate
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)) {
        if (isEmoticonUnique(line)) tasks.push({ polish: false, text: line })
        else {
          for (const chunk of processMessages(line, maxLength.value, yolo ? undefined : randomCharToInsert)) {
            tasks.push({ polish: yolo, text: chunk })
          }
        }
      }
      if (tasks.length === 0) throw new Error('当前模板没有可发送片段')

      let completed = true
      outer: for (let i = 0; i < tasks.length; i++) {
        if (!canContinue()) {
          completed = false
          break
        }
        const task = tasks[i]
        let sendItems = [task.text]
        if (task.polish) {
          const polished = await polishWithLlm('autoSend', task.text, { signal })
          if (!canContinue()) {
            completed = false
            break
          }
          if (!polished.trim()) throw new Error('独轮车 AI 返回为空')
          appendLog(`✨ 独轮车 AI 润色：${task.text} → ${polished}`)
          sendItems = processMessages(polished, maxLength.value, randomCharToInsert)
          if (sendItems.length === 0) throw new Error('AI 润色后没有可发送片段')
        }

        for (const [j, message] of sendItems.entries()) {
          if (!canContinue()) {
            completed = false
            break outer
          }
          const isEmote = isEmoticonUnique(message)
          if (isLockedEmoticon(message)) throw new Error(formatLockedEmoticonReject(message, '自动表情'))
          if (isUnavailableEmoticon(message)) throw new Error(formatUnavailableEmoticonReject(message, '自动表情'))
          const processedMessage = isEmote ? message : applyReplacements(message)
          if (!canContinue()) {
            completed = false
            break outer
          }
          if (enableRandomColor) await setRandomDanmakuColor(roomId, csrfToken)
          if (!canContinue()) {
            completed = false
            break outer
          }

          const { observer, guard } = runObserver(run.runId, isCurrent)
          const result: SendDanmakuResult = await enqueueDanmaku(
            processedMessage,
            roomId,
            csrfToken,
            SendPriority.AUTO,
            'loop',
            guard,
            observer
          )
          const displayMsg = message === processedMessage ? message : `${message} → ${processedMessage}`
          const baseLabel = result.isEmoticon ? '自动表情' : '自动'
          const label = tasks.length > 1 ? `${baseLabel} [${i + 1}/${tasks.length}]` : baseLabel
          appendLog(result, label, displayMsg)
          if (!isCurrent()) {
            completed = false
            break outer
          }
          if (!result.success) {
            const current = autoSendRun.peek()
            stopRun(
              run.runId,
              result.cancelled ? 'cancelled' : current.preparationFailed > 0 ? 'preparation-error' : 'failure'
            )
            completed = false
            break outer
          }
          if (!hasBudget(run.runId)) {
            if (i === tasks.length - 1 && j === sendItems.length - 1) appendLog(`🔵第 ${++count} 轮发送完成`)
            stopRun(run.runId, 'limit')
            completed = false
            break outer
          }
          if (!(await abortableSleep(resolveSendDelayMs(interval, enableRandomInterval), signal))) {
            completed = false
            break outer
          }
        }
      }
      if (completed && isCurrent()) appendLog(`🔵第 ${++count} 轮发送完成`)
    } catch (err) {
      if (isCurrent()) {
        appendLog(`🔴 自动发送准备失败：${err instanceof Error ? err.message : String(err)}`)
        if (autoSendRun.peek().preparationFailed === preparationFailuresBefore) recordPreparationFailure(run.runId)
        else stopRun(run.runId, 'preparation-error')
      }
    } finally {
      if (currentAbort === controller) currentAbort = null
    }
  }
}
