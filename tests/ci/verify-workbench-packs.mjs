import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const output = resolve(process.argv[2] ?? 'artifacts/workbench-packs')
const packageDirectories = [
  'packages/workbench-vault',
  'packages/ssh-manager',
  'packages/api-client',
]
const archives = existsSync(output) ? readdirSync(output).filter(file => file.endsWith('.tgz')) : []

for (const directory of packageDirectories) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  const expected = manifest.name.replace(/^@/, '').replaceAll('/', '-') + '-' + manifest.version + '.tgz'
  const archive = resolve(output, expected)
  if (!archives.includes(expected) || !statSync(archive).isFile() || statSync(archive).size === 0) {
    throw new Error('Missing or empty package archive for ' + manifest.name + ': ' + basename(archive))
  }
}

if (archives.length !== packageDirectories.length) {
  throw new Error('Expected exactly ' + packageDirectories.length + ' package archives, found ' + archives.length + ': ' + archives.join(', '))
}

console.log('Verified Workbench package archives: ' + archives.sort().join(', '))
