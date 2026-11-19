import { useCallback, useState } from 'react'

/**
 * Which sections of the Layers tab are open: "Key changes", the layers for
 * review, and "Other changes", the background ones. Key changes starts open
 * and Other changes folded — it is
 * how the change is done, for a reviewer who asked not to read how. One choice
 * for every review, kept in localStorage the way the rail's other switches
 * are; absent means never chosen.
 */
export type LayerSection = 'read' | 'background'

export type LayerSectionsOpen = Record<LayerSection, boolean>

const KEY = 'diffo:ui:layerSections'

const DEFAULT: LayerSectionsOpen = { read: true, background: false }

function load(): LayerSectionsOpen {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LayerSectionsOpen> | null
    return {
      read: typeof raw?.read === 'boolean' ? raw.read : DEFAULT.read,
      background: typeof raw?.background === 'boolean' ? raw.background : DEFAULT.background,
    }
  } catch {
    return DEFAULT
  }
}

function store(open: LayerSectionsOpen) {
  try {
    localStorage.setItem(KEY, JSON.stringify(open))
  } catch {
    // no storage: the choice lasts the session
  }
}

export function useLayerSections(): [LayerSectionsOpen, (section: LayerSection) => void] {
  const [open, setOpen] = useState<LayerSectionsOpen>(load)
  const toggle = useCallback((section: LayerSection) => {
    setOpen((prev) => {
      const next = { ...prev, [section]: !prev[section] }
      store(next)
      return next
    })
  }, [])
  return [open, toggle]
}
