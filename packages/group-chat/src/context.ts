import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Host services this plugin needs.
 *
 * `agents` and `sessions` carry the room subscription, `webServer` exposes the
 * browser-facing room API, and `credentials` resolves the token this workspace
 * presents — the secret is never read from configuration or cached in the plugin.
 */
export interface GroupChatHostServices {
  readonly agents: {
    get(id: string): Agent | undefined
    list(): readonly Agent[]
  }
  /**
   * The session registry.
   *
   * Read-only on purpose: sessions are created through `sessionController.create`, which
   * persists them and binds an agent in one step. The registry's own `create` builds an
   * in-memory handle that cannot be resumed, so exposing it here would be an invitation
   * to the one call that makes a room silently never answer.
   */
  readonly sessions: {
    get(id: string): Session | undefined
    list(): readonly Session[]
  }
  readonly credentials: {
    resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined>
  }
  /**
   * The Host API's own session controller.
   *
   * An agent is bound to a session by resuming it, and the controller already owns that
   * sequence — composing the preset, checking the persisted working directory, and
   * rejecting a session another owner holds. Reproducing it here would be a second,
   * divergent implementation of session lifecycle.
   */
  readonly sessionController: {
    /**
     * Create a session and bind an agent to it.
     *
     * Creation is the controller's, not `sessions.create()`: the controller persists the
     * session and binds the agent in one step, while the session registry alone only
     * builds an in-memory handle. A session that was never persisted cannot be resumed,
     * so an agent resolved onto one fails with `SessionPersistenceNotFoundError` and the
     * room never answers.
     */
    create(request: {
      readonly sessionId: string
      /**
       * The workspace the session belongs to.
       *
       * This is the only thing that puts a session under a Workspace row: the sidebar
       * groups sessions from each Workspace's own `sessionIds`. A session created with a
       * bare `cwd` is persisted, carries its directory, and is still openable by id — it
       * just has no Workspace claiming it, so it lands in the shell's ungrouped bucket.
       * Exactly one of `workspaceId` and `cwd` may be given: the controller refuses the
       * pair.
       */
      readonly workspaceId?: string
      /** The session's working directory, independent of Workspace membership. */
      readonly cwd?: string
      readonly agentPreset?: string
    }): Promise<{ readonly sessionId: string }>
    /**
     * Install one session-local model selection.
     *
     * A session created without a selection runs on the deployment default, and a room whose
     * default is not routable has no way to reach a model at all: the agent resolves, the turn
     * starts, and it ends on an authentication failure that reads like a plugin defect. The
     * selection is what decides which provider a session actually talks to.
     */
    selectModel(request: {
      readonly sessionId: string
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }): Promise<unknown>
    /** Resolves to the live agent, or to the failure that prevented resuming one. */
    resolveAgent(sessionId: string): Promise<
      | { readonly agent: Agent }
      | { readonly error: unknown }
    >
  }
  readonly webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler(req: unknown, res: unknown): void | Promise<void>
    }): () => void
  }
  readonly logger?: {
    error(...args: unknown[]): void
    warn?(...args: unknown[]): void
    info?(...args: unknown[]): void
  }
}

export type GroupChatContext = CordisContext & GroupChatHostServices

/** The `session/event` listener signature declared by `dsh-session`. */
export type SessionEventListener = (session: Session, event: SessionEvent) => void
