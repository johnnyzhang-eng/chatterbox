import { useEffect, useRef } from 'preact/hooks'

import { logLines, maxLogLines } from '../lib/log'
import { pageSendStats } from '../lib/send-stats'
import { logPanelOpen } from '../lib/store'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Textarea } from './ui/textarea'

export function LogPanel() {
  const ref = useRef<HTMLTextAreaElement>(null)
  const stats = pageSendStats.value

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [logLines.value])

  return (
    <AccordionItem
      open={logPanelOpen.value}
      onOpenChange={v => {
        logPanelOpen.value = v
      }}
      className='mt-1'
    >
      <AccordionTrigger>日志</AccordionTrigger>
      <AccordionContent>
        <div class='my-2 text-xs'>
          <div>
            本页：发起 POST {stats.requests} · 接口接受 {stats.accepted} · 请求失败 {stats.failed}
          </div>
          <div>
            未发取消 {stats.cancelled} · 发送前错误 {stats.preparationFailed}
          </div>
          <p class='my-1 text-ga6'>刷新后归零；接口接受不代表公开显示，需另一账号独立核验。</p>
        </div>
        <Textarea
          ref={ref}
          readOnly
          value={logLines.value.join('\n')}
          placeholder={`此处将输出日志（最多保留 ${maxLogLines.value} 条）`}
          className='mt-2 h-15'
        />
      </AccordionContent>
    </AccordionItem>
  )
}
