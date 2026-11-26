import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { AGENT_PICKS_SET, type ReviewerRole } from '../../shared/roles.js'
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
 * row of sets ticks the roles a kind of change wants in one click, from the
 * library too. What a role looks for is one click away on each row.
 *
 * It opens with a set already ticked, so the roles are there to read before
 * anything starts: the human's default set, or, until they name one, the set
 * the author agent said fits this change (`picked`), with its reason.
 */
export function InviteReviewer({
  agentAttached,
  suggested,
  picked: agentPick,
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
  /** The set the author agent said fits this change, and why. */
  picked?: { set: string; reason?: string }
  /** The roles to open ticked: the page's "Add to this review", for the role
   * or the set in view there. */
  preselect?: readonly string[]
  /** Open the Reviewer agents page, where roles and sets are written. */
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
  const known = new Set(roles.map((r) => r.id))
  const sets = (data?.sets ?? []).filter((s) => s.roles.every((id) => known.has(id)))
  const agentSet = agentPick ? sets.find((s) => s.id === agentPick.set) : undefined
  // The set it opens on: the human's default, or the agent's pick when the
  // default is to follow the agent.
  const opensOn =
    data?.defaultSet === AGENT_PICKS_SET ? agentSet : sets.find((s) => s.id === data?.defaultSet)
  // What comes ticked: what the page asked for, else that set and the role the
  // agent flagged, else the one default role. Never one already here or on
  // its way.
  const asked = preselect?.filter((id) => known.has(id)) ?? [
    ...(opensOn?.roles ?? []),
    ...(suggested ? [suggested.role] : []),
  ]
  const first = asked.length > 0 ? asked : data?.default !== undefined ? [data.default] : []
  const fallback = first.filter((id) => !inReview.has(id) && !onTheWay.has(id))
  const picked = touched ?? new Set(fallback)
  const chosen = roles.filter((r) => picked.has(r.id))
  const toggle = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setTouched(next)
  }
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
                  Edit agents and sets
                </button>
              )}
            </div>
            {sets.length > 0 && (
              <fieldset className="rv-combos">
                <legend className="rv-combos-cap">Sets</legend>
                {sets.map((set) => {
                  const names = set.roles
                    .map((id) => roles.find((r) => r.id === id)?.name ?? id)
                    .join(', ')
                  const agents = set.id === agentSet?.id
                  return (
                    <button
                      key={set.id}
                      type="button"
                      className="rv-combo"
                      aria-pressed={isPicked(set.roles)}
                      title={agents ? `Your agent's pick for this change: ${names}` : names}
                      onClick={() => setTouched(new Set(set.roles))}
                    >
                      {agents && <Icon name="sparkle" size="sm" />}
                      {set.name}
                    </button>
                  )
                })}
              </fieldset>
            )}
            {agentSet && (
              <p className="rv-picked">
                <Icon name="sparkle" size="sm" />
                <span>
                  Your agent picked <b>{agentSet.name}</b> for this change
                  {agentPick?.reason ? `: ${agentPick.reason}` : '.'}
                </span>
              </p>
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
