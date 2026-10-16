/** @module @sparkelf/dsh-group-chat/identity */
import { join } from 'node:path'

/**
 * How this plugin learns where its server is and who it is.
 *
 * The **protocol**, not DataOps, is the contract: any server implementing the
 * documented room endpoints works, so nothing here is specific to DataOps. A
 * deployment supplies values through the plugin's own settings, and DataOps
 * additionally injects environment defaults into its workspace containers so the
 * first-run experience needs no typing.
 *
 * Resolution order is settings first, environment second:
 *
 * 1. An explicit setting always wins — that is what an operator edits, and it is
 *    how a workspace points at any conforming server.
 * 2. The DataOps environment variables fill whatever the settings leave blank.
 */

/** Environment variables DataOps injects into a managed workspace container. */
export const MANAGED_ENV = {
  /** Base URL of the server, e.g. `http://host.docker.internal:3101`. */
  baseUrl: 'DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL',
  /** Workspace root, used as a room session's `cwd`. */
  mountPath: 'DATAOPS_AI_WORKSPACE_MOUNT_PATH',
  /** DSH's own home, where per-room directories live when nobody chose one. */
  home: 'DATAOPS_DSH_HOME',
} as const

/** Directory under DSH's home that holds one directory per room. */
export const ROOMS_DIRECTORY = 'group-chat/rooms'

/**
 * How this plugin authenticates.
 *
 * A DataOps JWT, sent as `Authorization: Bearer`, resolved from the DSH credential
 * store on every request. This is the deployment's single identity and authorization
 * credential — the same one `dataops-managed` and `knowledge-base` use — so this
 * plugin mints no credential of its own and replicates no DataOps policy.
 *
 * The companion container that runs this DSH has no credential in its environment
 * by design, which is why reading the store is the only correct source: the JWT is
 * provisioned there for the workspace.
 */
export const AUTHORIZATION_HEADER = 'authorization'

/**
 * The default credential reference.
 *
 * It names the DataOps access token the workspace already holds in the DSH
 * credential store — the same reference `dataops-managed` and `knowledge-base`
 * use. That is what makes this work in a managed workspace: the companion
 * container has no credential in its environment by design, but the credential
 * store does carry this entry, and a deployment can point the setting at any other
 * reference for a different server.
 */
export const DEFAULT_CREDENTIAL_REF = 'DATAOPS_ACCESS_TOKEN'

/** What the plugin needs in hand before it can talk to a server. */
export interface ServerTarget {
  /** Origin with any trailing slash removed. */
  readonly baseUrl: string
  /** Credential reference to resolve per request. */
  readonly credentialRef: string
}

export interface ResolveTargetInput {
  /** Value from the settings panel, if the operator set one. */
  readonly baseUrl?: string
  readonly credentialRef?: string
  /** Environment bag; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/**
 * Resolves the server target, or `undefined` when this workspace is not configured.
 *
 * `undefined` means "do not activate": no route, no listener, no timer. A
 * half-configured workspace is treated as unconfigured rather than failing loudly,
 * because a plugin that cannot reach a server has nothing useful to do at startup
 * and must not disturb ordinary sessions.
 *
 * The actor is deliberately absent: a bearer credential identifies the account
 * server-side, so the plugin never states who it is and cannot disagree with the
 * server about it.
 */
export const resolveServerTarget = (input: ResolveTargetInput = {}): ServerTarget | undefined => {
  const env = input.env ?? process.env
  const rawBaseUrl = nonEmpty(input.baseUrl) ?? nonEmpty(env[MANAGED_ENV.baseUrl])
  if (rawBaseUrl === undefined) return undefined

  let parsed: URL
  try {
    parsed = new URL(rawBaseUrl)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined

  return {
    baseUrl: rawBaseUrl.replace(/\/+$/u, ''),
    credentialRef: nonEmpty(input.credentialRef) ?? DEFAULT_CREDENTIAL_REF,
  }
}

/** The workspace root a room session uses as its `cwd`. */
export const resolveWorkspaceRoot = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => nonEmpty(env[MANAGED_ENV.mountPath]) ?? process.cwd()

/**
 * The directory one room's session owns.
 *
 * A room needs a workspace of its own, and the only thing that makes a Session belong to
 * one is its stored `cwd`: the sidebar groups Sessions by the workspace whose path equals
 * that directory, and `openSession` finds nothing to show when no workspace claims it.
 * Sharing the workspace root would put every room inside the same workspace as the
 * operator's own Sessions — the rooms would then have to share one directory scope, which
 * is the opposite of a room being a boundary a creator chose.
 *
 * `room.cwd` wins because a creator who named a directory meant it, and the room's members
 * all share that scope. The derived directory is the fallback for the common case where
 * nobody chose one, and it is per-room so two rooms never share a directory by accident.
 *
 * @param roomId - the room the directory belongs to.
 * @param configured - the room's own `cwd`, when its creator set one.
 * @param env - environment bag; defaults to `process.env`.
 * @returns an absolute directory path, which the caller must create before use.
 */
export const resolveRoomDirectory = (
  roomId: string,
  configured?: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const chosen = nonEmpty(configured ?? undefined)
  if (chosen !== undefined) return chosen
  // A per-room directory under DSH's own home. `join` is used rather than a hardcoded
  // separator so the derivation stays correct wherever this runs, and the home falls back
  // to the conventional location the managed launcher sets so an unmanaged run still has a
  // stable place to put the directories.
  const home = nonEmpty(env[MANAGED_ENV.home]) ?? '/workspace/.dataops/dsh'
  return join(home, ROOMS_DIRECTORY, roomId)
}
