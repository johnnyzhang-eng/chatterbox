import { join } from 'node:path'
import { parseArgs } from 'node:util'

import pkg from '../package.json' with { type: 'json' }

const TARGETS = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64', 'bun-linux-arm64', 'bun-windows-x64'] as const

type Target = (typeof TARGETS)[number]

const ROOT = join(import.meta.dir, '..')

function isTarget(value: string): value is Target {
  return TARGETS.some(target => target === value)
}

function hostTarget(): string {
  return `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
}

/** `0.1.0-beta.1` → `0.1.0.0`; Windows version info wants four numeric parts. */
function windowsVersion(version: string): string {
  const [major = '0', minor = '0', patch = '0'] = (version.split('-')[0] ?? '').split('.')
  return `${major}.${minor}.${patch}.0`
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { target: { type: 'string', multiple: true }, all: { type: 'boolean' } },
})

const requested = values.all ? [...TARGETS] : (values.target ?? [hostTarget()])
const targets = requested.filter(isTarget)
if (targets.length !== requested.length) {
  console.error(`Unknown target in ${requested.join(', ')}; expected one of ${TARGETS.join(', ')}`)
  process.exit(1)
}

for (const target of targets) {
  const [, os, arch] = target.split('-')
  const isWindows = os === 'windows'
  const outfile = join(ROOT, 'dist', `kakashi-server-${os}-${arch}${isWindows ? '.exe' : ''}`)
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'src/index.ts')],
    // Unminified so user-reported stack traces stay readable; with bytecode on, Bun can only emit an external map.
    bytecode: true,
    compile: {
      target,
      outfile,
      // A stray bunfig.toml `preload` in the working directory would otherwise run arbitrary code.
      autoloadBunfig: false,
      // Bun can only write these resources when building on Windows itself.
      windows:
        isWindows && process.platform === 'win32'
          ? {
              icon: join(ROOT, 'assets/icon.ico'),
              title: 'LAPLACE Kakashi Server',
              publisher: 'LAPLACE Live!',
              version: windowsVersion(pkg.version),
              description: 'Copy Ninja relay for LAPLACE Chatterbox',
              copyright: `© ${new Date().getFullYear()} LAPLACE Live!`,
            }
          : undefined,
    },
  })
  if (!result.success) {
    for (const message of result.logs) console.error(message)
    process.exit(1)
  }
  console.log(`✓ ${outfile}`)
}
