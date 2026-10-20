import { createContext, useContext } from 'react'

export type ToastKind = 'error' | 'info'
// A button in the toast, e.g. "Redo" after an undo.
export interface ToastAction {
  label: string
  run: () => void
}
export type Notify = (kind: ToastKind, text: string, action?: ToastAction) => void

export const ToastContext = createContext<Notify>(() => undefined)
export const useToast = (): Notify => useContext(ToastContext)
