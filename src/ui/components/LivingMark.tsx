/*
 * The Diffo mark, alive.
 *
 * Same drawing as the `logo` symbol in Icon.tsx (24-unit viewBox, 1.7 stroke), drawn
 * inline rather than through the sprite because a `<use>` hides its paths from CSS,
 * and this one animates them. The mark is a diff — a removed line beside a −, a kept
 * line, an added line beside a + — and a change passes through it: the top line and
 * its − flush red and slide out to the right; the bottom line erases and rewrites
 * itself left to right in green while the +'s upright pops in; then a new top line
 * springs back in from the left and everything settles to ink.
 *
 * It loops, slowly, with a rest between plays: in the header it is the one thing on
 * the page that is quietly alive. Keyframes live in styles.css under "the living
 * mark"; `prefers-reduced-motion` leaves the still mark.
 */
export function LivingMark({
  size = 24,
  className,
  label,
}: {
  size?: number
  className?: string
  label?: string
}) {
  return (
    <svg
      className={className ? `icon living-mark ${className}` : 'icon living-mark'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      focusable="false"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <path className="lm-minus" d="M3.3 7.4h2.6" />
        <path className="lm-plus-h" d="M3.3 16.6h2.6" />
        <path className="lm-plus-v" d="M4.6 15.3v2.6" />
        <path className="lm-l1" d="M9.3 7.4H20.4" />
        <path d="M9.3 12h8" />
        <path className="lm-l3" d="M9.3 16.6h10.2" />
      </g>
    </svg>
  )
}
