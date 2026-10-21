/**
 * Turning grants into the two "share" groups the Home tab shows.
 *
 * The split the reader cares about is DIRECTION: what has been shared with me, and what
 * I have shared out. The grant data has no grantor field (the backend's `toSummary`
 * omits it and the table has no `created_by`), so "who gave me this" cannot be answered
 * from it. What CAN be answered is the audience side: which principal a grant names.
 *
 * Everything here is a pure function of the grant list plus the caller, which is what
 * makes the two-way split testable without a browser.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/** One grant, in the shape the Host relays. */
export interface ShareGrant {
  /** Stable row id. */
  id: string
  /** Path relative to the knowledge mount point. */
  relPath: string
  /** Whether the path is a file or a directory. */
  kind: 'file' | 'directory'
  /** Principal kind the grant names. */
  principalType: 'user' | 'role' | 'department' | 'group'
  /** Principal id within its kind. */
  principalId: string
  /** Permission the grant confers. */
  action: string
}

/** A principal name lookup: id per kind, falling back to the id itself. */
export type PrincipalNameOf = (kind: ShareGrant['principalType'], id: string) => string | undefined

/** Which group one grant belongs to. */
export type ShareDirection = 'received' | 'given'

/** One row of either group. */
export interface ShareRow {
  /** Stable row id, taken from the grant. */
  id: string
  /** Path relative to the knowledge mount point. */
  relPath: string
  /** File name alone, for the row's title. */
  name: string
  /** Directory the path sits in, for the location column. */
  location: string
  /** Principal kind the grant names. */
  principalType: ShareGrant['principalType']
  /** The audience this grant names, resolved to a display name when possible. */
  audience: string
  /** The permission the grant confers. */
  action: string
}

/**
 * The audience name for one grant.
 *
 * Falls back to the raw id rather than to an "unknown" placeholder: the id is real
 * data about a real principal, and printing it is more useful than a word that says
 * nothing. Only a grant whose id is itself empty has no name to show.
 * @param grant - the grant to name.
 * @param nameOf - the caller's principal directory lookup.
 * @returns The display name, the raw id, or an empty string.
 */
function audienceOf(grant: ShareGrant, nameOf: PrincipalNameOf): string {
  const resolved = nameOf(grant.principalType, grant.principalId)
  if (resolved !== undefined && resolved !== '') return resolved
  return grant.principalId
}

/**
 * Whether a grant names the caller directly.
 *
 * Only a `user` grant can: a role, department or group is an audience the caller
 * belongs to rather than the caller themselves, and treating it as "me" would let a
 * department-wide grant read as a personal share.
 * @param grant - the grant to test.
 * @param callerId - the caller's own user id, when known.
 * @returns True when the grant names this exact user.
 */
export function isOwnGrant(grant: ShareGrant, callerId: string | undefined): boolean {
  if (callerId === undefined || callerId === '') return false
  return grant.principalType === 'user' && grant.principalId === callerId
}

/**
 * Split grants into the two directions the Home tab shows.
 *
 * The rule is deliberately simple and says only what the data supports: a grant that
 * names the caller is "shared with me"; every other grant is "shared out". It does NOT
 * claim the caller created the latter -- the grantor is not in this data at all -- so
 * callers must word that group as an audience ("I shared to X"), never as a fact about
 * who granted it.
 *
 * A grant naming the caller is excluded from the outgoing group even when it also
 * appears there, so one document cannot look like it was shared to the reader and by
 * the reader at the same time.
 * @param grants - every grant the Host relayed.
 * @param callerId - the caller's own user id, when known.
 * @param nameOf - the principal directory lookup.
 * @returns Both groups, each in the order the grants arrived.
 */
export function splitShareRelations(
  grants: readonly ShareGrant[],
  callerId: string | undefined,
  nameOf: PrincipalNameOf,
): { received: ShareRow[]; given: ShareRow[] } {
  const received: ShareRow[] = []
  const given: ShareRow[] = []
  for (const grant of grants) {
    const cut = grant.relPath.lastIndexOf('/')
    const row: ShareRow = {
      id: grant.id,
      relPath: grant.relPath,
      name: cut === -1 ? grant.relPath : grant.relPath.slice(cut + 1),
      location: cut === -1 ? '—' : grant.relPath.slice(0, cut),
      principalType: grant.principalType,
      audience: audienceOf(grant, nameOf),
      action: grant.action,
    }
    if (isOwnGrant(grant, callerId)) received.push(row)
    else given.push(row)
  }
  return { received, given }
}
