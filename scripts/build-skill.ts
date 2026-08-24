// Regenerates skills/diffo/SKILL.md from src/skill.ts, so the skill can never
// drift from the real protocol (src/skill.test.ts enforces it).
//
//   pnpm build:skill            # rewrite the committed file after changing src/skill.ts
//   pnpm dev:skill              # write a LOCAL skill that drives this checkout's build
//
// The dev skill is a SEPARATE skill — `diffo-dev`, its own name and its own
// directory — so it installs alongside the shipped `diffo` rather than replacing
// it. Both can be present at once: `/diffo` reviews with the released CLI,
// `/diffo-dev` with this checkout, and only the user picks the second one (the
// generated frontmatter forbids the model from choosing it).
//
//   pnpm dev:skill --global     # ~/.claude/skills/diffo-dev  — every repo
//   pnpm build:skill --global   # ~/.claude/skills/diffo      — every repo
//
// Without `--global` the dev skill is repo-scoped (.claude/skills/, gitignored).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devCliFor, NPX } from '../src/server/prompt.js'
import { createSkillMarkdown, DEV_SKILL_NAME, SKILL_NAME } from '../src/skill.js'

const dev = process.argv.includes('--dev')
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const devCli = devCliFor(repoRoot.replace(/\/$/, ''))

const global = process.argv.includes('--global')

const skillName = dev ? DEV_SKILL_NAME : SKILL_NAME

const dir = global
  ? join(homedir(), '.claude', 'skills', skillName)
  : dev
    ? join(repoRoot, '.claude', 'skills', skillName)
    : join(repoRoot, 'skills', skillName)
const target = join(dir, 'SKILL.md')

await mkdir(dir, { recursive: true })
await writeFile(target, createSkillMarkdown(dev ? devCli : undefined))
console.log(`wrote ${target}`)
console.log(`  /${skillName} teaches: ${dev ? devCli : NPX}`)
if (global) {
  console.log(
    dev
      ? '  every repo on this machine now has /diffo-dev pointing at this checkout — re-run after moving it'
      : '  every repo on this machine now has /diffo pointing at the shipped CLI',
  )
  console.log('  start a fresh agent session to pick it up')
}

// Before `diffo-dev` existed, `--dev --global` overwrote the shipped skill's own
// slot. Leaving that behind would mean BOTH commands run the checkout while only
// one of them looks like it does.
if (dev) {
  const shipped = join(homedir(), '.claude', 'skills', SKILL_NAME, 'SKILL.md')
  const stale = await readFile(shipped, 'utf-8').catch(() => '')
  if (stale.includes('This is a DEV build')) {
    console.log(`\n  note: ${shipped} is also a dev skill (installed the old way),`)
    console.log('        so /diffo runs this checkout too. Put the shipped one back with:')
    console.log('          pnpm build:skill --global')
  }
}
