import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))[0]
const files = new Set(result.files.map(entry => entry.path))
for (const path of [
  'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json',
  'lib/index.js', 'lib/invariant.js', 'lib/bin.js',
  'lib/types/index.d.ts', 'lib/types/invariant.d.ts', 'lib/types/bin.d.ts',
  'runtime/bin.mjs', 'runtime/client.mjs', 'runtime/manifest.mjs', 'runtime/supervisor.mjs',
  'progress/index.html', 'progress/app.js', 'progress/styles.css',
]) assert.equal(files.has(path), true, 'missing packed file: ' + path)
for (const entry of files) {
  assert.equal(entry.startsWith('src/'), false, 'source leaked into tarball: ' + entry)
  assert.equal(entry.startsWith('test/'), false, 'test leaked into tarball: ' + entry)
  assert.equal(entry.startsWith('scripts/'), false, 'script leaked into tarball: ' + entry)
}
console.log('supervisor pack OK (' + files.size + ' files)')
