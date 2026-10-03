<script setup lang="ts">
/*
 * The install, as a terminal with two ways in: run it yourself, or paste a prompt and
 * let your agent run it. The line types itself when it scrolls into view and again on
 * every tab switch. Without JavaScript, or with reduced motion, it is simply there.
 */
import { onMounted, onUnmounted, ref } from 'vue'

const tabs = [
  { label: 'For you', prompt: '$', text: 'npx skills add DiffoHQ/diffo --skill diffo' },
  {
    label: 'For your agent',
    prompt: '›',
    text: 'Run `npx skills add DiffoHQ/diffo --skill diffo -g` and open the diffo review',
  },
]

const root = ref<HTMLElement | null>(null)
const active = ref(0)
const shown = ref(tabs[0].text)
const typing = ref(false)
const copied = ref(false)

let still = false
let timer = 0
let observer: IntersectionObserver | undefined

function type(text: string) {
  clearInterval(timer)
  if (still) {
    shown.value = text
    return
  }
  let n = 0
  shown.value = ''
  typing.value = true
  timer = window.setInterval(() => {
    n += 1
    shown.value = text.slice(0, n)
    if (n >= text.length) {
      clearInterval(timer)
      typing.value = false
    }
  }, 28)
}

function pick(i: number) {
  if (i === active.value) return
  active.value = i
  copied.value = false
  type(tabs[i].text)
}

async function copy() {
  try {
    await navigator.clipboard.writeText(tabs[active.value].text)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    /* clipboard blocked; the text is selectable */
  }
}

onMounted(() => {
  still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (still || !root.value) return
  shown.value = ''
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        type(tabs[active.value].text)
        observer?.disconnect()
      }
    },
    { threshold: 0.6 },
  )
  observer.observe(root.value)
})

onUnmounted(() => {
  clearInterval(timer)
  observer?.disconnect()
})
</script>

<template>
  <div ref="root" class="install-term">
    <div class="it-bar">
      <span class="it-dot" /><span class="it-dot" /><span class="it-dot" />
      <div class="it-tabs" role="tablist">
        <button
          v-for="(t, i) in tabs"
          :key="t.label"
          role="tab"
          :aria-selected="active === i"
          :class="{ on: active === i }"
          @click="pick(i)"
        >
          {{ t.label }}
        </button>
      </div>
      <button class="it-copy" :class="{ copied }" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
    </div>
    <div class="it-line">
      <span class="it-prompt">{{ tabs[active].prompt }}</span>
      <code>{{ shown }}<span class="it-caret" :class="{ typing }" /></code>
    </div>
  </div>
</template>

<style scoped>
.install-term {
  margin: 20px 0 24px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-code-block-bg);
}

.it-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 8px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
}

.it-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--vp-c-default-soft);
}

.it-tabs {
  display: flex;
  gap: 2px;
  margin-left: 10px;
}

.it-tabs button,
.it-copy {
  padding: 3px 10px;
  border-radius: 6px;
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 500;
  transition: color 0.2s, background-color 0.2s;
}

.it-tabs button:hover,
.it-copy:hover {
  color: var(--vp-c-text-1);
}

.it-tabs button.on {
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-1);
}

.it-copy {
  margin-left: auto;
  border: 1px solid var(--vp-c-divider);
}

.it-copy.copied {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.it-line {
  display: flex;
  gap: 12px;
  min-height: 3.6em;
  padding: 16px 18px;
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  line-height: 1.7;
}

.it-prompt {
  color: var(--vp-c-brand-1);
  user-select: none;
}

.it-line code {
  padding: 0;
  background: none;
  color: var(--vp-c-text-1);
  font-size: inherit;
  white-space: pre-wrap;
  word-break: break-word;
}

.it-caret {
  display: inline-block;
  width: 8px;
  height: 1.15em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--vp-c-brand-1);
  animation: it-blink 1.1s steps(1, end) infinite;
}

.it-caret.typing {
  animation: none;
}

@keyframes it-blink {
  50% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .it-caret { animation: none; opacity: 0.6; }
}
</style>
