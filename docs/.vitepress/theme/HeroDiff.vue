<script setup lang="ts">
/*
 * One round trip, on a loop: the hunk lands, a Question goes on line 14, the agent
 * answers in the thread, and the fix lands in the diff being read. The picture is
 * AppReview.vue, the same miniature of the app the loop scene uses; this only plays
 * it, once it scrolls into view. Reduced motion shows the finished state.
 */
import { onMounted, onUnmounted, ref } from 'vue'
import AppReview from './AppReview.vue'

const root = ref<HTMLElement | null>(null)
const stage = ref(4)
let timers: number[] = []
let observer: IntersectionObserver | undefined

const SCRIPT: Array<[ms: number, stage: number]> = [
  [0, 2],
  [1400, 3],
  [4200, 4],
  [12500, 2],
]
const LOOP_MS = 14000

function play() {
  for (const [ms, s] of SCRIPT) timers.push(window.setTimeout(() => (stage.value = s), ms))
  timers.push(window.setTimeout(play, LOOP_MS))
}

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  stage.value = 1
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer?.disconnect()
        play()
      }
    },
    { threshold: 0.35 },
  )
  if (root.value) observer.observe(root.value)
})

onUnmounted(() => {
  observer?.disconnect()
  for (const t of timers) clearTimeout(t)
})
</script>

<template>
  <div ref="root" class="hero-diff">
    <AppReview :stage="stage" />
  </div>
</template>

<style scoped>
.hero-diff {
  margin: 24px 0;
}
</style>
