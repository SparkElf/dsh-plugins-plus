import { describe, expect, it } from 'vitest'
import {
  addTombstone,
  hiddenPaths,
  removeTombstone,
  tombstoneHides,
  type Tombstone,
} from '../src/trash.ts'

/** Build a tombstone with the fields a test does not care about filled in. */
function stone(relPath: string, kind: 'file' | 'directory' = 'file'): Tombstone {
  return { relPath, kind, removedBy: 'tester', removedAt: '2026-01-01T00:00:00.000Z', originalPath: relPath }
}

describe('a tombstone hides a path and what is under it', () => {
  it('hides the path it names', () => {
    expect(tombstoneHides([stone('global/a.md')], 'global/a.md')).toBeDefined()
    expect(tombstoneHides([stone('global/a.md')], 'global/b.md')).toBeUndefined()
  })

  it('hides a directory subtree, because removing a folder removes its contents', () => {
    const entries = [stone('global/2024', 'directory')]
    expect(tombstoneHides(entries, 'global/2024/report.md')).toBeDefined()
    // Deeper still: the folder is the unit of removal, not one level of it.
    expect(tombstoneHides(entries, 'global/2024/q1/plan.md')).toBeDefined()
  })

  it('does not let one name prefix another', () => {
    // A tombstone on `global/ab` must not hide `global/abc`: the boundary is a
    // separator, not a string prefix.
    const entries = [stone('global/ab', 'directory')]
    expect(tombstoneHides(entries, 'global/abc')).toBeUndefined()
    expect(tombstoneHides(entries, 'global/ab/c')).toBeDefined()
  })

  it('leaves a same-named file in another bucket visible', () => {
    // Buckets are different audiences; hiding one person's draft must not touch the
    // identically named company document.
    const entries = [stone('personal/notes.md')]
    expect(tombstoneHides(entries, 'global/notes.md')).toBeUndefined()
  })
})

describe('adding a tombstone', () => {
  it('is idempotent, because a double click sends the same request twice', () => {
    const once = addTombstone([], stone('global/a.md'))
    const twice = addTombstone(once, stone('global/a.md'))
    expect(twice).toHaveLength(1)
  })

  it('replaces the tombstones it subsumes', () => {
    // Keeping the children after the folder is removed would leave them hidden
    // after the folder is restored, which is not what restoring means.
    const entries = [stone('global/dir/a.md'), stone('global/dir/b.md')]
    const next = addTombstone(entries, stone('global/dir', 'directory'))
    expect(next.map(entry => entry.relPath)).toEqual(['global/dir'])
  })

  it('keeps unrelated removals', () => {
    const entries = [stone('global/a.md')]
    const next = addTombstone(entries, stone('personal/b.md'))
    expect(next.map(entry => entry.relPath).sort()).toEqual(['global/a.md', 'personal/b.md'])
  })

  it('appends, so the newest removal is last in the record', () => {
    const next = addTombstone([stone('global/a.md')], stone('global/b.md'))
    expect(next[next.length - 1]?.relPath).toBe('global/b.md')
  })
})

describe('restoring', () => {
  it('drops the tombstone and reports that it did', () => {
    const result = removeTombstone([stone('global/a.md')], 'global/a.md')
    expect(result.restored).toBe(true)
    expect(result.entries).toEqual([])
  })

  it('reports a restore of something not removed rather than pretending', () => {
    const result = removeTombstone([stone('global/a.md')], 'global/other.md')
    expect(result.restored).toBe(false)
    expect(result.entries).toHaveLength(1)
  })

  it('restores a folder along with the children it subsumed', () => {
    const result = removeTombstone([stone('global/dir', 'directory')], 'global/dir')
    expect(result.restored).toBe(true)
    expect(result.entries).toEqual([])
  })

  it('leaves a sibling directory alone', () => {
    const entries = [stone('global/dir', 'directory'), stone('global/other', 'directory')]
    const result = removeTombstone(entries, 'global/dir')
    expect(result.entries.map(entry => entry.relPath)).toEqual(['global/other'])
  })
})

describe('the hidden set a view builder consumes', () => {
  it('names every removed path', () => {
    const set = hiddenPaths([stone('global/a.md'), stone('personal/b.md')])
    expect([...set].sort()).toEqual(['global/a.md', 'personal/b.md'])
  })

  it('is empty when nothing was removed', () => {
    expect(hiddenPaths([]).size).toBe(0)
  })
})
