import { createContext, useContext, useEffect, useState } from 'react'

/**
 * The phone layout: below this width the review stops being a desktop page
 * squeezed onto a small screen and becomes its own shape — one column of code,
 * a bar at the thumb, sheets instead of side panels. Width, not touch: a tablet
 * is wide enough for the desktop layout, and a narrow desktop window docked
 * beside a terminal is not a phone.
 */
export const PHONE_QUERY = '(max-width: 640px)'

const matches = () =>
  typeof window !== 'undefined' && (window.matchMedia?.(PHONE_QUERY).matches ?? false)

/** Follows the query live — turning a phone sideways can cross it. Read once,
 * at the top of the app; everything below asks the context. */
export function usePhoneQuery(): boolean {
  const [phone, setPhone] = useState(matches)
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_QUERY)
    if (!media) return
    const update = () => setPhone(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return phone
}

export const PhoneContext = createContext(false)

/** Is the review in its phone layout? */
export function useIsPhone(): boolean {
  return useContext(PhoneContext)
}
