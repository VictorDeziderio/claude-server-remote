import { Fragment } from 'react'
import { t } from './i18n.js'
// Text with simple markup coming from the language file: **bold** and `code`.
// E.g. "Log in **Logs → Backup**" -> Log in <b>Logs → Backup</b>
export function TR({ k, vars }) {
  const parts = String(t(k, vars)).split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>
    return <Fragment key={i}>{p}</Fragment>
  })
}
