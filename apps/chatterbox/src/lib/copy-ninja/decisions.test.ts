import { describe, expect, mock, test } from 'bun:test'

import { pickDelayMs, planCopy, shouldFollow } from './decisions'

const sequence = (...values: number[]) => {
  let i = 0
  return () => values[i++] ?? 0
}

describe('planCopy', () => {
  const base = { sourceEnabled: true, dropPercent: 0, delayMinSec: 1, delayMaxSec: 3 }

  test('skips sources this mirror opted out of without rolling', () => {
    const random = mock(() => 0)
    expect(planCopy({ ...base, sourceEnabled: false, dropPercent: 100, random })).toEqual({
      kind: 'skip',
      reason: '未跟随此类动作',
    })
    expect(random).not.toHaveBeenCalled()
  })

  test('drops when the decay roll lands under the percentage', () => {
    expect(planCopy({ ...base, dropPercent: 30, random: sequence(0.29) })).toEqual({ kind: 'drop' })
    expect(planCopy({ ...base, dropPercent: 30, random: sequence(0.3, 0.5) })).toEqual({ kind: 'send', delayMs: 2000 })
  })

  test('never drops at 0% and always drops at 100%', () => {
    expect(planCopy({ ...base, random: sequence(0, 0) }).kind).toBe('send')
    expect(planCopy({ ...base, dropPercent: 100, random: sequence(0.999) }).kind).toBe('drop')
  })
})

describe('pickDelayMs', () => {
  test('spans the range and tolerates swapped or negative bounds', () => {
    expect(pickDelayMs(1, 3, () => 0)).toBe(1000)
    expect(pickDelayMs(1, 3, () => 1)).toBe(3000)
    expect(pickDelayMs(3, 1, () => 0)).toBe(1000)
    expect(pickDelayMs(-2, 0.5, () => 1)).toBe(500)
  })
})

describe('shouldFollow', () => {
  const base = { enabled: true, paused: false, target: 1, masterRoomId: 1, currentRoomId: 2 }

  test('follows when enabled and still behind the master', () => {
    expect(shouldFollow(base)).toBe(true)
  })

  test('holds when following is off, paused, or the room is unknown', () => {
    expect(shouldFollow({ ...base, enabled: false })).toBe(false)
    expect(shouldFollow({ ...base, paused: true })).toBe(false)
    expect(shouldFollow({ ...base, currentRoomId: null })).toBe(false)
  })

  test('drops a stale target once the master has moved on or come back', () => {
    expect(shouldFollow({ ...base, masterRoomId: 3 })).toBe(false)
    expect(shouldFollow({ ...base, masterRoomId: 2, target: 1 })).toBe(false)
    expect(shouldFollow({ ...base, currentRoomId: 1 })).toBe(false)
  })
})
