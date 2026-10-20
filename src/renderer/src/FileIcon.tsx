import type { FileStatus } from '../../shared/types'
import { FILE_KINDS, fileKind, STATUS } from './fileTypes'
import { Icon } from './icons'

// The type icon of a file row, colored by --icon-<kind>.
export function FileIcon({ path }: { path: string }) {
  const kind = fileKind(path)
  const k = FILE_KINDS[kind]
  return (
    <span className={`ficon ${'glyph' in k && k.glyph.length > 2 ? 'long' : ''}`} style={{ color: `var(--icon-${kind})` }} aria-hidden="true">
      {'icon' in k ? <Icon name={k.icon} size={14} stroke={2} /> : k.glyph}
    </span>
  )
}

// The change status of a file row: a colored letter, spelled out in the tooltip.
export function StatusBadge({ status }: { status: FileStatus }) {
  const s = STATUS[status]
  return (
    <span className={`st st-${s.tone}`} title={s.title} role="img" aria-label={s.title}>
      {s.letter}
    </span>
  )
}
