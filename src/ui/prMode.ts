import { createContext, useContext } from 'react'
import type { PrInfo } from '../shared/types.js'

/**
 * The pull request under review, when there is one. A context rather than a
 * prop: every composer and every thread card asks the same question — is there
 * a public side to this review? — and threading a flag through the hunk card,
 * the file body and the changeset strip would touch every layer for one bit.
 * Null is the ordinary local review, and every consumer must read as before.
 */
export const PrContext = createContext<PrInfo | null>(null)

export function usePr(): PrInfo | null {
  return useContext(PrContext)
}
