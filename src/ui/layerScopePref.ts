import { useCallback, useState } from 'react'

/**
 * How much of a step's files the pane shows, narrowest first: only the
 * highlighted lines with two around each (`highlights`), the hunks the step's
 * ranges and highlights claim (`parts`, the default), or every file whole in
 * each step that lists it (`whole`) — which also stops a split file being
 * read, and marked, a part at a time. One choice for the whole review, kept
 * in localStorage beside the reading-order pick; absent means never chosen.
 * The key is the one the two-way parts/whole switch used, so a pick of the
 * whole file carries over.
 */

export type LayerScopeKind = 'highlights' | 'parts' | 'whole'

const KEY = 'diffo:ui:layerSplit'

function loadLayerScope(): LayerScopeKind {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === 'whole' || stored === 'highlights' ? stored : 'parts'
  } catch {
    return 'parts'
  }
}

function storeLayerScope(kind: LayerScopeKind) {
  try {
    localStorage.setItem(KEY, kind)
  } catch {
    // no storage: the choice lasts the session
  }
}

export function useLayerScope(): [LayerScopeKind, (kind: LayerScopeKind) => void] {
  const [kind, setKind] = useState<LayerScopeKind>(loadLayerScope)
  const pick = useCallback((next: LayerScopeKind) => {
    storeLayerScope(next)
    setKind(next)
  }, [])
  return [kind, pick]
}
