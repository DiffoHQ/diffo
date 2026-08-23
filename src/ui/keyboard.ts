export type ReviewAction =
  | 'next-hunk'
  | 'prev-hunk'
  | 'next-file'
  | 'prev-file'
  | 'toggle-viewed'
  | 'toggle-view-mode'
  | 'toggle-nav'
  | 'focus-search'
  | 'comment'
  | 'next-unreviewed'
  | 'toggle-fold'
  | 'hide-reviewed'
  | 'shortcuts'

export function actionForKey(key: string, shift: boolean): ReviewAction | null {
  if (key === 'j') return 'next-hunk'
  if (key === 'k') return 'prev-hunk'
  if (key === 'J' || (shift && key === 'j')) return 'next-file'
  if (key === 'K' || (shift && key === 'k')) return 'prev-file'
  if (key === 'v') return 'toggle-viewed'
  if (key === 'u') return 'toggle-view-mode'
  if (key === 'b') return 'toggle-nav'
  if (key === '/') return 'focus-search'
  if (key === 'c') return 'comment'
  if (key === 'n') return 'next-unreviewed'
  if (key === 'o') return 'toggle-fold'
  if (key === 'h') return 'hide-reviewed'
  if (key === '?') return 'shortcuts'
  return null
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}
