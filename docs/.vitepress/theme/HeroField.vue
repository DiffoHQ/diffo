<script setup lang="ts">
/*
 * The ground behind the hero: a field of faint points, some of them + and −.
 *
 * Every few seconds a hunk "lands": a band sweeps down the field and the points it
 * crosses light up in the diff's own colours. Points near the pointer brighten and
 * lean away from it. One canvas, drawn only while the hero is on screen and the tab
 * is visible; `prefers-reduced-motion` gets a single still frame.
 */
import { onMounted, onUnmounted, ref } from 'vue'

const canvas = ref<HTMLCanvasElement | null>(null)

type Point = { x: number; y: number; a: number; kind: 0 | 1 | 2; phase: number }

const GAP = 26
const SWEEP_MS = 5200

let points: Point[] = []
let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0
let raf = 0
let visible = true
let pointer = { x: -1e4, y: -1e4 }
let start = 0
let observer: IntersectionObserver | undefined
let resizeObserver: ResizeObserver | undefined

function layout() {
  const el = canvas.value
  if (!el || !ctx) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = el.clientWidth
  height = el.clientHeight
  el.width = width * dpr
  el.height = height * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  points = []
  for (let y = GAP / 2; y < height; y += GAP) {
    for (let x = GAP / 2; x < width; x += GAP) {
      const r = Math.random()
      points.push({
        x,
        y,
        a: 0.16 + Math.random() * 0.22,
        kind: r < 0.04 ? 1 : r < 0.07 ? 2 : 0,
        phase: Math.random() * Math.PI * 2,
      })
    }
  }
}

function colours() {
  const style = getComputedStyle(document.documentElement)
  return {
    ink: style.getPropertyValue('--vp-c-text-1').trim() || '#fff',
    add: style.getPropertyValue('--diffo-c-add').trim() || '#3fb950',
    del: style.getPropertyValue('--diffo-c-del').trim() || '#f85149',
  }
}

function draw(now: number) {
  if (!ctx) return
  const c = colours()
  const t = (now - start) / 1000
  // The sweep: a band moving down the field, then a pause before the next one.
  const cycle = ((now - start) % SWEEP_MS) / SWEEP_MS
  const band = cycle < 0.6 ? (cycle / 0.6) * (height + 160) - 80 : -1e4

  ctx.clearRect(0, 0, width, height)
  for (const p of points) {
    const dx = p.x - pointer.x
    const dy = p.y - pointer.y
    const near = Math.max(0, 1 - Math.hypot(dx, dy) / 150)
    const lit = Math.max(0, 1 - Math.abs(p.y - band) / 70)
    const push = near * 6
    const d = Math.hypot(dx, dy) || 1
    const x = p.x + (dx / d) * push
    const y = p.y + (dy / d) * push

    if (p.kind === 0) {
      ctx.globalAlpha = Math.min(1, p.a + near * 0.5 + lit * 0.35)
      ctx.fillStyle = lit > 0.2 ? c.add : c.ink
      ctx.fillRect(x - 1, y - 1, 2, 2)
      continue
    }

    const twinkle = 0.5 + 0.5 * Math.sin(t * 1.3 + p.phase)
    ctx.globalAlpha = Math.min(1, 0.2 + twinkle * 0.5 + near * 0.5 + lit * 0.4)
    ctx.strokeStyle = p.kind === 1 ? c.add : c.del
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(x - 3.5, y)
    ctx.lineTo(x + 3.5, y)
    if (p.kind === 1) {
      ctx.moveTo(x, y - 3.5)
      ctx.lineTo(x, y + 3.5)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function loop(now: number) {
  raf = 0
  if (!visible || document.hidden) return
  draw(now)
  raf = requestAnimationFrame(loop)
}

function wake() {
  if (!raf && visible && !document.hidden) raf = requestAnimationFrame(loop)
}

function onPointer(e: PointerEvent) {
  const rect = canvas.value?.getBoundingClientRect()
  if (!rect) return
  pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onLeave() {
  pointer = { x: -1e4, y: -1e4 }
}

onMounted(() => {
  const el = canvas.value
  if (!el) return
  ctx = el.getContext('2d')
  start = performance.now()
  layout()

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    draw(start + SWEEP_MS * 0.9)
    resizeObserver = new ResizeObserver(() => {
      layout()
      draw(start + SWEEP_MS * 0.9)
    })
    resizeObserver.observe(el)
    return
  }

  resizeObserver = new ResizeObserver(layout)
  resizeObserver.observe(el)
  observer = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting)
    wake()
  })
  observer.observe(el)
  window.addEventListener('pointermove', onPointer, { passive: true })
  document.addEventListener('pointerleave', onLeave)
  document.addEventListener('visibilitychange', wake)
  wake()
})

onUnmounted(() => {
  if (raf) cancelAnimationFrame(raf)
  observer?.disconnect()
  resizeObserver?.disconnect()
  window.removeEventListener('pointermove', onPointer)
  document.removeEventListener('pointerleave', onLeave)
  document.removeEventListener('visibilitychange', wake)
})
</script>

<template>
  <canvas ref="canvas" class="hero-field" aria-hidden="true" />
</template>

<style scoped>
.hero-field {
  position: absolute;
  inset: 0 0 auto;
  z-index: 0;
  width: 100%;
  height: min(100vh, 920px);
  pointer-events: none;
  mask-image: radial-gradient(ellipse 80% 70% at 50% 35%, #000 30%, transparent 100%);
  animation: field-in 1.6s ease both;
}

@keyframes field-in {
  from { opacity: 0; }
}
</style>
