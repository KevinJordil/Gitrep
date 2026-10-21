import { useState } from 'react'
import { MAX_PROMPT_NAME, MAX_PROMPT_TEXT, MAX_PROMPTS, type ReviewPrompt } from '../../shared/types'
import { Dialog } from './Dialog'

interface Props {
  repoName: string
  prompts: ReviewPrompt[] // for every repository, the first is the default
  own: ReviewPrompt | null // this repository's own prompt
  onSave: (prompts?: ReviewPrompt[], own?: ReviewPrompt | null) => Promise<boolean> // only what changed is given; true closes
  onClose: () => void
}

// What the review prompts are wrong about, or '' when they can be saved.
export function promptProblem(list: ReviewPrompt[], own: ReviewPrompt | null): string {
  const names = list.map((p) => p.name.trim())
  if (names.some((n) => !n) || (own && !own.name.trim())) return 'Every prompt needs a name.'
  if ([...names, own?.name.trim() ?? ''].some((n) => n.length > MAX_PROMPT_NAME)) return `A name is limited to ${MAX_PROMPT_NAME} characters.`
  if (new Set(names).size !== names.length) return 'Two prompts have the same name.'
  return ''
}

const clean = (p: ReviewPrompt): ReviewPrompt => ({ name: p.name.trim(), text: p.text })

export function PromptsDialog({ repoName, prompts, own, onSave, onClose }: Props) {
  const [list, setList] = useState(prompts)
  const [mine, setMine] = useState<ReviewPrompt>(own ?? { name: `${repoName} review`, text: '' })
  const [useOwn, setUseOwn] = useState(!!own)
  const [busy, setBusy] = useState(false)
  const problem = promptProblem(list, useOwn ? mine : null)
  const set = (i: number, patch: Partial<ReviewPrompt>) => setList((l) => l.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const save = async () => {
    const next = list.map(clean)
    const nextOwn = useOwn ? clean(mine) : null
    setBusy(true)
    const ok = await onSave(JSON.stringify(next) !== JSON.stringify(prompts) ? next : undefined, JSON.stringify(nextOwn) !== JSON.stringify(own) ? nextOwn : undefined)
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog title="Review prompts" submit="Save" wide busy={busy} canSubmit={!problem} onSubmit={() => void save()} onClose={onClose}>
      <section className="prompt-card">
        <label className="check">
          <input type="checkbox" checked={useOwn} onChange={(e) => setUseOwn(e.target.checked)} /> This repository ({repoName}) uses its own prompt
        </label>
        {useOwn && (
          <>
            <input className="field" aria-label="Name of this repository's prompt" maxLength={MAX_PROMPT_NAME} value={mine.name} onChange={(e) => setMine({ ...mine, name: e.target.value })} />
            <textarea className="field" aria-label="Text of this repository's prompt" rows={4} maxLength={MAX_PROMPT_TEXT} value={mine.text} onChange={(e) => setMine({ ...mine, text: e.target.value })} />
          </>
        )}
      </section>
      <div className="lbl-row">
        <b>All repositories</b>
        <span className="grow" />
        <button type="button" className="btn sm" disabled={list.length >= MAX_PROMPTS} onClick={() => setList([...list, { name: `Prompt ${list.length + 1}`, text: '' }])}>
          Add prompt
        </button>
      </div>
      {list.map((p, i) => (
        <section key={i} className="prompt-card">
          <div className="lbl-row">
            <input className="field grow" aria-label={`Name of prompt ${i + 1}`} maxLength={MAX_PROMPT_NAME} value={p.name} onChange={(e) => set(i, { name: e.target.value })} />
            {i === 0 ? (
              <span className="badge blue">Default</span>
            ) : (
              <button type="button" className="btn sm" onClick={() => setList([p, ...list.filter((_, j) => j !== i)])}>
                Make default
              </button>
            )}
            {list.length > 1 && (
              <button type="button" className="btn sm" aria-label={`Remove prompt ${i + 1}`} onClick={() => setList(list.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
          <textarea className="field" aria-label={`Text of prompt ${i + 1}`} rows={3} maxLength={MAX_PROMPT_TEXT} value={p.text} onChange={(e) => set(i, { text: e.target.value })} />
        </section>
      ))}
      {problem && <div className="note err">{problem}</div>}
      <span className="note">Stored in GitRep on this computer, not in the repository. Claude keeps its own output format whatever a prompt says.</span>
    </Dialog>
  )
}
