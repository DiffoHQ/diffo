import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  AGENT_PICKS_SET,
  CUSTOM_SETS_MAX,
  type ReviewerRole,
  type ReviewerSet,
  SET_NAME_MAX,
  SET_WHEN_MAX,
} from '../../shared/roles.js'
import { type ReviewerRoles, reviewerApi } from '../api.js'
import { Confirm } from './Confirm.js'
import { Icon } from './Icon.js'
import { Menu, MenuItem } from './Menu.js'

type SetDraft = Pick<ReviewerSet, 'name' | 'when' | 'roles'>

/** What the tab shows on the right. */
type Shown = { kind: 'agent' } | { kind: 'set'; id: string } | { kind: 'new'; from?: SetDraft }

const EMPTY: SetDraft = { name: '', when: '', roles: [] }

/**
 * The Sets tab of the Reviewer agents page: the sets of agents the Add
 * reviewer picker offers, and which one it opens on. Laid out like the Agents
 * tab beside it: the list on the left, the one picked on the right.
 *
 * A set is a name, a line on the kind of change it is for, and a few agents.
 * The built-ins are fixed; a copy is the way to change one. The reviewer's
 * own are written here, by hand: three fields need no agent.
 *
 * The first row is not a set. "Let the agent choose" is a default: the author
 * agent says which set fits each change when it opens the review, and the
 * picker opens on that one. Any set can be the default in its place.
 */
export function ReviewerSets({
  data,
  onAdd,
}: {
  data: ReviewerRoles
  /** Open the Add dialog on a set. Absent where reviewer agents cannot join. */
  onAdd?: (roles: readonly string[]) => void
}) {
  const client = useQueryClient()
  const [pick, setPick] = useState<Shown | null>(null)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ReviewerSet | null>(null)

  const { roles, sets, defaultSet } = data
  const mine = sets.filter((s) => !s.builtIn)
  const followsAgent = defaultSet === AGENT_PICKS_SET
  // Nothing picked yet: whatever the picker opens on.
  const shown: Shown = pick ?? (followsAgent ? { kind: 'agent' } : { kind: 'set', id: defaultSet })
  const viewed = shown.kind === 'set' ? sets.find((s) => s.id === shown.id) : undefined
  const show = (next: Shown | null) => {
    setEditing(false)
    setError(null)
    setPick(next)
  }
  const nameOf = (id: string) => roles.find((r) => r.id === id)?.name ?? id

  /** Replace the reviewer's own sets. Null when the save was refused. */
  const put = async (next: Array<SetDraft & { id?: string }>): Promise<ReviewerRoles | null> => {
    setError(null)
    try {
      const saved = await reviewerApi.saveSets(next)
      client.setQueryData<ReviewerRoles>(['reviewer-roles'], saved)
      return saved
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }
  const saveNew = async (draft: SetDraft): Promise<boolean> => {
    const saved = await put([...mine, draft])
    if (!saved) return false
    // The server named it: it is the last of the reviewer's own.
    const made = saved.sets.filter((s) => !s.builtIn).at(-1)
    show(made ? { kind: 'set', id: made.id } : null)
    return true
  }
  const saveEdit = async (id: string, draft: SetDraft): Promise<boolean> => {
    const saved = await put(mine.map((s) => (s.id === id ? { ...s, ...draft } : s)))
    if (saved) setEditing(false)
    return saved !== null
  }
  const remove = async (id: string) => {
    if (!(await put(mine.filter((s) => s.id !== id)))) throw new Error('refused')
    show(null)
  }
  const makeDefault = (id: string) => {
    setError(null)
    reviewerApi
      .setDefaultSet(id)
      .then((saved) => client.setQueryData<ReviewerRoles>(['reviewer-roles'], saved))
      .catch((err: Error) => setError(err.message))
  }

  const defaultButton = (id: string) =>
    defaultSet === id ? null : (
      <button
        type="button"
        className="btn btn-sm"
        title="Add reviewer opens with this ticked"
        onClick={() => makeDefault(id)}
      >
        Make default
      </button>
    )
  const row = (set: ReviewerSet) => (
    <button
      key={set.id}
      type="button"
      className="lp-row"
      aria-current={(shown.kind === 'set' && shown.id === set.id) || undefined}
      onClick={() => show({ kind: 'set', id: set.id })}
    >
      <span className="lp-row-name">
        {set.name}
        {defaultSet === set.id && <span className="lp-row-state">Default</span>}
      </span>
      <span className="lp-row-sub">{set.roles.map(nameOf).join(', ')}</span>
    </button>
  )

  return (
    <div className="lp-grid">
      <nav className="lp-side" aria-label="Sets">
        <div className="lp-cap">Add reviewer opens on</div>
        <div className="lp-group">
          <button
            type="button"
            className="lp-row"
            aria-current={shown.kind === 'agent' || undefined}
            onClick={() => show({ kind: 'agent' })}
          >
            <span className="lp-row-name">
              Let the agent choose
              {followsAgent && <span className="lp-row-state">Default</span>}
            </span>
            <span className="lp-row-sub">The set that fits each change</span>
          </button>
        </div>
        <div className="lp-cap">Sets</div>
        <div className="lp-group">
          {sets.map(row)}
          <button
            type="button"
            className="lp-row lp-row-new"
            aria-current={shown.kind === 'new' || undefined}
            disabled={mine.length >= CUSTOM_SETS_MAX}
            title={
              mine.length >= CUSTOM_SETS_MAX ? `Up to ${CUSTOM_SETS_MAX} of your own` : undefined
            }
            onClick={() => show({ kind: 'new' })}
          >
            <Icon name="plus" size="sm" />
            <span className="lp-row-name">New set</span>
          </button>
        </div>
      </nav>
      <div className="lp-detail">
        {shown.kind === 'agent' && (
          <>
            <header className="lp-dhead">
              <div className="lp-dhead-row">
                <h3 className="lp-title">Let the agent choose</h3>
                {followsAgent && (
                  <span className="lp-dhead-tags">
                    <span className="lp-row-state">Default</span>
                  </span>
                )}
                <span className="lp-dhead-acts">{defaultButton(AGENT_PICKS_SET)}</span>
              </div>
              <p className="lp-dsub">Your agent says which set fits the change it wrote.</p>
            </header>
            <div className="lp-card">
              <dl className="lp-facts">
                <div className="lp-fact">
                  <dt className="lp-fact-cap">How it works</dt>
                  <dd className="lp-fact-body">
                    <p className="lp-fro">
                      When a review opens, your agent reads each set's "when to use it" line and
                      names the one that fits. Add reviewer then opens with that set's agents ticked
                      and the agent's reason beside them. Nothing starts until you say so.
                    </p>
                  </dd>
                </div>
                <div className="lp-fact">
                  <dt className="lp-fact-cap">Until it has picked</dt>
                  <dd className="lp-fact-body">
                    <p className="lp-fro">Add reviewer opens on General alone.</p>
                  </dd>
                </div>
              </dl>
            </div>
          </>
        )}
        {viewed && (
          <>
            <header className="lp-dhead">
              <div className="lp-dhead-row">
                <h3 className="lp-title">{viewed.name}</h3>
                <span className="lp-dhead-tags">
                  {defaultSet === viewed.id && <span className="lp-row-state">Default</span>}
                  {viewed.builtIn && <span className="lp-row-state">Built in</span>}
                </span>
                <span className="lp-dhead-acts">
                  {onAdd && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      title="Open Add reviewer with these agents ticked"
                      onClick={() => onAdd(viewed.roles)}
                    >
                      Add to review
                    </button>
                  )}
                  {defaultButton(viewed.id)}
                  {!viewed.builtIn && !editing && (
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                      Edit
                    </button>
                  )}
                  <Menu label="Set options">
                    {(close) =>
                      viewed.builtIn ? (
                        <MenuItem
                          title="A copy under your own sets, yours to change"
                          onClick={() => {
                            close()
                            show({
                              kind: 'new',
                              from: {
                                name: `${viewed.name} (mine)`.slice(0, SET_NAME_MAX),
                                when: viewed.when,
                                roles: viewed.roles,
                              },
                            })
                          }}
                        >
                          Make a copy to edit
                        </MenuItem>
                      ) : (
                        <MenuItem
                          danger
                          onClick={() => {
                            close()
                            setDeleting(viewed)
                          }}
                        >
                          Delete
                        </MenuItem>
                      )
                    }
                  </Menu>
                </span>
              </div>
            </header>
            <div className="lp-card">
              {editing && !viewed.builtIn ? (
                <SetEditor
                  key={viewed.id}
                  initial={viewed}
                  roles={roles}
                  active={data.active}
                  onSave={(draft) => saveEdit(viewed.id, draft)}
                  onCancel={() => setEditing(false)}
                />
              ) : (
                <dl className="lp-facts">
                  {viewed.when && (
                    <div className="lp-fact">
                      <dt className="lp-fact-cap">When to use it</dt>
                      <dd className="lp-fact-body">
                        <p className="lp-fro">{viewed.when}</p>
                      </dd>
                    </div>
                  )}
                  <div className="lp-fact">
                    <dt className="lp-fact-cap">Agents in this set</dt>
                    <dd className="lp-fact-body">
                      <ul className="rs-list">
                        {viewed.roles.map((id) => {
                          const role = roles.find((r) => r.id === id)
                          return (
                            <li key={id} className="rs-item">
                              <span className="rs-name">{role?.name ?? id}</span>
                              <span className="rs-blurb">{role?.blurb}</span>
                            </li>
                          )
                        })}
                      </ul>
                    </dd>
                  </div>
                </dl>
              )}
            </div>
          </>
        )}
        {shown.kind === 'new' && (
          <>
            <header className="lp-dhead">
              <div className="lp-dhead-row">
                <h3 className="lp-title">New set</h3>
              </div>
              <p className="lp-dsub">
                {shown.from
                  ? 'A copy of a built-in, yours to change.'
                  : 'The agents you start together for one kind of change.'}
              </p>
            </header>
            <div className="lp-card">
              <SetEditor
                key={shown.from?.name ?? 'new'}
                initial={shown.from ?? EMPTY}
                roles={roles}
                active={data.active}
                fresh
                onSave={saveNew}
                onCancel={() => show(null)}
              />
            </div>
          </>
        )}
        {error && (
          <div className="warn">
            <Icon name="alert" size="sm" />
            <div>{error}</div>
          </div>
        )}
      </div>
      {deleting && (
        <Confirm
          title="Delete set"
          action="Delete set"
          onConfirm={() => remove(deleting.id)}
          onClose={() => setDeleting(null)}
        >
          Deletes “{deleting.name}”. Its agents stay. This can’t be undone.
        </Confirm>
      )}
    </div>
  )
}

/** A set as a form: its name, the kind of change it is for, and its agents. */
function SetEditor({
  initial,
  roles,
  active,
  fresh = false,
  onSave,
  onCancel,
}: {
  initial: SetDraft
  roles: readonly ReviewerRole[]
  /** The roles in the picker: listed first, the library after. */
  active: readonly string[]
  /** Nothing is saved yet. */
  fresh?: boolean
  onSave: (draft: SetDraft) => Promise<boolean>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [when, setWhen] = useState(initial.when)
  const [picked, setPicked] = useState<readonly string[]>(initial.roles)
  const [saving, setSaving] = useState(false)
  const toggle = (id: string) =>
    setPicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]))
  const ready = name.trim() !== '' && picked.length > 0
  const dirty =
    name !== initial.name || when !== initial.when || picked.join() !== initial.roles.join()
  const listed = [
    ...roles.filter((r) => active.includes(r.id)),
    ...roles.filter((r) => !active.includes(r.id)),
  ]
  const submit = async () => {
    if (!ready || saving) return
    setSaving(true)
    // In the order the agents are listed, not the order they were ticked.
    const ordered = listed.filter((r) => picked.includes(r.id)).map((r) => r.id)
    await onSave({ name: name.trim(), when: when.trim(), roles: ordered })
    setSaving(false)
  }
  return (
    <>
      <div className="lp-group lp-fields">
        <div className="lp-frow">
          <label className="lp-flabel" htmlFor="rs-f-name">
            Name
          </label>
          <input
            id="rs-f-name"
            className="lp-fin"
            value={name}
            maxLength={SET_NAME_MAX}
            placeholder="Auth changes"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="lp-frow">
          <label className="lp-flabel" htmlFor="rs-f-when">
            When to use it
          </label>
          <input
            id="rs-f-when"
            className="lp-fin"
            value={when}
            maxLength={SET_WHEN_MAX}
            placeholder="Anything that touches login, sessions or permissions."
            onChange={(e) => setWhen(e.target.value)}
          />
        </div>
        <fieldset className="lp-frow rs-pick">
          <legend className="lp-flabel">
            Agents <span className="rs-count">{`${picked.length} picked`}</span>
          </legend>
          <ul className="rv-roles">
            {listed.map((role) => {
              const on = picked.includes(role.id)
              return (
                <li key={role.id} className="rv-role">
                  <label className="rv-role-pick">
                    <input type="checkbox" checked={on} onChange={() => toggle(role.id)} />
                    <span className="rv-role-name">{role.name}</span>
                    <span className="rv-role-blurb" title={role.blurb}>
                      {role.blurb}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>
      </div>
      <div className="lp-savebar">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!ready || saving || (!fresh && !dirty)}
          title={ready ? undefined : 'A set needs a name and at least one agent'}
          onClick={() => void submit()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  )
}
