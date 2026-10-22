import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

interface DialogProps {
  title: string
  submit: string
  busy?: boolean
  canSubmit?: boolean
  onSubmit: () => void
  onClose: () => void
  children: ReactNode
  wide?: boolean
  foot?: ReactNode // at the left of the buttons
  cancel?: boolean // false: the submit button alone closes it
}

// Modal form on the native <dialog> (focus trap, Escape, backdrop). Electron has no window.prompt.
export function Dialog({ title, submit, busy = false, canSubmit = true, onSubmit, onClose, children, wide = false, foot, cancel = true }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const d = ref.current
    d?.showModal()
    return () => d?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (canSubmit && !busy) onSubmit()
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="dialog-actions">
          {foot && <span className="dialog-foot">{foot}</span>}
          {cancel && (
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn-primary" disabled={!canSubmit || busy}>
            {busy && <span className="spin" />}
            {submit}
          </button>
        </div>
      </form>
    </dialog>
  )
}

interface PromptProps {
  title: string
  label: string
  submit: string
  textarea?: string // label of an optional multi-line field
  checkbox?: string // label of an optional checkbox, ticked by default
  onSubmit: (text: string, long: string, checked: boolean) => Promise<boolean> // true closes the dialog
  onClose: () => void
}

export function PromptDialog({ title, label, submit, textarea, checkbox, onSubmit, onClose }: PromptProps) {
  const [text, setText] = useState('')
  const [long, setLong] = useState('')
  const [checked, setChecked] = useState(true)
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true)
    const ok = await onSubmit(text.trim(), long, checked)
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog title={title} submit={submit} busy={busy} canSubmit={text.trim() !== ''} onSubmit={() => void send()} onClose={onClose}>
      <label className="dialog-field">
        {label}
        <input className="field" autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {textarea && (
        <label className="dialog-field">
          {textarea}
          <textarea className="field" rows={3} value={long} onChange={(e) => setLong(e.target.value)} />
        </label>
      )}
      {checkbox && (
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {checkbox}
        </label>
      )}
    </Dialog>
  )
}

interface ConfirmProps {
  title: string
  body: string
  submit: string
  checkbox?: string // label of an optional checkbox, ticked by default
  onSubmit: (checked: boolean) => void
  onClose: () => void
}

export function ConfirmDialog({ title, body, submit, checkbox, onSubmit, onClose }: ConfirmProps) {
  const [checked, setChecked] = useState(true)
  return (
    <Dialog title={title} submit={submit} onSubmit={() => (onClose(), onSubmit(checked))} onClose={onClose}>
      <p className="dialog-body">{body}</p>
      {checkbox && (
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {checkbox}
        </label>
      )}
    </Dialog>
  )
}
