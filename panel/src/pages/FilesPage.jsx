import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Files from '../components/Files.jsx'

const enc = (p) => p.split('/').map(encodeURIComponent).join('/')

// /files/<caminho relativo a /root> — a URL e a fonte da verdade
export default function FilesPage({ onFlash }) {
  const { '*': raw = '' } = useParams()
  const navigate = useNavigate()
  const cur = raw.replace(/^\/+|\/+$/g, '')
  const go = useCallback((p) => navigate('/files' + (p ? '/' + enc(p) : '')), [navigate])
  return <Files path={cur} onNavigate={go} onFlash={onFlash} />
}
