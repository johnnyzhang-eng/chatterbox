import { describe, expect, mock, test } from 'bun:test'

import { BASE_URL } from './const'
import * as sendStats from './send-stats'
import * as utils from './utils'

const source = await Bun.file(new URL('./api.ts', import.meta.url)).text()
let moduleId = 0

async function loadApi(
  reply: () => Response | Promise<Response>,
  emoticon = false,
  prepareError?: Error,
  formData: typeof FormData = FormData
) {
  const requests: { url: string; options?: RequestInit }[] = []
  const fetch = mock(async (url: string, options?: RequestInit) => {
    requests.push({ url, options })
    return reply()
  })
  const dependencies: Record<string, unknown> = {
    './const': { BASE_URL },
    './emoticon': {
      isEmoticonUnique: () => {
        if (prepareError) throw prepareError
        return emoticon
      },
    },
    './replacement': { buildReplacementMap: () => {} },
    './store': {},
    './send-stats': sendStats,
    './utils': utils,
    './wbi': { cachedWbiKeys: null },
  }
  const key = `__sendDanmakuTest${++moduleId}`
  Reflect.set(globalThis, key, { fetch, FormData: formData, dependencies })
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const injected = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}].dependencies[${JSON.stringify(path)}];`
  })
  try {
    const api: typeof import('./api') = await import(
      `data:text/javascript;base64,${Buffer.from(`const { fetch, FormData } = globalThis[${JSON.stringify(key)}];\n${injected}`).toString('base64')}`
    )
    return { api, requests, fetch }
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

describe('sendDanmaku receipts', () => {
  test.each([
    { code: 0, message: '', msg: '' },
    { code: 0, message: ' OK ', msg: 'success' },
    { code: 0, message: ' ', msg: '\t' },
  ])('accepts an HTTP success with numeric code zero and no rejection: %j', async body => {
    const { api, requests } = await loadApi(() => Response.json(body))
    const result = await api.sendDanmaku('offline test', 42, 'test-csrf')
    expect(result).toMatchObject({ success: true, deliveryConfirmed: false })
    expect(result.error).toBeUndefined()
    expect(result.receipt).toEqual({ http_status: 200, ...body, id_str: null })
    expect(requests).toHaveLength(1)
  })

  const rejections = [
    { name: 'system upgrade', body: { code: 0, message: '系统升级中', msg: '系统升级中' }, error: '系统升级中' },
    {
      name: 'rate limit',
      body: { code: 0, message: 'max limit exceeded', msg: 'max limit exceeded' },
      error: 'max limit exceeded',
    },
    {
      name: 'msg-only rejection',
      body: { code: 0, message: '', msg: 'max limit exceeded' },
      error: 'max limit exceeded',
    },
    { name: 'message-only rejection', body: { code: 0, message: 'f', msg: '' }, error: 'f' },
    { name: 'acknowledgement plus rejection', body: { code: 0, message: 'OK', msg: 'k' }, error: 'k' },
    {
      name: 'different rejection texts',
      body: { code: 0, message: ' first rejection ', msg: 'second rejection' },
      error: ' first rejection  / second rejection',
    },
    { name: 'nonzero code', body: { code: -101, message: '', msg: '' }, error: '接口未接受：code=-101' },
    { name: 'string code zero', body: { code: '0', message: '', msg: '' }, error: '接口未接受：code="0"' },
    { name: 'missing code', body: { message: '', msg: '' }, error: '接口未接受：code=null' },
    { name: 'null response', body: null, error: '接口未接受：code=null' },
  ]
  for (const { name, body, error } of rejections) {
    test(`rejects ${name} without retrying`, async () => {
      const { api, requests } = await loadApi(() => Response.json(body))
      const result = await api.sendDanmaku('offline test', 42, 'test-csrf')
      expect(result).toMatchObject({ success: false, deliveryConfirmed: false, error })
      expect(result.receipt).toEqual({
        http_status: 200,
        code: utils.readPath(body, 'code') ?? null,
        message: utils.readPath(body, 'message') ?? null,
        msg: utils.readPath(body, 'msg') ?? null,
        id_str: null,
      })
      expect(requests).toHaveLength(1)
    })
  }

  test.each([400, 503])('rejects HTTP %i even when the body says code zero', async status => {
    const { api } = await loadApi(() => Response.json({ code: 0 }, { status }))
    const result = await api.sendDanmaku('offline test', 42, 'test-csrf')
    expect(result).toMatchObject({
      success: false,
      deliveryConfirmed: false,
      error: `HTTP ${status}`,
      receipt: { http_status: status, code: 0 },
    })
  })

  test.each([
    { mode_info: { extra: JSON.stringify({ id_str: 'message-id', private_field: 'not retained' }) } },
    { mode_info: { extra: { id_str: 'message-id' } } },
    { id_str: 'message-id' },
  ])('retains the message ID without retaining the rest of data: %j', async data => {
    const { api } = await loadApi(() => Response.json({ code: 0, data }))
    const result = await api.sendDanmaku('offline test', 42, 'test-csrf')
    expect(result.receipt).toEqual({ http_status: 200, code: 0, message: null, msg: null, id_str: 'message-id' })
  })

  test('a malformed optional extra does not change acceptance', async () => {
    const { api } = await loadApi(() => Response.json({ code: 0, data: { mode_info: { extra: 'invalid JSON' } } }))
    const result = await api.sendDanmaku('offline test', 42, 'test-csrf')
    expect(result).toMatchObject({ success: true, deliveryConfirmed: false, receipt: { id_str: null } })
  })

  test('a JSON parse failure retains the actual HTTP status', async () => {
    const response = new Response('not JSON', { status: 502 })
    const parseError = await response
      .clone()
      .json()
      .catch((error: Error) => error.message)
    const { api, requests } = await loadApi(() => response)
    const result = await api.sendDanmaku('offline test', 42, 'test-csrf')
    expect(result).toMatchObject({ success: false, deliveryConfirmed: false, error: parseError })
    expect(result.receipt).toEqual({ http_status: 502, code: null, message: null, msg: null, id_str: null })
    expect(requests).toHaveLength(1)
  })

  test('a network failure preserves its error without inventing a receipt', async () => {
    const { api, requests } = await loadApi(() => {
      throw new TypeError('Failed to fetch')
    })
    const result = await api.sendDanmaku('offline test', 42, 'test-csrf')
    expect(result).toMatchObject({ success: false, deliveryConfirmed: false, error: 'Failed to fetch' })
    expect(result.receipt).toEqual({ http_status: null, code: null, message: null, msg: null, id_str: null })
    expect(requests).toHaveLength(1)
  })

  test.each([false, true])('preserves the request payload and emoticon option %j', async emoticon => {
    const { api, requests } = await loadApi(() => Response.json({ code: 0 }), emoticon)
    const result = await api.sendDanmaku('offline test', 42, 'test-csrf')
    expect(result.isEmoticon).toBe(emoticon)
    expect(requests[0].url).toBe(`${BASE_URL.BILIBILI_MSG_SEND}?`)
    expect(requests[0].options).toMatchObject({ method: 'POST', credentials: 'include' })
    const form = requests[0].options?.body as FormData
    const fields = Object.fromEntries(form.entries())
    const rnd = fields.rnd
    expect(rnd).toMatch(/^\d+$/)
    expect(fields).toEqual({
      bubble: '2',
      msg: 'offline test',
      color: '16777215',
      mode: '1',
      room_type: '0',
      jumpfrom: '0',
      reply_mid: '0',
      reply_attr: '0',
      replay_dmid: '',
      statistics: '{"appId":100,"platform":5}',
      fontsize: '25',
      rnd,
      roomid: '42',
      csrf: 'test-csrf',
      csrf_token: 'test-csrf',
      ...(emoticon ? { dm_type: '1', emoticon_options: '{}' } : {}),
    })
  })
})

test('direct API calls count actual dispatches and callback order without requiring the queue', async () => {
  const before = sendStats.pageSendStats.peek()
  const events: string[] = []
  const { api } = await loadApi(() => {
    events.push('fetch')
    return Response.json({ code: 0 })
  })
  const result = await api.sendDanmaku('offline', 42, 'test-csrf', {
    onRequestStart: () => events.push('start'),
    onResult: () => events.push('result'),
  })
  expect(result.success).toBe(true)
  expect(events).toEqual(['start', 'fetch', 'result'])
  expect(sendStats.pageSendStats.peek()).toEqual({
    ...before,
    requests: before.requests + 1,
    accepted: before.accepted + 1,
  })
})

test('a preparation error settles before any fetch or request-start notification', async () => {
  const before = sendStats.pageSendStats.peek()
  const { api, requests } = await loadApi(
    () => Response.json({ code: 0 }),
    false,
    new Error('emote preparation failed')
  )
  const started = mock(() => {})
  const settled = mock(() => {})
  const result = await api.sendDanmaku('offline', 42, 'test-csrf', { onRequestStart: started, onResult: settled })
  expect(result).toMatchObject({ success: false, error: 'emote preparation failed' })
  expect(requests).toHaveLength(0)
  expect(started).not.toHaveBeenCalled()
  expect(settled).toHaveBeenCalledTimes(1)
  expect(sendStats.pageSendStats.peek()).toEqual({ ...before, preparationFailed: before.preparationFailed + 1 })
})

test('a direct API network failure still consumes exactly one actual fetch attempt', async () => {
  const before = sendStats.pageSendStats.peek()
  const { api } = await loadApi(() => {
    throw new TypeError('Failed to fetch')
  })
  const result = await api.sendDanmaku('offline', 42, 'test-csrf')
  expect(result.success).toBe(false)
  expect(sendStats.pageSendStats.peek()).toEqual({
    ...before,
    requests: before.requests + 1,
    failed: before.failed + 1,
  })
})

test('FormData construction failures settle without attempting a request', async () => {
  const before = sendStats.pageSendStats.peek()
  class BrokenFormData extends FormData {
    constructor() {
      super()
      throw new Error('form setup failed')
    }
  }
  const { api, requests } = await loadApi(() => Response.json({ code: 0 }), false, undefined, BrokenFormData)
  const settled = mock((_result: unknown) => {})
  const result = await api.sendDanmaku('offline', 42, 'test-csrf', { onResult: settled })
  expect(result).toMatchObject({ success: false, error: 'form setup failed' })
  expect(requests).toHaveLength(0)
  expect(settled).toHaveBeenCalledTimes(1)
  expect(sendStats.pageSendStats.peek()).toEqual({ ...before, preparationFailed: before.preparationFailed + 1 })
})
