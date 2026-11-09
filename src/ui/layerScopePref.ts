import { useCallback, useState } from 'react'

/**
 * How much of a layer's files the pane shows, narrowest first — the card's
 * "Show this layer changed lines | hunks | files": its hunks with the lines
 * the agent highlighted lit and the rest dimmed (`highlights`, the default),
 * its hunks plain (`parts`), or every hunk of each file it lists, other
 * layers' dimmed and tagged (`whole`). A view only: what a layer owns, and
 * what its Viewed marks, is the same under all three. One choice for the
 * whole review, kept in localStorage beside the reading-order pick; absent
 * means never chosen. The key is the one the two-way parts/whole switch used,
 * so a pick made with it carries over.
 */

export type LayerScopeKind = 'highlights' | 'parts' | 'whole'

const KEY = 'diffo:ui:layerSplit'

function loadLayerScope(): LayerScopeKind {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === 'whole' || stored === 'parts' ? stored : 'highlights'
  } catch {
    return 'highlights'
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
