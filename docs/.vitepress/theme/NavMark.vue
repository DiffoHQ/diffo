<script setup lang="ts">
/*
 * The mark in the nav bar. Still by default; hovering the site title retypes the
 * three code lines in brand green, top to bottom, then they settle back to ink.
 * Same drawing as the `logo` symbol in src/ui/components/Icon.tsx and assets/logo.svg.
 */
</script>

<template>
  <svg class="nav-mark" viewBox="0 0 32 32" aria-hidden="true">
    <g class="ink">
      <path d="M5 7.5h4" />
      <path d="M5 22.5h4M7 20.5v4" />
      <path class="line" d="M14 7.5h13" />
      <path class="line" d="M14 15h9" />
      <path class="line" d="M14 22.5h11" />
    </g>
  </svg>
</template>

<style scoped>
.nav-mark {
  flex-shrink: 0;
  width: var(--vp-nav-logo-height);
  height: var(--vp-nav-logo-height);
  margin-right: 8px;
}

.ink {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.6;
  stroke-linecap: round;
}

.line {
  stroke-dasharray: 14 14;
  stroke-dashoffset: 0;
}

/* `.title` is the VPNavBarTitle link that wraps this slot; it owns the hover. */
:global(.VPNavBarTitle .title:hover) .line {
  animation: retype 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) both;
}

:global(.VPNavBarTitle .title:hover) .line:nth-of-type(2) {
  animation-delay: 0.08s;
}

:global(.VPNavBarTitle .title:hover) .line:nth-of-type(3) {
  animation-delay: 0.16s;
}

@keyframes retype {
  0% { stroke-dashoffset: 14; stroke: var(--vp-c-brand-1); }
  70% { stroke: var(--vp-c-brand-1); }
  100% { stroke-dashoffset: 0; stroke: currentColor; }
}

@media (prefers-reduced-motion: reduce) {
  :global(.VPNavBarTitle .title:hover) .line {
    animation: none;
  }
}
</style>
