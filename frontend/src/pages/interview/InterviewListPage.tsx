import { useState, useRef, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, streamEvents } from '../../api/client'
import { useAuthStore } from '../../store/authStore'

interface Transcript {
  id: string
  title: string
  source_type: 'upload' | 'youtube'
  youtube_url?: string
  youtube_id?: string
  content_length: number
  created_at: string
  updated_at: string
  is_suno_team: boolean
  source_date?: string
  interviewees: string
}

type SortKey = 'date_desc' | 'date_asc' | 'source_date_desc' | 'source_date_asc' | 'title_asc' | 'title_desc' | 'length_desc'
type FilterSource = 'all' | 'youtube' | 'upload'
type FilterTeam = 'all' | 'suno' | 'non_suno'

const SORT_LABELS: Record<SortKey, string> = {
  date_desc:        'Added: newest first',
  date_asc:         'Added: oldest first',
  source_date_desc: 'Source date: newest first',
  source_date_asc:  'Source date: oldest first',
  title_asc:        'Title: A → Z',
  title_desc:       'Title: Z → A',
  length_desc:      'Length: long → short',
}

function formatLen(len: number | null | undefined) {
  const n = len ?? 0
  if (n < 1000) return `${n} chars`
  return `${(n / 1000).toFixed(1)}k chars`
}

export default function InterviewListPage() {
  const navigate = useNavigate()
  const { setShowKeyModal } = useAuthStore()
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'upload' | 'youtube'>('youtube')
  const [pageTab, setPageTab] = useState<'transcripts' | 'overview'>('transcripts')

  // Upload form
  const [uploadTitle, setUploadTitle] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadSunoTeam, setUploadSunoTeam] = useState(false)
  const [uploadDocDate, setUploadDocDate] = useState('')
  const [uploadInterviewees, setUploadInterviewees] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // YouTube form
  const [ytUrl, setYtUrl] = useState('')
  const [ytTitle, setYtTitle] = useState('')
  const [ytProgress, setYtProgress] = useState('')
  const [ytRunning, setYtRunning] = useState(false)
  const [ytError, setYtError] = useState('')
  const [ytFormatQa, setYtFormatQa] = useState(true)
  const [ytSunoTeam, setYtSunoTeam] = useState(false)
  const [ytInterviewees, setYtInterviewees] = useState('')

  // Single delete confirm
  const [deleteId, setDeleteId] = useState<string | null>(null)

  // Sort / filter
  const [sortKey, setSortKey] = useState<SortKey>('date_desc')
  const [filterSource, setFilterSource] = useState<FilterSource>('all')
  const [filterTeam, setFilterTeam] = useState<FilterTeam>('all')
  const [sortOpen, setSortOpen] = useState(false)
  const [filterSourceOpen, setFilterSourceOpen] = useState(false)
  const [filterTeamOpen, setFilterTeamOpen] = useState(false)

  // Bulk select
  const [bulkMode, setBulkMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)

  const load = async () => {
    try {
      const data = await apiFetch<Transcript[]>('/interviews')
      setTranscripts(data)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleUpload = async () => {
    if (!uploadFile) { setUploadError('Please select a file.'); return }
    setUploading(true)
    setUploadError('')
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      fd.append('title', uploadTitle || uploadFile.name.replace(/\.[^.]+$/, ''))
      fd.append('is_suno_team', uploadSunoTeam ? 'true' : 'false')
      if (uploadDocDate) fd.append('document_date', uploadDocDate)
      fd.append('interviewees', uploadInterviewees)
      await apiFetch('/interviews/upload', { method: 'POST', body: fd })
      setUploadTitle('')
      setUploadFile(null)
      setUploadDocDate('')
      setUploadInterviewees('')
      if (fileRef.current) fileRef.current.value = ''
      await load()
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleYouTube = () => {
    if (!ytUrl.trim()) return
    if (ytFormatQa && !localStorage.getItem('openai_api_key')) { setShowKeyModal(true); return }
    setYtRunning(true)
    setYtError('')
    setYtProgress('Starting…')

    const stop = streamEvents(
      '/interviews/youtube',
      { url: ytUrl.trim(), title: ytTitle.trim() || undefined, format_qa: ytFormatQa, is_suno_team: ytSunoTeam, interviewees: ytInterviewees.trim() || undefined },
      (ev) => {
        if (ev.type === 'progress') setYtProgress(ev.message as string)
        if (ev.type === 'error') { setYtError(ev.message as string); setYtRunning(false); stop() }
        if (ev.type === 'done') {
          setYtRunning(false)
          setYtUrl('')
          setYtTitle('')
          setYtProgress('')
          setYtInterviewees('')
          load()
          stop()
        }
      },
      () => { setYtRunning(false) },
      (err) => { setYtError(err.message); setYtRunning(false) },
    )
  }

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/interviews/${id}`, { method: 'DELETE' })
      setTranscripts((prev) => prev.filter((t) => t.id !== id))
      setSelected(prev => { const s = new Set(prev); s.delete(id); return s })
    } catch { /* ignore */ }
    setDeleteId(null)
  }

  const handleBulkDelete = async () => {
    setBulkDeleting(true)
    await Promise.all(Array.from(selected).map(id =>
      apiFetch(`/interviews/${id}`, { method: 'DELETE' }).catch(() => {})
    ))
    setTranscripts(prev => prev.filter(t => !selected.has(t.id)))
    setSelected(new Set())
    setBulkDeleteConfirm(false)
    setBulkDeleting(false)
    setBulkMode(false)
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })
  }

  const closeDropdowns = () => { setSortOpen(false); setFilterSourceOpen(false); setFilterTeamOpen(false) }

  const displayTranscripts = useMemo(() => {
    let list = transcripts.filter(t => {
      if (filterSource !== 'all' && t.source_type !== filterSource) return false
      if (filterTeam === 'suno' && !t.is_suno_team) return false
      if (filterTeam === 'non_suno' && t.is_suno_team) return false
      return true
    })
    list = [...list].sort((a, b) => {
      switch (sortKey) {
        case 'date_desc':
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        case 'date_asc':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        case 'source_date_desc': {
          const da = a.source_date ? new Date(a.source_date).getTime() : 0
          const db = b.source_date ? new Date(b.source_date).getTime() : 0
          return db - da
        }
        case 'source_date_asc': {
          const da = a.source_date ? new Date(a.source_date).getTime() : Infinity
          const db = b.source_date ? new Date(b.source_date).getTime() : Infinity
          return da - db
        }
        case 'title_asc':
          return a.title.localeCompare(b.title)
        case 'title_desc':
          return b.title.localeCompare(a.title)
        case 'length_desc':
          return (b.content_length ?? 0) - (a.content_length ?? 0)
      }
    })
    return list
  }, [transcripts, sortKey, filterSource, filterTeam])

  const allSelected = displayTranscripts.length > 0 && displayTranscripts.every(t => selected.has(t.id))

  const activeFilterCount = (filterSource !== 'all' ? 1 : 0) + (filterTeam !== 'all' ? 1 : 0)

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 space-y-4">

      {/* Add transcript panel */}
      <div className="bg-white rounded-2xl shadow border border-gray-200 overflow-hidden">
        <div className="flex border-b border-gray-100">
          <button
            onClick={() => setTab('youtube')}
            className={`flex-1 py-3 text-sm font-semibold transition-colors ${
              tab === 'youtube'
                ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Transcribe YouTube Video
          </button>
          <button
            onClick={() => setTab('upload')}
            className={`flex-1 py-3 text-sm font-semibold transition-colors ${
              tab === 'upload'
                ? 'bg-indigo-50 text-indigo-700 border-b-2 border-indigo-500'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Upload File
          </button>
        </div>

        <div className="p-4 space-y-3">
          {tab === 'youtube' ? (
            <>
              <input
                type="text"
                placeholder="YouTube URL"
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              <input
                type="text"
                placeholder="Title (optional — auto-fetched from YouTube)"
                value={ytTitle}
                onChange={(e) => setYtTitle(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              <input
                type="text"
                placeholder="Interviewee name(s), comma-separated (e.g. Jane Smith, John Doe)"
                value={ytInterviewees}
                onChange={(e) => setYtInterviewees(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              {ytProgress && !ytError && (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <div className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin shrink-0" />
                  {ytProgress}
                </div>
              )}
              {ytError && <p className="text-xs text-red-600">{ytError}</p>}
              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={ytFormatQa}
                    onChange={(e) => setYtFormatQa(e.target.checked)}
                    className="w-4 h-4 rounded accent-indigo-600"
                  />
                  <span className="text-sm text-gray-600">Format as <span className="font-semibold text-indigo-700">Q&amp;A</span> with GPT <span className="text-xs text-gray-400">(requires OpenAI key)</span></span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={ytSunoTeam}
                    onChange={(e) => setYtSunoTeam(e.target.checked)}
                    className="w-4 h-4 rounded accent-indigo-600"
                  />
                  <span className="text-sm text-gray-600">Label as <span className="font-semibold text-indigo-700">Suno Team</span></span>
                </label>
              </div>
              <button
                onClick={handleYouTube}
                disabled={ytRunning || !ytUrl.trim()}
                className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
              >
                {ytRunning ? 'Transcribing…' : 'Transcribe YouTube Video'}
              </button>
            </>
          ) : (
            <>
              <input
                type="text"
                placeholder="Title (optional — uses filename if blank)"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 shrink-0">Document date/time</label>
                <input
                  type="datetime-local"
                  value={uploadDocDate}
                  onChange={(e) => setUploadDocDate(e.target.value)}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
              </div>
              <input
                type="text"
                placeholder="Interviewee name(s), comma-separated (e.g. Jane Smith, John Doe)"
                value={uploadInterviewees}
                onChange={(e) => setUploadInterviewees(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              <label className="block">
                <span className="sr-only">Choose file</span>
                <div
                  onClick={() => fileRef.current?.click()}
                  className="cursor-pointer flex items-center gap-3 border-2 border-dashed border-gray-300 rounded-2xl px-4 py-5 hover:border-indigo-400 transition-colors"
                >
                  <svg className="w-8 h-8 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-gray-700">
                      {uploadFile ? uploadFile.name : 'Click to choose file'}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">.txt, .md, .pdf supported</p>
                  </div>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.md,.pdf,.text"
                  className="hidden"
                  onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={uploadSunoTeam}
                    onChange={(e) => setUploadSunoTeam(e.target.checked)}
                    className="w-4 h-4 rounded accent-indigo-600"
                  />
                  <span className="text-sm text-gray-600">Label as <span className="font-semibold text-indigo-700">Suno Team</span></span>
                </label>
              </div>
              {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}
              <button
                onClick={handleUpload}
                disabled={uploading || !uploadFile}
                className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
              >
                {uploading ? 'Uploading…' : 'Upload Transcript'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Page tabs */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow">
        <div className="border-b border-gray-200 px-4 pt-4">
          <div className="flex gap-0.5 overflow-x-auto">
            <button
              onClick={() => setPageTab('transcripts')}
              className={`px-4 py-2 text-sm font-semibold rounded-t-lg transition-colors whitespace-nowrap ${
                pageTab === 'transcripts' ? 'bg-slate-700 text-white' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              Transcripts
            </button>
            <button
              onClick={() => setPageTab('overview')}
              className={`px-4 py-2 text-sm font-semibold rounded-t-lg transition-colors whitespace-nowrap ${
                pageTab === 'overview' ? 'bg-slate-700 text-white' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              Overview
            </button>
          </div>
        </div>

        <div className="p-5">
          {pageTab === 'transcripts' ? (
            <div className="space-y-3">

              {/* Controls bar */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-gray-500 uppercase tracking-wide mr-auto">
                  {loading ? 'Loading…' : `${displayTranscripts.length} of ${transcripts.length} transcript${transcripts.length !== 1 ? 's' : ''}`}
                </span>

                {/* Source filter */}
                <div className="relative">
                  <button
                    onClick={() => { setFilterSourceOpen(o => !o); setSortOpen(false); setFilterTeamOpen(false) }}
                    className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      filterSource !== 'all'
                        ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-semibold'
                        : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
                    }`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                    </svg>
                    {filterSource === 'all' ? 'All sources' : filterSource === 'youtube' ? 'YouTube only' : 'Uploads only'}
                  </button>
                  {filterSourceOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={closeDropdowns} />
                      <div className="absolute right-0 top-8 z-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-40">
                        {(['all', 'youtube', 'upload'] as FilterSource[]).map(f => (
                          <button key={f} onClick={() => { setFilterSource(f); setFilterSourceOpen(false) }}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-50 hover:text-indigo-700 transition-colors ${filterSource === f ? 'font-semibold text-indigo-700' : 'text-gray-700'}`}>
                            {f === 'all' ? 'All sources' : f === 'youtube' ? 'YouTube only' : 'Uploads only'}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Team filter */}
                <div className="relative">
                  <button
                    onClick={() => { setFilterTeamOpen(o => !o); setSortOpen(false); setFilterSourceOpen(false) }}
                    className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      filterTeam !== 'all'
                        ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-semibold'
                        : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
                    }`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {filterTeam === 'all' ? 'All teams' : filterTeam === 'suno' ? 'Suno Team' : 'Non-Suno'}
                  </button>
                  {filterTeamOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={closeDropdowns} />
                      <div className="absolute right-0 top-8 z-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-40">
                        {(['all', 'suno', 'non_suno'] as FilterTeam[]).map(f => (
                          <button key={f} onClick={() => { setFilterTeam(f); setFilterTeamOpen(false) }}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-50 hover:text-indigo-700 transition-colors ${filterTeam === f ? 'font-semibold text-indigo-700' : 'text-gray-700'}`}>
                            {f === 'all' ? 'All teams' : f === 'suno' ? 'Suno Team only' : 'Non-Suno only'}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Sort */}
                <div className="relative">
                  <button
                    onClick={() => { setSortOpen(o => !o); setFilterSourceOpen(false); setFilterTeamOpen(false) }}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                    </svg>
                    {SORT_LABELS[sortKey].split(':')[0]}
                  </button>
                  {sortOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={closeDropdowns} />
                      <div className="absolute right-0 top-8 z-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-56">
                        {(Object.entries(SORT_LABELS) as [SortKey, string][]).map(([k, label]) => (
                          <button key={k} onClick={() => { setSortKey(k); setSortOpen(false) }}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-50 hover:text-indigo-700 transition-colors ${sortKey === k ? 'font-semibold text-indigo-700' : 'text-gray-700'}`}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Bulk select toggle */}
                <button
                  onClick={() => { setBulkMode(o => !o); setSelected(new Set()); setBulkDeleteConfirm(false) }}
                  className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                    bulkMode
                      ? 'border-red-300 bg-red-50 text-red-700 font-semibold'
                      : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                  {bulkMode ? 'Cancel' : 'Select'}
                </button>
              </div>

              {/* Active filter badge */}
              {activeFilterCount > 0 && (
                <p className="text-xs text-indigo-600 font-medium">
                  {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''} active ·{' '}
                  <button onClick={() => { setFilterSource('all'); setFilterTeam('all') }} className="underline hover:no-underline">
                    Clear all
                  </button>
                </p>
              )}

              {/* Bulk action bar */}
              {bulkMode && displayTranscripts.length > 0 && (
                <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-2.5">
                  <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => allSelected
                        ? setSelected(new Set())
                        : setSelected(new Set(displayTranscripts.map(t => t.id)))
                      }
                      className="w-4 h-4 rounded accent-indigo-600"
                    />
                    Select all ({displayTranscripts.length})
                  </label>
                  <span className="text-gray-300">·</span>
                  <span className="text-xs text-gray-500">{selected.size} selected</span>
                  {selected.size > 0 && (
                    <>
                      <span className="flex-1" />
                      {bulkDeleteConfirm ? (
                        <span className="flex items-center gap-2 text-xs">
                          <span className="text-gray-600">Delete {selected.size} transcript{selected.size !== 1 ? 's' : ''}?</span>
                          <button onClick={handleBulkDelete} disabled={bulkDeleting}
                            className="text-red-600 font-semibold hover:underline disabled:opacity-50">
                            {bulkDeleting ? 'Deleting…' : 'Yes, delete'}
                          </button>
                          <button onClick={() => setBulkDeleteConfirm(false)} className="text-gray-400 hover:underline">Cancel</button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setBulkDeleteConfirm(true)}
                          className="flex items-center gap-1.5 text-xs text-white bg-red-500 hover:bg-red-600 px-3 py-1 rounded-lg font-semibold transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete {selected.size}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Empty state */}
              {!loading && displayTranscripts.length === 0 && (
                <div className="rounded-2xl border border-gray-200 p-8 text-center text-gray-400 text-sm">
                  {transcripts.length === 0
                    ? 'No transcripts yet. Upload a file or paste a YouTube URL above.'
                    : 'No transcripts match the current filters.'}
                </div>
              )}

              {/* Transcript cards */}
              {displayTranscripts.map((t) => (
                <div
                  key={t.id}
                  className={`bg-white rounded-2xl border shadow-sm transition-all ${
                    bulkMode && selected.has(t.id)
                      ? 'border-indigo-400 ring-1 ring-indigo-300'
                      : 'border-gray-200 hover:border-indigo-300 hover:shadow'
                  }`}
                >
                  <div className="flex items-stretch">
                    {bulkMode && (
                      <label className="flex items-center px-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selected.has(t.id)}
                          onChange={() => toggleSelect(t.id)}
                          className="w-4 h-4 rounded accent-indigo-600"
                        />
                      </label>
                    )}

                    <button
                      onClick={() => bulkMode ? toggleSelect(t.id) : navigate(`/interview/${t.id}`)}
                      className="flex-1 text-left p-4 flex items-start gap-3"
                    >
                      <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                        t.source_type === 'youtube' ? 'bg-red-50' : 'bg-indigo-50'
                      }`}>
                        {t.source_type === 'youtube' ? (
                          <svg className="w-4 h-4 text-red-600" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                          </svg>
                        ) : (
                          <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="font-semibold text-gray-900 text-sm truncate">{t.title}</p>
                          {t.is_suno_team && (
                            <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                              Suno Team
                            </span>
                          )}
                        </div>
                        {t.interviewees && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {t.interviewees.split(',').map((name) => name.trim()).filter(Boolean).map((name) => (
                              <span key={name} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                                {name}
                              </span>
                            ))}
                          </div>
                        )}
                        <p className="text-xs text-gray-400 mt-0.5">
                          {t.source_type === 'youtube' ? 'YouTube' : 'Upload'}
                          {t.source_date && (
                            <> · <span className="text-gray-500">{t.source_type === 'youtube' ? 'Published' : 'Dated'} {t.source_date.slice(0, 19).replace('T', ' ')}</span></>
                          )}
                          {' · '}{formatLen(t.content_length)}
                          {' · '}Transcribed {t.created_at.slice(0, 19).replace('T', ' ')}
                        </p>
                      </div>

                      {!bulkMode && (
                        <svg className="w-4 h-4 text-gray-300 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      )}
                    </button>
                  </div>

                  {!bulkMode && (
                    <div className="px-4 pb-3 flex justify-end">
                      {deleteId === t.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Delete this transcript?</span>
                          <button onClick={() => handleDelete(t.id)}
                            className="text-xs text-red-600 font-semibold hover:underline">
                            Yes, delete
                          </button>
                          <button onClick={() => setDeleteId(null)}
                            className="text-xs text-gray-400 hover:underline">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteId(t.id) }}
                          className="flex items-center gap-1 text-xs font-medium text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 hover:bg-red-50 px-2.5 py-1 rounded-lg transition-colors"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            /* Overview table */
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-3 border-b border-gray-200">Title</th>
                    <th className="px-4 py-3 border-b border-gray-200">Interviewee(s)</th>
                    <th className="px-4 py-3 border-b border-gray-200">Video URL</th>
                    <th className="px-4 py-3 border-b border-gray-200 w-32">Date Published</th>
                    <th className="px-4 py-3 border-b border-gray-200 w-40">Date Transcribed</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">Loading…</td>
                    </tr>
                  ) : transcripts.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">No transcripts yet.</td>
                    </tr>
                  ) : (
                    transcripts.map((t) => (
                      <tr
                        key={t.id}
                        className="hover:bg-indigo-50/40 cursor-pointer transition-colors"
                        onClick={() => navigate(`/interview/${t.id}`)}
                      >
                        <td className="px-4 py-3 border-b border-gray-100">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-gray-900">{t.title}</span>
                            {t.source_type === 'youtube' ? (
                              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">YT</span>
                            ) : (
                              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">File</span>
                            )}
                            {t.is_suno_team && (
                              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">Suno</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 border-b border-gray-100 text-gray-600">
                          {t.interviewees ? (
                            <div className="flex flex-wrap gap-1">
                              {t.interviewees.split(',').map((name) => name.trim()).filter(Boolean).map((name) => (
                                <span key={name} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                                  {name}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 border-b border-gray-100 text-xs text-gray-500 max-w-[200px] truncate">
                          {t.youtube_url ? (
                            <a
                              href={t.youtube_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-indigo-600 hover:text-indigo-800 hover:underline truncate block"
                            >
                              {t.youtube_url}
                            </a>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 border-b border-gray-100 text-xs text-gray-600 whitespace-nowrap">
                          {t.source_date ? t.source_date.slice(0, 19).replace('T', ' ') : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-3 border-b border-gray-100 text-xs text-gray-500 whitespace-nowrap">
                          {t.created_at.slice(0, 19).replace('T', ' ')}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
