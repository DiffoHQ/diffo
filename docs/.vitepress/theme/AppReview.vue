<script setup lang="ts">
/*
 * The review UI, drawn in HTML so the docs can animate it.
 *
 * A faithful miniature of the real app (src/ui): the header with the agent chip and
 * Finish review, the Files / Threads / Layers rail, a layer card, a file card with
 * Viewed, and an inline thread with You and Agent rows. Colours are the app's own
 * tokens from src/ui/styles.css, in both themes. Copy any change to the app's look
 * here too, or this stops being a picture of Diffo.
 *
 * `stage` drives it: 1 the agent orients you (layers + the layer card), 2 you read
 * (the hunk lands, Viewed ticks), 3 you comment (a Question is typed on line 14),
 * 4 the agent answers (it works, answers in the thread, and the fix lands in the diff).
 * Every change is a transition, so a lower stage plays the scene back in reverse.
 */
import { computed, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{ stage: number }>()

const QUESTION = 'Does “friday” on a Friday mean today or next week?'

const typed = ref(props.stage >= 3 ? QUESTION : '')
const phase = ref<'idle' | 'working' | 'answered' | 'fixed'>(props.stage >= 4 ? 'fixed' : 'idle')
let timers: number[] = []

function clear() {
  for (const t of timers) clearTimeout(t)
  timers = []
}

function later(ms: number, fn: () => void) {
  timers.push(window.setTimeout(fn, ms))
}

const still =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/* Types the question from scratch; returns how long that takes. */
function typeQuestion() {
  if (typed.value === QUESTION) return 0
  if (still) {
    typed.value = QUESTION
    return 0
  }
  typed.value = ''
  for (let i = 1; i <= QUESTION.length; i++) {
    later(400 + i * 26, () => (typed.value = QUESTION.slice(0, i)))
  }
  return 400 + QUESTION.length * 26
}

watch(
  () => props.stage,
  (stage) => {
    clear()
    if (stage < 3) {
      typed.value = ''
      phase.value = 'idle'
      return
    }
    const typing = typeQuestion()
    if (stage === 3) {
      phase.value = 'idle'
      return
    }
    if (still) {
      phase.value = 'fixed'
      return
    }
    if (phase.value === 'fixed') return
    later(typing + 300, () => (phase.value = 'working'))
    later(typing + 2000, () => (phase.value = 'answered'))
    later(typing + 2800, () => (phase.value = 'fixed'))
  },
)

onUnmounted(clear)

const agent = computed(() =>
  phase.value === 'working' ? 'agent · working' : 'agent · listening',
)
const fixed = computed(() => phase.value === 'fixed')
const answered = computed(() => phase.value === 'answered' || phase.value === 'fixed')
const viewed = computed(() => props.stage >= 2 && !fixed.value)

type Seg = [cls: string, text: string]
const L = (...segs: Seg[]) => segs

const rows: Array<{ o?: number; n?: number; kind?: 'add' | 'del'; code: Seg[]; at?: true }> = [
  { o: 12, n: 12, code: L(['k', 'export function '], ['f', 'parseDue'], ['', '(input: '], ['k', 'string'], ['', '): Date | '], ['k', 'null'], ['', ' {']) },
  { o: 13, kind: 'del', code: L(['k', '  const '], ['', 'day = WEEKDAYS.'], ['f', 'indexOf'], ['', '(input.'], ['f', 'toLowerCase'], ['', '())']) },
  { n: 13, kind: 'add', code: L(['k', '  const '], ['', 'day = WEEKDAYS.'], ['f', 'indexOf'], ['', '('], ['f', 'normalize'], ['', '(input))']) },
  { o: 14, n: 14, at: true, code: L(['k', '  if '], ['', '(day === '], ['n', '-1'], ['', ') '], ['k', 'return null']) },
]
const fixRow: Seg[] = L(['k', '  if '], ['', '(day === '], ['f', 'today'], ['', '()) '], ['k', 'return '], ['f', 'nextWeek'], ['', '(day)'])
const tail: Array<{ o: number; code: Seg[] }> = [
  { o: 15, code: L(['k', '  return '], ['f', 'nextWeekday'], ['', '(day)']) },
  { o: 16, code: L(['', '}']) },
]
</script>

<template>
  <div
    class="app-review"
    :class="{ s1: stage >= 1, s2: stage >= 2, s3: stage >= 3, s4: stage >= 4, fixed, answered }"
    aria-hidden="true"
  >
    <!-- Header -->
    <div class="ar-head">
      <span class="ar-burger"><i /><i /><i /></span>
      <b class="ar-word">Diffo</b>
      <span class="ar-crumb ar-mono">todo-app</span>
      <span class="ar-crumb ar-mono ar-branch">main</span>
      <span class="ar-crumb ar-mono ar-range">working tree → HEAD</span>
      <span class="ar-stat ar-mono"><em class="p">+{{ fixed ? 6 : 5 }}</em> <em class="m">−1</em></span>
      <span class="ar-agent" :class="{ busy: phase === 'working' }">
        <span class="ar-bars"><i /><i /><i /></span>{{ agent }}
      </span>
      <span class="ar-finish">Finish review</span>
    </div>

    <div class="ar-body">
      <!-- Left rail -->
      <aside class="ar-rail">
        <div class="ar-tabs">
          <span :class="{ on: stage < 1 }">Files <i>3</i></span>
          <span>Threads <i>{{ stage >= 3 ? 1 : 0 }}</i></span>
          <span class="ar-tab-layers" :class="{ on: stage >= 1 }">Layers <i>3</i></span>
        </div>
        <div class="ar-layers">
          <div v-for="(l, i) in ['Parse due dates', 'Wire into the list', 'Tests']" :key="l" class="ar-layer" :class="{ cur: i === 0 }" :style="{ '--i': i }">
            <span class="ar-box" :class="{ ticked: i === 0 && viewed }" />
            <div>
              <div class="ar-layer-t">{{ l }}</div>
              <div class="ar-layer-m"><span class="ar-mini"><span :style="{ transform: `scaleX(${i === 0 && viewed ? 1 : 0})` }" /></span>{{ [1, 2, 2][i] }} file{{ i ? 's' : '' }}</div>
            </div>
          </div>
        </div>
      </aside>

      <!-- Reading pane -->
      <div class="ar-pane">
        <div class="ar-bar ar-mono">
          <span class="ar-prog"><span :style="{ transform: `scaleX(${viewed ? 0.34 : 0})` }" /></span>
          layer 1 / 3 · 1 file · {{ viewed ? 0 : 1 }} left
        </div>

        <div class="ar-layer-card">
          <div class="ar-lc-k">Layer 1 of 3</div>
          <div class="ar-lc-t">Parse due dates</div>
          <p>
            <code>parseDue</code> reads a weekday in plain words; everything after it hangs off the
            <code>Date</code> it returns.
          </p>
          <div class="ar-flow">
            <span>input</span><i /><span>normalize</span><i /><span>parseDue</span><i /><span>Date</span>
          </div>
        </div>

        <div class="ar-file">
          <div class="ar-file-h">
            <span class="ar-chev" />
            <span class="ar-mono ar-path">src/todo/<b>dates.ts</b></span>
            <span class="ar-changed">changed since you read it</span>
            <span class="ar-mono ar-num"><em class="p">+{{ fixed ? 2 : 1 }}</em> <em class="m">−1</em></span>
            <span class="ar-blocks"><i class="p" /><i class="p" /><i class="p" /><i class="m" /><i /></span>
            <span class="ar-viewed" :class="{ on: viewed }"><span class="ar-box" :class="{ ticked: viewed }" />Viewed</span>
          </div>

          <div class="ar-code ar-mono">
            <div v-for="(r, i) in rows" :key="i" class="ar-row" :class="[r.kind, { at: r.at }]" :style="{ '--i': i }">
              <span class="ar-ln">{{ r.o }}</span><span class="ar-ln">{{ r.n }}</span>
              <span class="ar-sign">{{ r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : '' }}</span>
              <span class="ar-src"><span v-for="(s, j) in r.code" :key="j" :class="s[0]">{{ s[1] }}</span></span>
            </div>

            <!-- The thread, inline under the line it is on, as in the app. -->
            <div class="ar-thread-wrap">
              <div class="ar-thread">
                <div class="ar-th-h">
                  <span class="ar-chev small" />Comment on line 14
                  <span class="ar-kind">Question</span>
                  <span class="ar-sent">{{ phase === 'idle' ? 'Draft' : 'Sent' }}</span>
                </div>
                <div class="ar-msg">
                  <span class="ar-av you" />
                  <div>
                    <div class="ar-who"><b>You</b> commented just now</div>
                    <div class="ar-text">{{ typed }}<span v-if="stage >= 3 && typed !== QUESTION" class="ar-caret" /></div>
                  </div>
                </div>
                <div class="ar-msg ar-agent-msg">
                  <span class="ar-av bot">✦</span>
                  <div>
                    <div class="ar-who"><b class="amber">Agent</b> {{ answered ? 'answered in 4.2s' : 'with the agent · just now' }}</div>
                    <div v-if="!answered" class="ar-dots"><i /><i /><i /></div>
                    <div v-else class="ar-text ar-answer">
                      Today, which is wrong: a bare weekday should mean the next one. Fixed, so
                      <code>parseDue('friday')</code> on a Friday rolls to next week.
                    </div>
                  </div>
                </div>
                <div class="ar-reply"><span>Reply…</span><b>Resolve</b></div>
              </div>
            </div>

            <div class="ar-fix-wrap">
              <div class="ar-row add ar-fix">
                <span class="ar-ln" /><span class="ar-ln">15</span><span class="ar-sign">+</span>
                <span class="ar-src"><span v-for="(s, j) in fixRow" :key="j" :class="s[0]">{{ s[1] }}</span></span>
              </div>
            </div>

            <div v-for="(r, i) in tail" :key="r.o" class="ar-row" :style="{ '--i': i + 4 }">
              <span class="ar-ln">{{ r.o }}</span><span class="ar-ln">{{ fixed ? r.o + 1 : r.o }}</span>
              <span class="ar-sign" />
              <span class="ar-src"><span v-for="(s, j) in r.code" :key="j" :class="s[0]">{{ s[1] }}</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The app's tokens (src/ui/styles.css), light then dark. */
.app-review {
  --paper: #ffffff;
  --fill: #f5f5f7;
  --fill-2: #ebebed;
  --ink: #1d1d1f;
  --ink-2: #515154;
  --ink-3: #6e6e73;
  --hair: #e5e5e7;
  --brand: #1a7f37;
  --brand-solid: #1f883d;
  --attn: #9a6206;
  --attn-wash: #faf1e2;
  --attn-line: #e6cfa0;
  --add: #248a3d;
  --add-row: rgba(36, 138, 61, 0.1);
  --del: #c9252d;
  --del-row: rgba(201, 37, 45, 0.085);
  --sx-k: #cf222e;
  --sx-f: #8250df;
  --sx-n: #0550ae;
  --finish-bg: #1d1d1f;
  --finish-fg: #ffffff;
  --ease: cubic-bezier(0.22, 0.7, 0.2, 1);

  container-type: inline-size;
  overflow: hidden;
  height: 560px;
  border: 1px solid var(--hair);
  border-radius: 14px;
  background: var(--paper);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 30px 80px -40px rgba(0, 0, 0, 0.35);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 12.5px;
  line-height: 1.45;
  text-align: left;
}


.ar-mono {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}

code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--fill);
  color: var(--ink);
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.92em;
}

/* ── Header ── */
.ar-head {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
  padding: 0 14px;
  border-bottom: 1px solid var(--hair);
  white-space: nowrap;
}

.ar-burger { display: grid; gap: 2.5px; width: 13px; }
.ar-burger i { height: 1.5px; border-radius: 1px; background: var(--ink); }
.ar-burger i:nth-child(2) { width: 75%; }
.ar-word { font-size: 15px; font-weight: 600; margin-right: 4px; }
.ar-crumb { color: var(--ink-3); font-size: 12px; }
.ar-range { color: var(--ink); }
.ar-branch::before { content: '⑂ '; }
.ar-stat em, .ar-num em { font-style: normal; }
.p { color: var(--add); }
.m { color: var(--del); }

.ar-agent {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 4px 11px;
  border: 1px solid var(--attn-line);
  border-radius: 999px;
  background: var(--attn-wash);
  color: var(--attn);
  font-size: 12px;
  transition: background-color 0.3s;
}

.ar-bars { display: inline-flex; align-items: center; gap: 1.5px; height: 10px; }
.ar-bars i { width: 2px; height: 4px; border-radius: 1px; background: currentColor; }
.ar-bars i:nth-child(2) { height: 8px; }
.ar-agent.busy .ar-bars i { animation: ar-eq 0.8s ease-in-out infinite; }
.ar-agent.busy .ar-bars i:nth-child(2) { animation-delay: 0.15s; }
.ar-agent.busy .ar-bars i:nth-child(3) { animation-delay: 0.3s; }

@keyframes ar-eq { 50% { height: 10px; } }

.ar-finish {
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--finish-bg);
  color: var(--finish-fg);
  font-size: 12.5px;
  font-weight: 600;
}

/* ── Body ── */
.ar-body {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  height: calc(100% - 46px);
}

.ar-rail {
  border-right: 1px solid var(--hair);
  overflow: hidden;
}

.ar-tabs {
  display: flex;
  margin: 10px 8px;
  padding: 2px;
  border-radius: 8px;
  background: var(--fill);
  font-size: 12px;
  color: var(--ink-3);
}

.ar-tabs span {
  flex: 1;
  padding: 4px 0;
  white-space: nowrap;
  border-radius: 6px;
  text-align: center;
  transition: background-color 0.3s, color 0.3s, box-shadow 0.3s;
}

.ar-tabs i { font-style: normal; font-size: 11px; opacity: 0.7; }
.ar-tabs .on { background: var(--paper); color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }

.ar-layer {
  display: flex;
  gap: 9px;
  padding: 8px 12px;
  opacity: 0;
  transform: translateX(-8px);
  transition: opacity 0.45s var(--ease), transform 0.45s var(--ease), background-color 0.3s;
  transition-delay: calc(0.2s + var(--i) * 90ms);
}

.ar-layer.cur { background: var(--fill); }
.ar-layer-t { font-size: 12.5px; font-weight: 500; }
.ar-layer-m { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ink-3); }

.ar-mini { position: relative; width: 40px; height: 2px; overflow: hidden; border-radius: 2px; background: var(--fill-2); }
.ar-mini span, .ar-prog span {
  position: absolute;
  inset: 0;
  background: var(--brand);
  transform-origin: left;
  transition: transform 0.6s var(--ease) 0.6s;
}

.ar-box {
  flex: none;
  width: 13px;
  height: 13px;
  margin-top: 2px;
  border: 1px solid var(--ink-3);
  border-radius: 3.5px;
  background-position: center;
  background-repeat: no-repeat;
  background-size: 9px;
  transition: background-color 0.25s, border-color 0.25s;
}

.ar-box.ticked {
  border-color: var(--brand-solid);
  background-color: var(--brand-solid);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.5l2.5 2.5 4.5-5' fill='none' stroke='white' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  transition-delay: 0.6s;
}

/* ── Pane ── */
.ar-pane {
  overflow: hidden;
  padding: 0 14px;
}

.ar-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  color: var(--ink-3);
  font-size: 11.5px;
}

.ar-prog { position: relative; width: 52px; height: 2px; overflow: hidden; border-radius: 2px; background: var(--fill-2); }

.ar-layer-card {
  max-height: 0;
  margin-bottom: 0;
  padding: 0 14px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 10px;
  opacity: 0;
  transition:
    max-height 0.55s var(--ease),
    padding 0.55s var(--ease),
    margin 0.55s var(--ease),
    opacity 0.4s var(--ease),
    border-color 0.4s;
}

.ar-lc-k { font-size: 11px; color: var(--ink-3); }
.ar-lc-t { margin: 2px 0 4px; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.ar-layer-card p { margin: 0 0 10px; color: var(--ink-2); line-height: 1.6; }

.ar-flow {
  display: flex;
  align-items: center;
  padding: 14px;
  border-radius: 8px;
  background: var(--fill);
  font-size: 11.5px;
}

.ar-flow span {
  padding: 5px 10px;
  border: 1px solid var(--hair);
  border-radius: 4px;
  background: var(--paper);
  opacity: 0;
  transition: opacity 0.4s 0.5s;
}

.ar-flow i {
  position: relative;
  flex: 1;
  height: 1px;
  background: var(--ink-3);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.45s var(--ease) 0.7s;
}

.ar-flow i::after {
  content: '';
  position: absolute;
  right: -1px;
  top: -3px;
  border: 3.5px solid transparent;
  border-left: 5px solid var(--ink-3);
  border-right: 0;
}

/* File card */
.ar-file {
  overflow: hidden;
  border: 1px solid var(--hair);
  border-radius: 10px;
}

.ar-file-h {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--hair);
  background: var(--fill);
  white-space: nowrap;
}

.ar-chev {
  width: 6px;
  height: 6px;
  border-right: 1.5px solid var(--ink-3);
  border-bottom: 1.5px solid var(--ink-3);
  transform: rotate(45deg) translate(-2px, -2px);
}

.ar-chev.small { width: 5px; height: 5px; margin-right: 8px; }
.ar-path { color: var(--ink-3); font-size: 12px; }
.ar-path b { color: var(--ink); font-weight: 600; }

.ar-changed {
  padding: 2px 8px;
  border: 1px solid var(--attn-line);
  border-radius: 999px;
  background: var(--attn-wash);
  color: var(--attn);
  font-size: 11px;
  opacity: 0;
  transform: scale(0.9);
  transition: opacity 0.35s var(--ease), transform 0.35s var(--ease);
}

.ar-num { margin-left: auto; font-size: 11.5px; }
.ar-blocks { display: flex; gap: 1.5px; }
.ar-blocks i { width: 7px; height: 7px; border-radius: 1.5px; background: var(--fill-2); }
.ar-blocks i.p { background: var(--add); }
.ar-blocks i.m { background: var(--del); }

.ar-viewed {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border: 1px solid var(--hair);
  border-radius: 6px;
  background: var(--paper);
  font-size: 12px;
}

.ar-viewed .ar-box { margin-top: 0; }

/* Code */
.ar-code { font-size: 12px; line-height: 23px; }

.ar-row {
  display: grid;
  grid-template-columns: 34px 34px 18px minmax(0, 1fr);
  opacity: 0;
  transform: translateY(5px);
  transition: opacity 0.45s var(--ease), transform 0.45s var(--ease), background-color 0.4s;
  transition-delay: calc(var(--i, 0) * 70ms);
}

.ar-ln { padding-right: 8px; color: var(--ink-3); text-align: right; user-select: none; }
.ar-sign { text-align: center; }
.ar-src { overflow: hidden; white-space: pre; text-overflow: ellipsis; }
.ar-row.add { background: var(--add-row); }
.ar-row.add .ar-sign { color: var(--add); }
.ar-row.add .ar-ln:nth-child(2) { box-shadow: inset -2px 0 0 var(--add); }
.ar-row.del { background: var(--del-row); }
.ar-row.del .ar-sign { color: var(--del); }
.k { color: var(--sx-k); }
.f { color: var(--sx-f); }
.n { color: var(--sx-n); }

/* Thread */
.ar-thread-wrap,
.ar-fix-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.55s var(--ease);
}

.ar-thread-wrap > *,
.ar-fix-wrap > * { min-height: 0; overflow: hidden; }

.ar-thread {
  margin: 0 10px;
  border: 1px solid var(--hair);
  border-radius: 10px;
  background: var(--paper);
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 12.5px;
  line-height: 1.5;
  opacity: 0;
  transition: opacity 0.4s var(--ease), margin 0.55s var(--ease);
}

.ar-th-h {
  display: flex;
  align-items: center;
  padding: 7px 12px;
  border-bottom: 1px solid var(--hair);
  background: var(--fill);
  color: var(--ink-2);
  font-size: 12px;
}

.ar-kind {
  margin-left: 8px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--paper);
  border: 1px solid var(--hair);
  font-size: 11px;
}

.ar-sent { margin-left: auto; color: var(--ink-3); font-size: 11.5px; }

.ar-msg {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
}

.ar-agent-msg {
  border-top: 1px solid var(--hair);
  max-height: 0;
  padding-block: 0;
  overflow: hidden;
  opacity: 0;
  transition: max-height 0.5s var(--ease), padding 0.5s var(--ease), opacity 0.4s;
}

.ar-av {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 11px;
}

.ar-av.you { background: var(--ink); }
.ar-av.bot { border: 1px solid var(--attn-line); background: var(--attn-wash); color: var(--attn); }
.ar-who { color: var(--ink-3); font-size: 11.5px; }
.ar-who b { color: var(--ink); font-weight: 600; margin-right: 3px; }
.ar-who b.amber { color: var(--attn); }
.ar-text { min-height: 1.5em; margin-top: 2px; color: var(--ink); }
.ar-answer { animation: ar-in 0.45s var(--ease) both; }

@keyframes ar-in { from { opacity: 0; transform: translateY(4px); } }

.ar-caret {
  display: inline-block;
  width: 1.5px;
  height: 1.1em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--ink);
}

.ar-dots { display: flex; gap: 4px; padding: 7px 0 3px; }
.ar-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--ink-3); animation: ar-dot 1s ease-in-out infinite; }
.ar-dots i:nth-child(2) { animation-delay: 0.15s; }
.ar-dots i:nth-child(3) { animation-delay: 0.3s; }

@keyframes ar-dot { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }

.ar-reply {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 10px;
  border-top: 1px solid var(--hair);
  color: var(--ink-3);
}

.ar-reply span { flex: 1; padding: 5px 10px; border: 1px solid var(--hair); border-radius: 7px; }
.ar-reply b { color: var(--ink-2); font-weight: 500; }

/* ── Stages ── */
.s1 .ar-layer { opacity: 1; transform: none; }
.s1 .ar-layer-card {
  max-height: 260px;
  margin-bottom: 12px;
  padding: 12px 14px 14px;
  border-color: var(--hair);
  opacity: 1;
}
.s1 .ar-flow span { opacity: 1; }
.s1 .ar-flow i { transform: none; }

.app-review:not(.s2) .ar-file { opacity: 0.5; }
.ar-file { transition: opacity 0.4s; }

/* Reading: the layer card makes way for the code. */
.s2 .ar-layer-card { max-height: 0; margin-bottom: 0; padding-block: 0; border-color: transparent; opacity: 0; }
.s2 .ar-row { opacity: 1; transform: none; }

.s3 .ar-row.at { background: rgba(127, 127, 127, 0.1); transition-delay: 0s; }
.s3 .ar-thread-wrap { grid-template-rows: 1fr; }
.s3 .ar-thread { margin: 6px 10px 8px; opacity: 1; }

.s4 .ar-agent-msg { max-height: 140px; padding-block: 10px; opacity: 1; }
.fixed .ar-fix-wrap { grid-template-rows: 1fr; }
.fixed .ar-fix { opacity: 1; transform: none; }
.fixed .ar-changed { opacity: 1; transform: none; }
.fixed .ar-row.at { background: transparent; }

/* ── Narrow ── */
@container (max-width: 760px) {
  .ar-body { grid-template-columns: 170px minmax(0, 1fr); }
  .ar-crumb, .ar-stat, .ar-blocks, .ar-changed { display: none; }
  .ar-tabs { font-size: 11px; }
  .ar-tabs i { display: none; }
}

@container (max-width: 600px) {
  .ar-body { grid-template-columns: minmax(0, 1fr); }
  .ar-rail { display: none; }
  .ar-head { gap: 8px; }
}

@container (max-width: 460px) {
  .ar-finish, .ar-num, .ar-reply, .ar-kind { display: none; }
  .ar-bar { height: 10px; font-size: 0; }
  .ar-msg { padding: 8px 10px; }
  .s4 .ar-agent-msg { padding-block: 8px; }
  .ar-row { grid-template-columns: 26px 26px 14px minmax(0, 1fr); }
  .ar-code { font-size: 11px; }
}

@media (max-width: 960px) {
  .app-review { height: 480px; }
}

@media (prefers-reduced-motion: reduce) {
  .app-review *,
  .app-review *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation: none !important;
  }
}
</style>

<style>
/* Dark tokens. Unscoped, because the theme class lives on <html>, outside the component. */
html.dark .app-review {
  --paper: #000000;
  --fill: #1c1c1e;
  --fill-2: #2c2c2e;
  --ink: #f5f5f7;
  --ink-2: #c7c7cc;
  --ink-3: #8e8e93;
  --hair: #2c2c2e;
  --brand: #3fb950;
  --brand-solid: #238636;
  --attn: #e3a646;
  --attn-wash: rgba(227, 166, 70, 0.12);
  --attn-line: rgba(227, 166, 70, 0.4);
  --add: #3fb950;
  --add-row: rgba(63, 185, 80, 0.13);
  --del: #f85149;
  --del-row: rgba(248, 81, 73, 0.12);
  --sx-k: #ff7b72;
  --sx-f: #d2a8ff;
  --sx-n: #79c0ff;
  --finish-bg: #f5f5f7;
  --finish-fg: #000000;
  box-shadow: 0 30px 80px -40px rgba(0, 0, 0, 0.8);
}
</style>
