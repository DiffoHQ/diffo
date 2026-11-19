import { useCallback, useState } from 'react'

/** The project's home: the Settings menu's "Star on GitHub" and the critter's star ask. */
export const GITHUB_URL = 'https://github.com/DiffoHQ/diffo'

/** Opens the repo in a new tab, with no handle back to this page. */
export function openGithub() {
  window.open(GITHUB_URL, '_blank', 'noopener,noreferrer')
}

/**
 * The one GitHub-star ask: the header critter asks for it (StarAsk.tsx) once the
 * Finish review dialog closes on a finished review, from the third finish on.
 * It waits to be answered. Following it ends it for good; ✕ snoozes it until
 * the tenth finish, and a second ✕ ends it (the rule lives in server/index.ts).
 *
 * The server holds both the finish count and the dismissal (see `starNudge` in
 * server/index.ts) since every repo's page lives on its own origin. `offer`
 * asks it after the finish has been counted, so the answer is never stale.
 */
export function useStarNudge(): {
  visible: boolean
  offer: () => void
  end: (answer: 'dismissed' | 'snoozed') => void
} {
  const [visible, setVisible] = useState(false)
  const offer = useCallback(() => {
    void fetch('/api/settings')
      .then((res) => (res.ok ? (res.json() as Promise<{ starNudge?: unknown }>) : null))
      .then((body) => {
        if (body?.starNudge === 'show') setVisible(true)
      })
      .catch(() => {})
  }, [])
  const end = useCallback((answer: 'dismissed' | 'snoozed') => {
    setVisible(false)
    void fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starNudge: answer }),
    }).catch(() => {})
  }, [])
  return { visible, offer, end }
}
