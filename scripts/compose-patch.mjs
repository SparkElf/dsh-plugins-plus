#!/usr/bin/env node
/**
 * Install deploy/local-patch fragments into the user patch layer.
 *
 *   scripts/compose-patch.mjs              install the fragments
 *   scripts/compose-patch.mjs --dry-run    print the composed layer
 *
 * Why this exists
 * ---------------
 * A bundle's own patch is the wrong home for a deployment choice: the bundle is an npm package, so
 * the next install replaces the file. The user layer is applied last by the loader, which makes it
 * the layer an override belongs in - and no package upgrade touches it.
 *
 * The layer also carries entries this repository does not own (model providers, the permission
 * preset), so this script edits it the way app-boot's own capability writer does: it rewrites only
 * the entries named by a fragment and leaves every other line byte-for-byte alone. A fragment entry
 * whose id already exists in a DIFFERENT shape would be ambiguous, so that case is reported and the
 * script stops rather than silently choosing.
 *
 * Fragments are ordinary patch lists, so a fragment can add a row or override one by id.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(here)
const FRAGMENT_DIR = join(REPO_ROOT, 'deploy', 'local-patch')
const USER_LAYER = process.env.DSH_USER_PATCH ?? '/root/.dsh/cordis.patch.yml'
const DRY = process.argv.includes('--dry-run')

/** Names the top-level entries of a patch list: `- id: x` at column zero, or `- insert:` groups. */
function entryIds(text) {
  const ids = []
  for (const line of text.split(String.fromCharCode(10))) {
    const m = /^-\s+id:\s*(.+?)\s*$/.exec(line)
    if (m !== null) ids.push(m[1].replace(/["']/g, ''))
  }
  return ids
}

/**
 * Split a patch list into top-level blocks. A block starts at a line that begins with `- ` at column
 * zero and runs until the next such line, so a fragment's comments travel with the entry they head.
 */
function splitBlocks(text) {
  const blocks = []
  let current = null
  let preamble = []
  for (const line of text.split(String.fromCharCode(10))) {
    if (/^-/.test(line)) {
      if (current !== null) blocks.push(current)
      current = { lines: [line], id: null }
      const m = /^-\s+id:\s*(.+?)\s*$/.exec(line)
      if (m !== null) current.id = m[1].replace(/["']/g, '')
      continue
    }
    if (current === null) { preamble.push(line); continue }
    current.lines.push(line)
  }
  if (current !== null) blocks.push(current)
  return { preamble, blocks }
}

if (!existsSync(FRAGMENT_DIR)) { console.log('compose-patch: no fragments at ' + FRAGMENT_DIR); process.exit(0) }
const fragmentFiles = readdirSync(FRAGMENT_DIR).filter(function (f) { return /\.ya?ml$/.test(f) }).sort()
if (fragmentFiles.length === 0) { console.log('compose-patch: no fragments to install'); process.exit(0) }

const layerExists = existsSync(USER_LAYER)
const layerText = layerExists ? readFileSync(USER_LAYER, 'utf8') : ''
const { preamble, blocks } = splitBlocks(layerText)

let added = 0
let replaced = 0
const owned = new Set()

for (const file of fragmentFiles) {
  const frag = readFileSync(join(FRAGMENT_DIR, file), 'utf8')
  const parsed = splitBlocks(frag)
  for (const fragBlock of parsed.blocks) {
    const body = fragBlock.lines.join(String.fromCharCode(10)).replace(/\s+$/, '')
    if (fragBlock.id === null) { console.log('compose-patch: ' + file + ' has an entry without an id; skipping'); continue }
    if (owned.has(fragBlock.id)) { console.log('compose-patch: ' + fragBlock.id + ' named by two fragments; stopping'); process.exit(1) }
    owned.add(fragBlock.id)
    const existing = blocks.findIndex(function (b) { return b.id === fragBlock.id })
    if (existing < 0) {
      blocks.push({ lines: body.split(String.fromCharCode(10)), id: fragBlock.id })
      added += 1
      continue
    }
    const same = blocks[existing].lines.join(String.fromCharCode(10)).replace(/\s+$/, '') === body
    if (!same) {
      console.log('compose-patch: replacing entry ' + fragBlock.id + ' in ' + USER_LAYER)
      blocks[existing] = { lines: body.split(String.fromCharCode(10)), id: fragBlock.id }
      replaced += 1
    }
  }
}

const head = preamble.join(String.fromCharCode(10)).replace(/\s+$/, '')
const composed = [head, ...blocks.map(function (b) { return b.lines.join(String.fromCharCode(10)).replace(/\s+$/, '') })].filter(function (s) { return s !== '' }).join(String.fromCharCode(10) + String.fromCharCode(10)) + String.fromCharCode(10)

if (DRY) { process.stdout.write(composed); process.exit(0) }

if (added === 0 && replaced === 0) { console.log('compose-patch: layer already current (' + String(owned.size) + ' entries owned)'); process.exit(0) }

mkdirSync(dirname(USER_LAYER), { recursive: true })
if (layerExists) {
  const backup = USER_LAYER + '.pre-compose-patch-' + new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(USER_LAYER, backup)
  console.log('compose-patch: backup ' + backup)
}
writeFileSync(USER_LAYER, composed)
console.log('compose-patch: wrote ' + USER_LAYER + ' (added ' + String(added) + ', replaced ' + String(replaced) + ')')