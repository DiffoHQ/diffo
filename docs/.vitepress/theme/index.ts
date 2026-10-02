import DefaultTheme from 'vitepress/theme'
import { useRoute } from 'vitepress'
import { h, nextTick, onMounted, watch } from 'vue'
import HeroDiff from './HeroDiff.vue'
import LivingMark from './LivingMark.vue'
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
 * Home page motion: sections arrive like fresh hunks, and the install command types
 * itself. Both are driven from here rather than from the CSS so that a page with no
 * JavaScript (or a reader who asked for reduced motion) sees everything at once: the
 * classes that hide an element are only ever added by this code, right before the
 * observer that reveals it.
 */
function bindHomeMotion() {
  if (!document.querySelector('.VPHome')) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  const groups = document.querySelectorAll<HTMLElement>(
    '.VPHome .VPFeatures .items, .home-steps, .home-next ul',
  )
  for (const group of groups) {
    let i = 0
    for (const item of group.children) {
      ;(item as HTMLElement).style.setProperty('--reveal-i', String(i++))
    }
  }

  const targets = document.querySelectorAll<HTMLElement>(
    '.VPHome .VPFeatures .item, .VPHome .vp-doc h2, .VPHome .vp-doc h2 + p, .home-step, .home-next li, .home-clip, .hero-diff, .home-install',
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

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-title-before': () => h(NavMark),
      'home-hero-image': () => h(LivingMark),
    })
  },
  enhanceApp({ app }) {
    app.component('HeroDiff', HeroDiff)
  },
  setup() {
    if (typeof window === 'undefined') return
    const route = useRoute()
    const teardowns: Array<(() => void) | undefined> = []

    const rebind = () => {
      for (const teardown of teardowns.splice(0)) teardown?.()
      teardowns.push(bindClips(), bindHomeMotion())
    }

    onMounted(rebind)
    watch(() => route.path, () => nextTick(rebind))
  },
}
