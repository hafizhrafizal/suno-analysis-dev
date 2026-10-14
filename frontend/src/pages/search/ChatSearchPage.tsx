import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import ReactMarkdown from 'react-markdown'
import { apiFetch, streamEvents } from '../../api/client'
import { useSearchStore } from '../../store/searchStore'
import { useAuthStore } from '../../store/authStore'
import { usePhaseStore } from '../../store/phaseStore'
import type { Message, Upload, Stats } from '../../types'
import type { SearchTab, MatchType, TrendBucket, AnalysisTab, FilterMode, TrendPoint, SrLogEntry, MsgEmotion } from './types'
import { LOG_ICONS } from './types'
import {
  applyExactFilter, applyAnyFilter, applyFuzzyFilter, computeFilterTokens,
  fetchMsgEmotionsBatched, ssGet, ssSet,
} from './utils'
import MessageCard from './MessageCard'
import BrowseChatRow from './BrowseChatRow'
import SearchingAnimation from './SearchingAnimation'

export default function ChatSearchPage() {
  const PHASE_DEFS = usePhaseStore(s => s.defs)
  const { results, setResults, bookmarkedIds, setBookmarkedIds, toggleBookmarked } = useSearchStore()
  const { setShowKeyModal } = useAuthStore()

  // Search state
  const [activeTab, setActiveTab] = useState<SearchTab>(() => (localStorage.getItem('search_tab') as SearchTab) || 'keyword')
  const [matchType, setMatchType] = useState<MatchType>(() => ssGet('sr_match_type', 'any'))
  const [query, setQuery] = useState(() => ssGet('sr_query', ''))
  const [filterUsername, setFilterUsername] = useState(() => ssGet('sr_filter_username', ''))
  const [dateFrom, setDateFrom] = useState(() => ssGet('sr_date_from', ''))
  const [dateTo, setDateTo] = useState(() => ssGet('sr_date_to', ''))
  const [rangeDateFrom, setRangeDateFrom] = useState(() => ssGet('sr_range_date_from', ''))
  const [rangeDateTo, setRangeDateTo] = useState(() => ssGet('sr_range_date_to', ''))
  const [sunoTeam, setSunoTeam] = useState('all')
  const [filterSentiment, setFilterSentiment] = useState<'all' | 'positive' | 'negative' | 'neutral'>('all')
  const [filterEmotion, setFilterEmotion] = useState('')
  const [maxResults, setMaxResults] = useState(1000000)
  const [minWords, setMinWords] = useState(0)
  const [ctxBefore, setCtxBefore] = useState(10)
  const [ctxAfter, setCtxAfter] = useState(10)
  const [sortBy, setSortBy] = useState('similarity')
  const [showOptions, setShowOptions] = useState(false)
  const [searching, setSearching] = useState(false)
  const [didSearch, setDidSearch] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bookmarkError, setBookmarkError] = useState<string | null>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [selectedUploads, setSelectedUploads] = useState<Set<string>>(new Set())
  const [trendData, setTrendData] = useState<TrendPoint[]>(() => ssGet<TrendPoint[]>('sr_trend_data', []))
  const [trendBucket, setTrendBucket] = useState<TrendBucket>('month')
  const [lastKeyword, setLastKeyword] = useState(() => ssGet('sr_last_keyword', ''))
  const [lastTokens, setLastTokens] = useState<string[]>(() => ssGet<string[]>('sr_last_tokens', []))
  const [showSearchPanel, setShowSearchPanel] = useState(true)
  const [rangeLimit] = useState(200)
  const [rangeOffset] = useState(0)
  const [rangeMode, setRangeMode] = useState<'exact' | 'month'>('exact')

  // Analysis tabs
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>('none')

  // Summarize & Analyse state
  const [summarizeQuery, setSummarizeQuery] = useState('')
  const [summarizeResult, setSummarizeResult] = useState('')
  const [summarizeLoading, setSummarizeLoading] = useState(false)
  const [summarizeFollowUp, setSummarizeFollowUp] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [summarizeFollowUpLoading, setSummarizeFollowUpLoading] = useState(false)
  const [summarizeFollowUpInput, setSummarizeFollowUpInput] = useState('')
  const [srModel, setSrModel] = useState('gpt-4o')
  const [srRetrievalMode, setSrRetrievalMode] = useState<'cluster' | 'all'>('cluster')
  const [srLog, setSrLog] = useState<SrLogEntry[]>([])
  const [srLogVisible, setSrLogVisible] = useState(true)
  const [showSrResultsPanel, setShowSrResultsPanel] = useState(false)
  const stopSummarizeRef = useRef<(() => void) | null>(null)

  // Results filter bar state
  const [filterMode, setFilterMode] = useState<FilterMode>('any')
  const [filterText, setFilterText] = useState('')
  const [displayedResults, setDisplayedResults] = useState<Message[]>([])
  const [filterCount, setFilterCount] = useState<{ shown: number; total: number } | null>(null)
  const [filterLoading, setFilterLoading] = useState(false)
  const [filterTokens, setFilterTokens] = useState<string[]>([])

  // Chart range filter
  const [chartRange, setChartRange] = useState<{ from: string; to: string; label: string } | null>(null)

  // Per-message emotions (fetched from DB after each search)
  const [msgEmotions, setMsgEmotions] = useState<Record<string, MsgEmotion>>({})
  const requestedMsgEmotionUuidsRef = useRef(new Set<string>())

  // Phase personas (for archetype badge on MessageCard)
  const [phasePersonas, setPhasePersonas] = useState<Record<string, Record<string, string>>>({})
  const [phaseSecondaryPersonas, setPhaseSecondaryPersonas] = useState<Record<string, Record<string, string>>>({})

  // Semantic filter debounce ref
  const semanticFilterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Infinite scroll — chat results
  const [visibleCount, setVisibleCount] = useState(50)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Browse All tab — server-side pagination
  const [browseMessages, setBrowseMessages] = useState<Message[]>([])
  const [browseFetching, setBrowseFetching] = useState(false)
  const [browseHasMore, setBrowseHasMore] = useState(true)
  const [browseExporting, setBrowseExporting] = useState(false)
  const resultsAnchorRef = useRef<HTMLDivElement>(null)
  const browseOffsetRef = useRef(0)
  const browseHasMoreRef = useRef(true)
  const browseIsFetchingRef = useRef(false)
  const browseSentinelRef = useRef<HTMLDivElement>(null)
  const [browseUsernameFilter, setBrowseUsernameFilter] = useState('')
  const [browseKeywordFilter, setBrowseKeywordFilter] = useState('')
  const [browseDateFrom, setBrowseDateFrom] = useState('')
  const [browseDateTo, setBrowseDateTo] = useState('')
  const browseDateFromRef = useRef('')
  const browseDateToRef = useRef('')
  const browseScopeRef = useRef('')

  // Track which phase persona requests have been fired
  const requestedPhasePersonasRef = useRef(new Set<string>())

  const { data: _uploads } = useQuery<Upload[]>({ queryKey: ['uploads'], queryFn: () => apiFetch('/uploads') })
  const { data: _bookmarkIds } = useQuery<number[]>({ queryKey: ['bookmark-ids'], queryFn: () => apiFetch('/bookmarks/ids') })
  const { data: _stats } = useQuery<Stats>({ queryKey: ['stats'], queryFn: () => apiFetch('/stats') })
  const vdbName = _stats?.vector_db_label ?? 'ChromaDB'
  useEffect(() => { if (_uploads) setUploads(_uploads) }, [_uploads])
  useEffect(() => { if (_bookmarkIds) setBookmarkedIds(_bookmarkIds) }, [_bookmarkIds])

  // Restore results to Zustand store on mount if store is empty (page refresh)
  useEffect(() => {
    if (results.length === 0) {
      const saved = ssGet<Message[]>('sr_results', [])
      if (saved.length > 0) setResults(saved)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch stored emotions only for rows currently rendered. Loading every
  // result's emotion metadata at once makes very large searches feel frozen.
  useEffect(() => {
    const visible = displayedResults.slice(0, visibleCount)
    const uuids = visible
      .map(m => m.msg_uuid)
      .filter((u): u is string => !!u && !requestedMsgEmotionUuidsRef.current.has(u))
    if (results.length === 0) {
      requestedMsgEmotionUuidsRef.current.clear()
      setMsgEmotions({})
      return
    }
    if (uuids.length === 0) return
    let cancelled = false
    for (const uuid of uuids) requestedMsgEmotionUuidsRef.current.add(uuid)
    ;(async () => {
      for (let i = 0; i < uuids.length; i += 500) {
        const batch = uuids.slice(i, i + 500)
        try {
          const data = await fetchMsgEmotionsBatched(batch)
          if (!cancelled) setMsgEmotions(prev => ({ ...prev, ...data }))
        } catch {
          for (const uuid of batch) requestedMsgEmotionUuidsRef.current.delete(uuid)
        }
      }
    })()
    return () => { cancelled = true }
  }, [displayedResults, visibleCount, results.length])

  // Sync key state to sessionStorage
  useEffect(() => {
    if (results.length <= 5000) ssSet('sr_results', results)
    else sessionStorage.removeItem('sr_results')
  }, [results])
  useEffect(() => { ssSet('sr_query', query) }, [query])
  useEffect(() => { ssSet('sr_match_type', matchType) }, [matchType])
  useEffect(() => { ssSet('sr_date_from', dateFrom) }, [dateFrom])
  useEffect(() => { ssSet('sr_date_to', dateTo) }, [dateTo])
  useEffect(() => { ssSet('sr_range_date_from', rangeDateFrom) }, [rangeDateFrom])
  useEffect(() => { ssSet('sr_range_date_to', rangeDateTo) }, [rangeDateTo])
  useEffect(() => { ssSet('sr_filter_username', filterUsername) }, [filterUsername])
  useEffect(() => { ssSet('sr_last_keyword', lastKeyword) }, [lastKeyword])
  useEffect(() => { ssSet('sr_last_tokens', lastTokens) }, [lastTokens])
  useEffect(() => { ssSet('sr_trend_data', trendData) }, [trendData])

  // Reset to first page whenever the filtered result set changes
  useEffect(() => {
    setVisibleCount(50)
  }, [displayedResults])

  // IntersectionObserver: load next 50 when sentinel scrolls into view
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((prev) => prev + 50)
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedResults.length])

  const scopeParam = selectedUploads.size > 0 ? [...selectedUploads].join(',') : ''

  const buildParams = useCallback(() => {
    const p = new URLSearchParams()
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo) p.set('date_to', dateTo)
    if (sunoTeam === 'only') p.set('is_suno_team', 'only')
    else if (sunoTeam === 'exclude') p.set('is_suno_team', 'exclude')
    if (minWords > 0) p.set('min_words', String(minWords))
    p.set('limit', String(maxResults))
    if (scopeParam) p.set('upload_ids', scopeParam)
    return p
  }, [dateFrom, dateTo, sunoTeam, minWords, maxResults, scopeParam])

  const toggleScopeChip = (id: string) => {
    setSelectedUploads((prev) => {
      const next = new Set(prev)
      if (next.size === 0) {
        uploads.forEach((u) => { if (u.id !== id) next.add(u.id) })
      } else if (next.has(id)) {
        next.delete(id)
        if (next.size === 0) return new Set()
      } else {
        next.add(id)
        if (next.size === uploads.length) return new Set()
      }
      return next
    })
  }

  const buildTrend = useCallback((data: Message[], bucket: TrendBucket) => {
    const counts: Record<string, number> = {}
    const mins: Record<string, string> = {}
    const maxs: Record<string, string> = {}
    data.forEach((m) => {
      if (!m.date) return
      let key: string
      if (bucket === 'month') key = m.date.slice(0, 7)
      else if (bucket === 'day') key = m.date.slice(0, 10)
      else {
        const d = new Date(m.date)
        const monday = new Date(d)
        monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
        key = monday.toISOString().slice(0, 10)
      }
      counts[key] = (counts[key] || 0) + 1
      const day = m.date.slice(0, 10)
      if (!mins[key] || day < mins[key]) mins[key] = day
      if (!maxs[key] || day > maxs[key]) maxs[key] = day
    })
    const sorted = Object.keys(counts).sort()
    setTrendData(sorted.map((period) => ({
      period,
      count: counts[period],
      from: mins[period],
      to: maxs[period],
    })))
  }, [])

  const fetchBrowsePage = useCallback(async () => {
    if (browseIsFetchingRef.current || !browseHasMoreRef.current) return
    browseIsFetchingRef.current = true
    setBrowseFetching(true)
    const offset = browseOffsetRef.current
    try {
      const p = new URLSearchParams({ limit: '50', offset: String(offset) })
      if (browseDateFromRef.current) p.set('date_from', browseDateFromRef.current)
      if (browseDateToRef.current) p.set('date_to', browseDateToRef.current)
      if (browseScopeRef.current) p.set('upload_ids', browseScopeRef.current)
      const data = await apiFetch<Message[]>(`/search/range?${p}`)
      setBrowseMessages((prev) => (offset === 0 ? data : [...prev, ...data]))
      browseOffsetRef.current = offset + data.length
      if (data.length < 50) { browseHasMoreRef.current = false; setBrowseHasMore(false) }
    } catch {
      // silent
    } finally {
      browseIsFetchingRef.current = false
      setBrowseFetching(false)
    }
  }, [])

  // Auto-fetch first page when switching to Browse tab
  useEffect(() => {
    if (activeTab === 'browse') {
      fetchBrowsePage()
    }
  }, [activeTab, fetchBrowsePage])

  // Re-fetch from scratch when browse date filters or scope changes
  useEffect(() => {
    if (activeTab !== 'browse') return
    browseDateFromRef.current = browseDateFrom
    browseDateToRef.current = browseDateTo
    browseScopeRef.current = scopeParam
    browseOffsetRef.current = 0
    browseHasMoreRef.current = true
    browseIsFetchingRef.current = false
    setBrowseMessages([])
    setBrowseFetching(false)
    setBrowseHasMore(true)
    fetchBrowsePage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseDateFrom, browseDateTo, scopeParam])

  // IntersectionObserver for Browse All infinite scroll
  useEffect(() => {
    if (activeTab !== 'browse') return
    const el = browseSentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) fetchBrowsePage()
      },
      { rootMargin: '400px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [activeTab, browseMessages.length, fetchBrowsePage])

  const formatTrendPeriod = useCallback((period: string) => {
    if (trendBucket === 'month') {
      const [y, m] = period.split('-').map(Number)
      const d = new Date(y, m - 1, 1)
      return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    }
    if (trendBucket === 'week') {
      const [y, m, day] = period.split('-').map(Number)
      const d = new Date(y, m - 1, day)
      const weekOfMonth = Math.ceil(day / 7)
      return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) + ` W${weekOfMonth}`
    }
    return period
  }, [trendBucket])

  const browseTokens = useMemo(() => {
    if (!browseKeywordFilter.trim()) return []
    return browseKeywordFilter.trim().split(/\s+/).filter(Boolean)
  }, [browseKeywordFilter])

  const filteredBrowseMessages = useMemo(() => {
    let msgs = browseMessages
    if (browseUsernameFilter.trim()) {
      const lc = browseUsernameFilter.toLowerCase()
      msgs = msgs.filter((m) => m.username?.toLowerCase().includes(lc))
    }
    if (browseTokens.length > 0) {
      const words = browseTokens.map((w) => w.toLowerCase())
      msgs = msgs.filter((m) => {
        const lc = m.content.toLowerCase()
        return words.some((w) => lc.includes(w))
      })
    }
    return msgs
  }, [browseMessages, browseUsernameFilter, browseTokens])

  const handleBrowseDownloadCsv = useCallback(async () => {
    setBrowseExporting(true)
    try {
      const p = new URLSearchParams()
      if (browseDateFrom) p.set('date_from', browseDateFrom)
      if (browseDateTo) p.set('date_to', browseDateTo)
      if (scopeParam) p.set('upload_ids', scopeParam)
      const res = await fetch(`/api/messages/export?${p}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `chat_export_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('CSV export error:', err)
    } finally {
      setBrowseExporting(false)
    }
  }, [browseDateFrom, browseDateTo, scopeParam])

  // Apply text filter + optional chart range filter on top of full results
  const applyFilters = useCallback((
    allResults: Message[],
    mode: FilterMode,
    text: string,
    range: { from: string; to: string; label: string } | null,
    tokens: string[],
  ) => {
    let filtered = allResults

    if (range) {
      filtered = filtered.filter((m) => {
        const d = m.date?.slice(0, 10) ?? ''
        return d >= range.from && d <= range.to
      })
    }

    if (text.trim()) {
      if (mode === 'exact') {
        filtered = applyExactFilter(filtered, text)
      } else if (mode === 'any') {
        filtered = applyAnyFilter(filtered, text)
      } else if (mode === 'fuzzy') {
        filtered = applyFuzzyFilter(filtered, text)
      }
    }

    setDisplayedResults(filtered)
    setFilterTokens(tokens)
    const hasFilter = text.trim() || range
    setFilterCount(hasFilter ? { shown: filtered.length, total: allResults.length } : null)
  }, [])

  const runSemanticFilter = useCallback(async (text: string, allResults: Message[]) => {
    if (!text.trim()) {
      setDisplayedResults(allResults)
      setFilterCount(null)
      setFilterTokens([])
      return
    }
    if (!localStorage.getItem('openai_api_key')) { setShowKeyModal(true); return }
    setFilterLoading(true)
    try {
      const data = await apiFetch<Message[]>('/filter/semantic', {
        method: 'POST',
        body: JSON.stringify({ query: text, messages: allResults }),
      })
      setDisplayedResults(data)
      setFilterTokens([])
      setFilterCount({ shown: data.length, total: allResults.length })
    } catch {
      setDisplayedResults(allResults)
      setFilterCount(null)
    } finally {
      setFilterLoading(false)
    }
  }, [setShowKeyModal])

  // When filter text or mode changes, recompute displayedResults
  useEffect(() => {
    if (results.length === 0) return
    if (filterMode === 'semantic') {
      if (semanticFilterTimerRef.current) clearTimeout(semanticFilterTimerRef.current)
      semanticFilterTimerRef.current = setTimeout(() => {
        runSemanticFilter(filterText, results)
      }, 500)
    } else {
      const tokens = computeFilterTokens(filterMode, filterText)
      applyFilters(results, filterMode, filterText, chartRange, tokens)
    }
  }, [filterText, filterMode, results, chartRange, applyFilters, runSemanticFilter])

  const handleChartBarClick = (pt: TrendPoint) => {
    if (chartRange?.from === pt.from) {
      setChartRange(null)
      const tokens = computeFilterTokens(filterMode, filterText)
      applyFilters(results, filterMode, filterText, null, tokens)
    } else {
      const range = { from: pt.from, to: pt.to, label: pt.period }
      setChartRange(range)
      const tokens = computeFilterTokens(filterMode, filterText)
      applyFilters(results, filterMode, filterText, range, tokens)
    }
  }

  const doSearch = useCallback(async () => {
    setSearching(true)
    setTimeout(() => resultsAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30)
    setError(null)
    setTrendData([])
    setFilterText('')
    setFilterMode('any')
    setFilterCount(null)
    setFilterTokens([])
    setChartRange(null)
    setAnalysisTab('none')
    setResults([])
    setDisplayedResults([])

    if (activeTab === 'range' && !rangeDateFrom && !rangeDateTo) {
      setError('Please enter at least one date before searching.')
      setSearching(false)
      return
    }

    try {
      const params = buildParams()
      let data: Message[] = []
      let kw = ''
      let toks: string[] = []

      if (filterSentiment !== 'all') params.set('sentiment', filterSentiment)
      if (filterEmotion) params.set('emotion', filterEmotion)
      if (activeTab === 'keyword') {
        if (!query.trim()) { setSearching(false); return }
        params.set('q', query)
        params.set('match_type', matchType === 'any' ? 'any_word' : matchType)
        if (filterUsername) params.set('username', filterUsername)
        data = await apiFetch<Message[]>(`/search/keyword?${params}`)
        kw = query
        if (matchType === 'exact') toks = [query]
        else if (matchType === 'any') toks = query.split(/\s+/).filter(Boolean)
      } else if (activeTab === 'semantic') {
        if (!query.trim()) { setSearching(false); return }
        if (!localStorage.getItem('openai_api_key')) { setShowKeyModal(true); setSearching(false); return }
        params.set('q', query)
        if (filterUsername) params.set('username', filterUsername)
        if (sortBy !== 'similarity') params.set('sort_by', sortBy)
        const raw = await apiFetch<Message[] | { error: string; results: [] }>(`/search/semantic?${params}`)
        if (Array.isArray(raw)) {
          data = raw
        } else {
          setError((raw as { error: string }).error || `Semantic search unavailable (${vdbName} may not be running)`)
          data = []
        }
        kw = query
      } else if (activeTab === 'username') {
        if (!query.trim()) { setSearching(false); return }
        params.set('q', query)
        data = await apiFetch<Message[]>(`/search/username?${params}`)
      } else if (activeTab === 'range') {
        const p = new URLSearchParams()
        if (rangeDateFrom) p.set('date_from', rangeDateFrom)
        if (rangeDateTo) p.set('date_to', rangeDateTo)
        if (sunoTeam === 'only') p.set('is_suno_team', 'only')
        else if (sunoTeam === 'exclude') p.set('is_suno_team', 'exclude')
        if (minWords > 0) p.set('min_words', String(minWords))
        if (scopeParam) p.set('upload_ids', scopeParam)
        p.set('limit', String(maxResults))
        p.set('offset', String(rangeOffset))
        if (filterSentiment !== 'all') p.set('sentiment', filterSentiment)
        if (filterEmotion) p.set('emotion', filterEmotion)
        data = await apiFetch<Message[]>(`/search/range?${p}`)
      }

      setResults(data)
      setDisplayedResults(data)
      setLastKeyword(kw)
      setLastTokens(toks)
      if (data.length > 0) buildTrend(data, trendBucket)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearching(false)
      setDidSearch(true)
      setTimeout(() => resultsAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
    }
  }, [query, activeTab, matchType, filterUsername, filterSentiment, filterEmotion, buildParams, rangeLimit, rangeOffset, sortBy, trendBucket, setResults, buildTrend, dateFrom, dateTo, rangeDateFrom, rangeDateTo, sunoTeam, minWords, scopeParam, setShowKeyModal, maxResults, vdbName])

  const handleBookmarkToggle = async (msg: Message) => {
    const wasBookmarked = bookmarkedIds.has(msg.id)
    toggleBookmarked(msg.id)
    try {
      if (wasBookmarked) {
        await apiFetch(`/bookmarks/by-msg/${msg.id}`, { method: 'DELETE' })
      } else {
        await apiFetch('/bookmarks', {
          method: 'POST',
          body: JSON.stringify({ msg_id: msg.id }),
        })
      }
    } catch (err) {
      toggleBookmarked(msg.id)
      const msg2 = err instanceof Error ? err.message : 'Bookmark action failed'
      setBookmarkError(msg2)
      setTimeout(() => setBookmarkError(null), 5000)
    }
  }

  const handleTabSwitch = (tab: SearchTab) => {
    localStorage.setItem('search_tab', tab)
    setActiveTab(tab)
    setResults([])
    setDisplayedResults([])
    setTrendData([])
    setLastKeyword('')
    setLastTokens([])
    setFilterText('')
    setFilterCount(null)
    setFilterTokens([])
    setChartRange(null)
    setAnalysisTab('none')
    setDidSearch(false)
    if (tab === 'browse') {
      browseOffsetRef.current = 0
      browseHasMoreRef.current = true
      browseIsFetchingRef.current = false
      browseDateFromRef.current = ''
      browseDateToRef.current = ''
      browseScopeRef.current = scopeParam
      setBrowseMessages([])
      setBrowseFetching(false)
      setBrowseHasMore(true)
      setBrowseUsernameFilter('')
      setBrowseKeywordFilter('')
      setBrowseDateFrom('')
      setBrowseDateTo('')
    }
  }

  const exportCSV = () => {
    const rows = results
    if (rows.length === 0) return

    const normSunoTeam = (v: string | boolean | null | undefined): string => {
      if (v === true) return 'true'
      if (v === false) return 'false'
      if (typeof v === 'string' && v.length > 0) {
        const l = v.toLowerCase()
        if (l === 'true' || l === '1') return 'true'
        if (l === 'false' || l === '0') return 'false'
      }
      return ''
    }

    const header = ['id', 'username', 'date', 'content', 'is_suno_team']
    const lines = rows.map((r) =>
      [r.id, r.username, r.date, `"${(r.content || '').replace(/"/g, '""')}"`, normSunoTeam(r.is_suno_team)].join(',')
    )
    const csv = [header.join(','), ...lines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url

    const isRange = activeTab === 'range'
    const from = isRange ? rangeDateFrom : dateFrom
    const to = isRange ? rangeDateTo : dateTo
    const parts: string[] = ['discord', activeTab]
    if (from) parts.push(from)
    if (from && to) parts.push('to')
    if (to) parts.push(to)
    if (sunoTeam === 'only') parts.push('suno-only')
    else if (sunoTeam === 'exclude') parts.push('suno-exclude')
    if (minWords > 0) parts.push(`min${minWords}w`)
    a.download = parts.join('_') + '.csv'

    a.click()
    URL.revokeObjectURL(url)
  }

  const handleSummarize = () => {
    if (!localStorage.getItem('openai_api_key')) { setShowKeyModal(true); return }
    const msgs = results
    if (msgs.length === 0) return
    setSummarizeResult('')
    setSummarizeFollowUp([])
    setSummarizeLoading(true)
    setSrLog([])
    setShowSrResultsPanel(true)

    if (stopSummarizeRef.current) stopSummarizeRef.current()

    stopSummarizeRef.current = streamEvents(
      '/summarize-results',
      {
        messages: msgs.map((m) => ({ username: m.username, date: m.date, content: m.content, msg_uuid: m.msg_uuid })),
        prompt: summarizeQuery,
        model: srModel,
        retrieval_mode: srRetrievalMode,
      },
      (event) => {
        if (event.type === 'log') {
          setSrLog((prev) => [...prev, {
            step: String(event.step ?? ''),
            label: String(event.label ?? event.step ?? ''),
            msg: String(event.message ?? event.msg ?? ''),
          }])
        } else if (event.content) {
          setSummarizeResult((prev) => prev + String(event.content))
        }
      },
      () => setSummarizeLoading(false),
      (err) => {
        setSummarizeResult(`Error: ${err.message}`)
        setSummarizeLoading(false)
      },
    )
  }

  const handleSumFollowUp = () => {
    if (!summarizeFollowUpInput.trim() || summarizeFollowUpLoading) return
    if (!localStorage.getItem('openai_api_key')) { setShowKeyModal(true); return }
    const q = summarizeFollowUpInput.trim()
    setSummarizeFollowUpInput('')
    setSummarizeFollowUp((prev) => [...prev, { role: 'user', content: q }])
    setSummarizeFollowUpLoading(true)
    let answer = ''
    streamEvents(
      '/summarize-results/followup',
      { question: q, summary: summarizeResult, history: summarizeFollowUp },
      (event) => {
        if (event.type === 'chunk') {
          answer += String(event.content ?? '')
          setSummarizeFollowUp((prev) => {
            const last = prev[prev.length - 1]
            if (last?.role === 'assistant') return [...prev.slice(0, -1), { role: 'assistant', content: answer }]
            return [...prev, { role: 'assistant', content: answer }]
          })
        } else if (event.type === 'result') {
          answer = String(event.content ?? answer)
          setSummarizeFollowUp((prev) => {
            const last = prev[prev.length - 1]
            if (last?.role === 'assistant') return [...prev.slice(0, -1), { role: 'assistant', content: answer }]
            return [...prev, { role: 'assistant', content: answer }]
          })
        }
      },
      () => setSummarizeFollowUpLoading(false),
      (err) => {
        setSummarizeFollowUp((prev) => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
        setSummarizeFollowUpLoading(false)
      },
    )
  }

  const handleExportPDF = () => {
    if (!summarizeResult) return
    const win = window.open('', '_blank')
    if (!win) return
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Analysis Export</title>
      <style>
        body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; color: #1a1a1a; }
        h1, h2, h3 { color: #1e1b4b; }
        pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
        blockquote { border-left: 4px solid #818cf8; margin: 0; padding-left: 16px; color: #555; }
        .followup { margin-top: 32px; border-top: 2px solid #e5e7eb; padding-top: 16px; }
        .q { font-weight: bold; color: #3730a3; margin-bottom: 4px; }
        .a { margin-bottom: 16px; }
      </style>
    </head><body>`)
    win.document.write(`<h1>Analysis Results</h1>`)
    win.document.write(`<div>${summarizeResult.replace(/\n/g, '<br>')}</div>`)
    if (summarizeFollowUp.length > 0) {
      win.document.write(`<div class="followup"><h2>Follow-up Q&amp;A</h2>`)
      summarizeFollowUp.forEach((h) => {
        if (h.role === 'user') {
          win.document.write(`<div class="q">Q: ${h.content}</div>`)
        } else {
          win.document.write(`<div class="a">${h.content.replace(/\n/g, '<br>')}</div>`)
        }
      })
      win.document.write(`</div>`)
    }
    win.document.write(`</body></html>`)
    win.document.close()
    win.print()
  }

  const toggleAnalysisTab = (tab: 'summarize' | 'viz') => {
    setAnalysisTab((prev) => prev === tab ? 'none' : tab)
  }

  // Map a message date string to the phase key it falls in
  const dateToPhaseKey = useCallback((date: string): string | null => {
    const d = date?.slice(0, 10) ?? ''
    if (!d) return null
    for (const def of PHASE_DEFS) {
      if (d >= def.from && (!def.to || d <= def.to)) return def.key
    }
    return null
  }, [PHASE_DEFS])

  // When search results arrive, pre-fetch phase personas for any phase represented in results
  useEffect(() => {
    if (results.length === 0) return
    const phaseKeys = new Set<string>()
    for (const msg of results) {
      const key = dateToPhaseKey(msg.date ?? '')
      if (key) phaseKeys.add(key)
    }
    for (const key of phaseKeys) {
      if (requestedPhasePersonasRef.current.has(key)) continue
      requestedPhasePersonasRef.current.add(key)
      apiFetch<{ username: string; persona: string; secondary_persona?: string }[]>(
        `/persona/by-phase?phase=${encodeURIComponent(key)}&method=archetype`
      ).then(rows => {
        const map: Record<string, string> = {}
        const secMap: Record<string, string> = {}
        for (const r of rows) {
          map[r.username] = r.persona
          if (r.secondary_persona) secMap[r.username] = r.secondary_persona
        }
        setPhasePersonas(prev => ({ ...prev, [key]: map }))
        setPhaseSecondaryPersonas(prev => ({ ...prev, [key]: secMap }))
      }).catch(() => {})
    }
  }, [results, dateToPhaseKey])

  const inputCls = 'search-input'
  const tabs: { id: SearchTab; label: string }[] = [
    { id: 'browse', label: 'Browse All' },
    { id: 'keyword', label: 'Keyword Search' },
    { id: 'semantic', label: 'Semantic Search' },
    { id: 'username', label: 'Username Search' },
    { id: 'range', label: 'Time Range' },
  ]

  const activeTokens = filterText.trim() ? filterTokens : lastTokens
  const activeKeyword = filterText.trim() ? '' : lastKeyword

  const filterPlaceholder: Record<FilterMode, string> = {
    exact: 'Filter: all words must match…',
    any: 'Filter: any word matches…',
    fuzzy: 'Filter: fuzzy char-order match…',
    semantic: 'Filter: semantic similarity…',
  }

  const retrievalHint: Record<'cluster' | 'all', string> = {
    cluster: 'Groups messages by topic and samples representatives. Best for large result sets.',
    all: 'Passes all messages directly to the model. Use for small result sets (<100 msgs).',
  }

  // Suppress unused variable warning
  void phaseSecondaryPersonas

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 space-y-4">

      {/* Scope selector */}
      <section className="bg-white rounded-2xl shadow p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide">Search Scope</h2>
          <div className="flex gap-2 items-center">
            <button onClick={() => setSelectedUploads(new Set())} className="text-xs font-semibold text-indigo-700 hover:underline">All</button>
            <span className="text-gray-400">|</span>
            <button onClick={() => setSelectedUploads(new Set(uploads.map(u => u.id)))} className="text-xs font-semibold text-indigo-700 hover:underline">None</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {uploads.length === 0 ? (
            <span className="text-xs text-gray-400 italic">No uploads yet — go to the Settings page to add data.</span>
          ) : (
            uploads.map((u) => {
              const active = selectedUploads.size === 0 || selectedUploads.has(u.id)
              return (
                <button
                  key={u.id}
                  onClick={() => toggleScopeChip(u.id)}
                  className={`scope-chip ${active ? 'scope-chip-on' : 'scope-chip-off'}`}
                  title={u.id}
                >
                  {u.filename}
                  <span className="text-[10px] opacity-70">{Number(u.row_count).toLocaleString()} rows</span>
                </button>
              )
            })
          )}
        </div>
        <p className="text-xs text-gray-600 mt-2">Toggle which uploaded files to include. All selected = search everything.</p>
      </section>

      {/* Search section */}
      <section
        className="bg-white rounded-2xl shadow p-5"
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          const tag = (e.target as HTMLElement).tagName.toLowerCase()
          if (tag === 'button' || tag === 'textarea') return
          doSearch()
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide">Search Options</h2>
          <button
            onClick={() => setShowSearchPanel((v) => !v)}
            className="text-gray-400 hover:text-gray-600 text-xs"
          >
            {showSearchPanel ? '▲ Collapse' : '▼ Expand'}
          </button>
        </div>

        {showSearchPanel && (
          <>
            {/* Chat / Users navigation row */}
            <div className="flex gap-1 mb-4 items-center justify-between">
              <div className="flex gap-1">
                <button className="subtab-btn subtab-btn-active">Chat Data</button>
              </div>
              <Link
                to="/discord/search/users"
                className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 hover:underline transition-colors"
              >
                Users Analysis →
              </Link>
            </div>

            {/* Chat search tab bar */}
            <div className="flex border-b mb-4 overflow-x-auto">
              {tabs.map((t) => (
                <button key={t.id} onClick={() => handleTabSwitch(t.id)} className={`search-tab whitespace-nowrap${activeTab === t.id ? ' tab-active' : ''}`}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Keyword tab */}
            {activeTab === 'keyword' && (
              <>
                <div className="flex gap-2 mb-4 items-center">
                  <div className="inline-flex shrink-0">
                    {(['any', 'fuzzy', 'exact'] as MatchType[]).map((m) => (
                      <button key={m} onClick={() => setMatchType(m)} className={`range-mode-btn${matchType === m ? ' range-mode-active' : ''}`}>
                        {m === 'any' ? 'Any Word' : m === 'fuzzy' ? 'Fuzzy' : 'Exact'}
                      </button>
                    ))}
                  </div>
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Keyword or phrase…" className={`${inputCls} flex-1`} />
                  <button onClick={doSearch} disabled={searching} className="search-btn">{searching ? 'Searching…' : 'Search'}</button>
                </div>
                <button onClick={() => setShowOptions((v) => !v)} className="flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600 mb-2 transition-colors">
                  <svg className={`w-3 h-3 transition-transform duration-200${showOptions ? ' rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/>
                  </svg>
                  <span>Options</span>
                </button>
                {showOptions && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Username</label>
                      <input value={filterUsername} onChange={(e) => setFilterUsername(e.target.value)} placeholder="Optional username…" className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">From</label>
                      <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">To</label>
                      <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Suno Team</label>
                      <select value={sunoTeam} onChange={(e) => setSunoTeam(e.target.value)} className={inputCls}>
                        <option value="all">All</option>
                        <option value="only">Only Suno Team</option>
                        <option value="exclude">Exclude Suno Team</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Limit</label>
                      <input type="text" inputMode="numeric" value={String(maxResults)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMaxResults(d ? parseInt(d) : 1000000) }} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Min Words</label>
                      <input type="text" inputMode="numeric" value={String(minWords)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinWords(d ? parseInt(d) : 0) }} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Sentiment</label>
                      <div className="inline-flex">
                        {(['all', 'positive', 'negative', 'neutral'] as const).map(s => (
                          <button key={s} onClick={() => setFilterSentiment(s)} className={`range-mode-btn${filterSentiment === s ? ' range-mode-active' : ''}`}>
                            {s === 'all' ? 'All' : s === 'positive' ? '😊 +' : s === 'negative' ? '😞 −' : '😐 ±'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Emotion</label>
                      <select value={filterEmotion} onChange={e => setFilterEmotion(e.target.value)} className={inputCls}>
                        <option value="">Any</option>
                        <optgroup label="Positive">
                          {['admiration','amusement','approval','caring','excitement','gratitude','joy','love','optimism','pride','relief'].map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Negative">
                          {['anger','annoyance','disappointment','disapproval','disgust','embarrassment','fear','grief','nervousness','remorse','sadness'].map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Ambiguous">
                          {['confusion','curiosity','desire','realization','surprise'].map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Neutral">
                          <option value="neutral">neutral</option>
                        </optgroup>
                      </select>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Semantic tab */}
            {activeTab === 'semantic' && (
              <>
                <div className="flex gap-2 mb-4">
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Describe what you're looking for…" className={`${inputCls} flex-1`} />
                  <button onClick={doSearch} disabled={searching} className="search-btn">{searching ? 'Searching…' : 'Search'}</button>
                </div>
                <button onClick={() => setShowOptions((v) => !v)} className="flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600 mb-2 transition-colors">
                  <svg className={`w-3 h-3 transition-transform duration-200${showOptions ? ' rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/>
                  </svg>
                  <span>Options</span>
                </button>
                {showOptions && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Username</label>
                      <input value={filterUsername} onChange={(e) => setFilterUsername(e.target.value)} placeholder="Optional username…" className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">From</label>
                      <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">To</label>
                      <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Suno Team</label>
                      <select value={sunoTeam} onChange={(e) => setSunoTeam(e.target.value)} className={inputCls}>
                        <option value="all">All</option>
                        <option value="only">Only Suno Team</option>
                        <option value="exclude">Exclude Suno Team</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Limit</label>
                      <input type="text" inputMode="numeric" value={String(maxResults)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMaxResults(d ? parseInt(d) : 1000000) }} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Min Words</label>
                      <input type="text" inputMode="numeric" value={String(minWords)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinWords(d ? parseInt(d) : 0) }} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Sort By</label>
                      <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className={inputCls}>
                        <option value="similarity">Similarity ↓</option>
                        <option value="date_asc">Date (oldest first)</option>
                        <option value="date_desc">Date (newest first)</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Sentiment</label>
                      <div className="inline-flex">
                        {(['all', 'positive', 'negative', 'neutral'] as const).map(s => (
                          <button key={s} onClick={() => setFilterSentiment(s)} className={`range-mode-btn${filterSentiment === s ? ' range-mode-active' : ''}`}>
                            {s === 'all' ? 'All' : s === 'positive' ? '😊 +' : s === 'negative' ? '😞 −' : '😐 ±'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Emotion</label>
                      <select value={filterEmotion} onChange={e => setFilterEmotion(e.target.value)} className={inputCls}>
                        <option value="">Any</option>
                        <optgroup label="Positive">
                          {['admiration','amusement','approval','caring','excitement','gratitude','joy','love','optimism','pride','relief'].map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Negative">
                          {['anger','annoyance','disappointment','disapproval','disgust','embarrassment','fear','grief','nervousness','remorse','sadness'].map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Ambiguous">
                          {['confusion','curiosity','desire','realization','surprise'].map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Neutral">
                          <option value="neutral">neutral</option>
                        </optgroup>
                      </select>
                    </div>
                  </div>
                )}
                <p className="text-xs text-gray-500 mt-3">Requires embedded data. Author &amp; date filter applied after retrieval.</p>
              </>
            )}

            {/* Username tab */}
            {activeTab === 'username' && (
              <>
                <div className="flex gap-2 mb-4">
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Username or partial match…" className={`${inputCls} flex-1`} />
                  <button onClick={doSearch} disabled={searching} className="search-btn">{searching ? 'Searching…' : 'Search'}</button>
                </div>
                <button onClick={() => setShowOptions((v) => !v)} className="flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600 mb-2 transition-colors">
                  <svg className={`w-3 h-3 transition-transform duration-200${showOptions ? ' rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/>
                  </svg>
                  <span>Options</span>
                </button>
                {showOptions && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">From</label>
                      <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">To</label>
                      <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Suno Team</label>
                      <select value={sunoTeam} onChange={(e) => setSunoTeam(e.target.value)} className={inputCls}>
                        <option value="all">All</option>
                        <option value="only">Only Suno Team</option>
                        <option value="exclude">Exclude Suno Team</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Limit</label>
                      <input type="text" inputMode="numeric" value={String(maxResults)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMaxResults(d ? parseInt(d) : 1000000) }} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Min Words</label>
                      <input type="text" inputMode="numeric" value={String(minWords)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinWords(d ? parseInt(d) : 0) }} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Sentiment</label>
                      <div className="inline-flex">
                        {(['all', 'positive', 'negative', 'neutral'] as const).map(s => (
                          <button key={s} onClick={() => setFilterSentiment(s)} className={`range-mode-btn${filterSentiment === s ? ' range-mode-active' : ''}`}>
                            {s === 'all' ? 'All' : s === 'positive' ? '😊 +' : s === 'negative' ? '😞 −' : '😐 ±'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Emotion</label>
                      <select value={filterEmotion} onChange={e => setFilterEmotion(e.target.value)} className={inputCls}>
                        <option value="">Any</option>
                        <optgroup label="Positive">
                          {['admiration','amusement','approval','caring','excitement','gratitude','joy','love','optimism','pride','relief'].map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Negative">
                          {['anger','annoyance','disappointment','disapproval','disgust','embarrassment','fear','grief','nervousness','remorse','sadness'].map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Ambiguous">
                          {['confusion','curiosity','desire','realization','surprise'].map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Neutral">
                          <option value="neutral">neutral</option>
                        </optgroup>
                      </select>
                    </div>
                  </div>
                )}
                <p className="text-xs text-gray-500 mt-3">Partial match, case-insensitive.</p>
              </>
            )}

            {/* Phase shortcuts — shared by keyword / semantic / username tabs (all use dateFrom/dateTo) */}
            {(activeTab === 'keyword' || activeTab === 'semantic' || activeTab === 'username') && showOptions && (() => {
              type PhaseKey = '1' | '2' | '3' | '3a' | '3b' | '3c' | '3d'
              const ap: PhaseKey | null =
                dateFrom === '2023-04-01' && dateTo === '2023-07-18' ? '1' :
                dateFrom === '2023-07-19' && dateTo === '2023-09-05' ? '2' :
                dateFrom === '2023-09-06' && dateTo === '' ? '3' :
                dateFrom === '2023-09-06' && dateTo === '2023-12-18' ? '3a' :
                dateFrom === '2023-12-18' && dateTo === '2024-03-17' ? '3b' :
                dateFrom === '2024-03-17' && dateTo === '2024-05-16' ? '3c' :
                dateFrom === '2024-05-17' && dateTo === '' ? '3d' : null
              const set = (p: PhaseKey) => {
                if (ap === p) { setDateFrom(''); setDateTo(''); return }
                if (p === '1')       { setDateFrom('2023-04-01'); setDateTo('2023-07-18') }
                else if (p === '2')  { setDateFrom('2023-07-19'); setDateTo('2023-09-05') }
                else if (p === '3')  { setDateFrom('2023-09-06'); setDateTo('') }
                else if (p === '3a') { setDateFrom('2023-09-06'); setDateTo('2023-12-18') }
                else if (p === '3b') { setDateFrom('2023-12-18'); setDateTo('2024-03-17') }
                else if (p === '3c') { setDateFrom('2024-03-17'); setDateTo('2024-05-16') }
                else if (p === '3d') { setDateFrom('2024-05-17'); setDateTo('') }
              }
              return (
                <div className="mt-2 mb-1 flex flex-wrap gap-1.5">
                  <span className="filter-label self-center shrink-0">Phase</span>
                  {([
                    { key: '1',  label: 'Phase 1 — Capability Surfacing',     dates: 'Apr–18 Jul 2023',         cls: ['border-blue-400 bg-blue-100 text-blue-800',         'border-blue-300 text-blue-700 hover:bg-blue-50']         },
                    { key: '2',  label: 'Phase 2 — Enclosure & Scrutiny',     dates: '19 Jul–5 Sep 2023',       cls: ['border-amber-400 bg-amber-100 text-amber-800',       'border-amber-300 text-amber-700 hover:bg-amber-50']       },
                    { key: '3',  label: 'Phase 3 — Commercialization',        dates: 'Sep 2023 onward',         cls: ['border-emerald-400 bg-emerald-100 text-emerald-800', 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'] },
                    { key: '3a', label: 'Phase 3A — Early Commercialization', dates: '6 Sep–18 Dec 2023',       cls: ['border-violet-400 bg-violet-100 text-violet-800',    'border-violet-300 text-violet-700 hover:bg-violet-50']    },
                    { key: '3b', label: 'Phase 3B — Early Wide Adoption',     dates: '18 Dec 2023–17 Mar 2024', cls: ['border-sky-400 bg-sky-100 text-sky-800',             'border-sky-300 text-sky-700 hover:bg-sky-50']             },
                    { key: '3c', label: 'Phase 3C — Pre-Litigation',          dates: '17 Mar–16 May 2024',      cls: ['border-orange-400 bg-orange-100 text-orange-800',    'border-orange-300 text-orange-700 hover:bg-orange-50']    },
                    { key: '3d', label: 'Phase 3D — Warning & Lawsuit',       dates: '17 May 2024 onward',      cls: ['border-rose-400 bg-rose-100 text-rose-800',          'border-rose-300 text-rose-700 hover:bg-rose-50']          },
                  ] as { key: PhaseKey; label: string; dates: string; cls: [string, string] }[]).map(({ key, label, dates, cls }) => (
                    <button
                      key={key}
                      onClick={() => set(key)}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors font-medium ${ap === key ? cls[0] + ' font-semibold' : cls[1]}`}
                    >
                      {label} <span className="opacity-60 ml-1">{dates}</span>
                    </button>
                  ))}
                </div>
              )
            })()}

            {/* Time Range tab */}
            {activeTab === 'range' && (
              <>
                <div className="inline-flex mb-3">
                  <button onClick={() => setRangeMode('exact')} className={`range-mode-btn${rangeMode === 'exact' ? ' range-mode-active' : ''}`}>Exact Date Range</button>
                  <button onClick={() => setRangeMode('month')} className={`range-mode-btn${rangeMode === 'month' ? ' range-mode-active' : ''}`}>By Month &amp; Year</button>
                </div>

                {/* Phase template shortcuts */}
                {(() => {
                  type PhaseKey = '1' | '2' | '3' | '3a' | '3b' | '3c' | '3d'
                  const rangeActivePhase: PhaseKey | null =
                    rangeDateFrom === '2023-04-01' && rangeDateTo === '2023-07-18' ? '1' :
                    rangeDateFrom === '2023-07-19' && rangeDateTo === '2023-09-05' ? '2' :
                    rangeDateFrom === '2023-09-06' && rangeDateTo === '' ? '3' :
                    rangeDateFrom === '2023-09-06' && rangeDateTo === '2023-12-18' ? '3a' :
                    rangeDateFrom === '2023-12-18' && rangeDateTo === '2024-03-17' ? '3b' :
                    rangeDateFrom === '2024-03-17' && rangeDateTo === '2024-05-16' ? '3c' :
                    rangeDateFrom === '2024-05-17' && rangeDateTo === '' ? '3d' : null

                  const applyPhase = (p: PhaseKey) => {
                    if (rangeActivePhase === p) {
                      setRangeDateFrom(''); setRangeDateTo('')
                    } else {
                      setRangeMode('exact')
                      if (p === '1')  { setRangeDateFrom('2023-04-01'); setRangeDateTo('2023-07-18') }
                      else if (p === '2')  { setRangeDateFrom('2023-07-19'); setRangeDateTo('2023-09-05') }
                      else if (p === '3')  { setRangeDateFrom('2023-09-06'); setRangeDateTo('') }
                      else if (p === '3a') { setRangeDateFrom('2023-09-06'); setRangeDateTo('2023-12-18') }
                      else if (p === '3b') { setRangeDateFrom('2023-12-18'); setRangeDateTo('2024-03-17') }
                      else if (p === '3c') { setRangeDateFrom('2024-03-17'); setRangeDateTo('2024-05-16') }
                      else if (p === '3d') { setRangeDateFrom('2024-05-17'); setRangeDateTo('') }
                    }
                  }

                  return (
                    <div className="flex flex-wrap gap-2 mb-3">
                      <span className="filter-label self-center shrink-0">Phase</span>
                      <button
                        onClick={() => applyPhase('1')}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${rangeActivePhase === '1' ? 'border-blue-400 bg-blue-100 text-blue-800 font-semibold' : 'border-blue-300 text-blue-700 hover:bg-blue-50'}`}
                      >
                        Phase 1 — Capability Surfacing <span className="opacity-60 ml-1">Apr–18 Jul 2023</span>
                      </button>
                      <button
                        onClick={() => applyPhase('2')}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${rangeActivePhase === '2' ? 'border-amber-400 bg-amber-100 text-amber-800 font-semibold' : 'border-amber-300 text-amber-700 hover:bg-amber-50'}`}
                      >
                        Phase 2 — Enclosure &amp; Scrutiny <span className="opacity-60 ml-1">19 Jul–5 Sep 2023</span>
                      </button>
                      <button
                        onClick={() => applyPhase('3')}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${rangeActivePhase === '3' ? 'border-emerald-400 bg-emerald-100 text-emerald-800 font-semibold' : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'}`}
                      >
                        Phase 3 — Commercialization <span className="opacity-60 ml-1">Sep 2023 onward</span>
                      </button>
                      <button
                        onClick={() => applyPhase('3a')}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${rangeActivePhase === '3a' ? 'border-violet-400 bg-violet-100 text-violet-800 font-semibold' : 'border-violet-300 text-violet-700 hover:bg-violet-50'}`}
                      >
                        Phase 3A — Early Commercialization <span className="opacity-60 ml-1">6 Sep–18 Dec 2023</span>
                      </button>
                      <button
                        onClick={() => applyPhase('3b')}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${rangeActivePhase === '3b' ? 'border-sky-400 bg-sky-100 text-sky-800 font-semibold' : 'border-sky-300 text-sky-700 hover:bg-sky-50'}`}
                      >
                        Phase 3B — Early Wide Adoption <span className="opacity-60 ml-1">18 Dec 2023–17 Mar 2024</span>
                      </button>
                      <button
                        onClick={() => applyPhase('3c')}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${rangeActivePhase === '3c' ? 'border-orange-400 bg-orange-100 text-orange-800 font-semibold' : 'border-orange-300 text-orange-700 hover:bg-orange-50'}`}
                      >
                        Phase 3C — Pre-Litigation <span className="opacity-60 ml-1">17 Mar–16 May 2024</span>
                      </button>
                      <button
                        onClick={() => applyPhase('3d')}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${rangeActivePhase === '3d' ? 'border-rose-400 bg-rose-100 text-rose-800 font-semibold' : 'border-rose-300 text-rose-700 hover:bg-rose-50'}`}
                      >
                        Phase 3D — Warning &amp; Lawsuit <span className="opacity-60 ml-1">17 May 2024 onward</span>
                      </button>
                    </div>
                  )
                })()}

                {rangeMode === 'exact' && (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-3">
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">From</label>
                      <input type="date" value={rangeDateFrom} onChange={(e) => setRangeDateFrom(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">To</label>
                      <input type="date" value={rangeDateTo} onChange={(e) => setRangeDateTo(e.target.value)} className={inputCls} />
                    </div>
                  </div>
                )}
                {rangeMode === 'month' && (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-3">
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">From Month</label>
                      <input type="month" value={rangeDateFrom.slice(0, 7)} onChange={(e) => setRangeDateFrom(e.target.value + '-01')} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">To Month</label>
                      <input type="month" value={rangeDateTo.slice(0, 7)} onChange={(e) => setRangeDateTo(e.target.value + '-31')} className={inputCls} />
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 mb-4">
                  <div className="flex flex-col gap-1">
                    <label className="filter-label">Suno Team</label>
                    <select value={sunoTeam} onChange={(e) => setSunoTeam(e.target.value)} className={inputCls}>
                      <option value="all">All</option>
                      <option value="only">Only Suno Team</option>
                      <option value="exclude">Exclude Suno Team</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="filter-label">Min Words</label>
                    <input type="text" inputMode="numeric" value={String(minWords)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinWords(d ? parseInt(d) : 0) }} className={inputCls} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="filter-label">Limit</label>
                    <input type="text" inputMode="numeric" value={String(maxResults)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMaxResults(d ? parseInt(d) : 1000000) }} className={inputCls} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="filter-label">Sentiment</label>
                    <div className="inline-flex">
                      {(['all', 'positive', 'negative', 'neutral'] as const).map(s => (
                        <button key={s} onClick={() => setFilterSentiment(s)} className={`range-mode-btn${filterSentiment === s ? ' range-mode-active' : ''}`}>
                          {s === 'all' ? 'All' : s === 'positive' ? '😊 +' : s === 'negative' ? '😞 −' : '😐 ±'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="filter-label">Emotion</label>
                    <select value={filterEmotion} onChange={e => setFilterEmotion(e.target.value)} className={inputCls}>
                      <option value="">Any</option>
                      <optgroup label="Positive">
                        {['admiration','amusement','approval','caring','excitement','gratitude','joy','love','optimism','pride','relief'].map(e => (
                          <option key={e} value={e}>{e}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Negative">
                        {['anger','annoyance','disappointment','disapproval','disgust','embarrassment','fear','grief','nervousness','remorse','sadness'].map(e => (
                          <option key={e} value={e}>{e}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Ambiguous">
                        {['confusion','curiosity','desire','realization','surprise'].map(e => (
                          <option key={e} value={e}>{e}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Neutral">
                        <option value="neutral">neutral</option>
                      </optgroup>
                    </select>
                  </div>
                </div>
                <button onClick={doSearch} disabled={searching} className="search-btn">{searching ? 'Searching…' : 'Search'}</button>
                <p className="text-xs text-gray-500 mt-3">Returns all messages in the selected range. At least one date is required.</p>
              </>
            )}
            {activeTab === 'browse' && (
              <p className="text-xs text-gray-500">
                Showing all messages oldest-first, 50 at a time. Scroll down to load more.
              </p>
            )}
          </>
        )}
      </section>

      {/* Scroll anchor + loading animation */}
      <div ref={resultsAnchorRef} className="-mt-2" />
      {searching && <SearchingAnimation />}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* No results feedback */}
      {!searching && !error && didSearch && results.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-sm text-gray-500 text-center">
          {activeTab === 'range'
            ? 'No results found for the selected date range. The dataset may not have data for that period.'
            : lastKeyword
              ? <>No results for <span className="font-semibold text-gray-700">"{lastKeyword}"</span>. Try a different query, match type, or date range.</>
              : 'No results found. Try adjusting the username or date filter.'}
        </div>
      )}

      {/* Chat results */}
      {results.length > 0 && (
        <>
          {/* Analysis tab bar */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => toggleAnalysisTab('summarize')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border-2 transition-colors ${analysisTab === 'summarize' ? 'border-indigo-500 bg-indigo-50 text-indigo-800' : 'border-gray-200 bg-white text-gray-600 hover:border-indigo-300'}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Summarize &amp; Analyse
            </button>
            <button
              onClick={() => toggleAnalysisTab('viz')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border-2 transition-colors ${analysisTab === 'viz' ? 'border-purple-500 bg-purple-50 text-purple-800' : 'border-gray-200 bg-white text-gray-600 hover:border-purple-300'}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              Visualization
            </button>
            <button onClick={exportCSV} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border-2 border-gray-200 bg-white text-gray-600 hover:border-green-300 hover:text-green-700 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
            <span className="ml-auto text-xs text-gray-400">
              {`${Math.min(visibleCount, displayedResults.length).toLocaleString()} of ${results.length.toLocaleString()} results`}
            </span>
          </div>

          {/* Summarize & Analyse panel */}
          {analysisTab === 'summarize' && (
            <section className="bg-white rounded-2xl shadow p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-800">Summarize &amp; Analyse Results</h3>
                <span className="text-xs text-gray-500">{results.length.toLocaleString()} current results available for analysis.</span>
              </div>

              {/* Controls */}
              <div className="space-y-3 mb-4">
                <div className="flex flex-col gap-1">
                  <label className="filter-label">Custom instructions (optional)</label>
                  <textarea
                    value={summarizeQuery}
                    onChange={(e) => setSummarizeQuery(e.target.value)}
                    placeholder="Optional focus or instructions for the analysis…"
                    className={`${inputCls} min-h-[60px] resize-y`}
                    rows={2}
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                  <div className="flex flex-col gap-1">
                    <label className="filter-label">Retrieval mode</label>
                    <select value={srRetrievalMode} onChange={(e) => setSrRetrievalMode(e.target.value as 'cluster' | 'all')} className={inputCls}>
                      <option value="cluster">Cluster &amp; Sample (recommended)</option>
                      <option value="all">All messages (no clustering)</option>
                    </select>
                    <p className="text-xs text-gray-400 mt-0.5">{retrievalHint[srRetrievalMode]}</p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="filter-label">Model</label>
                    <select value={srModel} onChange={(e) => setSrModel(e.target.value)} className={inputCls}>
                      <optgroup label="GPT-5.4">
                        <option value="gpt-5.4">GPT-5.4 (default)</option>
                        <option value="gpt-5.4-pro">gpt-5.4-pro</option>
                        <option value="gpt-5.4-mini">gpt-5.4-mini</option>
                        <option value="gpt-5.4-nano">gpt-5.4-nano</option>
                      </optgroup>
                      <optgroup label="GPT-4.1">
                        <option value="gpt-4.1">GPT-4.1</option>
                      </optgroup>
                      <optgroup label="GPT-4o">
                        <option value="gpt-4o">GPT-4o</option>
                      </optgroup>
                      <optgroup label="o-series">
                        <option value="o4-mini">o4-mini</option>
                        <option value="o3">o3</option>
                        <option value="o3-mini">o3-mini</option>
                      </optgroup>
                    </select>
                  </div>
                </div>
              </div>

              <button
                onClick={handleSummarize}
                disabled={summarizeLoading}
                className="search-btn mb-4"
              >
                {summarizeLoading ? 'Generating…' : 'Summarize Results'}
              </button>

              {/* Pipeline log */}
              {(srLog.length > 0 || summarizeLoading) && (
                <div className="mb-4">
                  <button
                    onClick={() => setSrLogVisible((v) => !v)}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-1"
                  >
                    <svg className={`w-3 h-3 transition-transform${srLogVisible ? ' rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/>
                    </svg>
                    Pipeline log ({srLog.length} steps)
                  </button>
                  {srLogVisible && (
                    <div className="bg-gray-50 rounded-xl p-3 space-y-1 text-xs font-mono max-h-48 overflow-y-auto">
                      {srLog.map((entry, i) => (
                        <div key={i} className="log-entry flex gap-2 items-start">
                          <span className="log-icon shrink-0">{LOG_ICONS[entry.step] ?? '•'}</span>
                          <span className="log-label font-semibold text-gray-600 shrink-0 w-20">{entry.label}</span>
                          <span className="log-msg text-gray-500 flex-1">{entry.msg}</span>
                        </div>
                      ))}
                      {summarizeLoading && (
                        <div className="flex gap-2 items-center text-gray-400 animate-pulse">
                          <span>✨</span>
                          <span>Processing…</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Result area */}
              {showSrResultsPanel && (
                <div>
                  {summarizeResult && (
                    <div className="bg-gray-50 rounded-xl p-4 markdown-body mb-4" aria-live="polite">
                      <ReactMarkdown>{summarizeResult + (summarizeLoading ? ' ▋' : '')}</ReactMarkdown>
                    </div>
                  )}
                  {!summarizeLoading && summarizeResult && (
                    <button
                      onClick={handleExportPDF}
                      className="action-btn-primary mb-4"
                    >
                      Export PDF
                    </button>
                  )}

                  {/* Follow-up Q&A */}
                  {summarizeResult && !summarizeLoading && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Follow-up Q&amp;A</h4>
                        {summarizeFollowUp.length > 0 && (
                          <button
                            onClick={() => setSummarizeFollowUp([])}
                            className="text-xs text-gray-400 hover:text-red-500"
                          >
                            Clear Q&amp;A
                          </button>
                        )}
                      </div>
                      <div className="space-y-2 mb-2 max-h-60 overflow-y-auto">
                        {summarizeFollowUp.map((h, i) => (
                          <div key={i} className={h.role === 'user' ? 'flex justify-end' : ''}>
                            <div className={`rounded-xl px-3 py-2 text-sm ${h.role === 'user' ? 'bg-indigo-700 text-white max-w-xl' : 'bg-gray-50 border border-gray-200 text-gray-900 markdown-body'}`}>
                              {h.role === 'assistant' ? <ReactMarkdown>{h.content}</ReactMarkdown> : h.content}
                            </div>
                          </div>
                        ))}
                        {summarizeFollowUpLoading && <div className="text-xs text-gray-400 animate-pulse">Generating…</div>}
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={summarizeFollowUpInput}
                          onChange={(e) => setSummarizeFollowUpInput(e.target.value)}
                          onKeyDown={(e) => {
                            if ((e.key === 'Enter' && e.ctrlKey) || (e.key === 'Enter' && !e.shiftKey)) {
                              e.preventDefault()
                              handleSumFollowUp()
                            }
                          }}
                          placeholder="Ask a follow-up question… (Ctrl+Enter to submit)"
                          className={`${inputCls} flex-1`}
                        />
                        <button onClick={handleSumFollowUp} disabled={summarizeFollowUpLoading || !summarizeFollowUpInput.trim()} className="search-btn">Ask</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Visualization panel */}
          {analysisTab === 'viz' && (
            <section className="bg-white rounded-2xl shadow p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-sm text-gray-700 uppercase tracking-wide">Message Volume Over Time</h3>
                <div className="flex items-center gap-2">
                  <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
                    {(['month', 'week', 'day'] as TrendBucket[]).map((b) => (
                      <button
                        key={b}
                        onClick={() => { setTrendBucket(b); buildTrend(results, b) }}
                        className={`trend-bucket-btn${trendBucket === b ? ' trend-bucket-active' : ''}`}
                      >
                        {b.charAt(0).toUpperCase() + b.slice(1)}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => alert('Chart export requires Chart.js. PNG export not available with Recharts.')}
                    className="action-btn-primary text-xs"
                    title="Export chart as PNG"
                  >
                    PNG
                  </button>
                </div>
              </div>

              {/* Chart range banner */}
              {chartRange && (
                <div className="flex items-center gap-2 mb-3 bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2 text-sm text-indigo-800">
                  <span>
                    Showing {displayedResults.length} of {results.length} — {chartRange.label} ({chartRange.from} → {chartRange.to})
                  </span>
                  <button
                    onClick={() => {
                      setChartRange(null)
                      const tokens = computeFilterTokens(filterMode, filterText)
                      applyFilters(results, filterMode, filterText, null, tokens)
                    }}
                    className="ml-auto text-indigo-500 hover:text-indigo-800 font-bold"
                  >
                    ✕ Clear
                  </button>
                </div>
              )}

              {trendData.length > 0 ? (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart
                    data={trendData}
                    onClick={(data) => {
                      if (data?.activePayload?.[0]) {
                        const pt = data.activePayload[0].payload as TrendPoint
                        handleChartBarClick(pt)
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} tickFormatter={formatTrendPeriod} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                      {trendData.map((entry, i) => (
                        <Cell
                          key={i}
                          fill={chartRange?.from === entry.from ? '#4f46e5' : 'rgba(99,102,241,0.7)'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">No trend data available.</p>
              )}
            </section>
          )}

          {/* Results filter bar — sticky so it stays visible while scrolling through cards */}
          <div className="bg-white rounded-2xl shadow px-4 py-3 sticky top-0 z-20">
            <div className="flex flex-wrap items-center gap-2">
              {/* Mode buttons */}
              <div className="inline-flex rounded-lg overflow-hidden border border-gray-200 shrink-0">
                <button
                  onClick={() => setFilterMode('any')}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${filterMode === 'any' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Any Word
                </button>
                <button
                  onClick={() => setFilterMode('exact')}
                  className={`px-3 py-1.5 text-xs font-semibold border-l border-gray-200 transition-colors ${filterMode === 'exact' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Exact
                </button>
                <button
                  onClick={() => setFilterMode('fuzzy')}
                  className={`px-3 py-1.5 text-xs font-semibold border-l border-gray-200 transition-colors ${filterMode === 'fuzzy' ? 'bg-amber-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Fuzzy
                </button>
                <button
                  onClick={() => setFilterMode('semantic')}
                  className={`px-3 py-1.5 text-xs font-semibold border-l border-gray-200 transition-colors ${filterMode === 'semantic' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Semantic
                </button>
              </div>

              {/* Filter input */}
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
                </svg>
                <input
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder={filterPlaceholder[filterMode]}
                  className="search-input flex-1 min-w-0 text-xs py-1.5"
                />
                {filterLoading && (
                  <svg className="w-3.5 h-3.5 text-indigo-500 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {filterText && (
                  <button
                    onClick={() => {
                      setFilterText('')
                      setDisplayedResults(results)
                      setFilterCount(null)
                      setFilterTokens([])
                    }}
                    className="text-gray-400 hover:text-gray-700 shrink-0 font-bold text-sm"
                    title="Clear filter"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Count label */}
              {filterCount && (
                <span className="text-xs text-gray-500 shrink-0 tabular-nums">
                  {filterCount.shown} of {filterCount.total}
                </span>
              )}

              {/* Context window — how many messages "View context" shows before/after */}
              <div className="flex items-center gap-1 shrink-0" title="Messages shown before / after in 'View context'">
                <span className="text-xs text-gray-400">Context</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={String(ctxBefore)}
                  onChange={(e) => setCtxBefore(Math.max(0, Math.min(200, parseInt(e.target.value.replace(/\D/g, '')) || 0)))}
                  className="search-input text-xs py-1 w-14 text-center"
                  title="Messages before"
                />
                <span className="text-xs text-gray-300">/</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={String(ctxAfter)}
                  onChange={(e) => setCtxAfter(Math.max(0, Math.min(200, parseInt(e.target.value.replace(/\D/g, '')) || 0)))}
                  className="search-input text-xs py-1 w-14 text-center"
                  title="Messages after"
                />
              </div>
            </div>
          </div>

          {/* Bookmark error toast */}
          {bookmarkError && (
            <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-700 flex items-center justify-between">
              <span>Bookmark failed: {bookmarkError}</span>
              <button onClick={() => setBookmarkError(null)} className="text-red-400 hover:text-red-700 font-bold ml-3">✕</button>
            </div>
          )}

          {/* Message cards */}
          <div className="bg-white rounded-2xl shadow px-4 py-3" id="results-container">
            {displayedResults.slice(0, visibleCount).map((msg, idx, sliced) => {
              const prev = sliced[idx - 1]
              const isGrouped = idx > 0 && prev?.username === msg.username
              const prevDay = prev?.date?.slice(0, 10)
              const thisDay = msg.date?.slice(0, 10)
              const showDateSep = idx === 0 || thisDay !== prevDay
              return (
                <div key={msg.id}>
                  {showDateSep && (
                    <div className="flex items-center gap-3 my-3">
                      <div className="flex-1 border-t border-gray-100" />
                      <span className="text-xs text-gray-400 font-medium shrink-0">{thisDay}</span>
                      <div className="flex-1 border-t border-gray-100" />
                    </div>
                  )}
                  <MessageCard
                    msg={msg}
                    keyword={activeKeyword}
                    tokens={activeTokens}
                    isBookmarked={bookmarkedIds.has(msg.id)}
                    onBookmarkToggle={handleBookmarkToggle}
                    ctxBefore={ctxBefore}
                    ctxAfter={ctxAfter}
                    isGrouped={isGrouped && !showDateSep}
                    emotion={msg.msg_uuid ? msgEmotions[msg.msg_uuid] : undefined}
                    archetype={(() => {
                      const phaseKey = dateToPhaseKey(msg.date ?? '')
                      return phaseKey && phasePersonas[phaseKey]
                        ? phasePersonas[phaseKey][msg.username]
                        : undefined
                    })()}
                  />
                </div>
              )
            })}
            {displayedResults.length === 0 && filterText.trim() && (
              <div className="text-center py-8 text-gray-400 text-sm">No results match the current filter.</div>
            )}
            {/* Sentinel — IntersectionObserver target for infinite scroll */}
            <div ref={sentinelRef} />
            {visibleCount < displayedResults.length ? (
              <div className="py-4 text-center text-sm text-gray-400 animate-pulse">
                Loading more… ({Math.min(visibleCount, displayedResults.length).toLocaleString()} of {displayedResults.length.toLocaleString()})
              </div>
            ) : displayedResults.length > 50 && (
              <div className="py-3 text-center text-xs text-gray-400">
                All {displayedResults.length.toLocaleString()} results shown
              </div>
            )}
          </div>
        </>
      )}

      {/* Browse All results */}
      {activeTab === 'browse' && (
        <div className="bg-white rounded-2xl shadow" id="browse-container">
          {/* Sticky filter bar */}
          <div className="sticky top-0 z-20 bg-white border-b border-gray-100 px-4 py-3 shadow-sm rounded-t-2xl">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex flex-col gap-1">
                <label className="filter-label">Username</label>
                <input
                  value={browseUsernameFilter}
                  onChange={(e) => setBrowseUsernameFilter(e.target.value)}
                  placeholder="filter…"
                  className="search-input text-xs py-1 w-44"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="filter-label">Keyword</label>
                <input
                  value={browseKeywordFilter}
                  onChange={(e) => setBrowseKeywordFilter(e.target.value)}
                  placeholder="filter…"
                  className="search-input text-xs py-1 w-56"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="filter-label">From</label>
                <input
                  type="date"
                  value={browseDateFrom}
                  onChange={(e) => setBrowseDateFrom(e.target.value)}
                  className="search-input text-xs py-1"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="filter-label">To</label>
                <input
                  type="date"
                  value={browseDateTo}
                  onChange={(e) => setBrowseDateTo(e.target.value)}
                  className="search-input text-xs py-1"
                />
              </div>
              {(browseUsernameFilter || browseKeywordFilter || browseDateFrom || browseDateTo) && (
                <button
                  onClick={() => { setBrowseUsernameFilter(''); setBrowseKeywordFilter(''); setBrowseDateFrom(''); setBrowseDateTo('') }}
                  className="self-end pb-1 text-xs text-gray-400 hover:text-red-500 transition-colors flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  Clear
                </button>
              )}
              <div className="self-end pb-1 ml-auto flex items-center gap-3">
                <button
                  onClick={handleBrowseDownloadCsv}
                  disabled={browseExporting}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  title="Download all messages as CSV (ignores pagination)"
                >
                  {browseExporting ? (
                    <svg className="w-3.5 h-3.5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  )}
                  {browseExporting ? 'Exporting…' : 'Download CSV'}
                </button>
                <span className="text-xs text-gray-400">
                  {filteredBrowseMessages.length !== browseMessages.length
                    ? `${filteredBrowseMessages.length.toLocaleString()} / ${browseMessages.length.toLocaleString()} loaded`
                    : `${browseMessages.length.toLocaleString()} loaded`}
                </span>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="px-4 py-3">
            {filteredBrowseMessages.map((msg, idx) => {
              const prev = filteredBrowseMessages[idx - 1]
              const isGrouped = idx > 0 && prev.username === msg.username
              const prevDay = prev?.date?.slice(0, 10)
              const thisDay = msg.date?.slice(0, 10)
              const showDateSep = idx === 0 || thisDay !== prevDay
              return (
                <div key={msg.id}>
                  {showDateSep && (
                    <div className="flex items-center gap-3 my-3">
                      <div className="flex-1 border-t border-gray-100" />
                      <span className="text-xs text-gray-400 font-medium shrink-0">{thisDay}</span>
                      <div className="flex-1 border-t border-gray-100" />
                    </div>
                  )}
                  <BrowseChatRow
                    msg={msg}
                    isGrouped={isGrouped && !showDateSep}
                    isBookmarked={bookmarkedIds.has(msg.id)}
                    onBookmarkToggle={handleBookmarkToggle}
                    tokens={browseTokens}
                  />
                </div>
              )
            })}
            <div ref={browseSentinelRef} />
            {browseFetching && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-indigo-500">
                <svg className="w-4 h-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Loading more messages…
              </div>
            )}
            {!browseHasMore && browseMessages.length > 0 && (
              <div className="py-3 text-center text-xs text-gray-400">
                All {browseMessages.length.toLocaleString()} messages loaded
              </div>
            )}
            {browseMessages.length === 0 && !browseFetching && (
              <div className="text-center py-8 text-gray-400 text-sm">No messages found.</div>
            )}
            {filteredBrowseMessages.length === 0 && browseMessages.length > 0 && (
              <div className="text-center py-8 text-gray-400 text-sm">No messages match the current filters.</div>
            )}
          </div>
        </div>
      )}

    </div>
  )
}
