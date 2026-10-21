import { parseArgs } from 'node:util'
import { DEFAULT_PORT, PROTOCOL_VERSION } from '@laplace.live/kakashi-protocol'

import pkg from '../package.json' with { type: 'json' }
import { isLoopbackHost } from './origin'
import { startKakashiServer } from './server'

const HELP = `LAPLACE Kakashi Server v${pkg.version} — Copy Ninja relay for LAPLACE Chatterbox

Usage: kakashi-server [options]

Options:
  --port <port>           Port to listen on (env KAKASHI_PORT, default ${DEFAULT_PORT})
  --host <host>           Interface to bind (env KAKASHI_HOST, default 127.0.0.1)
  --token <token>         Require this token from every tab (env KAKASHI_TOKEN); required off loopback
  --allow-origin <origin> Extra WebSocket origin to accept; repeatable (env KAKASHI_ALLOW_ORIGINS, comma-separated)
  --debug                 Verbose logging (env DEBUG=1)
  -v, --version           Print the version
  -h, --help              Show this help
`

function timestamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false })
}

function log(line: string): void {
  console.log(`[${timestamp()}] ${line}`)
}

/** Keep a double-clicked Windows console open long enough to read why it exited. */
function exitWithError(message: string): never {
  console.error(message)
  if (process.platform === 'win32' && Bun.isStandaloneExecutable) prompt('Press Enter to exit')
  process.exit(1)
}

function readArgs() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        token: { type: 'string' },
        'allow-origin': { type: 'string', multiple: true },
        debug: { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch (err) {
    return exitWithError(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`)
  }
}

const args = readArgs()
if (args.help) {
  console.log(HELP)
  process.exit(0)
}
if (args.version) {
  console.log(pkg.version)
  process.exit(0)
}

const port = Number(args.port ?? process.env.KAKASHI_PORT ?? DEFAULT_PORT)
if (!Number.isInteger(port) || port < 1 || port > 65535) exitWithError(`Invalid port: ${args.port}`)

const hostname = args.host ?? process.env.KAKASHI_HOST ?? '127.0.0.1'
const token = args.token ?? process.env.KAKASHI_TOKEN ?? ''
if (!token && !isLoopbackHost(hostname)) {
  exitWithError(`--token is required when listening on ${hostname}: anyone on the network could drive your accounts.`)
}

const extraOrigins = [
  ...(args['allow-origin'] ?? []),
  ...(process.env.KAKASHI_ALLOW_ORIGINS?.split(',') ?? []),
].flatMap(origin => (origin.trim() ? [origin.trim()] : []))

const debugEnabled = !!args.debug || process.env.DEBUG === '1' || process.env.DEBUG?.toLowerCase() === 'true'

let running: ReturnType<typeof startKakashiServer>
try {
  running = startKakashiServer({
    port,
    hostname,
    token,
    extraOrigins,
    version: pkg.version,
    log,
    debug: debugEnabled ? line => log(`🐛 ${line}`) : undefined,
  })
} catch (err) {
  const inUse = err instanceof Error && 'code' in err && err.code === 'EADDRINUSE'
  exitWithError(
    inUse
      ? `Port ${port} is already in use. Is another kakashi-server running? Pick another with --port.`
      : `Failed to start: ${err instanceof Error ? err.message : String(err)}`
  )
}

const url = running.server.url.href.replace(/^http/, 'ws').replace(/\/$/, '')
console.log(`🥷 LAPLACE Kakashi Server v${pkg.version} (protocol ${PROTOCOL_VERSION})`)
console.log(`🚀 Listening on ${url}`)
console.log(`🔐 Token: ${token ? 'required' : 'off (loopback only)'}`)
if (extraOrigins.length) console.log(`🌐 Extra origins: ${extraOrigins.join(', ')}`)
console.log(`🐛 Debug: ${debugEnabled ? 'on' : 'off'}`)
console.log(`\nIn Chatterbox, open the 忍者 tab and set 服务器地址 to ${url}\n`)
