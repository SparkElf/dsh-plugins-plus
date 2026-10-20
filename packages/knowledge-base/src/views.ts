/**
 * Materialize each user's visible knowledge tree as a hardlink view.
 *
 * A grant in the DataOps database is a statement about what a principal MAY read;
 * it is not a filesystem fact. A workspace process that mounts the shared export
 * sees every file in it, so the grant has to be turned into an actual directory
 * tree before it can mean anything: one directory per user, holding hardlinks to
 * exactly the files that user may read. Nothing crosses into a view whose grant
 * was not resolved by DataOps, so this module never decides who may see what --
 * it only asks, and links what the answer allows.
 *
 * Hardlinks rather than copies: the link shares the inode, so a revoke unlinks
 * the view's entry and the source is untouched, and a re-grant costs one link
 * rather than a copy of the file. That is what makes permission changes
 * incremental, and it is why the NFS export has to be one filesystem (a hardlink
 * cannot span mounts).
 *
 * @module @sparkelf/dsh-knowledge-base/views
 */

import { appendFile, link, mkdir, readdir, readFile, readlink, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** One path a user may read, as DataOps resolved it. */
export interface ResolvedPath {
  /** Path relative to the authoritative root. */
  relPath: string
}

/** Which layout the listing uses for this caller. */
export type ViewMode = 'list' | 'grid' | 'explorer'

/** What one user's view currently holds. */
export interface ViewDelta {
  /** Paths linked into the view during this run. */
  linked: string[]
  /** Paths unlinked from the view during this run. */
  unlinked: string[]
  /** Paths left alone because the view already matched. */
  unchanged: number
  /**
   * Directories removed because a revoke emptied them.
   *
   * Kept apart from `unlinked` because a leftover empty directory is not a stale
   * file: it still discloses a folder name the user has lost access to.
   */
  pruned: string[]
}

/** Links a resolved set into a user's view and removes what no longer belongs. */
export interface ViewOptions {
  /** Directory holding the authoritative files. */
  actualRoot: string
  /** Directory holding one view per user. */
  viewRoot: string
  /** Opaque user key; a directory name, so it must not contain a separator. */
  userId: string
  /**
   * Department code used to select the `department/` subtree, when the caller has one.
   *
   * Layout only: it decides which department bucket is linked, never whether a path
   * may be read. Without it the view simply has no department bucket.
   */
  departmentCode?: string
  /**
   * Paths this caller has removed from their view, in view coordinates.
   *
   * A filter, not a permission: a hidden path keeps its grant, its inode and every
   * other caller's link. It is checked while building the view because a view is
   * hardlinks into one tree, so "remove" cannot mean "unlink" without also undoing
   * a grant on the next sync.
   */
  hidden?: readonly string[]
}

/**
 * The three top-level buckets every view exposes, in display order.
 *
 * A curated shared store needs one visible answer to "where does this document
 * live" before it can have a delete policy: what everyone may read, what the
 * caller's department may read, and what only the caller may read are three
 * different audiences, and mixing them puts a department document beside a
 * company-wide one with no way to tell them apart.
 */
/**
 * File name of a caller's trash record inside their view directory.
 *
 * Named here rather than imported from `trash.ts` so the view builder does not
 * depend on the trash module: the builder only needs to know not to prune it.
 */
export const TRASH_RECORD_NAME = '.kb-trash.json'

export const VIEW_BUCKETS = ['global', 'department', 'personal'] as const

/** One bucket a view can hold. */
export type ViewBucket = typeof VIEW_BUCKETS[number]

/** Display name of each bucket, keyed for the client's locale files. */
export const VIEW_BUCKET_LABELS: Readonly<Record<ViewBucket, string>> = {
  global: '全局',
  department: '部门',
  personal: '个人',
}

/**
 * Which bucket a resolved path belongs to, and where it lands inside that bucket.
 *
 * The authoritative root carries the same three names as ordinary directories, so
 * ownership is a fact of where the file lives rather than a per-file label that
 * could disagree with it. Legacy flat files (written before the split) answer
 * `global`, which keeps a view populated while a migration is still in progress.
 *
 * `global` owns no second segment, so only its own name is dropped. `department`
 * and `personal` name an OWNER (`department/<code>/`, `personal/<userId>/`) — that
 * segment stays in the authoritative path for the caller to select on, but it is
 * dropped from the view: a caller opening 「部门」 expects their department's
 * documents at its top level, not nested under a second copy of the code.
 *
 * @param relPath - path relative to the authoritative root.
 * @returns The bucket and the path to link inside it, or undefined when the path
 * cannot be placed safely.
 */
export function bucketOf(relPath: string): { bucket: ViewBucket; inner: string } | undefined {
  if (!isContainedRelPath(relPath)) return undefined
  const segments = relPath.split('/').filter(segment => segment !== '')
  if (segments.length === 0) return undefined
  const [head] = segments
  if (head === 'global') {
    // `global/<file>` — the bucket name is the whole prefix.
    const inner = segments.slice(1).join('/')
    return inner === '' ? undefined : { bucket: 'global', inner }
  }
  if (head === 'department' || head === 'personal') {
    // `<bucket>/<owner>/<file>` — owner is required and is not shown.
    const inner = segments.slice(2).join('/')
    return inner === '' ? undefined : { bucket: head, inner }
  }
  return { bucket: 'global', inner: relPath }
}

/**
 * Whether a `department/<code>/…` path belongs to the caller's own department.
 *
 * The department segment is compared exactly, so `OPS` does not match `OPS2`. A
 * caller with no department matches nothing: their view gets no department bucket
 * rather than every department a stray grant happens to mention.
 *
 * @param relPath - authoritative path, already known to start with `department/`.
 * @param departmentCode - the caller's department code, when DataOps reported one.
 * @returns true when the path sits under the caller's own department.
 */
export function departmentPrefixMatches(relPath: string, departmentCode: string | undefined): boolean {
  if (departmentCode === undefined || departmentCode === '') return false
  const segments = relPath.split('/').filter(segment => segment !== '')
  return segments[0] === 'department' && segments[1] === departmentCode && segments.length > 2
}

/**
 * Whether a user key is safe to use as one directory name.
 *
 * The key comes from the identity provider rather than from this plugin, so it is
 * validated before it reaches the filesystem: a value carrying a separator or a
 * parent reference would place the view outside the view root, which is the one
 * thing this module must not allow.
 * @param userId - the candidate key.
 * @returns true when it is a single ordinary path segment.
 */export function isSafeUserId(userId: string): boolean {
  return userId !== '' && userId !== '.' && userId !== '..'
    && !userId.includes('/') && !userId.includes('\\') && !userId.includes('\0')
}

/**
 * The directory one user's view lives in.
 * @param options - the roots and the user key.
 * @returns The absolute view directory.
 */
/**
 * Whether a path is a mount point.
 *
 * Read from `/proc/self/mountinfo` rather than inferred from `stat`: comparing a
 * directory's device against its parent's reports a bind mount of the SAME
 * filesystem as "not a mount point", and the whole point of this check is to catch
 * the deployment where the share IS the path being retargeted. The file is the
 * kernel's own list, so a path present in it is mounted by definition.
 *
 * Field 5 of each line is the mount point, escaped (`\040` for a space). A path
 * that is not absolute, or a kernel without the file, answers false: the remaining
 * guards in {@link pointMountAtView} still refuse a non-empty directory, so this
 * check failing open cannot on its own authorize a destructive replace.
 * @param path - absolute path to test.
 * @returns true when the kernel lists it as a mount point.
 */
export async function isMountPoint(path: string): Promise<boolean> {
  let table: string
  try {
    table = await readFile('/proc/self/mountinfo', 'utf8')
  } catch {
    return false
  }
  // A mount point is reported with its trailing separators removed.
  const wanted = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  for (const line of table.split('\n')) {
    if (line === '') continue
    const field = line.split(' ')[4]
    if (field === undefined) continue
    // The kernel escapes space, tab, newline and backslash in this field.
    const decoded = field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)))
    if (decoded === wanted) return true
  }
  return false
}

/**
 * Whether a directory exists and holds any entry.
 *
 * A path that does not exist is not non-empty: the create case must pass.
 * @param path - absolute path to read.
 * @returns true when it is a directory with at least one entry.
 */
async function isNonEmptyDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path)
    return entries.length > 0
  } catch {
    return false
  }
}

/**
 * Point the browsable mount at one user's view.
 *
 * The view is built beside the authoritative tree, but the page browses
 * `mountPoint`. Without this step every user would browse the same directory and a
 * grant would change nothing they can see: the view would be correct and
 * unreachable at the same time.
 *
 * A symlink is the mechanism because the browsable path is a fixed path the caller
 * configured, while the view is per user.
 *
 * This function REPLACES whatever sits at `mountPoint`, so it refuses two shapes
 * outright rather than removing them:
 *
 * - a **mount point**, because removing it would delete the mounted filesystem's
 *   contents on the server. Measured on 2026-10-17: a deployment whose
 *   `mountPoint` was the NFS root had `actual/` and every user's `views/` deleted
 *   by the old unconditional `rm -rf`, and the share root replaced by a symlink.
 * - a **non-empty real directory**, because its contents are someone else's data
 *   and a retarget is not a reason to delete them.
 *
 * What remains is exactly the set of shapes a pointer may legitimately occupy: an
 * absent path (first sync), a symlink (a repeat sync), an empty directory (a
 * leftover), or an already-correct link. A refusal throws rather than returning
 * false, because false means "the view was not ready" while this means "the
 * configuration is wrong" -- two different things for the caller to report.
 * @param options - the roots the paths are resolved against.
 * @param mountPoint - the browsable path to retarget.
 * @returns True when the link now points at the view.
 */
export async function pointMountAtView(
  options: ViewOptions,
  mountPoint: string,
): Promise<boolean> {
  if (!isSafeUserId(options.userId)) {
    throw new Error('unsafe view user id: ' + JSON.stringify(options.userId))
  }
  const target = viewPathFor(options)
  // Verify the view exists before repointing: a link to a missing directory would
  // render as an empty tree, which reads as "you have no files" rather than as a
  // deployment that has not run its first sync.
  try {
    const info = await stat(target)
    if (!info.isDirectory()) return false
  } catch {
    return false
  }
  // Already pointing here: the common case on a repeat sync, and rewriting the link
  // would churn a path a reader may be walking.
  const current = await readlink(mountPoint).catch(() => undefined)
  if (current === target) return true
  if (current === undefined) {
    // Not a symlink, so this is a real entry (or nothing). Both destructive shapes
    // are refused here, before any syscall that could remove something.
    if (await isMountPoint(mountPoint)) {
      throw new Error(
        'refusing to replace ' + JSON.stringify(mountPoint) + ' with a symlink: it is a mount point, '
        + 'and removing it would delete the mounted filesystem\'s contents. Point this plugin\'s '
        + 'mountPoint at a dedicated path for the view pointer instead of at the share root.',
      )
    }
    if (await isNonEmptyDirectory(mountPoint)) {
      throw new Error(
        'refusing to replace ' + JSON.stringify(mountPoint) + ' with a symlink: it is a non-empty '
        + 'directory, and its contents are not this plugin\'s to delete. Point mountPoint at a '
        + 'dedicated path for the view pointer, or empty it first.',
      )
    }
    // Absent, or an empty directory: nothing of value is lost, so a leftover
    // directory is removed to make room for the link. `rm` with `force` answers
    // success for a path that is not there, which is the first-sync case.
    await rm(mountPoint, { recursive: true, force: true })
  } else {
    // `rename` onto a symlink whose target is a directory answers EISDIR, so the
    // old link is removed first. The gap is one syscall wide and only a reader
    // racing a permission change can observe it.
    await unlink(mountPoint)
  }
  // The parent may not exist on a first sync -- the pointer is a nested path such
  // as `<share>/views/current`, and `views/` is created by the view builder only
  // when it has something to link. Without this the very first retarget fails with
  // ENOENT, which reads as a broken deployment rather than as an empty tree.
  await mkdir(dirname(mountPoint), { recursive: true })
  await symlink(target, mountPoint)
  return true
}

export function viewPathFor(options: ViewOptions): string {
  if (!isSafeUserId(options.userId)) {
    throw new Error('unsafe view user id: ' + JSON.stringify(options.userId))
  }
  return join(options.viewRoot, options.userId)
}

/**
 * Reject a relative path that would escape the root it is joined to.
 *
 * The resolved paths come from the authorization service, but they name files in
 * a shared export. A `..` segment would let a grant for one path reach another, so
 * it is refused here rather than trusted: the service decides visibility, this
 * module decides that a visible path still lands inside the tree.
 * @param relPath - the candidate path.
 * @returns true when the path is relative and stays under its root.
 */
export function isContainedRelPath(relPath: string): boolean {
  if (relPath === '' || relPath.startsWith('/') || relPath.includes('\0')) return false
  if (relPath.includes('\\')) return false
  const segments = relPath.split(sep)
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** One directory entry inside a view, as the walk sees it. */
interface ViewEntry {
  /** Path relative to the view root. */
  relPath: string
  /** Absolute path inside the view. */
  full: string
}

/**
 * Walk one view and report every file it currently links, plus the directories it
 * contains.
 *
 * The directories are reported because an emptied one is exactly what a revoke
 * leaves behind, and a leftover directory still discloses the name of a folder
 * the user no longer has access to.
 * @param viewDir - the user's view directory.
 * @returns The linked files and the directories, relative to the view root.
 */
async function walkView(viewDir: string): Promise<{ files: ViewEntry[]; directories: string[] }> {
  const found: ViewEntry[] = []
  const directories: string[] = []
  // The metadata files live at the view root and are preferences rather than
  // content, so the walk skips them. They have to be skipped here rather than left
  // for the unlink pass: that pass removes every file it walks which the resolved
  // set does not name, so a walked `.pinned.json` would be deleted on every sync
  // and the reader's pins would silently vanish. Skipping these exact paths rather
  // than every dotfile keeps a legitimately granted hidden file -- a `.env` someone
  // was given -- visible to the unlink pass, where a revoke can still remove it.
  //
  // Every preference file this module writes belongs in this set. A new one that is
  // not listed here is silently deleted on the next sync, which reads as a setting
  // that will not stick rather than as a bug in this function.
  const metadataPaths = new Set<string>([
    pinsPathFor(viewDir),
    viewModePathFor(viewDir),
    settingsPathFor(viewDir),
    auditLogPathFor(viewDir),
  ])
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // A view that does not exist yet holds nothing; that is the create case.
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Recorded before descending, so a directory that becomes empty is still
        // known to this run and can be pruned in the same pass.
        directories.push(full)
        await walk(full)
        continue
      }
      if (entry.isFile() && !metadataPaths.has(full)) found.push({ relPath: relative(viewDir, full), full })
    }
  }
  await walk(viewDir)
  return { files: found, directories }
}

/**
 * Bring one user's view in line with the paths DataOps resolved for them.
 *
 * Only the difference is touched: a path already linked is left alone, a missing
 * one is linked, and one that is no longer resolved is unlinked. A run over an
 * unchanged grant set therefore performs no filesystem writes at all, which is
 * what makes this safe to repeat after every permission change.
 *
 * A link whose source has gone stale is reported as unlinked rather than failing
 * the run, so one deleted file cannot leave a user's whole view half-applied.
 * @param options - the roots and the user key.
 * @param resolved - the paths DataOps says this user may read.
 * @returns What changed, so a caller can report or log the delta.
 */
export async function syncView(options: ViewOptions, resolved: readonly ResolvedPath[]): Promise<ViewDelta> {
  const viewDir = viewPathFor(options)
  // A view path is `<bucket>/<inner>`, not the authoritative path verbatim: the
  // same file may be readable by a department and by one person, and the bucket is
  // what tells those two audiences apart. `placed` keeps the authoritative path
  // for the source and the view path for the link, because they are no longer equal.
  const hidden = options.hidden === undefined || options.hidden.length === 0
    ? undefined
    : new Set(options.hidden)
  const wanted = new Map<string, string>()
  for (const item of resolved) {
    if (!isContainedRelPath(item.relPath)) continue
    const placement = bucketOf(item.relPath)
    if (placement === undefined) continue
    // A department bucket is only linked when it is the CALLER's department. The
    // grant already covers the read, so this is layout: without it a caller whose
    // grants reach two departments would see both under one 「部门」 folder.
    if (placement.bucket === 'department' && !departmentPrefixMatches(item.relPath, options.departmentCode)) continue
    // A removed path is not linked even though its grant still stands, so a sync
    // triggered by an unrelated grant change cannot resurrect it.
    if (hidden !== undefined && hidden.has(`${placement.bucket}/${placement.inner}`)) continue
    wanted.set(`${placement.bucket}/${placement.inner}`, join(options.actualRoot, item.relPath))
  }

  // The three buckets exist even when empty. A caller whose grants reach only
  // one of them still sees the same three folders as everyone else, which is what
  // makes the layout a structure rather than an accident of what happens to be
  // shared: an absent 「部门」 would read as "my department has nothing" only if
  // the caller already knew the folder was supposed to be there.
  const createBuckets: string[] = []
  for (const bucket of VIEW_BUCKETS) {
    // A caller without a department gets no department bucket: an empty folder
    // that can never fill is noise, and the caller has nothing to put in it.
    if (bucket === 'department' && (options.departmentCode === undefined || options.departmentCode === '')) continue
    try {
      await mkdir(join(viewDir, bucket), { recursive: true })
      createBuckets.push(bucket)
    } catch {
      // A bucket that cannot be created is reported by the prune pass below.
    }
  }

  const walked = await walkView(viewDir)
  const present = new Map(walked.files.map(entry => [entry.relPath, entry.full]))
  const directories = walked.directories
  const delta: ViewDelta = { linked: [], unlinked: [], unchanged: 0, pruned: [] }

  // Links first: a view is more useful showing too much for one instant than
  // showing nothing, so it is never emptied before it is refilled.
  for (const [relPath, source] of wanted) {
    if (present.has(relPath)) {
      delta.unchanged += 1
      continue
    }
    const target = join(viewDir, relPath)
    try {
      await mkdir(dirname(target), { recursive: true })
      await link(source, target)
      delta.linked.push(relPath)
    } catch {
      // The source may have been removed between the resolve and this link. The
      // path stays out of the view, which is the correct answer for a file that
      // no longer exists; a later run picks it up if it comes back.
    }
  }

  for (const [relPath, full] of present) {
    if (wanted.has(relPath)) continue
    // A view directory holds one bookkeeping file that is not a document: the
    // caller's trash record. Pruning it as an orphan would delete the very record
    // this sync just read, so a removal would apply once and then silently come
    // back on the next sync. It is named rather than pattern-matched: a hidden-dot
    // exception would also spare a user's own `.something` file from a revoke.
    if (relPath === TRASH_RECORD_NAME) continue
    try {
      await rm(full)
      delta.unlinked.push(relPath)
    } catch {
      // A view entry that cannot be removed is left for the next run rather than
      // aborting the rest of the revoke.
    }
  }

  // Drop the directories a revoke emptied. Leaving them would still disclose the
  // names of folders the user no longer has access to, and an empty tree reads as a
  // permission that grants nothing rather than as a tree that was never shared.
  // Deepest first, so a directory is reconsidered after its children are gone.
  const pruned: string[] = []
  // Buckets are structure, not a permission artifact: emptying one must not remove
  // it, or the caller's three folders would appear and disappear as grants change.
  // Everything INSIDE a bucket is still pruned normally.
  const bucketRoots = new Set(VIEW_BUCKETS.map(bucket => join(viewDir, bucket)))
  for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
    if (bucketRoots.has(dir)) continue
    const remaining = await readdir(dir).catch(() => ['unreadable'])
    if (remaining.length > 0) continue
    try {
      // `rm` with `recursive: false` answers ERR_FS_EISDIR on a directory, so the
      // removal that actually works here is `rmdir`. The distinction matters because
      // the catch below would have swallowed that error and reported success.
      await rmdir(dir)
      pruned.push(relative(viewDir, dir))
    } catch {
      // Non-empty by the time the removal ran, or gone already: either way the
      // next sync sees the truth.
    }
  }
  delta.pruned = pruned

  return delta
}

/**
 * Remove one user's whole view.
 *
 * Used when a user is removed rather than merely re-scoped: their grants are gone
 * from DataOps, so the view directory has no reason to exist. The authoritative
 * files are untouched, because every entry in the view is a link to them.
 * @param options - the roots and the user key.
 * @returns true when a directory was removed, false when there was none.
 */
export async function dropView(options: ViewOptions): Promise<boolean> {
  const viewDir = viewPathFor(options)
  try {
    await stat(viewDir)
  } catch {
    return false
  }
  await rm(viewDir, { recursive: true, force: true })
  return true
}

/**
 * The dotfile holding one user's list/grid preference.
 *
 * Beside `.pinned.json` and for the same reasons: the view directory is already
 * per-user, already on the share, and the choice should follow the reader rather
 * than the browser profile. Written through {@link writeViewMode} and skipped by
 * the sync walk, which is what keeps a preference from being deleted as if it
 * were a stale grant.
 * @param viewDir - the user's view directory.
 * @returns The absolute path of the view-mode file.
 */
export function viewModePathFor(viewDir: string): string {
  return join(viewDir, '.view-mode.json')
}

/**
 * The dotfile holding this knowledge base's review settings.
 *
 * A third sibling of `.pinned.json` and `.view-mode.json`, for the same reasons: the
 * view directory already exists per user, already lives on the share, and the setting
 * belongs to the knowledge base rather than to one browser profile. It MUST be named in
 * the sync walk's metadata set, or the next sync deletes it as if it were a stale grant.
 * @param viewDir - the user's view directory.
 * @returns The absolute path of the settings file.
 */
export function settingsPathFor(viewDir: string): string {
  return join(viewDir, '.kb-settings.json')
}

/**
 * The append-only audit log.
 *
 * A `.jsonl` file rather than a JSON array: an audit entry is appended with a single
 * `appendFile`, so recording one action never rewrites the history before it. A JSON
 * array would have to be read, extended and rewritten in full, which both costs more and
 * creates a window where a crash truncates the whole trail.
 * @param viewDir - the user's view directory.
 * @returns The absolute path of the audit log.
 */
export function auditLogPathFor(viewDir: string): string {
  return join(viewDir, '.kb-audit.jsonl')
}

/**
 * Where content waits while review is required.
 *
 * Deliberately NOT under a view: the sync walk unlinks every file in a view that the
 * caller's resolved grants do not name, so pending content parked there would be
 * deleted by the next sync, which is the same failure that made writing new documents
 * into a view wrong. It lives in the authoritative root instead, in a directory whose
 * name starts with a dot so the tree listing already hides it.
 * @param actualRoot - the authoritative root.
 * @returns The absolute path of the pending directory.
 */
export function pendingDirFor(actualRoot: string): string {
  return join(actualRoot, '.kb-pending')
}

/**
 * Build the stable filename one pending write is parked under.
 *
 * The caller's id is part of the name so the trail of who submitted what survives even
 * when the same path is submitted twice by different people; the timestamp keeps the
 * two submissions from overwriting each other.
 * @param userId - the submitting caller.
 * @param relPath - the path the caller wanted to write.
 * @param at - when it was submitted.
 * @returns A filename that is safe as one path segment.
 */
export function pendingFileNameFor(userId: string, relPath: string, at: string): string {
  const safeUser = userId.replace(/[^A-Za-z0-9_-]+/gu, '_')
  const safePath = relPath.replace(/[^A-Za-z0-9._-]+/gu, '_')
  const stamp = at.replace(/[^0-9]+/gu, '')
  return safeUser + '__' + stamp + '__' + safePath
}

/**
 * Park one write for review instead of applying it.
 *
 * The payload is a small JSON envelope beside a copy of the bytes, both inside the
 * pending directory. Keeping the content rather than only the intent means an approver
 * can read exactly what was submitted, which is the whole point of reviewing it.
 * @param actualRoot - the authoritative root.
 * @param submission - what was submitted.
 * @returns The directory the submission was parked in.
 */
export async function parkPendingWrite(
  actualRoot: string,
  submission: { userId: string; relPath: string; content: string; at: string },
): Promise<string> {
  const directory = pendingDirFor(actualRoot)
  await mkdir(directory, { recursive: true })
  const name = pendingFileNameFor(submission.userId, submission.relPath, submission.at)
  const envelope = {
    name,
    userId: submission.userId,
    relPath: submission.relPath,
    at: submission.at,
    bytes: Buffer.byteLength(submission.content, 'utf8'),
  }
  await writeFile(join(directory, name + '.json'), JSON.stringify(envelope, null, 2) + '\n', 'utf8')
  await writeFile(join(directory, name + '.content'), submission.content, 'utf8')
  return directory
}

/** One submission waiting for review. */
export interface PendingWrite {
  /** The parking name, which is also the handle a reviewer acts on. */
  name: string
  /** Who submitted it. */
  userId: string
  /** The path it wants to occupy in the authoritative tree. */
  relPath: string
  /** When it was submitted. */
  at: string
  /** Size of the submitted bytes. */
  bytes: number
}

/**
 * Decide whether a value is one parking name and not a path.
 *
 * A reviewer acts on a name that came back from {@link listPendingWrites}, but the
 * request is still browser input. Refusing separators and dot segments here means a
 * crafted name cannot reach outside the pending directory, whatever the caller sends.
 * @param value - the candidate name.
 * @returns Whether it is usable as one path segment.
 */
export function isPendingName(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 512) return false
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false
  if (value === '.' || value === '..') return false
  // Dots are allowed WITHIN the name because the parking name carries the original
  // extension (`...__a.md`), and refusing them here made `listPendingWrites` reject every
  // real submission. A name that is only dots is still refused, so no value can be
  // read as a relative segment.
  if (/^\.+$/u.test(value)) return false
  return /^[A-Za-z0-9._-]+$/u.test(value)
}

/**
 * Read every submission waiting for review.
 *
 * The envelope is the source of truth rather than the filename, because the name escapes
 * characters out of `relPath` and that escaping is lossy: a reviewer must see the path
 * the submitter actually asked for. A submission whose envelope cannot be read is
 * skipped rather than aborting the queue.
 * @param actualRoot - the authoritative root.
 * @returns The pending submissions, oldest first.
 */
export async function listPendingWrites(actualRoot: string): Promise<PendingWrite[]> {
  const directory = pendingDirFor(actualRoot)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const pending: PendingWrite[] = []
  for (const entry of names) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = await readFile(join(directory, entry), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown> | null
      if (parsed === null || typeof parsed !== 'object') continue
      const name = typeof parsed.name === 'string' ? parsed.name : entry.slice(0, -'.json'.length)
      if (!isPendingName(name)) continue
      if (typeof parsed.userId !== 'string' || typeof parsed.relPath !== 'string') continue
      pending.push({
        name,
        userId: parsed.userId,
        relPath: parsed.relPath,
        at: typeof parsed.at === 'string' ? parsed.at : '',
        bytes: typeof parsed.bytes === 'number' ? parsed.bytes : 0,
      })
    } catch {
      // A half-written envelope is data from an interrupted submit, not a reason to
      // hide the rest of the queue.
    }
  }
  // Oldest first, so a reviewer works the queue in the order it arrived.
  pending.sort((left, right) => left.at.localeCompare(right.at))
  return pending
}

/**
 * Read one submission's bytes.
 *
 * The name is checked again rather than trusted: this is the function that returns
 * content to be written into the shared tree, so it is the last place a traversal could
 * turn into a write outside the pending directory.
 * @param actualRoot - the authoritative root.
 * @param name - the parking name.
 * @returns The submitted content, or null when it is not there.
 */
export async function readPendingContent(actualRoot: string, name: string): Promise<string | null> {
  if (!isPendingName(name)) return null
  try {
    return await readFile(join(pendingDirFor(actualRoot), name + '.content'), 'utf8')
  } catch {
    return null
  }
}

/**
 * Forget one submission.
 *
 * Used by both the approve and the reject path: approving means the bytes now live in the
 * authoritative tree, and rejecting means nobody wants them. Either way the parked copy
 * must not linger, or the queue would re-offer a decision already made.
 * @param actualRoot - the authoritative root.
 * @param name - the parking name.
 * @returns Whether anything was removed.
 */
export async function discardPendingWrite(actualRoot: string, name: string): Promise<boolean> {
  if (!isPendingName(name)) return false
  const directory = pendingDirFor(actualRoot)
  let removed = false
  for (const suffix of ['.json', '.content']) {
    try {
      await unlink(join(directory, name + suffix))
      removed = true
    } catch {
      // Already gone is the same outcome as removing it.
    }
  }
  return removed
}

/**
 * Storage choices the operator may change from the panel.
 *
 * A strict subset of the plugin's configuration, and every field here is one the panel
 * can meaningfully write: which shape to run, which transport a remote deployment uses,
 * and where that transport reaches. Everything omitted -- `mountPoint`, `actualRoot`,
 * `viewRoot`, `permitted` -- is left to the deployment because those paths are bound into
 * the container when it is created, so writing them here would only point the plugin at
 * paths nothing serves.
 *
 * There is deliberately no private-key field. `sshKeyRef` names a credential; the secret
 * lives in the credential store, which is the only place a key may live.
 */
export interface KnowledgeStorageSettings {
  /** Which storage shape to run, when the operator has chosen one. */
  storageMode?: 'local' | 'remote'
  /** Transport a remote deployment reaches its share by. */
  storageProtocol?: 'nfs' | 'sshfs'
  /** NFS export host. */
  nfsServer?: string
  /** SSHFS: remote host. */
  sshHost?: string
  /** SSHFS: login user. */
  sshUser?: string
  /** SSHFS: SSH daemon port. */
  sshPort?: number
  /** SSHFS: absolute path of the shared directory on the remote host. */
  sshRemotePath?: string
  /** SSHFS: extra `-o` options. */
  sshMountOptions?: string
  /** SSHFS: credential reference holding the private key -- a name, never the key. */
  sshKeyRef?: string
}

/** Whether a write must be reviewed before it counts as published. */
export interface KnowledgeSettings extends KnowledgeStorageSettings {
  /**
   * When true, content a caller adds is recorded as pending instead of taking effect.
   *
   * Defaults to false: the product ships with review OFF and an audit trail only, which
   * is the behaviour the operator asked for. Turning it on is a deliberate act.
   */
  reviewRequired: boolean
}

/** The settings a caller who has never opened the page gets. */
export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = { reviewRequired: false }

/**
 * Copy the storage fields out of a parsed settings object.
 *
 * Values are validated here rather than at the render site so a hand-edited or foreign file
 * cannot put an unknown mode into the effective configuration: an unrecognized value is
 * dropped and the deployment default stands.
 * @param raw - the parsed settings object.
 * @returns The recognized storage fields, omitting anything invalid.
 */
export function storageSettingsOf(raw: Record<string, unknown>): KnowledgeStorageSettings {
  const out: KnowledgeStorageSettings = {}
  if (raw.storageMode === 'local' || raw.storageMode === 'remote') out.storageMode = raw.storageMode
  if (raw.storageProtocol === 'nfs' || raw.storageProtocol === 'sshfs') out.storageProtocol = raw.storageProtocol
  if (typeof raw.nfsServer === 'string') out.nfsServer = raw.nfsServer
  if (typeof raw.sshHost === 'string') out.sshHost = raw.sshHost
  if (typeof raw.sshUser === 'string') out.sshUser = raw.sshUser
  if (typeof raw.sshPort === 'number' && Number.isInteger(raw.sshPort) && raw.sshPort > 0 && raw.sshPort <= 65_535) out.sshPort = raw.sshPort
  if (typeof raw.sshRemotePath === 'string') out.sshRemotePath = raw.sshRemotePath
  if (typeof raw.sshMountOptions === 'string') out.sshMountOptions = raw.sshMountOptions
  if (typeof raw.sshKeyRef === 'string') out.sshKeyRef = raw.sshKeyRef
  return out
}

/**
 * Read this knowledge base's settings.
 *
 * Anything unrecognized answers the defaults rather than an error: a corrupt settings
 * file should cost the reader their preferences, not the page. `reviewRequired` is
 * coerced to a real boolean so a hand-edited `"false"` string cannot switch review on.
 * @param viewDir - the user's view directory.
 * @returns The stored settings, or the defaults.
 */
export async function readSettings(viewDir: string): Promise<KnowledgeSettings> {
  let raw: string
  try {
    raw = await readFile(settingsPathFor(viewDir), 'utf8')
  } catch {
    return { ...DEFAULT_KNOWLEDGE_SETTINGS }
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_KNOWLEDGE_SETTINGS }
    // The storage fields travel with the review toggle: the panel writes both through this
    // one file, so a read that returned only the toggle would silently drop them.
    return { reviewRequired: parsed.reviewRequired === true, ...storageSettingsOf(parsed) }
  } catch {
    return { ...DEFAULT_KNOWLEDGE_SETTINGS }
  }
}

/**
 * Replace this knowledge base's settings.
 *
 * Atomic by rename for the same reason the pins and the view mode are: a reader must
 * never observe a half-written settings file. The view directory is created because a
 * setting can be recorded before the first sync has built one.
 * @param viewDir - the user's view directory, created if absent.
 * @param settings - the settings to store.
 * @returns The settings actually written.
 */
export async function writeSettings(
  viewDir: string,
  settings: KnowledgeSettings,
): Promise<KnowledgeSettings> {
  const normalized: KnowledgeSettings = {
    reviewRequired: settings.reviewRequired === true,
    // Round-tripped through the validator so a caller cannot store a value the reader
    // would reject, and omitted fields stay omitted rather than becoming `undefined` keys.
    ...storageSettingsOf({ ...settings } as unknown as Record<string, unknown>),
  }
  await mkdir(viewDir, { recursive: true })
  const target = settingsPathFor(viewDir)
  const temporary = target + '.tmp'
  await writeFile(temporary, JSON.stringify(normalized), 'utf8')
  await rename(temporary, target)
  return normalized
}

/**
 * The deployment-level settings file, addressed from the mounted knowledge tree.
 *
 * A separate accessor from {@link settingsPathFor} because the two files answer different
 * questions and are read at different moments. The per-user file is only reachable once a
 * caller is known, while this one must be readable on the very first `config` call -- before
 * any identity has been resolved -- because the storage shape is what tells the page whether
 * a caller is needed at all. `mountPoint` is the one path the panel knows without asking
 * anyone, so the file hangs off it.
 *
 * Named `.kb-settings.json` so it lands in the same metadata set the sync walk already
 * skips; a sync that deleted it would silently revert the operator's choice.
 * @param mountPoint - the mounted knowledge tree.
 * @returns The absolute path of the settings file.
 */
export function storageSettingsPathFor(mountPoint: string): string {
  return join(mountPoint, '.kb-settings.json')
}

/**
 * Read the stored storage settings, tolerating every ordinary absence.
 *
 * A missing mount point, a missing file, and a file written by an older build are all the
 * same answer here: nothing has been chosen yet, so the deployment defaults stand. Only a
 * value that IS present and unrecognized is dropped, and it is dropped on its own rather
 * than invalidating its neighbours.
 * @param mountPoint - the mounted knowledge tree.
 * @returns The stored storage fields, empty when nothing usable is on disk.
 */
export async function readStorageSettings(mountPoint: string): Promise<KnowledgeStorageSettings> {
  let raw: string
  try {
    raw = await readFile(storageSettingsPathFor(mountPoint), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return {}
    return storageSettingsOf(parsed)
  } catch {
    return {}
  }
}

/**
 * Merge a patch into the stored storage settings and write the file atomically.
 *
 * A merge rather than a replace: the panel sends only the fields the operator touched, and a
 * save that blanked the others would make editing one field erase the rest. Written by
 * `rename` so a reader never sees a half-written file, for the same reason the per-user
 * settings are.
 * @param mountPoint - the mounted knowledge tree, created if absent.
 * @param patch - the fields to change.
 * @returns The settings now on disk.
 */
export async function writeStorageSettings(
  mountPoint: string,
  patch: KnowledgeStorageSettings,
): Promise<KnowledgeStorageSettings> {
  const merged = { ...(await readStorageSettings(mountPoint)), ...storageSettingsOf(patch as Record<string, unknown>) }
  await mkdir(mountPoint, { recursive: true })
  const target = storageSettingsPathFor(mountPoint)
  const temporary = target + '.tmp'
  // `reviewRequired` is preserved when the file already had it: this accessor owns only the
  // storage half, and rewriting the file must not drop the half it does not read.
  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(target, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (parsed !== null && typeof parsed === 'object') existing = parsed
  } catch {
    existing = {}
  }
  const next = { ...existing, ...merged }
  await writeFile(temporary, JSON.stringify(next), 'utf8')
  await rename(temporary, target)
  return storageSettingsOf(next)
}

/**
 * Read one user's list/grid preference.
 *
 * Anything unrecognized answers `list`, which is the shape the page was built
 * around: a corrupt or hand-edited preference should cost the reader a layout
 * choice, not the page. A missing file is that same ordinary first read.
 * @param viewDir - the user's view directory.
 * @returns The stored mode.
 */
export async function readViewMode(viewDir: string): Promise<ViewMode> {
  let raw: string
  try {
    raw = await readFile(viewModePathFor(viewDir), 'utf8')
  } catch {
    return 'list'
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    return parsed !== null && typeof parsed === 'object' && (parsed.mode === 'grid' || parsed.mode === 'explorer') ? parsed.mode : 'list'
  } catch {
    return 'list'
  }
}

/**
 * Replace one user's list/grid preference.
 *
 * Atomic by rename for the same reason the pins are: a reader must never observe
 * a half-written file. The view directory is created because the preference can
 * be recorded before the first sync has built one.
 * @param viewDir - the user's view directory, created if absent.
 * @param mode - the mode to store.
 * @returns The mode actually written.
 */
export async function writeViewMode(viewDir: string, mode: ViewMode): Promise<ViewMode> {
  await mkdir(viewDir, { recursive: true })
  const target = viewModePathFor(viewDir)
  const temporary = target + '.tmp'
  await writeFile(temporary, JSON.stringify({ mode }), 'utf8')
  await rename(temporary, target)
  return mode
}

/**
 * Move or rename one entry inside the authoritative tree.
 *
 * `rename(2)` rather than a copy followed by an unlink, and that choice is the
 * whole point of this function: the authoritative tree is an NFS export, so a
 * copy-and-delete would read and rewrite the entire file across the network for
 * what the kernel can do as a single atomic directory operation. It also keeps
 * the inode, which matters because every user's view holds HARDLINKS to these
 * files: a copy would give the moved file a new inode and leave every hardlink in
 * every view pointing at the old one. Callers must resynchronize the affected
 * views afterwards ({@link syncView} relinks the new path and drops the old), and
 * that is not optional -- without it the reader sees a dead entry.
 *
 * Both paths are required to be contained relative paths; the caller is
 * responsible for having asked the authority whether the caller may write them.
 * The destination's parent is created when it does not exist, and a destination
 * that already holds an entry is refused rather than overwritten, because a move
 * that silently replaces a document is data loss and no prompt can undo it.
 * @param options - the roots; only `actualRoot` is used.
 * @param fromRelPath - the entry's current path, relative to the root.
 * @param toRelPath - the entry's new path, relative to the root.
 * @returns The moved entry's new relative path.
 */
export async function moveEntry(
  options: ViewOptions,
  fromRelPath: string,
  toRelPath: string,
): Promise<{ from: string; to: string }> {
  if (!isContainedRelPath(fromRelPath) || !isContainedRelPath(toRelPath)) {
    throw new Error('refusing to move a path that is not contained: ' + JSON.stringify({ fromRelPath, toRelPath }))
  }
  const source = join(options.actualRoot, fromRelPath)
  const destination = join(options.actualRoot, toRelPath)
  // A no-op rename would answer success and report a move that changed nothing.
  if (source === destination) throw new Error('source and destination are the same path')
  // Refuse a destination that already exists BEFORE the rename, so the error names
  // the conflict instead of arriving as a bare EEXIST/ENOTEMPTY from the kernel.
  // Only "not there" (ENOENT) may continue; any other stat failure is reported as
  // itself rather than mistaken for an available destination.
  let destinationTaken = true
  try {
    await stat(destination)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') destinationTaken = false
    else throw error
  }
  if (destinationTaken) throw new Error('destination already exists: ' + JSON.stringify(toRelPath))
  await mkdir(dirname(destination), { recursive: true })
  await rename(source, destination)
  return { from: fromRelPath, to: toRelPath }
}

/**
 * The dotfile holding one user's pins.
 *
 * A dotfile inside the caller's own view directory, rather than a backend table:
 * the view directory is already per-user, already on the shared export, and
 * already rebuilt in place by {@link syncView}. Pins are therefore durable across
 * a restart and need no new authority to store. The name is dotted to keep it out
 * of the way of a reader scanning the tree, and the walk skips this exact path so
 * a sync cannot delete it.
 * @param viewDir - the user's view directory.
 * @returns The absolute path of the pin file.
 */
export function pinsPathFor(viewDir: string): string {
  return join(viewDir, '.pinned.json')
}

/**
 * Read one user's pins.
 *
 * A missing file is the empty list rather than an error: every user has no pins
 * until they make one, so that is the ordinary first read. A file that exists but
 * cannot be parsed is also reported empty, because a corrupt preference should
 * cost the reader their pins rather than the whole page.
 * @param viewDir - the user's view directory.
 * @returns The pinned paths, in the order they were written.
 */
export async function readPins(viewDir: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(pinsPathFor(viewDir), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    // The file is a bare array rather than an object with a key: it has exactly one
    // field, and a wrapper would only add a shape to validate.
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/**
 * Replace one user's pins.
 *
 * The list is normalized before it is written: every entry must be a contained
 * relative path, duplicates collapse, and the order is the caller's. Writing is
 * atomic by rename, so a reader never observes a half-written file, and the
 * temporary name is a sibling because a rename cannot cross a filesystem.
 * @param viewDir - the user's view directory, created if absent.
 * @param relPaths - the paths to store, already filtered for readability.
 * @returns The paths actually written, after normalization.
 */
export async function writePins(viewDir: string, relPaths: readonly string[]): Promise<string[]> {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const relPath of relPaths) {
    if (!isContainedRelPath(relPath)) continue
    if (seen.has(relPath)) continue
    seen.add(relPath)
    normalized.push(relPath)
  }
  await mkdir(viewDir, { recursive: true })
  const target = pinsPathFor(viewDir)
  const temporary = target + '.tmp'
  await writeFile(temporary, JSON.stringify(normalized), 'utf8')
  await rename(temporary, target)
  return normalized
}

/** One recorded change to the knowledge base. */
export interface KnowledgeAuditEntry {
  /** ISO timestamp of the action. */
  at: string
  /** Who performed it: the DataOps user id the Host resolved. */
  actor: string
  /**
   * That user's display name at the time of the action, when the Host resolved one.
   *
   * Kept beside the id rather than replacing it: the id is the identity an audit is
   * checked against, while this is only what the trail is read as. Optional because
   * logs written before it existed carry no label, and a reader must show such an
   * entry by its id rather than drop it.
   */
  actorLabel?: string
  /** What they did. */
  /**
   * What they did.
   *
   * `edit` is a save of an existing document's bytes, kept distinct from `create`
   * because the two answer different questions in a review: "who first put this
   * here" and "who changed it last". A save through the host's own file editor
   * reports here through a side channel (see the `audit.appended` route), which is
   * what keeps the host's write path untouched.
   */
  action: 'create' | 'upload' | 'move' | 'approve' | 'reject' | 'edit'
  /** The path the action concerned, relative to the knowledge root. */
  relPath: string
  /** For a move, the destination path. */
  toRelPath?: string
  /**
   * What became of it.
   *
   * `pending` means it was parked for review, `applied` means it took effect,
   * `rejected` means a reviewer refused it. The three are kept distinct because
   * "nothing happened yet" and "somebody said no" are different facts, and an audit
   * trail that collapsed them would misreport why a document is missing.
   */
  outcome: 'applied' | 'pending' | 'rejected'
}

/**
 * Append one audit entry.
 *
 * Deliberately append-only: no update and no delete path exists in this module, because
 * an audit trail a caller can rewrite is not an audit trail. The file is opened with
 * `'a'`, so the write is a single append at the end and can never overwrite an earlier
 * entry, even with two writers racing.
 *
 * Failure to record is NOT allowed to fail the action that was recorded. The caller has
 * already made its change, so throwing here would report a failure that did not happen;
 * the caller is expected to treat this as best-effort and the reason is logged by the
 * host. That trade is deliberate: an audit gap is bad, but a reported-but-not-applied
 * write is worse.
 * @param viewDir - the user's view directory, created if absent.
 * @param entry - the entry to record.
 */
export async function appendAuditEntry(viewDir: string, entry: KnowledgeAuditEntry): Promise<void> {
  await mkdir(viewDir, { recursive: true })
  await appendFile(auditLogPathFor(viewDir), JSON.stringify(entry) + '\n', 'utf8')
}

/**
 * Read the newest audit entries, newest first.
 *
 * The whole file is read because it is a per-user, append-only log that grows by one
 * short line per write; there is no rotation yet and pretending otherwise would add a
 * seek that the format does not support. Unparseable lines are skipped rather than
 * thrown: a half-written last line from a crash must not make the whole trail unreadable.
 * @param viewDir - the user's view directory.
 * @param limit - maximum entries to return, newest first.
 * @returns The entries, newest first.
 */
export async function readAuditEntries(viewDir: string, limit = 200): Promise<KnowledgeAuditEntry[]> {
  let raw: string
  try {
    raw = await readFile(auditLogPathFor(viewDir), 'utf8')
  } catch {
    return []
  }
  const entries: KnowledgeAuditEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as KnowledgeAuditEntry
      if (parsed && typeof parsed.at === 'string' && typeof parsed.actor === 'string') {
        // Older lines predate `actorLabel`; a non-string value is treated as absent.
        // Neither case is an error: the id alone still identifies the actor.
        if (typeof parsed.actorLabel !== 'string') delete parsed.actorLabel
        entries.push(parsed)
      }
    } catch {
      // A torn line is data from an interrupted write, not a reason to hide the rest.
    }
  }
  return entries.slice(-Math.max(1, limit)).reverse()
}
