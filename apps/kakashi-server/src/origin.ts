const LIVE_ORIGINS = ['https://live.bilibili.com']

// Managers that run userscripts in an extension context send the extension's origin instead of the page's.
const EXTENSION_PROTOCOLS = ['chrome-extension:', 'moz-extension:', 'safari-web-extension:']

/**
 * Whether a WebSocket handshake `Origin` may connect. Browsers always send it, so this is what stops an
 * arbitrary website from driving the accounts; a missing header means a non-browser client.
 */
export function isOriginAllowed(origin: string | null, extraOrigins: readonly string[] = []): boolean {
  if (origin === null) return true
  if (LIVE_ORIGINS.includes(origin) || extraOrigins.includes(origin)) return true
  if (!URL.canParse(origin)) return false
  return EXTENSION_PROTOCOLS.includes(new URL(origin).protocol)
}

/** Whether `host` only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
}
