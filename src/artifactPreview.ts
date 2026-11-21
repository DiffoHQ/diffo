import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import {
  type ArtifactView,
  frameDoc,
  LEFT_PAGE_DOC,
  LEFT_PAGE_ISSUE,
  newFrameToken,
  readFrameReport,
  SANDBOX,
  STATIC_THEMES,
} from './shared/artifactFrame.js'
import { type ArtifactBox, boxOf, checkArtifacts, hasOwnFullView } from './shared/artifacts.js'

/**
 * `diffo artifact preview`: render an artifact the way the reviewer will see
 * it — the same frame document, card and full view, light and dark — and hand
 * the agent screenshots it can look at before anyone else does.
 *
 * No new dependency: it drives whatever Chrome-family browser the machine
 * already has, headless, through its command line (`--dump-dom` to read what
 * the frame measured and caught, `--screenshot` for the pictures). The frame's
 * boot script writes its findings onto <html> for exactly this reader.
 */

export const FULL = { width: 1200, height: 760 }

const RUN_TIMEOUT_MS = 20_000

/** The browsers to try, in order. `DIFFO_CHROME` wins over all of them. */
export function chromeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = []
  if (env.DIFFO_CHROME) out.push(env.DIFFO_CHROME)
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
    for (const root of ['/Applications', join(homedir(), 'Applications')])
      for (const app of apps) out.push(join(root, app))
  } else if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (r): r is string => typeof r === 'string',
    )
    for (const root of roots) {
      out.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      out.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else {
    const names = [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
      'brave-browser',
    ]
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean))
      for (const name of names) out.push(join(dir, name))
  }
  return out
}

export function findChrome(): string | null {
  return chromeCandidates().find((p) => existsSync(p)) ?? null
}

function runChrome(chrome: string, profile: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
        // The artifact's sandboxed frame in the host's own process, so the
        // virtual clock (--virtual-time-budget) runs its timers too.
        '--disable-features=IsolateSandboxedIframes',
        `--user-data-dir=${profile}`,
        '--virtual-time-budget=2500',
        ...args,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    )
    let out = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf-8')
    })
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy()
      rmSync(profile, { recursive: true, force: true })
      resolve(out)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done()
    }, RUN_TIMEOUT_MS)
    child.on('error', done)
    child.on('close', done)
    // A helper Chrome spawns (an updater, a crash handler) can inherit stdout
    // and keep the stream open long after Chrome itself exits: settle on the
    // exit, with a moment for the dump's last bytes.
    child.on('exit', () => setTimeout(done, 500))
  })
}

export interface PreviewInput {
  title: string
  box: ArtifactBox
  html: string
}

export interface PreviewedArtifact {
  title: string
  /** The box, and how tall the content measured in it. */
  card: { width: number; height: number; content: number; fits: boolean }
  /** `full` is null when the full view is just the card uncut. */
  screenshots: { card_light: string; card_dark: string; full: string | null }
  issues: string[]
}

let profiles = 0

/**
 * The page the preview loads: the artifact in the same sandboxed frame the
 * review gives it, never as a page of its own — so what it can't do for the
 * reviewer it can't do here, and what it reports comes through the same
 * stamped messages. The host writes the tally onto its own <html>, where the
 * artifact can't reach it, for the DOM dump to read.
 */
function hostDoc(doc: string, token: string, width: number, height: number): string {
  const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const boot = `(function(){
var T=${JSON.stringify(token)},de=document.documentElement,loads=0,stopped=false;
var F=function(){return document.getElementById('f')};
var rep={issues:[],height:-1,width:${width}};
var w=function(){de.setAttribute('data-diffo-report',JSON.stringify(rep))};
var add=function(t){t=String(t).slice(0,500);if(rep.issues.indexOf(t)<0&&rep.issues.length<8)rep.issues.push(t)};
var stop=function(){if(stopped)return;stopped=true;F().srcdoc=${JSON.stringify(LEFT_PAGE_DOC)};add(${JSON.stringify(LEFT_PAGE_ISSUE)});rep.ready=1;w()};
addEventListener('message',function(e){var f=F(),d=e.data;if(stopped||!f||!d||d.diffoArtifact!==1||d.t!==T)return;if(e.source!==null&&e.source!==f.contentWindow)return;
 if(d.type==='leaving'){stop();return}
 if(d.type==='issue')add(d.text);if(d.type==='size'&&typeof d.height==='number')rep.height=d.height;if(d.type==='ready')rep.ready=1;w()});
document.addEventListener('load',function(e){if(e.target===F()&&++loads>=2)stop()},true);
})()`
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;background:transparent}iframe{display:block;border:0}</style>' +
    // Listening before the frame exists: a page that leaves while it is still
    // loading says so before any later script could hear it.
    `<script>${boot}</script></head><body>` +
    `<iframe id="f" sandbox="${SANDBOX}" style="width:${width}px;height:${height}px" srcdoc="${attr(doc)}"></iframe>` +
    '</body></html>'
  )
}

async function previewOne(
  chrome: string,
  dir: string,
  n: number,
  a: PreviewInput,
): Promise<PreviewedArtifact> {
  const page = (view: ArtifactView, scheme: 'light' | 'dark', w: number, h: number) => {
    const path = join(dir, `${n}-${view}-${scheme}.html`)
    const token = newFrameToken()
    writeFileSync(
      path,
      hostDoc(frameDoc(a.html, view, STATIC_THEMES[scheme], a.box, token), token, w, h),
    )
    return `file://${path}`
  }
  // A page has one view; its thumbnail is the page itself.
  const isPage = a.box.page === true
  const cardView: ArtifactView = isPage ? 'full' : 'card'
  const cardLight = page(cardView, 'light', a.box.width, a.box.height)
  const cardDark = page(cardView, 'dark', a.box.width, a.box.height)
  const full = isPage ? cardLight : page('full', 'light', FULL.width, FULL.height)
  const profile = () => join(dir, `.profile-${++profiles}`)
  const dump = (url: string, w: number, h: number) =>
    runChrome(chrome, profile(), [`--window-size=${w},${h}`, '--dump-dom', url]).then(
      readFrameReport,
    )

  // What the frame measured and caught, in its box in both themes (unreadable
  // text is a per-theme bug), and in the full view.
  const { width, height } = a.box
  const [light, dark, fullReport] = await Promise.all([
    dump(cardLight, width, height),
    dump(cardDark, width, height),
    isPage ? Promise.resolve(undefined) : dump(full, FULL.width, FULL.height),
  ])

  const content = light?.height ?? height
  const shown = Math.max(48, Math.min(height, content))
  const shot = (url: string, name: string, w: number, h: number, half = false) => {
    const path = join(dir, `${n}-${name}.png`)
    return runChrome(chrome, profile(), [
      `--window-size=${w},${h}`,
      ...(half ? ['--force-device-scale-factor=0.5'] : []),
      `--screenshot=${path}`,
      url,
    ]).then(() => path)
  }
  // The full view earns a screenshot only when it differs from the card: the
  // page styles it, or the card cuts content off. Otherwise it is the card
  // uncut, and the picture would cost the agent a large image for nothing.
  // A page is large: its dark shot comes at half size — the frame's own checks
  // read the text in both themes, so the picture only has to show the look.
  const fullDiffers = !isPage && (hasOwnFullView(a.html, a.box) || content > height)
  const [cardLightPng, cardDarkPng, fullPng] = await Promise.all([
    shot(cardLight, isPage ? 'page-light' : 'card-light', width, shown),
    shot(cardDark, isPage ? 'page-dark-half' : 'card-dark', width, shown, isPage),
    fullDiffers ? shot(full, 'full-light', FULL.width, FULL.height) : Promise.resolve(null),
  ])

  const issues: string[] = []
  const add = (r: ReturnType<typeof readFrameReport> | undefined, where: string) => {
    if (r === undefined) return
    if (r === null) {
      issues.push(
        `${where}: the page never finished loading in the preview (an endless loop, or a script that blocks)`,
      )
      return
    }
    for (const i of r.issues)
      if (!issues.some((x) => x.startsWith(i))) issues.push(`${i} [${where}]`)
  }
  // A card cut short is the commonest miss, and the numbers alone don't say
  // what it costs: name it, so the agent need not find it in a picture.
  if (!isPage && content > height)
    issues.push(
      `the card cuts off: the content is ${content}px tall and the box ${height}px, so the bottom ${content - height}px only shows in the full view — make the box taller (size=${width}x${Math.min(1200, content + 8)}) or the content shorter`,
    )
  const where = isPage ? 'page' : `card ${width}×${height}`
  add(light, `${where}, light`)
  add(dark, `${where}, dark`)
  add(fullReport, 'full view, light')

  return {
    title: a.title,
    card: { width, height, content, fits: content <= height },
    screenshots: { card_light: cardLightPng, card_dark: cardDarkPng, full: fullPng },
    issues,
  }
}

export interface PreviewResult {
  dir: string
  artifacts: PreviewedArtifact[]
  errors: string[]
  warnings: string[]
}

/**
 * The artifacts in `text` — a message's markdown with ```artifact fences, or,
 * with `asHtml`, one whole page — rendered to `dir` (a fresh temp dir by
 * default).
 */
export async function previewArtifacts(
  chrome: string,
  text: string,
  opts: { asHtml?: { title: string; box: ArtifactBox }; dir?: string } = {},
): Promise<PreviewResult> {
  const dir =
    opts.dir ?? join(tmpdir(), 'diffo-preview', `${Date.now().toString(36)}-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  let inputs: PreviewInput[]
  let errors: string[] = []
  let warnings: string[] = []
  if (opts.asHtml) {
    inputs = [{ ...opts.asHtml, html: text }]
  } else {
    const check = checkArtifacts(text)
    errors = check.errors
    warnings = check.warnings
    inputs = check.artifacts
      .filter((a) => a.closed && a.html.trim() !== '')
      .map((a) => ({
        title: a.info.title ?? `artifact ${a.index + 1}`,
        box: boxOf(a.info.size),
        html: a.html,
      }))
  }
  const artifacts: PreviewedArtifact[] = []
  for (const [i, a] of inputs.entries()) artifacts.push(await previewOne(chrome, dir, i + 1, a))
  return { dir, artifacts, errors, warnings }
}

/** A title for a whole .html file: its <title>, else its file name. */
export function htmlTitle(html: string, path: string | null): string {
  const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim()
  return t || (path ? basename(path).replace(/\.html?$/i, '') : 'artifact')
}
