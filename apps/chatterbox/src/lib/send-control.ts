let automaticStopEpoch = 0
const stopListeners = new Set<() => void>()

/** Capture the current automatic-send generation before asynchronous preparation. */
export function automaticSendGuard(callerGuard: () => boolean = () => true): () => boolean {
  const epoch = automaticStopEpoch
  return () => epoch === automaticStopEpoch && callerGuard()
}

/** Register producer/queue cleanup without introducing queue-to-producer imports. */
export function onAutomaticSendStop(listener: () => void): () => void {
  stopListeners.add(listener)
  return () => stopListeners.delete(listener)
}

/** Invalidate old work and stop automatic producers after an actual send failure. */
export function stopAutomaticSends(): void {
  automaticStopEpoch++
  for (const listener of stopListeners) {
    try {
      listener()
    } catch (err) {
      console.error('[LAPLACE Chatterbox] automatic send cleanup failed:', err)
    }
  }
}
