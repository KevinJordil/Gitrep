import { createHighlighterCore, type HighlighterCore, type LanguageInput, type ThemeRegistration } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { Hunk } from '../../shared/types'
import type { Lang } from './fileTypes'

export interface Token {
  text: string
  color?: string // a CSS color (a --syn-* variable); none: the line's own color
  italic?: boolean
}

// Diffs bigger than this are shown without colors: tokenizing them would stall the view.
export const MAX_HIGHLIGHT = 200_000 // characters

const PLAIN = 'var(--syn-plain)' // the theme's default color: such tokens are left uncolored

// Token colors are the theme's --syn-* variables (styles.css), so a theme change needs no code change.
const THEME: ThemeRegistration = {
  name: 'gitrep',
  type: 'dark',
  fg: PLAIN,
  bg: 'transparent',
  settings: [
    { scope: ['keyword', 'storage', 'entity.name.tag', 'markup.heading'], settings: { foreground: 'var(--syn-kw)' } },
    { scope: ['keyword.operator', 'punctuation'], settings: { foreground: PLAIN } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: 'var(--syn-com)', fontStyle: 'italic' } },
    { scope: ['string', 'punctuation.definition.string', 'markup.inline.raw'], settings: { foreground: 'var(--syn-str)' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: 'var(--syn-num)' } },
    {
      scope: ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'support.type', 'support.class', 'storage.type.built-in', 'storage.type.primitive', 'entity.other.attribute-name'],
      settings: { foreground: 'var(--syn-ty)' }
    },
    {
      scope: ['meta.preprocessor', 'keyword.control.directive', 'punctuation.definition.directive', 'entity.name.function.preprocessor', 'meta.annotation', 'storage.type.annotation'],
      settings: { foreground: 'var(--syn-pp)' }
    },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: 'var(--syn-fn)' } }
  ]
}

// One import per grammar, loaded the first time a diff of that language is shown.
const GRAMMARS: Record<Lang, () => LanguageInput> = {
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  vue: () => import('shiki/langs/vue.mjs')
}

let highlighter: Promise<HighlighterCore> | null = null
const loaded = new Map<Lang, Promise<void>>()

async function ready(lang: Lang): Promise<HighlighterCore> {
  // forgiving: a pattern the JavaScript engine cannot run leaves its text uncolored instead of failing.
  highlighter ??= createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) })
  const hl = await highlighter
  if (!loaded.has(lang)) loaded.set(lang, hl.loadLanguage(GRAMMARS[lang]()))
  await loaded.get(lang)
  return hl
}

// The tokens of each line of `code`.
export async function tokenize(code: string, lang: Lang): Promise<Token[][]> {
  const hl = await ready(lang)
  return hl.codeToTokensBase(code, { lang, theme: 'gitrep' }).map((line) =>
    line.map((t) => ({ text: t.content, ...(t.color && t.color !== PLAIN ? { color: t.color } : {}), ...((t.fontStyle ?? 0) & 1 ? { italic: true } : {}) }))
  )
}

export interface DiffSides {
  old: string[] // context and deleted lines, hunks in order
  new: string[] // context and added lines
  at: { side: 'old' | 'new'; line: number }[][] // per hunk, per diff line: where it is in old or new
}

// A diff line is colored within its own version of the file, so that a multi-line string or comment that spans
// unchanged and changed lines keeps its colors: deleted lines in the old text, the others in the new one.
export function diffSides(hunks: Hunk[]): DiffSides {
  const old: string[] = []
  const neu: string[] = []
  const at = hunks.map((h) =>
    h.lines.map((l) => {
      if (l.kind === 'del') return { side: 'old' as const, line: old.push(l.text) - 1 }
      if (l.kind === 'context') old.push(l.text)
      return { side: 'new' as const, line: neu.push(l.text) - 1 }
    })
  )
  return { old, new: neu, at }
}

// Tokens of every line of the hunks ([hunk][line]); null when the diff is too big. A line whose tokens do not spell
// its exact text (line-ending quirks) gets null and is shown plain.
export async function highlightDiff(hunks: Hunk[], lang: Lang): Promise<(Token[] | null)[][] | null> {
  const sides = diffSides(hunks)
  if (sides.old.join('\n').length + sides.new.join('\n').length > MAX_HIGHLIGHT) return null
  const [old, neu] = await Promise.all([
    sides.old.length ? tokenize(sides.old.join('\n'), lang) : [],
    sides.new.length ? tokenize(sides.new.join('\n'), lang) : []
  ])
  return sides.at.map((lines, h) =>
    lines.map(({ side, line }, i) => {
      const tokens = (side === 'old' ? old : neu)[line]
      return tokens && tokens.map((t) => t.text).join('') === hunks[h].lines[i].text ? tokens : null
    })
  )
}
