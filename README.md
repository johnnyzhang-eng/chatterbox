# LAPLACE Chatterbox

A userscript for Bilibili Live that adds danmaku (chat message) utilities — auto-send loops, speech-to-text, meme lists, AI evasion, Copy Ninja multi-account mirroring, and more.

## Install

Requires a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).

Install from [LAPLACE Live!](https://laplace.live/chatterbox).

Copy Ninja (拷贝忍者) also needs [kakashi-server](apps/kakashi-server) running on the same machine.

## Layout

| Package                                                  | What                                                    |
| -------------------------------------------------------- | ------------------------------------------------------- |
| [`apps/chatterbox`](apps/chatterbox)                     | The userscript (`laplace-chatterbox`)                   |
| [`apps/kakashi-server`](apps/kakashi-server)             | Copy Ninja relay, shipped as signed standalone binaries |
| [`packages/kakashi-protocol`](packages/kakashi-protocol) | WebSocket protocol shared by the two                    |

## Development

```bash
bun install
bun run dev          # userscript dev server
bun run dev:server   # kakashi-server in watch mode
bun run lint && bun run typecheck && bun test
bun run build        # userscript → apps/chatterbox/dist
```

## Credits

- The auto-seek (自动追帧) algorithm — buffer thresholds, speed ladder,
  slowdown semantics, and default values — is adapted from c-basalt's
  [`Bilibili 直播自动追帧`](https://github.com/c-basalt/bilibili-live-seeker-script)
  userscript (GPL-3.0). Our reimplementation is event-driven rather than
  interval-polled and shares no code with the upstream, but the algorithm
  belongs to them.

## License

AGPL-3.0
