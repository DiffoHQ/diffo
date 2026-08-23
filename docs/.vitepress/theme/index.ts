import DefaultTheme from 'vitepress/theme'
import { useRoute } from 'vitepress'
import { nextTick, onMounted, watch } from 'vue'
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

export default {
  extends: DefaultTheme,
  setup() {
    if (typeof window === 'undefined') return
    const route = useRoute()
    let teardown: (() => void) | undefined

    const rebind = () => {
      teardown?.()
      teardown = bindClips()
    }

    onMounted(rebind)
    watch(() => route.path, () => nextTick(rebind))
  },
}
