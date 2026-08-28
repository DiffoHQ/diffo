import { Modal } from './Modal.js'

const GROUPS: { name: string; keys: [string, string][] }[] = [
  {
    name: 'Move',
    keys: [
      ['j', 'Next hunk'],
      ['k', 'Previous hunk'],
      ['J', 'Next file'],
      ['K', 'Previous file'],
      ['n', 'Next unreviewed file'],
      ['/', 'Filter files'],
    ],
  },
  {
    name: 'Read',
    keys: [
      ['v', 'Mark this file reviewed'],
      ['h', 'Hide reviewed files'],
      ['u', 'Unified / split'],
      ['o', 'Collapse / expand file'],
      ['b', 'Show / hide the file list'],
    ],
  },
  {
    name: 'Comment',
    keys: [
      ['c', 'Comment on this hunk'],
      ['drag ↓', 'Comment on a range of lines'],
      ['⇧ click', 'Move the range’s edge to a line'],
      ['⌘↵', 'Add the comment'],
      ['esc', 'Close / cancel'],
      ['?', 'This sheet'],
    ],
  },
]

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Shortcuts" onClose={onClose}>
      <div className="keys">
        {GROUPS.map((group) => (
          <div key={group.name} className="keys-group">
            <div className="keys-name">{group.name}</div>
            {group.keys.map(([key, what]) => (
              <div key={key} className="keys-row">
                <span className="kbd">{key}</span> {what}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  )
}
