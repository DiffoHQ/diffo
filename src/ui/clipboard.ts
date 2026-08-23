/**
 * Copy, with a fallback for contexts where the async clipboard is missing or denied
 * (permission policy, a non-secure origin, an embedded browser).
 *
 * Returns whether the text actually made it. Callers that show a "Copied"
 * confirmation must honour it: a copy that silently failed strands the reviewer.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // execCommand still works under user activation in most engines.
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
