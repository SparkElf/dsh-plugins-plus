#!/usr/bin/env node
/**
 * Validate the bundled skill directories after a consolidation.
 *
 * The DSH skill filesystem discovers one level: `<root>/<skill>/SKILL.md` or a flat
 * `<root>/<name>.md`. Anything deeper is a resource, not a skill. This script checks the
 * contract the loader enforces before the catalog ever sees a skill:
 *
 *   - YAML frontmatter with a kebab-case `name` and a non-empty `description`;
 *   - no duplicate names across the scanned roots;
 *   - no nested `SKILL.md` below a skill directory (it would be invisible, not a skill);
 *   - every relative Markdown link resolves, so a merged main file cannot point at a
 *     reference that was never migrated.
 *
 * Usage: node scripts/validate-skills.mjs [package-root ...]
 * Defaults to every `packages/<name>` directory that carries `SKILL.md` or `skills/`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requested = process.argv.slice(2)
const packageRoots = requested.length > 0
  ? requested.map((entry) => resolve(repoRoot, entry))
  : readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, 'packages', entry.name))
      .filter((directory) => existsSync(join(directory, 'SKILL.md')) || existsSync(join(directory, 'skills')))

const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const problems = []
const seen = new Map()
let checked = 0

/** Parse the leading `---` YAML block, if any. */
function frontmatter(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (match === null) {
    problems.push(`${file}: missing frontmatter`)
    return undefined
  }
  try {
    return parseYaml(match[1]) ?? {}
  } catch (error) {
    problems.push(`${file}: invalid YAML frontmatter: ${error.message}`)
    return undefined
  }
}

/** Check every relative Markdown link against the skill's resource directory. */
function checkLinks(text, skillDirectory, file) {
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)) {
    const target = match[1]
    if (/^(?:[a-z]+:|#)/iu.test(target)) continue
    const path = target.split('#')[0]
    if (path === '' || !path.endsWith('.md')) continue
    const resolved = resolve(skillDirectory, path)
    if (!existsSync(resolved)) problems.push(`${file}: relative link does not resolve: ${target}`)
  }
}

/** Recursively look for a nested SKILL.md below a skill directory. */
function findNestedSkillFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...findNestedSkillFiles(path))
    else if (entry.name === 'SKILL.md') found.push(path)
  }
  return found
}

function checkSkillFile(file, skillDirectory) {
  checked += 1
  const text = readFileSync(file, 'utf8')
  const data = frontmatter(text, file)
  if (data === undefined) return
  const name = data.name
  const description = data.description
  if (typeof name !== 'string' || !skillName.test(name)) {
    problems.push(`${file}: name must be kebab-case, got ${JSON.stringify(name)}`)
  }
  if (typeof description !== 'string' || description.trim() === '') {
    problems.push(`${file}: description is required`)
  }
  if (typeof name === 'string') {
    const previous = seen.get(name)
    if (previous !== undefined) problems.push(`${file}: duplicate skill name "${name}" (also ${previous})`)
    else seen.set(name, relative(repoRoot, file))
  }
  checkLinks(text, skillDirectory, file)
  const referencesRoot = join(skillDirectory, 'references')
  if (existsSync(referencesRoot)) {
    for (const nested of findNestedSkillFiles(referencesRoot)) {
      problems.push(`${nested}: nested SKILL.md under references/ is not discoverable; keep one layer`)
    }
  }
}

for (const packageRoot of packageRoots) {
  if (!existsSync(packageRoot)) {
    console.log(`scanning ${mode(packageRoot)}`)
    continue
  }
  console.log(`scanning ${relative(repoRoot, packageRoot)}`)
  const rootSkill = join(packageRoot, 'SKILL.md')
  if (existsSync(rootSkill)) checkSkillFile(rootSkill, packageRoot)
  const skillsRoot = join(packageRoot, 'skills')
  if (!existsSync(skillsRoot)) continue
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const directory = join(skillsRoot, entry.name)
    const file = join(directory, 'SKILL.md')
    if (!statSync(directory).isDirectory() || !existsSync(file)) {
      problems.push(`${directory}: skill directory has no SKILL.md`)
      continue
    }
    checkSkillFile(file, directory)
  }
}

function mode(path) {
  return `missing package root ${path}`
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) across ${checked} skill file(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`\nok: ${checked} skill file(s), ${seen.size} unique name(s)`)