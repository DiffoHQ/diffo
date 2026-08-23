import { Icon } from './Icon.js'

export function MarkBox({
  state = false,
}: {
  /** `'mixed'` is a folder with some of it read — no file row can have it, because
   * no gesture marks part of a file. */
  state?: boolean | 'mixed'
}) {
  return (
    <span
      className="markbox"
      data-state={state === 'mixed' ? 'mixed' : state ? 'on' : 'off'}
      aria-hidden="true"
    >
      {state === true && <Icon name="check" size="sm" />}
    </span>
  )
}
