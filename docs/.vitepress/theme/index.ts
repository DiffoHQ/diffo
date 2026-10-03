import DefaultTheme from 'vitepress/theme'
import { useRoute } from 'vitepress'
import { h, nextTick, onMounted, watch } from 'vue'
import HeroDiff from './HeroDiff.vue'
import HeroField from './HeroField.vue'
import InstallTerminal from './InstallTerminal.vue'
import LivingMark from './LivingMark.vue'
import LoopScene from './LoopScene.vue'
import NavMark from './NavMark.vue'
import './custom.css'

/*
 * Play the screen-recorded clips only while they are on screen.
 *
 * The `autoplay` attribute cannot do this job: it overrides `preload="none"`, so every
 * clip on the page downloads at load, including the theme variant that is `display: none`
 * and will never be seen. Driving playback from an IntersectionObserver instead means a
 * clip is fetched the moment it scrolls into view and never before, a hidden variant is
 * never fetched at all, and anything scrolled past stops decoding.
 */
function bindClips() {
  const clips = document.querySelectorAll<HTMLVideoElement>('video.clip')
  if (!clips.length) return

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const video = entry.target as HTMLVideoElement
        if (entry.isIntersecting) {
          // play() on a preload="none" video is what triggers the download.
          video.play().catch(() => {
            /* autoplay blocked, or the clip was hidden mid-flight; nothing to recover */
          })
        } else {
          video.pause()
        }
      }
    },
    { rootMargin: '200px' },
  )

  for (const clip of clips) observer.observe(clip)
  return () => observer.disconnect()
}

/*
 * Home page motion: sections arrive like fresh hunks, and each heading rises in word by
 * word. Driven from here rather than from the CSS so that a page with no JavaScript (or a
 * reader who asked for reduced motion) sees everything at once: the classes that hide an
 * element are only ever added by this code, right before the observer that reveals it.
 */
function bindHomeMotion() {
  if (!document.querySelector('.VPHome')) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  const groups = document.querySelectorAll<HTMLElement>(
    '.VPHome .VPFeatures .items, .home-next ul',
  )
  for (const group of groups) {
    let i = 0
    for (const item of group.children) {
      ;(item as HTMLElement).style.setProperty('--reveal-i', String(i++))
    }
  }

  for (const h2 of document.querySelectorAll<HTMLElement>('.VPHome .vp-doc h2')) splitWords(h2)

  const targets = document.querySelectorAll<HTMLElement>(
    '.VPHome .VPFeatures .item, .VPHome .vp-doc h2, .VPHome .vp-doc h2 + p, .home-next li, .hero-diff, .install-term',
  )
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-in')
        observer.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  )
  for (const target of targets) {
    target.classList.add('reveal')
    observer.observe(target)
  }
  return () => observer.disconnect()
}

/* Wrap each word of a heading's own text in a mask, so the words can rise in one by one. */
function splitWords(heading: HTMLElement) {
  if (heading.dataset.split) return
  heading.dataset.split = '1'
  let i = 0
  for (const node of Array.from(heading.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
    const frag = document.createDocumentFragment()
    for (const part of node.textContent.split(/(\s+)/)) {
      if (!part) continue
      if (/^\s+$/.test(part)) {
        frag.append(part)
        continue
      }
      const mask = document.createElement('span')
      mask.className = 'word'
      const word = document.createElement('span')
      word.textContent = part
      word.style.setProperty('--w', String(i++))
      mask.append(word)
      frag.append(mask)
    }
    node.replaceWith(frag)
  }
}

/*
 * Scroll-linked values, written as CSS custom properties once per frame:
 * `--p` on each recorded clip (0 as it enters the bottom of the viewport, 1 once it is
 * well inside), which the CSS turns into a tilt that settles flat; and
 * `--home-progress` on the page, which draws the reading bar under the nav.
 */
function bindScrollFx() {
  if (!document.querySelector('.VPHome')) return
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const clips = still ? [] : Array.from(document.querySelectorAll<HTMLElement>('.home-clip'))
  const root = document.documentElement
  let frame = 0

  const measure = () => {
    frame = 0
    const vh = window.innerHeight
    for (const clip of clips) {
      const top = clip.getBoundingClientRect().top
      const p = Math.min(1, Math.max(0, (vh - top) / (vh * 0.7)))
      clip.style.setProperty('--p', p.toFixed(3))
    }
    const max = root.scrollHeight - vh
    root.style.setProperty('--home-progress', max > 0 ? (window.scrollY / max).toFixed(4) : '0')
  }
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(measure)
  }

  measure()
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
  return () => {
    window.removeEventListener('scroll', onScroll)
    window.removeEventListener('resize', onScroll)
    if (frame) cancelAnimationFrame(frame)
    root.style.removeProperty('--home-progress')
  }
}

/* A soft light that follows the pointer across cards; CSS reads --mx / --my. */
const SPOTLIT = '.VPFeature, .home-next li > a, .install-term'
function onSpotlight(e: PointerEvent) {
  const card = (e.target as Element | null)?.closest?.<HTMLElement>(SPOTLIT)
  if (!card) return
  const rect = card.getBoundingClientRect()
  card.style.setProperty('--mx', `${e.clientX - rect.left}px`)
  card.style.setProperty('--my', `${e.clientY - rect.top}px`)
}

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-title-before': () => h(NavMark),
      'home-hero-before': () => h(HeroField),
      'home-hero-image': () => h(LivingMark),
    })
  },
  enhanceApp({ app }) {
    app.component('HeroDiff', HeroDiff)
    app.component('InstallTerminal', InstallTerminal)
    app.component('LoopScene', LoopScene)
  },
  setup() {
    if (typeof window === 'undefined') return
    const route = useRoute()
    const teardowns: Array<(() => void) | undefined> = []

    const rebind = () => {
      for (const teardown of teardowns.splice(0)) teardown?.()
      teardowns.push(bindClips(), bindHomeMotion(), bindScrollFx())
    }

    onMounted(() => {
      document.addEventListener('pointermove', onSpotlight, { passive: true })
      rebind()
    })
    watch(() => route.path, () => nextTick(rebind))
  },
}
