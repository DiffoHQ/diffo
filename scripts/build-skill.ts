// Regenerates skills/diffo/SKILL.md from src/skill.ts, so the skill can never
// drift from the real protocol (src/skill.test.ts enforces it).
//
//   pnpm build:skill   # rewrite the committed file after changing src/skill.ts
//   pnpm dev:skill     # write a LOCAL skill that drives this checkout's build
//
// The dev skill is a different file in a different place (.claude/skills/,
// gitignored, repo-scoped) so it cannot be mistaken for the shipped one.
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devCliFor } from '../src/server/prompt.js'
import { createSkillMarkdown } from '../src/skill.js'

const dev = process.argv.includes('--dev')
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const devCli = devCliFor(repoRoot.replace(/\/$/, ''))

const global = process.argv.includes('--global')

const dir = !dev
  ? join(repoRoot, 'skills', 'diffo')
  : global
    ? join(homedir(), '.claude', 'skills', 'diffo')
    : join(repoRoot, '.claude', 'skills', 'diffo')
const target = join(dir, 'SKILL.md')

if (global && !dev) {
  console.error('--global only applies to --dev (the shipped skill is a repo file)')
  process.exit(1)
}

await mkdir(dir, { recursive: true })
await writeFile(target, createSkillMarkdown(dev ? devCli : undefined))
console.log(`wrote ${target}`)
if (dev) console.log(`  teaches: ${devCli}`)
if (global)
  console.log('  every repo on this machine now sees this checkout — re-run after moving it')
