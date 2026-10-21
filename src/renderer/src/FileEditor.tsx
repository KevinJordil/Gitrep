import { useCallback, useEffect, useRef, useState } from 'react'
import type { Compartment, RangeSet, StateEffectType } from '@codemirror/state'
import type { EditorView, GutterMarker } from '@codemirror/view'
import type { FileDiff } from '../../shared/types'
import { api } from './api'
import { errorText, splitPath } from './format'
import { langFor } from './fileTypes'
import { Dialog } from './Dialog'
import { setUnsaved } from './unsaved'
import { useToast } from './toast'

// Lines (1-based, in the new file) a diff adds or changes, and where it removes lines (the line after the removal).
export function changeMarks(diff: FileDiff | null | undefined): Marks {
  const add: number[] = []
  const del: number[] = []
  for (const h of diff?.hunks ?? []) {
    let removed = false
    for (const l of h.lines) {
      if (l.kind === 'del') removed = true
      else if (l.newNo !== null) {
        if (l.kind === 'add') add.push(l.newNo)
        else if (removed) del.push(l.newNo)
        removed = false
      }
    }
    if (removed) del.push(h.newStart + h.newLines)
  }
  return { add, del }
}

type Marks = { add: number[]; del: number[] }
type Cm = Awaited<ReturnType<typeof loadCm>>
// CodeMirror and its grammars are fetched when the first editor opens, not with the app.
const loadCm = async () => {
  const [state, view, commands, search, language, data, lezer] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
    import('@codemirror/search'),
    import('@codemirror/language'),
    import('@codemirror/language-data'),
    import('@lezer/highlight')
  ])
  return { state, view, commands, search, language, data, lezer }
}

// Theme and syntax colors come from the CSS tokens of the stylesheet.
function theme({ view, language, lezer }: Cm) {
  const t = lezer.tags
  const colors = language.HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self], color: 'var(--syn-kw)' },
    { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-ty)' },
    { tag: [t.string, t.regexp, t.special(t.string)], color: 'var(--syn-str)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-num)' },
    { tag: [t.comment, t.docComment], color: 'var(--syn-com)', fontStyle: 'italic' },
    { tag: [t.meta, t.processingInstruction], color: 'var(--syn-pp)' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--syn-fn)' },
    { tag: t.heading, color: 'var(--syn-kw)', fontWeight: '600' }
  ])
  const ui = view.EditorView.theme(
    {
      '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--panel)' },
      '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12.5px', lineHeight: '22px' },
      '.cm-content': { caretColor: 'var(--text)' },
      '.cm-cursor': { borderLeftColor: 'var(--text)' },
      '&.cm-focused': { outline: 'none' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--sel)' },
      '.cm-activeLine': { backgroundColor: 'var(--row-hover)' },
      '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--faint)', border: 'none' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--row-hover)', color: 'var(--text)' },
      '.cm-change-gutter': { width: '8px' },
      '.cm-chg': { width: '3px', height: '100%', backgroundColor: 'var(--green)' },
      '.cm-chg-del': { width: '0', height: '0', backgroundColor: 'transparent', borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: '5px solid var(--red)' },
      '.cm-panels': { backgroundColor: 'var(--overlay)', color: 'var(--text)', borderColor: 'var(--overlay-line)' },
      '.cm-panels input, .cm-panels button': { fontFamily: 'inherit', fontSize: '12px' },
      '.cm-textfield': { backgroundColor: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '4px' },
      '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '4px' },
      '.cm-panels label': { color: 'var(--muted)' },
      '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--amber) 30%, transparent)' },
      '.cm-searchMatch-selected': { backgroundColor: 'var(--amber)', color: 'var(--on-c)' }
    },
    { dark: true }
  )
  return [ui, language.syntaxHighlighting(colors)]
}

interface Props {
  repo: string
  path: string
  initial: string // the file as read from disk
  version: number // changes when the repository refreshed: the disk is looked at again
  gone: boolean // the file no longer has changes in git
  onSaved?: () => void
  onReload: () => void // re-read the file, dropping the edits
}

// Lines end with CRLF when the file has any, else with LF (a lone CR stays a character).
const separator = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

export function FileEditor({ repo, path, initial, version, gone, onSaved, onReload }: Props) {
  const notify = useToast()
  const host = useRef<HTMLDivElement>(null)
  const [cm, setCm] = useState<{ cm: Cm; view: EditorView } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [head, setHead] = useState<Marks | null>(null) // the file's changes against HEAD
  const [external, setExternal] = useState<string | null>(null) // the disk changed under unsaved edits: what it holds now
  const [keeping, setKeeping] = useState(false) // asking to confirm "Keep mine"
  const base = useRef(initial) // what the disk holds, as far as this editor knows
  const dirtyRef = useRef(false)
  const marks = useRef<StateEffectType<Marks> | null>(null) // sets the gutter marks
  const lock = useRef<Compartment | null>(null) // read-only while saving
  const sep = useRef<Compartment | null>(null) // line separator of the document
  const inflight = useRef<Promise<boolean> | null>(null) // the save in progress
  const saves = useRef(0) // saves finished so far
  const latest = useRef({ notify, onReload, onSaved, repo, path })
  latest.current = { notify, onReload, onSaved, repo, path }
  const saveRef = useRef<() => Promise<boolean>>(async () => false)

  useEffect(() => {
    let view: EditorView | undefined
    let alive = true
    void loadCm().then((m) => {
      if (!alive || !host.current) return
      const { state, view: v, commands, search } = m
      const setMarks = state.StateEffect.define<Marks>()
      class Bar extends v.GutterMarker {
        constructor(readonly del: boolean) {
          super()
        }
        toDOM() {
          const d = document.createElement('div')
          d.className = this.del ? 'cm-chg cm-chg-del' : 'cm-chg'
          return d
        }
      }
      const markers = state.StateField.define({
        create: () => state.RangeSet.empty as RangeSet<GutterMarker>,
        update(set, tr) {
          set = set.map(tr.changes)
          for (const e of tr.effects) {
            if (!e.is(setMarks)) continue
            const at = (n: number, del: boolean) => ({ n: Math.min(Math.max(n, 1), tr.state.doc.lines), del })
            const all = [...e.value.add.map((n) => at(n, false)), ...e.value.del.map((n) => at(n, true))].sort((a, b) => a.n - b.n)
            // One marker per line: a removal next to an added line shows the bar only.
            const seen = new Set<number>()
            set = state.RangeSet.of(
              all.filter((x) => (seen.has(x.n) ? false : (seen.add(x.n), true))).map((x) => new Bar(x.del).range(tr.state.doc.line(x.n).from)),
              true
            )
          }
          return set
        },
        provide: (f) => v.gutter({ class: 'cm-change-gutter', markers: (view) => view.state.field(f) })
      })
      marks.current = setMarks
      const readOnly = new state.Compartment()
      lock.current = readOnly
      const separatorSlot = new state.Compartment()
      sep.current = separatorSlot
      const languageSlot = new state.Compartment()
      const save = () => {
        void saveRef.current()
        return true
      }
      view = new v.EditorView({
        parent: host.current,
        state: state.EditorState.create({
          doc: initial,
          extensions: [
            separatorSlot.of(state.EditorState.lineSeparator.of(separator(initial))),
            v.lineNumbers(),
            v.highlightActiveLine(),
            v.highlightActiveLineGutter(),
            v.drawSelection(),
            commands.history(),
            search.search({ top: true }),
            v.keymap.of([{ key: 'Mod-s', run: save, preventDefault: true }, ...search.searchKeymap, ...commands.historyKeymap, ...commands.defaultKeymap, commands.indentWithTab]),
            markers,
            theme(m),
            v.EditorView.contentAttributes.of({ 'aria-label': `Edit ${splitPath(path)[1]}` }),
            readOnly.of(state.EditorState.readOnly.of(false)),
            languageSlot.of([]),
            v.EditorView.updateListener.of((u) => {
              if (!u.docChanged) return
              const now = u.state.sliceDoc() !== base.current
              if (now !== dirtyRef.current) setDirty((dirtyRef.current = now))
            })
          ]
        })
      })
      // Grammar of the file; a file without one stays plain.
      const desc = m.language.LanguageDescription.matchFilename(m.data.languages, splitPath(path)[1]) ?? (langFor(path) ? m.language.LanguageDescription.matchLanguageName(m.data.languages, langFor(path)!, true) : null)
      void desc?.load().then(
        (support) => alive && view?.dispatch({ effects: languageSlot.reconfigure(support) }),
        () => undefined
      )
      view.focus()
      setCm({ cm: m, view })
    })
    return () => {
      alive = false
      view?.destroy()
      setUnsaved(latest.current.repo, null)
    }
    // The editor opens once per file content: reloading remounts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Puts `text` in the editor as the new disk content (silently when it is not an edit of the user: no undo step).
  const replace = useCallback(
    (text: string, asEdit: boolean) => {
      if (!cm) return
      base.current = text
      cm.view.dispatch({ effects: sep.current?.reconfigure(cm.cm.state.EditorState.lineSeparator.of(separator(text))) })
      cm.view.dispatch({ changes: { from: 0, to: cm.view.state.doc.length, insert: text }, annotations: asEdit ? [] : cm.cm.state.Transaction.addToHistory.of(false) })
      const now = cm.view.state.sliceDoc() !== text
      setDirty((dirtyRef.current = now))
      setExternal(null)
    },
    [cm]
  )

  // On each refresh: what the disk holds now. A clean editor follows it, one with edits says so.
  useEffect(() => {
    if (!cm) return
    let alive = true
    const done = saves.current
    api.readWorkingFile(repo, path).then(
      (r) => {
        if ('reason' in r || !alive || inflight.current || done !== saves.current) return // a save is changing the disk
        if (r.text === base.current) return setExternal(null)
        if (!dirtyRef.current) return replace(r.text, false)
        if (cm.view.state.sliceDoc() === r.text) return replace(r.text, false)
        setExternal(r.text)
      },
      () => undefined
    )
    // The editor itself is not a dependency of the refresh.
    return () => {
      alive = false
    }
  }, [cm, repo, path, version, replace])

  // The file's changes against HEAD, for the gutter.
  useEffect(() => {
    let alive = true
    api.headDiff(repo, path).then((d) => alive && setHead(changeMarks(d)), () => undefined)
    return () => {
      alive = false
    }
  }, [repo, path, version])

  // The gutter follows HEAD, unless unsaved edits moved the lines; it comes back when the editor is clean again.
  useEffect(() => {
    if (!cm || dirty || !head || !marks.current) return
    cm.view.dispatch({ effects: marks.current.of(head) })
  }, [cm, head, dirty])

  const save = (): Promise<boolean> => {
    if (inflight.current) return inflight.current
    if (!cm || !dirtyRef.current) return Promise.resolve(true)
    const text = cm.view.state.sliceDoc()
    const l = latest.current
    setSaving(true)
    const setReadOnly = (on: boolean) => cm.view.dispatch({ effects: lock.current?.reconfigure(cm.cm.state.EditorState.readOnly.of(on)) })
    setReadOnly(true)
    inflight.current = (async () => {
      try {
        await api.saveWorkingFile(l.repo, l.path, text, base.current)
        base.current = text
        setDirty((dirtyRef.current = false))
        setExternal(null)
        l.onSaved?.()
        l.notify('info', `Saved ${splitPath(l.path)[1]}`)
        return true
      } catch (e) {
        l.notify('error', errorText(e), { label: 'Reload from disk', run: l.onReload })
        return false
      } finally {
        saves.current++
        inflight.current = null
        setReadOnly(false)
        setSaving(false)
      }
    })()
    return inflight.current
  }
  saveRef.current = save

  // The guard of the other views asks this editor to save before they leave.
  useEffect(() => {
    setUnsaved(repo, dirty ? { path, save: () => saveRef.current() } : null)
  }, [repo, path, dirty])

  const revert = () => cm?.view.dispatch({ changes: { from: 0, to: cm.view.state.doc.length, insert: base.current } })
  // "Keep mine": what the disk holds now becomes the base, so Save overwrites it knowingly.
  const keepMine = () => {
    if (!cm || external === null) return
    base.current = external
    const now = cm.view.state.sliceDoc() !== external
    setDirty((dirtyRef.current = now))
    setExternal(null)
    setKeeping(false)
  }

  return (
    <div className="editor">
      <div className="editor-bar">
        {dirty && (
          <span className="unsaved">
            <span className="dot" /> Unsaved
          </span>
        )}
        <div className="grow" />
        <button className="head-btn" disabled={!dirty || saving} onClick={revert}>
          Revert edits
        </button>
        <button className="btn-primary" style={{ height: 28 }} disabled={!dirty || saving} onClick={() => void save()}>
          {saving && <span className="spin" />}
          Save
        </button>
      </div>
      {gone && <div className="banner editor-banner">This file no longer has changes in git: your edits are kept here; Save writes them back.</div>}
      {external !== null && (
        <div className="banner editor-banner">
          <span>Changed on disk: the file was modified outside this editor.</span>
          <div className="grow" />
          <button className="head-btn" onClick={() => replace(external, true)}>
            Reload (lose my edits)
          </button>
          <button className="head-btn" onClick={() => setKeeping(true)}>
            Keep mine
          </button>
        </div>
      )}
      {keeping && (
        <Dialog title="Overwrite the newer version on disk?" submit="Keep mine" onSubmit={keepMine} onClose={() => setKeeping(false)}>
          <p className="note">Saving will replace what the file holds on disk now with your version.</p>
        </Dialog>
      )}
      <div className="editor-host" ref={host} />
    </div>
  )
}
