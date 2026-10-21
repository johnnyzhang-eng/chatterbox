export type CopyPlan = { kind: 'skip'; reason: string } | { kind: 'drop' } | { kind: 'send'; delayMs: number }

export interface CopyPlanInput {
  sourceEnabled: boolean
  /** 0–100: share of master actions this mirror ignores. */
  dropPercent: number
  delayMinSec: number
  delayMaxSec: number
  random?: () => number
}

/** Random delay in [min, max] seconds, as ms; tolerates swapped or negative bounds. */
export function pickDelayMs(minSec: number, maxSec: number, random: () => number = Math.random): number {
  const lo = Math.max(0, Math.min(minSec, maxSec))
  const hi = Math.max(0, minSec, maxSec)
  return Math.round((lo + random() * (hi - lo)) * 1000)
}

/** Decide what a mirror does with one master action: skip (opted out), drop (decay roll), or send after a delay. */
export function planCopy({
  sourceEnabled,
  dropPercent,
  delayMinSec,
  delayMaxSec,
  random = Math.random,
}: CopyPlanInput): CopyPlan {
  if (!sourceEnabled) return { kind: 'skip', reason: '未跟随此类动作' }
  if (dropPercent > 0 && random() * 100 < dropPercent) return { kind: 'drop' }
  return { kind: 'send', delayMs: pickDelayMs(delayMinSec, delayMaxSec, random) }
}

export interface FollowInput {
  enabled: boolean
  paused: boolean
  /** Room the server last asked this tab to follow. */
  target: number
  masterRoomId: number | null
  currentRoomId: number | null
}

/** Whether to move to `target`: following is on, it is still the master's room, and this tab isn't there yet. */
export function shouldFollow({ enabled, paused, target, masterRoomId, currentRoomId }: FollowInput): boolean {
  return enabled && !paused && masterRoomId === target && currentRoomId !== null && currentRoomId !== target
}
