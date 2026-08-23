/**
 * The icon set — one inline `<symbol>` sprite mounted once, plus an `<Icon>` that
 * references it.
 *
 * No emoji anywhere in the UI: an emoji can't be sized or coloured, so it never
 * matched the text beside it or dimmed with a muted row. These are strokes in
 * `currentColor`.
 *
 * Geometry: a 16-unit viewBox drawn at 15px (13px `sm`), 1.4–1.6 stroke, no fills
 * except where a dot is the shape. `logo` is the one exception — drawn on 24, since
 * it is the product mark rather than a UI icon.
 */

export type IconName =
  | 'logo'
  | 'chev'
  | 'check'
  | 'chat'
  | 'plus'
  | 'more'
  | 'copy'
  | 'up'
  | 'down'
  | 'unfold'
  | 'x'
  | 'unified'
  | 'split'
  | 'fold'
  | 'send'
  | 'note'
  | 'alert'
  | 'keys'
  | 'next'
  | 'gear'
  | 'sparkle'
  | 'search'
  | 'cmp'
  | 'arrow'
  | 'book'
  | 'edit'
  | 'bold'
  | 'italic'
  | 'code'
  | 'link'
  | 'list'
  | 'quote'
  | 'at'
  | 'attach'
  | 'user'
  | 'sidebar'
  | 'sun'
  | 'moon'
  | 'display'
  | 'branch'
  | 'worktree'
  | 'trash'
  | 'folder'
  | 'filter'
  | 'eye-off'
  | 'diff-add'
  | 'diff-del'
  | 'diff-mod'
  | 'undo'
  | 'bell'

export type IconSize = 'xs' | 'sm' | 'md' | 'lg'

const PX: Record<IconSize, number> = { xs: 11, sm: 13, md: 15, lg: 20 }

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <symbol id="i-logo" viewBox="0 0 24 24">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9.3 7.4H20.4M9.3 12h8M9.3 16.6h10.2" />
          <path d="M3.3 7.4h2.6" />
          <path d="M3.3 16.6h2.6M4.6 15.3v2.6" />
        </g>
      </symbol>
      <symbol id="i-sidebar" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M6.2 3v10" />
        </g>
      </symbol>
      <symbol id="i-branch" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="4.5" cy="3.5" r="1.75" />
          <circle cx="4.5" cy="12.5" r="1.75" />
          <circle cx="11.5" cy="5" r="1.75" />
          <path d="M4.5 5.25v5.5M11.5 6.75c0 2.5-2 3.4-4.2 3.9" />
        </g>
      </symbol>
      <symbol id="i-worktree" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <rect x="2" y="4.5" width="8" height="8" rx="1.3" />
          <path d="M5.2 2.2h7.1c.8 0 1.4.6 1.4 1.4v7.1" />
        </g>
      </symbol>
      <symbol id="i-check" viewBox="0 0 16 16">
        <path
          d="M3.2 8.6l3.1 3.1 6.5-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-chev" viewBox="0 0 16 16">
        <path
          d="M4 6.2l4 4 4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-search" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="7" cy="7" r="4.2" />
          <path d="M10.2 10.2l3.3 3.3" />
        </g>
      </symbol>
      <symbol id="i-chat" viewBox="0 0 16 16">
        <path
          d="M13.5 8.4c0 2.4-2.5 4.3-5.5 4.3-.7 0-1.4-.1-2-.3l-3 1.2.9-2.5A4.3 4.3 0 012.5 8.4C2.5 6 5 4.1 8 4.1s5.5 1.9 5.5 4.3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-plus" viewBox="0 0 16 16">
        <path
          d="M8 3.5v9M3.5 8h9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </symbol>
      <symbol id="i-more" viewBox="0 0 16 16">
        <g fill="currentColor">
          <circle cx="3.4" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.6" cy="8" r="1.3" />
        </g>
      </symbol>
      <symbol id="i-copy" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" />
          <path d="M10.8 5.5v-1a1.6 1.6 0 00-1.6-1.6H4.1a1.6 1.6 0 00-1.6 1.6v5.1a1.6 1.6 0 001.6 1.6h1" />
        </g>
      </symbol>
      <symbol id="i-up" viewBox="0 0 16 16">
        <path
          d="M8 12.5v-9M4.2 7.3L8 3.5l3.8 3.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-down" viewBox="0 0 16 16">
        <path
          d="M8 3.5v9M4.2 8.7L8 12.5l3.8-3.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-unfold" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3.2 8h9.6" />
          <path d="M8 5.5V1.4M6.2 3.2L8 1.4l1.8 1.8" />
          <path d="M8 10.5v4.1M6.2 12.8L8 14.6l1.8-1.8" />
        </g>
      </symbol>
      <symbol id="i-x" viewBox="0 0 16 16">
        <path
          d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </symbol>
      <symbol id="i-unified" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />
        </g>
      </symbol>
      <symbol id="i-split" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2.2" y="3" width="11.6" height="10" rx="1.8" />
          <path d="M8 3v10" />
        </g>
      </symbol>
      <symbol id="i-fold" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 6.2L8 3.4l3 2.8M11 9.8L8 12.6 5 9.8" />
        </g>
      </symbol>
      <symbol id="i-send" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M14 2L7 9M14 2l-4.4 12-2.6-5L2 8.4z" />
        </g>
      </symbol>
      <symbol id="i-note" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9.5 2.6H4a1.5 1.5 0 00-1.5 1.5v8A1.5 1.5 0 004 13.6h8a1.5 1.5 0 001.5-1.5V6.6" />
          <path d="M11 2l3 3-4.5 4.5-3 .5.5-3z" />
        </g>
      </symbol>
      <symbol id="i-alert" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 2.9l5.5 9.6H2.5z" />
          <path d="M8 6.4v3M8 11.2h.01" />
        </g>
      </symbol>
      <symbol id="i-keys" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <rect x="1.5" y="4.2" width="13" height="7.6" rx="1.8" />
          <path d="M4 6.6h.01M6.4 6.6h.01M8.8 6.6h.01M11.2 6.6h.01M4 9.4h6.5" />
        </g>
      </symbol>
      <symbol id="i-next" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 8h8M7.5 4.5L11 8l-3.5 3.5M13.5 3.5v9" />
        </g>
      </symbol>
      <symbol id="i-gear" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <circle cx="8" cy="8" r="2.1" />
          <path d="M8 1.8l.8 1.6 1.8-.5.5 1.8 1.6.8-1 1.5 1 1.5-1.6.8-.5 1.8-1.8-.5L8 14.2l-.8-1.6-1.8.5-.5-1.8-1.6-.8 1-1.5-1-1.5 1.6-.8.5-1.8 1.8.5z" />
        </g>
      </symbol>
      <symbol id="i-arrow" viewBox="0 0 16 16">
        <path
          d="M3.5 8h9M9 4.5L12.5 8 9 11.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-cmp" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="4" cy="3.6" r="1.7" />
          <circle cx="4" cy="12.4" r="1.7" />
          <path d="M4 5.3v5.4" />
          <circle cx="12" cy="12.4" r="1.7" />
          <path d="M12 10.7V6.6a2 2 0 00-2-2H6.5M8.2 2.8L6.3 4.6l1.9 1.8" />
        </g>
      </symbol>
      <symbol id="i-sparkle" viewBox="0 0 16 16">
        <path
          d="M8 1.8l1.3 3.4 3.4 1.3-3.4 1.3L8 11.2 6.7 7.8 3.3 6.5l3.4-1.3zM12.4 10.6l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-attach" viewBox="0 0 16 16">
        <path
          d="M8.5 4.2L4.8 7.9a2.3 2.3 0 003.3 3.3l4.2-4.2a3.4 3.4 0 00-4.8-4.8L3 6.7a4.5 4.5 0 006.4 6.4l2.4-2.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </symbol>
      <symbol id="i-book" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <path d="M2.5 3.2c1.8-.8 3.7-.8 5.5.4 1.8-1.2 3.7-1.2 5.5-.4v9c-1.8-.8-3.7-.8-5.5.4-1.8-1.2-3.7-1.2-5.5-.4z" />
          <path d="M8 3.6v9" />
        </g>
      </symbol>
      <symbol id="i-edit" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M11.4 1.9l2.7 2.7-8 8-3.4.7.7-3.4z" />
          <path d="M9.6 3.7l2.7 2.7" />
        </g>
      </symbol>
      <symbol id="i-bold" viewBox="0 0 16 16">
        <path
          d="M4.5 2.8h4a2.6 2.6 0 010 5.2h-4zM4.5 8h4.6a2.6 2.6 0 010 5.2H4.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-italic" viewBox="0 0 16 16">
        <path
          d="M6.5 2.8h5M4.5 13.2h5M9.5 2.8l-3 10.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </symbol>
      <symbol id="i-code" viewBox="0 0 16 16">
        <path
          d="M5.8 4.5L2.5 8l3.3 3.5M10.2 4.5L13.5 8l-3.3 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-link" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M6.6 9.4a2.6 2.6 0 010-3.7l1.8-1.8a2.6 2.6 0 013.7 3.7l-.9.9" />
          <path d="M9.4 6.6a2.6 2.6 0 010 3.7l-1.8 1.8a2.6 2.6 0 01-3.7-3.7l.9-.9" />
        </g>
      </symbol>
      <symbol id="i-list" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M6 4h8M6 8h8M6 12h8" />
          <circle cx="2.8" cy="4" r=".9" fill="currentColor" stroke="none" />
          <circle cx="2.8" cy="8" r=".9" fill="currentColor" stroke="none" />
          <circle cx="2.8" cy="12" r=".9" fill="currentColor" stroke="none" />
        </g>
      </symbol>
      <symbol id="i-quote" viewBox="0 0 16 16">
        <path
          d="M3 4.5v7M6.5 5.5h7M6.5 8h7M6.5 10.5h4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </symbol>
      <symbol id="i-user" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="5.6" r="2.6" />
          <path d="M3 13.2a5 5 0 0110 0" />
        </g>
      </symbol>
      <symbol id="i-sun" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="8" r="2.7" />
          <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
        </g>
      </symbol>
      <symbol id="i-moon" viewBox="0 0 16 16">
        <path
          d="M13.2 9.7A5.6 5.6 0 016.3 2.8a5.6 5.6 0 106.9 6.9z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-display" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2" y="2.8" width="12" height="8.4" rx="1.5" />
          <path d="M6 13.8h4M8 11.2v2.6" />
        </g>
      </symbol>
      <symbol id="i-trash" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 4.3h11" />
          <path d="M6.2 4.3V3.1a1.1 1.1 0 011.1-1.1h1.4a1.1 1.1 0 011.1 1.1v1.2" />
          <path d="M3.9 4.3l.6 8.3a1.5 1.5 0 001.5 1.4h4a1.5 1.5 0 001.5-1.4l.6-8.3" />
          <path d="M6.6 7v4.2M9.4 7v4.2" />
        </g>
      </symbol>
      <symbol id="i-folder" viewBox="0 0 16 16">
        <path
          d="M1.8 4.1a1.4 1.4 0 011.4-1.4h2.9l1.6 1.7h5.1a1.4 1.4 0 011.4 1.4v6.1a1.4 1.4 0 01-1.4 1.4H3.2a1.4 1.4 0 01-1.4-1.4z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-eye-off" viewBox="0 0 16 16">
        <path
          d="M6.3 3.3a6.6 6.6 0 0 1 1.7-.2c3.4 0 6 3 6.5 4.9-.2.7-.9 1.9-2.1 2.9M9.9 12.7a6.6 6.6 0 0 1-1.9.2c-3.4 0-6-3-6.5-4.9.2-.9 1.3-2.5 3-3.6M6.6 6.6a2 2 0 1 0 2.8 2.8M2 14 14 2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="i-filter" viewBox="0 0 16 16">
        <path
          d="M2.5 4.5h11M4.7 8h6.6M7 11.5h2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </symbol>
      <symbol id="i-diff-add" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.4" />
          <path d="M8 5.4v5.2M5.4 8h5.2" />
        </g>
      </symbol>
      <symbol id="i-diff-del" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.4" />
          <path d="M5.4 8h5.2" />
        </g>
      </symbol>
      <symbol id="i-diff-mod" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.4" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
        </g>
      </symbol>
      <symbol id="i-undo" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.4 3.6v3.8h3.8" />
          <path d="M3.4 10.3a5.2 5.2 0 101.1-5.5L2.4 7.4" />
        </g>
      </symbol>
      <symbol id="i-bell" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12.7 10.9H3.3c.9-.8 1.4-1.6 1.4-3.5C4.7 5.2 6 3.4 8 3.4s3.3 1.8 3.3 4c0 1.9.5 2.7 1.4 3.5z" />
          <path d="M6.7 13a1.4 1.4 0 002.6 0" />
        </g>
      </symbol>
      <symbol id="i-at" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="8" r="2.3" />
          <path d="M10.3 5.7v3.1a1.9 1.9 0 003.1 1.4A6 6 0 108.6 14" />
        </g>
      </symbol>
    </svg>
  )
}

export function Icon({
  name,
  size = 'md',
  className,
  label,
}: {
  name: IconName
  size?: IconSize
  className?: string
  label?: string
}) {
  const px = PX[size]
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={px}
      height={px}
      focusable="false"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      data-icon={name}
    >
      <use href={`#i-${name}`} />
    </svg>
  )
}
