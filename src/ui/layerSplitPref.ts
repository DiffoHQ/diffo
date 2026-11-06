import { useCallback, useState } from 'react'

/**
 * Whether a file the agent split across steps reads as parts, or whole. On
 * (`parts`, the default) a step shows only the hunks its range names and
 * folds the rest; off (`whole`) the ranges are ignored at the resolver and
 * the file is a whole file in every step that lists it, the way a file in
 * two layers always was. One choice for the whole review, kept in
 * localStorage beside the reading-order pick; absent means never chosen.
 */

export type LayerSplitKind = 'parts' | 'whole'

const KEY = 'diffo:ui:layerSplit'

function loadLayerSplit(): LayerSplitKind {
  try {
    return localStorage.getItem(KEY) === 'whole' ? 'whole' : 'parts'
  } catch {
    return 'parts'
  }
}

function storeLayerSplit(kind: LayerSplitKind) {
  try {
    localStorage.setItem(KEY, kind)
  } catch {
    // no storage: the choice lasts the session
  }
}

export function useLayerSplit(): [LayerSplitKind, (kind: LayerSplitKind) => void] {
  const [kind, setKind] = useState<LayerSplitKind>(loadLayerSplit)
  const pick = useCallback((next: LayerSplitKind) => {
    storeLayerSplit(next)
    setKind(next)
  }, [])
  return [kind, pick]
}
