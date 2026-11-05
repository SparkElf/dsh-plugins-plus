import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requiredEntryFiles, verifyTarball } from '../../../scripts/verify-package-main.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'package-main-gate-'))
  roots.push(root)
  return root
}

/**
 * Build a tarball shaped like npm's: entries live under `package/`.
 *
 * @param manifest - package.json contents.
 * @param files - package-relative path to contents.
 * @returns the tarball path.
 */
function tarball(manifest: Record<string, unknown>, files: Record<string, string>): string {
  const root = scratch()
  const packageDirectory = join(root, 'package')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify(manifest))
  for (const [path, contents] of Object.entries(files)) {
    const target = join(packageDirectory, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents)
  }
  const output = join(root, 'package.tgz')
  execFileSync('tar', ['-czf', output, '-C', root, 'package'])
  return output
}

const MANIFEST = {
  name: '@sparkelf/dsh-demo',
  version: '1.0.0',
  main: './lib/index.js',
  exports: {
    '.': { default: './lib/index.js' },
    './client': { default: './lib/client.js' },
  },
}

describe('verify-package-main', () => {
  it('reads every declared entry from main and exports', () => {
    expect(requiredEntryFiles(MANIFEST)).toEqual([
      { label: 'main', path: 'lib/index.js' },
      { label: 'exports["."].default', path: 'lib/index.js' },
      { label: 'exports["./client"].default', path: 'lib/client.js' },
    ])
  })

  it('accepts a tarball that carries its entry files', () => {
    const file = tarball(MANIFEST, {
      'lib/index.js': 'export {}\n',
      'lib/client.js': 'export {}\n',
    })
    expect(verifyTarball(file)).toEqual({ name: '@sparkelf/dsh-demo', version: '1.0.0' })
  })

  it('names the missing main entry, which is the published-broken-package case', () => {
    // The 0.3.34 incident: the build emptied lib/ before failing, and the tarball shipped
    // without it. `main` is the file the launcher imports first.
    const file = tarball(MANIFEST, { 'lib/client.js': 'export {}\n' })
    expect(() => verifyTarball(file)).toThrow(/lib\/index\.js/)
    expect(() => verifyTarball(file)).toThrow(/from package\.json main/)
  })

  it('names a missing exports default even when main exists', () => {
    const file = tarball(MANIFEST, { 'lib/index.js': 'export {}\n' })
    expect(() => verifyTarball(file)).toThrow(/lib\/client\.js/)
    expect(() => verifyTarball(file)).toThrow(/exports\["\.\/client"\]\.default/)
  })

  it('rejects a package that declares no entry at all', () => {
    const file = tarball({ name: '@sparkelf/dsh-demo', version: '1.0.0' }, { 'lib/index.js': 'export {}\n' })
    expect(() => verifyTarball(file)).toThrow(/declares no main or exports entry/)
  })
})