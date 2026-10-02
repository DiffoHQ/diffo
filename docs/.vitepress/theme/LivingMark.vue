<script setup lang="ts">
/*
 * The hero mark, alive.
 *
 * The Diffo logo already is a diff: a removed line beside a −, a kept line, an added
 * line beside a +. Sitting still, nobody reads it that way. So in the hero it behaves
 * like one, on a nine-second loop: the top line and the − flush red, the bottom line
 * and the + flush green, a comment lands on the kept line, the agent erases and
 * retypes both changed lines in the brand green, and the mark settles back to ink.
 *
 * Same drawing as assets/logo.svg (stroke 2.6). Pure SVG + CSS keyframes, inherits
 * the theme's colours, no media. `prefers-reduced-motion` freezes it on the still mark.
 */
</script>

<template>
  <svg class="living-mark image-src" viewBox="-2 -2 36 36" role="img" aria-label="Diffo">
    <g class="ink">
      <path class="minus" d="M5 7.5h4" />
      <path class="plus plus-h" d="M5 22.5h4" />
      <path class="plus plus-v" d="M7 20.5v4" />
      <path class="l1" d="M14 7.5h13" />
      <path class="l2" d="M14 15h9" />
      <path class="l3" d="M14 22.5h11" />
    </g>
    <rect class="caret" x="25.6" y="20.9" width="1.2" height="3.2" rx="0.3" />
    <g class="comment">
      <circle cx="26.5" cy="12.6" r="3.1" />
      <path d="M24.9 12.6h3.2M26.5 11v3.2" />
    </g>
  </svg>
</template>

<style scoped>
.living-mark {
  width: 192px;
  height: 192px;
  overflow: visible;
}

@media (min-width: 640px) {
  .living-mark {
    width: 256px;
    height: 256px;
  }
}

@media (min-width: 960px) {
  .living-mark {
    width: 320px;
    height: 320px;
  }
}

.ink {
  fill: none;
  stroke: var(--vp-c-text-1);
  stroke-width: 2.6;
  stroke-linecap: round;
}

.ink path {
  animation-duration: 9s;
  animation-iteration-count: infinite;
  animation-timing-function: cubic-bezier(0.2, 0.7, 0.2, 1);
}

/* Each line is a dash exactly its own length, so a dashoffset sweep types it. */
.l1 { stroke-dasharray: 13 13; animation-name: l1; }
.l3 { stroke-dasharray: 11 11; animation-name: l3; }
.minus { animation-name: minus; animation-timing-function: ease; }
.plus { stroke-dasharray: 4 4; animation-timing-function: ease; }
.plus-h { animation-name: plus-h; }
.plus-v { animation-name: plus-v; }

.caret {
  fill: var(--vp-c-brand-1);
  opacity: 0;
  animation: caret 9s steps(1, end) infinite;
}

.comment {
  opacity: 0;
  transform-origin: 26.5px 12.6px;
  animation: comment 9s cubic-bezier(0.2, 0.7, 0.2, 1) infinite;
}

.comment circle { fill: var(--vp-c-brand-1); }
.comment path {
  fill: none;
  stroke: var(--vp-c-bg);
  stroke-width: 1.1;
  stroke-linecap: round;
}

/*
 * The story, on 9s:
 *   0–12%   the still mark
 *   16–45%  the diff shows its colours: − and line 1 red, + and line 3 green
 *   30–56%  a comment lands on the kept line
 *   52–82%  the agent erases both changed lines and retypes them, caret blinking
 *   92%–    ink again
 */
@keyframes minus {
  0%, 12% { stroke: var(--vp-c-text-1); }
  16%, 45% { stroke: var(--diffo-c-del); }
  60%, 100% { stroke: var(--vp-c-text-1); }
}

@keyframes l1 {
  0%, 12% { stroke: var(--vp-c-text-1); stroke-dashoffset: 0; }
  16%, 45% { stroke: var(--diffo-c-del); stroke-dashoffset: 0; }
  52% { stroke: var(--diffo-c-del); stroke-dashoffset: 13; }
  58% { stroke: var(--vp-c-brand-1); stroke-dashoffset: 13; }
  68%, 82% { stroke: var(--vp-c-brand-1); stroke-dashoffset: 0; }
  92%, 100% { stroke: var(--vp-c-text-1); stroke-dashoffset: 0; }
}

@keyframes l3 {
  0%, 12% { stroke: var(--vp-c-text-1); stroke-dashoffset: 0; }
  16%, 45% { stroke: var(--diffo-c-add); stroke-dashoffset: 0; }
  52% { stroke: var(--diffo-c-add); stroke-dashoffset: 11; }
  60% { stroke: var(--vp-c-brand-1); stroke-dashoffset: 11; }
  72%, 82% { stroke: var(--vp-c-brand-1); stroke-dashoffset: 0; }
  92%, 100% { stroke: var(--vp-c-text-1); stroke-dashoffset: 0; }
}

@keyframes plus-h {
  0%, 12% { stroke: var(--vp-c-text-1); }
  16%, 45% { stroke: var(--diffo-c-add); }
  60%, 100% { stroke: var(--vp-c-text-1); }
}

@keyframes plus-v {
  0%, 12% { stroke: var(--vp-c-text-1); stroke-dashoffset: 0; }
  13% { stroke-dashoffset: 4; }
  16% { stroke: var(--diffo-c-add); stroke-dashoffset: 0; }
  45% { stroke: var(--diffo-c-add); }
  60%, 100% { stroke: var(--vp-c-text-1); }
}

@keyframes comment {
  0%, 30% { opacity: 0; transform: scale(0.4); }
  34%, 56% { opacity: 1; transform: scale(1); }
  62%, 100% { opacity: 0; transform: scale(0.6); }
}

@keyframes caret {
  0%, 52% { opacity: 0; }
  53%, 55% { opacity: 1; }
  56%, 58% { opacity: 0; }
  59%, 61% { opacity: 1; }
  62%, 64% { opacity: 0; }
  65%, 67% { opacity: 1; }
  68%, 70% { opacity: 0; }
  71%, 73% { opacity: 1; }
  74%, 76% { opacity: 0; }
  77%, 79% { opacity: 1; }
  80%, 100% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .ink path,
  .caret,
  .comment {
    animation: none;
  }
}
</style>
