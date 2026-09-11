/**
 * Fail when a published plugin's declared DSH peers no longer match its source.
 *
 * The plugins pin their DSH peers exactly, so a runtime bump has to be republished
 * before any consumer can install the plugin next to the new runtime. That is easy
 * to forget: the source moves, CI typechecks green, and npm keeps serving a tarball
 * whose peers contradict the runtime a consumer actually has.
 *
 * This gate reads every publishable package's source manifest, asks the registry
 * what that exact version publishes, and reports packages whose DSH peers differ.
 * An exact peer cannot be corrected in place, so a difference requires a version
 * bump and a republish.
 *
 * Usage: node scripts/verify-published-peers.mjs [--registry <url>]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Peer specs named by a manifest, limited to the official DSH family. */
function dshPeers(manifest) {
  const peers = manifest.peerDependencies
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return {}
  const specs = {}
  for (const [name, spec] of Object.entries(peers)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    specs[name] = String(spec)
  }
  return specs
}

/** Publishable workspace packages: every package that is not private. */
function publishablePackages(root) {
  const packagesRoot = resolve(root, 'packages')
  const found = []
  for (const entry of readdirSync(packagesRoot)) {
    const manifestPath = join(packagesRoot, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.private === true) continue
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
    found.push({ name: manifest.name, version: manifest.version, manifest })
  }
  return found
}

/** Published manifest fields for one exact version, or undefined when absent. */
function publishedManifest(name, version, registry) {
  try {
    const raw = execFileSync('npm', ['view', name + '@' + version, 'peerDependencies', '--json', '--registry', registry], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return raw.trim() === '' ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Recorded drift the repository already knows about, as "name@version" lines. */
function readBaseline(path) {
  if (!existsSync(path)) return new Set()
  return new Set(readFileSync(path, 'utf8').split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#')))
}


/**
 * DSH versions a manifest's peer ranges must be able to match, and the range forms
 * that cannot match a prerelease.
 *
 * A comparator range such as `>=0.1.3-alpha.2 <0.2.0` excludes every prerelease by
 * semver's rules, so it can never match the rc the runtime actually is. Naming one
 * exact prerelease is the form every other peer in these manifests already uses.
 */
function unsatisfiablePeers(manifest, runtimeVersion) {
  const peers = manifest.peerDependencies
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return []
  const offenders = []
  for (const [name, spec] of Object.entries(peers)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    const text = String(spec)
    // 比较范围（含 >= 或 < 或空格）对预发布版本一律不匹配
    const isComparatorRange = /[<>]/u.test(text) || text.includes(' ')
    if (isComparatorRange && runtimeVersion.includes('-')) offenders.push(name + ' → ' + text)
  }
  return offenders
}

function main() {
  const { values } = parseArgs({ options: { registry: { type: 'string' }, baseline: { type: 'string' }, 'write-baseline': { type: 'boolean' } } })
  const registry = values.registry ?? 'https://registry.npmjs.org'
  const baselinePath = values.baseline ?? resolve(process.cwd(), 'scripts/published-peer-drift.baseline')
  const baseline = readBaseline(baselinePath)
  const drift = []
  const unsatisfiableDrift = []
  const unpublished = []
  // 与插件 pin 的运行时版本一致；预发布版本是范围陷阱的关键输入。
  const requiredRuntime = '0.1.5-rc.2'
  for (const entry of publishablePackages(process.cwd())) {
    const published = publishedManifest(entry.name, entry.version, registry)
    // 范围可满足性只看源码，因此先于「是否已发布」判断。
    const unsatisfiable = unsatisfiablePeers(entry.manifest, requiredRuntime)
    if (unsatisfiable.length > 0) unsatisfiableDrift.push({ name: entry.name, version: entry.version, names: unsatisfiable })
    if (published === undefined) { unpublished.push(entry.name + '@' + entry.version); continue }
    const source = dshPeers(entry.manifest)
    const shipped = dshPeers({ peerDependencies: published })
    const names = [...new Set([...Object.keys(source), ...Object.keys(shipped)])]
      .filter(name => source[name] !== shipped[name])
      .sort()
    if (names.length > 0) drift.push({ name: entry.name, version: entry.version, names })
  }
  if (unsatisfiableDrift.length > 0) {
    console.error('verify-published-peers: ' + String(unsatisfiableDrift.length) + ' package(s) declare a peer range that cannot match ' + requiredRuntime + ':')
    for (const entry of unsatisfiableDrift) console.error('  ' + entry.name + ' → ' + entry.names.join(', '))
    console.error('A comparator range excludes every prerelease; name the exact runtime version instead.')
    process.exitCode = 1
    return
  }
  if (values['write-baseline'] === true) {
    const lines = drift.map(entry => entry.name + '@' + entry.version).sort()
    writeFileSync(baselinePath, lines.length === 0 ? '# No known peer drift.\n' : lines.join('\n') + '\n')
    console.info('verify-published-peers: recorded ' + String(lines.length) + ' known drift(s) in ' + baselinePath)
    return
  }
  if (unpublished.length > 0) {
    console.warn('verify-published-peers: ' + String(unpublished.length) + ' package(s) not published at the source version:')
    for (const entry of unpublished) console.warn('  ' + entry)
  }
  const known = drift.filter(entry => baseline.has(entry.name + '@' + entry.version))
  const introduced = drift.filter(entry => !baseline.has(entry.name + '@' + entry.version))
  const stale = [...baseline].filter(entry => !drift.some(candidate => candidate.name + '@' + candidate.version === entry))
  if (known.length > 0) {
    console.warn('verify-published-peers: ' + String(known.length) + ' recorded drift(s) still awaiting a republish:')
    for (const entry of known) console.warn('  ' + entry.name + '@' + entry.version + ' → ' + entry.names.join(', '))
  }
  if (stale.length > 0) {
    console.warn('verify-published-peers: ' + String(stale.length) + ' baseline entr(ies) no longer drift; remove them:')
    for (const entry of stale) console.warn('  ' + entry)
  }
  if (introduced.length > 0) {
    console.error('verify-published-peers: ' + String(introduced.length) + ' package(s) now publish peers that contradict their source:')
    for (const entry of introduced) console.error('  ' + entry.name + '@' + entry.version + ' → ' + entry.names.join(', '))
    console.error('Bump the version and republish; an exact DSH peer cannot be corrected in place.')
    process.exitCode = 1
    return
  }
  console.info('verify-published-peers: no new peer drift beyond the ' + String(baseline.size) + ' recorded drift(s).')
}

main()
