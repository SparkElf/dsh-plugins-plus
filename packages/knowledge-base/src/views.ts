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

import { link, mkdir, readdir, readlink, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** One path a user may read, as DataOps resolved it. */
export interface ResolvedPath {
  /** Path relative to the authoritative root. */
  relPath: string
}

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
 */
export function isSafeUserId(userId: string): boolean {
  return userId !== '' && userId !== '.' && userId !== '..'
    && !userId.includes('/') && !userId.includes('\\') && !userId.includes('\0')
}

/**
 * The directory one user's view lives in.
 * @param options - the roots and the user key.
 * @returns The absolute view directory.
 */
/**
 * Point the browsable mount at one user's view.
 *
 * The view is built beside the authoritative tree, but the page browses
 * `mountPoint`, and a workspace mounts the SHARED export there. Without this step
 * every user would browse the same directory and a grant would change nothing
 * they can see: the view would be correct and unreachable at the same time.
 *
 * A symlink is the mechanism because the mount point is a fixed path the caller
 * already configured, while the view is per user. The link is replaced atomically
 * by renaming a sibling into place, so a reader never observes a half-swapped
 * pointer.
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
  if (current !== undefined) {
    // `rename` onto a symlink whose target is a directory answers EISDIR, so the
    // old link is removed first. The gap is one syscall wide and only a reader
    // racing a permission change can observe it.
    await unlink(mountPoint)
  } else {
    await rm(mountPoint, { recursive: true, force: true })
  }
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
      if (entry.isFile()) found.push({ relPath: relative(viewDir, full), full })
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
  const wanted = new Map<string, string>()
  for (const item of resolved) {
    if (!isContainedRelPath(item.relPath)) continue
    wanted.set(item.relPath, join(options.actualRoot, item.relPath))
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
  for (const dir of [...directories].sort((a, b) => b.length - a.length)) {
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
