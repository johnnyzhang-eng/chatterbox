import { expect, test } from 'bun:test'
import * as signals from '@preact/signals'

const source = await Bun.file(new URL('./gm-signal.ts', import.meta.url)).text()
let moduleId = 0

type Listener = (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void

/** Fresh gm-signal module over an in-memory GM store whose listeners can be fired as if from another tab. */
async function loadGmSignal() {
  const values = new Map<string, unknown>()
  const listeners = new Map<string, Listener>()
  const writes: [string, unknown][] = []
  const gm = {
    GM_getValue: (key: string, fallback: unknown) => (values.has(key) ? values.get(key) : fallback),
    GM_setValue: (key: string, value: unknown) => {
      writes.push([key, value])
      values.set(key, value)
    },
    GM_deleteValue: (key: string) => values.delete(key),
    GM_addValueChangeListener: (key: string, listener: Listener) => listeners.set(key, listener),
  }
  const key = `__gmSignalTest${++moduleId}`
  Reflect.set(globalThis, key, { gm, signals })
  const js = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(source)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']\$["'];?/, (_m, names) => `const {${names}} = globalThis.${key}.gm;`)
    .replace(
      /import\s*\{([^}]+)\}\s*from\s*["']@preact\/signals["'];?/,
      (_m, names) => `const {${names}} = globalThis.${key}.signals;`
    )
  try {
    const mod: typeof import('./gm-signal') = await import(
      `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
    )
    /** Simulate another tab writing `value`; `reported` is what the event carries, which may be stale. */
    const remoteWrite = (name: string, value: unknown, reported = value) => {
      values.set(name, value)
      listeners.get(name)?.(name, undefined, reported, true)
    }
    return { ...mod, values, writes, remoteWrite }
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

test('local writes persist, and a synced signal applies other tabs without writing back', async () => {
  const { gmSignal, writes, remoteWrite } = await loadGmSignal()
  const s = gmSignal('role', 'mirror', { syncTabs: true })
  s.value = 'master'
  expect(writes.at(-1)).toEqual(['role', 'master'])
  const writesBefore = writes.length
  remoteWrite('role', 'mirror')
  expect(s.value).toBe('mirror')
  expect(writes).toHaveLength(writesBefore)
})

test('a late callback carrying an older value applies what is stored now', async () => {
  const { gmSignal, remoteWrite } = await loadGmSignal()
  const s = gmSignal('drop', 0, { syncTabs: true })
  remoteWrite('drop', 30, 10)
  expect(s.value).toBe(30)
})

test('signals without syncTabs ignore other tabs', async () => {
  const { gmSignal, remoteWrite } = await loadGmSignal()
  const s = gmSignal('local', 1)
  remoteWrite('local', 2)
  expect(s.value).toBe(1)
})
