import { afterEach, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import type { BunPlugin } from 'bun'

import { startKakashiServer } from '../../../../kakashi-server/src/server'

const ROOM = 100
const OTHER_ROOM = 200
const LIB = join(import.meta.dir, '..')
const ENTRY = join(import.meta.dir, '__harness__.ts')

interface SentItem {
  message: string
  roomId: number
  source: string
}

/** Real client/mirror/settings modules; Bilibili, GM storage and the send queue are stubbed per account. */
interface Harness {
  startCopyNinja(): void
  stopCopyNinja(): void
  settings: typeof import('./settings')
  store: { cachedRoomId: { value: number | null } }
  sendQueue: { sent: (SentItem & { priority: number })[]; emitSent(item: SentItem): void }
  logs: string[]
}

const servers: ReturnType<typeof startKakashiServer>[] = []
const clients: Harness[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.stopCopyNinja()
  for (const server of servers.splice(0)) server.stop()
})

/** Bundle a fresh copy per account so module state (socket, signals) stays isolated, like separate browsers. */
async function loadClient(uid: string, gm: Record<string, unknown>): Promise<Harness> {
  const files = {
    [ENTRY]: `
      export * from './client'
      export * as settings from './settings'
      export * as store from '../store'
      export * as sendQueue from '../send-queue'
      export { lines as logs } from '../log'
    `,
    [join(LIB, 'api.ts')]: `
      export const getDedeUid = () => ${JSON.stringify(uid)}
      export const getCsrfToken = () => 'csrf'
      export const fetchSelfUname = async () => ${JSON.stringify(`user${uid}`)}
    `,
    [join(LIB, 'store.ts')]: `
      import { signal } from '@preact/signals'
      export const cachedRoomId = signal(${ROOM})
      export const maxLength = signal(40)
    `,
    [join(LIB, 'log.ts')]: `
      export const lines = []
      export function appendLog(entry, label, display) {
        lines.push(typeof entry === 'string' ? entry : label + ': ' + display)
      }
    `,
    [join(LIB, 'send-queue.ts')]: `
      export const SendPriority = { AUTO: 0, STT: 1, COPY: 1, MANUAL: 2 }
      export const sent = []
      const listeners = new Set()
      export function onDanmakuSent(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
      export function emitSent(item) {
        for (const listener of listeners) listener(item)
      }
      export async function enqueueDanmaku(message, roomId, csrfToken, priority, source, guard) {
        await Promise.resolve()
        if (guard && !guard()) return { success: false, cancelled: true, message, isEmoticon: false, error: 'cancelled' }
        sent.push({ message, roomId, priority, source })
        return { success: true, message, isEmoticon: false }
      }
    `,
    [join(LIB, 'emoticon.ts')]: `
      // As if the mirror's cache lacks every emote: ID-shaped text is unavailable to this account.
      export const isEmoticonUnique = () => false
      export const isLockedEmoticon = () => false
      export const isUnavailableEmoticon = text => /^[a-z]+(_\\d+)+$/.test(text)
    `,
  }
  const gmStub: BunPlugin = {
    name: 'gm-stub',
    setup(build) {
      build.onResolve({ filter: /^\$$/ }, () => ({ path: 'gm', namespace: 'gm-stub' }))
      build.onLoad({ filter: /.*/, namespace: 'gm-stub' }, () => ({
        loader: 'js',
        contents: `
          const values = new Map(Object.entries(${JSON.stringify(gm)}))
          export const GM_getValue = (key, fallback) => (values.has(key) ? values.get(key) : fallback)
          export const GM_setValue = (key, value) => values.set(key, value)
          export const GM_deleteValue = key => values.delete(key)
          export const GM_addValueChangeListener = () => 0
          export const GM_info = { script: { version: 'test' } }
        `,
      }))
    },
  }
  const result = await Bun.build({
    entrypoints: [ENTRY],
    files,
    plugins: [gmStub],
    target: 'bun',
    // Bun has no DOM; give the bundle its own `document`/`location` instead of touching globals other tests share.
    banner: [
      'const __harnessDocument = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };',
      'const __harnessLocation = { assign() {} };',
    ].join('\n'),
    define: { document: '__harnessDocument', location: '__harnessLocation' },
  })
  const output = result.outputs[0]
  if (!result.success || !output) throw new AggregateError(result.logs, 'harness build failed')
  const harness: Harness = await import(
    `data:text/javascript;base64,${Buffer.from(await output.text()).toString('base64')}`
  )
  clients.push(harness)
  return harness
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

async function setup() {
  const server = startKakashiServer({
    port: 0,
    hostname: '127.0.0.1',
    token: 'tok',
    extraOrigins: [],
    version: 'test',
    masterGraceMs: 0,
  })
  servers.push(server)
  const common = {
    copyNinjaServerUrl: `ws://127.0.0.1:${server.server.port}`,
    copyNinjaToken: 'tok',
    copyNinjaDelayMinSec: 0,
    copyNinjaDelayMaxSec: 0,
  }
  const master = await loadClient('1', { ...common, copyNinjaRoles: { 1: 'master' } })
  const mirror = await loadClient('2', common)
  master.startCopyNinja()
  mirror.startCopyNinja()
  await until(
    () =>
      master.settings.copyNinjaEffectiveRole.value === 'master' &&
      mirror.settings.copyNinjaEffectiveRole.value === 'mirror' &&
      master.settings.copyNinjaRoster.value.length === 2,
    'both accounts to join'
  )
  return { server, master, mirror, resultFor: (uid: string) => master.settings.copyNinjaResults.value[uid] }
}

test('a master send is copied by the mirror and the result is reported back', async () => {
  const { master, mirror, resultFor } = await setup()
  master.sendQueue.emitSent({ message: '晚上好', roomId: ROOM, source: 'manual' })
  await until(() => mirror.sendQueue.sent.length === 1, 'the mirror copy')
  expect(mirror.sendQueue.sent[0]).toEqual({ message: '晚上好', roomId: ROOM, priority: 1, source: 'copy' })
  await until(() => resultFor('2')?.status === 'sent', 'the sent result')
})

test('each mirror applies its own source toggles and decay', async () => {
  const { master, mirror, resultFor } = await setup()
  mirror.settings.copyNinjaSources.value = { loop: false }
  master.sendQueue.emitSent({ message: '独轮车', roomId: ROOM, source: 'loop' })
  await until(() => resultFor('2')?.status === 'skipped', 'the toggle skip')

  mirror.settings.copyNinjaDropPercent.value = 100
  master.sendQueue.emitSent({ message: '常规发送', roomId: ROOM, source: 'manual' })
  await until(() => resultFor('2')?.status === 'dropped', 'the decay drop')
  expect(mirror.sendQueue.sent).toHaveLength(0)
})

test('copies and mirror sends are never re-broadcast, and group uids are flagged', async () => {
  const { server, master, mirror } = await setup()
  const broadcasts = spyOn(server.hub, 'action')
  mirror.sendQueue.emitSent({ message: '分身自己发的', roomId: ROOM, source: 'manual' })
  master.sendQueue.emitSent({ message: '跟随副本', roomId: ROOM, source: 'copy' })
  await Bun.sleep(100)
  expect(broadcasts).not.toHaveBeenCalled()
  expect(master.sendQueue.sent).toHaveLength(0)
  expect(mirror.sendQueue.sent).toHaveLength(0)
  expect(master.settings.isCopyNinjaMember('2')).toBe(true)
  expect(mirror.settings.isCopyNinjaMember('1')).toBe(true)
})

test('a mirror in another room is reported as skipped', async () => {
  const { master, mirror, resultFor } = await setup()
  mirror.store.cachedRoomId.value = OTHER_ROOM
  await until(
    () => master.settings.copyNinjaRoster.value.some(m => m.uid === '2' && m.roomIds.includes(OTHER_ROOM)),
    'the presence update'
  )
  master.sendQueue.emitSent({ message: '晚上好', roomId: ROOM, source: 'manual' })
  await until(() => resultFor('2')?.detail === '不在同一直播间', 'the room skip')
  expect(mirror.sendQueue.sent).toHaveLength(0)
})

test('a wrong token stops retrying with a readable reason', async () => {
  const server = startKakashiServer({ port: 0, hostname: '127.0.0.1', token: 'tok', extraOrigins: [], version: 'test' })
  servers.push(server)
  const client = await loadClient('3', {
    copyNinjaServerUrl: `ws://127.0.0.1:${server.server.port}`,
    copyNinjaToken: 'x',
  })
  client.startCopyNinja()
  await until(() => client.settings.copyNinjaStatus.value === 'error', 'the auth failure')
  expect(client.settings.copyNinjaStatusDetail.value).toContain('令牌错误')
})

test('copies keep the master order even when random delays would reorder them', async () => {
  const { master, mirror } = await setup()
  mirror.settings.copyNinjaDelayMaxSec.value = 0.3
  for (const message of ['第一段', '第二段', '第三段']) {
    master.sendQueue.emitSent({ message, roomId: ROOM, source: 'manual' })
  }
  await until(() => mirror.sendQueue.sent.length === 3, 'all three copies')
  expect(mirror.sendQueue.sent.map(item => item.message)).toEqual(['第一段', '第二段', '第三段'])
})

test('stopping drops copies that are still waiting out their delay', async () => {
  const { server, master, mirror } = await setup()
  mirror.settings.copyNinjaDelayMinSec.value = 1
  mirror.settings.copyNinjaDelayMaxSec.value = 1
  const broadcasts = spyOn(server.hub, 'action')
  master.sendQueue.emitSent({ message: '晚上好', roomId: ROOM, source: 'manual' })
  await until(() => broadcasts.mock.calls.length === 1, 'the broadcast')
  await Bun.sleep(100)
  mirror.stopCopyNinja()
  await Bun.sleep(1200)
  expect(mirror.sendQueue.sent).toHaveLength(0)
})

test('an emote this mirror lacks is skipped instead of posted as text', async () => {
  const { master, mirror, resultFor } = await setup()
  master.sendQueue.emitSent({ message: 'room_21452505_12345', roomId: ROOM, source: 'emote' })
  await until(() => resultFor('2')?.status === 'skipped', 'the emote skip')
  expect(resultFor('2')?.detail).toBe('该账号无法使用此表情')
  expect(mirror.sendQueue.sent).toHaveLength(0)
})

test('turning following on after connecting schedules the move to the master room', async () => {
  const { mirror } = await setup()
  mirror.store.cachedRoomId.value = OTHER_ROOM
  await Bun.sleep(100)
  expect(mirror.logs.some(line => line.includes('秒后跟随'))).toBe(false)
  mirror.settings.copyNinjaFollowRoom.value = true
  await until(() => mirror.logs.some(line => line.includes(`主控在直播间 ${ROOM}`)), 'the scheduled follow')
})
