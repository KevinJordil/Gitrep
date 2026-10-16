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
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z'],
  search: ['M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'm20 20-4.5-4.5'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  discard: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  back: ['m15 6-6 6 6 6'],
  cloud: ['M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z'],
  tag: ['M3 12V4h8l10 10-8 8z'],
  check: ['m5 12 5 5 9-10'],
  warn: ['M12 3 2 20h20z', 'M12 10v4M12 17h.01'],
  target: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  eyeOff: ['M3 3l18 18', 'M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9', 'M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6'],
  up: ['m6 15 6-6 6 6'],
  down: ['m6 9 6 6 6-6'],
  copy: ['M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3']
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
      <rect x="1" y="1" width="22" height="22" rx="6" fill="#1a1e26" stroke="#252a34" />
      <path d="M8 6v12M8 12c0-3 3-4 8-4" stroke="#f5a524" strokeWidth="2" fill="none" strokeLinecap="round" />
      <circle cx="8" cy="18" r="2" fill="#6ea8ff" />
      <circle cx="16" cy="8" r="2" fill="#f5a524" />
    </svg>
  )
}
