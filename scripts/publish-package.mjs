/**
 * Pack a workspace package, verify what the tarball actually carries, then publish it.
 *
 * Publishing used to be `pnpm publish` per package, which trusts the tarball `prepack`
 * produced even when the build had emptied `lib` first. This script makes the tarball the
 * unit under review: `npm pack` runs the package's own build, the verifier reads
 * `package/package.json` out of the artifact, and only a complete artifact reaches npm.
 *
 * The verification step never builds. A build inside a publish gate would repeat the side
 * effect (`rm -rf lib`) that produced the incident this guards against.
 *
 * Usage:
 *   node scripts/publish-package.mjs --dir packages/dataops-managed [--tag latest]
 *                                   [--access public] [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { verifyTarball } from './verify-package-main.mjs'

/**
 * Read one option value.
 *
 * @param argv - arguments after the script name.
 * @param name - option to look for.
 * @returns the value that follows it, if present.
 */
function option(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const argv = process.argv.slice(2)
const directory = option(argv, '--dir')
const tag = option(argv, '--tag')
const access = option(argv, '--access') ?? 'public'
const dryRun = argv.includes('--dry-run')
if (directory === undefined) {
  throw new Error('usage: publish-package.mjs --dir <package directory> [--tag <dist-tag>] [--access public] [--dry-run]')
}

const packageDirectory = resolve(directory)
const packed = JSON.parse(execFileSync('npm', ['pack', '--json'], {
  cwd: packageDirectory,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}))
// npm 11 prints an array; npm 12 prints an object keyed by package name. Read both shapes.
const entries = Array.isArray(packed) ? packed : Object.values(packed)
const filename = entries[0]?.filename
if (typeof filename !== 'string') throw new Error('publish-package: npm pack printed no filename')
const tarball = join(packageDirectory, filename)

let succeeded = false
try {
  const verified = verifyTarball(tarball)
  console.log('publish-package: verified ' + verified.name + '@' + verified.version + ' -> ' + filename)
  if (dryRun) {
    console.log('publish-package: --dry-run, not publishing')
    succeeded = true
  } else {
    const args = ['publish', tarball, '--access', access]
    if (tag !== undefined) args.push('--tag', tag)
    // stdio inherit: the registry's response and any authentication error must stay visible.
    execFileSync('npm', args, { cwd: packageDirectory, stdio: 'inherit' })
    console.log('publish-package: published ' + verified.name + '@' + verified.version)
    succeeded = true
  }
} finally {
  // Keep the artifact on failure: the error message names a file the operator needs to inspect.
  if (succeeded) rmSync(tarball, { force: true })
}