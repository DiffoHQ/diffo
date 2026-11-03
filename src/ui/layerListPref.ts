import { useCallback, useState } from 'react'
import type { FileChange } from '../shared/types.js'
import { treeOrder } from './components/Nav.js'
import type { ResolvedLayer } from './layers.js'

/**
 * The order the reading pane walks a layer's files in: the agent's, as it
 * outlined the step, or the folder tree's, the way the Files tab reads. The
 * rail shows the tree either way; this only moves the pane, J/K and "next
 * unread", and the layer card is where it is switched. Order is the default —
 * a layer is a step, and a step has a first file. One choice for the whole
 * review, kept in localStorage the way the rail's other switches are
 * (`diffo:ui:hideTests` and kin): absent means never chosen.
 */

export type LayerListKind = 'order' | 'tree'

const KEY = 'diffo:ui:layerList'

function loadLayerList(): LayerListKind {
  try {
    return localStorage.getItem(KEY) === 'tree' ? 'tree' : 'order'
  } catch {
    return 'order'
  }
}

function storeLayerList(kind: LayerListKind) {
  try {
    localStorage.setItem(KEY, kind)
  } catch {
    // no storage: the choice lasts the session
  }
}

/** A layer's files in the picked order. `order` is `layer.files` as posted;
 * `tree` is the rail's tree flattened, the order the Files tab reads in. */
export function layerReadOrder(layer: ResolvedLayer, kind: LayerListKind): FileChange[] {
  const files = layer.files.map((f) => f.file)
  return kind === 'tree' ? treeOrder(files) : files
}

export function useLayerList(): [LayerListKind, (kind: LayerListKind) => void] {
  const [kind, setKind] = useState<LayerListKind>(loadLayerList)
  const pick = useCallback((next: LayerListKind) => {
    storeLayerList(next)
    setKind(next)
  }, [])
  return [kind, pick]
}
