/**
 * The routing rule that decides whether an incoming room event wakes this
 * workspace's agent.
 *
 * The rule is a single sentence: **only a member's own mention of themselves runs
 * that member's agent**. Everything else is recorded and read, never executed.
 *
 * The consequences are worth stating because they are the point of the design:
 *
 * - Nobody can drive someone else's agent, so nobody can spend another member's
 *   model budget or reach their files through a mention.
 * - `@everyone` and `@someone-else` are ordinary messages. They broadcast; they do
 *   not fan out into N agent runs.
 * - Every message still reaches every agent's context, so an agent answering later
 *   has read the whole conversation. Execution is gated; visibility is not.
 */
import type { RoomEvent, RoomMember } from './backend.ts'

/** Identifies a member mentioned by an event. */
export interface MentionTarget {
  readonly memberId: string
  /** `all` is reserved for `@everyone`; it never equals a member id, so it never triggers. */
  readonly kind: 'member' | 'all'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads the `source` object off an event's `data`, if it is shaped like a message. */
export const eventSource = (event: RoomEvent): Record<string, unknown> | undefined => {
  if (!isRecord(event.data)) return undefined
  const source = event.data['source']
  return isRecord(source) ? source : undefined
}

/** The DataOps user a message came from, when the event identifies one. */
export const senderId = (event: RoomEvent): string | undefined => {
  const memberId = eventSource(event)?.['memberId']
  return typeof memberId === 'string' && memberId.length > 0 ? memberId : undefined
}

/** True when the event is a member's agent reply rather than a human message. */
export const isAgentReply = (event: RoomEvent): boolean =>
  eventSource(event)?.['authorKind'] === 'agent'

/** The global backend id carried on the event, used for local deduplication. */
export const messageId = (event: RoomEvent): string | undefined => {
  const id = eventSource(event)?.['messageId']
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Reads structured mentions off an event.
 *
 * Mentions are declared by the sender's client as member ids — never parsed out of
 * message text. Parsing text would misread a code sample containing `@`, and it
 * would let any message smuggle itself into an execution path.
 */
export const mentionsOf = (event: RoomEvent): readonly MentionTarget[] => {
  const raw = eventSource(event)?.['mentions']
  if (!Array.isArray(raw)) return []
  const targets: MentionTarget[] = []
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) targets.push({ memberId: entry, kind: 'member' })
  }
  return targets
}

/** A room's reply policy. Room-level, so it is the same for every member. */
export type AgentTriggerPolicy = 'mention' | 'always' | 'never'

/**
 * The decision the whole design turns on.
 *
 * Under the default `mention` policy this requires the sender to be this workspace's
 * member *and* to have mentioned that same member, which is the only combination that
 * may start a turn. `always` and `never` are the room's explicit overrides; both change
 * only whether a turn runs, never what is recorded or what each agent can read.
 */
export const shouldTriggerAgent = (
  event: RoomEvent,
  workspaceUserId: string,
  roomMembers: readonly RoomMember[],
  policy: AgentTriggerPolicy = 'mention',
): boolean => {
  // Settled before any per-message reasoning: under `never` a message that would
  // otherwise qualify still starts nothing.
  if (policy === 'never') return false
  const sender = senderId(event)
  if (sender === undefined || sender !== workspaceUserId) return false
  // An agent's own reply must never re-trigger an agent; that is an infinite echo, and
  // it stays forbidden under `always`.
  if (isAgentReply(event)) return false
  if (policy === 'always') return true
  // A mention of a non-member does not resolve, so it cannot trigger anything.
  const memberIds = new Set(roomMembers.map((member) => member.userId))
  return mentionsOf(event).some((target) =>
    target.kind === 'member' && target.memberId === sender && memberIds.has(target.memberId))
}

/**
 * Renders the name prefix for a message this workspace did not author.
 *
 * DSH's compaction summarizes raw `role` + `content` and carries no speaker field,
 * so identity must live inside `content` to survive summarization. This mirrors the
 * shipped `agent-team` plugin, which prefixes `Team message from <name>:`.
 */
export const speakerPrefix = (event: RoomEvent, roomMembers: readonly RoomMember[]): string => {
  const source = eventSource(event)
  if (source === undefined) return ''
  const memberId = typeof source['memberId'] === 'string' ? source['memberId'] : undefined
  const known = memberId === undefined ? undefined : roomMembers.find((member) => member.userId === memberId)
  const name = known?.displayName
    ?? (typeof source['memberName'] === 'string' && source['memberName'].length > 0 ? source['memberName'] : undefined)
    ?? '未知成员'
  return isAgentReply(event) ? `[${name} 的 agent] ` : `${name}：`
}

/** Prepends the speaker to each text block so the model can attribute the message. */
export const withSpeakerPrefix = (event: RoomEvent, prefix: string): RoomEvent => {
  if (prefix.length === 0 || !isRecord(event.data)) return event
  const content = event.data['content']
  if (!Array.isArray(content)) return event
  const rewritten = content.map((block) => {
    if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') return block
    return { ...block, text: `${prefix}${block['text']}` }
  })
  return { ...event, data: { ...event.data, content: rewritten } }
}
