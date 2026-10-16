/**
 * The DataOps backend client for group chat.
 *
 * Two directions, deliberately different in shape:
 *
 * - **Uplink** is `fetch` with an awaited acknowledgement. The backend assigns the
 *   globally ordered `id` and returns the finalized event, so the caller can append
 *   that exact event locally. A message that the backend rejects never reaches the
 *   append-only session log.
 * - **Downlink** is a pull by cursor. The backend is the only cross-container
 *   intersection point, so it is also the only authority on order; a cursor is the
 *   whole synchronization state.
 *
 * This module owns no policy: it does not decide who may post where, whether a
 * mention should wake an agent, or which events enter the model. It moves events.
 */
import { AUTHORIZATION_HEADER, type ServerTarget } from './identity.ts'

/** One durable room event as the backend stores it. */
export interface RoomEventRecord {
  /** Global order across every container, as a decimal string. */
  readonly id: string
  /** The complete DSH event envelope, stored without translation. */
  readonly event: RoomEvent
  readonly createdAt?: string
}

/**
 * The envelope half of a DSH event. `data` is `unknown` on purpose: the backend
 * stores it verbatim and this plugin re-appends it verbatim, so nothing here needs
 * to understand content blocks.
 */
export interface RoomEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data: unknown
  readonly surfaceOp?: string
}

export interface RoomSummary {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string
  readonly invitePolicy: 'anyone' | 'admin'
  readonly discoverability: 'discoverable' | 'invite_only'
  /** The room's reply policy, which decides whether a message starts a turn. */
  readonly agentTrigger: 'mention' | 'always' | 'never'
  /**
   * The room's agent working directory, or null for the workspace root.
   *
   * Every member of a room shares this scope, so it is chosen at creation and is the
   * boundary the room's agent may act within on any member's behalf.
   */
  readonly cwd: string | null
  /** The room's agent preset, or null for the default. */
  readonly agentPreset: string | null
  /**
   * The model the room runs on, or nulls to follow the deployment default.
   *
   * A preset does not choose a model: the session's own model selection does, and a session
   * created without one runs the deployment default. When that default is not routable the
   * room can still open a session and start a turn, and the turn ends on an authentication
   * failure that reads like a defect in this plugin.
   */
  readonly modelProvider: string | null
  readonly model: string | null
  readonly reasoningEffort: string | null
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
  readonly events: readonly RoomEventRecord[]
  /** Cursor to resume from; `null` when the room has no events yet. */
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

/** A backend refusal that carries the HTTP status so callers can distinguish them. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

/** True when the request never reached the backend, so retrying cannot duplicate state. */
export const isTransportFailure = (error: unknown): boolean =>
  error instanceof Error && !(error instanceof BackendError)

export interface BackendClientOptions {
  /** Per-request timeout; a stalled backend must not hold a session append path. */
  readonly timeoutMs?: number
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Resolves the credential for one request.
 *
 * The secret is fetched per request rather than captured at activation: a
 * credential can be rotated or added while the plugin is loaded, and caching it
 * would keep sending a stale value. Returning `undefined` means "no credential
 * available", which fails the request instead of sending an anonymous one.
 */
export type CredentialResolver = () => Promise<string | undefined>

/** Thin typed wrapper over the group-chat server protocol. */
export class GroupChatBackend {
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly target: ServerTarget,
    private readonly resolveCredential: CredentialResolver,
    options: BackendClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Builds the headers for one call.
   *
   * The credential is a bearer token, so the request carries the deployment's own
   * identity rather than a plugin-specific one. The room routes are the same ones
   * a browser uses, which is why the plugin needs no parallel server surface.
   */
  private async headers(): Promise<Record<string, string>> {
    const credential = await this.resolveCredential()
    if (credential === undefined || credential.length === 0) {
      throw new Error('group-chat has no credential; configure one in the plugin settings')
    }
    return {
      [AUTHORIZATION_HEADER]: `Bearer ${credential}`,
      'content-type': 'application/json',
    }
  }

  /**
   * Rooms this workspace's member has joined.
   *
   * The response is validated rather than trusted, because a misconfigured base URL
   * does not fail loudly: a web tier in front of the API answers with its SPA
   * fallback, so the plugin receives a success status and a *string*. Iterating a
   * string yields its characters, so an unvalidated caller would treat each character
   * as a room and open a session per character. Rejecting the shape here keeps that
   * failure at the boundary, where the message names the real cause.
   */
  async listRooms(signal?: AbortSignal): Promise<readonly RoomSummary[]> {
    const rooms = await this.request<unknown>('GET', '/api/ai/chat/rooms', undefined, signal)
    if (!Array.isArray(rooms)) {
      throw new Error(
        `group-chat backend returned ${typeof rooms} instead of a room list; check that the base URL points at the API, not a web app`,
      )
    }
    // An entry without an id cannot address a room, and a session keyed on it would be
    // unreachable garbage, so it is filtered rather than opened.
    return rooms.filter((room): room is RoomSummary =>
      typeof room === 'object' && room !== null
      && typeof (room as RoomSummary).id === 'string'
      && (room as RoomSummary).id.length > 0)
  }

  /**
   * The account this workspace acts as, asked of the server rather than configured.
   *
   * The bearer credential already identifies the caller, so the server is the only
   * correct source for "who am I": a configured value could disagree with the
   * credential and silently change which messages trigger this agent.
   */
  /**
   * Ask the server who this workspace is.
   *
   * The response wraps the account: `/api/auth/me` answers `{ user: { id, ... } }`, not a
   * bare account. Reading the id off the top level yields `undefined` for every call,
   * which would leave the workspace unidentified — and an unidentified workspace still
   * records every message but can never match "the sender is me", so no turn ever starts
   * and the agent is silent with nothing in the logs to say why.
   */
  async whoami(signal?: AbortSignal): Promise<{ readonly id: string; readonly displayName?: string } | undefined> {
    try {
      const me = await this.request<{ user?: { id?: unknown; displayName?: unknown } }>(
        'GET', '/api/auth/me', undefined, signal,
      )
      const id = me.user?.id
      if (typeof id !== 'string' || id.length === 0) return undefined
      // The name travels alongside the id because the browser shows it — the roster and the
      // message prefix both come from the server, and re-reading `/api/auth/me` there would
      // be the browser talking to DataOps, which this client half never does.
      const displayName = me.user?.displayName
      return typeof displayName === 'string' && displayName.length > 0 ? { id, displayName } : { id }
    } catch {
      // An unidentified workspace still records every message; it simply never
      // starts a turn, because "the sender is me" cannot be established.
      return undefined
    }
  }

  async listMembers(roomId: string, signal?: AbortSignal): Promise<readonly RoomMember[]> {
    return this.request<readonly RoomMember[]>('GET', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/members`, undefined, signal)
  }

  /**
   * Pull events after `cursor`. Omitting the cursor asks for the room from the start,
   * which is what a fresh container does on its first sync.
   */
  async listEvents(roomId: string, cursor?: string, limit?: number, signal?: AbortSignal): Promise<EventPage> {
    const query = new URLSearchParams()
    if (cursor !== undefined) query.set('cursor', cursor)
    if (limit !== undefined) query.set('limit', String(limit))
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    return this.request<EventPage>('GET', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/events${suffix}`, undefined, signal)
  }

  /**
   * Send one human message. `rpcId` is the idempotency key: a retry that reuses it
   * returns the original row instead of creating a second one, so a timed-out
   * request is safe to repeat.
   */
  async sendMessage(
    roomId: string,
    input: { readonly content: string; readonly rpcId: string; readonly mentions?: readonly string[] },
    signal?: AbortSignal,
  ): Promise<{ readonly id: string; readonly event: RoomEvent; readonly deduplicated: boolean }> {
    return this.request('POST', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/messages`, input, signal)
  }

  /**
   * Create a room.
   *
   * `cwd` and the preset decide what the room's agent may touch on any member's behalf, so
   * they are creation-time scopes rather than later settings.
   */
  async createRoom(
    name: string,
    execution?: { readonly cwd?: string; readonly agentPreset?: string },
    signal?: AbortSignal,
  ): Promise<RoomSummary> {
    return this.request<RoomSummary>('POST', '/api/ai/chat/rooms', {
      name,
      ...execution === undefined ? {} : execution,
    }, signal)
  }

  /** Apply a room's policy fields. Only the room's owner may do this. */
  async updateRoom(
    roomId: string,
    patch: {
      readonly name?: string
      readonly invitePolicy?: string
      readonly discoverability?: string
      readonly agentTrigger?: string
    },
    signal?: AbortSignal,
  ): Promise<RoomSummary> {
    return this.request<RoomSummary>(
      'POST',
      `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/update`,
      patch,
      signal,
    )
  }

  /** Add members to a room, subject to that room's invite policy. */
  async inviteMembers(
    roomId: string,
    userIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('POST', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/members`, { userIds }, signal)
  }

  /** Leave a room. Its history stays on the server; the owner cannot leave. */
  async leaveRoom(roomId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('DELETE', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/members/me`, undefined, signal)
  }

  /**
   * Report one agent reply. Only the turn's final `assistant/message` is sent —
   * intermediate steps stay in this container by construction.
   */
  async reportAgentEvent(
    roomId: string,
    input: { readonly rpcId: string; readonly event: RoomEvent },
    signal?: AbortSignal,
  ): Promise<{ readonly id: string; readonly event: RoomEvent; readonly deduplicated: boolean }> {
    return this.request('POST', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/agent-events`, input, signal)
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    // The credential is resolved before the attempt, so a missing one fails here
    // rather than travelling as an anonymous request.
    const headers = await this.headers()
    let response: Response
    try {
      response = await this.fetchImpl(`${this.target.baseUrl}${path}`, {
        method,
        headers,
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: composed,
      })
    } catch (error) {
      // Network and timeout failures are not backend decisions; the caller may retry.
      throw new Error(`group-chat backend unreachable: ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }

    const text = await response.text()
    const parsed: unknown = text.length === 0 ? undefined : safeJson(text)
    if (!response.ok) {
      throw new BackendError(
        `group-chat backend rejected ${method} ${path} (${response.status})`,
        response.status,
        parsed,
      )
    }
    return parsed as T
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
