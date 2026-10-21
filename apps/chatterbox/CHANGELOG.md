# laplace-chatterbox

## 4.5.0

### Minor Changes

- d5ba5ff: feat: 感知忍術 (Kanchi Ninjutsu) for Copy Ninja mirrors: instead of copying the master verbatim, a mirror can reword each action through its own LLM with a dedicated prompt (设置 → LLM 提示词 → 感知忍術); emotes are still copied as-is

## 4.4.1

### Patch Changes

- 07fd0c4: chore: update @soniox/client to 2.4.0 (and its CDN build), cn to 0.5.0 and @types/bun to 1.4.3

## 4.4.0

### Minor Changes

- 67eed99: feat: 拷贝忍者 (Copy Ninja) multi-account mirroring: sends from a master account are copied by mirror accounts in other browsers through kakashi-server, with per-mirror action toggles, decay (random skip + delay) and room following
