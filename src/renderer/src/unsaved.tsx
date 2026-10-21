import { useCallback, useState, type ReactNode } from 'react'
import { Dialog } from './Dialog'

// The editor with unsaved changes of each repository (at most one per repo): its file and how to save it.
export interface Unsaved {
  path: string
  save: () => Promise<boolean> // true when saved
}
const open = new Map<string, Unsaved>()
export const setUnsaved = (repo: string, u: Unsaved | null) => void (u ? open.set(repo, u) : open.delete(repo))

// guard(repo, next) runs `next` now, or after the user saved or discarded the unsaved edits of that repo.
// Render `dialog` somewhere in the component.
export function useLeaveGuard(): { guard: (repo: string, next: () => void) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<{ repo: string; unsaved: Unsaved; next: () => void } | null>(null)
  const [busy, setBusy] = useState(false)
  const guard = useCallback((repo: string, next: () => void) => {
    const unsaved = open.get(repo)
    if (unsaved) setPending({ repo, unsaved, next })
    else next()
  }, [])
  const leave = () => {
    const p = pending
    setPending(null)
    p?.next()
  }
  const dialog = pending && (
    <Dialog
      title={`Discard your unsaved edits to ${pending.unsaved.path}?`}
      submit="Save"
      busy={busy}
      onSubmit={() => {
        setBusy(true)
        void pending.unsaved.save().then((ok) => {
          setBusy(false)
          if (ok) leave()
          else setPending(null) // the error is in a toast; the editor stays open
        })
      }}
      onClose={() => setPending(null)}
      foot={
        <button type="button" className="btn" onClick={leave}>
          Discard
        </button>
      }
    >
      <p className="note">Your changes to this file have not been saved.</p>
    </Dialog>
  )
  return { guard, dialog }
}
