// Tiny Markdown renderer for chat bubbles: fenced code, headings, lists, quotes, tables, rules,
// inline code, bold, italic, strike, links and bare URLs. It builds React elements (never
// innerHTML), so the text cannot inject markup. Only http(s)/mailto links become anchors.
import React from 'react'

const SAFE_URL = /^(https?:\/\/|mailto:)/i
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_])|(~~[^~\n]+~~)|(\*[^*\s][^*\n]*\*(?![\w*]))|(_[^_\s][^_\n]*_(?!\w))/

const link = (href, children, key) =>
  SAFE_URL.test(href)
    ? <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-2 break-words">{children}</a>
    : <span key={key}>{children}</span>

export function inline(text, kp = 'i') {
  const out = []
  let rest = String(text ?? ''), n = 0
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) { out.push(rest); break }
    const s = m[0], key = `${kp}${n++}`
    // italic markers glued to a word (snake_case, 2*3*4) stay plain text; no lookbehind (older iOS)
    if ((m[6] || m[7]) && m.index > 0 && /[\w*]/.test(rest[m.index - 1])) {
      out.push(rest.slice(0, m.index + 1)); rest = rest.slice(m.index + 1); continue
    }
    if (m.index) out.push(rest.slice(0, m.index))
    if (m[1]) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-words">{s.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={key}>{inline(s.slice(2, -2), key)}</strong>)
    else if (m[3]) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(s)
      out.push(link(mm[2], inline(mm[1], key), key))
    } else if (m[4]) out.push(link(s, s, key))
    else if (m[5]) out.push(<del key={key}>{inline(s.slice(2, -2), key)}</del>)
    else out.push(<em key={key}>{inline(s.slice(1, -1), key)}</em>)
    rest = rest.slice(m.index + s.length)
  }
  return out
}

const withBreaks = (text, kp) => text.split('\n').flatMap((ln, i) => (i ? [<br key={`${kp}b${i}`} />, ...inline(ln, `${kp}l${i}`)] : inline(ln, `${kp}l${i}`)))
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

export function parseBlocks(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim()) { i++; continue }
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(l)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++ // closing fence (or end of text while streaming)
      blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l)
    if (h) { blocks.push({ type: 'h', level: h[1].length, text: h[2] }); i++; continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { blocks.push({ type: 'hr' }); i++; continue }
    if (/^\s*>/.test(l)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', text: body.join('\n') })
      continue
    }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l)
      const rows = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      blocks.push({ type: 'table', head, rows })
      continue
    }
    if (LIST.test(l)) {
      const ordered = /^\s*\d/.test(l)
      const items = []
      while (i < lines.length) {
        const m = LIST.exec(lines[i])
        if (m) { items.push({ depth: Math.min(3, Math.floor(m[1].length / 2)), text: m[3] }); i++ }
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].text += '\n' + lines[i].trim(); i++ }
        else break
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    const body = []
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~)/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !LIST.test(lines[i])) body.push(lines[i++])
    blocks.push({ type: 'p', text: body.join('\n') })
  }
  return blocks
}

const H = ['text-lg', 'text-base', 'text-base', 'text-sm', 'text-sm', 'text-sm']

export function Markdown({ text }) {
  const blocks = parseBlocks(text)
  return (
    <div className="md space-y-2 break-words [overflow-wrap:anywhere]">
      {blocks.map((b, k) => {
        if (b.type === 'code') return (
          <pre key={k} className="max-w-full overflow-x-auto rounded-lg bg-zinc-950 px-3 py-2 text-[13px] leading-relaxed text-zinc-100 [overflow-wrap:normal]"><code className="font-mono">{b.text}</code></pre>
        )
        if (b.type === 'h') return <div key={k} role="heading" aria-level={b.level} className={`${H[b.level - 1]} font-semibold`}>{inline(b.text, `h${k}`)}</div>
        if (b.type === 'hr') return <hr key={k} className="border-border" />
        if (b.type === 'quote') return <blockquote key={k} className="border-l-2 border-border pl-3 text-muted-foreground">{withBreaks(b.text, `q${k}`)}</blockquote>
        if (b.type === 'table') return (
          <div key={k} className="max-w-full overflow-x-auto">
            <table className="text-sm [overflow-wrap:normal]">
              <thead><tr>{b.head.map((c, j) => <th key={j} className="border-b border-border px-2 py-1 text-left font-semibold">{inline(c, `t${k}h${j}`)}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} className="border-b border-border/60 px-2 py-1 align-top">{inline(c, `t${k}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul'
          return (
            <Tag key={k} className={`${b.ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-5`}>
              {b.items.map((it, j) => <li key={j} style={it.depth ? { marginLeft: `${it.depth}rem` } : undefined}>{withBreaks(it.text, `l${k}i${j}`)}</li>)}
            </Tag>
          )
        }
        return <p key={k}>{withBreaks(b.text, `p${k}`)}</p>
      })}
    </div>
  )
}
