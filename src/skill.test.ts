import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GUIDE } from './server/prompt.js'
import { createSkillMarkdown } from './skill.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skillPath = join(repoRoot, 'skills', 'diffo', 'SKILL.md')

const ALLOWED_TOP_LEVEL = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata'])

function readSkill() {
  const raw = readFileSync(skillPath, 'utf-8')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
  if (!match) throw new Error('SKILL.md has no frontmatter block')
  return { frontmatter: match[1]!, body: match[2]!, raw }
}

function parseFrontmatterShape(frontmatter: string) {
  const topLevel: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  let inMetadata = false
  let tooDeep = false
  for (const line of frontmatter.split('\n')) {
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      const key = line.split(':')[0]!.trim()
      topLevel[key] = line.slice(line.indexOf(':') + 1).trim()
      inMetadata = key === 'metadata'
    } else if (inMetadata && indent === 2) {
      const key = line.split(':')[0]!.trim()
      metadata[key] = line.slice(line.indexOf(':') + 1).trim()
    } else {
      tooDeep = true
    }
  }
  return { topLevel, metadata, tooDeep }
}

describe('skills/diffo/SKILL.md (Agent Skills format)', () => {
  it('matches the generator — the skill is a render of the real protocol', () => {
    expect(readFileSync(skillPath, 'utf-8')).toBe(createSkillMarkdown())
  })

  it('has frontmatter with name and description', () => {
    const { topLevel } = parseFrontmatterShape(readSkill().frontmatter)
    expect(topLevel.name).toBe('diffo')
    expect(topLevel.description!.length).toBeGreaterThan(20)
    expect(topLevel.description!.length).toBeLessThanOrEqual(1024)
  })

  it('uses only allowed top-level frontmatter keys', () => {
    const { topLevel } = parseFrontmatterShape(readSkill().frontmatter)
    for (const key of Object.keys(topLevel)) {
      expect(ALLOWED_TOP_LEVEL, `unexpected top-level key '${key}'`).toContain(key)
    }
    expect(topLevel.version).toBeUndefined()
  })

  it('has no YAML flow collections and metadata stays one level of strings', () => {
    const { frontmatter } = readSkill()
    const { metadata, tooDeep } = parseFrontmatterShape(frontmatter)
    expect(tooDeep, 'metadata must be one level deep').toBe(false)
    expect(frontmatter).not.toMatch(/:\s*\[/)
    expect(frontmatter).not.toMatch(/:\s*\{/)
    for (const [key, value] of Object.entries(metadata)) {
      expect(value, `metadata.${key} must be a scalar string`).not.toBe('')
    }
  })

  it('teaches the loop with the real commands, and the wake-path rules', () => {
    const { body } = readSkill()
    expect(body).toContain('npx -y diffo poll')
    expect(body).toContain('npx -y diffo reply <threadId>')
    expect(body).toContain('npx -y diffo comment [<file>]')
    expect(body).toContain('npx -y diffo end')
    expect(body).toContain('nohup')
    expect(body).toMatch(/Nothing\s+the\s+reviewer sent is lost/)
    expect(body).toMatch(/held in the review itself/)
    expect(body).toMatch(/Do not reopen/i)
  })

  it('teaches the guide step: the agent judges, and never pre-reviews', () => {
    const { body } = readSkill()
    // The doctrine is shared verbatim from GUIDE (prompt.ts) — the same
    // fragments the open-time nudge and `help agent` print — so the three
    // surfaces cannot drift apart.
    expect(body).toContain(GUIDE.when)
    expect(body).toContain(GUIDE.what)
    expect(body).toContain(GUIDE.stance)
    expect(body).toContain(GUIDE.update)
    // One comment on the changeset, short, and the real command.
    expect(body).toMatch(/ONE comment on the whole changeset/)
    expect(body).toContain('npx -y diffo comment --message')
    expect(body).toMatch(/Keep it short/)
  })

  it('ships in the npm package', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      files: string[]
    }
    expect(pkg.files).toContain('skills')
  })
})

describe('plugin.json (Agent Plugins manifest)', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
    name: string
    version: string
    description: string
    license: string
    files: string[]
  }
  const plugin = JSON.parse(readFileSync(join(repoRoot, 'plugin.json'), 'utf-8')) as Record<
    string,
    unknown
  >

  it('never disagrees with package.json', () => {
    expect(plugin.name).toBe(pkg.name)
    expect(plugin.version).toBe(pkg.version)
    expect(plugin.description).toBe(pkg.description)
    expect(plugin.license).toBe(pkg.license)
  })

  it('declares the schema and ships in the npm package', () => {
    expect(plugin.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    expect(pkg.files).toContain('plugin.json')
  })
})
