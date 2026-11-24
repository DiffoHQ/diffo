import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { type ReviewerRole, ROLE_COMBOS } from '../../shared/roles.js'
import { useReviewers } from '../actors.js'
import { reviewerApi, useReviewerInvite, useReviewerRoles } from '../api.js'
import { copyText } from '../clipboard.js'
import { Icon } from './Icon.js'
import { Modal } from './Modal.js'

/** How the reviewers picked get into the review. */
type How = 'agent' | 'paste'

/**
 * Bring reviewer agents into the review: tick the roles, then choose how they
 * join. Either the agent that wrote the change starts each as a sub-agent, or
 * the reviewer copies one line per role into any other agent session. The
 * second is the one that always works, and the one that gets a different
 * model's opinion; the first is one click.
 *
 * The dialog is the quick action. It lists the active roles; the rest wait
 * in the library on the Reviewer agents page, where any can be made active. A
 * row of ready-made sets ticks the roles a kind of change wants in one click,
 * from the library too. What a role looks for is one click away on each row.
 */
export function InviteReviewer({
  agentAttached,
  suggested,
  preselect,
  onManage,
  onStarted,
  onClose,
}: {
  /** Whether an agent is connected to hear "start them". */
  agentAttached: boolean
  /** The agent's standing suggestion: that role comes ticked, with its reason,
   * and the dialog offers to pass on it. */
  suggested?: { role: string; reason?: string }
  /** A role to open ticked: the page's "Add to this review". */
  preselect?: string
  /** Open the Reviewer agents page, where roles are written. */
  onManage?: () => void
  /** Reviewers were asked for: the page opens where they show up. */
  onStarted?: () => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const { data, isLoading, error } = useReviewerRoles()
  const { roles: seated, starting = [] } = useReviewers()
  /** Null until the reviewer touches a box: the default pick stands. */
  const [touched, setTouched] = useState<ReadonlySet<string> | null>(null)
  const [how, setHow] = useState<How>(agentAttached ? 'agent' : 'paste')
  /** The role whose focus is open. */
  const [viewing, setViewing] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)

  const roles = data?.roles ?? []
  const inReview = new Set(seated?.values() ?? [])
  const onTheWay = new Set(starting)
  const first = preselect ?? suggested?.role ?? data?.default
  // The default pick is one role, and never one already here or on its way.
  const fallback =
    first !== undefined && !inReview.has(first) && !onTheWay.has(first) ? [first] : []
  const picked = touched ?? new Set(fallback)
  const chosen = roles.filter((r) => picked.has(r.id))
  const toggle = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setTouched(next)
  }
  const known = new Set(roles.map((r) => r.id))
  const combos = ROLE_COMBOS.filter((c) => c.roles.every((id) => known.has(id)))
  const isPicked = (ids: readonly string[]) =>
    ids.length === picked.size && ids.every((id) => picked.has(id))
  // The active roles, and any other ticked (a quick set, the page's pick, the
  // agent's suggestion): the rest wait in the library.
  const active = new Set(data?.active)
  const listed = roles.filter((r) => active.has(r.id) || picked.has(r.id))
  const inLibrary = roles.filter((r) => !active.has(r.id)).length
  const row = (role: ReviewerRole) => (
    <RoleRow
      key={role.id}
      role={role}
      checked={picked.has(role.id)}
      tag={inReview.has(role.id) ? 'in this review' : onTheWay.has(role.id) ? 'on its way' : null}
      open={viewing === role.id}
      onToggle={() => toggle(role.id)}
      onView={() => setViewing(viewing === role.id ? null : role.id)}
    />
  )

  const start = () => {
    setAskError(null)
    setAsking(true)
    reviewerApi
      .request(chosen.map((r) => r.id))
      .then(() => {
        // Acting on a suggestion answers it; the review says so.
        void client.invalidateQueries({ queryKey: ['review'] })
        onClose()
        onStarted?.()
      })
      .catch((err: Error) => {
        setAskError(err.message)
        setAsking(false)
      })
  }

  const count = chosen.length
  const footer = (
    <>
      {how === 'agent' ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={count === 0 || asking || !agentAttached}
          title={
            count === 0
              ? 'Tick at least one agent'
              : 'Your agent starts each reviewer as a sub-agent of its own'
          }
          onClick={start}
        >
          {count > 1 ? `Start ${count} reviewers` : 'Start reviewer'}
        </button>
      ) : (
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      )}
      {how === 'agent' && (
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      )}
      {suggested && (
        <button
          type="button"
          className="btn btn-ghost rv-pass"
          title="Pass on your agent's suggestion: it goes from the top bar, and nothing is started"
          onClick={() => {
            void reviewerApi
              .dismissSuggestion()
              .then(() => client.invalidateQueries({ queryKey: ['review'] }))
              .finally(onClose)
          }}
        >
          Not now
        </button>
      )}
    </>
  )

  return (
    <Modal title="Add reviewer agents" className="rv-sheet" onClose={onClose} footer={footer}>
      <p className="cov-note">
        A second AI reads the change and comments on it. Your agent answers, and you settle what the
        two cannot.
      </p>
      {suggested && (
        <div className="rv-suggested">
          <Icon name="sparkle" size="sm" />
          <div>
            <b>Your agent suggests a {suggested.role} reviewer</b>
            {suggested.reason ? `: ${suggested.reason}` : '.'}
          </div>
        </div>
      )}
      {isLoading && <div className="shimmer" />}
      {error && (
        <p className="cov-note">Couldn't load the reviewer agents: {(error as Error).message}</p>
      )}
      {roles.length > 0 && (
        <div className="la-fields">
          <div className="la-by">
            <div className="la-by-head">
              <span className="la-cap">Reviewer agents</span>
              {onManage && (
                <button type="button" className="la-link" onClick={onManage}>
                  Edit agents
                </button>
              )}
            </div>
            {combos.length > 0 && (
              <fieldset className="rv-combos">
                <legend className="rv-combos-cap">Quick sets</legend>
                {combos.map((combo) => {
                  const names = combo.roles
                    .map((id) => roles.find((r) => r.id === id)?.name ?? id)
                    .join(', ')
                  return (
                    <button
                      key={combo.label}
                      type="button"
                      className="rv-combo"
                      aria-pressed={isPicked(combo.roles)}
                      title={names}
                      onClick={() => setTouched(new Set(combo.roles))}
                    >
                      {combo.label}
                    </button>
                  )
                })}
              </fieldset>
            )}
            <ul className="rv-roles">{listed.map(row)}</ul>
            {onManage && inLibrary > 0 && (
              <button type="button" className="la-link rv-more" onClick={onManage}>
                {inLibrary} more in the library
              </button>
            )}
          </div>
          <fieldset className="rv-how">
            <legend className="la-cap">How they join</legend>
            <HowOption
              value="agent"
              how={how}
              disabled={!agentAttached}
              title="My agent starts them"
              sub={
                agentAttached
                  ? 'As sub-agents of the agent that wrote the change'
                  : 'No agent is connected to this review'
              }
              onPick={setHow}
            />
            <HowOption
              value="paste"
              how={how}
              title="Another session"
              sub="Copy a line into any agent session: Codex, a second Claude"
              onPick={setHow}
            />
          </fieldset>
          {how === 'paste' && (
            <div className="rv-lines">
              {count === 0 && <p className="la-hint">Tick an agent to get its line.</p>}
              {chosen.map((role) => (
                <InviteLine key={role.id} role={role} onCopyFailed={setCopyFailed} />
              ))}
            </div>
          )}
          {askError && (
            <div className="warn">
              <Icon name="alert" size="sm" />
              <div>
                <b>Couldn't ask your agent</b>: {askError}
              </div>
            </div>
          )}
          {copyFailed && (
            <div className="warn">
              <Icon name="alert" size="sm" />
              <div>
                <b>Couldn't reach the clipboard</b>: this browser blocked it.
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/** One role: a box to tick, its name and one line, and its focus on demand. */
function RoleRow({
  role,
  checked,
  tag,
  open,
  onToggle,
  onView,
}: {
  role: ReviewerRole
  checked: boolean
  /** Why this role may not need adding: a reviewer has it already. */
  tag: string | null
  open: boolean
  onToggle: () => void
  onView: () => void
}) {
  return (
    <li className="rv-role">
      <div className="rv-role-row">
        <label className="rv-role-pick">
          <input type="checkbox" checked={checked} onChange={onToggle} />
          <span className="rv-role-name">{role.name}</span>
          {tag && <span className="lp-row-state">{tag}</span>}
          <span className="rv-role-blurb" title={role.blurb}>
            {role.blurb}
          </span>
        </label>
        <button
          type="button"
          className="la-link"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'View'} what the ${role.name} reviewer looks for`}
          onClick={onView}
        >
          {open ? 'Hide' : 'View'}
        </button>
      </div>
      {open && <RoleDetail role={role} />}
    </li>
  )
}

/** What a role is for, the quick read first: when to open it, and its whole
 * instructions only on demand. */
function RoleDetail({ role }: { role: ReviewerRole }) {
  const [full, setFull] = useState(false)
  return (
    <div className="rv-focus">
      <p className="rv-when">{role.when ?? role.blurb}</p>
      {full && <p className="rv-full">{role.focus}</p>}
      <button type="button" className="la-link" aria-expanded={full} onClick={() => setFull(!full)}>
        {full ? 'Hide full instructions' : 'Full instructions'}
      </button>
    </div>
  )
}

function HowOption({
  value,
  how,
  disabled = false,
  title,
  sub,
  onPick,
}: {
  value: How
  how: How
  disabled?: boolean
  title: string
  sub: string
  onPick: (how: How) => void
}) {
  return (
    <label className={`rv-how-opt${disabled ? ' rv-how-off' : ''}`}>
      <input
        type="radio"
        name="rv-how"
        checked={how === value}
        disabled={disabled}
        onChange={() => onPick(value)}
      />
      <span className="rv-how-text">
        <span className="rv-how-title">{title}</span>
        <span className="rv-how-sub">{sub}</span>
      </span>
    </label>
  )
}

/**
 * The line that brings one reviewer in, as something to copy rather than to
 * read: its role, the start of the line, and the button. The whole line is the
 * button's tooltip for whoever wants to see it.
 */
function InviteLine({
  role,
  onCopyFailed,
}: {
  role: ReviewerRole
  onCopyFailed: (failed: boolean) => void
}) {
  const invite = useReviewerInvite(role.id)
  const [copied, setCopied] = useState(false)
  const copy = () => {
    if (!invite.data) return
    void copyText(invite.data.ask).then((ok) => {
      onCopyFailed(!ok)
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    })
  }
  return (
    <div className="rv-line">
      <span className="rv-line-role">{role.name}</span>
      <code className="rv-line-text" title={invite.data?.ask}>
        {invite.error
          ? `Couldn't build the line: ${(invite.error as Error).message}`
          : (invite.data?.ask ?? '…')}
      </code>
      <button
        type="button"
        className="btn btn-sm"
        disabled={!invite.data}
        aria-label={`Copy the ${role.name} reviewer's invite`}
        onClick={copy}
      >
        <Icon name={copied ? 'check' : 'copy'} size="sm" />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
