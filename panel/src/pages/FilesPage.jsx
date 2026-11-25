import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Files from '../components/Files.jsx'

const enc = (p) => p.split('/').map(encodeURIComponent).join('/')

// /files/<path relative to /root> — the URL is the source of truth
export default function FilesPage({ onFlash }) {
  const { '*': raw = '' } = useParams()
  const navigate = useNavigate()
  const cur = raw.replace(/^\/+|\/+$/g, '')
  const go = useCallback((p) => navigate('/files' + (p ? '/' + enc(p) : '')), [navigate])
  return <Files path={cur} onNavigate={go} onFlash={onFlash} />
}
