import type { DragEvent } from 'react'
import type { Branch } from '../../shared/types'

const MIME = 'application/x-gitrep-branch'

export type DropBranch = (source: Branch, target: Branch, x: number, y: number) => void

// Native HTML5 drag and drop: branch pills (graph) and sidebar branches drag; local branches accept drops.
export function dragBranch(b: Branch) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(MIME, JSON.stringify({ name: b.name, remote: b.remote }))
      e.dataTransfer.effectAllowed = 'move'
    }
  }
}

export function dropOnBranch(target: Branch, branches: Branch[], onDrop: DropBranch) {
  const mark = (e: DragEvent, on: boolean) => (e.currentTarget as HTMLElement).classList.toggle('drop-over', on)
  return {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      mark(e, true)
    },
    onDragLeave: (e: DragEvent) => mark(e, false),
    onDrop: (e: DragEvent) => {
      mark(e, false)
      const raw = e.dataTransfer.getData(MIME)
      if (!raw) return
      e.preventDefault()
      const { name, remote } = JSON.parse(raw) as { name: string; remote: boolean }
      const source = branches.find((b) => b.name === name && b.remote === remote)
      if (source && source !== target) onDrop(source, target, e.clientX, e.clientY)
    }
  }
}
