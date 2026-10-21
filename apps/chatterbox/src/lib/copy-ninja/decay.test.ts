import { describe, expect, test } from 'bun:test'

import { pickDelayMs, planCopy } from './decay'

const sequence = (...values: number[]) => {
  let i = 0
  return () => values[i++] ?? 0
}

describe('planCopy', () => {
  const base = { sourceEnabled: true, dropPercent: 0, delayMinSec: 1, delayMaxSec: 3 }

  test('skips sources this mirror opted out of without rolling', () => {
    const random = sequence(0)
    expect(planCopy({ ...base, sourceEnabled: false, dropPercent: 100, random })).toEqual({
      kind: 'skip',
      reason: '未跟随此类动作',
    })
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
