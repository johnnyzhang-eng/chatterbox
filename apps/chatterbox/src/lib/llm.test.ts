import { afterEach, expect, mock, spyOn, test } from 'bun:test'

import { type ChatCompletionOptions, chatCompletion } from './llm'

const options: ChatCompletionOptions = {
  base: 'https://llm.test/v1',
  apiKey: 'key',
  model: 'model',
  messages: [{ role: 'user', content: '晚上好' }],
}

afterEach(() => mock.restore())

function reply(message: unknown): void {
  spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ choices: [{ message }] }))
}

test('an empty reply resolves to an empty string so callers can treat it as a refusal', async () => {
  reply({ role: 'assistant', content: '' })
  expect(await chatCompletion(options)).toBe('')
})

test('a reply without content is still an error', async () => {
  reply({ role: 'assistant', content: null, refusal: '无法回答' })
  await expect(chatCompletion(options)).rejects.toThrow('返回数据缺少 content 字段')
})
