import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

// Editor de codigo (CodeMirror 6): highlight por extensao (carregado sob demanda), numeros de
// linha, busca (Ctrl+F), multi-cursor, dobra, Tab indenta. Carregado via React.lazy pra nao
// pesar o bundle inicial. Controlado: `value` externo, `onChange(texto)`.
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

  // valor externo mudou (abriu outro arquivo / recarregou) -> substitui o doc sem perder o view
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

  // linguagem por nome de arquivo (carregamento sob demanda)
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
