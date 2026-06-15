import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { apiFetch, streamEvents } from '../../api/client'

interface GithubRepo {
  id: string
  owner: string
  name: string
  full_name: string
  description: string | null
  html_url: string
  stars: number
  forks: number
  open_issues: number
  language: string | null
  is_private: boolean
  default_branch: string | null
  created_at_gh: string | null
  updated_at_gh: string | null
  fetched_at: string
}

interface MaskedToken {
  index: number
  masked: string
}

function TokenManager() {
  const qc = useQueryClient()
  const [input, setInput] = useState('')
  const [err, setErr] = useState('')

  const { data } = useQuery<{ tokens: MaskedToken[]; count: number }>({
    queryKey: ['github-tokens'],
    queryFn: () => apiFetch('/github/tokens'),
  })

  const addMut = useMutation({
    mutationFn: (token: string) => apiFetch('/github/tokens', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['github-tokens'] })
      setInput('')
      setErr('')
    },
    onError: (e: Error) => setErr(e.message),
  })

  const delMut = useMutation({
    mutationFn: (index: number) => apiFetch(`/github/tokens/${index}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['github-tokens'] }),
  })

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    const t = input.trim()
    if (!t) return
    addMut.mutate(t)
  }

  const tokens = data?.tokens ?? []

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-500">
          {tokens.length === 0 ? 'No tokens added yet.' : `${tokens.length} token${tokens.length !== 1 ? 's' : ''} active`}
        </span>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${tokens.length > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
          {tokens.length > 0 ? 'Active' : 'No tokens'}
        </span>
      </div>

      {tokens.length > 0 && (
        <ul className="space-y-1.5">
          {tokens.map(tok => (
            <li key={tok.index} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              <code className="text-xs font-mono text-slate-600">{tok.masked}</code>
              <button
                onClick={() => delMut.mutate(tok.index)}
                disabled={delMut.isPending}
                className="text-xs text-red-500 hover:text-red-700 font-semibold disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="password"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="ghp_… personal access token"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <button
          type="submit"
          disabled={addMut.isPending || !input.trim()}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-800 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors shrink-0"
        >
          Add Token
        </button>
      </form>
      {err && <p className="text-red-600 text-xs">{err}</p>}
    </div>
  )
}

export default function GitHubListPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [urlInput, setUrlInput] = useState('')
  const [addError, setAddError] = useState('')
  const [addProgress, setAddProgress] = useState('')
  const [adding, setAdding] = useState(false)

  // List controls
  const [sort, setSort] = useState<'stars' | 'forks' | 'fetched' | 'updated'>('fetched')
  const [langFilter, setLangFilter] = useState('all')
  const [bulkMode, setBulkMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)

  const { data: repos = [], isLoading } = useQuery<GithubRepo[]>({
    queryKey: ['github-repos'],
    queryFn: () => apiFetch('/github/repos'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/github/repos/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['github-repos'] }),
  })

  // Derived: available languages + filtered/sorted list
  const languages = [...new Set(repos.map(r => r.language).filter(Boolean))] as string[]
  const filtered = langFilter === 'all' ? repos : repos.filter(r => r.language === langFilter)
  const sorted = [...filtered].sort((a, b) => {
    switch (sort) {
      case 'stars': return b.stars - a.stars
      case 'forks': return b.forks - a.forks
      case 'fetched': return b.fetched_at.localeCompare(a.fetched_at)
      case 'updated': return (b.updated_at_gh || '').localeCompare(a.updated_at_gh || '')
      default: return 0
    }
  })
  const allSelected = sorted.length > 0 && sorted.every(r => selected.has(r.id))

  const handleAnalyze = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (!trimmed) return
    setAddError('')
    setAddProgress('Connecting…')
    setAdding(true)

    const stop = streamEvents(
      '/github/repos',
      { url: trimmed },
      (ev) => {
        if (ev.type === 'progress') {
          setAddProgress(ev.message as string)
        }
        if (ev.type === 'error') {
          setAddError(ev.message as string)
          setAdding(false)
          setAddProgress('')
          stop()
        }
        if (ev.type === 'done') {
          qc.invalidateQueries({ queryKey: ['github-repos'] })
          setUrlInput('')
          setAdding(false)
          setAddProgress('')
          stop()
        }
      },
      () => { setAdding(false); setAddProgress('') },
      (err) => { setAddError(err.message); setAdding(false); setAddProgress('') },
    )
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleBulkDelete = async () => {
    for (const id of selected) {
      try { await apiFetch(`/github/repos/${id}`, { method: 'DELETE' }) } catch { /* continue */ }
    }
    setSelected(new Set())
    setBulkMode(false)
    setBulkDeleteConfirm(false)
    qc.invalidateQueries({ queryKey: ['github-repos'] })
  }

  const applyControl = (fn: () => void) => { fn(); setSortOpen(false); setFilterOpen(false) }

  const SORT_OPTIONS: { key: typeof sort; label: string }[] = [
    { key: 'fetched', label: 'Recently fetched' },
    { key: 'stars', label: 'Most stars' },
    { key: 'forks', label: 'Most forks' },
    { key: 'updated', label: 'Recently updated (GitHub)' },
  ]

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">

      

      {/* Token manager */}
      <div className="bg-white rounded-2xl shadow border border-gray-200 p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-1">API Token Pool</h2>
        <p className="text-gray-500 text-sm mb-4">Requests rotate across all tokens to maximize GitHub rate limits.</p>
        <TokenManager />
      </div>
      {/* Add repo form */}
      <div className="bg-white rounded-2xl shadow border border-gray-200 p-6">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-gray-900">Fetch a GitHub Repository</h2>
          <p className="text-gray-500 text-sm mt-0.5">Enter a repository URL or owner/repo slug to fetch its activity data.</p>
        </div>

        <form onSubmit={handleAnalyze} className="flex gap-2">
          <input
            type="text"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            placeholder="https://github.com/owner/repo  or  owner/repo"
            disabled={adding}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={adding || !urlInput.trim()}
            className="px-5 py-2.5 bg-slate-700 hover:bg-slate-800 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors flex items-center gap-2 shrink-0"
          >
            {adding ? (
              <>
                <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                Analyzing…
              </>
            ) : 'Analyze'}
          </button>
        </form>
        {addError && <p className="mt-2 text-red-600 text-sm">{addError}</p>}
        {adding && addProgress && (
          <p className="mt-2 text-slate-500 text-xs">{addProgress}</p>
        )}
      </div>
      {/* Repo list tab */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow">
        <div className="border-b border-gray-200 px-4 pt-4">
          <div className="flex gap-0.5 overflow-x-auto">
            <button className="px-4 py-2 text-sm font-semibold rounded-t-lg transition-colors whitespace-nowrap bg-slate-700 text-white">
              List of Repositories
            </button>
          </div>
        </div>

        <div className="p-5">

          {/* List controls */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide px-1 mr-auto">
              {isLoading ? 'Loading…' : `${sorted.length} of ${repos.length} repo${repos.length !== 1 ? 's' : ''}`}
            </h2>

            {/* Language filter */}
            <div className="relative">
              <button
                onClick={() => { setFilterOpen(o => !o); setSortOpen(false) }}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                  langFilter !== 'all'
                    ? 'border-slate-400 bg-slate-50 text-slate-700 font-semibold'
                    : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                {langFilter === 'all' ? 'All languages' : langFilter}
              </button>
              {filterOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setFilterOpen(false)} />
                  <div className="absolute right-0 top-8 z-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-40 max-h-56 overflow-y-auto">
                    <button
                      onClick={() => applyControl(() => setLangFilter('all'))}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-slate-50 ${langFilter === 'all' ? 'font-semibold text-slate-700' : 'text-gray-600'}`}
                    >All languages</button>
                    {languages.map(lang => (
                      <button
                        key={lang}
                        onClick={() => applyControl(() => setLangFilter(lang))}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-slate-50 ${langFilter === lang ? 'font-semibold text-slate-700' : 'text-gray-600'}`}
                      >{lang}</button>
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
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                </svg>
                {SORT_OPTIONS.find(o => o.key === sort)?.label ?? 'Sort'}
              </button>
              {sortOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setSortOpen(false)} />
                  <div className="absolute right-0 top-8 z-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-52">
                    {SORT_OPTIONS.map(o => (
                      <button
                        key={o.key}
                        onClick={() => applyControl(() => setSort(o.key))}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-slate-50 ${sort === o.key ? 'font-semibold text-slate-700' : 'text-gray-600'}`}
                      >{o.label}</button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Bulk select toggle */}
            <button
              onClick={() => { setBulkMode(o => !o); setSelected(new Set()); setBulkDeleteConfirm(false) }}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                bulkMode ? 'border-red-300 bg-red-50 text-red-700 font-semibold' : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              {bulkMode ? 'Cancel' : 'Select'}
            </button>
          </div>

          {/* Bulk action bar */}
          {bulkMode && sorted.length > 0 && (
            <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-2.5 mb-3">
              <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => {
                    if (allSelected) setSelected(new Set())
                    else setSelected(new Set(sorted.map(r => r.id)))
                  }}
                  className="w-4 h-4 rounded accent-slate-600"
                />
                Select all ({sorted.length})
              </label>
              <span className="text-gray-300">·</span>
              <span className="text-xs text-gray-500">{selected.size} selected</span>
              {selected.size > 0 && (
                <>
                  <span className="flex-1" />
                  {bulkDeleteConfirm ? (
                    <span className="flex items-center gap-2 text-xs">
                      <span className="text-gray-600">Delete {selected.size} repo{selected.size !== 1 ? 's' : ''}?</span>
                      <button onClick={handleBulkDelete} className="text-red-600 font-semibold hover:underline">Yes, delete</button>
                      <button onClick={() => setBulkDeleteConfirm(false)} className="text-gray-400 hover:underline">Cancel</button>
                    </span>
                  ) : (
                    <button onClick={() => setBulkDeleteConfirm(true)}
                      className="flex items-center gap-1.5 text-xs text-white bg-red-500 hover:bg-red-600 px-3 py-1 rounded-lg font-semibold transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Delete {selected.size}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* Repo cards */}
          <div className="space-y-3">
            {isLoading ? (
              <div className="flex justify-center py-12">
                <span className="animate-spin w-8 h-8 border-4 border-slate-600 border-t-transparent rounded-full" />
              </div>
            ) : sorted.length === 0 ? (
              <div className="text-center py-16 text-gray-400 text-sm">
                {repos.length === 0 ? 'No repositories analyzed yet. Enter a URL above to get started.' : 'No repos match the current filter.'}
              </div>
            ) : (
              sorted.map(repo => (
                <div
                  key={repo.id}
                  className={`bg-white rounded-xl border shadow-sm transition-all ${
                    bulkMode && selected.has(repo.id)
                      ? 'border-slate-400 ring-1 ring-slate-300'
                      : 'border-gray-200 hover:shadow-md'
                  }`}
                >
                  <div className="p-5 flex items-start gap-4">
                    {bulkMode && (
                      <label className="flex items-center pt-0.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selected.has(repo.id)}
                          onChange={() => toggleSelect(repo.id)}
                          className="w-4 h-4 rounded accent-slate-600"
                        />
                      </label>
                    )}

                    <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center shrink-0 mt-0.5">
                      <svg className="w-5 h-5 text-slate-600" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
                      </svg>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <button
                          onClick={() => bulkMode ? toggleSelect(repo.id) : navigate(`/github/${repo.id}`)}
                          className="text-left"
                        >
                          <h3 className="font-semibold text-gray-900 hover:text-slate-700 text-base leading-tight">
                            {repo.full_name}
                          </h3>
                        </button>
                        <div className="flex items-center gap-2 shrink-0">
                          {repo.is_private && (
                            <span className="text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Private</span>
                          )}
                          {repo.language && (
                            <span className="text-[10px] font-semibold uppercase tracking-wide bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                              {repo.language}
                            </span>
                          )}
                        </div>
                      </div>

                      {repo.description && (
                        <p className="text-gray-500 text-sm mt-1 line-clamp-2">{repo.description}</p>
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                          </svg>
                          {repo.stars.toLocaleString()}
                        </span>
                        <span className="flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                          </svg>
                          {repo.forks.toLocaleString()} forks
                        </span>
                        <span>{repo.open_issues.toLocaleString()} open issues</span>
                        <span className="text-gray-400">
                          Fetched {repo.fetched_at.slice(0, 10)}
                        </span>
                      </div>
                    </div>

                    {!bulkMode && (
                      <div className="flex flex-col gap-2 shrink-0">
                        <button
                          onClick={() => navigate(`/github/${repo.id}`)}
                          className="px-3 py-1.5 text-xs font-semibold bg-slate-700 hover:bg-slate-800 text-white rounded-lg transition-colors"
                        >
                          View
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Delete ${repo.full_name} and all its data?`)) {
                              deleteMutation.mutate(repo.id)
                            }
                          }}
                          disabled={deleteMutation.isPending}
                          className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-red-600 hover:text-red-700 border border-red-200 hover:border-red-400 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
