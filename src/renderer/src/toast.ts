import { createContext, useContext } from 'react'

export type ToastKind = 'error' | 'info'
export type Notify = (kind: ToastKind, text: string) => void

export const ToastContext = createContext<Notify>(() => undefined)
export const useToast = (): Notify => useContext(ToastContext)
