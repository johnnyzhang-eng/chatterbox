import { afterEach, describe, expect, test } from 'bun:test'
import type { HelloMessage, ServerMessage } from '@laplace.live/kakashi-protocol'
import { CloseCode, PROTOCOL_VERSION, parseServerMessage } from '@laplace.live/kakashi-protocol'

import { startKakashiServer } from './server'

const ORIGIN = 'https://live.bilibili.com'
const servers: ReturnType<typeof startKakashiServer>[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
})

function start(token = '') {
  const running = startKakashiServer({ port: 0, hostname: '127.0.0.1', token, extraOrigins: [], version: 'test' })
  servers.push(running)
  return `ws://127.0.0.1:${running.server.port}`
}

function hello(overrides: Partial<HelloMessage>): HelloMessage {
  return {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    token: '',
    clientVersion: 'test',
    uid: '1',
    uname: 'u1',
    role: 'mirror',
    roomId: 100,
    visible: true,
    ...overrides,
  }
}

/** Connect, send `first`, and collect parsed frames plus the close code. */
function connect(url: string, first: unknown, origin = ORIGIN) {
  const ws = new WebSocket(url, { headers: { Origin: origin } })
  const messages: ServerMessage[] = []
  const waiters: (() => void)[] = []
  const closed = new Promise<number>(resolve => ws.addEventListener('close', e => resolve(e.code)))
  ws.addEventListener('open', () => ws.send(JSON.stringify(first)))
  ws.addEventListener('message', e => {
    const parsed = typeof e.data === 'string' ? parseServerMessage(JSON.parse(e.data)) : null
    if (parsed) messages.push(parsed)
    for (const wake of waiters.splice(0)) wake()
  })
  async function next(type: ServerMessage['type']): Promise<ServerMessage> {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const index = messages.findIndex(m => m.type === type)
      const message = index >= 0 ? messages.splice(index, 1)[0] : undefined
      if (message) return message
      await new Promise<void>(resolve => {
        waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
    throw new Error(`timed out waiting for ${type}`)
  }
  return { ws, next, closed }
}

describe('handshake', () => {
  test('rejects a website origin before upgrading', async () => {
    const url = start()
    const { closed } = connect(url, hello({}), 'https://evil.example')
    expect(await closed).not.toBe(1000)
  })

  test('rejects opaque and extension origins by default', async () => {
    const url = start()
    expect(await connect(url, hello({}), 'null').closed).not.toBe(1000)
    expect(await connect(url, hello({}), 'chrome-extension://abc').closed).not.toBe(1000)
  })

  test('closes with UNAUTHORIZED on a wrong token', async () => {
    const url = start('secret')
    const { closed } = connect(url, hello({ token: 'nope' }))
    expect(await closed).toBe(CloseCode.UNAUTHORIZED)
  })

  test('closes with PROTOCOL_MISMATCH for a newer client', async () => {
    const url = start()
    const { closed } = connect(url, { type: 'hello', protocol: PROTOCOL_VERSION + 1 })
    expect(await closed).toBe(CloseCode.PROTOCOL_MISMATCH)
  })

  test('serves a JSON health check over plain HTTP', async () => {
    const url = start()
    const res = await fetch(url.replace('ws://', 'http://'))
    expect(await res.json()).toEqual({ name: 'kakashi-server', version: 'test', protocol: PROTOCOL_VERSION })
  })
})

test('relays a master send to a mirror and the result back', async () => {
  const url = start('secret')
  const master = connect(url, hello({ uid: '1', uname: 'master', role: 'master', token: 'secret' }))
  expect(await master.next('welcome')).toMatchObject({ type: 'welcome', protocol: PROTOCOL_VERSION })
  const mirror = connect(url, hello({ uid: '2', uname: 'mirror', role: 'mirror', token: 'secret' }))
  await mirror.next('welcome')
  await mirror.next('roster')

  master.ws.send(
    JSON.stringify({ type: 'action', action: { kind: 'danmaku', roomId: 100, text: '晚上好', source: 'manual' } })
  )
  const delivery = await mirror.next('action')
  if (delivery.type !== 'action') throw new Error('expected action')
  expect(delivery.action.text).toBe('晚上好')
  expect(delivery.from).toEqual({ uid: '1', uname: 'master' })

  mirror.ws.send(JSON.stringify({ type: 'result', eventId: delivery.eventId, status: 'sent' }))
  expect(await master.next('result')).toEqual({
    type: 'result',
    eventId: delivery.eventId,
    uid: '2',
    uname: 'mirror',
    status: 'sent',
  })
  master.ws.close()
  mirror.ws.close()
})
