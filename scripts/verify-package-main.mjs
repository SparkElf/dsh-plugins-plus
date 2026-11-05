/**
 * Reject a packed tarball whose manifest points at files the tarball does not carry.
 *
 * Measured 2026-11-05: `@sparkelf/dsh-dataops-managed@0.3.34` was published without
 * `lib/index.js` and `lib/client.js`. `npm pack` ran `prepack`, whose `rm -rf lib` succeeded
 * before the build failed; the package was then packed with `--ignore-scripts`, so the empty
 * `lib/` shipped and every image that installed it failed at import with
 * `ERR_MODULE_NOT_FOUND .../lib/index.js`. The publish step checked `skills/` and not `lib/`,
 * so nothing caught it.
 *
 * This runs after packing and before publishing. It reads `package/package.json` out of the
 * tarball itself (not the working directory), then checks that `main` and every `exports`
 * default target are present as files. It never runs a build: a build inside a publish gate
 * would reintroduce the side effect that emptied `lib` in the first place.
 *
 * Usage:
 *   node scripts/verify-package-main.mjs --tarball <file.tgz>
 *   node scripts/verify-package-main.mjs --dir <package directory>   (packs with --ignore-scripts)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One file the manifest promises and the tarball must carry. */
/**
 * @typedef {{ label: string, path: string }} RequiredFile
 */

/** Strip the leading `./` npm allows in manifest paths. */
function normalize(path) {
  return path.replace(/^\.\//u, '')
}

/**
 * Read a manifest field that may be a string or an object with `default`.
 *
 * @param value - export target.
 * @returns the default target path, or undefined for a target without one.
 */
function defaultTarget(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.default === 'string') return value.default
  return undefined
}

/**
 * Every file the manifest declares as an entry point.
 *
 * `main` is the runtime entry; each `exports` condition with a `default` is a subpath entry a
 * consumer imports directly (`./client` is what the browser loader mounts). A tarball that
 * misses any of them installs but fails at import, which is the failure this gate exists for.
 *
 * @param manifest - parsed `package/package.json`.
 * @returns labelled paths relative to the package root.
 */
export function requiredEntryFiles(manifest) {
  const required = []
  if (typeof manifest.main === 'string' && manifest.main !== '') {
    required.push({ label: 'main', path: normalize(manifest.main) })
  }
  const exportsField = manifest.exports
  if (exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    for (const [subpath, target] of Object.entries(exportsField)) {
      const path = defaultTarget(target)
      if (path === undefined) continue
      required.push({ label: 'exports["' + subpath + '"].default', path: normalize(path) })
    }
  }
  return required
}

/** Run tar and return trimmed output lines. */
function tar(args) {
  return execFileSync('tar', args, { encoding: 'utf8' }).trim()
}

/**
 * Verify one tarball.
 *
 * @param tarballPath - packed `.tgz`.
 * @returns the manifest name and version that passed.
 * @throws when `main` or an exports default target is absent from the tarball.
 */
export function verifyTarball(tarballPath) {
  const absolute = resolve(tarballPath)
  if (!existsSync(absolute)) throw new Error('verify-package-main: no tarball at ' + absolute)
  const manifest = JSON.parse(tar(['-xOzf', absolute, 'package/package.json']))
  const entries = tar(['-tzf', absolute]).split('\n').filter(entry => entry !== '')
  const files = new Set(entries.filter(entry => !entry.endsWith('/')))
  const required = requiredEntryFiles(manifest)
  if (required.length === 0) {
    throw new Error('verify-package-main: ' + String(manifest.name) + ' declares no main or exports entry to check')
  }
  const missing = required.filter(entry => !files.has('package/' + entry.path))
  if (missing.length > 0) {
    const prefix = String(manifest.name) + '@' + String(manifest.version) + ': tarball ' + absolute
    const detail = missing.map(entry => '  missing ' + entry.path + ' (from package.json ' + entry.label + ')').join('\n')
    const libFiles = entries.filter(entry => entry.startsWith('package/lib/')).slice(0, 8)
    throw new Error(prefix + ' does not carry its declared entry files:\n' + detail
      + (libFiles.length === 0 ? '\n  (the tarball has no package/lib/ files at all)' : '\n  lib/ contains: ' + libFiles.join(', ')))
  }
  return { name: String(manifest.name), version: String(manifest.version) }
}

/**
 * Pack a directory without running lifecycle scripts, then verify the produced tarball.
 *
 * `--ignore-scripts` is deliberate: the gate inspects what is on disk, and running `prepack`
 * here would execute the build whose failure emptied `lib` in the incident this guards.
 *
 * @param directory - package directory.
 * @returns the verification result and the tarball path.
 */
export function verifyPackageDirectory(directory) {
  const absolute = resolve(directory)
  const scratch = mkdtempSync(join(tmpdir(), 'verify-package-main-'))
  try {
    const printed = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], {
      cwd: absolute,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    // npm 11 prints an array; npm 12 prints an object keyed by package name. Read both shapes.
    const packed = JSON.parse(printed)
    const entries = Array.isArray(packed) ? packed : Object.values(packed)
    const filename = entries[0]?.filename
    if (typeof filename !== 'string') throw new Error('verify-package-main: npm pack printed no filename')
    return { ...verifyTarball(join(scratch, filename)), tarball: join(scratch, filename) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Parse `--tarball <file>` or `--dir <directory>`.
 *
 * @param argv - arguments after the script name.
 * @returns the selected mode.
 */
export function parseArguments(argv) {
  let tarball
  let directory
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const value = argv[index + 1]
    if (token === '--tarball') {
      if (value === undefined) throw new Error('--tarball requires a value')
      tarball = value
      index += 1
      continue
    }
    if (token === '--dir') {
      if (value === undefined) throw new Error('--dir requires a value')
      directory = value
      index += 1
      continue
    }
    throw new Error('unknown option: ' + String(token))
  }
  if (tarball === undefined && directory === undefined) throw new Error('usage: verify-package-main.mjs --tarball <file> | --dir <directory>')
  return { tarball, directory }
}

// `import.meta.url` comparison keeps this module importable from tests without running the CLI.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { tarball, directory } = parseArguments(process.argv.slice(2))
  const result = tarball === undefined ? verifyPackageDirectory(directory) : { ...verifyTarball(tarball) }
  console.log('verify-package-main: ok ' + result.name + '@' + result.version)
}
