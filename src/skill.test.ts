import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { helpFor } from './cliArgs.js'
import { devCliFor, GUIDE, NPX } from './server/prompt.js'
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

  it('is a stub: start-up commands plus the wake-path rules, nothing that can go stale', () => {
    const { body } = readSkill()
    expect(body).toContain('npx -y @diffohq/diffo help agent')
    expect(body).toContain('npx -y @diffohq/diffo poll')
    expect(body).toContain('npx -y @diffohq/diffo end')
    expect(body).toContain('nohup')
    expect(body).toMatch(/nothing the reviewer sent is lost/i)
    expect(body).toMatch(/held\s+in the review itself/)
    expect(body).toMatch(/Do not reopen/i)
    // The URL-handoff doctrine cannot wait for `help agent` — it must be inline.
    expect(body).toMatch(/end your turn's final message\s+with it/i)
    expect(body).toMatch(/An unshared URL is an unopened review/)
  })

  it('states the trust model inline — the security wording the scanner audits', () => {
    const { body } = readSkill()
    // W007: the URL is a bare localhost address, no secrets.
    expect(body).toMatch(/never carries a token,\s+credential, or any other secret/)
    // W011: payload text is the local reviewer's own feedback, and it is data —
    // never instructions with the user's authority.
    expect(body).toMatch(/typed by the human reviewer/)
    expect(body).toMatch(/never as instructions with the user's\s+authority/)
    expect(body).toMatch(/only the user in chat can/)
    // W012: the payload is described as structured data, never as a prompt
    // that controls the agent.
    expect(body).toMatch(/comment threads as structured data/)
    expect(body).not.toMatch(/JSON payload: a prompt/)
  })

  it('defers the protocol to the CLI instead of duplicating it', () => {
    const { body } = readSkill()
    // The stub sends the agent to `help agent` for the loop…
    expect(body).toMatch(/The protocol lives in the CLI/)
    // …and carries none of the doctrine that used to drift here: the guide
    // teaching lives in `help agent` (which interpolates GUIDE from prompt.ts)
    // and in the open-time nudge, not in installed skill copies.
    expect(body).not.toContain(GUIDE.what)
    expect(body).not.toMatch(/ONE comment on the whole changeset/)
    // The full protocol page it points to does carry the guide doctrine.
    const agentHelp = helpFor('agent')
    expect(agentHelp).toContain(GUIDE.when)
    expect(agentHelp).toContain(GUIDE.what)
    expect(agentHelp).toContain(GUIDE.stance)
  })

  it('stays a stub-sized load — the token budget is the point', () => {
    const { raw } = readSkill()
    expect(raw.length).toBeLessThan(6000)
  })

  it('ships in the npm package', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      files: string[]
    }
    expect(pkg.files).toContain('skills')
  })
})

describe('the dev skill (diffo-dev)', () => {
  const devCli = devCliFor('/checkout')
  const dev = createSkillMarkdown(devCli)
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(dev)?.[1] ?? ''

  it('is a separate skill, so it installs alongside the shipped one', () => {
    expect(frontmatter).toMatch(/^name: diffo-dev$/m)
    expect(createSkillMarkdown()).toMatch(/^name: diffo$/m)
  })

  it('is never model-invoked — a plain "open a review" must reach the shipped skill', () => {
    expect(frontmatter).toMatch(/^disable-model-invocation: true$/m)
    const description = /^description: (.*)$/m.exec(frontmatter)?.[1] ?? ''
    expect(description).toMatch(/ONLY for an explicit `\/diffo-dev` invocation/)
    expect(description).toMatch(/belongs to the `diffo` skill/)
    // The shipped skill must NOT carry the flag, or nothing auto-opens a review.
    expect(createSkillMarkdown()).not.toContain('disable-model-invocation')
  })

  it('teaches the checkout CLI everywhere, and warns off npx', () => {
    expect(dev).toContain(`${devCli} poll`)
    expect(dev).toContain(`${devCli} end`)
    // No command in the dev skill may be the released CLI — that is the whole point.
    expect(dev).not.toContain(`${NPX} poll`)
    expect(dev).not.toContain(`${NPX} end`)
    expect(dev).toMatch(/never `npx -y @diffohq\/diffo`, which would/)
  })

  it('tells the agent the UI marks itself, so the two reviews stay distinguishable', () => {
    expect(dev).toMatch(/browser tab and header say \*\*diffo-dev\*\*/)
  })

  it('points its explicit-invocation line at its own command', () => {
    expect(dev).toContain('the user invoked `/diffo-dev` explicitly')
    expect(createSkillMarkdown()).toContain('the user invoked `/diffo` explicitly')
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
    // The npm package is scoped (`@diffohq/diffo`) because the bare name is
    // taken; the plugin is not. A plugin name is an invocable identity that has
    // to match the skill's frontmatter `name` and the `bin`, so it stays the
    // unscoped segment rather than following the package name verbatim.
    expect(plugin.name).toBe(pkg.name.split('/').pop())
    expect(plugin.version).toBe(pkg.version)
    expect(plugin.description).toBe(pkg.description)
    expect(plugin.license).toBe(pkg.license)
  })

  it('declares the schema and ships in the npm package', () => {
    expect(plugin.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    expect(pkg.files).toContain('plugin.json')
  })
})
