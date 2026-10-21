import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DiffLine, FileDiff, FixResult, RepoStatus, ReviewFinding, Severity } from '../../shared/types'
import { api } from './api'
import { errorText } from './format'
import { Code, useHighlight } from './DiffView'
import { FileIcon, StatusBadge } from './FileIcon'
import { Icon } from './icons'
import type { RunOp } from './model'
import type { AccountSuggestion } from './AccountsDialog'
import { countBy, HEAD_MOVED, isMoved, MOVED_TEXT, postStatus, FORGE_NAME, initialEdits, keptComments, keptFixes, postPlan, requestLabel, requestName, requestWord, SEVERITIES, SEVERITY_CLASS, SEVERITY_LABEL, shortPath, visibleFindings, where, type FindingEdit, type PostState, type PostStepState, type ReviewMode, type ReviewSession, type ReviewUi } from './review'

interface BannerProps {
  session: ReviewSession
  rerunning: boolean
  posting: boolean // comments are being sent: leaving would lose track of them
  onRerun: () => void
  onMode: (m: ReviewMode) => void
  onExit: () => void
}

export function ReviewBanner({ session, rerunning, posting, onRerun, onMode, onExit }: BannerProps) {
  const { review, forge } = session
  const n = review.findings.length
  const request = forge?.request ? forge : null
  return (
    <div className="rbanner" role="region" aria-label="Review">
      <Icon name="sparkle" size={14} />
      <span>
        {session.mode === 'request' && request ? (
          <>
            Reviewing{' '}
            <b>
              {requestWord(request)} {requestLabel(request)}
            </b>{' '}
            <b className="mono">{review.branch}</b> → <b className="mono">{review.base}</b>
          </>
        ) : (
          <>
            Reviewing your branch <b className="mono">{review.branch}</b> against <b className="mono">{review.base}</b>
            {session.request.worktree && ' · includes uncommitted changes'}
          </>
        )}{' '}
        · {n} finding{n === 1 ? '' : 's'} · {review.prompt}
      </span>
      <span className="grow" />
      {request && (
        <button className="btn sm" disabled={posting} onClick={() => onMode(session.mode === 'request' ? 'branch' : 'request')}>
          {session.mode === 'request' ? 'Switch to my branch mode' : `Switch to ${requestWord(request)} mode`}
        </button>
      )}
      <button className="btn sm" disabled={rerunning || posting} onClick={onRerun}>
        {rerunning ? <span className="spin" /> : <Icon name="fetch" size={12} />} Re-run
      </button>
      <button className="btn sm" disabled={posting} onClick={onExit}>
        Exit review
      </button>
    </div>
  )
}

interface Props {
  repo: string
  session: ReviewSession
  status: RepoStatus | null
  remote: boolean // the reviewed branch is a remote-tracking one: it cannot be checked out as is
  undoLabel: string | null // what Undo would revert
  ui: ReviewUi
  setUi: (f: (u: ReviewUi) => ReviewUi) => void
  current: () => ReviewUi | null // the live state, for a posting loop that outlives this screen
  run: RunOp
  onShowChanges: () => void
  onAccounts: (suggest: AccountSuggestion | null) => void
}

// The review screen: findings on the left, the branch diff with a card under each finding, what to do with them on the right.
export function ReviewView({ repo, session, status, remote, undoLabel, ui, setUi, current, run, onShowChanges, onAccounts }: Props) {
  const { review } = session
  const { edits, severity, query, allFiles } = ui
  const patch = (p: Partial<ReviewUi>) => setUi((u) => ({ ...u, ...p }))
  const visible = useMemo(() => visibleFindings(review.findings, severity, query), [review.findings, severity, query])
  // A filter that hides the selected finding moves the selection to the first visible one.
  const selected = visible.some((f) => f.id === ui.selected) ? ui.selected : (visible[0]?.id ?? null)
  const body = useRef<HTMLDivElement>(null)
  // Only the list and the arrows scroll to a card: a click inside a card must not move it under the pointer.
  const reveal = useRef(false)
  const show = (id: number) => {
    reveal.current = true
    patch({ selected: id })
  }
  useEffect(() => {
    if (!reveal.current || selected === null) return
    reveal.current = false
    body.current?.querySelector(`[data-finding="${selected}"]`)?.scrollIntoView({ block: 'center' })
  }, [selected, allFiles])

  const locked = session.mode === 'request' && !!ui.post.steps // posting started: the text is what was sent
  const edit = (id: number, p: Partial<FindingEdit>) => setUi((u) => ({ ...u, edits: { ...u.edits, [id]: { ...u.edits[id], ...p } } }))
  const at = visible.findIndex((f) => f.id === selected)
  const step = (d: number) => visible.length && show(visible[(Math.max(at, 0) + d + visible.length) % visible.length].id)
  // ArrowUp / ArrowDown move through the list: focusing a row selects it.
  const arrows = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    const boxes = [...e.currentTarget.querySelectorAll('button')]
    const i = boxes.indexOf(document.activeElement as HTMLButtonElement)
    if (!d || i < 0) return
    e.preventDefault()
    boxes[Math.min(boxes.length - 1, Math.max(0, i + d))]?.focus()
  }
  const counts = countBy(review.findings)
  const kept = review.findings.filter((f) => edits[f.id]?.keep).length
  const withFindings = new Set(review.findings.map((f) => f.path))
  const files = allFiles ? review.files : review.files.filter((f) => withFindings.has(f.newPath))

  return (
    <>
      <aside className="sidebar findings" aria-label="Findings">
        <div className="side-title">
          <span>Findings</span>
          <span>
            {kept} of {review.findings.length} kept
          </span>
        </div>
        <div className="sevbar" role="group" aria-label="Severity">
          <button className={`chip sm ${severity === 'all' ? 'on' : ''}`} aria-pressed={severity === 'all'} onClick={() => patch({ severity: 'all' })}>
            All <span className="n">{review.findings.length}</span>
          </button>
          {SEVERITIES.map((s) => (
            <button key={s} className={`chip sm ${severity === s ? 'on' : ''}`} aria-pressed={severity === s} aria-label={`${SEVERITY_LABEL[s]} (${counts[s]})`} title={SEVERITY_LABEL[s]} onClick={() => patch({ severity: s })}>
              <i className={`sevdot ${SEVERITY_CLASS[s]}`} /> {counts[s]}
            </button>
          ))}
        </div>
        <input className="field" placeholder="Filter findings" aria-label="Filter findings" value={query} onChange={(e) => patch({ query: e.target.value })} />
        <div className="flist" onKeyDown={arrows}>
          {visible.map((f) => (
            <button key={f.id} type="button" className={`fitem ${f.id === selected ? 'sel' : ''} ${edits[f.id]?.keep ? '' : 'off'}`} aria-current={f.id === selected} onFocus={() => show(f.id)} onClick={() => show(f.id)}>
              <div>
                <div className="fmeta">
                  <span className={`sev ${SEVERITY_CLASS[f.severity]}`}>{SEVERITY_LABEL[f.severity]}</span>
                  <span className="mono faint">{where(f)}</span>
                </div>
                <div className="fsum">
                  {f.title}
                  {!edits[f.id]?.keep && <span className="sr-only"> (ignored)</span>}
                </div>
              </div>
            </button>
          ))}
        </div>
        {review.findings.length === 0 && <div className="note">Claude found nothing to report.</div>}
        <div className="note">Unchecked findings are dropped. Edit any text in the diff.</div>
        {review.excluded.length > 0 && <div className="note">Not sent to Claude (sensitive): {review.excluded.join(', ')}</div>}
        {review.skipped.length > 0 && <div className="note err">Not reviewed: {review.skipped.join(', ')}</div>}
        {review.dropped > 0 && (
          <div className="note">
            {review.dropped} finding{review.dropped === 1 ? '' : 's'} pointed outside the diff and {review.dropped === 1 ? 'was' : 'were'} left out.
          </div>
        )}
      </aside>
      <section className="center">
        <div className="pane-head">
          <span className="pane-title">Branch diff</span>
          <span className="mono faint">
            {review.branch} → {review.base}
          </span>
          <span className="grow" />
          <button
            className={`chip sm ${allFiles ? '' : 'on'}`}
            aria-pressed={!allFiles}
            onClick={() => {
              reveal.current = true
              patch({ allFiles: false })
            }}
          >
            Findings only
          </button>
          <button
            className={`chip sm ${allFiles ? 'on' : ''}`}
            aria-pressed={allFiles}
            onClick={() => {
              reveal.current = true
              patch({ allFiles: true })
            }}
          >
            All {review.files.length} files
          </button>
          <span className="faint">{at >= 0 ? `finding ${at + 1} of ${visible.length}` : `${visible.length} findings`}</span>
          <button className="iconbtn sm" aria-label="Previous finding" disabled={!visible.length} onClick={() => step(-1)}>
            <Icon name="up" size={14} stroke={2} />
          </button>
          <button className="iconbtn sm" aria-label="Next finding" disabled={!visible.length} onClick={() => step(1)}>
            <Icon name="down" size={14} stroke={2} />
          </button>
        </div>
        <div className="diff-body" ref={body}>
          {files.map((f) => (
            <FileBlock key={f.newPath} file={f} findings={review.findings.filter((x) => x.path === f.newPath)} edits={edits} selected={selected} mode={session.mode} locked={locked} onSelect={(id) => patch({ selected: id })} onEdit={edit} />
          ))}
          {files.length === 0 && <span className="faint">No finding to show.</span>}
        </div>
      </section>
      {session.mode === 'request' && session.forge?.request ? (
        <PostPanel repo={repo} session={session} edits={edits} post={ui.post} setUi={setUi} current={current} onAccounts={onAccounts} />
      ) : (
        <FixPanel repo={repo} session={session} edits={edits} status={status} remote={remote} undoLabel={undoLabel} run={run} onShowChanges={onShowChanges} />
      )}
    </>
  )
}

interface FileProps {
  file: FileDiff
  findings: ReviewFinding[]
  edits: Record<number, FindingEdit>
  selected: number | null
  mode: ReviewSession['mode']
  locked: boolean
  onSelect: (id: number) => void
  onEdit: (id: number, patch: Partial<FindingEdit>) => void
}

const anchored = (f: ReviewFinding, l: DiffLine) => (f.side === 'new' ? l.kind !== 'del' && l.newNo === f.endLine : l.kind === 'del' && l.oldNo === f.endLine)

function FileBlock({ file, findings, edits, selected, mode, locked, onSelect, onEdit }: FileProps) {
  const colored = useHighlight(file, file.newPath)
  const add = file.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'add').length, 0)
  const del = file.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'del').length, 0)
  return (
    <>
      <div className="fhead">
        <FileIcon path={file.newPath} />
        <span className="mono">{file.newPath}</span>
        {findings.length > 0 && (
          <span className="badge plain">
            {findings.length} finding{findings.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="grow" />
        <span className="add-n">+{add}</span>
        <span className="del-n">−{del}</span>
      </div>
      {file.binary && <div className="banner">Binary file: no preview.</div>}
      {file.hunks.map((h, i) => (
        <section key={`${i}:${h.header}`} className="hunk">
          <div className="hunk-head">
            <span className="h">{h.header}</span>
          </div>
          <div className="lines">
            {h.lines.map((l, j) => (
              <div key={j}>
                <div className={`line ${l.kind}`}>
                  <span className="no">{l.oldNo ?? ''}</span>
                  <span className="no">{l.newNo ?? ''}</span>
                  <span className="sg">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                  <span className="t">{colored?.[i]?.[j] ? <Code tokens={colored[i][j]!} /> : l.text}</span>
                </div>
                {findings
                  .filter((f) => anchored(f, l))
                  .map((f) => (
                    <Card key={f.id} finding={f} edit={edits[f.id]} active={f.id === selected} mode={mode} locked={locked} onSelect={() => onSelect(f.id)} onEdit={(p) => onEdit(f.id, p)} />
                  ))}
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

interface CardProps {
  finding: ReviewFinding
  edit: FindingEdit
  active: boolean
  mode: ReviewSession['mode']
  locked: boolean
  onSelect: () => void
  onEdit: (patch: Partial<FindingEdit>) => void
}

const rows = (text: string) => Math.min(12, text.split('\n').length + 1)

function Card({ finding: f, edit, active, mode, locked, onSelect, onEdit }: CardProps) {
  const fix = mode === 'branch' && f.fix && edit.fix !== null ? f.fix : null
  return (
    <div className={`ccard ${active ? 'active' : ''} ${edit.keep ? '' : 'off'}`} data-finding={f.id} role="group" aria-label={`Finding: ${f.title}`} onFocus={onSelect} onClick={onSelect}>
      <div className="ccard-head">
        <span className={`sev ${SEVERITY_CLASS[f.severity]}`}>{SEVERITY_LABEL[f.severity]}</span>
        <b>{f.title}</b>
        <span className="grow" />
        <span className="by">
          <Icon name="sparkle" size={12} /> Claude
        </span>
      </div>
      <textarea className="field ctext" aria-label="Comment" readOnly={locked} rows={rows(edit.body)} value={edit.body} onChange={(e) => onEdit({ body: e.target.value })} />
      {fix && (
        <div className="fix">
          <div className="fix-head">
            Suggested fix <span className="faint">· applied as unstaged change</span>
          </div>
          <div className="lines mini">
            {fix.original.map((t, i) => (
              <div key={i} className="line del">
                <span className="no">{f.line + i}</span>
                <span className="sg">−</span>
                <span className="t">{t}</span>
              </div>
            ))}
          </div>
          <textarea className="fix-edit" aria-label="Suggested fix" spellCheck={false} rows={rows(edit.fix ?? '')} value={edit.fix ?? ''} onChange={(e) => onEdit({ fix: e.target.value })} />
        </div>
      )}
      <div className="ccard-foot">
        <button className={`btn sm keep ${edit.keep ? 'on' : ''}`} aria-pressed={edit.keep} disabled={locked} onClick={() => onEdit({ keep: true })}>
          <Icon name="check" size={12} stroke={2.4} /> Keep
        </button>
        <button className={`btn sm ${edit.keep ? '' : 'on'}`} aria-pressed={!edit.keep} disabled={locked} onClick={() => onEdit({ keep: false })}>
          <Icon name="close" size={12} stroke={2.2} /> Ignore
        </button>
        <span className="grow" />
        <span className="note">edited text is what gets {mode === 'branch' ? 'applied' : 'posted'}</span>
      </div>
    </div>
  )
}

interface FixPanelProps {
  repo: string
  session: ReviewSession
  edits: Record<number, FindingEdit>
  status: RepoStatus | null
  remote: boolean
  undoLabel: string | null
  run: RunOp
  onShowChanges: () => void
}

// My branch: the kept fixes go into the working files as unstaged changes; nothing is staged or committed.
function FixPanel({ repo, session, edits, status, remote, undoLabel, run, onShowChanges }: FixPanelProps) {
  const { review } = session
  const [result, setResult] = useState<FixResult | null>(null)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  // New edits start over; an Undo of the prepared fixes makes them preparable again.
  useEffect(() => {
    setResult(null)
    setError('')
  }, [edits])
  const done = result && (!result.applied.length || /review fix/.test(undoLabel ?? '')) ? result : null
  const fixes = keptFixes(review, edits)
  const kept = review.findings.filter((f) => edits[f.id]?.keep)
  const paths = [...new Set(kept.map((f) => f.path))]
  const checkedOut = status?.branch === review.branch
  const unstaged = status?.unstaged ?? []
  const touched = unstaged.filter((u) => fixes.some((f) => f.path === u.path))
  const prepare = async () => {
    setApplying(true)
    setError('')
    await run('fixes', async () => {
      try {
        setResult(await api.prepareFixes(repo, review.branch, fixes))
      } catch (e) {
        setError(errorText(e))
        throw e
      }
    })
    setApplying(false)
  }
  const label = (id: number) => {
    const f = review.findings.find((x) => x.id === id)
    return f ? `${shortPath(f.path)}:${f.line}` : `#${id}`
  }
  return (
    <aside className="right">
      <div className="right-head">
        <b>Prepare fixes</b>
        <span className="faint">
          {fixes.length} of {kept.length} have a fix
        </span>
      </div>
      <div className="rp">
        {paths.length > 0 && (
          <div className="fixfiles">
            {paths.map((p) => {
              const n = fixes.filter((f) => f.path === p).length
              return (
                <div key={p} className={`file ${n ? '' : 'off'}`}>
                  {n ? <StatusBadge status="M" /> : <span className="st">–</span>}
                  <FileIcon path={p} />
                  <span className="path">{p}</span>
                  <span className="note">{n ? `${n} fix${n === 1 ? '' : 'es'}` : 'comment only'}</span>
                </div>
              )
            })}
          </div>
        )}
        <button className="btn-primary" disabled={!fixes.length || !checkedOut || applying || !!done?.applied.length} onClick={() => void prepare()}>
          <Icon name="wand" size={14} /> Prepare fixes ({fixes.length})
        </button>
        {!checkedOut ? <div className="note err">{remote ? `Create a local branch from ${review.branch} and review it to prepare fixes.` : `Check out ${review.branch} to prepare its fixes.`}</div> : !fixes.length ? <div className="note">No fix is kept: nothing to prepare.</div> : done?.applied.length ? <div className="note">Fixes applied. Undo to prepare them again.</div> : null}
        {error && <div className="note err">{error}</div>}
        <div className="explain">
          <b>What happens</b>
          <ul>
            <li>
              Fixes are written to your files as <b>unstaged changes</b>.
            </li>
            <li>You review them in Changes and stage block by block, or discard.</li>
            <li>Nothing is committed or pushed.</li>
          </ul>
        </div>
        {unstaged.length > 0 && (
          <div className="warnbox">
            You already have {unstaged.length} unstaged file{unstaged.length === 1 ? '' : 's'} ({unstaged.map((u) => shortPath(u.path)).join(', ')}). They are kept; fixes{' '}
            {touched.length ? 'only change lines that still read as reviewed.' : 'do not touch them.'}
          </div>
        )}
        {(applying || done) && (
          <div className="progress" role="status">
            <div className="ptitle">{applying ? 'Applying' : 'Result'}</div>
            {applying && (
              <div className="pstep run">
                <span className="spin" /> {fixes.length} fix{fixes.length === 1 ? '' : 'es'}
              </div>
            )}
            {done?.applied.map((id) => (
              <div key={id} className="pstep done">
                <Icon name="check" size={12} stroke={2.4} /> {label(id)} · applied
              </div>
            ))}
            {done?.skipped.map((s) => (
              <div key={s.id} className="pstep skip">
                <Icon name="warn" size={12} stroke={2} /> {label(s.id)} · skipped: {s.reason}
              </div>
            ))}
            {done && done.applied.length > 0 && (
              <button className="btn" onClick={onShowChanges}>
                Show in Changes
              </button>
            )}
          </div>
        )}
        <div className="note">A fix that no longer applies is skipped and listed, never forced.</div>
      </div>
    </aside>
  )
}

interface PostPanelProps {
  repo: string
  session: ReviewSession
  edits: Record<number, FindingEdit>
  post: PostState
  setUi: (f: (u: ReviewUi) => ReviewUi) => void
  current: () => ReviewUi | null
  onAccounts: (suggest: AccountSuggestion | null) => void
}

// Merge or pull request: the kept findings become comments on the request's diff lines, posted one call at a time.
// The state lives in the review session (not here): the loop stops when the session changes, and the progress is still there when the panel comes back.
// A failed call stays in the list: Retry sends only the failed ones, Skip leaves one out; nothing is pushed to the branch.
function PostPanel({ repo, session, edits, post, setUi, current, onAccounts }: PostPanelProps) {
  const { review } = session
  const forge = session.forge!
  const request = forge.request!
  const kind = forge.kind ?? 'gitlab'
  const { steps, posting, moved, draft } = post
  const comments = keptComments(review, edits)
  const kept = review.findings.filter((f) => edits[f.id]?.keep)
  const ignored = review.findings.length - kept.length
  const counts = countBy(kept)
  const word = `${requestWord(forge)} ${requestLabel(forge)}`
  const patch = (p: Partial<PostState>) => setUi((u) => ({ ...u, post: { ...u.post, ...p } }))

  const send = async (list: PostStepState[], id: number, asDraft: boolean) => {
    const next = list.map((s) => ({ ...s }))
    const mine = (f: (p: PostState) => PostState) => setUi((u) => (u.post.id === id ? { ...u, post: f(u.post) } : u))
    const push = () => mine((p) => ({ ...p, steps: next.map((x) => ({ ...x })) }))
    for (const s of next) {
      if (current()?.post.id !== id) return // another review or a new session is shown: this one is over
      if (s.state === 'done' || s.state === 'skip') continue
      // The draft is published only once every other call went through (or was skipped).
      if (s.step.kind === 'publish' && next.some((o) => o !== s && o.state !== 'done' && o.state !== 'skip')) continue
      s.state = 'run'
      push()
      try {
        await api.postReviewStep(repo, review.branch, review.head, asDraft, s.step)
        s.state = 'done'
        s.error = undefined
      } catch (e) {
        s.state = 'fail'
        s.error = errorText(e).replace(HEAD_MOVED, '').trim()
        if (isMoved(e)) {
          // The forge moved: nothing else would land on the right lines.
          for (const o of next) if (o.state !== 'done' && o.state !== 'skip') Object.assign(o, { state: 'fail', error: 'not sent' })
          mine((p) => ({ ...p, moved: true }))
          break
        }
      }
      push()
    }
    mine((p) => ({ ...p, steps: next.map((x) => ({ ...x })), posting: false }))
  }
  const start = () => {
    if (!forge.account) return onAccounts(forge.kind ? { host: forge.host, kind: forge.kind, url: forge.url } : null)
    const list = postPlan(kind, draft, comments).map((p): PostStepState => ({ ...p, state: 'todo' }))
    const id = Date.now()
    patch({ id, steps: list, posting: true, moved: false })
    void send(list, id, draft)
  }
  const resume = () => {
    patch({ posting: true })
    void send(steps ?? [], post.id, draft)
  }
  const skip = (i: number) => patch({ steps: (steps ?? []).map((s, j) => (j === i ? { ...s, state: 'skip', error: undefined } : s)) })
  const { done, skipped, failed, todo, finished } = postStatus(steps ?? [])

  return (
    <aside className="right">
      <div className="right-head">
        <b>Post to {requestName(forge).toLowerCase()}</b>
        <span className="faint">{word}</span>
      </div>
      <div className="rp">
        <div className="forge">
          <span className={`forge-ico ${kind === 'gitlab' ? 'gl' : 'gh'}`} aria-hidden>
            {kind === 'gitlab' ? 'GL' : 'GH'}
          </span>
          <div>
            {forge.host}
            <div className="note">
              {forge.project}
              {forge.account?.user ? ` · posting as @${forge.account.user}` : ''}
            </div>
          </div>
          {forge.account ? (
            <span className="ok">
              <Icon name="check" size={12} stroke={2.4} /> token OK
            </span>
          ) : (
            <button className="lnk" onClick={() => onAccounts(forge.kind ? { host: forge.host, kind: forge.kind, url: forge.url } : null)}>
              Accounts…
            </button>
          )}
        </div>
        <div className="sumlist">
          {SEVERITIES.filter((s) => counts[s]).map((s) => (
            <div key={s}>
              <span className={`sev ${SEVERITY_CLASS[s]}`}>{SEVERITY_LABEL[s]}</span> {counts[s]} inline comment{counts[s] === 1 ? '' : 's'}
            </div>
          ))}
          {ignored > 0 && <div className="note">{ignored} ignored</div>}
        </div>
        <label className="check">
          <input type="checkbox" checked={draft} disabled={!!steps} onChange={(e) => patch({ draft: e.target.checked })} /> {kind === 'github' ? 'Post as a pending review (submit it on GitHub)' : 'Post as a draft review (publish all at once)'}
        </label>
        {!steps && (
          <button className="btn-primary" disabled={posting || !comments.length} onClick={start}>
            Post {comments.length} comment{comments.length === 1 ? '' : 's'} to {word}
          </button>
        )}
        {steps && <div className="note">Posting uses the text as it was when you clicked Post.</div>}
        <div className="note">Comments are attached to the diff lines of the {requestWord(forge)}. Nothing is pushed to the branch.</div>
        {steps && (
          <div className="progress" role="status" aria-label="Posting">
            <div className="ptitle">{finished ? 'Posted' : posting ? 'While posting' : 'Stopped'}</div>
            {steps.map((s, i) => (
              <div key={i} className={`pstep ${s.state}`}>
                {s.state === 'run' ? <span className="spin" /> : s.state === 'done' ? <Icon name="check" size={12} stroke={2.4} /> : s.state === 'fail' || s.state === 'skip' ? <Icon name="warn" size={12} stroke={2} /> : null}
                <span className="sr-only">{{ todo: 'waiting', run: 'sending', done: 'sent', fail: 'failed', skip: 'skipped' }[s.state]}: </span>
                {s.label}
                {s.error ? ` · ${s.error}` : ''}
                {s.state === 'fail' && !posting && !moved && (
                  <button className="lnk" onClick={() => skip(i)}>
                    Skip
                  </button>
                )}
              </div>
            ))}
            <div className="pbar">
              <i style={{ width: `${(100 * done) / Math.max(1, steps.length)}%` }} />
            </div>
            <div className="note">
              {done} of {steps.length}
              {skipped ? ` · ${skipped} skipped` : ''}
              {failed && !moved ? ' · stays here: retry sends only the failed ones' : ''}
            </div>
            {moved && <div className="note err">{MOVED_TEXT}</div>}
            {!moved && !posting && failed > 0 && (
              <button className="btn" onClick={resume}>
                Retry failed ({failed})
              </button>
            )}
            {!moved && !posting && failed === 0 && todo > 0 && (
              <button className="btn" onClick={resume}>
                Continue
              </button>
            )}
            {finished && (
              <a className="lnk" href={request.url} target="_blank" rel="noreferrer">
                Open {word} on {FORGE_NAME[kind]}
              </a>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
