import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

// Code editor (CodeMirror 6): highlighting by extension (loaded on demand), line
// numbers, search (Ctrl+F), multi-cursor, folding, Tab indents. Loaded via React.lazy so it does not
// weigh on the initial bundle. Controlled: external `value`, `onChange(text)`.
export default function CodeEditor({ value, onChange, filename = '', readOnly = false, onSave }) {
  const boxRef = useRef(null)
  const viewRef = useRef(null)
  const langComp = useRef(new Compartment())
  const roComp = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  useEffect(() => { onChangeRef.current = onChange; onSaveRef.current = onSave }, [onChange, onSave])

  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup, oneDark,
          keymap.of([indentWithTab, { key: 'Mod-s', run: () => { onSaveRef.current?.(); return true } }]),
          langComp.current.of([]),
          roComp.current.of(EditorState.readOnly.of(readOnly)),
          EditorView.updateListener.of((u) => { if (u.docChanged) onChangeRef.current?.(u.state.doc.toString()) }),
          EditorView.theme({ '&': { backgroundColor: '#0b0d12' } }),
        ],
      }),
      parent: boxRef.current,
    })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // external value changed (opened another file / reloaded) -> replaces the doc without losing the view
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur !== value) view.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: roComp.current.reconfigure(EditorState.readOnly.of(readOnly)) })
  }, [readOnly])

  // language by file name (loaded on demand)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    let alive = true
    const desc = LanguageDescription.matchFilename(languages, filename || '')
    if (!desc) { view.dispatch({ effects: langComp.current.reconfigure([]) }); return undefined }
    desc.load().then((lang) => { if (alive && viewRef.current) viewRef.current.dispatch({ effects: langComp.current.reconfigure(lang) }) }).catch(() => {})
    return () => { alive = false }
  }, [filename])

  return <div ref={boxRef} className="h-full min-h-0 w-full overflow-hidden" />
}
