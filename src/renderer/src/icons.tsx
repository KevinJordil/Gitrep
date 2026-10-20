const PATHS = {
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  close: ['M6 6l12 12M18 6 6 18'],
  fetch: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  pull: ['M12 4v12', 'm6 10 6 6 6-6', 'M5 20h14'],
  push: ['M12 20V8', 'm6 14 6-6 6 6', 'M5 4h14'],
  branch: ['M6 3v18', 'M18 9a6 6 0 0 1-6 6H6', 'M18 3v6'],
  code: ['m8 7-5 5 5 5', 'm16 7 5 5-5 5'],
  terminal: ['m5 7 5 5-5 5', 'M12 19h7'],
  sliders: ['M4 7h10M18 7h2M4 17h2M10 17h10', 'M16 5v4M8 15v4'],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z'],
  search: ['M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'm20 20-4.5-4.5'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  discard: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  back: ['m15 6-6 6 6 6'],
  cloud: ['M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z'],
  tag: ['M3 12V4h8l10 10-8 8z'],
  check: ['m5 12 5 5 9-10'],
  warn: ['M12 3 2 20h20z', 'M12 10v4M12 17h.01'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
  image: ['M4 5h16v14H4z', 'm4 16 5-5 4 4 3-3 4 4', 'M15 9h.01'],
  archive: ['M4 4h16v4H4z', 'M5 8v12h14V8', 'M10 12h4'],
  lock: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0v3'],
  box: ['M12 3 3 8v8l9 5 9-5V8z', 'M3 8l9 5 9-5', 'M12 13v8'],
  stash: ['M3 5h18v4H3z', 'M5 9v10h14V9', 'M10 13h4'],
  pop: ['M5 9v10h14V9', 'M12 16V4', 'm8 8 4-4 4 4'],
  merge: ['M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 0 6-6V3', 'M12 15v6'],
  rebase: ['M6 3v18', 'M18 6a6 6 0 0 1-6 6H6'],
  ff: ['M5 5l7 7-7 7', 'M12 5l7 7-7 7'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  target: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  eyeOff: ['M3 3l18 18', 'M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9', 'M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6'],
  up: ['m6 15 6-6 6 6'],
  down: ['m6 9 6 6 6-6'],
  copy: ['M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'],
  undo: ['M9 14 4 9l5-5', 'M4 9h11a5 5 0 0 1 0 10h-3'],
  redo: ['m15 14 5-5-5-5', 'M20 9H9a5 5 0 0 0 0 10h3'],
  trash: ['M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  rebaseI: ['M4 6h16M4 12h10M4 18h6', 'M17 15l3 3-3 3'],
  wand: ['m4 20 11-11', 'm14 5 5 5', 'M19 3v3M17.5 4.5h3', 'M5 4v2M4 5h2'],
  grip: ['M9 6h.01M9 12h.01M9 18h.01', 'M15 6h.01M15 12h.01M15 18h.01']
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, stroke = 1.8 }: { name: IconName; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

export function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--raised)" stroke="var(--line)" />
      <path d="M8 6v12M8 12c0-3 3-4 8-4" stroke="var(--amber)" strokeWidth="2" fill="none" strokeLinecap="round" />
      <circle cx="8" cy="18" r="2" fill="var(--accent)" />
      <circle cx="16" cy="8" r="2" fill="var(--amber)" />
    </svg>
  )
}
