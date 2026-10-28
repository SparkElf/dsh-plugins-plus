#!/usr/bin/env node
/**
 * Prepend the Uint8Array.toHex/toBase64 polyfill to a documentpreview client.pdf.js.
 *
 * The PDF.js fingerprint path calls calculateMD5(...).toHex(). Chrome on Windows does not
 * ship the TC39 Uint8Array hex/base64 helpers, while the Playwright Chromium used for CI
 * does, so this defect is invisible to headless screenshots. The polyfill is deliberately
 * data-level: it changes no PDF.js code and no package version.
 *
 * Usage:
 *   node apply.mjs <client.pdf.js> [...more client.pdf.js]
 *
 * Idempotent: a target already carrying the marker is skipped. The script writes through a
 * temporary sibling and preserves the original mode. Keep a copy of the pre-patch file when
 * applying to a running tree; see README.md for the rollback command.
 */
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const marker = '/* task-121: Uint8Array toHex/toBase64 polyfill for Windows Chrome before PDF.js fingerprints */'
const here = dirname(fileURLToPath(import.meta.url))
const polyfill = readFileSync(join(here, 'polyfill.js'), 'utf8').trimEnd()

let changed = 0
for (const target of process.argv.slice(2)) {
  const current = readFileSync(target, 'utf8')
  if (current.includes(marker)) {
    console.log('skip (already patched): ' + target)
    continue
  }
  const mode = statSync(target).mode
  const temp = target + '.task121.tmp'
  // Set the mode at creation: a second write would not re-apply it after the temp exists.
  writeFileSync(temp, marker + '\n' + polyfill + '\n' + current, { mode })
  renameSync(temp, target)
  changed += 1
  console.log('patched: ' + target)
}
console.log('task-121: ' + String(changed) + ' file(s) patched')
