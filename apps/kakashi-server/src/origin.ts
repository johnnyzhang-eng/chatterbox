const LIVE_ORIGINS = ['https://live.bilibili.com']

/**
 * Whether a WebSocket handshake `Origin` may connect. Browsers always send it, so this stops other websites, opaque
 * (`null`) origins and unrelated extensions from driving the accounts; a missing header means a non-browser client.
 */
export function isOriginAllowed(origin: string | null, extraOrigins: readonly string[] = []): boolean {
  if (origin === null) return true
  return LIVE_ORIGINS.includes(origin) || extraOrigins.includes(origin)
}

/** Whether `host` only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
}
