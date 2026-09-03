import { describe, expect, it } from 'vitest'
import { nextEnabledOption } from '../src/client/Select.tsx'
import { formatBytes, joinedPath, parentPath, pathBreadcrumbs } from '../src/client/model.ts'

describe('SSH Manager select navigation', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Bravo', disabled: true },
    { value: 'c', label: 'Charlie' },
  ]

  it('wraps and skips disabled options in both directions', () => {
    expect(nextEnabledOption(options, 0, 1)).toBe(2)
    expect(nextEnabledOption(options, 2, 1)).toBe(0)
    expect(nextEnabledOption(options, 0, -1)).toBe(2)
  })

  it('returns no active option when every option is disabled', () => {
    expect(nextEnabledOption([{ value: 'a', label: 'Alpha', disabled: true }], 0, 1)).toBe(-1)
  })
})

describe('SSH Manager SFTP view model', () => {
  it('builds navigable absolute and relative breadcrumbs', () => {
    expect(pathBreadcrumbs('/var/log')).toEqual([
      { label: 'Root', path: '/' },
      { label: 'var', path: '/var' },
      { label: 'log', path: '/var/log' },
    ])
    expect(pathBreadcrumbs('projects/app/')).toEqual([
      { label: 'Home', path: '.' },
      { label: 'projects', path: 'projects' },
      { label: 'app', path: 'projects/app' },
    ])
  })

  it('keeps path traversal and file joining stable at roots', () => {
    expect(parentPath('/var/log')).toBe('/var')
    expect(parentPath('/var')).toBe('/')
    expect(parentPath('projects')).toBe('.')
    expect(joinedPath('/', 'readme.md')).toBe('/readme.md')
    expect(joinedPath('.', 'readme.md')).toBe('readme.md')
  })

  it('formats file sizes across table units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
})
