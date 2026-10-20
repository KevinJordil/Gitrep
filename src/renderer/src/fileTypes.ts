import type { FileStatus } from '../../shared/types'
import type { IconName } from './icons'

// What a file is, from its name: the icon of its rows and the grammar of its diffs (a Shiki language id).
// glyph: short text drawn as the icon; icon: an Icon instead. The color is the CSS variable --icon-<kind>.
export const FILE_KINDS = {
  c: { glyph: 'C', lang: 'c' },
  h: { glyph: 'H', lang: 'cpp' }, // C or C++: the C++ grammar reads both
  cpp: { glyph: 'C++', lang: 'cpp' },
  hpp: { glyph: 'H++', lang: 'cpp' },
  java: { glyph: 'J', lang: 'java' },
  kotlin: { glyph: 'K', lang: 'kotlin' },
  js: { glyph: 'JS', lang: 'javascript' },
  ts: { glyph: 'TS', lang: 'typescript' },
  jsx: { glyph: 'JSX', lang: 'jsx' },
  tsx: { glyph: 'TSX', lang: 'tsx' },
  python: { glyph: 'PY', lang: 'python' },
  go: { glyph: 'GO', lang: 'go' },
  rust: { glyph: 'RS', lang: 'rust' },
  shell: { glyph: '$_', lang: 'shellscript' },
  json: { glyph: '{}', lang: 'json' },
  yaml: { glyph: 'YML', lang: 'yaml' },
  toml: { glyph: 'TML', lang: 'toml' },
  xml: { glyph: '</>', lang: 'xml' },
  html: { glyph: '<>', lang: 'html' },
  css: { glyph: '#', lang: 'css' },
  sql: { glyph: 'SQL', lang: 'sql' },
  markdown: { glyph: 'M↓', lang: 'markdown' },
  text: { glyph: '≡', lang: null },
  cmake: { glyph: 'CM', lang: 'cmake' },
  make: { glyph: 'MK', lang: 'makefile' },
  docker: { icon: 'box', lang: 'dockerfile' },
  image: { icon: 'image', lang: null },
  pdf: { glyph: 'PDF', lang: null },
  archive: { icon: 'archive', lang: null },
  lock: { icon: 'lock', lang: null },
  git: { icon: 'branch', lang: null },
  license: { glyph: '©', lang: null },
  groovy: { glyph: 'GR', lang: 'groovy' },
  ini: { glyph: 'INI', lang: 'ini' },
  env: { glyph: 'ENV', lang: null },
  config: { glyph: 'CF', lang: null },
  csharp: { glyph: 'C#', lang: 'csharp' },
  ruby: { glyph: 'RB', lang: 'ruby' },
  php: { glyph: 'PHP', lang: 'php' },
  swift: { glyph: 'SW', lang: 'swift' },
  vue: { glyph: 'V', lang: 'vue' },
  file: { icon: 'file', lang: null }
} satisfies Record<string, { glyph?: string; icon?: IconName; lang: string | null }>

export type FileKind = keyof typeof FILE_KINDS
export type Lang = NonNullable<(typeof FILE_KINDS)[FileKind]['lang']>

const BY_NAME: Record<string, FileKind> = {
  'cmakelists.txt': 'cmake',
  makefile: 'make',
  gnumakefile: 'make',
  dockerfile: 'docker',
  containerfile: 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  license: 'license',
  licence: 'license',
  'license.md': 'license',
  'license.txt': 'license',
  copying: 'license',
  'package-lock.json': 'lock',
  'pnpm-lock.yaml': 'lock',
  'go.sum': 'lock',
  jenkinsfile: 'groovy'
}

const BY_EXT: Record<string, FileKind> = {
  c: 'c', h: 'h',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'hpp', hh: 'hpp', hxx: 'hpp',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', mts: 'ts', cts: 'ts', jsx: 'jsx', tsx: 'tsx',
  py: 'python', pyi: 'python', go: 'go', rs: 'rust',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  json: 'json', jsonc: 'json', json5: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', xsd: 'xml', svg: 'image',
  html: 'html', htm: 'html', css: 'css', scss: 'css', sass: 'css', less: 'css', sql: 'sql',
  md: 'markdown', markdown: 'markdown', rst: 'text', txt: 'text', adoc: 'text', asciidoc: 'text',
  cmake: 'cmake', mk: 'make', mak: 'make', dockerfile: 'docker',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image',
  pdf: 'pdf',
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', '7z': 'archive', rar: 'archive', jar: 'archive',
  lock: 'lock',
  gradle: 'groovy', properties: 'ini', ini: 'ini', env: 'env', dockerignore: 'config', editorconfig: 'config',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', vue: 'vue'
}

export function fileKind(path: string): FileKind {
  const name = (path.endsWith('/') ? path.slice(0, -1) : path).split('/').pop()!.toLowerCase()
  if (Object.hasOwn(BY_NAME, name)) return BY_NAME[name]
  if (name.startsWith('license-')) return 'license'
  if (name.startsWith('.env.')) return 'env'
  if (name.startsWith('dockerfile.') || name.startsWith('makefile.')) return name[0] === 'd' ? 'docker' : 'make'
  const dot = name.lastIndexOf('.')
  const ext = name.slice(dot + 1)
  return dot >= 0 && Object.hasOwn(BY_EXT, ext) ? BY_EXT[ext] : 'file'
}

export const langFor = (path: string): Lang | null => FILE_KINDS[fileKind(path)].lang

export type StatusTone = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

// The badge next to a changed file: letter, tooltip and color (CSS variable --status-<tone>).
export const STATUS: Record<FileStatus, { letter: string; title: string; tone: StatusTone }> = {
  A: { letter: 'A', title: 'Added', tone: 'added' },
  C: { letter: 'A', title: 'Added (copy)', tone: 'added' },
  M: { letter: 'M', title: 'Modified', tone: 'modified' },
  T: { letter: 'M', title: 'Modified (type changed)', tone: 'modified' },
  D: { letter: 'D', title: 'Deleted', tone: 'deleted' },
  R: { letter: 'R', title: 'Renamed', tone: 'renamed' },
  '?': { letter: 'U', title: 'Untracked', tone: 'untracked' },
  U: { letter: '!', title: 'Conflicted', tone: 'conflicted' }
}
