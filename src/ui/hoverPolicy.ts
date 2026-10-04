/**
 * When the usages card opens and when it closes — the whole policy in one
 * place, with no DOM in it, so the rules can be read and tested as rules.
 *
 *   open   the pointer rests on one name for `showDelay`; moving within the
 *          name keeps the clock, moving to another name restarts it — a card
 *          never follows the pointer from word to word.
 *   stay   while the pointer is on that name or anywhere inside the card.
 *          Clicking and scrolling inside the card are the card's own business.
 *   close  the pointer has been off both for `leaveGrace` — long enough to
 *          cross into the card, over the neighbouring line and whatever names
 *          it holds — or the reviewer dismisses it: Escape, a click elsewhere,
 *          the page scrolling, the window losing focus, or picking a usage.
 *
 * Another name while a card is open is treated as leaving: the open card gets
 * its grace, and the new name its full delay. The two never race — if the
 * pointer settles on the new name, the old card is gone before the new opens.
 */
export interface HoverPolicyHooks<T> {
  show(target: T): void
  hide(): void
  same(a: T, b: T): boolean
}

export interface HoverPolicyTiming {
  showDelay: number
  leaveGrace: number
}

export const HOVER_TIMING: HoverPolicyTiming = { showDelay: 600, leaveGrace: 500 }

export class HoverPolicy<T> {
  private armed: T | null = null
  private shown: T | null = null
  private showTimer: ReturnType<typeof setTimeout> | undefined
  private hideTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly hooks: HoverPolicyHooks<T>,
    private readonly timing: HoverPolicyTiming = HOVER_TIMING,
  ) {}

  /** The pointer is on a hoverable name. */
  over(target: T): void {
    if (this.shown && this.hooks.same(target, this.shown)) {
      this.cancelHide()
      return
    }
    if (this.armed && this.hooks.same(target, this.armed)) return
    if (this.shown) this.leave()
    this.cancelShow()
    this.armed = target
    this.showTimer = setTimeout(() => {
      this.showTimer = undefined
      this.armed = null
      this.shown = target
      this.hooks.show(target)
    }, this.timing.showDelay)
  }

  /** The pointer is inside the card. */
  inCard(): void {
    this.cancelHide()
    this.cancelShow()
  }

  /** The pointer is on nothing of ours. */
  away(): void {
    this.cancelShow()
    this.leave()
  }

  /** Escape, a click elsewhere, the page scrolling, a usage picked. */
  dismiss(): void {
    this.cancelShow()
    this.cancelHide()
    this.close()
  }

  get isShown(): boolean {
    return this.shown !== null
  }

  /** Start the grace clock on the open card, once. */
  private leave(): void {
    if (!this.shown || this.hideTimer !== undefined) return
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined
      this.close()
    }, this.timing.leaveGrace)
  }

  private close(): void {
    if (!this.shown) return
    this.shown = null
    this.hooks.hide()
  }

  private cancelShow(): void {
    if (this.showTimer !== undefined) clearTimeout(this.showTimer)
    this.showTimer = undefined
    this.armed = null
  }

  private cancelHide(): void {
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer)
    this.hideTimer = undefined
  }
}
