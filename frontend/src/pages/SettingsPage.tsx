import { useState, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { useAuthStore } from '../store/authStore'
import type { Stats, EmbeddingModel, Upload, SunoTeamMember } from '../types'

interface SyncScanResult {
  upload_id: string
  filename: string
  db_count: number
  qdrant_count: number
  missing: number
  orphans?: number
  status: 'scanned' | 'embedding' | 'done'
  embedded?: number
  deleted?: number
}

interface DeleteProgress {
  pct: number
  label: string
  type: 'info' | 'success' | 'error'
}

function UploadCard({
  upload,
  isAdmin,
  vdbName,
  onRefresh,
  onNeedApiKey,
}: {
  upload: Upload
  isAdmin: boolean
  vdbName: string
  onRefresh: () => void
  onNeedApiKey: () => void
}) {
  const [reembedProgress, setReembedProgress] = useState<{ pct: number; label: string; error?: string } | null>(null)
  const [reembedLoading, setReembedLoading] = useState(false)
  const [reembedPaused, setReembedPaused] = useState(false)
  const reembedPausedRef = useRef(false)
  const reembedAbortRef = useRef<AbortController | null>(null)
  const [confirmType, setConfirmType] = useState<'full' | 'sqlite' | 'embeddings' | null>(null)
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null)
  const [deleteMsg, setDeleteMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  const doReembed = async () => {
    if (reembedLoading) return
    const apiKey = localStorage.getItem('openai_api_key')
    if (!apiKey) { onNeedApiKey(); return }
    setReembedLoading(true)
    setReembedPaused(false)
    reembedPausedRef.current = false
    setReembedProgress({ pct: 5, label: `Connecting to ${vdbName}…` })

    const controller = new AbortController()
    reembedAbortRef.current = controller
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

    try {
      const response = await fetch(`/api/uploads/${encodeURIComponent(upload.id)}/reembed`, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: { 'X-OpenAI-Key': apiKey },
      })
      if (!response.ok) {
        let msg = `HTTP ${response.status}`
        try { const d = await response.json(); msg = d.error ?? d.message ?? msg } catch {}
        throw new Error(msg)
      }
      reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        while (reembedPausedRef.current && !controller.signal.aborted) {
          await new Promise(r => setTimeout(r, 100))
        }
        if (controller.signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let event: any
          try { event = JSON.parse(line.slice(6).trim()) } catch { continue }
          if (event.type === 'checking') {
            setReembedProgress({ pct: 15, label: `Checking ${vdbName} for existing vectors (${Number(event.total).toLocaleString()} messages)…` })
          } else if (event.type === 'embed_start') {
            const skipNote = event.skipped > 0 ? ` · ${Number(event.skipped).toLocaleString()} already in ${vdbName}` : ''
            setReembedProgress({ pct: 25, label: `Embedding ${Number(event.total).toLocaleString()} messages with ${event.model}…${skipNote}` })
          } else if (event.type === 'embed_progress') {
            const pct = 25 + (event.total > 0 ? Math.round((event.embedded / event.total) * 70) : 0)
            setReembedProgress({ pct, label: `Embedding: ${Number(event.embedded).toLocaleString()} / ${Number(event.total).toLocaleString()} vectors…` })
          } else if (event.type === 'done') {
            const skipNote = event.skipped > 0 ? ` · ${Number(event.skipped).toLocaleString()} already in ${vdbName}` : ''
            setReembedProgress({ pct: 100, label: `Done — ${Number(event.embedded).toLocaleString()} vectors embedded${skipNote}` })
            onRefresh()
            setTimeout(() => setReembedProgress(null), 4000)
          } else if (event.type === 'error') {
            throw new Error(String(event.message))
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        setReembedProgress({ pct: 0, label: 'Stopped' })
        setTimeout(() => setReembedProgress(null), 3000)
      } else {
        setReembedProgress({ pct: 0, label: 'Failed', error: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      try { reader?.cancel() } catch {}
      reembedAbortRef.current = null
      setReembedLoading(false)
      setReembedPaused(false)
      reembedPausedRef.current = false
    }
  }

  const pauseReembed = () => { reembedPausedRef.current = true; setReembedPaused(true) }
  const resumeReembed = () => { reembedPausedRef.current = false; setReembedPaused(false) }
  const stopReembed = () => { reembedAbortRef.current?.abort() }

  const doDelete = async (type: 'full' | 'sqlite' | 'embeddings') => {
    setConfirmType(null)
    setDeleteProgress({ pct: 0, label: 'Deleting…', type: 'info' })
    setDeleteMsg(null)
    const suffix = type === 'full' ? '' : `/${type}`
    try {
      const res = await apiFetch<{ deleted_messages?: number; deleted_vectors?: number }>(
        `/uploads/${encodeURIComponent(upload.id)}${suffix}`,
        { method: 'DELETE' },
      )
      setDeleteProgress({ pct: 100, label: 'Done', type: 'success' })
      const msg = type === 'sqlite'
        ? `Removed ${(res.deleted_messages ?? 0).toLocaleString()} messages from the database. ${vdbName} vectors untouched.`
        : type === 'embeddings'
          ? `Removed ${(res.deleted_vectors ?? 0).toLocaleString()} vectors from ${vdbName}. Database rows untouched.`
          : `Removed ${(res.deleted_messages ?? 0).toLocaleString()} messages and ${(res.deleted_vectors ?? 0).toLocaleString()} vectors.`
      setDeleteMsg({ text: msg, type: 'success' })
      setTimeout(() => onRefresh(), 1500)
    } catch (e) {
      setDeleteProgress({ pct: 100, label: 'Failed', type: 'error' })
      setDeleteMsg({ text: `Error: ${e instanceof Error ? e.message : String(e)}`, type: 'error' })
    }
  }

  const modelBadges = Object.entries(upload.embedded_models || {}).map(([mid, has]) => (
    <span key={mid} className={`embed-badge ${has ? 'embed-badge-yes' : 'embed-badge-no'}`}>
      {mid}
    </span>
  ))

  return (
    <div className="border border-gray-200 rounded-xl p-4 hover:border-indigo-200 transition-colors">
      {confirmType && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-3 text-sm">
          <p className="text-yellow-900 mb-2">
            {confirmType === 'sqlite'
              ? `Remove "${upload.filename}" messages from SQLite only. Embeddings will be preserved.`
              : confirmType === 'embeddings'
                ? `Remove all vector embeddings for "${upload.filename}". Messages in the database will be preserved.`
                : `Delete "${upload.filename}" and all its messages from both the database and the vector store?`}
          </p>
          <div className="flex gap-2">
            <button onClick={() => doDelete(confirmType)} className="action-btn-danger">Confirm Delete</button>
            <button onClick={() => setConfirmType(null)} className="action-btn-primary">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-gray-800 truncate">{upload.filename}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {Number(upload.row_count).toLocaleString()} rows &bull; Uploaded {upload.upload_time.slice(0, 19).replace('T', ' ')}
          </p>
          <p className="text-xs text-gray-400 font-mono mt-0.5">{upload.id}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">{modelBadges}</div>
        </div>

        {isAdmin && (
          <div className="flex flex-col gap-2 shrink-0">
            <button onClick={doReembed} disabled={reembedLoading} className="action-btn-primary">
              {reembedLoading ? 'Embedding…' : 'Re-embed'}
            </button>
            {reembedLoading && (
              <button onClick={reembedPaused ? resumeReembed : pauseReembed} className="action-btn-warning">
                {reembedPaused ? 'Resume' : 'Pause'}
              </button>
            )}
            {reembedLoading && (
              <button onClick={stopReembed} className="action-btn-danger">Stop</button>
            )}
            <button onClick={() => setConfirmType('embeddings')} disabled={reembedLoading} className="action-btn-warning">Delete Embedding</button>
            <button onClick={() => setConfirmType('sqlite')} className="action-btn-danger">Delete DB</button>
            <button onClick={() => setConfirmType('full')} className="action-btn-danger" style={{ borderColor: '#dc2626', fontWeight: 700 }}>Delete All</button>
          </div>
        )}
      </div>

      {reembedProgress && (
        <div className="mt-3">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${reembedProgress.pct}%` }} />
          </div>
          <p className="mt-1 text-xs text-gray-600">
            {reembedPaused && <span className="font-semibold text-amber-600 mr-1">[Paused]</span>}
            {reembedProgress.label}
          </p>
          {reembedProgress.error && (
            <pre className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
              {reembedProgress.error}
            </pre>
          )}
        </div>
      )}

      {deleteProgress && (
        <div className="mt-2">
          <div className="progress-track">
            <div className={`progress-fill ${deleteProgress.type === 'error' ? 'error' : ''}`} style={{ width: `${deleteProgress.pct}%` }} />
          </div>
        </div>
      )}
      {deleteMsg && (
        <div className={`mt-2 rounded-lg p-3 text-sm ${deleteMsg.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {deleteMsg.text}
        </div>
      )}
    </div>
  )
}

export default function SettingsPage() {
  const { user, appMode, setShowKeyModal, setShowHfTokenModal } = useAuthStore()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isAdmin = appMode !== 'multi' || user?.is_admin === true

  // Upload
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadProgress, setUploadProgress] = useState<{ pct: number; label: string; type: 'info' | 'success' | 'error' } | null>(null)
  const [uploadStatus, setUploadStatus] = useState('')
  const [uploadBtnLoading, setUploadBtnLoading] = useState(false)
  const [uploadPaused, setUploadPaused] = useState(false)
  const uploadPausedRef = useRef(false)
  const uploadAbortRef = useRef<AbortController | null>(null)

  const { data: stats } = useQuery<Stats>({
    queryKey: ['stats'],
    queryFn: () => apiFetch('/stats'),
  })

  const { data: models = [] } = useQuery<EmbeddingModel[]>({
    queryKey: ['embedding-models'],
    queryFn: () => apiFetch('/embedding-models'),
  })

  const { data: uploads = [], refetch: refetchUploads } = useQuery<Upload[]>({
    queryKey: ['uploads'],
    queryFn: () => apiFetch('/uploads'),
  })

  const { data: sunoTeam = [], refetch: refetchSuno } = useQuery<SunoTeamMember[]>({
    queryKey: ['suno-team'],
    queryFn: () => apiFetch('/suno-team'),
    enabled: isAdmin,
  })

  const handleUpload = async () => {
    if (!uploadFile) { setUploadStatus('Please select a CSV file.'); return }
    const apiKey = localStorage.getItem('openai_api_key')
    if (!apiKey) { setShowKeyModal(true); return }
    setUploadBtnLoading(true)
    setUploadPaused(false)
    uploadPausedRef.current = false
    setUploadProgress({ pct: 2, label: 'Uploading file…', type: 'info' })
    setUploadStatus('')
    const form = new FormData()
    form.append('file', uploadFile)
    const controller = new AbortController()
    uploadAbortRef.current = controller
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    try {
      const response = await fetch('/api/upload', { method: 'POST', body: form, credentials: 'include', signal: controller.signal, headers: { 'X-OpenAI-Key': apiKey } })
      if (!response.ok) {
        let msg = `HTTP ${response.status}`
        try { const d = await response.json(); msg = d.error ?? d.message ?? msg } catch {}
        throw new Error(msg)
      }
      reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        while (uploadPausedRef.current && !controller.signal.aborted) {
          await new Promise(r => setTimeout(r, 100))
        }
        if (controller.signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6).trim())
            if (event.type === 'progress') {
              // Insertion phase: 2% → 48%
              const pct = event.total > 0 ? Math.max(2, Math.round((event.inserted / event.total) * 48)) : 5
              const skipped = Number(event.skipped ?? 0)
              const skipNote = skipped > 0 ? ` · ${skipped.toLocaleString()} duplicate${skipped !== 1 ? 's' : ''} skipped` : ''
              setUploadProgress({ pct, label: `Inserting: ${Number(event.inserted).toLocaleString()} / ${Number(event.total).toLocaleString()} rows${skipNote}`, type: 'info' })
            } else if (event.type === 'embed_start') {
              // Embedding phase begins: 50%
              const alreadyEmb = Number(event.already_embedded ?? 0)
              const skipNote = alreadyEmb > 0 ? ` · ${alreadyEmb.toLocaleString()} already in ${vdbName}` : ''
              setUploadProgress({ pct: 50, label: `Embedding ${Number(event.total).toLocaleString()} new messages${skipNote} with ${event.model ?? 'text-embedding-3-small'}…`, type: 'info' })
            } else if (event.type === 'embed_progress') {
              // Embedding phase: 50% → 97%
              const pct = 50 + (event.total > 0 ? Math.round((event.embedded / event.total) * 47) : 0)
              setUploadProgress({ pct, label: `Embedding: ${Number(event.embedded).toLocaleString()} / ${Number(event.total).toLocaleString()} vectors…`, type: 'info' })
            } else if (event.type === 'embed_skip') {
              if (event.reason === 'all_already_embedded') {
                setUploadProgress({ pct: 97, label: `All ${Number(event.count).toLocaleString()} vectors already in ${vdbName} — nothing to embed`, type: 'info' })
              } else {
                setUploadProgress({ pct: 50, label: event.reason === 'no_api_key' ? 'No OpenAI API key — embedding skipped' : `${vdbName} unavailable — embedding skipped`, type: 'info' })
              }
            } else if (event.type === 'done') {
              const rowsNew = Number(event.total_inserted)
              const rowsSkip = Number(event.total_skipped ?? 0)
              const vecsNew = Number(event.embedded)
              const vecsOld = Number(event.already_embedded ?? 0)
              const rowNote = rowsSkip > 0 ? ` (${rowsSkip.toLocaleString()} duplicate${rowsSkip !== 1 ? 's' : ''} skipped)` : ''
              let embedMsg = ''
              if (vecsNew > 0 && vecsOld > 0) {
                embedMsg = ` · ${vecsNew.toLocaleString()} new + ${vecsOld.toLocaleString()} existing vectors (${event.embed_model})`
              } else if (vecsNew > 0) {
                embedMsg = ` · ${vecsNew.toLocaleString()} vectors embedded (${event.embed_model})`
              } else if (vecsOld > 0) {
                embedMsg = ` · ${vecsOld.toLocaleString()} vectors already in ${vdbName}`
              } else {
                embedMsg = ' · No vectors embedded'
              }
              setUploadProgress({ pct: 100, label: `Done! ${rowsNew.toLocaleString()} rows inserted${rowNote}${embedMsg}`, type: 'success' })
              refetchUploads()
              queryClient.invalidateQueries({ queryKey: ['stats'] })
            } else if (event.type === 'error') {
              setUploadProgress({ pct: 100, label: `Error: ${event.message}`, type: 'error' })
            }
          } catch { /* skip malformed lines */ }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        setUploadStatus('Upload cancelled.')
        setUploadProgress(null)
      } else {
        setUploadStatus(`Error: ${e instanceof Error ? e.message : String(e)}`)
        setUploadProgress(null)
      }
    } finally {
      try { reader?.cancel() } catch {}
      uploadAbortRef.current = null
      setUploadBtnLoading(false)
      setUploadPaused(false)
      uploadPausedRef.current = false
    }
  }

  const pauseUpload = () => { uploadPausedRef.current = true; setUploadPaused(true) }
  const resumeUpload = () => { uploadPausedRef.current = false; setUploadPaused(false) }
  const stopUpload = () => { uploadAbortRef.current?.abort() }

  const [sunoAddInput, setSunoAddInput] = useState('')
  const [sunoAddStatus, setSunoAddStatus] = useState<{ text: string; ok: boolean } | null>(null)
  const [sunoAddLoading, setSunoAddLoading] = useState(false)

  const handleAddSuno = async () => {
    const username = sunoAddInput.trim()
    if (!username) return
    setSunoAddLoading(true)
    setSunoAddStatus(null)
    try {
      const res = await apiFetch<{ updated: number }>(`/suno-team/${encodeURIComponent(username)}`, { method: 'POST' })
      setSunoAddStatus({ text: `Marked ${res.updated.toLocaleString()} messages by "${username}" as Suno Team.`, ok: true })
      setSunoAddInput('')
      refetchSuno()
    } catch (e) {
      setSunoAddStatus({ text: `Failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
    } finally {
      setSunoAddLoading(false)
    }
  }

  const handleRemoveSuno = async (username: string) => {
    try {
      await apiFetch(`/suno-team/${encodeURIComponent(username)}`, { method: 'DELETE' })
      refetchSuno()
    } catch (e) {
      alert(`Failed to remove: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const vdbName = stats?.vector_db_label ?? 'Qdrant'

  // Vector DB Maintenance (sync) state
  const [syncLoading, setSyncLoading] = useState(false)
  const [syncPhase, setSyncPhase] = useState<'idle' | 'scanning' | 'syncing' | 'done'>('idle')
  const [syncResults, setSyncResults] = useState<SyncScanResult[]>([])
  const [syncSummary, setSyncSummary] = useState<{ total_uploads: number; synced_uploads: number; total_embedded: number; total_deleted: number } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const syncAbortRef = useRef<AbortController | null>(null)

  const handleSyncVectors = async () => {
    if (syncLoading) return
    const apiKey = localStorage.getItem('openai_api_key')
    if (!apiKey) { setShowKeyModal(true); return }
    setSyncLoading(true)
    setSyncPhase('scanning')
    setSyncResults([])
    setSyncSummary(null)
    setSyncError(null)
    const controller = new AbortController()
    syncAbortRef.current = controller
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    try {
      const response = await fetch('/api/uploads/sync-qdrant', {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: { 'X-OpenAI-Key': apiKey },
      })
      if (!response.ok) {
        let msg = `HTTP ${response.status}`
        try { const d = await response.json(); msg = d.error ?? d.message ?? msg } catch {}
        throw new Error(msg)
      }
      reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        if (controller.signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let event: any
          try { event = JSON.parse(line.slice(6).trim()) } catch { continue }
          if (event.type === 'scan_result') {
            setSyncResults(prev => [...prev, {
              upload_id: event.upload_id,
              filename: event.filename,
              db_count: Number(event.db_count),
              qdrant_count: Number(event.qdrant_count),
              missing: Number(event.missing),
              orphans: Number(event.orphans ?? 0),
              status: 'scanned' as const,
            }])
          } else if (event.type === 'sync_start') {
            setSyncPhase('syncing')
          } else if (event.type === 'embed_start') {
            setSyncResults(prev => prev.map(r =>
              r.upload_id === event.upload_id ? { ...r, status: 'embedding' as const } : r
            ))
          } else if (event.type === 'embed_progress') {
            setSyncResults(prev => prev.map(r =>
              r.upload_id === event.upload_id ? { ...r, embedded: Number(event.embedded) } : r
            ))
          } else if (event.type === 'upload_done') {
            setSyncResults(prev => prev.map(r =>
              r.upload_id === event.upload_id
                ? { ...r, status: 'done' as const, embedded: Number(event.embedded), deleted: Number(event.deleted ?? 0) }
                : r
            ))
          } else if (event.type === 'done') {
            setSyncPhase('done')
            setSyncSummary({
              total_uploads: Number(event.total_uploads),
              synced_uploads: Number(event.synced_uploads),
              total_embedded: Number(event.total_embedded),
              total_deleted: Number(event.total_deleted ?? 0),
            })
            queryClient.invalidateQueries({ queryKey: ['stats'] })
            queryClient.invalidateQueries({ queryKey: ['uploads'] })
          } else if (event.type === 'error') {
            throw new Error(String(event.message))
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        setSyncError('Sync cancelled.')
      } else {
        setSyncError(e instanceof Error ? e.message : String(e))
      }
      setSyncPhase('idle')
    } finally {
      try { reader?.cancel() } catch {}
      syncAbortRef.current = null
      setSyncLoading(false)
    }
  }

  const stopSync = () => { syncAbortRef.current?.abort() }

  const hasLocalKey = !!localStorage.getItem('openai_api_key')
  const apiKeyStatus = (hasLocalKey || stats?.api_key_set)
    ? 'API key is set and active.'
    : 'No API key set. Click "Change Key" to add one.'

  const hasHfToken = !!localStorage.getItem('hf_token')

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 space-y-5">

      {/* Account section (multi mode only) */}
      {appMode === 'multi' && user && (
        <section className="bg-white rounded-2xl shadow p-5">
          <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide mb-4">Account</h2>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <div className="shrink-0 w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-base select-none">
                {user.username.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-sm text-gray-900 truncate">{user.username}</p>
                <p className="text-xs text-gray-500 mt-0.5">{user.is_admin ? 'Administrator' : 'User'}</p>
              </div>
            </div>
            <button
              onClick={async () => {
                try { await apiFetch('/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
                navigate('/login')
              }}
              className="shrink-0 flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 hover:border-red-300 transition-colors"
            >
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
              Log Out
            </button>
          </div>
        </section>
      )}

      {/* Embedding model — hidden in demo mode */}
      {appMode !== 'demo' && <section className="bg-white rounded-2xl shadow p-5">
        <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide mb-3">Embedding Model</h2>
        <div className="flex items-center gap-3 p-3 rounded-xl border border-indigo-100 bg-indigo-50">
          <svg className="w-5 h-5 text-indigo-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
          </svg>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-gray-800">text-embedding-3-small</span>
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#dbeafe', color: '#1e40af' }}>cloud</span>
              <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: '#ede9fe', color: '#5b21b6' }}>active</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">OpenAI text-embedding-3-small · 1536 dims</p>
            {models[0] && <p className="text-xs text-gray-400">{(models[0].vector_count || 0).toLocaleString()} uploads embedded</p>}
          </div>
        </div>
      </section>}

      {/* OpenAI API key */}
      <section className="bg-white rounded-2xl shadow p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide">OpenAI API Key</h2>
            <p className="text-xs text-gray-600 mt-1">{apiKeyStatus}</p>
            <p className="text-xs text-gray-400 mt-1.5 flex items-start gap-1">
              <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
              Stored in your browser's localStorage only — never sent to or saved on the server.
            </p>
          </div>
          <button onClick={() => setShowKeyModal(true)} className="shrink-0 px-4 py-2 text-sm font-semibold bg-indigo-700 text-white rounded-lg hover:bg-indigo-800 transition-colors">
            Change Key
          </button>
        </div>
      </section>

      {/* Hugging Face Token */}
      <section className="bg-white rounded-2xl shadow p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide">Hugging Face Token</h2>
            <p className="text-xs text-gray-600 mt-1">
              {hasHfToken ? 'Token is set and active.' : 'No token set — only public models are accessible.'}
            </p>
            <p className="text-xs text-gray-400 mt-1.5 flex items-start gap-1">
              <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              Stored in your browser's localStorage only. Also set <code className="bg-gray-100 px-1 rounded text-gray-700">HF_TOKEN</code> in your deployment env for the AI service to download gated models.
            </p>
          </div>
          <button
            onClick={() => setShowHfTokenModal(true)}
            className="shrink-0 px-4 py-2 text-sm font-semibold bg-[#ff7a00] text-white rounded-lg hover:bg-[#e06e00] transition-colors"
          >
            {hasHfToken ? 'Change Token' : 'Set Token'}
          </button>
        </div>
      </section>

      {/* Upload new CSV (admin only, hidden in demo mode) */}
      {isAdmin && appMode !== 'demo' && (
        <section className="bg-white rounded-2xl shadow p-5">
          <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide mb-3">Upload New CSV</h2>
          <p className="text-xs text-gray-600 mb-3">
            Required columns: <code className="bg-gray-100 text-gray-800 px-1 rounded">author_id, username, date, content</code>.
            Optional: <code className="bg-gray-100 text-gray-800 px-1 rounded">attachments, reactions, is_suno_team, week, month</code>.
          </p>
          <div className="flex flex-wrap gap-3 items-center">
            <label htmlFor="csv-file" className="sr-only">Choose CSV file</label>
            <input
              id="csv-file"
              type="file"
              accept=".csv"
              onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
              className="text-sm text-gray-700 file:mr-3 file:py-1.5 file:px-4 file:rounded-lg file:border-0 file:bg-indigo-100 file:text-indigo-800 file:font-semibold file:text-sm hover:file:bg-indigo-200 cursor-pointer"
            />
            <button
              onClick={handleUpload}
              disabled={uploadBtnLoading || !uploadFile}
              className="bg-indigo-700 text-white px-4 py-1.5 rounded-lg text-sm font-semibold hover:bg-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Upload &amp; Embed
            </button>
            {uploadBtnLoading && (
              <button
                onClick={uploadPaused ? resumeUpload : pauseUpload}
                className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200 transition-colors"
              >
                {uploadPaused ? 'Resume' : 'Pause'}
              </button>
            )}
            {uploadBtnLoading && (
              <button
                onClick={stopUpload}
                className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 transition-colors"
              >
                Stop
              </button>
            )}
          </div>
          {uploadStatus && <p className="mt-2 text-sm text-gray-500">{uploadStatus}</p>}
          {uploadProgress && (
            <div className="mt-3">
              <div className="progress-track">
                <div
                  className={`progress-fill ${uploadProgress.type === 'error' ? 'error' : ''}`}
                  style={{ width: `${uploadProgress.pct}%` }}
                />
              </div>
              <p className={`mt-2 text-xs ${uploadProgress.type === 'error' ? 'text-red-600' : uploadProgress.type === 'success' ? 'text-green-600' : 'text-gray-600'}`}>
                {uploadPaused && <span className="font-semibold text-amber-600 mr-1">[Paused]</span>}
                {uploadProgress.label} ({Math.round(uploadProgress.pct)}%)
              </p>
            </div>
          )}
        </section>
      )}

      {/* Active dataset — hidden in demo mode */}
      {appMode !== 'demo' && <section className="bg-white rounded-2xl shadow p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide">Active Dataset</h2>
          <button onClick={() => { refetchUploads(); queryClient.invalidateQueries({ queryKey: ['stats'] }) }} className="text-xs font-semibold text-indigo-700 hover:underline">Refresh</button>
        </div>
        {stats && (
          <div className="flex gap-4 mb-4 p-3 bg-gray-50 rounded-xl border border-gray-100 text-xs">
            <div className="flex-1 text-center">
              <p className="text-gray-500">Total messages</p>
              <p className="font-bold text-gray-900 text-base mt-0.5">{Number(stats.total_messages).toLocaleString()}</p>
            </div>
            <div className="w-px bg-gray-200" />
            <div className="flex-1 text-center">
              <p className="text-gray-500">Vectors in {vdbName}</p>
              <p className="font-bold text-indigo-700 text-base mt-0.5">{Number(stats.embedded_messages).toLocaleString()}</p>
            </div>
            <div className="w-px bg-gray-200" />
            <div className="flex-1 text-center">
              <p className="text-gray-500">Not embedded</p>
              {(() => {
                const missing = Number(stats.total_messages) - Number(stats.embedded_messages)
                return <p className={`font-bold text-base mt-0.5 ${missing > 0 ? 'text-amber-600' : 'text-green-600'}`}>{missing.toLocaleString()}</p>
              })()}
            </div>
          </div>
        )}
        <div className="space-y-3" aria-live="polite">
          {uploads.length === 0 ? (
            <p className="text-sm text-gray-600 text-center py-6">No dataset uploads yet.</p>
          ) : (
            uploads.map((u) => (
              <UploadCard key={u.id} upload={u} isAdmin={isAdmin} vdbName={vdbName} onRefresh={() => { refetchUploads(); queryClient.invalidateQueries({ queryKey: ['stats'] }) }} onNeedApiKey={() => setShowKeyModal(true)} />
            ))
          )}
        </div>
      </section>}

      {/* Vector DB Maintenance (multi-mode admins only) */}
      {appMode === 'multi' && user?.is_admin === true && (
        <section className="bg-white rounded-2xl shadow p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide">Vector DB Maintenance</h2>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Scans all uploads, embeds any messages missing from {vdbName}, and removes orphan vectors with no matching message. Safe to run at any time.
          </p>

          <div className="flex gap-2 mb-4 flex-wrap">
            <button
              onClick={handleSyncVectors}
              disabled={syncLoading}
              className="search-btn px-4 text-sm disabled:opacity-50"
            >
              {syncLoading
                ? (syncPhase === 'scanning' ? 'Scanning uploads…' : 'Syncing vectors…')
                : 'Analyze & Sync Vectors'}
            </button>
            {syncLoading && (
              <button onClick={stopSync} className="action-btn-danger">Cancel</button>
            )}
            {syncPhase === 'done' && !syncLoading && (
              <button
                onClick={() => { setSyncPhase('idle'); setSyncResults([]); setSyncSummary(null); setSyncError(null) }}
                className="action-btn-primary"
              >
                Clear
              </button>
            )}
          </div>

          {syncError && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              {syncError}
            </div>
          )}

          {syncSummary && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-xs text-green-800 font-medium">
              {syncSummary.total_embedded === 0 && syncSummary.total_deleted === 0
                ? `All ${syncSummary.total_uploads} upload${syncSummary.total_uploads !== 1 ? 's' : ''} fully synced — no issues found.`
                : `Sync complete · ${[
                    syncSummary.total_embedded > 0 ? `${syncSummary.total_embedded.toLocaleString()} new vectors embedded` : null,
                    syncSummary.total_deleted > 0 ? `${syncSummary.total_deleted.toLocaleString()} orphan vectors deleted` : null,
                  ].filter(Boolean).join(' · ')}`}
            </div>
          )}

          {syncResults.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-3 py-2 border-b border-gray-200">Upload</th>
                    <th className="px-3 py-2 border-b border-gray-200 text-right">DB messages</th>
                    <th className="px-3 py-2 border-b border-gray-200 text-right">{vdbName} vectors</th>
                    <th className="px-3 py-2 border-b border-gray-200 text-right">Missing</th>
                    <th className="px-3 py-2 border-b border-gray-200 text-right">Orphans</th>
                    <th className="px-3 py-2 border-b border-gray-200">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {syncResults.map((r) => (
                    <tr key={r.upload_id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 max-w-[180px] truncate text-xs font-medium text-gray-800" title={r.filename}>
                        {r.filename}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-gray-600">
                        {r.db_count.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-indigo-600">
                        {r.qdrant_count.toLocaleString()}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums text-xs font-semibold ${r.missing > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                        {r.missing.toLocaleString()}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums text-xs font-semibold ${(r.orphans ?? 0) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {(r.orphans ?? 0).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.status === 'embedding' ? (
                          <span className="text-indigo-600 font-medium">
                            Embedding{r.embedded != null ? ` ${r.embedded.toLocaleString()}/${r.missing.toLocaleString()}` : '…'}
                          </span>
                        ) : r.status === 'done' ? (
                          <span className="text-green-600 font-medium">
                            {[
                              r.embedded != null && r.embedded > 0 ? `✓ ${r.embedded.toLocaleString()} embedded` : null,
                              r.deleted != null && r.deleted > 0 ? `${r.deleted.toLocaleString()} deleted` : null,
                            ].filter(Boolean).join(' · ') || '✓ Synced'}
                          </span>
                        ) : r.missing === 0 && (r.orphans ?? 0) === 0 ? (
                          <span className="text-green-600">✓ Synced</span>
                        ) : (
                          <span className="text-amber-600">Pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Suno Team management (multi-mode admins only) */}
      {appMode === 'multi' && user?.is_admin === true && (
        <section className="bg-white rounded-2xl shadow p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide">Suno Team Members</h2>
            <button onClick={() => refetchSuno()} className="text-xs font-semibold text-indigo-700 hover:underline">Refresh</button>
          </div>
          <p className="text-xs text-gray-500 mb-4">Usernames flagged as Suno Team. Adding a user marks all their existing messages as team; removing reverses it.</p>

          {/* Add member */}
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={sunoAddInput}
              onChange={(e) => setSunoAddInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddSuno()}
              placeholder="Enter exact username…"
              className="search-input flex-1 text-sm"
            />
            <button
              onClick={handleAddSuno}
              disabled={sunoAddLoading || !sunoAddInput.trim()}
              className="search-btn px-4 text-sm disabled:opacity-50"
            >
              {sunoAddLoading ? 'Adding…' : '+ Add to Team'}
            </button>
          </div>
          {sunoAddStatus && (
            <div className={`mb-3 px-3 py-2 text-xs font-medium border ${sunoAddStatus.ok ? 'bg-green-50 text-green-800 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
              {sunoAddStatus.text}
            </div>
          )}

          {/* Members table */}
          <div className="overflow-x-auto">
            {sunoTeam.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">No Suno Team members found.</p>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-3 py-2 border-b border-gray-200">Username</th>
                    <th className="px-3 py-2 border-b border-gray-200 text-right">Messages</th>
                    <th className="px-3 py-2 border-b border-gray-200"></th>
                  </tr>
                </thead>
                <tbody>
                  {sunoTeam.map((m) => (
                    <tr key={m.username} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <span className="ubadge" style={{ background: '#ede9fe', color: '#5b21b6' }}>{m.username}</span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{m.message_count.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => handleRemoveSuno(m.username)} className="action-btn-danger">
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

    </div>
  )
}
