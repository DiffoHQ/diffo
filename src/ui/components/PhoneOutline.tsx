import { Icon } from './Icon.js'

export interface PhoneOutlineStep {
  /** 1-based; null on the trailing "not in any layer" step. */
  number: number | null
  title: string
  files: number
  /** Files of this step marked reviewed. */
  done: number
}

/**
 * The phone's home when the change has layers: the steps of the outline as a
 * list to start from, each with how much of it is read. Without layers the
 * home is the file list, which the reading pane already is on a phone.
 */
export function PhoneOutline({
  steps,
  onPick,
}: {
  steps: PhoneOutlineStep[]
  onPick: (index: number) => void
}) {
  if (steps.length === 0) return null
  return (
    <section className="phone-outline" aria-label="Steps">
      <h2 className="phone-outline-head">Steps</h2>
      <ol className="phone-outline-list">
        {steps.map((step, i) => {
          const read = step.files > 0 && step.done === step.files
          const left = step.files - step.done
          return (
            <li key={`${step.number ?? 'rest'}-${step.title}`}>
              <button type="button" className="phone-outline-step" onClick={() => onPick(i)}>
                <span className={`phone-outline-n${read ? ' phone-outline-n-read' : ''}`}>
                  {read ? <Icon name="check" size="sm" /> : (step.number ?? '·')}
                </span>
                <span className="phone-outline-text">
                  <span className="phone-outline-title">{step.title}</span>
                  <span className="phone-outline-meta">
                    {step.files} {step.files === 1 ? 'file' : 'files'}
                    {read ? ' · read' : step.done > 0 ? ` · ${left} left` : ''}
                  </span>
                </span>
                <Icon name="chev" size="md" />
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
