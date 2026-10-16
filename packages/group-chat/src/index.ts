/**
 * Human-agent group chat for DSH workspaces.
 *
 * A room is a message bus shared by its members. Each member's workspace keeps its
 * own copy of every message, and each member's agent is a local subscriber that
 * acts only on its own instructions:
 *
 * - A member's client posts a message; the **server** assigns the global order and
 *   returns the finalized event, which is appended here only after that
 *   acknowledgement. A refusal therefore never reaches the append-only log.
 * - The same broadcast reaches every member's workspace, where it is appended to
 *   that room's session so the local agent can read the whole conversation.
 * - Exactly one case starts an agent turn: the sender mentioned **themselves**.
 *   Everything else is recorded and read, never executed — so no member can drive
 *   another member's agent, spend their budget, or reach their files.
 *
 * The server is addressed by protocol, not by product: any server implementing the
 * room endpoints works. DataOps is the first deployment and supplies environment
 * defaults, so its workspaces need no configuration.
 *
 * The plugin registers nothing at all when no server is configured, which is what
 * keeps an ordinary DSH installation and every ordinary session unaffected.
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { mkdir } from 'node:fs/promises'
import { BackendError, GroupChatBackend, type RoomEvent, type RoomMember, type RoomSummary } from './backend.ts'
import type { GroupChatContext } from './context.ts'
import {
  DEFAULT_CREDENTIAL_REF,
  resolveRoomDirectory,
  resolveServerTarget,
  resolveWorkspaceRoot,
  type ServerTarget,
} from './identity.ts'
import { shouldTriggerAgent, speakerPrefix, withSpeakerPrefix, type AgentTriggerPolicy } from './routing.ts'
import { openRoomStream } from './stream.ts'

export const name = 'group-chat'

/** Host services this plugin needs beyond the room runtime. */
export const inject = ['agents', 'sessions', 'webServer', 'credentials', 'sessionController', 'workspaceRegistry']

/**
 * Plugin configuration, rendered as editable fields in the DSH settings panel.
 *
 * Every field is optional: leaving them blank uses the environment defaults a
 * managed workspace already carries, so the common case needs no editing while a
 * workspace pointed at any other conforming server can be configured from the UI.
 */
export interface Config {
  /** Origin of the room server, e.g. `http://host.docker.internal:3101`. */
  baseUrl?: string
  /** Credential reference resolved per request; never a secret value. */
  credentialRef?: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default('').description(
    'Origin of the group-chat server. Blank uses the workspace environment default.',
  ),
  credentialRef: z.string().default('').description(
    `Credential reference this plugin resolves per request, sent as a bearer token. Blank uses ${DEFAULT_CREDENTIAL_REF}.`,
  ),
})

export {
  BackendError,
  GroupChatBackend,
  isTransportFailure,
  type EventPage,
  type RoomEvent,
  type RoomEventRecord,
  type RoomMember,
  type RoomSummary,
} from './backend.ts'
export {
  DEFAULT_CREDENTIAL_REF,
  MANAGED_ENV,
  resolveServerTarget,
  resolveWorkspaceRoot,
  type ServerTarget,
} from './identity.ts'
export {
  isAgentReply,
  mentionsOf,
  messageId,
  senderId,
  shouldTriggerAgent,
  type AgentTriggerPolicy,
  speakerPrefix,
  withSpeakerPrefix,
} from './routing.ts'

/** Browser-facing route the sidebar calls to list and read rooms. */
export const GROUP_CHAT_ROUTE = '/dsh-group-chat/api'

/**
 * Milliseconds between cursor pulls.
 *
 * Pulling is the fallback and currently the only downlink: it needs no second
 * transport, and a cursor is the whole synchronization state, so it survives a
 * restart without re-appending history. The interval trades a bounded delay for a
 * request the backend already serves.
 */
export const POLL_INTERVAL_MS = 3_000

// The binding is defined in its own module because the browser half reads it too; see there for
// why it cannot live in this file. Imported for local use and re-exported so existing importers
// of this entry keep working.
import { ROOM_SESSION_PREFIX, roomSessionId, roomIdOfSession } from './session-id.ts'
export { ROOM_SESSION_PREFIX, roomSessionId, roomIdOfSession }

/** The most recently appended event belonging to a room. */
export const lastRoomEvent = (session: Session, roomId: string): SessionEvent | undefined => {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const source = (events[index] as { data?: { source?: { roomId?: unknown } } }).data?.source
    if (source?.roomId === roomId) return events[index]
  }
  return undefined
}

/** Narrows the payload `followup` accepts; the check is structural because JSON crossed a boundary. */
export const isUserMessageData = (data: unknown): data is Parameters<Agent['followup']>[0] => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const record = data as { role?: unknown; content?: unknown; id?: unknown; source?: unknown }
  return record.role === 'user'
    && typeof record.id === 'string'
    && Array.isArray(record.content)
    && typeof record.source === 'object' && record.source !== null
}

/**
 * Tracks which room events this workspace already appended.
 *
 * The key is the backend's global id, never the local sequence: the backend owns
 * cross-container order, and the same event can arrive twice (a broadcast and a
 * catch-up pull). Without this the model would read one message twice.
 */
export class RoomEventTracker {
  private readonly seen = new Map<string, Set<string>>()

  /** Records an event and reports whether it was new. */
  accept(roomId: string, globalId: string): boolean {
    const room = this.seen.get(roomId) ?? new Set<string>()
    this.seen.set(roomId, room)
    if (room.has(globalId)) return false
    room.add(globalId)
    return true
  }

  has(roomId: string, globalId: string): boolean {
    return this.seen.get(roomId)?.has(globalId) ?? false
  }

  /**
   * Highest global id seen for a room, as the cursor to resume from.
   *
   * Only the backend's own row id is a cursor. The tracker also holds the message ids it
   * was seeded with, and those are the same value only while every row came from this
   * backend; an older or hand-inserted row carries something else, and `since` answers a
   * non-id with no events at all. Returning one of those would stall the poll permanently
   * rather than resuming it, so they are skipped and the room is re-read from the start.
   */
  cursorOf(roomId: string): string | undefined {
    const room = this.seen.get(roomId)
    if (room === undefined || room.size === 0) return undefined
    let highest: bigint | undefined
    let highestId: string | undefined
    for (const id of room) {
      // Digits only: `Number('')` is 0 and `Number('1e3')` is 1000, and neither is a row id.
      if (!/^\d+$/.test(id)) continue
      const magnitude = BigInt(id)
      if (highest === undefined || magnitude > highest) {
        highest = magnitude
        highestId = id
      }
    }
    return highestId
  }

  /**
   * Rebuilds the tracker from a room's own session log, so a restart resumes from
   * what this workspace already holds instead of re-appending the whole room.
   */
  seedFromSession(roomId: string, events: readonly SessionEvent[]): void {
    for (const event of events) {
      const source = (event as { data?: { source?: { roomId?: unknown; messageId?: unknown } } }).data?.source
      if (source?.roomId !== roomId) continue
      if (typeof source.messageId === 'string') this.accept(roomId, source.messageId)
    }
  }
}

/** Per-room state the runtime keeps while a room is open. */
interface RoomRuntime {
  readonly session: Session
  members: readonly RoomMember[]
  syncing: boolean
  /** The room's reply policy, refreshed whenever the room list is read. */
  policy: AgentTriggerPolicy
}

/**
 * Resolves the DSH session backing one room.
 *
 * A room's session must exist before an event can be appended to it, so a room the
 * member has never opened is created on first sync. Ordinary sessions are never
 * touched because only `roomSessionId` is ever looked up or created.
 */
/**
 * The execution scope one room's session is created with.
 *
 * Grouped rather than passed as positional arguments because every field optional-but-paired
 * reads the same in a call: a provider without a model names no route, and dropping either half
 * silently sends the room back to the deployment default.
 */
interface RoomSessionScope {
  /**
   * The room's own name, used as the workspace title when this room is the one that
   * registers its directory. Create-or-reuse keeps an existing title, so this never
   * renames a workspace an ordinary session already owns.
   */
  readonly name: string
  /**
   * The directory the room's creator chose, when they chose one.
   *
   * Absent means "derive the room's own directory" rather than "use the workspace root":
   * the effective path is resolved in {@link RoomSessions.ensure}, so every caller
   * cannot forget the derivation.
   */
  readonly cwd?: string
  readonly agentPreset?: string
  readonly modelProvider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

class RoomSessions {
  constructor(private readonly ctx: GroupChatContext) {}

  existing(roomId: string): Session | undefined {
    return this.ctx.sessions.get(roomSessionId(roomId) as never)
  }

  /**
   * Open a room's session, creating it through the controller on first use.
   *
   * Creation goes through the controller rather than the session registry because only
   * the controller persists the session and binds its agent. A registry-only session is
   * an in-memory handle that cannot be resumed, so nothing would ever run in the room.
   */
  async ensure(roomId: string, room: RoomSessionScope): Promise<Session> {
    const existing = this.existing(roomId)
    if (existing !== undefined) return existing
    const sessionId = roomSessionId(roomId)
    // The room's directory is what makes the session findable: a Session belongs to a
    // workspace only through its stored `cwd`, and the sidebar reveals a Session by looking
    // it up among the workspaces' own session ids. A room created with a bare `cwd` is
    // therefore attached to nothing, the sidebar lists no session, and clicking the room
    // resolves to no workspace — the GUI falls back to the empty "choose a workspace"
    // state. Registering the directory first is what gives the room somewhere to live.
    const directory = resolveRoomDirectory(roomId, room.cwd)
    // Created before registration because `workspaceRegistry.create` canonicalizes through
    // `fs.realpath` and *rejects* a nonexistent path — it registers a directory, it does
    // not make one. `recursive` also makes this idempotent across restarts, which matters
    // because the room directory lives on the durable volume.
    await mkdir(directory, { recursive: true })
    // Create-or-reuse keyed on the canonical path, so every room open may call this: the
    // first call registers the room's directory, later ones return the same entity, and a
    // room whose creator pointed at an existing directory adopts that workspace instead of
    // cloning it.
    const workspace = await this.ctx.workspaceRegistry.create(directory, room.name)
    // The directory and the preset travel with creation: the directory is the boundary the
    // room agreed to, and the preset decides which tools the room's agent runs with.
    //
    // `workspaceId` rather than `cwd`, and never both: the controller refuses the pair
    // ("session.create accepts workspaceId or cwd, not both"), and `workspaceId` is the
    // half that also attaches the session to the workspace it names.
    await this.ctx.sessionController.create({
      sessionId,
      workspaceId: workspace.id,
      ...room.agentPreset === undefined ? {} : { agentPreset: room.agentPreset },
    })
    // A preset does not choose a model. A session created without a selection runs the
    // deployment default, and a room on a default whose credential is rejected opens fine,
    // starts its turn, and then ends on an authentication failure — which reads as this
    // plugin being broken. Installing the room's own selection is what puts it on a route
    // that works, so it happens before the first turn rather than after a failure.
    if (room.modelProvider !== undefined && room.model !== undefined) {
      await this.ctx.sessionController.selectModel({
        sessionId,
        provider: room.modelProvider,
        model: room.model,
        ...room.reasoningEffort === undefined ? {} : { reasoningEffort: room.reasoningEffort },
      })
    }
    const created = this.existing(roomId)
    if (created === undefined) {
      throw new Error(`group-chat could not open a session for room ${roomId}`)
    }
    return created
  }
}

/**
 * Wire the room runtime.
 *
 * Returns `undefined` on an unmanaged DSH: no route, no listener, no timer. That is
 * the mechanism behind "ordinary sessions are byte-identical with and without this
 * plugin".
 */
export const apply = (ctx: GroupChatContext, config: Config = {}): (() => void) | undefined => {
  // Settings win over the environment defaults DataOps injects, so an operator can
  // point this workspace at any server that implements the protocol.
  const target = resolveServerTarget({
    baseUrl: config.baseUrl,
    credentialRef: config.credentialRef,
  })
  if (target === undefined) return undefined
  return activate(ctx, target)
}

/** The activated runtime; separated so target resolution stays independently testable. */
export const activate = (ctx: GroupChatContext, target: ServerTarget): (() => void) => {
  // One credential path for both faces. The stream and the REST client authenticate as
  // the same principal through the same store entry, so there is no second mechanism to
  // keep in step.
  /** Temporary: the platform logger's destination is not captured by the service. */
  const credential = async (): Promise<string> => {
    const resolved = await ctx.credentials.resolve(credentialRef(target.credentialRef))
    if (resolved?.value === undefined || resolved.value.length === 0) {
      throw new Error('group-chat has no credential to present')
    }
    return resolved.value
  }
  const backend = new GroupChatBackend(target, credential)
  const tracker = new RoomEventTracker()
  const sessions = new RoomSessions(ctx)
  /**
   * Declared before the stream because the stream's sink delivers into it, and the stream
   * is opened before the rooms exist.
   */
  let deliver: (roomId: string, record: { id: string; event: RoomEvent }) => void = () => {}
  const stream = openRoomStream({
    baseUrl: target.baseUrl,
    token: credential,
    onEvent: (pushed) => deliver(pushed.roomId, { id: pushed.id, event: pushed.event }),
    // Logged only. The poll is the fallback, so a transport problem is not an outage.
    onError: (error) => log?.error?.('[group-chat] stream unavailable; polling continues', error),
  })
  const runtimes = new Map<string, RoomRuntime>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const log = ctx.logger
  /** The turn's most recent assistant message, published when the turn closes. */
  let pendingReply: { roomId: string; event: RoomEvent } | undefined
  /**
   * The account this workspace acts as, learned from the server on first use.
   *
   * Resolved once and cached because it changes only if the credential is replaced,
   * and until it is known no message can be recognized as this member's own — so
   * nothing triggers, and messages are still recorded for the agent to read.
   */
  let selfId: string | undefined
  let selfIdResolved = false

  const cwd = (): string => resolveWorkspaceRoot()

  deliver = (roomId: string, record: { id: string; event: RoomEvent }): void => {
    const runtime = runtimes.get(roomId)
    if (runtime === undefined) return
    if (!tracker.accept(roomId, record.id)) return
    // The message is not written here. `followup` below owns that: its contract is to
    // "queue an ordinary follow-up turn" whose item "becomes the sole ordinary message of its
    // own turn", and the driver writes the surface when it runs that turn — `system/message`
    // first, the user message after. Writing it here as well put a `user/message` on the
    // surface before any turn had run, and the log's first surface node must be the protected
    // `system/message`: the reader rejects the session outright once a surface exists without
    // that head ("system/message requires a protected first surface head"). The prefix still
    // has to be applied, because it is what carries the speaker into the model's view.
    const prefix = speakerPrefix(record.event, runtime.members)
    // `withSpeakerPrefix` rewrites the envelope; both official channels take the message
    // inside it (`UserMessage`), so the envelope is unwrapped here rather than handed on.
    const local = withSpeakerPrefix(record.event, prefix)
    const message = (local as { data?: unknown }).data
    // The rule needs an identified actor, and the answer can arrive after the first
    // message does, so it is decided per delivery rather than only at activation. Until
    // the account is known nothing can be recognized as this member's own, so the delivery
    // is decided again once it resolves rather than being dropped.
    const route = (): void => {
      if (selfId !== undefined && shouldTriggerAgent(record.event, selfId, runtime.members, runtime.policy)) {
        void deliverToAgent(roomId, message, true)
        return
      }
      void deliverToAgent(roomId, message, false)
    }
    if (selfId !== undefined || selfIdResolved) route()
    else void resolveSelfId().then(route)
  }

  /** Learns this workspace's account once, so a slow answer delays rather than loses a trigger. */
  const resolveSelfId = async (): Promise<void> => {
    if (selfIdResolved) return
    selfIdResolved = true
    const me = await backend.whoami()
    selfId = me?.id
    if (selfId === undefined) {
      log?.warn?.('[group-chat] the server did not identify this workspace; messages are recorded but no agent turn starts')
    }
  }

  const sync = async (roomId: string): Promise<void> => {
    const runtime = runtimes.get(roomId)
    if (runtime === undefined || runtime.syncing) return
    runtime.syncing = true
    try {
      let cursor = tracker.cursorOf(roomId)
      for (;;) {
        const page = await backend.listEvents(roomId, cursor)
        for (const record of page.events) deliver(roomId, record)
        if (!page.hasMore || page.nextCursor === null || page.events.length === 0) break
        cursor = page.nextCursor
      }
    } catch (error) {
      // A transport failure is retryable and must not tear the room down; the next
      // interval retries from the same cursor because nothing was acknowledged.
      log?.error?.('[group-chat] room sync failed', roomId, error)
    } finally {
      runtime.syncing = false
    }
  }

  const open = async (room: RoomSummary): Promise<void> => {
    if (runtimes.has(room.id)) return
    // The room's own directory, not the workspace root: the room decided at creation
    // which files its agent may touch, and every member shares that scope.
    // Subscribed before the session is built so an event that lands while the room is
    // still opening is not lost: the tracker de-duplicates it against the poll.
    stream.follow(room.id)
    const session = await sessions.ensure(room.id, {
      // The room's name titles the workspace it registers. Absent is the common case and
      // means "derive the room's own directory", which `ensure` resolves.
      name: room.name,
      ...room.cwd === null ? {} : { cwd: room.cwd },
      agentPreset: room.agentPreset ?? undefined,
      modelProvider: room.modelProvider ?? undefined,
      model: room.model ?? undefined,
      reasoningEffort: room.reasoningEffort ?? undefined,
    })
    let members: readonly RoomMember[] = []
    try {
      members = await backend.listMembers(room.id)
    } catch (error) {
      log?.error?.('[group-chat] reading room members failed', room.id, error)
    }
    tracker.seedFromSession(room.id, session.snapshotEvents())
    runtimes.set(room.id, { session, members, syncing: false, policy: room.agentTrigger })
    const timer = setInterval(() => { void sync(room.id) }, POLL_INTERVAL_MS)
    timers.add(timer)
    await sync(room.id)
  }

  /**
   * Wake this workspace's own agent for a self-mention.
   *
   * `followup` queues an ordinary next-turn prompt and wakes the driver; it takes a
   * complete `UserMessage`, not the raw event payload, so the event this plugin just
   * appended is rebuilt as one — same identity, same content, same source. That
   * keeps the model's history and the inbox item describing the same message.
   */
  const deliverToAgent = async (roomId: string, prompt: unknown, wake: boolean): Promise<void> => {
    const sessionId = roomSessionId(roomId)
    // A room session exists but carries no agent until one is resolved onto it, so the
    // live lookup is expected to miss on the first message. `resolveAgent` resumes the
    // session through the controller's own path, which is what binds one.
    let agent = ctx.agents.get(sessionId as never)
    if (agent === undefined) {
      const resolved = await ctx.sessionController.resolveAgent(sessionId as never)
      // The result is a union keyed on which field is present, not on an `ok` flag: a
      // missing `agent` is the failure, and it is what the log must show.
      if (!('agent' in resolved)) {
        log?.warn?.('[group-chat] could not resolve an agent for the room session', roomId, resolved.error)
        return
      }
      agent = resolved.agent
    }
    // The prompt is the message `deliver` already built for this record, not a re-read of the
    // session's last event: the surface holds whatever the driver last committed, which after a
    // turn is the assistant's reply rather than the message that triggered it.
    if (!isUserMessageData(prompt)) return
    try {
      // Two official channels, chosen by whether this delivery should also produce a reply.
      // `followup` "queue[s] an ordinary follow-up turn and wake[s] the driver", so the agent
      // answers; `inject` "queue[s] model-facing context for the next pre-step without waking
      // the driver", so the message reaches the model's context on a later turn without
      // starting one. Neither writes the surface here — the driver does, in its own order.
      //
      // A room where only mentions reached the session would not be a group chat: the agent
      // has to be able to read what was said around it, which is why the unmentioned case
      // still delivers.
      if (wake) agent.followup(prompt)
      else agent.inject(prompt)
    } catch (error) {
    }
  }

  /**
   * Publish the agent's reply when its turn closes.
   *
   * Only the turn's final `assistant/message` is sent: intermediate steps, file
   * reads, and tool output stay in this workspace by construction, which is what
   * keeps them out of a shared room.
   */
  const onSessionEvent = (session: Session, event: SessionEvent): void => {
    const roomId = roomIdOfSession(session)
    if (roomId === undefined) return
    if (event.type === 'assistant/message') {
      // DSH wraps an assistant message as `data.message` (a user message is `data`
      // itself), so the reply is published as that inner message and the backend
      // rebuilds the envelope. Reading `data.role` here would silently publish
      // nothing, because the outer object carries no role.
      const message = (event as { data?: { message?: unknown } }).data?.message
      if (message !== undefined) pendingReply = { roomId, event: { type: 'assistant/message', data: message } }
      return
    }
    if (event.type !== 'turn/end' || pendingReply === undefined) return
    const reply = pendingReply
    pendingReply = undefined
    backend
      .reportAgentEvent(roomId, { rpcId: `${roomId}:${String((event as { seq?: number }).seq ?? 'end')}`, event: reply.event })
      .catch((error: unknown) => { log?.error?.('[group-chat] reporting the agent reply failed', roomId, error) })
  }

  ctx.on('session/event', onSessionEvent)

  /**
   * The browser-facing room API.
   *
   * Registered through `ctx.effect` so unloading the plugin removes the route, and
   * registered before any outbound call because registration order is the contract:
   * a server that is unreachable at startup is exactly the state the settings panel
   * must be able to show, so a failed connection must never prevent the route from
   * existing. The route reports the failure instead.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: GROUP_CHAT_ROUTE,
    handler: async (req: unknown, res: unknown) => {
      const request = req as { url?: string; method?: string; on?: unknown }
      const response = res as { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }
      const url = new URL(request.url ?? '/', 'http://dsh.internal')
      const route = url.pathname.slice(GROUP_CHAT_ROUTE.length).replace(/^\/+/u, '')
      try {
        const payload = await readJsonBody(request)
        const body = await handleRoomRequest(
          route, request.method ?? 'GET', payload, url, backend, runtimes,
        )
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(body))
      } catch (error) {
        // A reachable route that cannot reach the server answers 503 with the
        // reason, so the UI can distinguish "not installed" from "server down".
        const status = error instanceof BackendError ? error.status : 503
        log?.error?.('[group-chat] room request failed', request.method, url.pathname, error)
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    },
  }), 'group-chat: room API route')

  /**
   * Opens every room this member has joined, and keeps looking for new ones.
   *
   * A single startup read is not enough: a member joins a room, or a peer adds them
   * to one, while this container is already running, and a room nobody opened is a
   * room whose messages never reach the agent. Re-reading on the same cadence as the
   * per-room sync is what makes membership actually take effect without a restart.
   */
  const discover = async (): Promise<void> => {
    try {
      const joined = await backend.listRooms()
      for (const room of joined) {
        if (runtimes.has(room.id)) {
          // The policy is a live setting, so an open room picks up a change here
          // rather than keeping the value it was opened with.
          const runtime = runtimes.get(room.id)
          if (runtime !== undefined && runtime.policy !== room.agentTrigger) {
            runtime.policy = room.agentTrigger
          }
          continue
        }
        await open(room)
      }
    } catch (error) {
      // Logged only: the route stays up so the settings panel can report the problem.
      log?.error?.('[group-chat] opening rooms failed', error)
    }
  }

  void (async () => {
    await discover()
    // Asked after the rooms are open so a slow identity lookup cannot delay them.
    await resolveSelfId()
  })()

  const discoverTimer = setInterval(() => { void discover() }, POLL_INTERVAL_MS)
  timers.add(discoverTimer)

  const dispose = (): void => {
    // The socket goes first: it holds a live connection and a reconnect timer, and an
    // event arriving after the runtimes are gone would be delivered to nothing.
    stream.close()
    for (const timer of timers) clearInterval(timer)
    timers.clear()
    runtimes.clear()
  }

  void { open }
  return dispose
}

/**
 * Serves one browser request under {@link GROUP_CHAT_ROUTE}.
 *
 * The browser reaches this through the workspace gateway, which forwards same-origin
 * requests to the DSH host, so the routes are same-origin and need no separate
 * transport or credential.
 */
const handleRoomRequest = async (
  route: string,
  httpMethod: string,
  payload: Record<string, unknown> | undefined,
  url: URL,
  backend: GroupChatBackend,
  runtimes: ReadonlyMap<string, { session: Session; members: readonly RoomMember[] }>,
): Promise<unknown> => {
  const [resource, roomId, ...rest] = route.split('/').filter((part) => part.length > 0)
  const action = rest.join('/')

  // Who this workspace acts as, for the one client-side decision that needs it: which
  // messages are the operator's own. Read from the same account the Host already resolves
  // for routing, so the browser and the trigger rule cannot disagree about identity.
  if (resource === 'me' && httpMethod === 'GET') {
    const me = await backend.whoami()
    return { id: me?.id ?? null, displayName: me?.displayName ?? null }
  }

  if (resource !== 'rooms') throw new Error(`unknown group-chat request: ${httpMethod} ${route}`)

  if (roomId === undefined) {
    if (httpMethod === 'GET') return backend.listRooms()
    if (httpMethod === 'POST') {
      const name = typeof payload?.['name'] === 'string' ? payload['name'] : ''
      if (name.trim().length === 0) throw new Error('group-chat create needs a room name')
      return backend.createRoom(name, readExecution(payload))
    }
    throw new Error(`unknown group-chat request: ${httpMethod} ${route}`)
  }

  if (httpMethod === 'GET') {
    if (action === 'events') {
      const cursor = url.searchParams.get('cursor') ?? undefined
      const limit = url.searchParams.get('limit')
      return backend.listEvents(roomId, cursor, limit === null ? undefined : Number(limit))
    }
    if (action === 'members') return backend.listMembers(roomId)
    if (action === 'state') {
      const runtime = runtimes.get(roomId)
      return {
        roomId,
        open: runtime !== undefined,
        memberCount: runtime?.members.length ?? 0,
      }
    }
  }

  if (httpMethod === 'POST') {
    /**
     * The upstream path, and the order is the contract.
     *
     * The message reaches the server first and this returns the event the server settled;
     * the room's own poll then delivers that same event back through {@link deliver},
     * which is what appends it to the local session. Appending locally first would put a
     * message in the agent's context that the server might never accept, and the two
     * copies would then disagree about the room's history.
     */
    if (action === 'messages') {
      const content = typeof payload?.['content'] === 'string' ? payload['content'] : ''
      const rpcId = typeof payload?.['rpcId'] === 'string' && payload['rpcId'].length > 0
        ? payload['rpcId']
        : `web-${String(Date.now())}`
      return backend.sendMessage(roomId, { content, rpcId })
    }
    if (action === 'update') return backend.updateRoom(roomId, readPolicyPatch(payload))
    if (action === 'members') {
      const userIds = Array.isArray(payload?.['userIds']) ? payload['userIds'].filter(isString) : []
      return backend.inviteMembers(roomId, userIds)
    }
  }

  if (httpMethod === 'DELETE' && action === 'members/me') return backend.leaveRoom(roomId)

  throw new Error(`unknown group-chat request: ${httpMethod} ${route}`)
}

const isString = (value: unknown): value is string => typeof value === 'string'

/**
 * Read the create-time execution scope.
 *
 * `cwd` and the preset decide what the room's agent may touch on any member's behalf, so
 * they travel with creation and are never accepted as later updates.
 */
const readExecution = (
  payload: Record<string, unknown> | undefined,
): { cwd?: string; agentPreset?: string } => ({
  ...typeof payload?.['cwd'] === 'string' && payload['cwd'].trim().length > 0
    ? { cwd: payload['cwd'].trim() } : {},
  ...typeof payload?.['agentPreset'] === 'string' && payload['agentPreset'].trim().length > 0
    ? { agentPreset: payload['agentPreset'].trim() } : {},
})

/** Read the room-policy fields an update may carry, dropping anything else. */
const readPolicyPatch = (payload: Record<string, unknown> | undefined) => ({
  ...typeof payload?.['name'] === 'string' ? { name: payload['name'] } : {},
  ...typeof payload?.['invitePolicy'] === 'string' ? { invitePolicy: payload['invitePolicy'] } : {},
  ...typeof payload?.['discoverability'] === 'string' ? { discoverability: payload['discoverability'] } : {},
  ...typeof payload?.['agentTrigger'] === 'string' ? { agentTrigger: payload['agentTrigger'] } : {},
})

/**
 * Read and parse a JSON request body.
 *
 * The route owns the full response lifecycle, so no framework body parser has run: the
 * stream is read here. A body larger than {@link MAX_REQUEST_BYTES} is refused rather
 * than buffered, since the only bodies this route accepts are small JSON objects.
 */
const readJsonBody = async (req: { on?: unknown }): Promise<Record<string, unknown> | undefined> => {
  const stream = req as AsyncIterable<Uint8Array>
  if (typeof stream[Symbol.asyncIterator] !== 'function') return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw new Error('group-chat request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    throw new Error('group-chat request body is not valid JSON')
  }
}

/** Largest request body this route accepts; the largest legitimate one is a message. */
const MAX_REQUEST_BYTES = 64 * 1024
