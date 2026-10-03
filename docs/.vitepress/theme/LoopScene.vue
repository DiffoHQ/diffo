<script setup lang="ts">
/*
 * The loop, as a scene you scroll through.
 *
 * The review window is pinned while the four chapters scroll past it, and each chapter
 * rewrites the window: the agent orients you, you read, you comment, the agent answers.
 * The window is AppReview.vue, a miniature of the real app; every state there is a
 * transition keyed off `step`, so scrolling back up plays the scene in reverse. Without JavaScript the window renders finished
 * (step 4) and the chapters read as an ordinary list.
 */
import { onMounted, onUnmounted, ref } from 'vue'
import AppReview from './AppReview.vue'

const steps = [
  {
    title: 'The agent orients you',
    body: 'On a multi-file or structural change it leaves one guide comment at the top of the review: what the change does, plus a <a href="https://mermaid.js.org">mermaid</a> diagram when the shape is easier to see than to read. Ask, and it posts <a href="./guide/layers">layers</a>: the change as ordered steps, in the order it should be read, not alphabetically. It orients your reading and stops there, with no verdicts.',
  },
  {
    title: 'You read',
    body: 'Syntax-highlighted unified or split diffs, keyboard-first navigation, per-file viewed tracking. The changeset stays live: fresh hunks appear as the agent works, and a hunk you already read says <em>changed since you read it</em>.',
  },
  {
    title: 'You comment',
    body: 'On a line, a file, or the whole changeset. Every thread is marked <strong>Change</strong> (edit the code) or <strong>Question</strong> (answer it, touch nothing), so a question never turns into an unrequested refactor.',
  },
  {
    title: 'The agent answers',
    body: 'Send one thread now, or hand back the whole batch with honest coverage stats. Answers land inline in your threads; fixes land in the diff you\'re reading, so you\'re reading the fix itself, not a promise of one.',
  },
]

const root = ref<HTMLElement | null>(null)
const step = ref(steps.length)
const progress = ref(1)

let observer: IntersectionObserver | undefined
let frame = 0

function measure() {
  frame = 0
  const el = root.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const travel = rect.height - window.innerHeight * 0.5
  progress.value = Math.min(1, Math.max(0, (window.innerHeight * 0.5 - rect.top) / travel))
}

function onScroll() {
  if (!frame) frame = requestAnimationFrame(measure)
}

onMounted(() => {
  const el = root.value
  if (!el) return
  step.value = 1
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) step.value = Number((entry.target as HTMLElement).dataset.n)
      }
    },
    // On a narrow screen the pinned window covers the top half, so the chapter that
    // counts is the one crossing the visible lower part rather than the middle.
    {
      rootMargin: window.matchMedia('(max-width: 960px)').matches
        ? '-78% 0px -21% 0px'
        : '-45% 0px -54% 0px',
    },
  )
  for (const chapter of el.querySelectorAll('.ls-step')) observer.observe(chapter)
  window.addEventListener('scroll', onScroll, { passive: true })
  measure()
})

onUnmounted(() => {
  observer?.disconnect()
  window.removeEventListener('scroll', onScroll)
  if (frame) cancelAnimationFrame(frame)
})
</script>

<template>
  <section ref="root" class="loop-scene">
    <div class="ls-stage">
      <AppReview :stage="step" />

      <div class="ls-progress" aria-hidden="true">
        <span class="ls-count">0{{ step }} <i>/ 0{{ steps.length }}</i></span>
        <span class="ls-track"><span :style="{ transform: `scaleX(${progress})` }" /></span>
      </div>
    </div>

    <ol class="ls-steps">
      <li
        v-for="(s, i) in steps"
        :key="s.title"
        class="ls-step"
        :class="{ on: step === i + 1 }"
        :data-n="i + 1"
      >
        <div class="ls-n">0{{ i + 1 }}</div>
        <h3>{{ s.title }}</h3>
        <p v-html="s.body" />
      </li>
    </ol>
  </section>
</template>

<style scoped>
.loop-scene {
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
  display: grid;
  grid-template-columns: minmax(0, 1.8fr) minmax(0, 1fr);
  gap: 48px;
  margin-top: 32px;
}

.ls-stage {
  position: sticky;
  top: calc(var(--vp-nav-height) + 40px);
  align-self: start;
}

/* ── Progress ─────────────────────────────────────────────────────────── */
.ls-progress {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 16px;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-1);
}

.ls-count i { font-style: normal; color: var(--vp-c-text-3); }

.ls-track {
  position: relative;
  flex: 1;
  height: 2px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--vp-c-divider);
}

.ls-track span {
  position: absolute;
  inset: 0;
  background: var(--vp-c-brand-1);
  transform-origin: left;
}

/* ── Chapters ─────────────────────────────────────────────────────────── */
.ls-steps {
  margin: 0;
  padding: 0;
  list-style: none;
}

.vp-doc .ls-step {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 72vh;
  margin: 0;
  opacity: 0.28;
  transform: translateX(8px);
  transition: opacity 0.5s var(--ease), transform 0.5s var(--ease);
}

.vp-doc .ls-step:first-child { min-height: 50vh; justify-content: flex-start; padding-top: 8vh; }
.vp-doc .ls-step:last-child { min-height: 85vh; }

.vp-doc .ls-step.on { opacity: 1; transform: none; }

.ls-n {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-brand-1);
}

.vp-doc .ls-step h3 {
  margin: 8px 0 12px;
  font-size: 26px;
  line-height: 1.25;
  letter-spacing: -0.02em;
}

.vp-doc .ls-step p {
  margin: 0;
  font-size: 15px;
  line-height: 1.75;
  color: var(--vp-c-text-2);
}

/* ── Narrow: the window pins to the top and the chapters scroll under it. ── */
@media (max-width: 960px) {
  .loop-scene {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }

  .ls-stage {
    z-index: 2;
    top: var(--vp-nav-height);
    padding: 12px 0;
    background: var(--vp-c-bg);
  }


  .vp-doc .ls-step,
  .vp-doc .ls-step:first-child,
  .vp-doc .ls-step:last-child {
    min-height: 55vh;
    justify-content: center;
    padding-top: 0;
    transform: none;
  }

  .vp-doc .ls-step h3 { font-size: 21px; }
}

@media (prefers-reduced-motion: reduce) {
  .vp-doc .ls-step {
    transition: none;
  }
}
</style>
