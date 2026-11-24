import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  CUSTOM_ROLES_MAX,
  type ReviewerRole,
  ROLE_BLURB_MAX,
  ROLE_FOCUS_MAX,
  ROLE_MESSAGE_MAX,
  ROLE_NAME_MAX,
  type RoleChange,
  type RoleDraft,
  roleIdFor,
} from '../../shared/roles.js'
import { type ReviewerRoles, reviewerApi, useReviewerRoles } from '../api.js'
import { mintDraftRoleKey, useRoleThread } from '../rolesPref.js'
import { AgentConversation, type AgentConversationProps } from './AgentConversation.js'
import { Confirm } from './Confirm.js'
import { Icon } from './Icon.js'
import { Menu, MenuItem } from './Menu.js'
import { Modal } from './Modal.js'

/** What the page shows on the right. */
export type ReviewerAgentsPick = { kind: 'role'; id: string } | { kind: 'new'; from?: RoleDraft }

const EMPTY: RoleDraft = { name: '', blurb: '', focus: '' }

/** Longer than this, a role's focus opens on its first lines. */
const LONG_FOCUS = 320

const FIELD_LABELS: Record<keyof RoleDraft, string> = {
  name: 'Name',
  blurb: 'One line',
  focus: 'What it looks for',
}

/** What a first message about a new role could say. */
const NEW_PLACEHOLDER =
  'Look for what gets slower: a query inside a loop, work repeated on every request. Leave the rest to other reviewers.'

/**
 * Reviewer roles, on one page, laid out like Layers presets and behaving like
 * it: on the left the roles a reviewer can be given, built in and the
 * reviewer's own; on the right, the one picked, as one card: what it looks
 * for and, under it, its conversation with the author agent, which makes a
 * role or changes one through the CLI and says what it changed, each edit
 * with an undo. The reviewer's own roles have a Manual edit too (never a
 * built-in's), and one bar at the foot adds a reviewer in the role in view.
 *
 * The reviewers at work in this review live in the agents panel, not here;
 * adding one is the Add dialog's job (`onAdd`), opened on the role in view.
 */
export function ReviewerAgents({
  initial,
  agentAttached = false,
  onAdd,
  onClose,
}: {
  /** What to open on. */
  initial?: ReviewerAgentsPick
  /** An author agent is on the review: it can make and change roles. */
  agentAttached?: boolean
  /** Open the Add dialog on a role. Absent where reviewer agents cannot join
   * (a pull request). */
  onAdd?: (role?: string) => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const { data, isLoading, error } = useReviewerRoles()
  const [pick, setPick] = useState<ReviewerAgentsPick | null>(initial ?? null)
  // One of the reviewer's own, with its fields open to edit.
  const [editing, setEditing] = useState(false)
  // A new role written by hand: the form, above the conversation.
  const [byHand, setByHand] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // The conversation in view waits on the agent's answer: closing asks first,
  // since nothing here says the answer will be kept for when you come back.
  // A ref, not state: the conversation reports it from an effect, and a
  // close must read the latest word, not the last render's.
  const waiting = useRef(false)
  const setWaiting = useCallback((now: boolean) => {
    waiting.current = now
  }, [])
  const [closing, setClosing] = useState(false)
  const close = () => (waiting.current ? setClosing(true) : onClose())
  // A new role's conversation, under a key of its own until the agent names
  // the role: a fresh one each time New role is opened.
  const [draftKey, setDraftKey] = useState(mintDraftRoleKey)
  // Delete asks first, in a dialog over this one: the role to delete.
  const [deleting, setDeleting] = useState<ReviewerRole | null>(null)

  const roles = data?.roles ?? []
  const mine = roles.filter((r) => !r.builtIn)
  // Active roles are in the Add reviewer picker; the rest wait in the library.
  const activeIds = new Set(data?.active)
  const active = roles.filter((r) => activeIds.has(r.id))
  const library = roles.filter((r) => !activeIds.has(r.id))
  const [activeError, setActiveError] = useState<string | null>(null)
  const setActive = (id: string, on: boolean) => {
    setActiveError(null)
    reviewerApi
      .setActive(id, on)
      .then((saved) => client.setQueryData<ReviewerRoles>(['reviewer-roles'], saved))
      .catch((err: Error) => setActiveError(err.message))
  }
  // Nothing picked yet: the first role.
  const shown: ReviewerAgentsPick | null =
    pick ?? (roles[0] ? { kind: 'role', id: roles[0].id } : null)
  /** Shows a card: what was being edited in the last one is left behind. */
  const show = (next: ReviewerAgentsPick | null) => {
    setEditing(false)
    setByHand(false)
    setExpanded(false)
    setSaveError(null)
    if (next?.kind === 'new') setDraftKey(mintDraftRoleKey())
    setPick(next)
  }
  // The agent made the role a draft asked for: the card and the conversation
  // carry on under the role itself.
  const made = (id: string) => {
    void client.invalidateQueries({ queryKey: ['reviewer-roles'] })
    show({ kind: 'role', id })
  }

  /** Replace the reviewer's own roles. True when the save went through. */
  const store = async (next: ReviewerRole[]): Promise<boolean> => {
    setSaveError(null)
    try {
      const saved = await reviewerApi.saveRoles(next)
      client.setQueryData<ReviewerRoles>(['reviewer-roles'], saved)
      // The line names the role; a renamed one has a new line.
      void client.invalidateQueries({ queryKey: ['reviewer-invite'] })
      return true
    } catch (err) {
      setSaveError((err as Error).message)
      return false
    }
  }
  const saveNew = async (fields: RoleDraft): Promise<boolean> => {
    const id = roleIdFor(fields.name, new Set(roles.map((r) => r.id)))
    if (id === null) {
      setSaveError('Give the agent a name with a letter or a digit in it.')
      return false
    }
    const ok = await store([...mine, { id, ...fields }])
    if (ok) show({ kind: 'role', id })
    return ok
  }
  const saveEdit = async (id: string, fields: Partial<RoleDraft>): Promise<boolean> => {
    const ok = await store(mine.map((r) => (r.id === id ? { ...r, ...fields } : r)))
    if (ok) setEditing(false)
    return ok
  }
  const remove = async (id: string) => {
    if (!(await store(mine.filter((r) => r.id !== id)))) throw new Error('refused')
    show(null)
  }

  const dhead = (title: string, sub: ReactNode, controls?: ReactNode, tags?: ReactNode) => (
    <header className="lp-dhead">
      <div className="lp-dhead-row">
        <h3 className="lp-title">{title}</h3>
        {tags && <span className="lp-dhead-tags">{tags}</span>}
        {controls && <span className="lp-dhead-acts">{controls}</span>}
      </div>
      {sub && <p className="lp-dsub">{sub}</p>}
    </header>
  )
  const roleRow = (role: ReviewerRole) => (
    <button
      key={role.id}
      type="button"
      className="lp-row"
      aria-current={(shown?.kind === 'role' && shown.id === role.id) || undefined}
      onClick={() => show({ kind: 'role', id: role.id })}
    >
      <span className="lp-row-name">{role.name}</span>
      <span className="lp-row-sub">{role.blurb}</span>
    </button>
  )

  const viewed = shown?.kind === 'role' ? roles.find((r) => r.id === shown.id) : undefined
  const newForm = shown?.kind === 'new' && (shown.from !== undefined || byHand)

  /** Everything done to a role, behind one "more". */
  const roleMenu = (role: ReviewerRole) => (
    <Menu label="Agent options">
      {(close) =>
        role.builtIn ? (
          <MenuItem
            title="A copy under your own agents, every field prefilled"
            onClick={() => {
              close()
              show({
                kind: 'new',
                from: {
                  name: `${role.name} (mine)`.slice(0, ROLE_NAME_MAX),
                  blurb: role.blurb,
                  focus: role.focus,
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
              setDeleting(role)
            }}
          >
            Delete
          </MenuItem>
        )
      }
    </Menu>
  )

  return (
    <Modal title="Reviewer agents" className="lp-modal ra-modal" wide onClose={close}>
      <p className="cov-note lp-intro">
        A reviewer agent is a second AI that reads the change and comments on it. Each one here
        looks for something different.
      </p>
      {isLoading && <div className="shimmer" />}
      {error && (
        <p className="cov-note">Couldn't load the reviewer agents: {(error as Error).message}</p>
      )}
      <div className="lp-grid">
        <nav className="lp-side" aria-label="Reviewer agents">
          <div className="lp-cap">Active</div>
          <div className="lp-group">
            {active.map(roleRow)}
            <button
              type="button"
              className="lp-row lp-row-new"
              aria-current={shown?.kind === 'new' || undefined}
              disabled={mine.length >= CUSTOM_ROLES_MAX}
              title={
                mine.length >= CUSTOM_ROLES_MAX
                  ? `Up to ${CUSTOM_ROLES_MAX} of your own`
                  : undefined
              }
              onClick={() => show({ kind: 'new' })}
            >
              <Icon name="plus" size="sm" />
              <span className="lp-row-name">New agent</span>
            </button>
          </div>
          {library.length > 0 && (
            <>
              <div className="lp-cap">Library</div>
              <div className="lp-group">{library.map(roleRow)}</div>
            </>
          )}
        </nav>
        <div className="lp-detail">
          {viewed && (
            <>
              {dhead(
                viewed.name,
                sentence(viewed.blurb),
                <>
                  {/* Bring one into the review: the action this page is
                      opened for most, at the top of what it is about. */}
                  {onAdd && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      title={`Add ${/^[aeiou]/i.test(viewed.name) ? 'an' : 'a'} ${viewed.name} reviewer to this review`}
                      onClick={() => onAdd(viewed.id)}
                    >
                      Add to review
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    title={
                      activeIds.has(viewed.id)
                        ? 'Take it out of the Add reviewer list; it waits in the library'
                        : 'Show it in the Add reviewer list'
                    }
                    onClick={() => setActive(viewed.id, !activeIds.has(viewed.id))}
                  >
                    {activeIds.has(viewed.id) ? 'Move to library' : 'Make active'}
                  </button>
                  {!viewed.builtIn && !editing && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      title="Change the fields yourself, without the agent"
                      onClick={() => setEditing(true)}
                    >
                      Manual edit
                    </button>
                  )}
                  {roleMenu(viewed)}
                </>,
                <>
                  {activeIds.has(viewed.id) && <span className="lp-row-state">Active</span>}
                  {viewed.builtIn && <span className="lp-row-state">Built in</span>}
                </>,
              )}
              {/* One card: what the role says, and under it, the way a
                  comment sits under the lines it is about, the conversation
                  that changes it. */}
              <div className="lp-card">
                {editing && !viewed.builtIn ? (
                  <RoleEditor
                    key={fieldsKey(viewed)}
                    initial={draftOf(viewed)}
                    onSave={(fields) => saveEdit(viewed.id, fields)}
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
                      <dt className="lp-fact-cap">What it looks for</dt>
                      <dd className="lp-fact-body">
                        <p
                          className={`lp-fro${viewed.focus.length > LONG_FOCUS && !expanded ? ' lp-clamp' : ''}`}
                        >
                          {viewed.focus}
                        </p>
                        {viewed.focus.length > LONG_FOCUS && (
                          <button
                            type="button"
                            className="lp-more"
                            aria-expanded={expanded}
                            onClick={() => setExpanded(!expanded)}
                          >
                            {expanded ? 'Show less' : 'Show all'}
                          </button>
                        )}
                      </dd>
                    </div>
                    <div className="lp-fact">
                      <dt className="lp-fact-cap">What every reviewer is told</dt>
                      <dd className="lp-fact-body">
                        <p className="lp-fro">
                          Comment only on what matters, and only on what it can show. One finding
                          per thread, and never edit the code.
                        </p>
                      </dd>
                    </div>
                  </dl>
                )}
                <div className="lp-card-thread">
                  <RoleConversation
                    key={viewed.id}
                    id={viewed.id}
                    onWaiting={setWaiting}
                    canAsk={agentAttached}
                    title={
                      viewed.builtIn
                        ? 'Want it different? Ask your agent'
                        : 'Ask your agent to change it'
                    }
                    context={
                      viewed.builtIn
                        ? 'The agent is sent this agent’s fields with every message. It can’t change a built-in, so it answers with a copy under yours.'
                        : 'The agent is sent this agent’s fields, as they stand, with every message.'
                    }
                    hint={
                      viewed.builtIn
                        ? 'It answers with a copy under your agents'
                        : 'It edits this agent; every edit has an undo'
                    }
                    placeholder="Tell the agent what to change."
                    current={draftOf(viewed)}
                    onUndo={
                      viewed.builtIn
                        ? undefined
                        : (change) => void saveEdit(viewed.id, change.before)
                    }
                    openMade={(change) => {
                      const to = change.roleId
                      return to !== undefined && to !== viewed.id
                        ? () => show({ kind: 'role', id: to })
                        : undefined
                    }}
                  />
                </div>
              </div>
            </>
          )}
          {shown?.kind === 'new' && (
            <>
              {dhead(
                'New agent',
                shown.from
                  ? 'A copy of a built-in, yours to change.'
                  : 'Tell your agent what this reviewer should look for, and it writes the agent.',
                <>
                  {!newForm && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      title="Write the fields yourself, without the agent"
                      onClick={() => setByHand(true)}
                    >
                      Manual edit
                    </button>
                  )}
                  {/* With the form open by hand, Cancel is the form's own: it
                      closes the form, not the new role. */}
                  {!(byHand && shown.from === undefined) && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => show(null)}
                    >
                      Cancel
                    </button>
                  )}
                </>,
              )}
              {/* A copy is a form to save, so it opens on the form; a blank
                  one opens on the conversation, with the form behind the same
                  "Manual edit" a saved role has. */}
              <div className={`lp-card${newForm ? '' : ' lp-card-bare'}`}>
                {newForm && (
                  <RoleEditor
                    key={shown.from?.name ?? draftKey}
                    initial={shown.from ?? EMPTY}
                    fresh
                    {...(shown.from === undefined ? { onCancel: () => setByHand(false) } : {})}
                    onSave={saveNew}
                  />
                )}
                <div className="lp-card-thread">
                  <RoleConversation
                    key={draftKey}
                    id={draftKey}
                    onWaiting={setWaiting}
                    canAsk={agentAttached}
                    title="Describe it to your agent"
                    context="The agent makes the reviewer agent from what you say, names it, and is sent the conversation with every message."
                    hint="It writes the agent from what you say"
                    placeholder={NEW_PLACEHOLDER}
                    onMade={made}
                  />
                </div>
              </div>
            </>
          )}
          {saveError && (
            <div className="warn">
              <Icon name="alert" size="sm" />
              <div>{saveError}</div>
            </div>
          )}
          {activeError && (
            <div className="warn">
              <Icon name="alert" size="sm" />
              <div>{activeError}</div>
            </div>
          )}
        </div>
      </div>
      {deleting && (
        <Confirm
          title="Delete agent"
          action="Delete agent"
          onConfirm={() => remove(deleting.id)}
          onClose={() => setDeleting(null)}
        >
          Deletes “{deleting.name}” and its conversation with the agent. This can’t be undone.
        </Confirm>
      )}
      {closing && (
        <Confirm
          title="Your agent is still answering"
          action="Close anyway"
          onConfirm={async () => onClose()}
          onClose={() => setClosing(false)}
        >
          Its answer is kept: it will be in this conversation when you open Reviewer agents again.
        </Confirm>
      )}
    </Modal>
  )
}

const sentence = (text: string) =>
  text === ''
    ? ''
    : `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.?!]$/.test(text) ? '' : '.'}`

const draftOf = (role: ReviewerRole): RoleDraft => ({
  name: role.name,
  blurb: role.blurb,
  focus: role.focus,
})

/** The fields as stored: an agent's edit changes the key, so the editor
 * shows the new values rather than a stale draft. */
const fieldsKey = (r: RoleDraft) => [r.name, r.blurb, r.focus].join('\u0000')

/**
 * The conversation about one role, or a new role's under its draft key (see
 * AgentConversation, which the Layers presets dialog shares). On a draft,
 * `onMade` hears the role the agent made from it.
 */
function RoleConversation({
  id,
  onMade,
  onWaiting,
  ...props
}: {
  id: string
  onMade?: (roleId: string) => void
  /** Whether the agent owes an answer here: the human spoke last. */
  onWaiting?: (waiting: boolean) => void
} & Omit<
  AgentConversationProps<RoleChange>,
  'conversation' | 'noun' | 'fieldLabels' | 'maxLength'
>) {
  const conversation = useRoleThread(id)
  const madeId = conversation.thread.messages.find((m) => m.change?.roleId !== undefined)?.change
    ?.roleId
  useEffect(() => {
    if (madeId !== undefined) onMade?.(madeId)
  }, [madeId, onMade])
  const waiting = conversation.thread.messages.at(-1)?.author === 'reviewer'
  useEffect(() => {
    onWaiting?.(waiting)
    return () => onWaiting?.(false)
  }, [waiting, onWaiting])
  return (
    <AgentConversation
      conversation={conversation}
      noun="agent"
      fieldLabels={FIELD_LABELS}
      maxLength={ROLE_MESSAGE_MAX}
      {...props}
    />
  )
}

/** A role's three fields as a form: Save once it has a name and a focus. */
function RoleEditor({
  initial,
  fresh = false,
  onSave,
  onCancel,
}: {
  initial: RoleDraft
  /** Nothing is saved yet. */
  fresh?: boolean
  onSave: (fields: RoleDraft) => Promise<boolean>
  onCancel?: () => void
}) {
  const [fields, setFields] = useState<RoleDraft>(initial)
  const [saving, setSaving] = useState(false)
  const set = (key: keyof RoleDraft) => (e: { target: { value: string } }) =>
    setFields((f) => ({ ...f, [key]: e.target.value }))
  const name = fields.name.trim()
  const focus = fields.focus.trim()
  const ready = name !== '' && focus !== ''
  const dirty =
    fields.name !== initial.name || fields.blurb !== initial.blurb || fields.focus !== initial.focus
  const submit = async () => {
    if (!ready || saving) return
    setSaving(true)
    await onSave({ name, blurb: fields.blurb.trim(), focus })
    setSaving(false)
  }
  return (
    <>
      <div className="lp-group lp-fields">
        <div className="lp-frow">
          <label className="lp-flabel" htmlFor="ra-f-name">
            {FIELD_LABELS.name}
          </label>
          <input
            id="ra-f-name"
            className="lp-fin"
            value={fields.name}
            maxLength={ROLE_NAME_MAX}
            placeholder="Performance"
            onChange={set('name')}
          />
        </div>
        <div className="lp-frow">
          <label className="lp-flabel" htmlFor="ra-f-blurb">
            {FIELD_LABELS.blurb}
          </label>
          <input
            id="ra-f-blurb"
            className="lp-fin"
            value={fields.blurb}
            maxLength={ROLE_BLURB_MAX}
            placeholder="What gets slower with this change"
            onChange={set('blurb')}
          />
        </div>
        <div className="lp-frow">
          <label className="lp-flabel" htmlFor="ra-f-focus">
            {FIELD_LABELS.focus}
          </label>
          <textarea
            id="ra-f-focus"
            className="lp-fin lp-farea lp-farea-tall"
            value={fields.focus}
            maxLength={ROLE_FOCUS_MAX}
            rows={6}
            placeholder="Read the change for what gets slower: a query inside a loop, work repeated on every request, a list loaded whole. Say what it costs and when. Leave everything else to another reviewer."
            onChange={set('focus')}
          />
        </div>
      </div>
      <div className="lp-savebar">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!ready || saving || (!fresh && !dirty)}
          title={ready ? undefined : 'A role needs a name and what it looks for'}
          onClick={() => void submit()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </>
  )
}
