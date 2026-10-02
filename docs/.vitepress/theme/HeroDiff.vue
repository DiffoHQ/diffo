<script setup lang="ts">
/*
 * One round trip, drawn rather than recorded.
 *
 * A hunk lands line by line, a Question appears on a line, the agent answers in the
 * thread, the fix lands in the diff being read, and the hunk says it changed. Vector,
 * so it is crisp at any width and in both themes, and it costs nothing above the
 * fold where the recorded clips used to. The real recordings stay further down.
 *
 * The landing happens once, when the component scrolls into view; the thread then
 * loops every ten seconds. `prefers-reduced-motion` shows the finished state.
 */
import { onMounted, onUnmounted, ref } from 'vue'

const root = ref<HTMLElement | null>(null)
const live = ref(false)
let observer: IntersectionObserver | undefined

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    live.value = true
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        live.value = true
        observer?.disconnect()
      }
    },
    { threshold: 0.35 },
  )
  if (root.value) observer.observe(root.value)
})

onUnmounted(() => observer?.disconnect())
</script>

<template>
  <div ref="root" class="hero-diff" :class="{ live }" aria-hidden="true">
    <div class="hd-bar">
      <span class="hd-dot" /><span class="hd-dot" /><span class="hd-dot" />
      <span class="hd-path">src/todo/dates.ts</span>
      <span class="hd-meta">1 of 23 files · layer 1 / 8</span>
      <span class="hd-chip">changed since you read it</span>
    </div>
    <div class="hd-body">
      <div class="hd-line" style="--i: 0"><span>12</span><span>export function parseDue(input: string): Date | null {</span></div>
      <div class="hd-line del" style="--i: 1"><span>−</span><span>  const day = WEEKDAYS.indexOf(input.toLowerCase())</span></div>
      <div class="hd-line add" style="--i: 2"><span>+</span><span>  const day = WEEKDAYS.indexOf(normalize(input))</span></div>
      <div class="hd-line" style="--i: 3"><span>15</span><span>  if (day === -1) return null</span></div>
      <div class="hd-line add hd-fix"><span>+</span><span>  if (day === today()) return nextWeek(day)</span></div>
      <div class="hd-line" style="--i: 4"><span>16</span><span>  return nextWeekday(day)</span></div>
      <div class="hd-line" style="--i: 5"><span>17</span><span>}</span></div>
    </div>
    <div class="hd-thread">
      <div class="hd-kind">Question <span>· line 14</span></div>
      <p class="hd-q">Does “friday” on a Friday mean today or next week?</p>
      <p class="hd-a"><b>agent</b> Today, which is wrong. Fixed: the same weekday now rolls to next week.</p>
    </div>
  </div>
</template>

<style scoped>
.hero-diff {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 2;
}

.hd-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.hd-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--vp-c-default-soft);
}

.hd-dot:nth-child(3) { margin-right: 6px; }

.hd-path { color: var(--vp-c-text-1); }

.hd-chip {
  margin-left: auto;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-base);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  opacity: 0;
}

.hd-body {
  padding: 8px 0 72px;
}

.hd-line {
  display: grid;
  grid-template-columns: 32px 1fr;
  padding: 0 14px;
  white-space: pre;
  opacity: 0;
  transform: translateY(6px);
}

.hd-line > span:first-child {
  color: var(--vp-c-text-3);
  user-select: none;
}

.del { background: var(--diffo-c-del-soft); }
.del > span:first-child { color: var(--diffo-c-del); }
.add { background: var(--diffo-c-add-soft); }
.add > span:first-child { color: var(--diffo-c-add); }

.hd-thread {
  position: absolute;
  right: 14px;
  top: 118px;
  width: 240px;
  padding: 10px 12px;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 10px;
  background: var(--vp-c-bg);
  box-shadow: var(--vp-shadow-2);
  font-family: var(--vp-font-family-base);
  font-size: 12px;
  line-height: 1.5;
  opacity: 0;
}

.hd-kind {
  color: var(--vp-c-brand-1);
  font-weight: 600;
}

.hd-kind span {
  color: var(--vp-c-text-3);
  font-weight: 400;
}

.hd-thread p { margin: 4px 0 0; }
.hd-q { color: var(--vp-c-text-1); }
.hd-a { color: var(--vp-c-text-2); opacity: 0; }
.hd-a b { color: var(--vp-c-brand-1); font-weight: 600; margin-right: 4px; }

/* Landing: once, when in view, each line 90ms after the last. */
.live .hd-line {
  animation: land 0.5s cubic-bezier(0.2, 0.7, 0.2, 1) both;
  animation-delay: calc(var(--i) * 90ms);
}

@keyframes land {
  to { opacity: 1; transform: none; }
}

/* The fix takes no room until it lands, so the hunk grows by a line when it does. */
.hd-fix {
  height: 0;
  overflow: hidden;
}

/* The thread, on a 10s loop that starts once the hunk has landed. */
.live .hd-thread { animation: thread 10s ease 0.9s infinite; }
.live .hd-a { animation: answer 10s ease 0.9s infinite; }
.live .hd-fix { animation: fix 10s ease 0.9s infinite; }
.live .hd-chip { animation: chip 10s ease 0.9s infinite; }

@keyframes thread {
  0%, 14% { opacity: 0; transform: translateY(6px); }
  20%, 88% { opacity: 1; transform: none; }
  94%, 100% { opacity: 0; }
}

@keyframes answer {
  0%, 42% { opacity: 0; }
  48%, 88% { opacity: 1; }
  94%, 100% { opacity: 0; }
}

@keyframes fix {
  0%, 56% { opacity: 0; height: 0; transform: translateY(6px); }
  58% { opacity: 0; height: 2em; }
  62%, 88% { opacity: 1; height: 2em; transform: none; }
  94%, 100% { opacity: 0; height: 2em; }
}

@keyframes chip {
  0%, 60% { opacity: 0; }
  66%, 88% { opacity: 1; }
  94%, 100% { opacity: 0; }
}

@media (max-width: 640px) {
  .hero-diff { font-size: 12px; }
  .hd-meta { display: none; }
  .hd-body { padding-bottom: 8px; overflow-x: auto; }
  .hd-thread {
    position: static;
    width: auto;
    margin: 0 14px 14px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .live .hd-line,
  .live .hd-thread,
  .live .hd-a,
  .live .hd-fix,
  .live .hd-chip {
    animation: none;
    opacity: 1;
    transform: none;
  }

  .live .hd-fix {
    height: 2em;
  }
}
</style>
