/**
 * Room-page transport.
 *
 * The browser talks only to the Host plugin's own route. The Host holds the
 * workspace credential and forwards to the server under the workspace identity, so
 * this module never sees a token and cannot disagree with the agent about who the
 * caller is.
 *
 * @module @sparkelf/dsh-group-chat/client/api
 */

/** The Host route registered by this plugin's own Host half. */
export const GC_API = '/dsh-group-chat/api'

/**
 * One event as the server stores it: the DSH envelope verbatim, with no
 * plugin-specific fields added.
 */
export interface RoomEvent {
  readonly id: string
  readonly event: {
    readonly type: string
    readonly seq?: number
    readonly time?: number
    readonly data?: Record<string, unknown>
  }
}

export interface RoomSummary {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string
  readonly invitePolicy: 'anyone' | 'admin'
  readonly discoverability: 'discoverable' | 'invite_only'
  /** The room's reply policy, which decides whether a message starts a turn. */
  readonly agentTrigger: 'mention' | 'always' | 'never'
  /** The room's agent working directory, or null for the workspace root. */
  readonly cwd: string | null
  /** The room's agent preset, or null for the default. */
  readonly agentPreset: string | null
  readonly memberCount: number
  readonly joined: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RoomMember {
  readonly userId: string
  readonly displayName: string
  readonly owner: boolean
  readonly joinedAt: string
}

export interface EventPage {
  readonly events: readonly RoomEvent[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

/** A failure the page renders as copy rather than as an exception. */
export class RoomError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'RoomError'
  }
}

const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response
  try {
    response = await fetch(`${GC_API}${path}`, {
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init?.headers,
      },
      // Same-origin: the Host route is served from this page's own origin.
      credentials: 'same-origin',
    })
  } catch (cause) {
    throw new RoomError('unreachable', 0)
  }
  if (!response.ok) {
    // The Host relays the server's own status, so each failure keeps its cause instead of
    // collapsing into one generic sentence. 401 and 403 are distinct from 503: the plugin
    // did resolve a credential and the server refused it, which is what a logged-out or
    // expired DataOps session looks like — a reader who saw "unreachable" would go looking
    // at the network instead of signing in again.
    const status = response.status
    if (status === 503) throw new RoomError('credentialMissing', status)
    if (status === 401 || status === 403) throw new RoomError('credentialRejected', status)
    if (status === 404) throw new RoomError('notConfigured', status)
    throw new RoomError('unreachable', status)
  }
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

/**
 * The account this workspace acts as.
 *
 * The message renderer needs it to tell the operator's own messages from another member's,
 * and the browser holds no credential of its own to ask DataOps directly — the Host resolves
 * it from the same identity that decides message routing, so the two cannot disagree.
 *
 * @returns the account id, or `undefined` when the Host cannot identify this workspace.
 */
export const readSelf = async (): Promise<string | undefined> => {
  try {
    const me = await call<{ id?: unknown }>('/me')
    return typeof me?.id === 'string' && me.id.length > 0 ? me.id : undefined
  } catch {
    // An unidentified workspace still shows its rooms; its own messages simply stay where
    // the official renderer puts them rather than being claimed as the operator's.
    return undefined
  }
}

/** Rooms this workspace has joined. */
export const listRooms = (): Promise<readonly RoomSummary[]> => call('/rooms')

export const listMembers = (roomId: string): Promise<readonly RoomMember[]> =>
  call(`/rooms/${encodeURIComponent(roomId)}/members`)

export const listEvents = (roomId: string, cursor?: string): Promise<EventPage> => {
  const suffix = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
  return call(`/rooms/${encodeURIComponent(roomId)}/events${suffix}`)
}

/**
 * Create a room.
 *
 * `cwd` and the preset are sent at creation because they decide the scope every member
 * will share; the server does not accept them afterwards.
 */
export const createRoom = (
  name: string,
  execution?: { cwd?: string; agentPreset?: string },
): Promise<RoomSummary> =>
  call('/rooms', { method: 'POST', body: JSON.stringify({ name, ...execution }) })

export const updateRoom = (
  roomId: string,
  patch: { name?: string; invitePolicy?: string; discoverability?: string; agentTrigger?: string },
): Promise<RoomSummary> =>
  call(`/rooms/${encodeURIComponent(roomId)}/update`, { method: 'POST', body: JSON.stringify(patch) })

export const inviteMembers = (roomId: string, userIds: readonly string[]): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ userIds }),
  })

export const leaveRoom = (roomId: string): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/members/me`, { method: 'DELETE' })

/**
 * Send one message.
 *
 * `rpcId` is the idempotency key: the server keys a retry on it, so a send that
 * succeeded but whose response was lost does not post twice.
 */
export const sendMessage = (roomId: string, content: string, rpcId: string): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, rpcId }),
  })

/** Text carried by an event, ignoring any non-text block. */
export const eventText = (record: RoomEvent): string => {
  const content = (record.event.data as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text?: string } =>
      typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** Who wrote an event, and whether an agent wrote it. */
export const eventAuthor = (record: RoomEvent): { name: string; isAgent: boolean; isSelf: boolean } => {
  const source = (record.event.data as { source?: Record<string, unknown> } | undefined)?.source ?? {}
  return {
    name: String(source.memberName ?? source.agentOwnerId ?? '—'),
    isAgent: source.authorKind === 'agent',
    isSelf: source.isSelf === true,
  }
}
