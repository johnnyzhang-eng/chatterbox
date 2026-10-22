import { isEmoticonUnique } from '../lib/emoticon'
import { describeLlmGap, isLlmApiConfigured } from '../lib/llm-tasks'
import { appendLog } from '../lib/log'
import { type AutoSendStopReason, autoSendRun, cancelLoop } from '../lib/loop'
import {
  activeTemplateIndex,
  autoSendMaxMessages,
  autoSendPanelOpen,
  autoSendYolo,
  cachedRoomId,
  llmActivePromptAutoSend,
  llmPromptsAutoSend,
  maxLength,
  msgSendInterval,
  msgTemplates,
  persistSendState,
  randomChar,
  randomColor,
  randomInterval,
  sendMsg,
} from '../lib/store'
import { getGraphemes, processMessages, trimText } from '../lib/utils'
import { PromptPicker } from './prompt-picker'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Combobox } from './ui/combobox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

function getPreview(template: string): string {
  const firstLine = (template.split('\n')[0] ?? '').trim()
  if (!firstLine) return '(空)'
  return getGraphemes(firstLine).length > 10 ? `${trimText(firstLine, 40)[0]}…` : firstLine
}

const STOP_LABELS: Record<Exclude<AutoSendStopReason, null>, string> = {
  manual: '手动停止',
  limit: '达到本次请求上限',
  failure: '发送失败，已停止',
  cancelled: '未发请求已取消',
  'preparation-error': '发送前错误，已停止',
}

export function AutoSendControls() {
  const templates = msgTemplates.value
  const idx = activeTemplateIndex.value
  const currentTemplate = templates[idx] ?? ''
  const run = autoSendRun.value
  const segments = currentTemplate
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => (isEmoticonUnique(line) ? [line] : processMessages(line, maxLength.value)))
  const msgCount = segments.length

  const toggleSend = () => {
    if (!sendMsg.value) {
      if (!currentTemplate.trim()) {
        appendLog('⚠️ 当前模板为空，请先输入内容')
        return
      }
      sendMsg.value = true
    } else {
      cancelLoop()
      sendMsg.value = false
    }
  }

  const updateTemplate = (text: string) => {
    const next = [...templates]
    next[idx] = text
    msgTemplates.value = next
  }

  const addTemplate = () => {
    msgTemplates.value = [...templates, '']
    activeTemplateIndex.value = msgTemplates.value.length - 1
  }

  const removeTemplate = () => {
    if (templates.length <= 1) return
    const next = [...templates]
    next.splice(idx, 1)
    msgTemplates.value = next
    activeTemplateIndex.value = Math.max(0, idx - 1)
  }

  // Picker shows even when the active draft is empty, so the user can recover by switching.
  const llmGap = describeLlmGap('autoSend')
  const llmReady = llmGap === null
  const showPromptPicker = isLlmApiConfigured() && llmPromptsAutoSend.value.length > 0

  return (
    <AccordionItem
      open={autoSendPanelOpen.value}
      onOpenChange={v => {
        autoSendPanelOpen.value = v
      }}
    >
      {/* Title markers: 🟢 = loop sending, ⚡️ = YOLO polish active (both can be on). */}
      <AccordionTrigger>
        独轮车{sendMsg.value ? ' 🟢' : ''}
        {autoSendYolo.value ? ' ⚡️' : ''}
      </AccordionTrigger>
      <AccordionContent>
        <div class='my-2 flex items-center gap-1'>
          <Button variant={sendMsg.value ? 'destructive' : 'default'} size='sm' onClick={toggleSend}>
            {sendMsg.value ? '停车' : '开车'}
          </Button>
          <Combobox
            value={String(idx)}
            options={templates.map((t, i) => ({
              value: String(i),
              label: `${i + 1}: ${getPreview(t)}`,
              searchText: t,
            }))}
            onChange={v => {
              activeTemplateIndex.value = parseInt(v, 10)
            }}
          />
          <Button variant='outline' size='sm' onClick={addTemplate}>
            新增
          </Button>
          <Button variant='outline' size='sm' onClick={removeTemplate}>
            删除当前
          </Button>
        </div>

        <Label className='my-2 flex flex-wrap items-center gap-2'>
          本次请求上限（0不限）
          <Input
            type='number'
            min='0'
            step='1'
            autocomplete='off'
            className='w-20'
            value={autoSendMaxMessages.value}
            disabled={run.active}
            onInput={e => {
              autoSendMaxMessages.value = Number(e.currentTarget.value)
            }}
          />
        </Label>
        <div class='my-2 text-sm'>
          <div>
            本次请求 {run.requests}/{run.limit || '不限'} ·{' '}
            {run.active ? '运行中' : run.stopReason ? STOP_LABELS[run.stopReason] : '未启动'}
          </div>
          <div>
            接口接受 {run.accepted} · 失败 {run.failed} · 未发取消 {run.cancelled} · 发送前错误 {run.preparationFailed}
          </div>
          <div class='text-ga6 text-xs'>每次开车重新计数；接口接受仍需独立核验公开显示。</div>
        </div>

        {/* Own line: LLM-side controls, orthogonal to the template controls above. */}
        <div class='my-2 flex items-center gap-1'>
          <Button
            // Variant flip mirrors 常规发送 / 自动融入 as the "is YOLO on?" affordance.
            variant={autoSendYolo.value ? 'default' : 'outline'}
            size='sm'
            disabled={!llmReady}
            onClick={() => {
              autoSendYolo.value = !autoSendYolo.value
            }}
          >
            YOLO
          </Button>
          {showPromptPicker && (
            // Hot-swaps the active prompt only; author/edit/reorder lives in Settings.
            <PromptPicker
              className='min-w-10 truncate'
              title='切换 YOLO 使用的独轮车提示词'
              prompts={llmPromptsAutoSend.value}
              activeIndex={llmActivePromptAutoSend.value}
              onActiveIndexChange={v => {
                llmActivePromptAutoSend.value = v
              }}
              previewGraphemes={16}
            />
          )}
        </div>

        <Textarea
          value={currentTemplate}
          onInput={e => updateTemplate(e.currentTarget.value)}
          placeholder='在这输入弹幕，每行一句话，超过可发送字数的会自动进行分割'
          className='h-20'
        />

        <details class='my-2 rounded border border-ga2 border-solid p-2'>
          <summary class='cursor-pointer select-none'>当前草稿分段预览（{msgCount} 条）</summary>
          <p class='my-1 text-ga6 text-xs'>
            文字按换行及当前 {maxLength.value}{' '}
            字上限分段，字数按可见字符计；表情标记保持单条。可在下方调整上限，实际发送仍受平台限制。
          </p>
          {segments.length > 0 ? (
            <ol class='my-2 max-h-48 list-none space-y-2 overflow-y-auto p-0'>
              {segments.map((segment, i) => (
                <li key={`${i}:${segment}`}>
                  <div class='text-ga6 text-xs'>
                    第 {i + 1} 条 · {getGraphemes(segment).length} 字
                  </div>
                  <div class='whitespace-pre-wrap break-words'>{segment}</div>
                </li>
              ))}
            </ol>
          ) : (
            <p class='my-2 text-ga6'>暂无可发送内容，请先输入模板。</p>
          )}
          <p class='my-1 text-ga6 text-xs'>
            模板修改下一轮生效，已快照的当前轮次继续使用原内容。此处即刻预览当前草稿；替换规则、YOLO
            润色或随机字符可能改变最终内容和条数。预览或运行中均不代表公开送达。
          </p>
        </details>

        <div class='my-2 flex flex-wrap gap-2'>
          <div class='flex flex-wrap items-center gap-x-2 gap-y-1'>
            <span>{msgCount} 条</span>
            <Label className='inline-flex items-center gap-1'>
              间隔
              <Input
                type='number'
                min='0'
                autocomplete='off'
                className='w-16'
                value={msgSendInterval.value}
                onInput={e => {
                  const v = parseInt(e.currentTarget.value, 10)
                  msgSendInterval.value = v >= 0 ? v : 0
                }}
              />
              秒
            </Label>
            <Label className='inline-flex items-center gap-1'>
              超过
              <Input
                type='number'
                min='1'
                autocomplete='off'
                className='w-16'
                value={maxLength.value}
                onInput={e => {
                  const v = parseInt(e.currentTarget.value, 10)
                  maxLength.value = v >= 1 ? v : 1
                }}
              />
              字自动分段
            </Label>
          </div>
          <Checkbox
            id='randomColor'
            checked={randomColor.value}
            onInput={e => {
              randomColor.value = e.currentTarget.checked
            }}
            label='随机颜色'
          />
          <Checkbox
            id='randomInterval'
            checked={randomInterval.value}
            onInput={e => {
              randomInterval.value = e.currentTarget.checked
            }}
            label='间隔增加随机性'
          />
          <Checkbox
            id='randomChar'
            checked={randomChar.value}
            onInput={e => {
              randomChar.value = e.currentTarget.checked
            }}
            label='随机字符'
          />
          <Checkbox
            id='persistSendState'
            disabled={cachedRoomId.value === null}
            checked={cachedRoomId.value !== null && !!persistSendState.value[String(cachedRoomId.value)]}
            onInput={e => {
              const roomId = cachedRoomId.value
              if (roomId === null) return
              persistSendState.value = { ...persistSendState.value, [String(roomId)]: e.currentTarget.checked }
            }}
            label='保持当前直播间独轮车开关状态'
          />
        </div>
      </AccordionContent>
    </AccordionItem>
  )
}
