/** Bump on any breaking wire change; peers on another version are refused. */
export const PROTOCOL_VERSION = 1

/** Default kakashi-server port; LAPLACE Event Bridge owns 9696. */
export const DEFAULT_PORT = 9697

/** Server URL the userscript starts with. Loopback IP rather than `localhost`, which may resolve to `::1` first. */
export const DEFAULT_SERVER_URL = `ws://127.0.0.1:${DEFAULT_PORT}`

/** App-level WebSocket close codes; the client stops reconnecting on these until its settings change. */
export const CloseCode = {
  UNAUTHORIZED: 4001,
  PROTOCOL_MISMATCH: 4002,
  BAD_HELLO: 4003,
} as const

/** Master send sources; each mirror picks which ones it copies. */
export const ACTION_SOURCES = ['manual', 'loop', 'repeat', 'emote', 'meme', 'blend', 'ai', 'stt'] as const

export type ActionSource = (typeof ACTION_SOURCES)[number]

/** Role a connection claims; the server lets one master uid act at a time. */
export type Role = 'master' | 'mirror'

/** Effective roster role; `standby` = claimed master while another master uid is online. */
export type MemberRole = Role | 'standby'

/** A danmaku the master's send succeeded with. */
export interface DanmakuAction {
  kind: 'danmaku'
  /** Real (long) room id. */
  roomId: number
  /** Final sent text, after replacements and AI polish, so mirrors never re-apply them. */
  text: string
  source: ActionSource
}

export type Action = DanmakuAction

export type CopyStatus = 'sent' | 'failed' | 'dropped' | 'skipped'

export interface HelloMessage {
  type: 'hello'
  protocol: number
  /** Empty when the server runs without a token. */
  token: string
  clientVersion: string
  uid: string
  uname: string
  role: Role
  roomId: number | null
  visible: boolean
  /** Whether this tab moves to the master's room when told (following on and not paused). */
  follow: boolean
}

export interface PresenceMessage {
  type: 'presence'
  role: Role
  roomId: number | null
  visible: boolean
  follow: boolean
}

export interface ActionMessage {
  type: 'action'
  action: Action
}

export interface ResultMessage {
  type: 'result'
  eventId: string
  status: CopyStatus
  detail?: string
}

export type ClientMessage = HelloMessage | PresenceMessage | ActionMessage | ResultMessage

export interface Member {
  uid: string
  uname: string
  role: MemberRole
  roomIds: number[]
  tabs: number
}

export interface WelcomeMessage {
  type: 'welcome'
  serverVersion: string
  protocol: number
}

export interface RosterMessage {
  type: 'roster'
  members: Member[]
  /** Room of the master's most recently active tab. */
  masterRoomId: number | null
}

export interface ActionDeliveryMessage {
  type: 'action'
  eventId: string
  from: { uid: string; uname: string }
  action: Action
}

export interface ResultDeliveryMessage {
  type: 'result'
  eventId: string
  uid: string
  uname: string
  status: CopyStatus
  detail?: string
}

/** Sent to one following tab per mirror uid whose tabs are all outside the master's room. */
export interface FollowMessage {
  type: 'follow'
  roomId: number
}

export interface ErrorMessage {
  type: 'error'
  message: string
}

export type ServerMessage =
  | WelcomeMessage
  | RosterMessage
  | ActionDeliveryMessage
  | ResultDeliveryMessage
  | FollowMessage
  | ErrorMessage

/** Longest `detail` a result may carry; longer frames are rejected, so clients truncate. */
export const MAX_DETAIL_LENGTH = 200

const MAX_SHORT = 64
const MAX_TOKEN = 256
const MAX_TEXT = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isShortString(value: unknown, max = MAX_SHORT): value is string {
  return typeof value === 'string' && value.length <= max
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SHORT
}

function isUid(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value)
}

function isRoomId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNullableRoomId(value: unknown): value is number | null {
  return value === null || isRoomId(value)
}

function isRole(value: unknown): value is Role {
  return value === 'master' || value === 'mirror'
}

function isMemberRole(value: unknown): value is MemberRole {
  return isRole(value) || value === 'standby'
}

function isCopyStatus(value: unknown): value is CopyStatus {
  return value === 'sent' || value === 'failed' || value === 'dropped' || value === 'skipped'
}

/** Whether `value` is one of {@link ACTION_SOURCES}. */
export function isActionSource(value: unknown): value is ActionSource {
  return typeof value === 'string' && ACTION_SOURCES.some(source => source === value)
}

function parseAction(value: unknown): Action | null {
  if (!isRecord(value) || value.kind !== 'danmaku') return null
  const { roomId, text, source } = value
  if (!isRoomId(roomId) || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return null
  if (!isActionSource(source)) return null
  return { kind: 'danmaku', roomId, text, source }
}

function parseMember(value: unknown): Member | null {
  if (!isRecord(value)) return null
  const { uid, uname, role, roomIds, tabs } = value
  if (!isUid(uid) || !isShortString(uname) || !isMemberRole(role)) return null
  if (!Array.isArray(roomIds) || !roomIds.every(isRoomId)) return null
  if (typeof tabs !== 'number' || !Number.isSafeInteger(tabs) || tabs < 0) return null
  return { uid, uname, role, roomIds, tabs }
}

/** The `protocol` a hello frame claims, read before full validation so a newer client gets a version error, not a parse error. */
export function readHelloProtocol(raw: unknown): number | null {
  if (!isRecord(raw) || raw.type !== 'hello' || typeof raw.protocol !== 'number') return null
  return raw.protocol
}

/** Parse a client→server frame; null when malformed. Unknown fields are dropped. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null
  switch (raw.type) {
    case 'hello': {
      const { protocol, token, clientVersion, uid, uname, role, roomId, visible, follow } = raw
      if (typeof protocol !== 'number' || !isShortString(token, MAX_TOKEN) || !isShortString(clientVersion)) return null
      if (!isUid(uid) || !isShortString(uname) || !isRole(role) || !isNullableRoomId(roomId)) return null
      if (typeof visible !== 'boolean' || typeof follow !== 'boolean') return null
      return { type: 'hello', protocol, token, clientVersion, uid, uname, role, roomId, visible, follow }
    }
    case 'presence': {
      const { role, roomId, visible, follow } = raw
      if (!isRole(role) || !isNullableRoomId(roomId) || typeof visible !== 'boolean' || typeof follow !== 'boolean') {
        return null
      }
      return { type: 'presence', role, roomId, visible, follow }
    }
    case 'action': {
      const action = parseAction(raw.action)
      return action ? { type: 'action', action } : null
    }
    case 'result': {
      const { eventId, status, detail } = raw
      if (!isId(eventId) || !isCopyStatus(status)) return null
      if (detail !== undefined && !isShortString(detail, MAX_DETAIL_LENGTH)) return null
      return detail === undefined ? { type: 'result', eventId, status } : { type: 'result', eventId, status, detail }
    }
    default:
      return null
  }
}

/** Parse a server→client frame; null when malformed. Unknown fields are dropped. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (!isRecord(raw)) return null
  switch (raw.type) {
    case 'welcome': {
      const { serverVersion, protocol } = raw
      if (!isShortString(serverVersion) || typeof protocol !== 'number') return null
      return { type: 'welcome', serverVersion, protocol }
    }
    case 'roster': {
      const { members, masterRoomId } = raw
      if (!Array.isArray(members) || !isNullableRoomId(masterRoomId)) return null
      const parsed: Member[] = []
      for (const member of members) {
        const m = parseMember(member)
        if (!m) return null
        parsed.push(m)
      }
      return { type: 'roster', members: parsed, masterRoomId }
    }
    case 'action': {
      const { eventId, from } = raw
      const action = parseAction(raw.action)
      if (!isId(eventId) || !action || !isRecord(from) || !isUid(from.uid) || !isShortString(from.uname)) return null
      return { type: 'action', eventId, from: { uid: from.uid, uname: from.uname }, action }
    }
    case 'result': {
      const { eventId, uid, uname, status, detail } = raw
      if (!isId(eventId) || !isUid(uid) || !isShortString(uname) || !isCopyStatus(status)) return null
      if (detail !== undefined && !isShortString(detail, MAX_DETAIL_LENGTH)) return null
      return detail === undefined
        ? { type: 'result', eventId, uid, uname, status }
        : { type: 'result', eventId, uid, uname, status, detail }
    }
    case 'follow': {
      const { roomId } = raw
      return isRoomId(roomId) ? { type: 'follow', roomId } : null
    }
    case 'error': {
      const { message } = raw
      return isShortString(message, MAX_DETAIL_LENGTH) ? { type: 'error', message } : null
    }
    default:
      return null
  }
}
