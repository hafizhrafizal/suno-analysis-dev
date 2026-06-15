import { useState, useRef, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../api/client'

interface Article {
  id: string
  title: string
  source_type: 'url' | 'upload'
  source_url?: string
  source_filename?: string
  word_count: number
  published_at: string | null
  created_at: string
}

type Tab = 'url' | 'bulk' | 'upload'
type SortKey = 'published_desc' | 'published_asc' | 'scraped_desc' | 'scraped_asc' | 'title_asc' | 'title_desc' | 'words_desc'
type FilterSource = 'all' | 'url' | 'upload'

interface BulkItem {
  url: string
  status: 'pending' | 'processing' | 'done' | 'error'
  message?: string
}

const SORT_LABELS: Record<SortKey, string> = {
  published_desc: 'Published: newest first',
  published_asc:  'Published: oldest first',
  scraped_desc:   'Added: newest first',
  scraped_asc:    'Added: oldest first',
  title_asc:      'Title: A → Z',
  title_desc:     'Title: Z → A',
  words_desc:     'Word count: high → low',
}

function safeHostname(url?: string): string {
  if (!url) return ''
  try { return new URL(url).hostname } catch { return url }
}

function formatWords(n: number | null | undefined): string {
  const v = n ?? 0
  return `${v.toLocaleString()} word${v === 1 ? '' : 's'}`
}

function formatPublished(iso: string | null, fallback: string): string {
  const src = iso ?? fallback
  try {
    const d = new Date(src)
    if (isNaN(d.getTime())) throw new Error('invalid')
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZoneName: 'short',
    }).format(d)
  } catch {
    return src.slice(0, 16).replace('T', ' ')
  }
}

export default function NewsListPage() {
  const navigate = useNavigate()
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('url')

  // Single URL form
  const [urlInput, setUrlInput] = useState('')
  const [urlTitle, setUrlTitle] = useState('')
  const [urlLoading, setUrlLoading] = useState(false)
  const [urlError, setUrlError] = useState('')
  const [urlProgress, setUrlProgress] = useState('')

  // Bulk URL form
  const [bulkText, setBulkText] = useState('')
  const [bulkItems, setBulkItems] = useState<BulkItem[]>([])
  const [bulkRunning, setBulkRunning] = useState(false)

  // File upload form
  const [uploadTitle, setUploadTitle] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Single-item delete confirm
  const [deleteId, setDeleteId] = useState<string | null>(null)

  // Sort / filter
  const [sortKey, setSortKey] = useState<SortKey>('scraped_desc')
  const [filterSource, setFilterSource] = useState<FilterSource>('all')
  const [sortOpen, setSortOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)

  // Bulk select
  const [bulkMode, setBulkMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)

  const load = async () => {
    try {
      const data = await apiFetch<Article[]>('/news/articles')
      setArticles(data)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleExtractUrl = async () => {
    const url = urlInput.trim()
    if (!url) { setUrlError('Please enter a URL.'); return }
    setUrlLoading(true)
    setUrlError('')
    setUrlProgress('Extracting article…')
    try {
      await apiFetch('/news/extract-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title: urlTitle.trim() || undefined }),
      })
      setUrlInput('')
      setUrlTitle('')
      setUrlProgress('')
      await load()
    } catch (e: unknown) {
      setUrlError(e instanceof Error ? e.message : 'Extraction failed')
      setUrlProgress('')
    } finally {
      setUrlLoading(false)
    }
  }

  const handleBulkExtract = async () => {
    const urls = bulkText
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('http'))
    if (urls.length === 0) return
    const items: BulkItem[] = urls.map(url => ({ url, status: 'pending' }))
    setBulkItems(items)
    setBulkRunning(true)
    for (let i = 0; i < urls.length; i++) {
      setBulkItems(prev => prev.map((it, idx) =>
        idx === i ? { ...it, status: 'processing' } : it
      ))
      try {
        await apiFetch('/news/extract-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urls[i] }),
        })
        setBulkItems(prev => prev.map((it, idx) =>
          idx === i ? { ...it, status: 'done' } : it
        ))
      } catch (e: unknown) {
        setBulkItems(prev => prev.map((it, idx) =>
          idx === i
            ? { ...it, status: 'error', message: e instanceof Error ? e.message : 'Failed' }
            : it
        ))
      }
    }
    setBulkRunning(false)
    await load()
  }

  const handleUpload = async () => {
    if (!uploadFile) { setUploadError('Please select a file.'); return }
    setUploading(true)
    setUploadError('')
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      fd.append('title', uploadTitle || uploadFile.name.replace(/\.[^.]+$/, ''))
      await apiFetch('/news/upload', { method: 'POST', body: fd })
      setUploadTitle('')
      setUploadFile(null)
      if (fileRef.current) fileRef.current.value = ''
      await load()
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/news/articles/${id}`, { method: 'DELETE' })
      setArticles(prev => prev.filter(a => a.id !== id))
      setSelected(prev => { const s = new Set(prev); s.delete(id); return s })
    } catch { /* ignore */ }
    setDeleteId(null)
  }

  const handleBulkDelete = async () => {
    setBulkDeleting(true)
    const ids = Array.from(selected)
    await Promise.all(ids.map(id =>
      apiFetch(`/news/articles/${id}`, { method: 'DELETE' }).catch(() => {})
    ))
    setArticles(prev => prev.filter(a => !selected.has(a.id)))
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

  const displayArticles = useMemo(() => {
    let list = articles.filter(a =>
      filterSource === 'all' || a.source_type === filterSource
    )
    list = [...list].sort((a, b) => {
      switch (sortKey) {
        case 'published_desc': {
          const da = a.published_at ? new Date(a.published_at).getTime() : 0
          const db = b.published_at ? new Date(b.published_at).getTime() : 0
          return db - da
        }
        case 'published_asc': {
          const da = a.published_at ? new Date(a.published_at).getTime() : Infinity
          const db = b.published_at ? new Date(b.published_at).getTime() : Infinity
          return da - db
        }
        case 'scraped_desc':
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        case 'scraped_asc':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        case 'title_asc':
          return a.title.localeCompare(b.title)
        case 'title_desc':
          return b.title.localeCompare(a.title)
        case 'words_desc':
          return b.word_count - a.word_count
      }
    })
    return list
  }, [articles, sortKey, filterSource])

  const allSelected = displayArticles.length > 0 && displayArticles.every(a => selected.has(a.id))

  const doneCount = bulkItems.filter(i => i.status === 'done').length
  const errorCount = bulkItems.filter(i => i.status === 'error').length

  const tabs: { key: Tab; label: string }[] = [
    { key: 'url', label: 'Extract from URL' },
    { key: 'bulk', label: 'Bulk URLs' },
    { key: 'upload', label: 'Upload Document' },
  ]

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 space-y-4">

      {/* Add article panel */}
      <div className="bg-white rounded-2xl shadow border border-gray-200 overflow-hidden">
        <div className="flex border-b border-gray-100">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 py-3 text-sm font-semibold transition-colors ${
                tab === t.key
                  ? 'bg-amber-50 text-amber-700 border-b-2 border-amber-500'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="p-4 space-y-3">

          {/* ── Single URL ── */}
          {tab === 'url' && (
            <>
              <input
                type="url"
                placeholder="https://example.com/article"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleExtractUrl()}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <input
                type="text"
                placeholder="Title (optional — extracted automatically if blank)"
                value={urlTitle}
                onChange={e => setUrlTitle(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              {urlProgress && !urlError && (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <div className="w-3.5 h-3.5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin shrink-0" />
                  {urlProgress}
                </div>
              )}
              {urlError && <p className="text-xs text-red-600">{urlError}</p>}
              <p className="text-xs text-gray-400">
                Supports plain HTML, JS-rendered pages, and soft-paywalled articles via Jina AI Reader.
              </p>
              <button
                onClick={handleExtractUrl}
                disabled={urlLoading || !urlInput.trim()}
                className="w-full py-2 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
              >
                {urlLoading ? 'Extracting…' : 'Extract Article'}
              </button>
            </>
          )}

          {/* ── Bulk URLs ── */}
          {tab === 'bulk' && (
            <>
              <textarea
                rows={6}
                placeholder={"Paste one URL per line:\nhttps://example.com/article-1\nhttps://example.com/article-2\nhttps://example.com/article-3"}
                value={bulkText}
                onChange={e => setBulkText(e.target.value)}
                disabled={bulkRunning}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-60 resize-y"
              />
              <p className="text-xs text-gray-400">
                URLs are processed sequentially. Each uses the same extraction strategy as single URL mode.
              </p>
              {bulkItems.length > 0 && (
                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                  {bulkItems.map((item, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="shrink-0 mt-0.5">
                        {item.status === 'pending' && (
                          <span className="inline-block w-4 h-4 rounded-full border border-gray-300" />
                        )}
                        {item.status === 'processing' && (
                          <span className="inline-block w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                        )}
                        {item.status === 'done' && (
                          <span className="inline-block w-4 h-4 rounded-full bg-green-500 text-white flex items-center justify-center text-[10px]">✓</span>
                        )}
                        {item.status === 'error' && (
                          <span className="inline-block w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center text-[10px]">✕</span>
                        )}
                      </span>
                      <span className={`flex-1 truncate ${item.status === 'error' ? 'text-red-600' : 'text-gray-600'}`}>
                        {item.url}
                        {item.message && <span className="ml-1 text-red-500">— {item.message}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {bulkItems.length > 0 && !bulkRunning && (
                <p className="text-xs text-gray-500">
                  {doneCount} extracted{errorCount > 0 ? `, ${errorCount} failed` : ''}.
                </p>
              )}
              <button
                onClick={handleBulkExtract}
                disabled={bulkRunning || !bulkText.trim()}
                className="w-full py-2 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
              >
                {bulkRunning
                  ? `Extracting ${bulkItems.findIndex(i => i.status === 'processing') + 1} of ${bulkItems.length}…`
                  : `Extract ${bulkText.split('\n').filter(l => l.trim().startsWith('http')).length || 0} URLs`}
              </button>
            </>
          )}

          {/* ── Upload ── */}
          {tab === 'upload' && (
            <>
              <input
                type="text"
                placeholder="Title (optional — uses filename if blank)"
                value={uploadTitle}
                onChange={e => setUploadTitle(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <div
                onClick={() => fileRef.current?.click()}
                className="cursor-pointer flex items-center gap-3 border-2 border-dashed border-gray-300 rounded-2xl px-4 py-5 hover:border-amber-400 transition-colors"
              >
                <svg className="w-8 h-8 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-gray-700">
                    {uploadFile ? uploadFile.name : 'Click to choose file'}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">.html, .pdf, .docx, .md, .txt</p>
                </div>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".html,.htm,.pdf,.docx,.md,.txt,.text"
                className="hidden"
                onChange={e => setUploadFile(e.target.files?.[0] ?? null)}
              />
              {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}
              <button
                onClick={handleUpload}
                disabled={uploading || !uploadFile}
                className="w-full py-2 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
              >
                {uploading ? 'Uploading…' : 'Upload Document'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Article list tabs */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow">
        <div className="border-b border-gray-200 px-4 pt-4">
          <div className="flex gap-0.5 overflow-x-auto">
            <button
              className="px-4 py-2 text-sm font-semibold rounded-t-lg transition-colors whitespace-nowrap bg-slate-700 text-white"
            >
              List of News Articles
            </button>
          </div>
        </div>

        <div className="p-5">

          {/* Article list header */}
          <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide px-1 mr-auto">
          {loading ? 'Loading…' : `${displayArticles.length} of ${articles.length} article${articles.length !== 1 ? 's' : ''}`}
        </h2>

        {/* Source filter */}
        <div className="relative">
          <button
            onClick={() => { setFilterOpen(o => !o); setSortOpen(false) }}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              filterSource !== 'all'
                ? 'border-amber-400 bg-amber-50 text-amber-700 font-semibold'
                : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            {filterSource === 'all' ? 'All sources' : filterSource === 'url' ? 'URL only' : 'Uploads only'}
          </button>
          {filterOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setFilterOpen(false)} />
              <div className="absolute right-0 top-8 z-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-40">
                {(['all', 'url', 'upload'] as FilterSource[]).map(f => (
                  <button
                    key={f}
                    onClick={() => { setFilterSource(f); setFilterOpen(false) }}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-amber-50 hover:text-amber-700 ${
                      filterSource === f ? 'font-semibold text-amber-700' : 'text-gray-700'
                    }`}
                  >
                    {f === 'all' ? 'All sources' : f === 'url' ? 'URL only' : 'Uploads only'}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Sort */}
        <div className="relative">
          <button
            onClick={() => { setSortOpen(o => !o); setFilterOpen(false) }}
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
              <div className="fixed inset-0 z-30" onClick={() => setSortOpen(false)} />
              <div className="absolute right-0 top-8 z-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-56">
                {(Object.entries(SORT_LABELS) as [SortKey, string][]).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => { setSortKey(k); setSortOpen(false) }}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-amber-50 hover:text-amber-700 ${
                      sortKey === k ? 'font-semibold text-amber-700' : 'text-gray-700'
                    }`}
                  >
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

      {/* Bulk action bar */}
      {bulkMode && displayArticles.length > 0 && (
        <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-2.5">
          <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => {
                if (allSelected) setSelected(new Set())
                else setSelected(new Set(displayArticles.map(a => a.id)))
              }}
              className="w-4 h-4 rounded accent-amber-600"
            />
            Select all ({displayArticles.length})
          </label>
          <span className="text-gray-300">·</span>
          <span className="text-xs text-gray-500">{selected.size} selected</span>
          {selected.size > 0 && (
            <>
              <span className="flex-1" />
              {bulkDeleteConfirm ? (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-gray-600">Delete {selected.size} article{selected.size !== 1 ? 's' : ''}?</span>
                  <button
                    onClick={handleBulkDelete}
                    disabled={bulkDeleting}
                    className="text-red-600 font-semibold hover:underline disabled:opacity-50"
                  >
                    {bulkDeleting ? 'Deleting…' : 'Yes, delete'}
                  </button>
                  <button onClick={() => setBulkDeleteConfirm(false)} className="text-gray-400 hover:underline">
                    Cancel
                  </button>
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

      {/* Article list */}
      <div className="space-y-2">
        {!loading && displayArticles.length === 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-400 text-sm">
            {articles.length === 0
              ? 'No articles yet. Extract from a URL or upload a document above.'
              : 'No articles match the current filter.'}
          </div>
        )}

        {displayArticles.map(a => (
          <div
            key={a.id}
            className={`bg-white rounded-2xl border shadow-sm transition-all ${
              bulkMode && selected.has(a.id)
                ? 'border-amber-400 ring-1 ring-amber-300'
                : 'border-gray-200 hover:border-amber-300 hover:shadow'
            }`}
          >
            <div className="flex items-stretch">
              {bulkMode && (
                <label className="flex items-center px-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(a.id)}
                    onChange={() => toggleSelect(a.id)}
                    className="w-4 h-4 rounded accent-amber-600"
                  />
                </label>
              )}

              <button
                onClick={() => bulkMode ? toggleSelect(a.id) : navigate(`/news/${a.id}`)}
                className="flex-1 text-left p-4 flex items-start gap-3"
              >
                <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                  a.source_type === 'url' ? 'bg-amber-100' : 'bg-orange-100'
                }`}>
                  {a.source_type === 'url' ? (
                    <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 text-sm truncate">{a.title}</p>
                  <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {a.source_type === 'url'
                      ? `URL · ${safeHostname(a.source_url)}`
                      : `Upload · ${a.source_filename ?? ''}`}
                    {' · '}
                    {formatWords(a.word_count)}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {a.published_at
                      ? `Published ${formatPublished(a.published_at, a.created_at)}`
                      : `Added ${formatPublished(null, a.created_at)}`}
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
                {deleteId === a.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">Delete this article?</span>
                    <button onClick={() => handleDelete(a.id)} className="text-xs text-red-600 font-semibold hover:underline">
                      Yes, delete
                    </button>
                    <button onClick={() => setDeleteId(null)} className="text-xs text-gray-400 hover:underline">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={e => { e.stopPropagation(); setDeleteId(a.id) }}
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
        </div>
      </div>
    </div>
  )
}
