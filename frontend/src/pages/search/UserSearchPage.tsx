import { useState, useCallback, useEffect, useRef, useMemo, Fragment } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import ReactMarkdown from 'react-markdown'
import { apiFetch, streamEvents } from '../../api/client'
import { useSearchStore } from '../../store/searchStore'
import { useAuthStore } from '../../store/authStore'
import { usePhaseStore } from '../../store/phaseStore'
import { getUserStyle, getUserColor } from '../../utils/colors'
import type { Message, Upload, UserInRange, Stats, UserTopicsResult, TopicPipelineStep, EmotionResult } from '../../types'
import {
  makeEmotionKey, checkEmotionCompleted, markEmotionCompleted,
  getEmotionMessages, saveEmotionMessages, buildEmotionResult,
} from '../../lib/analysisCache'
import type {
  SearchTab, MatchType, UsersDataTab, FilterMode,
  TrendPoint, EngagementLevel, EngagementInfo, CrossPhaseTransition, MsgEmotion,
} from './types'
import { ENGAGEMENT_COLORS, TOPIC_COLORS, emotionSentimentColor } from './types'
import {
  applyExactFilter, applyAnyFilter, applyFuzzyFilter,
  classifyEngagement, classifyEngagementSingle, daysBetween, deriveThresholds,
  deriveUserInRange, downloadChartAsPNG, downloadTableAsCSV, fetchStoredEmotionFromDB,
  fetchMsgEmotionsBatched, getMondayKey, heatmapColor, mergeEmotionResults, mondayKey, ssGet, ssSet,
} from './utils'
import MessageCard from './MessageCard'
import TopicMsgRow from './TopicMsgRow'

export default function UserSearchPage() {
  const PHASE_DEFS = usePhaseStore(s => s.defs)
  const { results, setResults, bookmarkedIds, setBookmarkedIds, toggleBookmarked } = useSearchStore()
  const { setShowKeyModal } = useAuthStore()
  const { username: routeUsername } = useParams<{ username?: string }>()
  const navigate = useNavigate()

  // Search state
  const [activeTab] = useState<SearchTab>(() => (localStorage.getItem('search_tab') as SearchTab) || 'keyword')
  const [matchType] = useState<MatchType>(() => ssGet('sr_match_type', 'any'))
  const [query] = useState(() => ssGet('sr_query', ''))
  const [filterUsername] = useState(() => ssGet('sr_filter_username', ''))
  const [dateFrom, setDateFrom] = useState(() => ssGet('sr_date_from', ''))
  const [dateTo, setDateTo] = useState(() => ssGet('sr_date_to', ''))
  const [rangeDateFrom] = useState(() => ssGet('sr_range_date_from', ''))
  const [rangeDateTo] = useState(() => ssGet('sr_range_date_to', ''))
  const [sunoTeam, setSunoTeam] = useState('all')
  const [maxResults] = useState(1000000)
  const [minWords, setMinWords] = useState(0)
  const [minMessages, setMinMessages] = useState(0)
  const [searching, setSearching] = useState(false)
  const [, setError] = useState<string | null>(null)
  const [, setBookmarkError] = useState<string | null>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [selectedUploads, setSelectedUploads] = useState<Set<string>>(new Set())
  const [userStats, setUserStats] = useState<UserInRange[]>(() => ssGet<UserInRange[]>('sr_user_stats', []))
  const [usersDataTab, setUsersDataTab] = useState<UsersDataTab>('search')
  const [selectedPhases, setSelectedPhases] = useState<Set<string>>(new Set())
  const [phaseData, setPhaseData] = useState<Record<string, UserInRange[]>>({})
  const [phaseLoadingSet, setPhaseLoadingSet] = useState<Set<string>>(new Set())
  // phaseKey → { username → primaryPersona } — fetched from DB per phase
  const [phasePersonas, setPhasePersonas] = useState<Record<string, Record<string, string>>>({})
  const [phaseSecondaryPersonas, setPhaseSecondaryPersonas] = useState<Record<string, Record<string, string>>>({})
  const [expandedPhaseSections, setExpandedPhaseSections] = useState<Set<string>>(new Set(['cross-active', 'username-trend', 'archetype-trend', 'sentiment-trend', 'archetype-engagement']))
  const [phaseUsernameSearch, setPhaseUsernameSearch] = useState('')
  const [phaseChartStatuses, setPhaseChartStatuses] = useState<Set<string>>(new Set(['High', 'Medium', 'Low']))
  const [userSortCol, setUserSortCol] = useState<'username' | 'total_messages' | 'first_date' | 'last_date' | 'avg_words' | 'weeks_active' | 'pct_weeks'>('total_messages')
  const [userSortDir, setUserSortDir] = useState<'asc' | 'desc'>('desc')
  const [userNameFilter, setUserNameFilter] = useState('')
  const [refineFirstMsgIn, setRefineFirstMsgIn] = useState('')
  const [refineLastMsgFrom, setRefineLastMsgFrom] = useState('')
  const [refineMinMessages, setRefineMinMessages] = useState('')
  const [refineMaxMessages, setRefineMaxMessages] = useState('')
  const [refineMinWeeks, setRefineMinWeeks] = useState('')
  const [refineAvgWordsMin, setRefineAvgWordsMin] = useState('')
  const [refineAvgWordsMax, setRefineAvgWordsMax] = useState('')
  const [trendData] = useState<TrendPoint[]>(() => ssGet<TrendPoint[]>('sr_trend_data', []))
  const [lastKeyword] = useState(() => ssGet('sr_last_keyword', ''))
  const [lastTokens] = useState<string[]>(() => ssGet<string[]>('sr_last_tokens', []))
  const [showSearchPanel, setShowSearchPanel] = useState(true)



  // Results filter bar state
  const [filterMode] = useState<FilterMode>('any')
  const [filterText] = useState('')
  const [displayedResults, setDisplayedResults] = useState<Message[]>([])

  // Chart range filter
  const [chartRange] = useState<{ from: string; to: string; label: string } | null>(null)

  // User detail panel state
  const [selectedUser, setSelectedUser] = useState<UserInRange | null>(null)
  const [userMsgs, setUserMsgs] = useState<Message[]>([])
  const [userMsgsLoading, setUserMsgsLoading] = useState(false)
  const [userDetailDateFrom, setUserDetailDateFrom] = useState('')
  const [userDetailDateTo, setUserDetailDateTo] = useState('')
  const [userDetailContains, setUserDetailContains] = useState('')
  const [userDetailMinWords, setUserDetailMinWords] = useState(0)
  const [userDetailCtxBefore, setUserDetailCtxBefore] = useState(5)
  const [userDetailCtxAfter, setUserDetailCtxAfter] = useState(5)
  const [userSumModel, setUserSumModel] = useState('gpt-5.4')
  const [userSumRetrievalMode, setUserSumRetrievalMode] = useState<'cluster' | 'all'>('cluster')
  const [userSumInstructions, setUserSumInstructions] = useState('')
  const [userSumResult, setUserSumResult] = useState('')
  const [userSumLoading, setUserSumLoading] = useState(false)
  const [userSumFollowUp, setUserSumFollowUp] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [userSumFollowUpInput, setUserSumFollowUpInput] = useState('')
  const [userSumFollowUpLoading, setUserSumFollowUpLoading] = useState(false)
  const [userDetailPage, setUserDetailPage] = useState(0)
  const msgContainerRef = useRef<HTMLDivElement>(null)
  const userSumStopRef = useRef<(() => void) | null>(null)

  // BERTopic analysis state
  const [userTopicsResult, setUserTopicsResult] = useState<UserTopicsResult | null>(null)
  const [userTopicsLoading, setUserTopicsLoading] = useState(false)
  const [topicsDbLoading, setTopicsDbLoading] = useState(false)  // true while fetching saved result from DB
  const [expandedTopicSamples, setExpandedTopicSamples] = useState<Set<number>>(new Set())
  // Topic label editing in user-detail panel
  const [editingTopicId, setEditingTopicId] = useState<number | null>(null)
  const [editingLabelValue, setEditingLabelValue] = useState('')
  const [relabelingTopicId, setRelabelingTopicId] = useState<number | null>(null)
  const [userTopicsSteps, setUserTopicsSteps] = useState<TopicPipelineStep[]>([])
  const [topicModalId, setTopicModalId] = useState<number | null>(null)
  // Stats-table topic message modal (separate from the user-detail panel modal)
  const [statsTopicModal, setStatsTopicModal] = useState<{
    topicId: number; label: string; keywords: string[]; username: string; messageCount: number
  } | null>(null)
  const [statsTopicMessages, setStatsTopicMessages] = useState<Message[]>([])
  const [statsTopicLoading, setStatsTopicLoading] = useState(false)
  const [userAnalysisTab, setUserAnalysisTab] = useState<'topics' | 'emotion' | 'timeline' | 'dropout' | 'summary' | 'strategy' | 'persona'>('dropout')
  const [dropoutSubTab, setDropoutSubTab] = useState<'current' | 'phases' | 'cross'>('cross')
  const [crossPhaseNarrative, setCrossPhaseNarrative] = useState<string | null>(null)
  const [narrativeLoading, setNarrativeLoading] = useState(false)
  const [msgEmotions, setMsgEmotions] = useState<Record<string, MsgEmotion>>({})
  const requestedMsgEmotionUuidsRef = useRef(new Set<string>())

  // Persona / archetype classification state
  // Single-method ("archetype"); each user/phase has one primary + optional secondary.
  type PersonaResult = {
    persona: string
    confidence: number
    secondary_persona?: string | null
    secondary_confidence?: number | null
    reasoning: string
    created_at?: string
  }
  type UserPersonas = Record<string, PersonaResult>  // keyed by phase key, for one selected user
  const [userPersonas, setUserPersonas] = useState<UserPersonas>({})
  const [personaClassifying, setPersonaClassifying] = useState<Set<string>>(new Set())
  const [personaSummary, setPersonaSummary] = useState<
    { phase: string; phase_label: string; method: string; persona: string; count: number }[]
  >([])
  const [personaSummaryLoading, setPersonaSummaryLoading] = useState(false)
  const [phaseSentiment, setPhaseSentiment] = useState<
    { phase: string; positive: number; negative: number; neutral: number; total: number }[]
  >([])
  const [batchPersonaClassifying, setBatchPersonaClassifying] = useState(false)
  const [batchPersonaProgress, setBatchPersonaProgress] = useState<{ done: number; total: number; errors: number } | null>(null)
  const [reanalyzingPhases, setReanalyzingPhases] = useState<Set<string>>(new Set())
  const [batchTopicRunning, setBatchTopicRunning] = useState(false)
  const [batchTopicProgress, setBatchTopicProgress] = useState<{ done: number; total: number; errors: number } | null>(null)
  const [batchTopicCurrentUser, setBatchTopicCurrentUser] = useState<string | null>(null)
  const [showOnlyFailedTopics, setShowOnlyFailedTopics] = useState(false)
  const [showOnlyAnomalyTopics, setShowOnlyAnomalyTopics] = useState(false)
  const [relabelingInTable, setRelabelingInTable] = useState<Record<string, Set<number>>>({})
  const [relabelAllProgress, setRelabelAllProgress] = useState<{ done: number; total: number; errors: number } | null>(null)
  // Keyed by username (one entry per user for the current phase).
  const [tablePersonas, setTablePersonas] = useState<Record<string, PersonaResult>>({})
  type EmotionEntry = { label: string; score: number }
  type SentBucket = { count: number; top_emotions: EmotionEntry[] }
  type TableSentiment = {
    positive: number; negative: number; neutral: number; analyzed: number;
    top_emotions: EmotionEntry[];
    by_sentiment: { positive: SentBucket; negative: SentBucket; neutral: SentBucket };
  }
  const [tableSentiments, setTableSentiments] = useState<Record<string, TableSentiment>>({})
  const [batchSentimentRunning, setBatchSentimentRunning] = useState(false)
  const [sentimentDetailUser, setSentimentDetailUser] = useState<string | null>(null)
  const [sentimentProgress, setSentimentProgress] = useState<{ msgs: number; totalMsgs: number; users: number; totalUsers: number } | null>(null)
  const [tableTopics, setTableTopics] = useState<Record<string, UserTopicsResult>>({})
  const [topicDetailUser, setTopicDetailUser] = useState<string | null>(null)
  type FlowModalUser = { username: string; total_messages: number; weeks_active: number | null; pct_weeks: number | null; avg_words: number | null; status: EngagementLevel | 'no-data' | null }
  const [flowModal, setFlowModal] = useState<{ title: string; users: FlowModalUser[]; totalWeeks?: number } | null>(null)
  const [flowModalSortCol, setFlowModalSortCol] = useState<'username' | 'total_messages' | 'weeks_active' | 'pct_weeks' | 'avg_words'>('total_messages')
  const [flowModalSortDir, setFlowModalSortDir] = useState<'asc' | 'desc'>('desc')

  const topicsStopRef = useRef<(() => void) | null>(null)

  // Emotion analysis state
  const [userEmotionResult, setUserEmotionResult] = useState<EmotionResult | null>(null)
  const [userEmotionLoading, setUserEmotionLoading] = useState(false)
  const [emotionMsgFilter, setEmotionMsgFilter] = useState<{
    type: 'emotion' | 'sentiment'
    label: string        // emotion name (e.g. "joy") or sentiment ("positive"|"negative"|"neutral")
    period?: string      // YYYY-MM, only for sentiment type
  } | null>(null)

  // Strategy extraction state
  const [strategyDefs, setStrategyDefs] = useState('')
  const [strategyResult, setStrategyResult] = useState<{
    strategies: { id: string; name: string; description: string; count: number; messages: { msg_uuid: string; content: string; date: string; username: string }[] }[]
    total_messages: number
    total_classified: number
  } | null>(null)
  const [strategyLoading, setStrategyLoading] = useState(false)
  const [strategyError, setStrategyError] = useState<string | null>(null)
  const [expandedStrategyIds, setExpandedStrategyIds] = useState<Set<string>>(new Set())

  // Dropout analysis parameters
  const [dropoutStatusFilter, setDropoutStatusFilter] = useState<'all' | EngagementLevel | 'decreased' | 'dropout'>('all')
  const [archetypeFilter, setArchetypeFilter] = useState<string>('all')
  const [secondaryArchetypeFilter, setSecondaryArchetypeFilter] = useState<string>('all')

  // Timeline interactivity
  const [selectedTopicIds, setSelectedTopicIds] = useState<Set<number> | null>(null)
  const [heatmapCell, setHeatmapCell] = useState<{ topicId: number; period: string } | null>(null)

  // Analysis result cache — persists across user navigation, keyed by username|dateFrom|dateTo
  const topicsCacheRef = useRef<Map<string, { result: UserTopicsResult; uuids: Set<string> }>>(new Map())
  const emotionCacheRef = useRef<Map<string, { result: EmotionResult; uuids: Set<string> }>>(new Map())
  const openedWithKeyRef = useRef<string | null>(null)
  const makeAnalysisKey = (username: string, from: string, to: string) => `${username}|${from}|${to}`
  const routeLoadedRef = useRef<string | null>(null)
  const sentimentReqIdRef = useRef(0)
  const chartCountsRef    = useRef<HTMLDivElement>(null)
  const chartTrendsRef    = useRef<HTMLDivElement>(null)
  const chartStackedRef   = useRef<HTMLDivElement>(null)
  const chartUserTrendRef = useRef<HTMLDivElement>(null)
  const chartArchetypeRef  = useRef<HTMLDivElement>(null)
  const chartSentimentRef  = useRef<HTMLDivElement>(null)

  // Semantic filter debounce ref
  const semanticFilterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Infinite scroll — chat results
  const [visibleCount, setVisibleCount] = useState(50)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Infinite scroll — users table
  const [visibleUserCount, setVisibleUserCount] = useState(50)
  // Callback ref: the observer is created when the sentinel mounts and destroyed when it
  // unmounts. Using useState (not useRef) so the effect re-runs on mount/unmount.
  const [userTableSentinelEl, setUserTableSentinelEl] = useState<HTMLDivElement | null>(null)
  const userTableScrollRef = useRef<HTMLDivElement>(null)

  // Browse All tab — server-side pagination
  const [browseMessages, setBrowseMessages] = useState<Message[]>([])
  const resultsAnchorRef = useRef<HTMLDivElement>(null)
  const browseOffsetRef = useRef(0)
  const browseHasMoreRef = useRef(true)
  const browseIsFetchingRef = useRef(false)
  const browseSentinelRef = useRef<HTMLDivElement>(null)
  const [browseDateFrom] = useState('')
  const [browseDateTo] = useState('')
  const browseDateFromRef = useRef('')
  const browseDateToRef = useRef('')
  const browseScopeRef = useRef('')

  const { data: _uploads } = useQuery<Upload[]>({ queryKey: ['uploads'], queryFn: () => apiFetch('/uploads') })
  const { data: _bookmarkIds } = useQuery<number[]>({ queryKey: ['bookmark-ids'], queryFn: () => apiFetch('/bookmarks/ids') })
  const { data: _stats } = useQuery<Stats>({ queryKey: ['stats'], queryFn: () => apiFetch('/stats') })
  useEffect(() => { if (_uploads) setUploads(_uploads) }, [_uploads])
  useEffect(() => { if (_bookmarkIds) setBookmarkedIds(_bookmarkIds) }, [_bookmarkIds])

  // Restore results to Zustand store on mount if store is empty (page refresh) but sessionStorage has data
  useEffect(() => {
    if (results.length === 0) {
      const saved = ssGet<Message[]>('sr_results', [])
      if (saved.length > 0) setResults(saved)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch stored emotions only for currently rendered rows. Large searches can
  // contain tens of thousands of messages, so avoid one giant metadata request.
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

  // Fetch stored emotions for user detail messages and merge into msgEmotions
  useEffect(() => {
    const uuids = userMsgs
      .map(m => m.msg_uuid)
      .filter((u): u is string => !!u && !requestedMsgEmotionUuidsRef.current.has(u))
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
  }, [userMsgs])

  // Sync key state to sessionStorage so it survives navigation and page refresh
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
  useEffect(() => { ssSet('sr_user_stats', userStats) }, [userStats])

  // Reset to first page whenever the filtered result set changes (new search or filter applied)
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
  // Re-attach whenever displayedResults changes so the cap logic in render stays correct
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedResults.length])

  // Reset users table page when search result or any filter changes
  useEffect(() => {
    setVisibleUserCount(50)
  }, [userStats, dropoutStatusFilter, archetypeFilter, secondaryArchetypeFilter, userNameFilter, refineMinMessages, refineMaxMessages, refineMinWeeks,
      refineFirstMsgIn, refineLastMsgFrom, refineAvgWordsMin, refineAvgWordsMax,
      userSortCol, userSortDir])

  // IntersectionObserver: load next 50 users when sentinel scrolls into view.
  // Depends on the sentinel element (state-based callback ref), not visibleUserCount.
  // This prevents the cascade where recreating the observer on every count increment
  // causes it to fire immediately because the sentinel is still visible.
  useEffect(() => {
    const el = userTableSentinelEl
    const root = userTableScrollRef.current
    if (!el || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setVisibleUserCount((prev) => prev + 50)
      },
      { root, rootMargin: '100px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [userTableSentinelEl])

  const scopeParam = selectedUploads.size > 0 ? [...selectedUploads].join(',') : ''

  const buildParams = useCallback(() => {
    const p = new URLSearchParams()
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo) p.set('date_to', dateTo)
    if (sunoTeam === 'only') p.set('is_suno_team', 'only')
    else if (sunoTeam === 'exclude') p.set('is_suno_team', 'exclude')
    if (minWords > 0) p.set('min_words', String(minWords))
    if (minMessages > 0) p.set('min_messages', String(minMessages))
    p.set('limit', String(maxResults))
    if (scopeParam) p.set('upload_ids', scopeParam)
    return p
  }, [dateFrom, dateTo, sunoTeam, minWords, minMessages, maxResults, scopeParam])

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


  const fetchBrowsePage = useCallback(async () => {
    if (browseIsFetchingRef.current || !browseHasMoreRef.current) return
    browseIsFetchingRef.current = true
    const offset = browseOffsetRef.current
    try {
      const p = new URLSearchParams({ limit: '50', offset: String(offset) })
      if (browseDateFromRef.current) p.set('date_from', browseDateFromRef.current)
      if (browseDateToRef.current) p.set('date_to', browseDateToRef.current)
      if (browseScopeRef.current) p.set('upload_ids', browseScopeRef.current)
      const data = await apiFetch<Message[]>(`/search/range?${p}`)
      setBrowseMessages((prev) => (offset === 0 ? data : [...prev, ...data]))
      browseOffsetRef.current = offset + data.length
      if (data.length < 50) { browseHasMoreRef.current = false }
    } catch {
      // silent
    } finally {
      browseIsFetchingRef.current = false
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
    fetchBrowsePage()
  // fetchBrowsePage is stable; we intentionally skip it from deps to avoid double-fire on tab switch
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





  // Apply text filter + optional chart range filter on top of full results
  const applyFilters = useCallback((
    allResults: Message[],
    mode: FilterMode,
    text: string,
    range: { from: string; to: string; label: string } | null,
  ) => {
    let filtered = allResults

    // Apply chart range first
    if (range) {
      filtered = filtered.filter((m) => {
        const d = m.date?.slice(0, 10) ?? ''
        return d >= range.from && d <= range.to
      })
    }

    // Apply text filter
    if (text.trim()) {
      if (mode === 'exact') {
        filtered = applyExactFilter(filtered, text)
      } else if (mode === 'any') {
        filtered = applyAnyFilter(filtered, text)
      } else if (mode === 'fuzzy') {
        filtered = applyFuzzyFilter(filtered, text)
      }
      // semantic is handled separately (async)
    }

    setDisplayedResults(filtered)
  }, [])

  const runSemanticFilter = useCallback(async (text: string, allResults: Message[]) => {
    if (!text.trim()) {
      setDisplayedResults(allResults)
      return
    }
    if (!localStorage.getItem('openai_api_key')) { setShowKeyModal(true); return }
    try {
      const data = await apiFetch<Message[]>('/filter/semantic', {
        method: 'POST',
        body: JSON.stringify({ query: text, messages: allResults }),
      })
      setDisplayedResults(data)
    } catch {
      setDisplayedResults(allResults)
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
      applyFilters(results, filterMode, filterText, chartRange)
    }
  }, [filterText, filterMode, results, chartRange, applyFilters, runSemanticFilter])



  // When rendered at /discord/search/users/:username, auto-load that user's detail panel
  useEffect(() => {
    if (!routeUsername || routeLoadedRef.current === routeUsername) return
    routeLoadedRef.current = routeUsername
    ;(async () => {
      setUserMsgsLoading(true)
      setUserMsgs([])
      setUserDetailDateFrom('')
      setUserDetailDateTo('')
      setUserDetailContains('')
      setUserDetailMinWords(0)
      setUserDetailPage(0)
      setUserSumResult('')
      setUserSumFollowUp([])
      setUserTopicsResult(null)
      setUserTopicsSteps([])
      setUserEmotionResult(null)
      setStrategyResult(null)
      setStrategyError(null)
      setExpandedStrategyIds(new Set())
      try {
        const data = await apiFetch<Message[]>(
          `/search/user-messages?username=${encodeURIComponent(routeUsername)}&limit=1000000`
        )
        const u = deriveUserInRange(routeUsername, data)
        openedWithKeyRef.current = makeAnalysisKey(routeUsername, '', '')
        setSelectedUser(u)
        setUserStats(prev => {
          // Add/update this user in the stats list so dropoutMap can compute their status
          const without = prev.filter(x => x.username !== routeUsername)
          return [u, ...without]
        })
        setUserMsgs(data)
      } finally {
        setUserMsgsLoading(false)
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeUsername])

  const doUserSearch = async (datesOverride?: { from: string; to: string }) => {
    setUserStats([])
    setSentimentDetailUser(null)
    setTopicDetailUser(null)
    setSearching(true)
    setTimeout(() => resultsAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30)
    setError(null)
    try {
      const params = buildParams()
      // Override dates when called directly from phase buttons (state hasn't re-rendered yet)
      if (datesOverride) {
        if (datesOverride.from) params.set('date_from', datesOverride.from)
        else params.delete('date_from')
        if (datesOverride.to) params.set('date_to', datesOverride.to)
        else params.delete('date_to')
      }
      const data = await apiFetch<UserInRange[]>(`/search/users-in-range?${params}`)
      const users = data.filter(u => u.username !== 'Deleted User')
      setUserStats(users)
      if (users.length > 0) {
        const sentBody: Record<string, unknown> = { usernames: users.map(u => u.username) }
        const df = params.get('date_from') ?? ''
        const dt = params.get('date_to') ?? ''
        if (df) sentBody.date_from = df
        if (dt) sentBody.date_to = dt
        if (scopeParam) sentBody.upload_ids = scopeParam
        const reqId = ++sentimentReqIdRef.current
        apiFetch<{ results: (TableSentiment & { username: string })[] }>(
          '/search/stored-sentiment',
          { method: 'POST', body: JSON.stringify(sentBody) }
        ).then(sentData => {
          if (sentimentReqIdRef.current !== reqId) return  // stale response, discard
          const fresh: Record<string, TableSentiment> = {}
          for (const { username, ...rest } of sentData.results) {
            if ((rest as TableSentiment).analyzed > 0) fresh[username] = rest as TableSentiment
          }
          setTableSentiments(prev => ({ ...prev, ...fresh }))
        }).catch(() => {})
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearching(false)
      setTimeout(() => resultsAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
    }
  }

  const fetchPhaseSummary = (phases: Set<string>, opts?: { minWords?: number; minMessages?: number }) => {
    const toFetch = [...phases].filter((k) => !(k in phaseData))
    if (toFetch.length === 0) return
    setPhaseLoadingSet((prev) => new Set([...prev, ...toFetch]))
    toFetch.forEach(async (key) => {
      try {
        const def = PHASE_DEFS.find((p) => p.key === key)
        if (!def) return
        const p = new URLSearchParams()
        if (def.from) p.set('date_from', def.from)
        if (def.to) p.set('date_to', def.to)
        p.set('is_suno_team', 'exclude')
        if ((opts?.minWords ?? 0) > 0) p.set('min_words', String(opts!.minWords))
        if ((opts?.minMessages ?? 0) > 0) p.set('min_messages', String(opts!.minMessages))
        const data = await apiFetch<UserInRange[]>(`/search/users-in-range?${p}`)
        setPhaseData((prev) => ({ ...prev, [key]: data.filter((u) => u.username !== 'Deleted User') }))
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to load phase ${key}`)
      } finally {
        setPhaseLoadingSet((prev) => { const next = new Set(prev); next.delete(key); return next })
      }
    })
  }

  const handleBookmarkToggle = async (msg: Message) => {
    const wasBookmarked = bookmarkedIds.has(msg.id)
    // Optimistic update — flip the UI immediately so the button responds at once.
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
      // Revert the optimistic update and surface the error.
      toggleBookmarked(msg.id)
      const msg2 = err instanceof Error ? err.message : 'Bookmark action failed'
      setBookmarkError(msg2)
      setTimeout(() => setBookmarkError(null), 5000)
    }
  }







  // Filter end date: explicit dateTo or max last_date in dataset
  const filterEndDate = useMemo(() => {
    if (dateTo) return dateTo
    return userStats.reduce((max, u) =>
      (u.last_date && u.last_date > max ? u.last_date.slice(0, 10) : max), '')
  }, [dateTo, userStats])

  // Filter start date: explicit dateFrom or min first_date in dataset
  const filterStartDate = useMemo(() => {
    if (dateFrom) return dateFrom
    return userStats.reduce((mn, u) =>
      (u.first_date && (!mn || u.first_date < mn) ? u.first_date.slice(0, 10) : mn), '')
  }, [dateFrom, userStats])

  // Analysis window in days — drives adaptive dropout thresholds
  const windowDays = useMemo(() => {
    if (!filterStartDate || !filterEndDate) return 90
    return Math.max(14, daysBetween(filterStartDate, filterEndDate))
  }, [filterStartDate, filterEndDate])

  // Engagement status map for all users
  const dropoutMap = useMemo(() => {
    if (!filterEndDate || userStats.length === 0) return new Map<string, EngagementInfo>()
    const map = new Map<string, EngagementInfo>()
    for (const u of userStats) {
      map.set(u.username, classifyEngagement(u, filterStartDate, filterEndDate))
    }
    return map
  }, [userStats, filterStartDate, filterEndDate])

  // Matched against the RAW dateFrom/dateTo (not the resolved filterStartDate/
  // filterEndDate, which fall back to the actual last message date and drift
  // as new data is ingested). Topic runs are cached by the raw window too
  // (see runBatchTopicForUsers), so archetype lookups/saves must key off the
  // same raw strings or an open-ended phase (dateTo === '') never matches.
  const currentBatchPhaseKey = useMemo(() => {
    const matched = PHASE_DEFS.find(def => def.from === dateFrom && def.to === dateTo)
    return matched ? matched.key : `custom|${dateFrom || 'start'}|${dateTo || 'end'}`
  }, [PHASE_DEFS, dateFrom, dateTo])

  // Cross-phase transition map: for users relative to the previous phase
  const crossPhaseMap = useMemo(() => {
    const result = new Map<string, CrossPhaseTransition>()
    const currentIdx = PHASE_DEFS.findIndex(d => d.key === currentBatchPhaseKey)
    if (currentIdx <= 0) return result
    const prevDef = PHASE_DEFS[currentIdx - 1]
    const prevData = phaseData[prevDef.key]
    if (!prevData?.length) return result
    const prevEnd = prevDef.to || prevData.reduce((mx, u) =>
      (u.last_date && u.last_date > mx ? u.last_date : mx), '').slice(0, 10)
    const prevLevelMap = new Map<string, EngagementLevel>()
    for (const u of prevData) {
      prevLevelMap.set(u.username, classifyEngagement(u, prevDef.from, prevEnd).level)
    }
    const currentUsernames = new Set(userStats.map(u => u.username))
    for (const u of userStats) {
      const prevLevel = prevLevelMap.get(u.username)
      if (!prevLevel) continue
      const currLevel = dropoutMap.get(u.username)?.level ?? 'low'
      if (prevLevel === 'high' && currLevel === 'medium') result.set(u.username, 'dec-hm')
      else if (prevLevel === 'high' && currLevel === 'low') result.set(u.username, 'dec-hl')
      else if (prevLevel === 'medium' && currLevel === 'low') result.set(u.username, 'dec-ml')
    }
    for (const [username, prevLevel] of prevLevelMap) {
      if (!currentUsernames.has(username)) {
        result.set(username, prevLevel === 'high' ? 'dropout-high' : prevLevel === 'medium' ? 'dropout-med' : 'dropout-low')
      }
    }
    return result
  }, [PHASE_DEFS, currentBatchPhaseKey, phaseData, userStats, dropoutMap])


  useEffect(() => {
    apiFetch<{
      username: string; method: string;
      persona: string; confidence: number;
      secondary_persona?: string | null; secondary_confidence?: number | null;
      reasoning: string; created_at?: string;
    }[]>(
      `/persona/by-phase?phase=${encodeURIComponent(currentBatchPhaseKey)}&method=archetype`
    )
      .then(rows => {
        const map: Record<string, PersonaResult> = {}
        for (const r of rows) {
          map[r.username] = {
            persona: r.persona,
            confidence: r.confidence,
            secondary_persona: r.secondary_persona ?? null,
            secondary_confidence: r.secondary_confidence ?? null,
            reasoning: r.reasoning,
            created_at: r.created_at,
          }
        }
        setTablePersonas(map)
      })
      .catch(() => {})
  }, [currentBatchPhaseKey])

  // Fetch per-phase sentiment aggregate + refresh archetype summary whenever new phases are loaded
  useEffect(() => {
    const loadedKeys = Object.keys(phaseData)
    if (loadedKeys.length === 0) return
    const payload = loadedKeys.map(key => {
      const def = PHASE_DEFS.find(p => p.key === key)
      if (!def) return null
      return { phase: key, date_from: def.from, date_to: def.to }
    }).filter(Boolean)
    if (payload.length > 0) {
      apiFetch<typeof phaseSentiment>('/persona/phase-sentiment', {
        method: 'POST',
        body: JSON.stringify(payload),
      }).then(d => setPhaseSentiment(d)).catch(() => {})
    }
    // Also refresh archetype summary so Section C populates without needing to open the Archetype tab
    apiFetch<typeof personaSummary>('/persona/phase-summary?method=archetype')
      .then(d => setPersonaSummary(d))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseData])

  // Fetch per-phase archetypes from DB for the cross-tab visualization
  useEffect(() => {
    const toFetch = Object.keys(phaseData).filter(k => !(k in phasePersonas))
    for (const key of toFetch) {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseData])

  // Map a message date string to the phase key it falls in
  const dateToPhaseKey = useCallback((date: string): string | null => {
    const d = date?.slice(0, 10) ?? ''
    if (!d) return null
    for (const def of PHASE_DEFS) {
      if (d >= def.from && (!def.to || d <= def.to)) return def.key
    }
    return null
  }, [PHASE_DEFS])

  // Track which phase persona requests have been fired to avoid duplicate fetches
  const requestedPhasePersonasRef = useRef(new Set<string>())

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

  // Load BERTopic results from DB for all users in the current search
  useEffect(() => {
    if (userStats.length === 0) { setTableTopics({}); return }
    let cancelled = false
    const body: Record<string, unknown> = { usernames: userStats.map(u => u.username) }
    // Use raw dateFrom/dateTo (not computed filterStartDate/filterEndDate) so that
    // open-ended phases (3, 3D) with empty dateTo match topic runs saved by the
    // user-detail panel which also uses empty date_to.
    if (dateFrom) body.date_from = dateFrom
    if (dateTo) body.date_to = dateTo
    if (scopeParam) body.upload_ids = scopeParam
    apiFetch<{ results: Record<string, UserTopicsResult | null> }>(
      '/topics/batch-get',
      { method: 'POST', body: JSON.stringify(body) }
    ).then(data => {
      if (cancelled) return
      const entries: Record<string, UserTopicsResult> = {}
      for (const [username, result] of Object.entries(data.results)) {
        if (result) entries[username] = result
      }
      setTableTopics(entries)
    }).catch(() => {})
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userStats, dateFrom, dateTo, scopeParam])

  const filteredUsers = userStats.filter((u) => {
    if (userNameFilter.trim() && !u.username.toLowerCase().includes(userNameFilter.trim().toLowerCase())) return false
    if (refineFirstMsgIn && (u.first_date ?? '') < refineFirstMsgIn) return false
    if (refineLastMsgFrom && (u.last_date ?? '') < refineLastMsgFrom) return false
    if (refineMinMessages && u.total_messages < parseInt(refineMinMessages)) return false
    if (refineMaxMessages && u.total_messages > parseInt(refineMaxMessages)) return false
    if (refineMinWeeks && (u.weeks_active ?? 0) < parseInt(refineMinWeeks)) return false
    if (refineAvgWordsMin && (u.avg_words ?? 0) < parseFloat(refineAvgWordsMin)) return false
    if (refineAvgWordsMax && (u.avg_words ?? 0) > parseFloat(refineAvgWordsMax)) return false
    if (dropoutStatusFilter !== 'all') {
      if (dropoutStatusFilter === 'decreased') {
        const cp = crossPhaseMap.get(u.username)
        if (!cp || !cp.startsWith('dec-')) return false
      } else if (dropoutStatusFilter === 'dropout') {
        const cp = crossPhaseMap.get(u.username)
        if (!cp || !cp.startsWith('dropout-')) return false
      } else {
        const info = dropoutMap.get(u.username)
        if (!info || info.level !== dropoutStatusFilter) return false
      }
    }
    if (archetypeFilter !== 'all') {
      const p = tablePersonas[u.username]
      if (!p || p.persona !== archetypeFilter) return false
    }
    if (secondaryArchetypeFilter !== 'all') {
      const p = tablePersonas[u.username]
      const sec = p?.secondary_persona ?? 'None'
      if (sec !== secondaryArchetypeFilter) return false
    }
    if (showOnlyFailedTopics) {
      const t = tableTopics[u.username]
      // Only show users where BERTopic actually failed (warning + non-empty fallback topics).
      // Exclude users whose warning is just "no meaningful content" (topics array is empty).
      if (!t?.warning || (t.topics?.length ?? 0) === 0) return false
    }
    if (showOnlyAnomalyTopics) {
      const topics = (tableTopics[u.username]?.topics ?? []).filter(tp => tp.id !== -1)
      const topicCount = topics.length
      const msgCount = u.total_messages ?? 0
      if (topicCount === 0 || msgCount === 0 || topicCount <= msgCount) return false
    }
    return true
  })

  const sortedUsers = [...filteredUsers].sort((a, b) => {
    const dir = userSortDir === 'asc' ? 1 : -1
    switch (userSortCol) {
      case 'username': return dir * a.username.localeCompare(b.username)
      case 'first_date': return dir * (a.first_date ?? '').localeCompare(b.first_date ?? '')
      case 'last_date': return dir * (a.last_date ?? '').localeCompare(b.last_date ?? '')
      case 'avg_words': return dir * ((a.avg_words ?? 0) - (b.avg_words ?? 0))
      case 'weeks_active': return dir * ((a.weeks_active ?? 0) - (b.weeks_active ?? 0))
      case 'pct_weeks': return dir * ((a.pct_weeks ?? 0) - (b.pct_weeks ?? 0))
      default: return dir * (a.total_messages - b.total_messages)
    }
  })

  const handleUserSortCol = (col: typeof userSortCol) => {
    if (userSortCol === col) setUserSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setUserSortCol(col); setUserSortDir('desc') }
  }

  const clearRefine = () => {
    setUserNameFilter('')
    setRefineFirstMsgIn('')
    setRefineLastMsgFrom('')
    setRefineMinMessages('')
    setRefineMaxMessages('')
    setRefineMinWeeks('')
    setRefineAvgWordsMin('')
    setRefineAvgWordsMax('')
    setDropoutStatusFilter('all')
    setArchetypeFilter('all')
    setSecondaryArchetypeFilter('all')
  }


  // User detail derived state
  const userDetailFiltered = useMemo(() => {
    let msgs = userMsgs
    if (userDetailDateFrom) msgs = msgs.filter(m => (m.date?.slice(0, 10) ?? '') >= userDetailDateFrom)
    if (userDetailDateTo) msgs = msgs.filter(m => (m.date?.slice(0, 10) ?? '') <= userDetailDateTo)
    if (userDetailContains.trim()) {
      const words = userDetailContains.toLowerCase().split(/\s+/).filter(Boolean)
      msgs = msgs.filter(m => words.every(w => m.content.toLowerCase().includes(w)))
    }
    if (userDetailMinWords > 0) {
      msgs = msgs.filter(m => m.content.split(/\s+/).filter(Boolean).length >= userDetailMinWords)
    }
    return msgs
  }, [userMsgs, userDetailDateFrom, userDetailDateTo, userDetailContains, userDetailMinWords])

  // Map topic_id → full Message objects, built from doc_assignments after userDetailFiltered is ready
  const topicMessages = useMemo(() => {
    const assignments = userTopicsResult?.doc_assignments
    if (!assignments) return new Map<number, Message[]>()
    const map = new Map<number, Message[]>()
    for (const m of userDetailFiltered) {
      const uuid = m.msg_uuid
      if (!uuid) continue
      const topicId = assignments[uuid]
      if (topicId === undefined) continue
      if (!map.has(topicId)) map.set(topicId, [])
      map.get(topicId)!.push(m)
    }
    return map
  }, [userTopicsResult, userDetailFiltered])

  // How many filtered messages haven't been covered by the last cached analysis
  const topicsRemainingCount = useMemo(() => {
    if (!selectedUser || !userTopicsResult) return 0
    const cached = topicsCacheRef.current.get(makeAnalysisKey(selectedUser.username, userDetailDateFrom, userDetailDateTo))
    if (!cached) return 0
    return userDetailFiltered.filter(m => !cached.uuids.has(m.msg_uuid ?? '')).length
  }, [selectedUser, userTopicsResult, userDetailFiltered, userDetailDateFrom, userDetailDateTo])

  const emotionRemainingCount = useMemo(() => {
    if (!selectedUser || !userEmotionResult) return 0
    const cached = emotionCacheRef.current.get(makeAnalysisKey(selectedUser.username, userDetailDateFrom, userDetailDateTo))
    if (!cached) return 0
    return userDetailFiltered.filter(m => !cached.uuids.has(m.msg_uuid ?? '')).length
  }, [selectedUser, userEmotionResult, userDetailFiltered, userDetailDateFrom, userDetailDateTo])

  // Cross-join BERTopic + Emotion + dates into a temporal matrix
  const userTimeline = useMemo(() => {
    const assignments = userTopicsResult?.doc_assignments
    if (!assignments) return null

    const emotionMap = new Map<string, 'positive' | 'negative' | 'neutral'>()
    if (userEmotionResult) {
      for (const p of userEmotionResult.per_message) {
        if (p.msg_uuid) emotionMap.set(p.msg_uuid, p.sentiment)
      }
    }

    const matrix: Record<string, Record<number, { count: number; positive: number; negative: number; neutral: number }>> = {}
    for (const m of userDetailFiltered) {
      if (!m.msg_uuid) continue
      const topicId = assignments[m.msg_uuid]
      if (topicId === undefined) continue
      const period = m.date ? getMondayKey(m.date) : 'unknown'
      const sentiment = emotionMap.get(m.msg_uuid) ?? 'neutral'
      if (!matrix[period]) matrix[period] = {}
      if (!matrix[period][topicId]) matrix[period][topicId] = { count: 0, positive: 0, negative: 0, neutral: 0 }
      matrix[period][topicId].count++
      matrix[period][topicId][sentiment]++
    }

    const periods = Object.keys(matrix).sort()
    if (periods.length === 0) return null

    const topicTotals: Record<number, number> = {}
    for (const period of periods) {
      for (const [tid, data] of Object.entries(matrix[period])) {
        const id = Number(tid)
        topicTotals[id] = (topicTotals[id] ?? 0) + data.count
      }
    }

    // Top 9 real topics by count, outliers (-1) go last
    const sorted = Object.entries(topicTotals).sort(([, a], [, b]) => b - a).map(([id]) => Number(id))
    const topTopics = [
      ...sorted.filter(id => id !== -1).slice(0, 9),
      ...(sorted.includes(-1) ? [-1] : []),
    ].slice(0, 10)

    const streamTopics = topTopics.filter(id => id !== -1)

    const streamData = periods.map(period => {
      const entry: Record<string, number | string> = { period }
      for (const tid of streamTopics) {
        entry[`t${tid}`] = matrix[period]?.[tid]?.count ?? 0
      }
      return entry
    })

    const heatmap = periods.map(period => ({
      period,
      topics: topTopics.map(tid => ({
        topicId: tid,
        ...(matrix[period]?.[tid] ?? { count: 0, positive: 0, negative: 0, neutral: 0 }),
      })),
    }))

    const maxCount = Math.max(1, ...heatmap.flatMap(h => h.topics.map(t => t.count)))

    const topicMeta = topTopics.map((tid, idx) => {
      const topic = userTopicsResult?.topics.find(t => t.id === tid)
      return {
        id: tid,
        label: tid === -1 ? 'Outliers' : (topic?.label ?? `Topic ${tid}`),
        color: tid === -1 ? '#6b7280' : TOPIC_COLORS[idx % TOPIC_COLORS.length],
        totalCount: topicTotals[tid] ?? 0,
      }
    })

    return { periods, streamTopics, streamData, heatmap, maxCount, topicMeta, hasEmotion: emotionMap.size > 0 }
  }, [userTopicsResult, userEmotionResult, userDetailFiltered])

  // Reset to page 0 and scroll to top whenever the filtered set changes
  useEffect(() => {
    setUserDetailPage(0)
    msgContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [userDetailFiltered])

  // When user changes phase date shortcuts while a user is open, reload analysis from cache
  useEffect(() => {
    if (!selectedUser || userMsgsLoading || userMsgs.length === 0) return
    const currentKey = makeAnalysisKey(selectedUser.username, userDetailDateFrom, userDetailDateTo)
    if (currentKey === openedWithKeyRef.current) return  // initial open already handled

    // Clear stale analysis results
    setUserTopicsResult(null)
    setUserEmotionResult(null)

    // Try BERTopic from in-memory cache or DB for this date range
    const mem = topicsCacheRef.current.get(currentKey)
    if (mem) {
      setUserTopicsResult(mem.result)
    } else {
      setTopicsDbLoading(true)
      const topicsParams = new URLSearchParams()
      if (userDetailDateFrom) topicsParams.set('date_from', userDetailDateFrom)
      if (userDetailDateTo) topicsParams.set('date_to', userDetailDateTo)
      if (scopeParam) topicsParams.set('upload_ids', scopeParam)
      apiFetch<UserTopicsResult | null>(
        `/topics/user/${encodeURIComponent(selectedUser.username)}?${topicsParams}`
      ).then(result => {
        if (result) {
          setUserTopicsResult(result)
          topicsCacheRef.current.set(currentKey, {
            result,
            uuids: new Set(userMsgs.map(m => m.msg_uuid ?? '')),
          })
        }
      }).catch(() => {}).finally(() => setTopicsDbLoading(false))
    }

    // Restore emotion — try IndexedDB, then in-memory cache, then stored DB rows
    const emotionFilteredUuids = userMsgs
      .filter(m => {
        const d = m.date?.slice(0, 10) ?? ''
        if (userDetailDateFrom && d < userDetailDateFrom) return false
        if (userDetailDateTo && d > userDetailDateTo) return false
        return true
      })
      .map(m => m.msg_uuid ?? '')
      .filter(Boolean)
    const emotionKey = makeEmotionKey(selectedUser.username, userDetailDateFrom, userDetailDateTo)
    checkEmotionCompleted(emotionKey)
      .then(async completed => {
        if (completed) {
          const emotionMap = await getEmotionMessages(emotionFilteredUuids)
          if (emotionMap.size > 0) {
            const perMessage = emotionFilteredUuids
              .map(uuid => emotionMap.get(uuid))
              .filter((v): v is NonNullable<typeof v> => !!v)
            const result = buildEmotionResult(perMessage)
            setUserEmotionResult(result)
            emotionCacheRef.current.set(currentKey, { result, uuids: new Set(emotionMap.keys()) })
            return
          }
        }
        const mem = emotionCacheRef.current.get(currentKey)
        if (mem) {
          setUserEmotionResult(mem.result)
        } else {
          const dateByUuid = new Map(userMsgs.map(m => [m.msg_uuid ?? '', m.date ?? '']))
          const dbResult = await fetchStoredEmotionFromDB(emotionFilteredUuids, dateByUuid, emotionFilteredUuids.length)
          if (dbResult) {
            setUserEmotionResult(dbResult)
            emotionCacheRef.current.set(currentKey, { result: dbResult, uuids: new Set(emotionFilteredUuids) })
          }
        }
      })
      .catch(() => null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUser?.username, userDetailDateFrom, userDetailDateTo])

  const userDetailStats = useMemo(() => {
    if (userDetailFiltered.length === 0) return null
    const dates = userDetailFiltered.map(m => m.date?.slice(0, 19) ?? '').filter(Boolean).sort()
    const first = dates[0] ?? ''
    const last = dates[dates.length - 1] ?? ''
    const avgWords = userDetailFiltered.reduce((s, m) => s + m.content.split(/\s+/).filter(Boolean).length, 0) / userDetailFiltered.length
    const weekKey = (ds: string) => {
      const d = new Date(ds)
      const ys = new Date(d.getFullYear(), 0, 1)
      const doy = Math.floor((d.getTime() - ys.getTime()) / 86400000)
      const w = Math.floor((doy + (ys.getDay() === 0 ? 6 : ys.getDay() - 1)) / 7)
      return `${d.getFullYear()}-${String(w).padStart(2, '0')}`
    }
    const weeksActive = new Set(userDetailFiltered.map(m => m.date ? weekKey(m.date) : null).filter(Boolean)).size
    const totalWeeks = first && last ? Math.max(1, Math.ceil((new Date(last).getTime() - new Date(first).getTime()) / (7 * 86400000)) + 1) : 1
    return {
      total: userDetailFiltered.length,
      first: first.replace('T', ' '),
      last: last.replace('T', ' '),
      avgWords: Math.round(avgWords * 10) / 10,
      weeksActive,
      totalWeeks,
      pctWeeks: Math.round(weeksActive / totalWeeks * 1000) / 10,
    }
  }, [userDetailFiltered])

  // Messages filtered by clicked emotion/sentiment
  const emotionFilteredMsgs = useMemo(() => {
    if (!emotionMsgFilter || !userEmotionResult) return []
    const { type, label, period } = emotionMsgFilter

    let matchingUuids: Set<string>
    if (type === 'emotion') {
      matchingUuids = new Set(
        userEmotionResult.per_message
          .filter(p => p.top_emotions.some(e => e.label === label))
          .map(p => p.msg_uuid)
      )
    } else {
      matchingUuids = new Set(
        userEmotionResult.per_message
          .filter(p =>
            p.sentiment === label &&
            (!period || (p.date?.slice(0, 7) ?? '') === period)
          )
          .map(p => p.msg_uuid)
      )
    }

    return userDetailFiltered
      .filter(m => m.msg_uuid && matchingUuids.has(m.msg_uuid))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  }, [emotionMsgFilter, userEmotionResult, userDetailFiltered])

  // Messages for a clicked heatmap cell (topic × week)
  const heatmapCellMsgs = useMemo(() => {
    if (!heatmapCell) return []
    const msgs = topicMessages.get(heatmapCell.topicId) ?? []
    return msgs
      .filter(m => m.date && getMondayKey(m.date) === heatmapCell.period)
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  }, [heatmapCell, topicMessages])

  const openUserDetail = async (u: UserInRange) => {
    // Capture filter values before state updates so we can build the cache key
    const initialAnalysisKey = makeAnalysisKey(u.username, dateFrom, dateTo)
    openedWithKeyRef.current = initialAnalysisKey
    // Mark as loaded so the route effect doesn't double-fetch when the URL changes
    routeLoadedRef.current = u.username
    navigate(`/discord/search/users/${encodeURIComponent(u.username)}`)

    setSelectedUser(u)
    setUserMsgsLoading(true)
    setUserMsgs([])
    setUserDetailDateFrom(dateFrom)
    setUserDetailDateTo(dateTo)
    setUserDetailContains('')
    setUserDetailMinWords(0)
    setUserSumResult('')
    setUserSumFollowUp([])
    setUserDetailPage(0)
    setUserTopicsResult(null)
    setUserTopicsSteps([])
    setTopicsDbLoading(true)
    setUserEmotionResult(null)
    setEmotionMsgFilter(null)
    setSelectedTopicIds(null)
    setHeatmapCell(null)
    setDropoutSubTab('cross')
    setCrossPhaseNarrative(null)
    setNarrativeLoading(false)
    setUserPersonas({})
    setPersonaClassifying(new Set())
    setStrategyResult(null)
    setStrategyError(null)
    setExpandedStrategyIds(new Set())
    try {
      const userMsgParams = new URLSearchParams({ username: u.username, limit: '1000000' })
      if (scopeParam) userMsgParams.set('upload_ids', scopeParam)

      // Fetch messages, BERTopic from DB, and saved personas in parallel
      const topicsParams = new URLSearchParams()
      if (dateFrom) topicsParams.set('date_from', dateFrom)
      if (dateTo) topicsParams.set('date_to', dateTo)
      if (scopeParam) topicsParams.set('upload_ids', scopeParam)
      const [data, cachedTopics, savedPersonas] = await Promise.all([
        apiFetch<Message[]>(`/search/user-messages?${userMsgParams}`),
        apiFetch<UserTopicsResult | null>(
          `/topics/user/${encodeURIComponent(u.username)}?${topicsParams}`
        ).catch(() => null),
        apiFetch<{
          phase: string; method: string; persona: string; confidence: number;
          secondary_persona?: string | null; secondary_confidence?: number | null;
          reasoning: string; created_at: string;
        }[]>(
          `/persona/user/${encodeURIComponent(u.username)}?method=archetype`
        ).catch(() => [] as Array<{
          phase: string; method: string; persona: string; confidence: number;
          secondary_persona?: string | null; secondary_confidence?: number | null;
          reasoning: string; created_at: string;
        }>),
      ])
      // Organize saved personas into per-phase map (single archetype per phase)
      if (savedPersonas.length > 0) {
        const personaMap: UserPersonas = {}
        for (const p of savedPersonas) {
          personaMap[p.phase] = {
            persona: p.persona,
            confidence: p.confidence,
            secondary_persona: p.secondary_persona ?? null,
            secondary_confidence: p.secondary_confidence ?? null,
            reasoning: p.reasoning,
            created_at: p.created_at,
          }
        }
        setUserPersonas(personaMap)
      }
      setUserMsgs(data)

      // Restore BERTopic from DB / in-memory cache
      if (cachedTopics) {
        setUserTopicsResult(cachedTopics)
        topicsCacheRef.current.set(initialAnalysisKey, {
          result: cachedTopics,
          uuids: new Set(data.map(m => m.msg_uuid ?? '')),
        })
      } else {
        // Fall back to in-memory cache (same session, different user navigation)
        const mem = topicsCacheRef.current.get(initialAnalysisKey)
        if (mem) {
          setUserTopicsResult(mem.result)
        }
      }
      setTopicsDbLoading(false)

      // Restore emotion — try IndexedDB, then in-memory cache, then stored DB rows
      const emotionFilteredUuids = data
        .filter(m => {
          const d = m.date?.slice(0, 10) ?? ''
          if (dateFrom && d < dateFrom) return false
          if (dateTo && d > dateTo) return false
          return true
        })
        .map(m => m.msg_uuid ?? '')
        .filter(Boolean)
      const emotionKey = makeEmotionKey(u.username, dateFrom, dateTo)
      const emotionCompleted = await checkEmotionCompleted(emotionKey).catch(() => false)
      let emotionLoaded = false
      if (emotionCompleted) {
        const emotionMap = await getEmotionMessages(emotionFilteredUuids).catch(() => new Map())
        if (emotionMap.size > 0) {
          const perMessage = emotionFilteredUuids
            .map(uuid => emotionMap.get(uuid))
            .filter((v): v is NonNullable<typeof v> => !!v)
          const result = buildEmotionResult(perMessage)
          setUserEmotionResult(result)
          emotionCacheRef.current.set(initialAnalysisKey, { result, uuids: new Set([...emotionMap.keys()]) })
          emotionLoaded = true
        }
      }
      if (!emotionLoaded) {
        const mem = emotionCacheRef.current.get(initialAnalysisKey)
        if (mem) {
          setUserEmotionResult(mem.result)
        } else {
          const dateByUuid = new Map(data.map(m => [m.msg_uuid ?? '', m.date ?? '']))
          const dbResult = await fetchStoredEmotionFromDB(emotionFilteredUuids, dateByUuid, emotionFilteredUuids.length)
          if (dbResult) {
            setUserEmotionResult(dbResult)
            emotionCacheRef.current.set(initialAnalysisKey, { result: dbResult, uuids: new Set(emotionFilteredUuids) })
          }
        }
      }
    } catch {
      setTopicsDbLoading(false)
    } finally {
      setUserMsgsLoading(false)
    }
  }

  const runUserSummary = () => {
    if (userDetailFiltered.length === 0) return
    setUserAnalysisTab('summary')
    setUserSumResult('')
    setUserSumFollowUp([])
    setUserSumLoading(true)
    if (userSumStopRef.current) userSumStopRef.current()
    userSumStopRef.current = streamEvents(
      '/summarize-results',
      {
        messages: userDetailFiltered.map(m => ({ username: m.username, date: m.date, content: m.content, msg_uuid: m.msg_uuid })),
        prompt: userSumInstructions,
        model: userSumModel,
        retrieval_mode: userSumRetrievalMode,
      },
      (event) => { if (event.content) setUserSumResult(prev => prev + String(event.content)) },
      () => setUserSumLoading(false),
      (err) => { setUserSumResult(`Error: ${err.message}`); setUserSumLoading(false) },
    )
  }

  const runUserTopics = (mode: 'all' | 'remaining' = 'all') => {
    if (!selectedUser) return
    const topicsAnalysisKey = makeAnalysisKey(selectedUser.username, userDetailDateFrom, userDetailDateTo)
    const cached = topicsCacheRef.current.get(topicsAnalysisKey)
    const msgs = mode === 'remaining' && cached
      ? userDetailFiltered.filter(m => !cached.uuids.has(m.msg_uuid ?? ''))
      : userDetailFiltered
    if (msgs.length === 0) return
    setUserAnalysisTab('topics')
    setUserTopicsLoading(true)
    setUserTopicsResult(null)
    setExpandedTopicSamples(new Set())
    setUserTopicsSteps([
      { stage: 'prepare',          status: 'pending', message: 'Collecting messages…' },
      { stage: 'fetch_embeddings', status: 'pending', message: 'Fetching embeddings from Qdrant…' },
      { stage: 'align_docs',       status: 'pending', message: 'Aligning documents…' },
      { stage: 'bertopic',         status: 'pending', message: 'Running topic modeling…' },
      { stage: 'complete',         status: 'pending', message: 'Finalizing results…' },
    ])
    if (topicsStopRef.current) topicsStopRef.current()
    const docs = msgs.map(m => m.content)
    const msg_uuids = msgs.map(m => m.msg_uuid ?? '')
    const username = selectedUser.username
    topicsStopRef.current = streamEvents(
      '/user-topics/stream',
      {
        docs,
        msg_uuids,
        username,
        date_from: userDetailDateFrom || undefined,
        date_to: userDetailDateTo || undefined,
        upload_ids: scopeParam || undefined,
      },
      (event) => {
        const stage = event.stage as string
        const status = event.status as string
        const message = event.message as string
        if (stage === 'complete' && event.result) {
          const result = event.result as UserTopicsResult
          setUserTopicsResult(result)
          const allUuids = new Set(userDetailFiltered.map(m => m.msg_uuid ?? ''))
          topicsCacheRef.current.set(topicsAnalysisKey, { result, uuids: allUuids })
          // Also update the table column live
          setTableTopics(prev => ({ ...prev, [username]: result }))
        }
        setUserTopicsSteps(prev =>
          prev.map(s => s.stage === stage ? { ...s, status: status as TopicPipelineStep['status'], message } : s)
        )
      },
      () => setUserTopicsLoading(false),
      (err) => {
        setUserTopicsSteps(prev =>
          prev.map(s => s.status === 'running' ? { ...s, status: 'error', message: `Failed: ${err.message}` } : s)
        )
        setUserTopicsResult({ topics: [], total_docs: 0, filtered_docs: 0 })
        setUserTopicsLoading(false)
      },
    )
  }

  const runUserEmotion = async (mode: 'all' | 'remaining' = 'all') => {
    if (userDetailFiltered.length === 0 || !selectedUser) return
    const emotionAnalysisKey = makeAnalysisKey(selectedUser.username, userDetailDateFrom, userDetailDateTo)
    const cached = emotionCacheRef.current.get(emotionAnalysisKey)
    const msgs = mode === 'remaining' && cached
      ? userDetailFiltered.filter(m => !cached.uuids.has(m.msg_uuid ?? ''))
      : userDetailFiltered
    if (msgs.length === 0) return
    setUserAnalysisTab('emotion')
    setUserEmotionLoading(true)
    setUserEmotionResult(null)
    try {
      const result = await apiFetch<EmotionResult>('/user-emotion', {
        method: 'POST',
        body: JSON.stringify({
          messages: msgs.map(m => ({
            content: m.content,
            date: m.date,
            msg_uuid: m.msg_uuid ?? '',
          })),
        }),
      })
      let finalResult = result
      if (mode === 'remaining' && cached) {
        finalResult = mergeEmotionResults(cached.result, result)
      }
      const allUuids = new Set(userDetailFiltered.map(m => m.msg_uuid ?? ''))
      emotionCacheRef.current.set(emotionAnalysisKey, { result: finalResult, uuids: allUuids })
      setUserEmotionResult(finalResult)
      // Persist per-message results and mark this username|dateFrom|dateTo as completed
      const emotionKey = makeEmotionKey(selectedUser.username, userDetailDateFrom, userDetailDateTo)
      saveEmotionMessages(result.per_message).catch(console.error)
      markEmotionCompleted(emotionKey).catch(console.error)
    } catch (err) {
      console.error('Emotion analysis failed:', err)
    } finally {
      setUserEmotionLoading(false)
    }
  }

  // Single shared archetype response shape from POST /persona/compute-batch
  type ArchetypeRow = {
    username: string
    persona: string
    confidence: number
    secondary_persona?: string | null
    secondary_confidence?: number | null
    reasoning: string
    scores?: Record<string, number>
  }

  // Helper: build the `users` payload for compute-batch from a UserInRange list.
  // Pulls activity stats AND the precomputed engagement level — backend uses
  // the engagement string as its authoritative tier signal (only "high" users
  // are eligible for Power Contributor).  Without this, percentile-rank-based
  // tiering on the backend lets low-volume users in quiet phases slip into PC.
  const buildUsersPayload = (
    users: UserInRange[],
    windowFrom?: string,
    windowTo?: string,
  ) => {
    const from = windowFrom ?? filterStartDate
    const to   = windowTo   ?? filterEndDate
    return users.map(u => ({
      username:       u.username,
      total_messages: u.total_messages,
      weeks_active:   u.weeks_active ?? 0,
      pct_weeks:      u.pct_weeks ?? 0,
      avg_words:      u.avg_words ?? 0,
      engagement:     classifyEngagement(u, from, to).level,  // "high"|"medium"|"low"
    }))
  }

  // Recompute archetypes for a batch of users in one round-trip.  Replaces the
  // old per-user /persona/classify loop (rule_based + LLM); now everything is
  // computed server-side from already-stored sentiment + topics + activity.
  const computeBatchArchetypes = async (users: UserInRange[]) => {
    if (batchPersonaClassifying || users.length === 0) return
    // Match against the RAW dateFrom/dateTo — same reasoning as currentBatchPhaseKey:
    // topic runs are cached under the raw window, so the compute-batch request must
    // send that same raw window (and a stable phase key) or an open-ended phase
    // (dateTo === '') never finds its topics and the custom-key fallback drifts
    // every time filterEndDate resolves to a newer "last message" date.
    const matched = PHASE_DEFS.find(def => def.from === dateFrom && def.to === dateTo)
    const phaseKey   = matched ? matched.key   : `custom|${dateFrom || 'start'}|${dateTo || 'end'}`
    const phaseLabel = matched ? matched.label : `${dateFrom || 'start'} → ${dateTo || 'present'}`

    setBatchPersonaClassifying(true)
    setBatchPersonaProgress({ done: 0, total: users.length, errors: 0 })
    try {
      const resp = await apiFetch<{ results: ArchetypeRow[]; count: number }>(
        '/persona/compute-batch',
        {
          method: 'POST',
          body: JSON.stringify({
            phase: phaseKey,
            phase_label: phaseLabel,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            upload_ids: scopeParam || undefined,
            users: buildUsersPayload(users),
          }),
        }
      )
      // Single bulk update of tablePersonas — no per-user setState churn
      setTablePersonas(prev => {
        const next = { ...prev }
        for (const r of resp.results) {
          next[r.username] = {
            persona: r.persona,
            confidence: r.confidence,
            secondary_persona: r.secondary_persona ?? null,
            secondary_confidence: r.secondary_confidence ?? null,
            reasoning: r.reasoning,
          }
        }
        return next
      })
      setBatchPersonaProgress({ done: resp.results.length, total: users.length, errors: 0 })
    } catch (err) {
      console.error('Archetype batch compute failed:', err)
      setBatchPersonaProgress({ done: 0, total: users.length, errors: users.length })
    } finally {
      setBatchPersonaClassifying(false)
    }

    // Refresh aggregate summary so Persona tab updates
    apiFetch<typeof personaSummary>('/persona/phase-summary?method=archetype')
      .then(d => setPersonaSummary(d))
      .catch(() => {})
  }

  // Recompute archetypes for ALL users in a specific phase (called from Phase Summary table).
  const reanalyzePhaseFull = async (phaseKey: string, phaseLabel: string, phaseFrom: string, phaseTo: string) => {
    if (reanalyzingPhases.has(phaseKey)) return
    const users = phaseData[phaseKey] ?? []
    if (users.length === 0) return
    // phaseTo is the RAW phase end (empty for an open-ended phase like 3D) — it
    // must stay raw in the request body so it matches the window topics were
    // cached under. But classifyEngagement needs a real end date to compute
    // windowDays; feeding it '' makes daysBetween() return NaN (new Date('') is
    // Invalid Date), which forces every user's engagement to "low". Resolve a
    // real end date from the loaded batch's own data just for that calculation.
    const engagementEnd = phaseTo || users.reduce((mx, u) =>
      (u.last_date && u.last_date > mx ? u.last_date.slice(0, 10) : mx), '')
    setReanalyzingPhases(prev => new Set([...prev, phaseKey]))
    try {
      const resp = await apiFetch<{ results: ArchetypeRow[] }>(
        '/persona/compute-batch',
        {
          method: 'POST',
          body: JSON.stringify({
            phase: phaseKey,
            phase_label: phaseLabel,
            date_from: phaseFrom || undefined,
            date_to: phaseTo || undefined,
            upload_ids: scopeParam || undefined,
            users: buildUsersPayload(users, phaseFrom, engagementEnd),
          }),
        }
      )
      // Update per-phase persona maps so the cross-phase visualization refreshes immediately
      const map: Record<string, string> = {}
      const secMap: Record<string, string> = {}
      for (const r of resp.results) {
        map[r.username] = r.persona
        if (r.secondary_persona) secMap[r.username] = r.secondary_persona
      }
      setPhasePersonas(prev => ({ ...prev, [phaseKey]: map }))
      setPhaseSecondaryPersonas(prev => ({ ...prev, [phaseKey]: secMap }))
      // Refresh the aggregate summary counts shown in the table
      apiFetch<typeof personaSummary>('/persona/phase-summary?method=archetype')
        .then(d => setPersonaSummary(d))
        .catch(() => {})
    } catch (err) {
      console.error('Phase reanalyze failed:', err)
    } finally {
      setReanalyzingPhases(prev => { const next = new Set(prev); next.delete(phaseKey); return next })
    }
  }

  // Recompute archetype for the currently-selected user in a single phase.
  // Uses the same batch endpoint with a one-user payload so all rules stay in one place.
  const recomputeOneArchetype = async (phaseKey: string, phaseLabel: string, phaseFrom: string, phaseTo: string) => {
    if (!selectedUser) return
    // Prefer per-phase stats (so total_messages / weeks_active reflect THIS phase,
    // not the global filter window).  Fall back to userStats if per-phase data
    // hasn't been fetched yet.
    const phaseUsers = phaseData[phaseKey] ?? []
    const u = phaseUsers.find(x => x.username === selectedUser.username)
            ?? userStats.find(x => x.username === selectedUser.username)
    if (!u) return
    // phaseTo is the RAW phase end (empty for an open-ended phase like 3D) — kept
    // raw in the request body so it matches the window topics were cached under.
    // But classifyEngagement needs a real end date: feeding it '' makes
    // daysBetween() return NaN, forcing engagement to "low" for every user.
    // Resolve a real end date from whichever batch we found `u` in.
    const engagementUsers = phaseUsers.length > 0 ? phaseUsers : userStats
    const engagementEnd = phaseTo || engagementUsers.reduce((mx, x) =>
      (x.last_date && x.last_date > mx ? x.last_date.slice(0, 10) : mx), '')
    setPersonaClassifying(prev => new Set([...prev, phaseKey]))
    try {
      const resp = await apiFetch<{ results: ArchetypeRow[] }>(
        '/persona/compute-batch',
        {
          method: 'POST',
          body: JSON.stringify({
            phase: phaseKey,
            phase_label: phaseLabel,
            date_from: phaseFrom || undefined,
            date_to: phaseTo || undefined,
            upload_ids: scopeParam || undefined,
            users: buildUsersPayload([u], phaseFrom, engagementEnd),  // engagement scoped to phase window
          }),
        }
      )
      const r = resp.results[0]
      if (r) {
        setUserPersonas(prev => ({
          ...prev,
          [phaseKey]: {
            persona: r.persona,
            confidence: r.confidence,
            secondary_persona: r.secondary_persona ?? null,
            secondary_confidence: r.secondary_confidence ?? null,
            reasoning: r.reasoning,
          },
        }))
      }
    } catch (err) {
      console.error('Archetype recompute failed:', err)
    } finally {
      setPersonaClassifying(prev => {
        const next = new Set(prev); next.delete(phaseKey); return next
      })
    }
  }

  // Apply a new label to a single topic — updates DB and local state for both
  // the per-user detail view (userTopicsResult) and the result-table snapshot
  // (tableTopics) so the rename is visible everywhere immediately.
  const applyTopicLabelLocally = (topicId: number, newLabel: string) => {
    setUserTopicsResult(prev => prev ? {
      ...prev,
      topics: prev.topics.map(t => t.id === topicId ? { ...t, label: newLabel } : t),
    } : prev)
    if (selectedUser) {
      setTableTopics(prev => {
        const existing = prev[selectedUser.username]
        if (!existing) return prev
        return {
          ...prev,
          [selectedUser.username]: {
            ...existing,
            topics: existing.topics.map(t => t.id === topicId ? { ...t, label: newLabel } : t),
          },
        }
      })
    }
  }

  const saveTopicLabel = async (topicId: number, label: string) => {
    if (!selectedUser || !label.trim()) return
    try {
      await apiFetch('/topics/label', {
        method: 'POST',
        body: JSON.stringify({
          username:   selectedUser.username,
          topic_id:   topicId,
          date_from:  userDetailDateFrom || undefined,
          date_to:    userDetailDateTo   || undefined,
          upload_ids: scopeParam         || undefined,
          label:      label.trim(),
        }),
      })
      applyTopicLabelLocally(topicId, label.trim())
    } catch (err) {
      console.error('Topic label save failed:', err)
      window.alert('Failed to save label — see console for details.')
    } finally {
      setEditingTopicId(null)
      setEditingLabelValue('')
    }
  }

  const relabelTopicWithAI = async (topicId: number) => {
    if (!selectedUser) return
    setRelabelingTopicId(topicId)
    try {
      const resp = await apiFetch<{ label: string }>('/topics/relabel', {
        method: 'POST',
        body: JSON.stringify({
          username:   selectedUser.username,
          topic_id:   topicId,
          date_from:  userDetailDateFrom || undefined,
          date_to:    userDetailDateTo   || undefined,
          upload_ids: scopeParam         || undefined,
        }),
      })
      applyTopicLabelLocally(topicId, resp.label)
    } catch (err) {
      console.error('AI relabel failed:', err)
      window.alert('AI relabel failed — check OpenAI key and console.')
    } finally {
      setRelabelingTopicId(null)
    }
  }

  const relabelTopicInTable = async (username: string, topicId: number, silent = false) => {
    setRelabelingInTable(prev => {
      const s = new Set(prev[username] ?? [])
      s.add(topicId)
      return { ...prev, [username]: s }
    })
    try {
      const resp = await apiFetch<{ label: string }>('/topics/relabel', {
        method: 'POST',
        body: JSON.stringify({
          username,
          topic_id:   topicId,
          date_from:  filterStartDate || undefined,
          date_to:    filterEndDate   || undefined,
          upload_ids: scopeParam      || undefined,
        }),
      })
      setTableTopics(prev => {
        const t = prev[username]
        if (!t) return prev
        return { ...prev, [username]: { ...t, topics: t.topics.map(tp => tp.id === topicId ? { ...tp, label: resp.label } : tp) } }
      })
    } catch (err) {
      console.error('Table relabel failed:', err)
      if (silent) throw err
      window.alert('AI relabel failed — check OpenAI key and console.')
    } finally {
      setRelabelingInTable(prev => {
        const s = new Set(prev[username] ?? [])
        s.delete(topicId)
        return { ...prev, [username]: s }
      })
    }
  }

  const relabelAllTopicsInTable = async (username: string, topicIds: number[]) => {
    for (const id of topicIds) {
      try {
        await relabelTopicInTable(username, id, true)
      } catch {
        // individual topic failure — continue with remaining topics
      }
    }
  }

  const openStatsTopicModal = useCallback(async (
    username: string, topicId: number, label: string, keywords: string[], messageCount: number,
    dateFrom: string, dateTo: string, uploadIds: string,
  ) => {
    setStatsTopicModal({ topicId, label, keywords, username, messageCount })
    setStatsTopicMessages([])
    setStatsTopicLoading(true)
    try {
      const p = new URLSearchParams({ topic_id: String(topicId), date_from: dateFrom, date_to: dateTo, upload_ids: uploadIds })
      const data = await apiFetch<Message[]>(`/topics/user/${encodeURIComponent(username)}/messages?${p}`)
      setStatsTopicMessages(Array.isArray(data) ? data : [])
    } catch {
      setStatsTopicMessages([])
    } finally {
      setStatsTopicLoading(false)
    }
  }, [])

  const runRelabelAllUsers = async (usersWithTopics: { username: string; topicIds: number[] }[]) => {
    if (usersWithTopics.length === 0) return
    setRelabelAllProgress({ done: 0, total: usersWithTopics.length, errors: 0 })
    for (const { username, topicIds } of usersWithTopics) {
      try {
        await relabelAllTopicsInTable(username, topicIds)
        setRelabelAllProgress(prev => prev ? { ...prev, done: prev.done + 1 } : null)
      } catch {
        setRelabelAllProgress(prev => prev ? { ...prev, done: prev.done + 1, errors: prev.errors + 1 } : null)
      }
    }
    setRelabelAllProgress(null)
  }

  const SENTIMENT_CONCURRENCY = 5 // users analyzed in parallel via SSE

  const runBatchSentimentForUsers = async (
    usernames: string[],
    dateFrom?: string,
    dateTo?: string,
    uploadIds?: string,
    analyzeNewOnly = false,
  ) => {
    if (usernames.length === 0) return
    setBatchSentimentRunning(true)
    // For "all": clear only the specific users being re-analyzed so other filter tabs
    // (e.g. Med engagement) retain their previously loaded sentiment while this batch runs.
    if (!analyzeNewOnly) setTableSentiments(prev => {
      const next = { ...prev }
      for (const u of usernames) delete next[u]
      return next
    })
    // Fire the exact-count query IN PARALLEL with the SSE streams so we don't
    // block the AI service on a 1-5s COUNT(*) before any inference can start.
    // While in flight the progress bar shows just "X msgs" (no denominator —
    // see the `totalMsgs > 0` guard in the render).  As soon as COUNT returns
    // (usually well before the first user finishes) the denominator snaps in.
    setSentimentProgress({ msgs: 0, totalMsgs: 0, users: 0, totalUsers: usernames.length })
    const countBody: Record<string, unknown> = { usernames }
    if (dateFrom) countBody.date_from = dateFrom
    if (dateTo) countBody.date_to = dateTo
    if (uploadIds) countBody.upload_ids = uploadIds
    if (analyzeNewOnly) countBody.analyze_new_only = true
    apiFetch<{ count: number }>(
      '/search/sentiment-count',
      { method: 'POST', body: JSON.stringify(countBody) },
    )
      .then(({ count }) => {
        setSentimentProgress(prev => prev ? { ...prev, totalMsgs: count } : null)
      })
      .catch(() => { /* count is best-effort; bar just runs without denominator */ })

    // Wrap a single-user SSE stream in a Promise so we can await it.
    const analyzeOneUser = (username: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const body: Record<string, unknown> = { usernames: [username] }
        if (dateFrom) body.date_from = dateFrom
        if (dateTo) body.date_to = dateTo
        if (uploadIds) body.upload_ids = uploadIds
        if (analyzeNewOnly) body.analyze_new_only = true

        streamEvents(
          '/search/batch-sentiment-stream',
          body,
          (event) => {
            const ev = event as Record<string, unknown>
            if (ev.type === 'progress') {
              const delta = (ev.delta as number) ?? 0
              setSentimentProgress(prev => prev ? { ...prev, msgs: prev.msgs + delta } : null)
            } else if (ev.type === 'user') {
              const result = ev.result as TableSentiment
              setTableSentiments(prev => ({ ...prev, [ev.username as string]: result }))
              setSentimentProgress(prev => prev ? {
                ...prev,
                users: prev.users + 1,
                totalUsers: usernames.length,
              } : null)
            }
          },
          () => resolve(),
          (err) => reject(err),
        )
      })

    try {
      // Process SENTIMENT_CONCURRENCY users at a time in parallel.
      // Each SSE stream emits real-time progress events and a per-user result.
      for (let i = 0; i < usernames.length; i += SENTIMENT_CONCURRENCY) {
        const window = usernames.slice(i, i + SENTIMENT_CONCURRENCY)
        await Promise.all(window.map(analyzeOneUser))
      }
      // After "new only" analysis, reload combined totals from DB for the analyzed users.
      // Use a merge (not replace) so other engagement tabs keep their sentiment data.
      if (analyzeNewOnly && usernames.length > 0) {
        const sentBody: Record<string, unknown> = { usernames }
        if (dateFrom) sentBody.date_from = dateFrom
        if (dateTo) sentBody.date_to = dateTo
        if (uploadIds) sentBody.upload_ids = uploadIds
        apiFetch<{ results: (TableSentiment & { username: string })[] }>(
          '/search/stored-sentiment',
          { method: 'POST', body: JSON.stringify(sentBody) }
        ).then(sentData => {
          setTableSentiments(prev => {
            const next = { ...prev }
            for (const { username, ...rest } of sentData.results)
              if ((rest as TableSentiment).analyzed > 0) next[username] = rest as TableSentiment
            return next
          })
        }).catch(() => {})
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sentiment analysis failed')
    } finally {
      setBatchSentimentRunning(false)
      setSentimentProgress(null)
      const detailUuids = userMsgs.map(m => m.msg_uuid).filter((u): u is string => !!u)
      if (detailUuids.length > 0) {
        fetchMsgEmotionsBatched(detailUuids)
          .then(data => setMsgEmotions(prev => ({ ...prev, ...data })))
          .catch(() => {})
      }
    }
  }

  const runBatchSentimentAll = () => {
    runBatchSentimentForUsers(filteredUsers.map(u => u.username), filterStartDate, filterEndDate, scopeParam, false)
  }

  const runBatchSentimentNew = () => {
    runBatchSentimentForUsers(filteredUsers.map(u => u.username), filterStartDate, filterEndDate, scopeParam, true)
  }

  const runBatchTopicForUsers = async (analyzeNewOnly: boolean) => {
    if (batchTopicRunning || filteredUsers.length === 0) return
    // Snapshot before any awaits — re-renders that remove users from filteredUsers
    // (e.g. anomalous users dropping out after a successful reanalysis) must not
    // truncate the loop.
    const targetUsers = [...filteredUsers]
    setBatchTopicRunning(true)
    setBatchTopicProgress({ done: 0, total: targetUsers.length, errors: 0 })
    let errors = 0

    // "New Only": skip users that already have a result in tableTopics.
    const alreadyAnalyzed = new Set(Object.keys(tableTopics))

    for (let i = 0; i < targetUsers.length; i++) {
      const u = targetUsers[i]
      try {
        if (analyzeNewOnly && alreadyAnalyzed.has(u.username)) {
          setBatchTopicProgress({ done: i + 1, total: targetUsers.length, errors })
          continue
        }
        setBatchTopicCurrentUser(u.username)
        const params = new URLSearchParams({ username: u.username, limit: '1000000' })
        if (scopeParam) params.set('upload_ids', scopeParam)
        // Use raw dateFrom/dateTo for message fetch AND save — consistent with
        // batch-get which also keys on the explicit user filter, not computed dates.
        // When dateTo is empty (open-ended phase 3/3D), the backend returns all
        // messages from dateFrom onward without an upper bound.
        if (dateFrom) params.set('date_from', dateFrom)
        if (dateTo) params.set('date_to', dateTo)
        const msgs = await apiFetch<Message[]>(`/search/user-messages?${params}`).catch(() => [] as Message[])
        if (msgs.length > 0) {
          await new Promise<void>((resolve) => {
            streamEvents(
              '/user-topics/stream',
              {
                docs: msgs.map(m => m.content),
                msg_uuids: msgs.map(m => m.msg_uuid ?? ''),
                username: u.username,
                date_from: dateFrom || undefined,
                date_to: dateTo || undefined,
                upload_ids: scopeParam || undefined,
              },
              (event) => {
                if (event.stage === 'complete' && event.result) {
                  const result = event.result as UserTopicsResult
                  setTableTopics(prev => ({ ...prev, [u.username]: result }))
                }
              },
              () => resolve(),
              () => { errors++; resolve() },
            )
          })
        }
      } catch {
        errors++
      }
      setBatchTopicCurrentUser(null)
      setBatchTopicProgress({ done: i + 1, total: targetUsers.length, errors })
    }

    setBatchTopicCurrentUser(null)
    setBatchTopicRunning(false)
    setBatchTopicProgress(null)
  }

  const runUserSumFollowUp = () => {
    if (!userSumFollowUpInput.trim() || userSumFollowUpLoading) return
    const q = userSumFollowUpInput.trim()
    setUserSumFollowUpInput('')
    setUserSumFollowUp(prev => [...prev, { role: 'user', content: q }])
    setUserSumFollowUpLoading(true)
    let answer = ''
    streamEvents(
      '/summarize-results/followup',
      { question: q, summary: userSumResult, history: userSumFollowUp },
      (event) => {
        if (event.type === 'chunk' || event.content) {
          answer += String(event.content ?? '')
          setUserSumFollowUp(prev => {
            const last = prev[prev.length - 1]
            if (last?.role === 'assistant') return [...prev.slice(0, -1), { role: 'assistant', content: answer }]
            return [...prev, { role: 'assistant', content: answer }]
          })
        }
      },
      () => setUserSumFollowUpLoading(false),
      (err) => {
        setUserSumFollowUp(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
        setUserSumFollowUpLoading(false)
      },
    )
  }

  const inputCls = 'search-input'




  // User detail full-panel view
  if (selectedUser) {
    const u = selectedUser
    const PAGE_SIZE = 50
    const totalPages = Math.max(1, Math.ceil(userDetailFiltered.length / PAGE_SIZE))
    const visibleMsgs = userDetailFiltered.slice(userDetailPage * PAGE_SIZE, (userDetailPage + 1) * PAGE_SIZE)
    return (
      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 space-y-4">
        {/* Header bar — sticky floating */}
        <div className="sticky top-4 z-20 bg-indigo-700 text-white rounded-2xl shadow-xl px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => {
              setSelectedUser(null)
              if (routeUsername) navigate(-1)
            }}
            className="flex items-center gap-1.5 text-sm font-semibold text-indigo-200 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Back
          </button>
          <span className="text-base font-bold flex-1 truncate">{u.username}</span>
          {(() => {
            const di = dropoutMap.get(u.username)
            if (!di) return null
            const badge: Record<EngagementLevel, { label: string; cls: string }> = {
              high:   { label: 'High Eng.',  cls: 'bg-emerald-500 text-white' },
              medium: { label: 'Med Eng.',   cls: 'bg-sky-500 text-white' },
              low:    { label: 'Low Eng.',   cls: 'bg-amber-500 text-white' },
            }
            const b = badge[di.level]
            return (
              <span
                className={`shrink-0 text-xs font-bold px-2.5 py-1 rounded-full ${b.cls}`}
                title={`${di.pctWeeks}% of weeks active`}
              >
                {b.label}
              </span>
            )
          })()}
          <span className="text-sm text-indigo-200 shrink-0">{userMsgsLoading ? 'Loading…' : `Total Number of Messages: ${userMsgs.length.toLocaleString()}`}</span>
        </div>

        {/* Stats cards — reflect filtered messages */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'TOTAL MESSAGES', value: userDetailStats ? userDetailStats.total.toLocaleString() : '—' },
            { label: 'FIRST MESSAGE', value: userDetailStats?.first.slice(0, 19) ?? '—' },
            { label: 'LAST MESSAGE', value: userDetailStats?.last.slice(0, 19) ?? '—' },
            { label: 'AVG WORDS', value: userDetailStats ? String(userDetailStats.avgWords) : '—' },
            { label: 'WEEKS ACTIVE', value: userDetailStats ? `${userDetailStats.weeksActive} / ${userDetailStats.totalWeeks}` : '—' },
            { label: '% WEEKS ACTIVE', value: userDetailStats ? `${userDetailStats.pctWeeks}%` : '—' },
          ].map(({ label, value }) => (
            <div key={label} className="bg-white rounded-xl shadow px-3 py-2.5">
              <p className="text-[10px] font-semibold text-indigo-600 uppercase tracking-wide">{label}</p>
              <p className="text-sm font-bold text-gray-900 mt-0.5 truncate">{value}</p>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl shadow px-4 py-3">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="flex flex-col gap-1">
              <label className="filter-label">From</label>
              <input type="date" value={userDetailDateFrom} onChange={e => setUserDetailDateFrom(e.target.value)} className="search-input" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="filter-label">To</label>
              <input type="date" value={userDetailDateTo} onChange={e => setUserDetailDateTo(e.target.value)} className="search-input" />
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-[160px]">
              <label className="filter-label">Contains</label>
              <input
                value={userDetailContains}
                onChange={e => setUserDetailContains(e.target.value)}
                placeholder="keyword..."
                className="search-input"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="filter-label">Min words</label>
              <input
                type="text" inputMode="numeric"
                value={String(userDetailMinWords)}
                onChange={e => setUserDetailMinWords(parseInt(e.target.value.replace(/\D/g, '')) || 0)}
                className="search-input w-20"
              />
            </div>
            <span className="text-sm text-gray-500 pb-1">{userDetailFiltered.length.toLocaleString()} results</span>
            {(userDetailDateFrom || userDetailDateTo || userDetailContains.trim() || userDetailMinWords > 0) && (
              <button
                onClick={() => { setUserDetailDateFrom(''); setUserDetailDateTo(''); setUserDetailContains(''); setUserDetailMinWords(0) }}
                className="text-xs text-gray-400 hover:text-gray-700 pb-1 flex items-center gap-1"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                Clear all
              </button>
            )}
          </div>

          {/* Phase date shortcuts */}
          {(() => {
            type PhaseKey = '1' | '2' | '3' | '3a' | '3b' | '3c' | '3d'
            const activePhase: PhaseKey | null =
              userDetailDateFrom === '2023-04-01' && userDetailDateTo === '2023-07-18' ? '1' :
              userDetailDateFrom === '2023-07-19' && userDetailDateTo === '2023-09-05' ? '2' :
              userDetailDateFrom === '2023-09-06' && userDetailDateTo === '' ? '3' :
              userDetailDateFrom === '2023-09-06' && userDetailDateTo === '2023-12-18' ? '3a' :
              userDetailDateFrom === '2023-12-18' && userDetailDateTo === '2024-03-17' ? '3b' :
              userDetailDateFrom === '2024-03-17' && userDetailDateTo === '2024-05-16' ? '3c' :
              userDetailDateFrom === '2024-05-17' && userDetailDateTo === '' ? '3d' : null
            const applyPhase = (p: PhaseKey) => {
              if (activePhase === p) { setUserDetailDateFrom(''); setUserDetailDateTo(''); return }
              if (p === '1')  { setUserDetailDateFrom('2023-04-01'); setUserDetailDateTo('2023-07-18') }
              else if (p === '2')  { setUserDetailDateFrom('2023-07-19'); setUserDetailDateTo('2023-09-05') }
              else if (p === '3')  { setUserDetailDateFrom('2023-09-06'); setUserDetailDateTo('') }
              else if (p === '3a') { setUserDetailDateFrom('2023-09-06'); setUserDetailDateTo('2023-12-18') }
              else if (p === '3b') { setUserDetailDateFrom('2023-12-18'); setUserDetailDateTo('2024-03-17') }
              else if (p === '3c') { setUserDetailDateFrom('2024-03-17'); setUserDetailDateTo('2024-05-16') }
              else if (p === '3d') { setUserDetailDateFrom('2024-05-17'); setUserDetailDateTo('') }
            }
            return (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="filter-label self-center shrink-0">Phase</span>
                {([
                  { key: '1',  label: 'Phase 1 — Capability Surfacing',  dates: 'Apr–18 Jul 2023',        cls: ['border-blue-400 bg-blue-100 text-blue-800',   'border-blue-300 text-blue-700 hover:bg-blue-50']   },
                  { key: '2',  label: 'Phase 2 — Enclosure & Scrutiny',  dates: '19 Jul–5 Sep 2023',      cls: ['border-amber-400 bg-amber-100 text-amber-800', 'border-amber-300 text-amber-700 hover:bg-amber-50'] },
                  { key: '3',  label: 'Phase 3 — Commercialization',     dates: 'Sep 2023 onward',        cls: ['border-emerald-400 bg-emerald-100 text-emerald-800', 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'] },
                  { key: '3a', label: 'Phase 3A — Early Commercialization', dates: '6 Sep–18 Dec 2023',   cls: ['border-violet-400 bg-violet-100 text-violet-800', 'border-violet-300 text-violet-700 hover:bg-violet-50'] },
                  { key: '3b', label: 'Phase 3B — Early Wide Adoption',  dates: '18 Dec 2023–17 Mar 2024', cls: ['border-sky-400 bg-sky-100 text-sky-800',       'border-sky-300 text-sky-700 hover:bg-sky-50']     },
                  { key: '3c', label: 'Phase 3C — Pre-Litigation',       dates: '17 Mar–16 May 2024',     cls: ['border-orange-400 bg-orange-100 text-orange-800', 'border-orange-300 text-orange-700 hover:bg-orange-50'] },
                  { key: '3d', label: 'Phase 3D — Warning & Lawsuit',    dates: '17 May 2024 onward',     cls: ['border-rose-400 bg-rose-100 text-rose-800',   'border-rose-300 text-rose-700 hover:bg-rose-50']   },
                ] as { key: PhaseKey; label: string; dates: string; cls: [string, string] }[]).map(({ key, label, dates, cls }) => (
                  <button
                    key={key}
                    onClick={() => applyPhase(key)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors font-medium ${activePhase === key ? cls[0] + ' font-semibold' : cls[1]}`}
                  >
                    {label} <span className="opacity-60 ml-1">{dates}</span>
                  </button>
                ))}
              </div>
            )
          })()}

          <div className="mt-3 pt-3 border-t flex flex-wrap gap-x-4 gap-y-2 items-center text-sm text-gray-700">
            <span className="font-semibold text-gray-800">CONTEXT WINDOW</span>
            <label className="flex items-center gap-1.5">
              <span>Before</span>
              <input type="text" inputMode="numeric" value={String(userDetailCtxBefore)}
                onChange={e => setUserDetailCtxBefore(parseInt(e.target.value.replace(/\D/g, '')) || 0)}
                className="w-14 border border-gray-400 px-2 py-1 text-sm text-center text-gray-900" />
            </label>
            <label className="flex items-center gap-1.5">
              <span>After</span>
              <input type="text" inputMode="numeric" value={String(userDetailCtxAfter)}
                onChange={e => setUserDetailCtxAfter(parseInt(e.target.value.replace(/\D/g, '')) || 0)}
                className="w-14 border border-gray-400 px-2 py-1 text-sm text-center text-gray-900" />
            </label>
            <span className="text-xs text-gray-500">msgs · click "Show context" on any message</span>
          </div>
        </div>

        {/* User Analysis */}
        <div className="bg-white rounded-2xl shadow overflow-hidden">
          {/* Section header with tab switcher */}
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <span className="text-sm font-semibold text-gray-800">User Analysis</span>
            </div>
            <div className="flex flex-wrap rounded-lg overflow-hidden border border-gray-200 text-[11px] font-semibold">
              <button
                onClick={() => setUserAnalysisTab('dropout')}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors ${
                  userAnalysisTab === 'dropout' ? 'bg-rose-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Phase Summary
              </button>
              <button
                onClick={() => setUserAnalysisTab('topics')}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors border-l border-gray-200 ${
                  userAnalysisTab === 'topics' ? 'bg-violet-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                BERTopic
              </button>
              <button
                onClick={() => setUserAnalysisTab('emotion')}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors border-l border-gray-200 ${
                  userAnalysisTab === 'emotion' ? 'bg-amber-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Emotion
              </button>
              <button
                onClick={() => setUserAnalysisTab('timeline')}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors border-l border-gray-200 ${
                  userAnalysisTab === 'timeline' ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
                Timeline
              </button>
              <button
                onClick={() => setUserAnalysisTab('strategy')}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors border-l border-gray-200 ${
                  userAnalysisTab === 'strategy' ? 'bg-sky-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
                Reactions
              </button>
              <button
                onClick={() => {
                  setUserAnalysisTab('persona')
                  if (personaSummary.length === 0 && !personaSummaryLoading) {
                    setPersonaSummaryLoading(true)
                    apiFetch<typeof personaSummary>('/persona/phase-summary?method=archetype')
                      .then(d => setPersonaSummary(d))
                      .catch(() => {})
                      .finally(() => setPersonaSummaryLoading(false))
                  }
                }}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors border-l border-gray-200 ${
                  userAnalysisTab === 'persona' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Archetype
              </button>
              <button
                onClick={() => setUserAnalysisTab('summary')}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors border-l border-gray-200 ${
                  userAnalysisTab === 'summary' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                LLM Summary
              </button>
            </div>
          </div>

          {userAnalysisTab === 'topics' && (
            <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-3">
              {!userMsgsLoading && userDetailFiltered.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">No messages in this phase.</p>
              ) : topicsDbLoading && !userTopicsResult ? (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <svg className="w-3.5 h-3.5 animate-spin text-violet-400 shrink-0" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Loading saved topics from database…
                </div>
              ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {!userTopicsResult ? (
                  <button onClick={() => runUserTopics('all')} disabled={userTopicsLoading} className="search-btn">
                    {userTopicsLoading ? 'Analysing…' : 'Analyze Topics'}
                  </button>
                ) : (
                  <>
                    <button onClick={() => runUserTopics('all')} disabled={userTopicsLoading} className="search-btn">
                      {userTopicsLoading ? 'Analysing…' : 'Reanalyze All'}
                    </button>
                    {topicsRemainingCount > 0 && (
                      <button
                        onClick={() => runUserTopics('remaining')}
                        disabled={userTopicsLoading}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100 transition-colors disabled:opacity-50"
                      >
                        Reanalyze Remaining ({topicsRemainingCount.toLocaleString()})
                      </button>
                    )}
                  </>
                )}
                {userTopicsResult && (
                  <span className="text-xs text-gray-400">
                    {userTopicsResult.filtered_docs.toLocaleString()} of {userTopicsResult.total_docs.toLocaleString()} msgs
                    {userTopicsResult.warning ? ' · keyword fallback' : ' · BERTopic'}
                    {userTopicsResult.date_from || userTopicsResult.date_to ? (
                      <span className="ml-1 text-amber-500" title="Topics from a different date window than your current filter">
                        · from {userTopicsResult.date_from || '—'} → {userTopicsResult.date_to || '—'}
                      </span>
                    ) : null}
                  </span>
                )}
              </div>
              )}

              {userDetailFiltered.length > 0 && userTopicsSteps.length > 0 && (
                <div className={`rounded-xl border px-3 py-2.5 space-y-1.5 transition-colors ${
                  userTopicsLoading ? 'bg-violet-50 border-violet-200' : 'bg-gray-50 border-gray-200'
                }`}>
                  <p className={`text-[11px] font-semibold uppercase tracking-wide mb-1.5 ${
                    userTopicsLoading ? 'text-violet-500' : 'text-gray-400'
                  }`}>Analysis pipeline</p>
                  {userTopicsSteps.map((step) => (
                    <div key={step.stage} className="flex items-center gap-2">
                      {step.status === 'running' && (
                        <svg className="w-3.5 h-3.5 animate-spin text-violet-500 shrink-0" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                      )}
                      {step.status === 'done' && (
                        <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      {step.status === 'pending' && (
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 shrink-0" />
                      )}
                      {step.status === 'error' && (
                        <svg className="w-3.5 h-3.5 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                      <span className={`text-xs leading-tight ${
                        step.status === 'done'    ? 'text-gray-400' :
                        step.status === 'running' ? 'text-violet-700 font-medium' :
                        step.status === 'error'   ? 'text-red-500' :
                        'text-gray-400'
                      }`}>{step.message}</span>
                    </div>
                  ))}
                </div>
              )}

              {userDetailFiltered.length > 0 && userTopicsResult && userTopicsResult.topics.length === 0 && !userTopicsLoading && (
                <p className="text-sm text-gray-400">No topics identified — not enough message content.</p>
              )}

              {userDetailFiltered.length > 0 && userTopicsResult && userTopicsResult.topics.length > 0 && (
                <div className="space-y-2">
                  {userTopicsResult.topics.map((topic) => {
                    const pct = userTopicsResult.filtered_docs > 0
                      ? Math.round((topic.message_count / userTopicsResult.filtered_docs) * 100)
                      : 0
                    const colors = [
                      'bg-violet-100 border-violet-200',
                      'bg-indigo-100 border-indigo-200',
                      'bg-blue-100 border-blue-200',
                      'bg-cyan-100 border-cyan-200',
                      'bg-teal-100 border-teal-200',
                      'bg-emerald-100 border-emerald-200',
                      'bg-amber-100 border-amber-200',
                      'bg-orange-100 border-orange-200',
                      'bg-rose-100 border-rose-200',
                      'bg-gray-100 border-gray-200',
                    ]
                    const barColors = [
                      'bg-violet-400', 'bg-indigo-400', 'bg-blue-400', 'bg-cyan-400',
                      'bg-teal-400', 'bg-emerald-400', 'bg-amber-400', 'bg-orange-400',
                      'bg-rose-400', 'bg-gray-400',
                    ]
                    const colorIdx = topic.id % colors.length
                    const samplesOpen = expandedTopicSamples.has(topic.id)
                    const hasSamples = topic.representative_docs && topic.representative_docs.length > 0
                    const isEditing = editingTopicId === topic.id
                    const isRelabeling = relabelingTopicId === topic.id
                    const isOutlier = topic.id === -1
                    return (
                      <div key={topic.id} className={`rounded-xl border px-3 py-2.5 ${colors[colorIdx]}`}>
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className="text-[10px] font-bold text-gray-400 uppercase w-6 shrink-0">#{topic.id}</span>
                            {isEditing ? (
                              <input
                                type="text"
                                autoFocus
                                value={editingLabelValue}
                                onChange={e => setEditingLabelValue(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') saveTopicLabel(topic.id, editingLabelValue)
                                  if (e.key === 'Escape') { setEditingTopicId(null); setEditingLabelValue('') }
                                }}
                                className="text-sm font-semibold text-gray-800 bg-white/90 border border-violet-300 rounded px-2 py-0.5 flex-1 min-w-0 focus:outline-none focus:ring-1 focus:ring-violet-400"
                              />
                            ) : (
                              <span className="text-sm font-semibold text-gray-800 truncate">{topic.label}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {!isOutlier && (
                              isEditing ? (
                                <>
                                  <button
                                    onClick={() => saveTopicLabel(topic.id, editingLabelValue)}
                                    title="Save (Enter)"
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 font-semibold"
                                  >✓</button>
                                  <button
                                    onClick={() => { setEditingTopicId(null); setEditingLabelValue('') }}
                                    title="Cancel (Esc)"
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 font-semibold"
                                  >✕</button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => { setEditingTopicId(topic.id); setEditingLabelValue(topic.label) }}
                                    title="Edit label manually"
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-white/70 text-gray-600 hover:bg-white hover:text-gray-900 border border-white/80"
                                  >✏️</button>
                                  <button
                                    disabled={isRelabeling}
                                    onClick={() => relabelTopicWithAI(topic.id)}
                                    title="Regenerate label with GPT-4o-mini"
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-white/70 text-violet-600 hover:bg-white hover:text-violet-800 border border-white/80 disabled:opacity-50"
                                  >{isRelabeling ? '⏳' : '🤖'}</button>
                                </>
                              )
                            )}
                            <span className="text-xs text-gray-500">{topic.message_count.toLocaleString()} msgs · {pct}%</span>
                          </div>
                        </div>
                        {/* Proportion bar */}
                        <div className="w-full h-1.5 bg-white/60 rounded-full mb-2">
                          <div className={`h-1.5 rounded-full ${barColors[colorIdx]}`} style={{ width: `${Math.max(pct, 1)}%` }} />
                        </div>
                        {/* Keywords */}
                        <div className="flex flex-wrap gap-1 mb-2">
                          {topic.keywords.map((kw) => (
                            <span key={kw} className="text-[11px] px-2 py-0.5 rounded-full bg-white/70 text-gray-700 font-medium border border-white/80">
                              {kw}
                            </span>
                          ))}
                        </div>
                        {/* Sample messages toggle + view all */}
                        <div className="flex items-center gap-3 flex-wrap">
                          {hasSamples && (
                            <button
                              onClick={() => setExpandedTopicSamples(prev => {
                                const next = new Set(prev)
                                next.has(topic.id) ? next.delete(topic.id) : next.add(topic.id)
                                return next
                              })}
                              className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 transition-colors"
                            >
                              <svg className={`w-3 h-3 transition-transform ${samplesOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                              {samplesOpen ? 'Hide' : 'Show'} samples ({topic.representative_docs!.length})
                            </button>
                          )}
                          {topicMessages.has(topic.id) && (
                            <button
                              onClick={() => setTopicModalId(topic.id)}
                              className="flex items-center gap-1 text-[11px] text-violet-600 hover:text-violet-800 font-medium transition-colors"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                              </svg>
                              View all {topicMessages.get(topic.id)!.length.toLocaleString()} messages
                            </button>
                          )}
                        </div>
                        {hasSamples && samplesOpen && (
                          <div className="mt-2 max-h-72 overflow-y-auto space-y-1.5 pr-1">
                            {topic.representative_docs!.map((doc, di) => (
                              <div key={di} className="text-[11px] text-gray-700 bg-white/60 rounded-lg px-2.5 py-1.5 border border-white/80 leading-relaxed">
                                <span className="text-gray-400 font-medium mr-1.5">#{di + 1}</span>
                                {doc}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

        {/* Topic messages modal */}
        {topicModalId !== null && (() => {
          const activeTopic = userTopicsResult?.topics.find(t => t.id === topicModalId)
          const activeMessages = topicMessages.get(topicModalId) ?? []
          const colors = [
            'bg-violet-600', 'bg-indigo-600', 'bg-blue-600', 'bg-cyan-600',
            'bg-teal-600', 'bg-emerald-600', 'bg-amber-600', 'bg-orange-600',
            'bg-rose-600', 'bg-gray-600',
          ]
          const accentColor = activeTopic ? colors[Math.abs(activeTopic.id) % colors.length] : 'bg-violet-600'
          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
              onClick={() => setTopicModalId(null)}
            >
              {/* Backdrop */}
              <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
              {/* Panel */}
              <div
                className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
              >
                {/* Header */}
                <div className={`${accentColor} px-5 py-4 flex items-start justify-between gap-3`}>
                  <div>
                    <p className="text-white/70 text-[11px] font-medium uppercase tracking-wide mb-0.5">
                      {topicModalId === -1 ? 'Outliers / Miscellaneous' : `Topic #${topicModalId}`}
                    </p>
                    <h3 className="text-white font-semibold text-base leading-snug">
                      {activeTopic?.label ?? 'Messages'}
                    </h3>
                    {activeTopic?.keywords && activeTopic.keywords.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {activeTopic.keywords.slice(0, 6).map(kw => (
                          <span key={kw} className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/20 text-white font-medium">
                            {kw}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setTopicModalId(null)}
                    className="text-white/80 hover:text-white transition-colors shrink-0 mt-0.5"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {/* Count bar */}
                <div className="px-5 py-2 border-b border-gray-100 bg-gray-50">
                  <span className="text-xs text-gray-500">
                    {activeMessages.length.toLocaleString()} message{activeMessages.length !== 1 ? 's' : ''}
                  </span>
                </div>
                {/* Message list */}
                <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
                  {activeMessages.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-10">No messages found.</p>
                  ) : (
                    activeMessages.map((msg, i) => (
                      <TopicMsgRow
                        key={msg.id ?? i}
                        msg={msg}
                        isBookmarked={bookmarkedIds.has(msg.id)}
                        onBookmarkToggle={handleBookmarkToggle}
                        ctxBefore={userDetailCtxBefore}
                        ctxAfter={userDetailCtxAfter}
                      />
                    ))
                  )}
                </div>
              </div>
            </div>
          )
        })()}

        {/* Emotion messages modal */}
        {emotionMsgFilter !== null && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            onClick={() => setEmotionMsgFilter(null)}
          >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div
              className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div
                className="px-5 py-4 flex items-start justify-between gap-3"
                style={{
                  background: emotionMsgFilter.type === 'emotion'
                    ? emotionSentimentColor(emotionMsgFilter.label)
                    : emotionMsgFilter.label === 'positive' ? '#10b981'
                    : emotionMsgFilter.label === 'negative' ? '#f43f5e'
                    : '#9ca3af'
                }}
              >
                <div>
                  <p className="text-white/70 text-[11px] font-medium uppercase tracking-wide mb-0.5">
                    {emotionMsgFilter.type === 'emotion' ? 'Emotion' : `Sentiment${emotionMsgFilter.period ? ` · ${emotionMsgFilter.period}` : ''}`}
                  </p>
                  <h3 className="text-white font-semibold text-base leading-snug capitalize">
                    {emotionMsgFilter.label}
                  </h3>
                </div>
                <button
                  onClick={() => setEmotionMsgFilter(null)}
                  className="text-white/80 hover:text-white transition-colors shrink-0 mt-0.5"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* Count bar */}
              <div className="px-5 py-2 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  {emotionFilteredMsgs.length.toLocaleString()} message{emotionFilteredMsgs.length !== 1 ? 's' : ''}
                  {emotionMsgFilter.type === 'emotion'
                    ? ` where "${emotionMsgFilter.label}" appears`
                    : ` with ${emotionMsgFilter.label} sentiment${emotionMsgFilter.period ? ` in ${emotionMsgFilter.period}` : ''}`}
                </span>
                <span className="text-xs text-gray-400">newest first</span>
              </div>
              {/* Message list */}
              <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
                {emotionFilteredMsgs.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-10">No messages found.</p>
                ) : (
                  emotionFilteredMsgs.map((msg, i) => {
                    const emotionData = userEmotionResult?.per_message.find(p => p.msg_uuid === msg.msg_uuid)
                    const topEmotion = emotionData?.top_emotions[0]
                    return (
                      <div key={msg.id ?? i} className="px-5 py-3 hover:bg-gray-50 transition-colors">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-[11px] font-semibold" style={{ color: getUserColor(msg.username)[1] }}>
                            {msg.username}
                          </span>
                          <span className="text-[10px] text-gray-400">{msg.date?.slice(0, 19).replace('T', ' ')}</span>
                          {topEmotion && (
                            <span
                              className="text-[9px] font-bold px-1.5 py-0.5 rounded-full text-white"
                              style={{ backgroundColor: emotionSentimentColor(topEmotion.label) }}
                            >
                              {topEmotion.label} {Math.round(topEmotion.score * 100)}%
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
                          {msg.content}
                        </p>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        )}

          {userAnalysisTab === 'persona' && (() => {
            const PERSONA_COLORS: Record<string, string> = {
              'Suno Team':     'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300',
              'Contributor':   'bg-blue-100 text-blue-800 border-blue-300',
              'Help-Seeker':   'bg-amber-100 text-amber-800 border-amber-300',
              'Evangelist':    'bg-emerald-100 text-emerald-800 border-emerald-300',
              'Scrutinizer':   'bg-rose-100 text-rose-800 border-rose-300',
              'Explorer':      'bg-violet-100 text-violet-800 border-violet-300',
              'Uncategorized': 'bg-slate-100 text-slate-600 border-slate-300',
            }
            const PersonaChip = ({ persona, secondary }: { persona: string; secondary?: boolean }) => (
              <span className={`inline-block text-[9px] font-semibold px-1.5 py-0.5 rounded border ${PERSONA_COLORS[persona] ?? 'bg-gray-100 text-gray-600 border-gray-300'} ${secondary ? 'opacity-70' : ''}`}>
                {persona}
              </span>
            )

            // This user's archetype across phases
            const hasAnyPersona = Object.values(userPersonas).some(p => p && p.persona)

            // Aggregate summary — single method now ("archetype").
            // Tolerant of legacy rows (rule_based/llm); they're folded in for backwards compat.
            const summaryByPhase: Record<string, Record<string, number>> = {}
            for (const row of personaSummary) {
              if (!summaryByPhase[row.phase]) summaryByPhase[row.phase] = {}
              summaryByPhase[row.phase][row.persona] = (summaryByPhase[row.phase][row.persona] ?? 0) + row.count
            }

            return (
              <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-5">
                {/* This user's archetypes */}
                <div>
                  <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">This User's Archetype Per Phase</p>
                  {!hasAnyPersona ? (
                    <p className="text-[11px] text-gray-400">
                      No archetypes computed yet. Go to <button onClick={() => { setUserAnalysisTab('dropout'); setDropoutSubTab('phases') }}
                        className="text-indigo-600 hover:underline">Dropout → Per Phase</button> and click ↻ Recompute, or use the batch button in the result table.
                    </p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-gray-200">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="bg-gray-50 border-b border-gray-200">
                            <th className="text-left px-3 py-2 font-semibold text-gray-600">Phase</th>
                            <th className="text-center px-3 py-2 font-semibold text-indigo-600">Primary Archetype</th>
                            <th className="text-center px-3 py-2 font-semibold text-gray-500">Secondary</th>
                          </tr>
                        </thead>
                        <tbody>
                          {PHASE_DEFS.map(def => {
                            const p = userPersonas[def.key]
                            if (!p) return null
                            const conf = Math.round(p.confidence * 100)
                            const sConf = p.secondary_confidence != null ? Math.round(p.secondary_confidence * 100) : null
                            return (
                              <tr key={def.key} className="border-b border-gray-100 hover:bg-gray-50">
                                <td className="px-3 py-2">
                                  <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${def.chipCls}`}>{def.label}</span>
                                </td>
                                <td className="text-center px-3 py-2">
                                  <span title={p.reasoning} className="cursor-help">
                                    <PersonaChip persona={p.persona} /> <span className="text-[9px] text-gray-400">{conf}%</span>
                                  </span>
                                </td>
                                <td className="text-center px-3 py-2">
                                  {p.secondary_persona
                                    ? <span title={p.reasoning} className="cursor-help">
                                        <PersonaChip persona={p.secondary_persona} secondary /> <span className="text-[9px] text-gray-400">{sConf}%</span>
                                      </span>
                                    : <span className="text-[9px] text-gray-300">—</span>}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Phase-level aggregate from DB */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Population Archetype Distribution (All Computed Users)</p>
                    <button
                      onClick={() => {
                        setPersonaSummaryLoading(true)
                        apiFetch<typeof personaSummary>('/persona/phase-summary?method=archetype')
                          .then(d => setPersonaSummary(d))
                          .catch(() => {})
                          .finally(() => setPersonaSummaryLoading(false))
                      }}
                      className="text-[10px] px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors"
                    >↻ Refresh</button>
                  </div>

                  {personaSummaryLoading ? (
                    <div className="flex items-center gap-2 py-4">
                      <div className="animate-spin w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full" />
                      <p className="text-[11px] text-gray-400">Loading…</p>
                    </div>
                  ) : personaSummary.length === 0 ? (
                    <p className="text-[11px] text-gray-400 py-2">No archetypes computed yet. Run the Archetype batch button in the user result table.</p>
                  ) : (() => {
                    const ALL_PERSONAS = [
                      'Contributor', 'Explorer', 'Help-Seeker',
                      'Evangelist', 'Scrutinizer', 'Suno Team', 'Uncategorized',
                    ]
                    const phases = PHASE_DEFS.filter(def =>
                      personaSummary.some(r => r.phase === def.key)
                    )
                    if (phases.length === 0) return (
                      <p className="text-[11px] text-gray-400 py-2">No archetype data yet.</p>
                    )
                    return (
                      <div className="overflow-x-auto rounded-xl border border-gray-200">
                        <table className="w-full text-xs border-collapse">
                          <thead>
                            <tr className="bg-gray-50 border-b border-gray-200">
                              <th className="text-left px-3 py-2 font-semibold text-gray-600">Phase</th>
                              {ALL_PERSONAS.map(p => (
                                <th key={p} className="text-center px-2 py-2 font-semibold text-gray-500 text-[9px] max-w-[80px] whitespace-nowrap">{p}</th>
                              ))}
                              <th className="text-right px-3 py-2 font-semibold text-gray-400 text-[9px]">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {phases.map(def => {
                              const row = summaryByPhase[def.key] ?? {}
                              const total = Object.values(row).reduce((s, c) => s + c, 0)
                              return (
                                <tr key={def.key} className="border-b border-gray-100 hover:bg-gray-50">
                                  <td className="px-3 py-2">
                                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${def.chipCls}`}>{def.label}</span>
                                  </td>
                                  {ALL_PERSONAS.map(p => {
                                    const count = row[p] ?? 0
                                    const pct = total > 0 ? Math.round((count / total) * 100) : 0
                                    return (
                                      <td key={p} className="text-center px-2 py-2">
                                        {count > 0 ? (
                                          <div className="flex flex-col items-center gap-0.5">
                                            <span className="text-[11px] font-bold text-gray-800">{count}</span>
                                            <span className="text-[9px] text-gray-400">{pct}%</span>
                                          </div>
                                        ) : <span className="text-[9px] text-gray-200">—</span>}
                                      </td>
                                    )
                                  })}
                                  <td className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500">{total}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )
                  })()}
                </div>
              </div>
            )
          })()}

          {userAnalysisTab === 'summary' && (
            <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">
              {/* Controls row */}
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label className="filter-label">Model</label>
                  <select value={userSumModel} onChange={e => setUserSumModel(e.target.value)} className="search-input text-xs py-1">
                    <optgroup label="GPT-5.4">
                      <option value="gpt-5.4">GPT-5.4</option>
                      <option value="gpt-5.4-mini">GPT-5.4 mini</option>
                      <option value="gpt-5.4-nano">GPT-5.4 nano</option>
                    </optgroup>
                    <optgroup label="GPT-4.1">
                      <option value="gpt-4.1">GPT-4.1</option>
                      <option value="gpt-4.1-mini">GPT-4.1 mini</option>
                    </optgroup>
                    <optgroup label="GPT-4o">
                      <option value="gpt-4o">GPT-4o</option>
                      <option value="gpt-4o-mini">GPT-4o mini</option>
                    </optgroup>
                    <optgroup label="o-series">
                      <option value="o4-mini">o4-mini</option>
                      <option value="o3-mini">o3-mini</option>
                    </optgroup>
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="filter-label">Mode</label>
                  <div className="flex rounded-lg overflow-hidden border border-gray-300 text-xs font-semibold">
                    {(['cluster', 'all'] as const).map(mode => (
                      <button
                        key={mode}
                        onClick={() => setUserSumRetrievalMode(mode)}
                        className={`px-3 py-1.5 transition-colors ${userSumRetrievalMode === mode ? 'bg-indigo-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                      >
                        {mode === 'cluster' ? 'Cluster & Sample' : 'All Messages'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
                  <label className="filter-label">Custom instructions (optional)</label>
                  <textarea
                    value={userSumInstructions}
                    onChange={e => setUserSumInstructions(e.target.value)}
                    rows={2}
                    placeholder="e.g. Focus on feature requests. Highlight recurring concerns."
                    className="search-input w-full resize-none"
                  />
                </div>
                <button
                  onClick={runUserSummary}
                  disabled={userSumLoading || userDetailFiltered.length === 0}
                  className="search-btn self-end"
                >
                  {userSumLoading ? 'Running…' : 'Run Summary'}
                </button>
              </div>
              <p className="text-xs text-gray-500">
                {userSumRetrievalMode === 'cluster'
                  ? 'Groups messages by topic and samples representatives. Best for large sets.'
                  : 'Passes all filtered messages directly to the model. Use for small sets (<100 msgs).'}
                {' '}Each message includes <strong>{userDetailCtxBefore} before</strong> / <strong>{userDetailCtxAfter} after</strong> context.
              </p>

              {/* Result */}
              {userSumLoading && !userSumResult && (
                <p className="text-sm text-gray-400 animate-pulse">Generating summary…</p>
              )}
              {userSumResult && (
                <div className="bg-gray-50 rounded-xl p-4 markdown-body" aria-live="polite">
                  <ReactMarkdown>{userSumResult + (userSumLoading ? ' ▋' : '')}</ReactMarkdown>
                </div>
              )}
              {userSumResult && !userSumLoading && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Follow-up Q&amp;A</h4>
                    {userSumFollowUp.length > 0 && (
                      <button onClick={() => setUserSumFollowUp([])} className="text-xs text-gray-400 hover:text-red-500">Clear Q&amp;A</button>
                    )}
                  </div>
                  <div className="space-y-2 mb-2 max-h-60 overflow-y-auto">
                    {userSumFollowUp.map((h, i) => (
                      <div key={i} className={h.role === 'user' ? 'flex justify-end' : ''}>
                        <div className={`rounded-xl px-3 py-2 text-sm ${h.role === 'user' ? 'bg-indigo-700 text-white max-w-xl' : 'bg-gray-50 border border-gray-200 text-gray-900 markdown-body'}`}>
                          {h.role === 'assistant' ? <ReactMarkdown>{h.content}</ReactMarkdown> : h.content}
                        </div>
                      </div>
                    ))}
                    {userSumFollowUpLoading && <div className="text-xs text-gray-400 animate-pulse">Generating…</div>}
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={userSumFollowUpInput}
                      onChange={e => setUserSumFollowUpInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runUserSumFollowUp() } }}
                      placeholder="Ask a follow-up question… (Enter to submit)"
                      className="search-input flex-1"
                    />
                    <button onClick={runUserSumFollowUp} disabled={userSumFollowUpLoading || !userSumFollowUpInput.trim()} className="search-btn">Ask</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {userAnalysisTab === 'emotion' && (
            <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">
              {!userMsgsLoading && userDetailFiltered.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">No posts in this view.</p>
              ) : (<>
              {/* Run button */}
              <div className="flex items-center gap-2 flex-wrap">
                {!userEmotionResult ? (
                  <button onClick={() => runUserEmotion('all')} disabled={userEmotionLoading || userMsgsLoading} className="search-btn">
                    {userEmotionLoading ? 'Analysing…' : 'Run Analysis'}
                  </button>
                ) : (
                  <>
                    <button onClick={() => runUserEmotion('all')} disabled={userEmotionLoading || userMsgsLoading} className="search-btn">
                      {userEmotionLoading ? 'Analysing…' : 'Reanalyze All'}
                    </button>
                    {emotionRemainingCount > 0 && (
                      <button
                        onClick={() => runUserEmotion('remaining')}
                        disabled={userEmotionLoading}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors disabled:opacity-50"
                      >
                        Reanalyze Remaining ({emotionRemainingCount.toLocaleString()})
                      </button>
                    )}
                  </>
                )}
                {userEmotionResult && !userEmotionLoading && (
                  <span className="text-xs text-gray-400">
                    {userEmotionResult.analyzed_messages.toLocaleString()} of {userEmotionResult.total_messages.toLocaleString()} messages analysed
                  </span>
                )}
              </div>

              {userEmotionLoading && (
                <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                  <svg className="w-4 h-4 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <span>Analyzing emotions across {userDetailFiltered.length.toLocaleString()} messages…</span>
                </div>
              )}

              {userEmotionResult && !userEmotionLoading && userEmotionResult.analyzed_messages > 0 && (
                <>
                  {/* Sentiment ratio bar — click a segment to see all messages in that bucket */}
                  {(() => {
                    const ratio = userEmotionResult.summary.sentiment_ratio
                    const total = userEmotionResult.analyzed_messages
                    const segments = [
                      { key: 'positive' as const, label: 'Positive',  bg: 'bg-emerald-500', hover: 'hover:bg-emerald-400', text: 'text-emerald-600' },
                      { key: 'negative' as const, label: 'Negative',  bg: 'bg-rose-500',    hover: 'hover:bg-rose-400',    text: 'text-rose-500'    },
                      { key: 'neutral'  as const, label: 'Neutral',   bg: 'bg-gray-400',    hover: 'hover:bg-gray-300',    text: 'text-gray-400'    },
                    ]
                    const anyActive = emotionMsgFilter?.type === 'sentiment' && !emotionMsgFilter.period
                    return (
                      <div>
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                          Sentiment Distribution
                          <span className="ml-1.5 normal-case font-normal text-gray-400">— click to view messages</span>
                        </p>
                        <div className="flex rounded-lg overflow-hidden h-8 text-xs font-semibold text-white">
                          {segments.map(({ key, label, bg, hover }) => {
                            const r = ratio[key]
                            if (r === 0) return null
                            const isActive = anyActive && emotionMsgFilter?.label === key
                            const isDimmed = anyActive && !isActive
                            return (
                              <button
                                key={key}
                                style={{ width: `${r * 100}%` }}
                                className={`flex items-center justify-center transition-all ${bg} ${hover} ${
                                  isActive ? 'ring-2 ring-inset ring-white/70' : isDimmed ? 'opacity-40' : ''
                                }`}
                                title={`${Math.round(r * total).toLocaleString()} ${label.toLowerCase()} messages — click to view`}
                                onClick={() => setEmotionMsgFilter(isActive ? null : { type: 'sentiment', label: key })}
                              >
                                {r >= 0.10 ? `${(r * 100).toFixed(0)}%` : ''}
                              </button>
                            )
                          })}
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
                          {segments.map(({ key, label, text }) => {
                            const r = ratio[key]
                            if (r === 0) return null
                            const count = Math.round(r * total)
                            const isActive = anyActive && emotionMsgFilter?.label === key
                            return (
                              <button
                                key={key}
                                onClick={() => setEmotionMsgFilter(isActive ? null : { type: 'sentiment', label: key })}
                                className={`text-xs font-medium ${text} hover:opacity-70 transition-opacity ${isActive ? 'underline underline-offset-2' : ''}`}
                              >
                                ● {label} · {count.toLocaleString()}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })()}

                  {/* Top emotions horizontal bar chart */}
                  {userEmotionResult.summary.top_emotions.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Top Emotions (by message count)</p>
                        <span className="text-[10px] text-gray-400">Click a bar to see messages</span>
                      </div>
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart
                          data={userEmotionResult.summary.top_emotions.slice(0, 8).map(e => ({
                            name: e.label,
                            value: e.score,
                          }))}
                          layout="vertical"
                          margin={{ left: 12, right: 24, top: 4, bottom: 4 }}
                        >
                          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} />
                          <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} />
                          <Tooltip formatter={(v: number) => [v, 'Messages']} />
                          <Bar
                            dataKey="value"
                            radius={[0, 3, 3, 0]}
                            style={{ cursor: 'pointer' }}
                            onClick={(data) => setEmotionMsgFilter({ type: 'emotion', label: String(data.name) })}
                          >
                            {userEmotionResult.summary.top_emotions.slice(0, 8).map((e, idx) => (
                              <Cell
                                key={idx}
                                fill={emotionSentimentColor(e.label)}
                                opacity={
                                  emotionMsgFilter?.type === 'emotion' && emotionMsgFilter.label !== e.label
                                    ? 0.35
                                    : 1
                                }
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                      {emotionMsgFilter?.type === 'emotion' && (
                        <button
                          onClick={() => setEmotionMsgFilter(null)}
                          className="text-[10px] text-gray-400 hover:text-gray-700 mt-1 flex items-center gap-1"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          Clear filter
                        </button>
                      )}
                    </div>
                  )}

                  {/* Monthly sentiment timeline */}
                  {userEmotionResult.summary.timeline.length > 1 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Sentiment Over Time</p>
                        <span className="text-[10px] text-gray-400">Click a bar segment to see messages</span>
                      </div>
                      <ResponsiveContainer width="100%" height={160}>
                        <BarChart
                          data={userEmotionResult.summary.timeline}
                          margin={{ left: 0, right: 8, top: 4, bottom: 24 }}
                        >
                          <XAxis dataKey="period" tick={{ fontSize: 9 }} angle={-45} textAnchor="end" interval={0} />
                          <YAxis tick={{ fontSize: 10 }} />
                          <Tooltip />
                          <Bar
                            dataKey="positive" stackId="s" fill="#10b981" name="Positive"
                            style={{ cursor: 'pointer' }}
                            opacity={emotionMsgFilter?.type === 'sentiment' && emotionMsgFilter.label !== 'positive' ? 0.35 : 1}
                            onClick={(data) => setEmotionMsgFilter(
                              emotionMsgFilter?.type === 'sentiment' && emotionMsgFilter.label === 'positive' && emotionMsgFilter.period === String(data.period)
                                ? null
                                : { type: 'sentiment', label: 'positive', period: String(data.period) }
                            )}
                          />
                          <Bar
                            dataKey="negative" stackId="s" fill="#f43f5e" name="Negative"
                            style={{ cursor: 'pointer' }}
                            opacity={emotionMsgFilter?.type === 'sentiment' && emotionMsgFilter.label !== 'negative' ? 0.35 : 1}
                            onClick={(data) => setEmotionMsgFilter(
                              emotionMsgFilter?.type === 'sentiment' && emotionMsgFilter.label === 'negative' && emotionMsgFilter.period === String(data.period)
                                ? null
                                : { type: 'sentiment', label: 'negative', period: String(data.period) }
                            )}
                          />
                          <Bar
                            dataKey="neutral" stackId="s" fill="#9ca3af" name="Neutral"
                            style={{ cursor: 'pointer' }}
                            opacity={emotionMsgFilter?.type === 'sentiment' && emotionMsgFilter.label !== 'neutral' ? 0.35 : 1}
                            onClick={(data) => setEmotionMsgFilter(
                              emotionMsgFilter?.type === 'sentiment' && emotionMsgFilter.label === 'neutral' && emotionMsgFilter.period === String(data.period)
                                ? null
                                : { type: 'sentiment', label: 'neutral', period: String(data.period) }
                            )}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                      {emotionMsgFilter?.type === 'sentiment' && (
                        <button
                          onClick={() => setEmotionMsgFilter(null)}
                          className="text-[10px] text-gray-400 hover:text-gray-700 mt-1 flex items-center gap-1"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          Clear filter
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}

              {userEmotionResult && !userEmotionLoading && userEmotionResult.analyzed_messages === 0 && (
                <p className="text-sm text-gray-400 text-center py-6">No messages with enough content for emotion analysis.</p>
              )}
              </>)}
            </div>
          )}

          {userAnalysisTab === 'timeline' && (
            <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-5">
              {/* Guide banners */}
              {!userTopicsResult && !userEmotionResult && (
                <p className="text-sm text-gray-400 text-center py-6">
                  Run <strong className="text-violet-600">BERTopic</strong> and <strong className="text-amber-500">Emotion Analysis</strong> first to build the timeline.
                </p>
              )}
              {!userTopicsResult && userEmotionResult && (
                <div className="text-xs text-violet-700 bg-violet-50 rounded-lg px-3 py-2">
                  Run <strong>BERTopic</strong> to add the topic dimension.
                </div>
              )}
              {userTopicsResult && !userEmotionResult && (
                <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                  Run <strong>Emotion Analysis</strong> to colour the heatmap by sentiment.
                </div>
              )}

              {userTimeline && (
                <>
                  {/* ── Topic Activity Stream ── */}
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                        Topic Activity Over Time
                      </p>
                      {selectedTopicIds !== null && (
                        <button
                          onClick={() => setSelectedTopicIds(null)}
                          className="text-[10px] text-indigo-600 hover:text-indigo-800 font-medium"
                        >
                          Show all topics
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-gray-400 mb-2">
                      {userTimeline.topicMeta.filter(t => t.id !== -1).length} topics · {userTimeline.periods.length} periods
                      {selectedTopicIds !== null && ` · ${selectedTopicIds.size} selected`}
                      {selectedTopicIds === null && ' · click legend to filter'}
                    </p>
                    <ResponsiveContainer width="100%" height={190}>
                      <AreaChart
                        data={userTimeline.streamData}
                        margin={{ left: 0, right: 8, top: 4, bottom: userTimeline.periods.length > 12 ? 28 : 20 }}
                      >
                        <XAxis
                          dataKey="period"
                          tick={{ fontSize: 9 }}
                          angle={-45}
                          textAnchor="end"
                          interval={userTimeline.periods.length > 24 ? Math.ceil(userTimeline.periods.length / 12) - 1
                            : userTimeline.periods.length > 12 ? 1 : 0}
                        />
                        <YAxis tick={{ fontSize: 10 }} width={24} />
                        <Tooltip
                          formatter={(value: number, name: string) => {
                            const tm = userTimeline.topicMeta.find(t => `t${t.id}` === name)
                            return [value, tm ? (tm.label.length > 28 ? tm.label.slice(0, 26) + '…' : tm.label) : name]
                          }}
                        />
                        {userTimeline.topicMeta.filter(t => t.id !== -1).map(tm => {
                          const visible = selectedTopicIds === null || selectedTopicIds.has(tm.id)
                          if (!visible) return null
                          return (
                            <Area
                              key={tm.id}
                              type="monotone"
                              dataKey={`t${tm.id}`}
                              stackId="1"
                              fill={tm.color}
                              stroke={tm.color}
                              fillOpacity={0.72}
                              strokeWidth={0}
                              name={`t${tm.id}`}
                            />
                          )
                        })}
                      </AreaChart>
                    </ResponsiveContainer>
                    {/* Legend — clickable chips to toggle topics */}
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {userTimeline.topicMeta.filter(t => t.id !== -1).map(tm => {
                        const active = selectedTopicIds === null || selectedTopicIds.has(tm.id)
                        return (
                          <button
                            key={tm.id}
                            onClick={() => {
                              setSelectedTopicIds(prev => {
                                const allIds = userTimeline!.topicMeta.filter(t => t.id !== -1).map(t => t.id)
                                if (prev === null) {
                                  // All visible: uncheck just this one
                                  const next = new Set(allIds)
                                  next.delete(tm.id)
                                  return next
                                }
                                const next = new Set(prev)
                                if (next.has(tm.id)) {
                                  next.delete(tm.id)
                                  return next.size === 0 ? null : next
                                } else {
                                  next.add(tm.id)
                                  return next.size === allIds.length ? null : next
                                }
                              })
                            }}
                            className="text-[10px] px-2 py-0.5 rounded-full font-medium leading-snug transition-opacity"
                            style={{
                              backgroundColor: active ? tm.color : '#d1d5db',
                              color: active ? 'white' : '#6b7280',
                            }}
                            title={`${tm.label} · ${tm.totalCount} messages`}
                          >
                            {tm.label.length > 22 ? tm.label.slice(0, 20) + '…' : tm.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* ── Stance Heatmap ── */}
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                        Stance Heatmap
                      </p>
                      {heatmapCell && (
                        <button
                          onClick={() => setHeatmapCell(null)}
                          className="text-[10px] text-indigo-600 hover:text-indigo-800 font-medium"
                        >
                          Close drill-down
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-gray-400 mb-2">
                      {userTimeline.hasEmotion
                        ? 'Green = positive · Red = negative · Gray = neutral · Darker = more messages · click cell to drill in'
                        : 'Message counts only — run Emotion Analysis for sentiment · click any cell to see messages'}
                    </p>
                    <div className="overflow-x-auto">
                      <table className="border-collapse" style={{ minWidth: `${userTimeline.periods.length * 36 + 140}px` }}>
                        <thead>
                          <tr>
                            <th className="text-left pr-3 pb-1 text-[9px] text-gray-400 font-medium w-36" />
                            {userTimeline.periods.map(p => (
                              <th key={p} className="pb-1 text-center align-bottom" style={{ width: 32 }}>
                                <span
                                  className="text-[8px] text-gray-400 font-normal"
                                  style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', display: 'inline-block' }}
                                >
                                  {p}
                                </span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {userTimeline.topicMeta
                            .filter(tm => selectedTopicIds === null || selectedTopicIds.has(tm.id) || tm.id === -1)
                            .map(tm => (
                            <tr key={tm.id}>
                              <td className="pr-3 py-0.5 max-w-[8.5rem]">
                                <div className="flex items-center gap-1.5">
                                  <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: tm.color }} />
                                  <span className="text-[10px] text-gray-600 font-medium truncate" title={tm.label}>
                                    {tm.label.length > 18 ? tm.label.slice(0, 16) + '…' : tm.label}
                                  </span>
                                </div>
                              </td>
                              {userTimeline.periods.map(period => {
                                const hRow = userTimeline.heatmap.find(r => r.period === period)
                                const cell = hRow?.topics.find(t => t.topicId === tm.id)
                                const { positive = 0, negative = 0, neutral = 0, count = 0 } = cell ?? {}
                                const isSelected = heatmapCell?.topicId === tm.id && heatmapCell?.period === period
                                const bg = isSelected
                                  ? '#6366f1'
                                  : userTimeline.hasEmotion
                                    ? heatmapColor(positive, negative, neutral, userTimeline.maxCount)
                                    : count > 0 ? `rgba(99,102,241,${Math.min(0.15 + (count / userTimeline.maxCount) * 0.75, 0.9).toFixed(2)})` : '#f3f4f6'
                                return (
                                  <td
                                    key={period}
                                    style={{ backgroundColor: bg, width: 32, height: 24 }}
                                    className={`text-center align-middle rounded-sm transition-all ${count > 0 ? 'cursor-pointer hover:ring-2 hover:ring-indigo-400 hover:ring-inset' : 'cursor-default'}`}
                                    title={count > 0
                                      ? `${period} · ${tm.label}\n${count} msg${count !== 1 ? 's' : ''}${userTimeline.hasEmotion ? ` · +${positive} −${negative} ○${neutral}` : ''}\nClick to see messages`
                                      : ''}
                                    onClick={() => {
                                      if (count === 0) return
                                      setHeatmapCell(prev =>
                                        prev?.topicId === tm.id && prev?.period === period ? null : { topicId: tm.id, period }
                                      )
                                    }}
                                  >
                                    {count > 0 && (
                                      <span className="text-white font-semibold" style={{ fontSize: 8 }}>
                                        {count}
                                      </span>
                                    )}
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* ── Heatmap cell drill-down ── */}
                  {heatmapCell && (() => {
                    const cellTopic = userTimeline.topicMeta.find(t => t.id === heatmapCell.topicId)
                    const emotionMap = new Map<string, { sentiment: string; top_emotions: { label: string; score: number }[] }>()
                    if (userEmotionResult) {
                      for (const p of userEmotionResult.per_message) {
                        if (p.msg_uuid) emotionMap.set(p.msg_uuid, { sentiment: p.sentiment, top_emotions: p.top_emotions })
                      }
                    }
                    return (
                      <div className="border border-indigo-200 rounded-xl overflow-hidden">
                        <div className="bg-indigo-600 px-4 py-3 flex items-center justify-between">
                          <div>
                            <p className="text-white font-semibold text-sm">
                              {cellTopic?.label ?? `Topic ${heatmapCell.topicId}`}
                            </p>
                            <p className="text-indigo-200 text-xs">Week of {heatmapCell.period} · {heatmapCellMsgs.length} messages</p>
                          </div>
                          <button onClick={() => setHeatmapCell(null)} className="text-indigo-200 hover:text-white">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        <div className="divide-y divide-gray-100 max-h-64 overflow-y-auto">
                          {heatmapCellMsgs.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-4">No messages found.</p>
                          ) : heatmapCellMsgs.map((m, i) => {
                            const emo = m.msg_uuid ? emotionMap.get(m.msg_uuid) : undefined
                            const sentColor = emo?.sentiment === 'positive' ? 'text-emerald-600 bg-emerald-50'
                              : emo?.sentiment === 'negative' ? 'text-rose-600 bg-rose-50'
                              : 'text-gray-500 bg-gray-100'
                            return (
                              <div key={i} className="px-4 py-2.5">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-[10px] text-gray-400">{m.date?.slice(0, 16).replace('T', ' ')}</span>
                                  {emo && (
                                    <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${sentColor}`}>
                                      {emo.sentiment}
                                    </span>
                                  )}
                                  {emo && emo.top_emotions.slice(0, 2).map(e => (
                                    <span key={e.label} className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                                      {e.label}
                                    </span>
                                  ))}
                                </div>
                                <p className="text-xs text-gray-700 leading-relaxed">{m.content}</p>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })()}
                </>
              )}

              {!userTimeline && userTopicsResult && (
                <p className="text-sm text-gray-400 text-center py-4">Not enough data across multiple time periods.</p>
              )}
            </div>
          )}

          {userAnalysisTab === 'dropout' && (() => {
            // ── Emotion lookup map from current analysis result ───────────────
            const emotionPerMsgMap = new Map<string, { sentiment: 'positive'|'negative'|'neutral'; top_emotions: { label: string; score: number }[] }>()
            if (userEmotionResult) {
              for (const m of userEmotionResult.per_message) {
                emotionPerMsgMap.set(m.msg_uuid, { sentiment: m.sentiment, top_emotions: m.top_emotions })
              }
            }

            // ── Per-phase stats computed from ALL messages (not filtered) ─────
            const allMsgsMaxDate = userMsgs.length > 0
              ? userMsgs.reduce((mx, m) => (m.date && m.date > mx ? m.date : mx), userMsgs[0].date ?? '').slice(0, 10)
              : ''
            const phaseStatuses = PHASE_DEFS.map(def => {
              const filterEnd = def.to || allMsgsMaxDate
              const msgs = userMsgs.filter(m => {
                const d = m.date?.slice(0, 10) ?? ''
                return d >= def.from && (!filterEnd || d <= filterEnd)
              })
              if (msgs.length === 0) return { def, status: 'low' as EngagementLevel, info: null, msgCount: 0 }
              const dates = msgs.map(m => m.date?.slice(0, 10) ?? '').filter(Boolean).sort()
              const firstDate = dates[0]
              const lastDate  = dates[dates.length - 1]
              const weeksActive = new Set(msgs.map(m => m.date ? mondayKey(m.date) : '').filter(Boolean)).size
              const avgWords = msgs.reduce((s, m) => s + m.content.split(/\s+/).filter(Boolean).length, 0) / msgs.length
              const windowDays = Math.max(14, daysBetween(def.from, filterEnd))
              const pctWeeks   = Math.round((weeksActive / (windowDays / 7)) * 100)
              const u: UserInRange = {
                username: selectedUser?.username ?? '',
                total_messages: msgs.length,
                first_date: firstDate,
                last_date: lastDate,
                avg_words: avgWords,
                weeks_active: weeksActive,
                pct_weeks: pctWeeks,
              }
              const info = classifyEngagementSingle(u, def.from, filterEnd)
              return { def, status: info.level, info, msgCount: msgs.length }
            })

            // ── Cross-phase drop-off detection ────────────────────────────────
            // A "drop-off" is: a phase where user was active → next phase where user is transient or absent
            const crossPhaseEvents = phaseStatuses.map((ps, i) => {
              const prev = i > 0 ? phaseStatuses[i - 1] : null
              const isDropOff = prev !== null && prev.msgCount > 0 && (ps.msgCount === 0 || (prev.status === 'high' && ps.status !== 'high') || (prev.status === 'medium' && ps.status === 'low'))
              const isReturn  = prev !== null && ps.msgCount > 0 && ((prev.msgCount === 0 && ps.status !== 'low') || (prev.status === 'low' && (ps.status === 'medium' || ps.status === 'high')) || (prev.status === 'medium' && ps.status === 'high'))
              return { ...ps, isDropOff, isReturn }
            })
            // ── Current-filter stats (existing logic) ─────────────────────────
            const derivedFirstDate = userDetailFiltered.length > 0
              ? userDetailFiltered.reduce((mn, m) => (m.date && m.date < mn ? m.date : mn), userDetailFiltered[0].date ?? '').slice(0, 10)
              : ''
            const derivedLastDate = userDetailFiltered.length > 0
              ? userDetailFiltered.reduce((mx, m) => (m.date && m.date > mx ? m.date : mx), userDetailFiltered[0].date ?? '').slice(0, 10)
              : ''
            const derivedWeeksActive = new Set(
              userDetailFiltered.map(m => m.date ? mondayKey(m.date) : '').filter(Boolean)
            ).size
            const derivedAvgWords = userDetailFiltered.length > 0
              ? userDetailFiltered.reduce((s, m) => s + m.content.split(/\s+/).filter(Boolean).length, 0) / userDetailFiltered.length
              : 0
            const detailFilterStart = userDetailDateFrom || derivedFirstDate || filterStartDate
            const detailFilterEnd   = userDetailDateTo   || derivedLastDate  || filterEndDate
            const detailWindowDays  = (detailFilterStart && detailFilterEnd)
              ? Math.max(14, daysBetween(detailFilterStart, detailFilterEnd))
              : windowDays
            const derivedPctWeeks = detailWindowDays > 0
              ? Math.round((derivedWeeksActive / (detailWindowDays / 7)) * 100)
              : 0
            const derivedUser: UserInRange = {
              username: selectedUser?.username ?? '',
              total_messages: userDetailFiltered.length,
              first_date: derivedFirstDate,
              last_date: derivedLastDate,
              avg_words: derivedAvgWords,
              weeks_active: derivedWeeksActive,
              pct_weeks: derivedPctWeeks,
            }
            const weekCounts: Record<string, number> = {}
            for (const m of userDetailFiltered) {
              if (!m.date) continue
              const key = mondayKey(m.date)
              weekCounts[key] = (weekCounts[key] ?? 0) + 1
            }
            const rangeEndRaw = detailFilterEnd || derivedLastDate
            const firstMsgDate = derivedFirstDate
            const toMonday = (iso: string): Date => {
              const d = new Date(iso)
              const diff = (d.getUTCDay() + 6) % 7
              return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff))
            }
            const weeklyData: { week: string; count: number }[] = []
            if (firstMsgDate && rangeEndRaw) {
              let cur = toMonday(firstMsgDate)
              const end = toMonday(rangeEndRaw)
              while (cur <= end) {
                const key = cur.toISOString().slice(0, 10)
                weeklyData.push({ week: key, count: weekCounts[key] ?? 0 })
                cur = new Date(cur.getTime() + 7 * 86400000)
              }
            }
            const dropInfo = (selectedUser && detailFilterEnd)
              ? classifyEngagementSingle(derivedUser, detailFilterStart, detailFilterEnd)
              : dropoutMap.get(selectedUser?.username ?? '')
            const sc = dropInfo ? ENGAGEMENT_COLORS[dropInfo.level] : ENGAGEMENT_COLORS.low
            const dropoutSilenceDays = deriveThresholds(detailWindowDays).silenceDays
            const windowStart = derivedLastDate
              ? new Date(new Date(derivedLastDate).getTime() - dropoutSilenceDays * 86400000).toISOString().slice(0, 10)
              : ''
            const preDropoutMsgs = windowStart
              ? userDetailFiltered.filter(m => (m.date?.slice(0, 10) ?? '') >= windowStart)
              : []
            const lastMsgs = [...userDetailFiltered]
              .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
              .slice(0, 10)
            const preDropoutSentiment = userEmotionResult
              ? (() => {
                  const preUuids = new Set(preDropoutMsgs.map(m => m.msg_uuid).filter(Boolean))
                  const counts = { positive: 0, negative: 0, neutral: 0 }
                  for (const p of userEmotionResult.per_message) {
                    if (preUuids.has(p.msg_uuid)) counts[p.sentiment]++
                  }
                  return counts
                })()
              : null
            const preDropoutTopics = (userTopicsResult && preDropoutMsgs.length > 0)
              ? (() => {
                  const assignments = userTopicsResult.doc_assignments
                  if (!assignments) return null
                  const tCounts: Record<number, number> = {}
                  for (const m of preDropoutMsgs) {
                    const tid = m.msg_uuid ? assignments[m.msg_uuid] : undefined
                    if (tid !== undefined) tCounts[tid] = (tCounts[tid] || 0) + 1
                  }
                  return Object.entries(tCounts).sort(([,a],[,b]) => b-a).slice(0,5)
                    .map(([tid, count]) => {
                      const id = Number(tid)
                      const topic = userTopicsResult.topics.find(t => t.id === id)
                      return { id, label: id === -1 ? 'Outliers' : (topic?.label ?? `Topic ${id}`), count }
                    })
                })()
              : null

            // ── status badge helper ───────────────────────────────────────────
            const StatusBadge = ({ status }: { status: EngagementLevel | null }) => {
              if (!status) return <span className="text-[10px] px-2 py-0.5 rounded-full border bg-gray-100 text-gray-400 border-gray-300">No data</span>
              const cls = {
                high:   'bg-emerald-100 text-emerald-700 border-emerald-300',
                medium: 'bg-sky-100 text-sky-700 border-sky-300',
                low:    'bg-amber-100 text-amber-700 border-amber-300',
              }[status]
              const label = { high: 'High Eng.', medium: 'Med Eng.', low: 'Low Eng.' }[status] ?? status
              return <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${cls}`}>{label}</span>
            }

            return (
              <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">
                {/* Sub-tab selector */}
                <div className="flex rounded-lg overflow-hidden border border-gray-200 text-[11px] font-semibold w-fit">
                  {([
                    ['cross',   'Across All Phases'],
                    ['phases',  'Per Phase'],
                    ['current', 'Current Filter'],
                  ] as [typeof dropoutSubTab, string][]).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setDropoutSubTab(key)}
                      className={`px-3 py-1.5 transition-colors border-r border-gray-200 last:border-0 ${
                        dropoutSubTab === key ? 'bg-rose-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* ── ACROSS ALL PHASES ──────────────────────────────────────── */}
                {dropoutSubTab === 'cross' && (
                  <div className="space-y-4">
                    {/* Drop-off summary banner — exhaustive analysis */}
                    {(() => {
                      const phasesWithData = phaseStatuses.filter(p => p.msgCount > 0)
                      const noData = phasesWithData.length === 0

                      const firstDataIdx = phaseStatuses.findIndex(p => p.msgCount > 0)
                      const lastDataIdx  = phaseStatuses.reduce((mx, p, i) => p.msgCount > 0 ? i : mx, -1)

                      const activePhases    = phasesWithData.filter(p => p.status === 'high')
                      const transientPhases = phasesWithData.filter(p => p.status === 'low' || p.status === 'medium')
                      const neverActive            = phasesWithData.length > 0 && activePhases.length === 0
                      const allParticipatedActive  = phasesWithData.length > 0 && transientPhases.length === 0

                      // Phases absent within the active window (gaps between first and last with data)
                      const midGaps = firstDataIdx >= 0 && lastDataIdx > firstDataIdx
                        ? phaseStatuses.slice(firstDataIdx + 1, lastDataIdx).filter(p => p.msgCount === 0)
                        : []
                      // Phases after last activity
                      const trailingAbsent = lastDataIdx >= 0 ? phaseStatuses.slice(lastDataIdx + 1) : []

                      const joinedPhase  = firstDataIdx >= 0 ? phaseStatuses[firstDataIdx].def.label : null
                      const lastActivePh = phasesWithData[phasesWithData.length - 1]
                      const finalStatus  = lastActivePh?.status ?? null
                      const preJoinCount = firstDataIdx > 0 ? firstDataIdx : 0
                      const participatedStr = `${phasesWithData.length}/${phaseStatuses.length}`

                      // Transitions within the active window only (skips pre-join phases)
                      const transitions: { from: string; to: string; fromStatus: string; toStatus: string; type: 'dropoff' | 'return' }[] = []
                      if (firstDataIdx >= 0) {
                        for (let i = firstDataIdx + 1; i <= lastDataIdx; i++) {
                          const prev = phaseStatuses[i - 1]
                          const cur  = phaseStatuses[i]
                          if (!prev || !cur) continue
                          const ps = prev.msgCount > 0 ? prev.status : 'absent'
                          const cs = cur.msgCount  > 0 ? cur.status  : 'absent'
                          if (ps === cs) continue
                          if (ps === 'high' && (cs === 'medium' || cs === 'low' || cs === 'absent')) {
                            transitions.push({ from: prev.def.label, to: cur.def.label, fromStatus: ps, toStatus: cs, type: 'dropoff' })
                          } else if ((ps === 'low' || ps === 'medium' || ps === 'absent') && cs === 'high') {
                            transitions.push({ from: prev.def.label, to: cur.def.label, fromStatus: ps, toStatus: cs, type: 'return' })
                          }
                        }
                      }

                      const dropOffEvents = transitions.filter(t => t.type === 'dropoff')
                      const returnEvents  = transitions.filter(t => t.type === 'return')

                      let bannerColor = 'bg-gray-50 border-gray-200'
                      let dotColor    = 'bg-gray-400'
                      let title       = ''
                      const details: string[] = []

                      if (noData) {
                        title = 'No messages found across any phase'
                      } else if (neverActive) {
                        bannerColor = 'bg-amber-50 border-amber-200'; dotColor = 'bg-amber-400'
                        title = 'Low/Med engagement — never reached high engagement in any phase'
                        if (preJoinCount > 0) details.push(`No activity in first ${preJoinCount} phase${preJoinCount > 1 ? 's' : ''} — joined in ${joinedPhase}`)
                        details.push(`Low/Med Eng. in: ${transientPhases.map(p => p.def.label).join(', ')}`)
                        if (midGaps.length) details.push(`Absent mid-journey: ${midGaps.map(p => p.def.label).join(', ')}`)
                        if (trailingAbsent.length) details.push(`No further activity after ${lastActivePh?.def.label} — ${trailingAbsent.map(p => p.def.label).join(', ')} absent`)
                        details.push(`Participated in ${participatedStr} phases`)
                      } else if (allParticipatedActive && midGaps.length === 0 && trailingAbsent.length === 0 && preJoinCount === 0) {
                        bannerColor = 'bg-emerald-50 border-emerald-200'; dotColor = 'bg-emerald-500'
                        title = `Consistently active across all ${phaseStatuses.length} phases from start to finish`
                        details.push(`Active in: ${activePhases.map(p => p.def.label).join(', ')}`)
                      } else if (allParticipatedActive) {
                        bannerColor = 'bg-emerald-50 border-emerald-200'; dotColor = 'bg-emerald-500'
                        title = `Active in all ${phasesWithData.length} phases participated (${participatedStr} total phases)`
                        if (preJoinCount > 0) details.push(`Not present in first ${preJoinCount} phase${preJoinCount > 1 ? 's' : ''} — joined in ${joinedPhase}`)
                        details.push(`Active in: ${activePhases.map(p => p.def.label).join(', ')}`)
                        if (midGaps.length) details.push(`Absent mid-journey: ${midGaps.map(p => p.def.label).join(', ')}`)
                        if (trailingAbsent.length) details.push(`No further activity after ${lastActivePh?.def.label} — ${trailingAbsent.map(p => p.def.label).join(', ')} absent`)
                      } else if (dropOffEvents.length > 0) {
                        const recovered = returnEvents.length > 0
                        bannerColor = recovered ? 'bg-sky-50 border-sky-200'  : 'bg-rose-50 border-rose-200'
                        dotColor    = recovered ? 'bg-sky-500'                : 'bg-rose-500'
                        title = recovered
                          ? `Engagement decline with recovery — ${dropOffEvents.length} drop-off, ${returnEvents.length} return event${returnEvents.length > 1 ? 's' : ''}`
                          : `Engagement decline — ${dropOffEvents.length} drop-off event${dropOffEvents.length > 1 ? 's' : ''}, no recovery`
                        if (preJoinCount > 0) details.push(`Joined in ${joinedPhase} — absent in first ${preJoinCount} phase${preJoinCount > 1 ? 's' : ''}`)
                        for (const t of dropOffEvents) details.push(`Drop-off: ${t.from} (active) → ${t.to} (${t.toStatus})`)
                        for (const t of returnEvents)  details.push(`Recovery: returned to active in ${t.to}`)
                        if (activePhases.length)    details.push(`High Eng. in: ${activePhases.map(p => p.def.label).join(', ')}`)
                        if (transientPhases.length) details.push(`Low/Med Eng. in: ${transientPhases.map(p => p.def.label).join(', ')}`)
                        if (midGaps.length) details.push(`Absent mid-journey: ${midGaps.map(p => p.def.label).join(', ')}`)
                        if (trailingAbsent.length) details.push(`No further activity after ${lastActivePh?.def.label} — ${trailingAbsent.map(p => p.def.label).join(', ')} absent`)
                        details.push(`Final status (${lastActivePh?.def.label}): ${finalStatus === 'high' ? 'High Engagement' : finalStatus === 'medium' ? 'Med Engagement' : finalStatus === 'low' ? 'Low Engagement' : 'Absent'} · Participated in ${participatedStr} phases`)
                      } else {
                        const trajectory = activePhases.length >= transientPhases.length ? 'predominantly high engagement' : 'predominantly low/med engagement'
                        bannerColor = 'bg-sky-50 border-sky-200'; dotColor = 'bg-sky-400'
                        title = `Mixed engagement — ${trajectory} across participated phases`
                        if (preJoinCount > 0) details.push(`Joined in ${joinedPhase} — absent in first ${preJoinCount} phase${preJoinCount > 1 ? 's' : ''}`)
                        if (activePhases.length)    details.push(`High Eng. in: ${activePhases.map(p => p.def.label).join(', ')} (${activePhases.length} phase${activePhases.length > 1 ? 's' : ''})`)
                        if (transientPhases.length) details.push(`Low/Med Eng. in: ${transientPhases.map(p => p.def.label).join(', ')} (${transientPhases.length} phase${transientPhases.length > 1 ? 's' : ''})`)
                        if (midGaps.length) details.push(`Absent mid-journey: ${midGaps.map(p => p.def.label).join(', ')}`)
                        if (trailingAbsent.length) details.push(`No further activity after ${lastActivePh?.def.label} — ${trailingAbsent.map(p => p.def.label).join(', ')} absent`)
                        details.push(`Final status (${lastActivePh?.def.label}): ${finalStatus === 'high' ? 'High Engagement' : finalStatus === 'medium' ? 'Med Engagement' : finalStatus === 'low' ? 'Low Engagement' : 'Absent'} · Participated in ${participatedStr} phases`)
                      }

                      return (
                        <div className={`rounded-xl border px-4 py-3 ${bannerColor}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-3 flex-1 min-w-0">
                              <div className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${dotColor}`} />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold text-gray-800">{title}</p>
                                {details.map((d, i) => (
                                  <p key={i} className="text-[11px] text-gray-600 mt-0.5">• {d}</p>
                                ))}
                                {crossPhaseNarrative && !narrativeLoading && (
                                  <p className="text-[11px] text-violet-700 mt-1.5 italic border-t border-violet-100 pt-1.5">
                                    AI: {crossPhaseNarrative}
                                  </p>
                                )}
                              </div>
                            </div>
                            {userMsgs.length > 0 && (
                              <button
                                onClick={async () => {
                                  if (!selectedUser) return
                                  setNarrativeLoading(true)
                                  setCrossPhaseNarrative(null)
                                  try {
                                    const result = await apiFetch<{ narrative: string }>('/user-engagement-narrative', {
                                      method: 'POST',
                                      body: JSON.stringify({
                                        username: selectedUser.username,
                                        phase_statuses: phaseStatuses.map(p => ({
                                          label: p.def.label,
                                          sub: p.def.sub,
                                          status: p.status,
                                          msg_count: p.msgCount,
                                        })),
                                      }),
                                    })
                                    setCrossPhaseNarrative(result.narrative)
                                  } catch (err) {
                                    const msg = err instanceof Error ? err.message : String(err)
                                    setCrossPhaseNarrative(`Failed: ${msg}`)
                                  } finally {
                                    setNarrativeLoading(false)
                                  }
                                }}
                                disabled={narrativeLoading}
                                className="shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-violet-100 text-violet-700 hover:bg-violet-200 disabled:opacity-50 transition-colors border border-violet-200 whitespace-nowrap"
                                title="Generate AI narrative for this user's engagement pattern"
                              >
                                {narrativeLoading ? '⏳ AI…' : crossPhaseNarrative ? '↺ AI' : '✦ AI'}
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })()}

                    {/* Phase timeline strip */}
                    <div>
                      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Phase-by-Phase Status</p>
                      <div className="flex gap-0 rounded-xl overflow-hidden border border-gray-200">
                        {crossPhaseEvents.map(({ def, status, msgCount, isDropOff, isReturn }, i) => {
                          const isPreJoin = msgCount === 0 && !crossPhaseEvents.slice(0, i).some(p => p.msgCount > 0)
                          const bgColor = isPreJoin ? '#f3f4f6'
                            : msgCount === 0    ? '#ffe4e6'
                            : status === 'high'   ? '#d1fae5'
                            : status === 'medium' ? '#e0f2fe'
                            : '#fef3c7'
                          const borderColor = isPreJoin ? '#e5e7eb'
                            : msgCount === 0    ? '#fca5a5'
                            : status === 'high'   ? '#6ee7b7'
                            : status === 'medium' ? '#7dd3fc'
                            : '#fcd34d'
                          return (
                            <div
                              key={def.key}
                              className="flex-1 relative px-2 py-3 text-center border-r last:border-r-0 border-gray-200"
                              style={{ backgroundColor: bgColor, borderTopColor: borderColor, borderTopWidth: 3 }}
                            >
                              {(isDropOff || isReturn) && (
                                <div className="absolute top-0 left-0 w-full flex justify-start pl-0">
                                  <span className={`text-[9px] font-bold px-1 py-0.5 ${isDropOff ? 'bg-rose-500 text-white' : 'bg-emerald-500 text-white'}`}>
                                    {isDropOff ? '↓ drop-off' : '↑ return'}
                                  </span>
                                </div>
                              )}
                              <p className="text-[10px] font-bold text-gray-700 mt-3">{def.label}</p>
                              <p className="text-[9px] text-gray-400 mb-1">{def.sub}</p>
                              <StatusBadge status={isPreJoin ? null : status} />
                              {msgCount > 0 && (
                                <p className="text-[9px] text-gray-400 mt-1">{msgCount} msgs</p>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>

                    {/* Message count bar chart across phases */}
                    {phaseStatuses.some(p => p.msgCount > 0) && (
                      <div>
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Message Volume per Phase</p>
                        <ResponsiveContainer width="100%" height={140}>
                          <BarChart
                            data={phaseStatuses.map(p => ({ phase: p.def.label, Messages: p.msgCount, status: p.status }))}
                            margin={{ left: -20, right: 4, top: 2, bottom: 0 }}
                          >
                            <XAxis dataKey="phase" tick={{ fontSize: 9 }} />
                            <YAxis tick={{ fontSize: 9 }} />
                            <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => [v, 'Messages']} />
                            <Bar dataKey="Messages" radius={[3, 3, 0, 0]}>
                              {phaseStatuses.map((p, i) => (
                                <Cell
                                  key={i}
                                  fill={
                                    p.status === 'high'   ? '#10b981'
                                    : p.status === 'medium' ? '#0ea5e9'
                                    : p.status === 'low'    ? '#f59e0b'
                                    : '#d1d5db'
                                  }
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                        <div className="flex gap-4 justify-center mt-1">
                          {[['#10b981','High Eng.'],['#0ea5e9','Med Eng.'],['#f59e0b','Low Eng.'],['#d1d5db','No data']].map(([c,l]) => (
                            <span key={l} className="flex items-center gap-1 text-[10px] text-gray-400">
                              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: c }} />{l}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}


                    {/* Archetype evolution strip */}
                    {phaseStatuses.some(ps => userPersonas[ps.def.key]) && (() => {
                      const ARC_BG: Record<string, string> = {
                        'Contributor': '#eff6ff', 'Explorer': '#f5f3ff',
                        'Help-Seeker': '#fffbeb', 'Suno Team': '#fdf4ff',
                        'Uncategorized': '#f1f5f9',
                      }
                      const ARC_BORDER: Record<string, string> = {
                        'Contributor': '#93c5fd', 'Explorer': '#c4b5fd',
                        'Help-Seeker': '#fcd34d', 'Suno Team': '#e879f9',
                        'Uncategorized': '#94a3b8',
                      }
                      const ARC_TEXT: Record<string, string> = {
                        'Contributor': '#1d4ed8', 'Explorer': '#7c3aed',
                        'Help-Seeker': '#92400e', 'Suno Team': '#86198f',
                        'Uncategorized': '#475569',
                      }
                      const SEC_BG: Record<string, string> = {
                        'Evangelist': '#ecfdf5', 'Scrutinizer': '#fff1f2',
                      }
                      const SEC_TEXT: Record<string, string> = {
                        'Evangelist': '#065f46', 'Scrutinizer': '#9f1239',
                      }
                      return (
                        <div>
                          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Archetype Evolution</p>
                          <div className="flex gap-0 rounded-xl overflow-hidden border border-gray-200">
                            {phaseStatuses.map(({ def, msgCount }, i) => {
                              const saved = userPersonas[def.key]
                              const isPreJoin = msgCount === 0 && !phaseStatuses.slice(0, i).some(p => p.msgCount > 0)
                              const prevSaved = i > 0 ? userPersonas[phaseStatuses[i - 1].def.key] : null
                              const changed = !!(saved && prevSaved && saved.persona !== prevSaved.persona)
                              const bg     = saved ? (ARC_BG[saved.persona]     ?? '#f9fafb') : '#f9fafb'
                              const border = saved ? (ARC_BORDER[saved.persona] ?? '#e5e7eb') : '#e5e7eb'
                              const tc     = saved ? (ARC_TEXT[saved.persona]   ?? '#6b7280') : '#9ca3af'
                              return (
                                <div
                                  key={def.key}
                                  className="flex-1 relative px-2 py-3 text-center border-r last:border-r-0 border-gray-200"
                                  style={{ backgroundColor: bg, borderTopColor: border, borderTopWidth: 3 }}
                                >
                                  {changed && (
                                    <div className="absolute top-0 right-0">
                                      <span className="text-[8px] font-bold px-1 py-0.5 bg-indigo-500 text-white" title="Archetype changed from previous phase">↺</span>
                                    </div>
                                  )}
                                  <p className="text-[10px] font-bold text-gray-700 mt-1">{def.label}</p>
                                  <p className="text-[9px] text-gray-400 mb-1.5">{def.sub}</p>
                                  {msgCount === 0 ? (
                                    <span className="text-[9px] text-gray-300">{isPreJoin ? '—' : 'No data'}</span>
                                  ) : saved ? (
                                    <div className="flex flex-col items-center gap-0.5">
                                      <span
                                        className="text-[9px] font-bold px-1.5 py-0.5 rounded border"
                                        style={{ color: tc, backgroundColor: bg, borderColor: border }}
                                        title={saved.reasoning}
                                      >
                                        {saved.persona}
                                      </span>
                                      <span className="text-[9px] text-gray-400">{Math.round(saved.confidence * 100)}%</span>
                                      {saved.secondary_persona && (
                                        <span
                                          className="text-[8px] font-semibold px-1 py-0.5 rounded border"
                                          style={{
                                            color: SEC_TEXT[saved.secondary_persona] ?? '#6b7280',
                                            backgroundColor: SEC_BG[saved.secondary_persona] ?? '#f9fafb',
                                            borderColor: SEC_TEXT[saved.secondary_persona] ?? '#e5e7eb',
                                          }}
                                        >
                                          {saved.secondary_persona}
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-[9px] text-gray-300">—</span>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                          <p className="text-[9px] text-gray-400 mt-1">↺ marks an archetype change from the previous phase. Hover any badge for the reasoning.</p>
                        </div>
                      )
                    })()}

                    {userMsgs.length === 0 && (
                      <p className="text-sm text-gray-400 text-center py-6">No messages loaded for this user.</p>
                    )}
                  </div>
                )}

                {/* ── PER PHASE ──────────────────────────────────────────────── */}
                {dropoutSubTab === 'phases' && (
                  <div className="space-y-3">
                    {/* Recompute all phases button */}
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-gray-400">Archetype computed from stored sentiment + topics + activity for this phase window.</p>
                      <button
                        disabled={phaseStatuses.some(ps => personaClassifying.has(ps.def.key))}
                        onClick={async () => {
                          for (const ps of phaseStatuses) {
                            if (ps.msgCount === 0) continue
                            // Raw def.to (not resolved to allMsgsMaxDate) — topic runs are
                            // cached under the raw window, so an open-ended phase (to === '')
                            // must be queried the same way or its topics never match.
                            await recomputeOneArchetype(ps.def.key, ps.def.label, ps.def.from, ps.def.to ?? '')
                          }
                        }}
                        className="text-[10px] font-semibold px-2.5 py-1 rounded-lg border disabled:opacity-50 transition-colors
                          bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100"
                      >
                        {phaseStatuses.some(ps => personaClassifying.has(ps.def.key)) ? '⏳' : '↻ Recompute All Phases'}
                      </button>
                    </div>

                    <div className="overflow-x-auto rounded-xl border border-gray-200">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="bg-gray-50 border-b border-gray-200">
                            <th className="text-left px-3 py-2 font-semibold text-gray-600">Phase</th>
                            <th className="text-right px-3 py-2 font-semibold text-gray-600">Status</th>
                            <th className="text-center px-3 py-2 font-semibold text-sky-600">Flow</th>
                            <th className="text-right px-3 py-2 font-semibold text-gray-600">Msgs</th>
                            <th className="text-right px-3 py-2 font-semibold text-gray-600">% Wks</th>
                            <th className="text-center px-3 py-2 font-semibold text-indigo-600">Primary Archetype</th>
                            <th className="text-center px-3 py-2 font-semibold text-gray-500">Secondary</th>
                            <th className="text-center px-2 py-2 font-semibold text-gray-400">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {phaseStatuses.map(({ def, status, info, msgCount }, idx) => {
                            // Flow label — compare against the last phase that had messages
                            const priorPhases = phaseStatuses.slice(0, idx)
                            const hasAnyPrior = priorPhases.some(p => p.msgCount > 0)
                            const lastWithData = [...priorPhases].reverse().find(p => p.msgCount > 0)
                            let flowLabel: string; let flowCls: string
                            if (msgCount === 0 && !hasAnyPrior) {
                              flowLabel = 'Not Present'; flowCls = 'bg-gray-100 text-gray-400 border-gray-200'
                            } else if (msgCount > 0 && !hasAnyPrior) {
                              flowLabel = 'New Joiner'; flowCls = 'bg-sky-100 text-sky-700 border-sky-300'
                            } else if (msgCount === 0) {
                              flowLabel = lastWithData ? 'Dropout' : 'Absent'
                              flowCls   = lastWithData
                                ? 'bg-rose-100 text-rose-700 border-rose-300'
                                : 'bg-gray-100 text-gray-500 border-gray-200'
                            } else if (!lastWithData) {
                              flowLabel = 'New Joiner'; flowCls = 'bg-sky-100 text-sky-700 border-sky-300'
                            } else if (lastWithData.status === 'high') {
                              flowLabel = status === 'high' ? 'Retained (High)' : status === 'medium' ? 'Decreased H→M' : 'Decreased H→L'
                              flowCls   = status === 'high'
                                ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
                                : 'bg-orange-100 text-orange-700 border-orange-300'
                            } else if (lastWithData.status === 'medium') {
                              flowLabel = status === 'high' ? 'Increased M→H' : status === 'medium' ? 'Continued (Med)' : 'Decreased M→L'
                              flowCls   = status === 'high'
                                ? 'bg-teal-100 text-teal-700 border-teal-300'
                                : status === 'medium'
                                  ? 'bg-sky-100 text-sky-700 border-sky-300'
                                  : 'bg-orange-100 text-orange-700 border-orange-300'
                            } else {
                              flowLabel = status === 'high' ? 'Increased L→H' : status === 'medium' ? 'Increased L→M' : 'Continued (Low)'
                              flowCls   = status !== 'low'
                                ? 'bg-teal-100 text-teal-700 border-teal-300'
                                : 'bg-slate-100 text-slate-500 border-slate-200'
                            }

                            const saved = userPersonas[def.key]
                            const loading = personaClassifying.has(def.key)
                            const PERSONA_COLORS_LOCAL: Record<string, string> = {
                              'Suno Team':     'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200',
                              'Contributor':   'bg-blue-50 text-blue-700 border-blue-200',
                              'Help-Seeker':   'bg-amber-50 text-amber-700 border-amber-200',
                              'Evangelist':    'bg-emerald-50 text-emerald-700 border-emerald-200',
                              'Scrutinizer':   'bg-rose-50 text-rose-700 border-rose-200',
                              'Explorer':      'bg-violet-50 text-violet-700 border-violet-200',
                              'Uncategorized': 'bg-slate-50 text-slate-500 border-slate-200',
                            }
                            const ArchetypeBadge = ({ name, conf, secondary }: { name: string; conf: number; secondary?: boolean }) => {
                              const cls = PERSONA_COLORS_LOCAL[name] ?? 'bg-gray-50 text-gray-600 border-gray-200'
                              return (
                                <span className={`inline-block text-[9px] font-semibold px-1.5 py-0.5 rounded border ${cls} ${secondary ? 'opacity-75' : ''}`}>
                                  {name} <span className="opacity-60">{Math.round(conf * 100)}%</span>
                                </span>
                              )
                            }

                            return (
                              <tr key={def.key} className="border-b border-gray-100 hover:bg-gray-50">
                                <td className="px-3 py-2">
                                  <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${def.chipCls}`}>{def.label}</span>
                                  <span className="ml-1.5 text-gray-400 text-[9px] hidden sm:inline">{def.sub}</span>
                                </td>
                                <td className="text-right px-3 py-2"><StatusBadge status={(msgCount === 0 && !hasAnyPrior) ? null : status} /></td>
                                <td className="text-center px-3 py-2">
                                  <span className={`inline-block text-[9px] font-semibold px-1.5 py-0.5 rounded-full border ${flowCls}`}>{flowLabel}</span>
                                </td>
                                <td className="text-right px-3 py-2 text-gray-700">{msgCount > 0 ? msgCount : '—'}</td>
                                <td className="text-right px-3 py-2 text-gray-600">{info ? `${info.pctWeeks}%` : '—'}</td>
                                <td className="text-center px-2 py-2">
                                  {loading
                                    ? <span className="text-[9px] text-indigo-400">⏳</span>
                                    : msgCount === 0
                                      ? <span className="text-[9px] text-gray-300">No data</span>
                                      : saved
                                        ? <span title={saved.reasoning} className="cursor-help"><ArchetypeBadge name={saved.persona} conf={saved.confidence} /></span>
                                        : <span className="text-[9px] text-gray-300">—</span>
                                  }
                                </td>
                                <td className="text-center px-2 py-2">
                                  {msgCount === 0
                                    ? <span className="text-[9px] text-gray-300">No data</span>
                                    : saved?.secondary_persona
                                      ? <span title={saved.reasoning} className="cursor-help">
                                          <ArchetypeBadge name={saved.secondary_persona} conf={saved.secondary_confidence ?? 0} secondary />
                                        </span>
                                      : <span className="text-[9px] text-gray-300">—</span>}
                                </td>
                                <td className="text-center px-2 py-1.5">
                                  {msgCount > 0 ? (
                                    <button
                                      disabled={loading}
                                      title="Recompute archetype from stored signals"
                                      onClick={() => recomputeOneArchetype(def.key, def.label, def.from, def.to ?? '')}
                                      className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 hover:bg-indigo-200 disabled:opacity-40 transition-colors font-semibold"
                                    >↻</button>
                                  ) : <span className="text-[9px] text-gray-300">—</span>}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[9px] text-gray-400">
                      Archetype is computed from already-stored sentiment + topic + activity signals; no LLM calls. Hover any badge to see the score breakdown.
                    </p>

                    {/* Criteria reference */}
                    <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-[10px] text-gray-400">
                      <span><span className="text-emerald-600 font-medium">High</span> — ≥50% weeks active</span>
                      <span><span className="text-sky-600 font-medium">Medium</span> — 20–49% weeks active</span>
                      <span><span className="text-amber-600 font-medium">Low</span> — &lt;20% weeks active</span>
                      <span><span className="text-rose-500 font-medium">Dropout</span> — absent in this phase</span>
                    </div>
                  </div>
                )}

                {/* ── CURRENT FILTER ─────────────────────────────────────────── */}
                {dropoutSubTab === 'current' && (
                  <div className="space-y-4">
                    {/* Criteria legend */}
                    <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-[10px] text-gray-400">
                      <span><span className="text-emerald-600 font-medium">High</span> — ≥50% weeks active</span>
                      <span><span className="text-sky-600 font-medium">Medium</span> — 20–49% weeks active</span>
                      <span><span className="text-amber-600 font-medium">Low</span> — &lt;20% weeks active</span>
                    </div>

                    {/* Status card */}
                    <div className={`rounded-xl px-4 py-3 flex items-start gap-3 ${sc.bg} border ${sc.border}`}>
                      <div className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${sc.dot}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-sm font-bold capitalize ${sc.text}`}>
                            {{ high: 'High Eng.', medium: 'Med Eng.', low: 'Low Eng.' }[dropInfo?.level ?? 'low'] ?? 'Unknown'}
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          Period: <strong>{detailFilterStart || '—'}</strong> → <strong>{detailFilterEnd || '—'}</strong>
                          {' '}· {userDetailFiltered.length} msgs · {derivedWeeksActive} active wks ({derivedPctWeeks}% of period)
                        </p>
                      </div>
                    </div>

                    {!detailFilterEnd && (
                      <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 border border-amber-200">
                        Set a "To" date in the phase filter above for accurate dropout calculation.
                      </p>
                    )}

                    {/* Weekly activity decay */}
                    {weeklyData.length > 1 && (
                      <div>
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Weekly Activity</p>
                        <ResponsiveContainer width="100%" height={120}>
                          <BarChart data={weeklyData} margin={{ left: -20, right: 4, top: 2, bottom: 0 }}>
                            <XAxis dataKey="week" tick={{ fontSize: 8 }} interval="preserveStartEnd" />
                            <YAxis tick={{ fontSize: 9 }} />
                            <Tooltip formatter={(v: number) => [v, 'Messages']} labelFormatter={l => `Week of ${l}`} />
                            <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                              {weeklyData.map((_, idx) => (
                                <Cell key={idx} fill='#6366f1' />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {/* Pre-dropout sentiment */}
                    {preDropoutSentiment && preDropoutMsgs.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                          Sentiment in Final {dropoutSilenceDays} Days ({preDropoutMsgs.length} messages)
                        </p>
                        <div className="flex gap-4">
                          {([['positive', '#10b981'], ['negative', '#f43f5e'], ['neutral', '#9ca3af']] as [string, string][]).map(([key, color]) => {
                            const val = preDropoutSentiment[key as keyof typeof preDropoutSentiment]
                            const total = preDropoutSentiment.positive + preDropoutSentiment.negative + preDropoutSentiment.neutral
                            const pct = total > 0 ? Math.round(val / total * 100) : 0
                            return (
                              <div key={key} className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                                <span className="text-xs text-gray-600 capitalize">{key}</span>
                                <span className="text-xs font-bold text-gray-800">{pct}%</span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* Pre-dropout topics */}
                    {preDropoutTopics && preDropoutTopics.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                          Topics in Final {dropoutSilenceDays} Days
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {preDropoutTopics.map((t, i) => (
                            <span
                              key={t.id}
                              className="text-[11px] px-2 py-0.5 rounded-full font-medium text-white"
                              style={{ backgroundColor: TOPIC_COLORS[i % TOPIC_COLORS.length] }}
                              title={`${t.count} messages`}
                            >
                              {t.label.length > 24 ? t.label.slice(0, 22) + '…' : t.label} ({t.count})
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Last messages */}
                    {lastMsgs.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                          Last {lastMsgs.length} Messages
                        </p>
                        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                          {lastMsgs.map((m, i) => (
                            <div key={m.id ?? i} className="bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
                              <p className="text-[10px] text-gray-400 mb-0.5">{m.date?.slice(0, 19).replace('T', ' ')}</p>
                              <p className="text-xs text-gray-700 leading-relaxed break-words">{m.content}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {userDetailFiltered.length === 0 && (
                      <p className="text-sm text-gray-400 text-center py-6">No messages loaded for this user.</p>
                    )}
                  </div>
                )}
              </div>
            )
          })()}

          {userAnalysisTab === 'strategy' && (
            <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">
              {/* Suno decision definitions editor */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Suno Decisions</p>
                  <button
                    onClick={() => setStrategyDefs(
                      `Free Tier Limits: Suno reduced or changed the number of free credits/generations available to free-tier users\nStem Separation Removal: Suno removed or restricted the ability to separate audio stems from generated tracks\nAPI Access Changes: Suno changed, restricted, or removed developer API access\nPricing Model Change: Suno updated subscription pricing tiers or billing structure\nv4 Model Launch: Suno released the v4 model with significant changes to generation quality and style control`
                    )}
                    className="text-[10px] text-sky-600 hover:text-sky-800 font-medium"
                  >
                    Load Suno preset
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 mb-2">
                  One decision per line: <code className="bg-gray-100 px-1 rounded">Decision Name: what Suno did and why it matters</code>
                </p>
                <textarea
                  value={strategyDefs}
                  onChange={e => setStrategyDefs(e.target.value)}
                  rows={5}
                  placeholder={"Free Tier Limits: Suno reduced the number of free credits available to free-tier users\nStem Separation Removal: Suno removed the ability to separate audio stems from generated tracks"}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono text-gray-700 focus:outline-none focus:ring-2 focus:ring-sky-300 resize-y"
                />
              </div>

              {/* Run button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={async () => {
                    if (!localStorage.getItem('openai_api_key')) { setShowKeyModal(true); return }
                    const lines = strategyDefs.split('\n').map(l => l.trim()).filter(Boolean)
                    const strategies = lines.map((line, i) => {
                      const colonIdx = line.indexOf(':')
                      const name = colonIdx > 0 ? line.slice(0, colonIdx).trim() : `Strategy ${i + 1}`
                      const description = colonIdx > 0 ? line.slice(colonIdx + 1).trim() : line
                      return { id: `s${i}`, name, description }
                    })
                    if (strategies.length === 0) return
                    setStrategyLoading(true)
                    setStrategyResult(null)
                    setStrategyError(null)
                    setExpandedStrategyIds(new Set())
                    try {
                      const result = await apiFetch<typeof strategyResult>('/user-strategy-classify', {
                        method: 'POST',
                        body: JSON.stringify({
                          messages: userDetailFiltered.map(m => ({
                            username: m.username,
                            date: m.date ?? '',
                            content: m.content,
                            msg_uuid: m.msg_uuid ?? '',
                          })),
                          strategies,
                          model: 'gpt-4o-mini',
                        }),
                      })
                      setStrategyResult(result)
                      if (result) {
                        setExpandedStrategyIds(new Set(
                          result.strategies.filter(s => s.count > 0).map(s => s.id)
                        ))
                      }
                    } catch (err) {
                      setStrategyError(err instanceof Error ? err.message : 'Classification failed')
                    } finally {
                      setStrategyLoading(false)
                    }
                  }}
                  disabled={strategyLoading || strategyDefs.trim() === ''}
                  className="search-btn"
                >
                  {strategyLoading ? 'Classifying…' : strategyResult ? 'Re-run' : 'Map Reactions'}
                </button>
                {strategyResult && (
                  <span className="text-xs text-gray-400">
                    {strategyResult.total_classified.toLocaleString()} of {strategyResult.total_messages.toLocaleString()} messages reacted to a decision · temp=0 seed=42
                  </span>
                )}
              </div>

              {strategyError && (
                <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">{strategyError}</p>
              )}

              {strategyLoading && (
                <div className="space-y-2">
                  {strategyDefs.split('\n').filter(Boolean).map((_, i) => (
                    <div key={i} className="h-12 bg-gray-100 rounded-xl animate-pulse" />
                  ))}
                </div>
              )}

              {/* Results */}
              {strategyResult && !strategyLoading && (
                <div className="space-y-2">
                  {strategyResult.strategies.map(s => {
                    const isOpen = expandedStrategyIds.has(s.id)
                    return (
                      <div key={s.id} className="border border-gray-200 rounded-xl overflow-hidden">
                        <button
                          onClick={() => setExpandedStrategyIds(prev => {
                            const next = new Set(prev)
                            if (next.has(s.id)) next.delete(s.id)
                            else next.add(s.id)
                            return next
                          })}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                        >
                          <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold shrink-0 ${
                            s.count > 0 ? 'bg-sky-600 text-white' : 'bg-gray-100 text-gray-400'
                          }`}>
                            {s.count}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-gray-800">{s.name}</p>
                            <p className="text-[10px] text-gray-400 truncate">{s.description}</p>
                          </div>
                          <svg
                            className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                            fill="none" stroke="currentColor" viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>

                        {isOpen && s.count > 0 && (
                          <div className="border-t border-gray-100 divide-y divide-gray-50 max-h-72 overflow-y-auto">
                            {s.messages.map((m, i) => (
                              <div key={i} className="px-4 py-2.5">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="ubadge text-[10px] font-semibold" style={getUserStyle(m.username)}>
                                    {m.username}
                                  </span>
                                  <span className="text-[10px] text-gray-400">
                                    {m.date?.slice(0, 10)}
                                  </span>
                                </div>
                                <p className="text-xs text-gray-700 leading-relaxed">{m.content}</p>
                              </div>
                            ))}
                          </div>
                        )}

                        {isOpen && s.count === 0 && (
                          <div className="border-t border-gray-100 px-4 py-3">
                            <p className="text-xs text-gray-400">No messages reacted to this decision.</p>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Messages list */}
        <div className="bg-white rounded-2xl shadow overflow-hidden">
          {/* Pagination header */}
          {!userMsgsLoading && userDetailFiltered.length > 0 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-gray-50">
              <span className="text-xs text-gray-500">
                {userDetailPage * PAGE_SIZE + 1}–{Math.min((userDetailPage + 1) * PAGE_SIZE, userDetailFiltered.length)} of {userDetailFiltered.length.toLocaleString()} messages
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { setUserDetailPage(p => p - 1); msgContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }}
                  disabled={userDetailPage === 0}
                  className="px-2 py-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 disabled:text-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  ← Prev
                </button>
                <span className="text-xs text-gray-500 px-1">Page {userDetailPage + 1} / {totalPages}</span>
                <button
                  onClick={() => { setUserDetailPage(p => p + 1); msgContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }}
                  disabled={userDetailPage >= totalPages - 1}
                  className="px-2 py-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 disabled:text-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
          {/* Scrollable message container */}
          <div ref={msgContainerRef} className="overflow-y-auto max-h-[70vh] p-3 space-y-3">
            {userMsgsLoading ? (
              <div className="p-8 text-center text-sm text-gray-400">Loading messages…</div>
            ) : userDetailFiltered.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400">No messages match the current filters.</div>
            ) : (
              visibleMsgs.map(msg => (
                <MessageCard
                  key={msg.id}
                  msg={msg}
                  keyword={userDetailContains}
                  tokens={[]}
                  isBookmarked={bookmarkedIds.has(msg.id)}
                  onBookmarkToggle={handleBookmarkToggle}
                  ctxBefore={userDetailCtxBefore}
                  ctxAfter={userDetailCtxAfter}
                  emotion={msg.msg_uuid ? msgEmotions[msg.msg_uuid] : undefined}
                  archetype={(() => {
                    const phaseKey = dateToPhaseKey(msg.date ?? '')
                    return phaseKey && phasePersonas[phaseKey]
                      ? phasePersonas[phaseKey][msg.username]
                      : tablePersonas[msg.username]?.persona
                  })()}
                />
              ))
            )}
          </div>
          {/* Pagination footer */}
          {!userMsgsLoading && totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 px-4 py-2.5 border-t border-gray-100 bg-gray-50">
              <button
                onClick={() => { setUserDetailPage(0); msgContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }}
                disabled={userDetailPage === 0}
                className="px-2 py-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                « First
              </button>
              <button
                onClick={() => { setUserDetailPage(p => p - 1); msgContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }}
                disabled={userDetailPage === 0}
                className="px-2 py-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                ← Prev
              </button>
              <span className="text-xs text-gray-500">Page {userDetailPage + 1} of {totalPages}</span>
              <button
                onClick={() => { setUserDetailPage(p => p + 1); msgContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }}
                disabled={userDetailPage >= totalPages - 1}
                className="px-2 py-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                Next →
              </button>
              <button
                onClick={() => { setUserDetailPage(totalPages - 1); msgContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }}
                disabled={userDetailPage >= totalPages - 1}
                className="px-2 py-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                Last »
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

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
          doUserSearch()
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
            {/* Users Data sub-tab toggle */}
            {(
              <div className="flex border-b mb-4">
                <button
                  onClick={() => setUsersDataTab('search')}
                  className={`search-tab${usersDataTab === 'search' ? ' tab-active' : ''}`}
                >
                  Users Stats Search
                </button>
                <button
                  onClick={() => { setUsersDataTab('phases'); setUserStats([]) }}
                  className={`search-tab${usersDataTab === 'phases' ? ' tab-active' : ''}`}
                >
                  User Summary Per Phases
                </button>
              </div>
            )}

            {/* Users Stats Search */}
            {usersDataTab === 'search' && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 mb-3">
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
                    <label className="filter-label">Min Words / Msg</label>
                    <input type="text" inputMode="numeric" placeholder="0" value={minWords === 0 ? '' : String(minWords)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinWords(d ? parseInt(d) : 0) }} className={inputCls} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="filter-label">Min Messages</label>
                    <input type="text" inputMode="numeric" placeholder="0" value={minMessages === 0 ? '' : String(minMessages)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinMessages(d ? parseInt(d) : 0) }} className={inputCls} />
                  </div>
                </div>

                {/* Phase template shortcuts */}
                {(() => {
                  type PhaseKey = '1' | '2' | '3' | '3a' | '3b' | '3c' | '3d'
                  const usersActivePhase: PhaseKey | null =
                    dateFrom === '2023-04-01' && dateTo === '2023-07-18' ? '1' :
                    dateFrom === '2023-07-19' && dateTo === '2023-09-05' ? '2' :
                    dateFrom === '2023-09-06' && dateTo === '' ? '3' :
                    dateFrom === '2023-09-06' && dateTo === '2023-12-18' ? '3a' :
                    dateFrom === '2023-12-18' && dateTo === '2024-03-17' ? '3b' :
                    dateFrom === '2024-03-17' && dateTo === '2024-05-16' ? '3c' :
                    dateFrom === '2024-05-17' && dateTo === '' ? '3d' : null

                  const applyPhase = (p: PhaseKey) => {
                    let newFrom = ''
                    let newTo = ''
                    if (usersActivePhase !== p) {
                      if (p === '1')       { newFrom = '2023-04-01'; newTo = '2023-07-18' }
                      else if (p === '2')  { newFrom = '2023-07-19'; newTo = '2023-09-05' }
                      else if (p === '3')  { newFrom = '2023-09-06'; newTo = '' }
                      else if (p === '3a') { newFrom = '2023-09-06'; newTo = '2023-12-18' }
                      else if (p === '3b') { newFrom = '2023-12-18'; newTo = '2024-03-17' }
                      else if (p === '3c') { newFrom = '2024-03-17'; newTo = '2024-05-16' }
                      else if (p === '3d') { newFrom = '2024-05-17'; newTo = '' }
                    }
                    setDateFrom(newFrom)
                    setDateTo(newTo)
                    // Trigger search immediately with the new dates — state hasn't re-rendered yet
                    // so we pass the new values explicitly rather than relying on stale closure state
                    doUserSearch({ from: newFrom, to: newTo })
                  }

                  return (
                    <div className="flex flex-wrap gap-1.5 mb-1">
                      <span className="filter-label self-center shrink-0">Phase</span>
                      {([
                        { key: '1',  label: 'Phase 1 — Capability Surfacing',     dates: 'Apr–18 Jul 2023',          cls: ['border-blue-400 bg-blue-100 text-blue-800',       'border-blue-300 text-blue-700 hover:bg-blue-50']       },
                        { key: '2',  label: 'Phase 2 — Enclosure & Scrutiny',     dates: '19 Jul–5 Sep 2023',        cls: ['border-amber-400 bg-amber-100 text-amber-800',    'border-amber-300 text-amber-700 hover:bg-amber-50']    },
                        { key: '3',  label: 'Phase 3 — Commercialization',        dates: 'Sep 2023 onward',          cls: ['border-emerald-400 bg-emerald-100 text-emerald-800', 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'] },
                        { key: '3a', label: 'Phase 3A — Early Commercialization', dates: '6 Sep–18 Dec 2023',        cls: ['border-violet-400 bg-violet-100 text-violet-800', 'border-violet-300 text-violet-700 hover:bg-violet-50'] },
                        { key: '3b', label: 'Phase 3B — Early Wide Adoption',     dates: '18 Dec 2023–17 Mar 2024',  cls: ['border-sky-400 bg-sky-100 text-sky-800',          'border-sky-300 text-sky-700 hover:bg-sky-50']          },
                        { key: '3c', label: 'Phase 3C — Pre-Litigation',          dates: '17 Mar–16 May 2024',       cls: ['border-orange-400 bg-orange-100 text-orange-800', 'border-orange-300 text-orange-700 hover:bg-orange-50'] },
                        { key: '3d', label: 'Phase 3D — Warning & Lawsuit',       dates: '17 May 2024 onward',       cls: ['border-rose-400 bg-rose-100 text-rose-800',       'border-rose-300 text-rose-700 hover:bg-rose-50']       },
                      ] as { key: PhaseKey; label: string; dates: string; cls: [string, string] }[]).map(({ key, label, dates, cls }) => (
                        <button
                          key={key}
                          onClick={() => applyPhase(key)}
                          className={`text-xs px-2.5 py-1 rounded-full border transition-colors font-medium ${usersActivePhase === key ? cls[0] + ' font-semibold' : cls[1]}`}
                        >
                          {label} <span className="opacity-60 ml-1">{dates}</span>
                        </button>
                      ))}
                    </div>
                  )
                })()}

                <button onClick={() => doUserSearch()} disabled={searching} className="search-btn mb-4">{searching ? 'Searching…' : 'Search'}</button>
                <p className="text-xs text-gray-500 mb-4">Returns all users active in the selected date range with message statistics. Leave dates empty to include all data.</p>
              </div>
            )}

            {/* User Summary Per Phases */}
            {usersDataTab === 'phases' && (() => {
              const pendingFetch = [...selectedPhases].filter((k) => !(k in phaseData))

              const phaseFilterEnd = (key: string) => {
                const def = PHASE_DEFS.find((p) => p.key === key)!
                if (def.to) return def.to
                return (phaseData[key] ?? []).reduce((max, u) =>
                  u.last_date && u.last_date > max ? u.last_date.slice(0, 10) : max, '')
              }

              const computePhaseCounts = (key: string) => {
                const users = phaseData[key] ?? []
                if (users.length === 0) return null
                const def = PHASE_DEFS.find((p) => p.key === key)!
                const filterEnd = phaseFilterEnd(key)
                const counts = { high: 0, medium: 0, low: 0 }
                for (const u of users) {
                  const info = classifyEngagement(u, def.from, filterEnd)
                  counts[info.level as keyof typeof counts]++
                }
                return { total: users.length, ...counts }
              }

              // Newcomers-only chart data: per phase, only count users not present in any earlier loaded phase
              const loadedSorted = [...selectedPhases]
                .filter(k => k in phaseData)
                .sort((a, b) => PHASE_DEFS.findIndex(d => d.key === a) - PHASE_DEFS.findIndex(d => d.key === b))

              const chartData = loadedSorted.map((key) => {
                const def = PHASE_DEFS.find((p) => p.key === key)
                if (!def || !phaseData[key]) return null
                const c = computePhaseCounts(key)
                if (!c) return null
                return {
                  phase: def.label,
                  High: c.high,
                  Medium: c.medium,
                  Low: c.low,
                  total: c.total,
                }
              }).filter(Boolean) as { phase: string; High: number; Medium: number; Low: number; total: number }[]

              const pctData = chartData.map((d) => ({
                phase: d.phase,
                High:   d.total > 0 ? Math.round((d.High   / d.total) * 100) : 0,
                Medium: d.total > 0 ? Math.round((d.Medium / d.total) * 100) : 0,
                Low:    d.total > 0 ? Math.round((d.Low    / d.total) * 100) : 0,
              }))


              const hasData = chartData.length > 0

              return (
                <div className="space-y-4">
                  {/* Phase selector chips */}
                  <div>
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className="filter-label shrink-0">Select Phases</span>
                      <button
                        onClick={() => {
                          const all = new Set(PHASE_DEFS.map((p) => p.key))
                          setSelectedPhases(all)
                          fetchPhaseSummary(all, { minWords, minMessages })
                        }}
                        className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        All
                      </button>
                      <button
                        onClick={() => setSelectedPhases(new Set())}
                        className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {PHASE_DEFS.map((def) => {
                        const selected = selectedPhases.has(def.key)
                        const loaded = def.key in phaseData
                        return (
                          <button
                            key={def.key}
                            onClick={() => {
                              const next = new Set(selectedPhases)
                              if (next.has(def.key)) next.delete(def.key)
                              else next.add(def.key)
                              setSelectedPhases(next)
                            }}
                            className={`text-xs px-3 py-1.5 rounded-full border transition-colors font-medium ${
                              selected ? def.chipCls + ' ring-2 ring-offset-1 ring-gray-400' : 'border-gray-300 text-gray-500 hover:bg-gray-50'
                            }`}
                          >
                            {def.label}
                            <span className="opacity-60 ml-1.5 font-normal">{def.sub}</span>
                            <span className="opacity-40 ml-1.5 font-normal text-[10px]">· {def.to ? daysBetween(def.from, def.to) : '?'}d</span>
                            {phaseLoadingSet.has(def.key) && (
                              <span className="ml-1.5 inline-block w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin opacity-60" />
                            )}
                            {selected && !loaded && !phaseLoadingSet.has(def.key) && <span className="ml-1 opacity-40 text-[10px]">—</span>}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Phase filters */}
                  <div className="flex flex-wrap gap-x-4 gap-y-2 items-end">
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Min Words / Msg</label>
                      <input type="text" inputMode="numeric" placeholder="0" value={minWords === 0 ? '' : String(minWords)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinWords(d ? parseInt(d) : 0) }} className={inputCls} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="filter-label">Min Messages</label>
                      <input type="text" inputMode="numeric" placeholder="0" value={minMessages === 0 ? '' : String(minMessages)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinMessages(d ? parseInt(d) : 0) }} className={inputCls} />
                    </div>
                  </div>

                  {/* Load button */}
                  {selectedPhases.size > 0 && pendingFetch.length > 0 && (
                    <button
                      onClick={() => fetchPhaseSummary(selectedPhases, { minWords, minMessages })}
                      disabled={phaseLoadingSet.size > 0}
                      className="search-btn"
                    >
                      {phaseLoadingSet.size > 0 ? `Loading ${phaseLoadingSet.size} phase${phaseLoadingSet.size > 1 ? 's' : ''}…` : `Load ${pendingFetch.length} Phase${pendingFetch.length > 1 ? 's' : ''}`}
                    </button>
                  )}

                  {hasData && (
                    <div className="space-y-6">
                      {/* User Flow Analysis — dropout, newcomers, resurgence per phase */}
                      {(() => {
                        const loadedKeys = [...selectedPhases]
                          .filter(k => k in phaseData)
                          .sort((a, b) => PHASE_DEFS.findIndex(d => d.key === a) - PHASE_DEFS.findIndex(d => d.key === b))
                        if (loadedKeys.length === 0) return null

                        // Build per-phase status maps
                        const phaseStatusMaps: Record<string, Map<string, EngagementLevel>> = {}
                        const phaseUserSets: Record<string, Set<string>> = {}
                        for (const key of loadedKeys) {
                          const def = PHASE_DEFS.find(p => p.key === key)!
                          const filterEnd = phaseFilterEnd(key)
                          phaseStatusMaps[key] = new Map()
                          phaseUserSets[key] = new Set()
                          for (const u of phaseData[key]) {
                            const info = classifyEngagement(u, def.from, filterEnd)
                            phaseStatusMaps[key].set(u.username, info.level)
                            phaseUserSets[key].add(u.username)
                          }
                        }

                        type FlowRow = {
                          key: string; label: string; sub: string; chipCls: string
                          periodDays: number | null; totalWeeks: number
                          total: number;           totalUsers: string[]
                          highInPhase: number;     highUsers: string[]
                          medInPhase: number;      medUsers: string[]
                          lowInPhase: number;      lowUsers: string[]
                          newComers: number;       newComerUsers: string[]
                          dropoutHigh: number | null; dropoutHighUsers: string[]
                          dropoutMed:  number | null; dropoutMedUsers:  string[]
                          dropoutLow:  number | null; dropoutLowUsers:  string[]
                          decHM: number | null; decHMUsers: string[]
                          decHL: number | null; decHLUsers: string[]
                          decML: number | null; decMLUsers: string[]
                        }

                        const flowRows: FlowRow[] = loadedKeys.map((key, i) => {
                          const def = PHASE_DEFS.find(p => p.key === key)!
                          const filterEnd = phaseFilterEnd(key)
                          const periodDays = filterEnd ? daysBetween(def.from, filterEnd) : null
                          const statusMap = phaseStatusMaps[key]
                          const userSet = phaseUserSets[key]
                          const totalUsers = [...userSet].sort()
                          const highUsers = [...statusMap.entries()].filter(([,s]) => s === 'high').map(([u]) => u).sort()
                          const medUsers  = [...statusMap.entries()].filter(([,s]) => s === 'medium').map(([u]) => u).sort()
                          const lowUsers  = [...statusMap.entries()].filter(([,s]) => s === 'low').map(([u]) => u).sort()
                          const earlierKeys = loadedKeys.slice(0, i)
                          const newComerUsers = totalUsers.filter(u => !earlierKeys.some(k => phaseUserSets[k].has(u)))
                          let dropoutHigh: number | null = null, dropoutHighUsers: string[] = []
                          let dropoutMed:  number | null = null, dropoutMedUsers:  string[] = []
                          let dropoutLow:  number | null = null, dropoutLowUsers:  string[] = []
                          let decHM: number | null = null, decHMUsers: string[] = []
                          let decHL: number | null = null, decHLUsers: string[] = []
                          let decML: number | null = null, decMLUsers: string[] = []
                          if (i > 0) {
                            const prevKey = loadedKeys[i - 1]
                            const prevStatus = phaseStatusMaps[prevKey]
                            const prevUsers = phaseUserSets[prevKey]
                            decHMUsers = [...prevUsers].filter(u => prevStatus.get(u) === 'high'   && statusMap.get(u) === 'medium').sort()
                            decHM = decHMUsers.length
                            decHLUsers = [...prevUsers].filter(u => prevStatus.get(u) === 'high'   && statusMap.get(u) === 'low').sort()
                            decHL = decHLUsers.length
                            decMLUsers = [...prevUsers].filter(u => prevStatus.get(u) === 'medium' && statusMap.get(u) === 'low').sort()
                            decML = decMLUsers.length
                            dropoutHighUsers = [...prevUsers].filter(u => prevStatus.get(u) === 'high'   && !userSet.has(u)).sort()
                            dropoutHigh = dropoutHighUsers.length
                            dropoutMedUsers  = [...prevUsers].filter(u => prevStatus.get(u) === 'medium' && !userSet.has(u)).sort()
                            dropoutMed  = dropoutMedUsers.length
                            dropoutLowUsers  = [...prevUsers].filter(u => prevStatus.get(u) === 'low'    && !userSet.has(u)).sort()
                            dropoutLow  = dropoutLowUsers.length
                          }
                          const totalWeeks = Math.ceil(Math.max(14, periodDays ?? 90) / 7)
                          return { key, label: def.label, sub: def.sub, chipCls: def.chipCls, periodDays, totalWeeks, total: totalUsers.length, totalUsers, highInPhase: highUsers.length, highUsers, medInPhase: medUsers.length, medUsers, lowInPhase: lowUsers.length, lowUsers, newComers: newComerUsers.length, newComerUsers, dropoutHigh, dropoutHighUsers, dropoutMed, dropoutMedUsers, dropoutLow, dropoutLowUsers, decHM, decHMUsers, decHL, decHLUsers, decML, decMLUsers }
                        })

                        const pct = (n: number, d: number) => d > 0 ? `${Math.round(n / d * 100)}%` : '—'

                        const makeModalUsers = (usernames: string[], srcKey: string, statusOverride?: EngagementLevel | 'no-data'): FlowModalUser[] =>
                          usernames.map(u => {
                            const data = (phaseData[srcKey] ?? []).find(x => x.username === u)
                            const hasData = statusOverride !== 'no-data'
                            return {
                              username: u,
                              total_messages: hasData ? (data?.total_messages ?? 0) : 0,
                              weeks_active: hasData ? (data?.weeks_active ?? null) : null,
                              pct_weeks: hasData ? (data?.pct_weeks ?? null) : null,
                              avg_words: hasData ? (data?.avg_words ?? null) : null,
                              status: statusOverride !== undefined ? statusOverride : (phaseStatusMaps[srcKey]?.get(u) ?? null),
                            }
                          })

                        return (
                          <div className="overflow-x-auto rounded-xl border border-gray-200">
                            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                              <div>
                                <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">User Flow Analysis</h3>
                                <p className="text-[10px] text-gray-400 mt-0.5">Dropout, newcomers and engagement changes across phases</p>
                              </div>
                              <button
                                onClick={() => {
                                  const p = (n: number | null, d: number) => n !== null && d > 0 ? `${Math.round(n / d * 100)}%` : '—'
                                  const csvHeaders = ['Phase', 'Sub', 'Days', 'Total', 'New Joiners', 'New %', 'High', 'High %', 'Medium', 'Med %', 'Low', 'Low %', '↓H→M', '↓H→M %', '↓H→L', '↓H→L %', '↓M→L', '↓M→L %', '↓Out(High)', '↓Out(High) %', '↓Out(Med)', '↓Out(Med) %', '↓Out(Low)', '↓Out(Low) %']
                                  const csvRows: (string | number | null)[][] = flowRows.map((fr, ri) => {
                                    const pt = ri > 0 ? phaseUserSets[loadedKeys[ri - 1]].size : 0
                                    return [fr.label, fr.sub, fr.periodDays ?? '', fr.total, fr.newComers, p(fr.newComers, fr.total), fr.highInPhase, p(fr.highInPhase, fr.total), fr.medInPhase, p(fr.medInPhase, fr.total), fr.lowInPhase, p(fr.lowInPhase, fr.total), fr.decHM ?? '—', p(fr.decHM, pt), fr.decHL ?? '—', p(fr.decHL, pt), fr.decML ?? '—', p(fr.decML, pt), fr.dropoutHigh ?? '—', p(fr.dropoutHigh, pt), fr.dropoutMed ?? '—', p(fr.dropoutMed, pt), fr.dropoutLow ?? '—', p(fr.dropoutLow, pt)]
                                  })
                                  downloadTableAsCSV(csvHeaders, csvRows, 'user-flow-analysis.csv')
                                }}
                                className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-white transition-colors"
                                title="Export as CSV"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                CSV
                              </button>
                            </div>
                            <table className="w-full text-xs border-collapse">
                              <thead>
                                <tr className="bg-gray-50 border-b border-gray-200 text-left text-[11px]">
                                  <th className="px-3 py-2.5 font-semibold text-gray-700">Phase</th>
                                  <th className="px-3 py-2.5 font-semibold text-gray-700 text-right">Total</th>
                                  <th className="px-3 py-2.5 font-semibold text-blue-600 text-right" title="Users whose first message across all loaded phases is in this phase">New Joiners</th>
                                  <th className="px-3 py-2.5 font-semibold text-emerald-700 text-right" title="Users with high engagement (≥50% weeks AND msgs ≥ 20×⌈50% of phase weeks⌉)">High Eng.</th>
                                  <th className="px-3 py-2.5 font-semibold text-sky-700 text-right" title="Users with medium engagement in this phase">Med Eng.</th>
                                  <th className="px-3 py-2.5 font-semibold text-amber-700 text-right" title="Users with low engagement (&lt;20% weeks) in this phase">Low Eng.</th>
                                  <th className="px-3 py-2.5 font-semibold text-orange-600 text-right" title="High → Medium engagement decrease from previous phase">↓ H→M</th>
                                  <th className="px-3 py-2.5 font-semibold text-red-600 text-right" title="High → Low engagement decrease from previous phase">↓ H→L</th>
                                  <th className="px-3 py-2.5 font-semibold text-orange-700 text-right" title="Medium → Low engagement decrease from previous phase">↓ M→L</th>
                                  <th className="px-3 py-2.5 font-semibold text-rose-700 text-right" title="High engagement in prev phase → absent in current phase">↓ Out (High)</th>
                                  <th className="px-3 py-2.5 font-semibold text-rose-600 text-right" title="Medium engagement in prev phase → absent in current phase">↓ Out (Med)</th>
                                  <th className="px-3 py-2.5 font-semibold text-rose-500 text-right" title="Low engagement in prev phase → absent in current phase">↓ Out (Low)</th>
                                </tr>
                              </thead>
                              <tbody>
                                {flowRows.map((row, i) => {
                                  const prevTotal = i > 0 ? phaseUserSets[loadedKeys[i - 1]].size : 0
                                  const prevKey = i > 0 ? loadedKeys[i - 1] : row.key
                                  const prevRowTotalWeeks = i > 0 ? flowRows[i - 1].totalWeeks : 0
                                  const crossCell = (val: number | null, users: string[], color: string, pctColor: string, title: string, src: string, wks: number, override?: EngagementLevel | 'no-data') =>
                                    val !== null ? (
                                      <div className="flex flex-col items-end">
                                        <button onClick={() => { setFlowModalSortCol('total_messages'); setFlowModalSortDir('desc'); setFlowModal({ title: `${title} in ${row.label}`, users: makeModalUsers(users, src, override), totalWeeks: wks }) }} className={`hover:underline font-semibold tabular-nums ${color}`}>
                                          {val}
                                        </button>
                                        <span className={`text-[10px] ${pctColor}`}>{pct(val, prevTotal)}</span>
                                      </div>
                                    ) : <span className="text-gray-300">—</span>
                                  return (
                                    <tr key={row.key} className="border-b border-gray-100 hover:bg-gray-50">
                                      <td className="px-3 py-2.5 min-w-[130px]">
                                        <div className="flex flex-col gap-0.5">
                                          <span className={`inline-block self-start px-2 py-0.5 rounded-full text-[10px] font-bold border ${row.chipCls}`}>{row.label}</span>
                                          <span className="text-gray-700 text-[11px] font-medium leading-tight">{row.sub}</span>
                                          <span className="text-gray-400 text-[10px]">{row.periodDays ?? '?'}d</span>
                                        </div>
                                      </td>
                                      <td className="px-3 py-2.5 text-right">
                                        <button onClick={() => { setFlowModalSortCol('total_messages'); setFlowModalSortDir('desc'); setFlowModal({ title: `All users in ${row.label}`, users: makeModalUsers(row.totalUsers, row.key), totalWeeks: row.totalWeeks }) }} className="font-bold text-gray-800 hover:underline tabular-nums text-sm">{row.total}</button>
                                      </td>
                                      <td className="px-3 py-2.5 text-right tabular-nums">
                                        <div className="flex flex-col items-end">
                                          <button onClick={() => { setFlowModalSortCol('total_messages'); setFlowModalSortDir('desc'); setFlowModal({ title: `New joiners in ${row.label}`, users: makeModalUsers(row.newComerUsers, row.key), totalWeeks: row.totalWeeks }) }} className="font-semibold text-blue-600 hover:underline">{row.newComers}</button>
                                          <span className="text-[10px] text-blue-400">{pct(row.newComers, row.total)}</span>
                                        </div>
                                      </td>
                                      <td className="px-3 py-2.5 text-right tabular-nums">
                                        <div className="flex flex-col items-end">
                                          <button onClick={() => { setFlowModalSortCol('total_messages'); setFlowModalSortDir('desc'); setFlowModal({ title: `High Engagement in ${row.label}`, users: makeModalUsers(row.highUsers, row.key), totalWeeks: row.totalWeeks }) }} className="font-semibold text-emerald-700 hover:underline">{row.highInPhase}</button>
                                          <span className="text-[10px] text-emerald-500">{pct(row.highInPhase, row.total)}</span>
                                        </div>
                                      </td>
                                      <td className="px-3 py-2.5 text-right tabular-nums">
                                        <div className="flex flex-col items-end">
                                          <button onClick={() => { setFlowModalSortCol('total_messages'); setFlowModalSortDir('desc'); setFlowModal({ title: `Med Engagement in ${row.label}`, users: makeModalUsers(row.medUsers, row.key), totalWeeks: row.totalWeeks }) }} className="font-semibold text-sky-700 hover:underline">{row.medInPhase}</button>
                                          <span className="text-[10px] text-sky-500">{pct(row.medInPhase, row.total)}</span>
                                        </div>
                                      </td>
                                      <td className="px-3 py-2.5 text-right tabular-nums">
                                        <div className="flex flex-col items-end">
                                          <button onClick={() => { setFlowModalSortCol('total_messages'); setFlowModalSortDir('desc'); setFlowModal({ title: `Low Engagement in ${row.label}`, users: makeModalUsers(row.lowUsers, row.key), totalWeeks: row.totalWeeks }) }} className="font-semibold text-amber-700 hover:underline">{row.lowInPhase}</button>
                                          <span className="text-[10px] text-amber-500">{pct(row.lowInPhase, row.total)}</span>
                                        </div>
                                      </td>
                                      <td className="px-3 py-2.5 text-right tabular-nums">{crossCell(row.decHM, row.decHMUsers, 'text-orange-600', 'text-orange-400', '↓ H→M', row.key, row.totalWeeks)}</td>
                                      <td className="px-3 py-2.5 text-right tabular-nums">{crossCell(row.decHL, row.decHLUsers, 'text-red-600', 'text-red-400', '↓ H→L', row.key, row.totalWeeks)}</td>
                                      <td className="px-3 py-2.5 text-right tabular-nums">{crossCell(row.decML, row.decMLUsers, 'text-orange-700', 'text-orange-500', '↓ M→L', row.key, row.totalWeeks)}</td>
                                      <td className="px-3 py-2.5 text-right tabular-nums">{crossCell(row.dropoutHigh, row.dropoutHighUsers, 'text-rose-700', 'text-rose-400', '↓ Out (High)', prevKey, prevRowTotalWeeks, 'no-data')}</td>
                                      <td className="px-3 py-2.5 text-right tabular-nums">{crossCell(row.dropoutMed,  row.dropoutMedUsers,  'text-rose-600', 'text-rose-400', '↓ Out (Med)',  prevKey, prevRowTotalWeeks, 'no-data')}</td>
                                      <td className="px-3 py-2.5 text-right tabular-nums">{crossCell(row.dropoutLow,  row.dropoutLowUsers,  'text-rose-500', 'text-rose-300', '↓ Out (Low)',  prevKey, prevRowTotalWeeks, 'no-data')}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                            <p className="text-[10px] text-gray-400 px-4 py-2 border-t border-gray-100 italic">
                              "↓ H→M/H→L/M→L": engagement tier dropped but user still present. "↓ Out (High/Med/Low)": user absent from current phase, counted by their prior tier. All cross-phase metrics compare against the immediately preceding loaded phase.
                            </p>
                          </div>
                        )
                      })()}

                      {/* Status toggles shared across all charts */}
                      {(() => {
                        const STATUSES = [
                          { key: 'High',   label: 'High Eng.', color: '#10b981', activeCls: 'bg-emerald-100 text-emerald-700 border-emerald-400 ring-emerald-300', inactiveCls: 'bg-gray-100 text-gray-400 border-gray-300' },
                          { key: 'Medium', label: 'Med Eng.',  color: '#0ea5e9', activeCls: 'bg-sky-100 text-sky-700 border-sky-400 ring-sky-300',                 inactiveCls: 'bg-gray-100 text-gray-400 border-gray-300' },
                          { key: 'Low',    label: 'Low Eng.',  color: '#f59e0b', activeCls: 'bg-amber-100 text-amber-700 border-amber-400 ring-amber-300',         inactiveCls: 'bg-gray-100 text-gray-400 border-gray-300' },
                        ]
                        const toggle = (key: string) => setPhaseChartStatuses((prev) => {
                          const next = new Set(prev)
                          if (next.has(key)) { if (next.size > 1) next.delete(key) }
                          else next.add(key)
                          return next
                        })
                        const show = phaseChartStatuses
                        return (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Show:</span>
                            {STATUSES.map(({ key, label, activeCls, inactiveCls }) => (
                              <button
                                key={key}
                                onClick={() => toggle(key)}
                                className={`text-xs px-3 py-1 rounded-full border font-semibold transition-colors ${show.has(key) ? `${activeCls} ring-2 ring-offset-1` : inactiveCls}`}
                              >
                                {label}
                              </button>
                            ))}
                            <button
                              onClick={() => setPhaseChartStatuses(new Set(['High', 'Medium', 'Low']))}
                              className="text-[10px] text-gray-400 hover:text-gray-600 underline ml-1"
                            >
                              reset
                            </button>
                          </div>
                        )
                      })()}

                      {/* Grouped bar chart — absolute counts */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">User Counts by Status per Phase</h3>
                          <button onClick={() => downloadChartAsPNG(chartCountsRef.current, 'user-counts-per-phase.png')} className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors" title="Export as PNG">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                            PNG
                          </button>
                        </div>
                        <div ref={chartCountsRef}>
                          <ResponsiveContainer width="100%" height={220}>
                            <BarChart data={chartData} barGap={2} barCategoryGap="25%">
                              <XAxis dataKey="phase" tick={{ fontSize: 10 }} />
                              <YAxis tick={{ fontSize: 10 }} />
                              <Tooltip contentStyle={{ fontSize: 11 }} />
                              {phaseChartStatuses.has('High')   && <Bar dataKey="High"   fill="#10b981" radius={[3, 3, 0, 0]} />}
                              {phaseChartStatuses.has('Medium') && <Bar dataKey="Medium" fill="#0ea5e9" radius={[3, 3, 0, 0]} />}
                              {phaseChartStatuses.has('Low')    && <Bar dataKey="Low"    fill="#f59e0b" radius={[3, 3, 0, 0]} />}
                            </BarChart>
                          </ResponsiveContainer>
                          <div className="flex gap-4 justify-center mt-1">
                            {([['#10b981', 'High', 'High Eng.'], ['#0ea5e9', 'Medium', 'Med Eng.'], ['#f59e0b', 'Low', 'Low Eng.']] as [string,string,string][]).filter(([, k]) => phaseChartStatuses.has(k)).map(([color,, label]) => (
                              <span key={label} className="flex items-center gap-1 text-[10px] text-gray-500">
                                <span className="inline-block w-3 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
                                {label}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Trend lines (%) */}
                      {chartData.length > 1 && (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Status Trends (%) Across Phases</h3>
                            <button onClick={() => downloadChartAsPNG(chartTrendsRef.current, 'status-trends-pct.png')} className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors" title="Export as PNG">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                              PNG
                            </button>
                          </div>
                          <div ref={chartTrendsRef}>
                            <ResponsiveContainer width="100%" height={200}>
                              <AreaChart data={pctData}>
                                <XAxis dataKey="phase" tick={{ fontSize: 10 }} />
                                <YAxis tick={{ fontSize: 10 }} unit="%" domain={[0, 100]} />
                                <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => `${v}%`} />
                                {phaseChartStatuses.has('High')   && <Area type="monotone" dataKey="High"   stroke="#10b981" fill="none" strokeWidth={2} dot={{ r: 4, fill: '#10b981' }} />}
                                {phaseChartStatuses.has('Medium') && <Area type="monotone" dataKey="Medium" stroke="#0ea5e9" fill="none" strokeWidth={2} dot={{ r: 4, fill: '#0ea5e9' }} />}
                                {phaseChartStatuses.has('Low')    && <Area type="monotone" dataKey="Low"    stroke="#f59e0b" fill="none" strokeWidth={2} dot={{ r: 4, fill: '#f59e0b' }} />}
                              </AreaChart>
                            </ResponsiveContainer>
                            <div className="flex gap-4 justify-center mt-1">
                              {([['#10b981', 'High', 'High Eng.'], ['#0ea5e9', 'Medium', 'Med Eng.'], ['#f59e0b', 'Low', 'Low Eng.']] as [string,string,string][]).filter(([, k]) => phaseChartStatuses.has(k)).map(([color,, label]) => (
                                <span key={label} className="flex items-center gap-1 text-[10px] text-gray-500">
                                  <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: color }} />
                                  {label}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Stacked % breakdown */}
                      {chartData.length > 1 && (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Status Distribution (%) — Stacked</h3>
                            <button onClick={() => downloadChartAsPNG(chartStackedRef.current, 'status-distribution-stacked.png')} className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors" title="Export as PNG">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                              PNG
                            </button>
                          </div>
                          <div ref={chartStackedRef}>
                            <ResponsiveContainer width="100%" height={180}>
                              <BarChart data={pctData} barCategoryGap="30%">
                                <XAxis dataKey="phase" tick={{ fontSize: 10 }} />
                                <YAxis tick={{ fontSize: 10 }} unit="%" domain={[0, 100]} />
                                <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => `${v}%`} />
                                {phaseChartStatuses.has('High')   && <Bar dataKey="High"   stackId="s" fill="#10b981" />}
                                {phaseChartStatuses.has('Medium') && <Bar dataKey="Medium" stackId="s" fill="#0ea5e9" />}
                                {phaseChartStatuses.has('Low')    && <Bar dataKey="Low"    stackId="s" fill="#f59e0b" radius={[3, 3, 0, 0]} />}
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}

                      {/* Section A: Users active across phases */}
                      {(() => {
                        const loadedKeys = [...selectedPhases].filter((k) => k in phaseData)
                        if (loadedKeys.length === 0) return null

                        // Per-phase active sets
                        const phaseActiveMaps = loadedKeys.map((key) => {
                          const def = PHASE_DEFS.find((p) => p.key === key)!
                          const filterEnd = phaseFilterEnd(key)
                          const map = new Map<string, UserInRange>()
                          for (const u of phaseData[key]) {
                            if (classifyEngagement(u, def.from, filterEnd).level === 'high') map.set(u.username, u)
                          }
                          return { key, map }
                        })

                        // Intersection: users who are active in ALL loaded phases
                        const baseMap = phaseActiveMaps[0].map
                        const crossActiveUsernames = [...baseMap.keys()].filter((name) =>
                          phaseActiveMaps.every(({ map }) => map.has(name))
                        )
                        crossActiveUsernames.sort((a, b) => {
                          const totalA = loadedKeys.reduce((s, k) => s + (phaseData[k].find((u) => u.username === a)?.total_messages ?? 0), 0)
                          const totalB = loadedKeys.reduce((s, k) => s + (phaseData[k].find((u) => u.username === b)?.total_messages ?? 0), 0)
                          return totalB - totalA
                        })

                        const isExpanded = expandedPhaseSections.has('cross-active')
                        const toggleSection = () => setExpandedPhaseSections((prev) => {
                          const next = new Set(prev)
                          if (next.has('cross-active')) next.delete('cross-active')
                          else next.add('cross-active')
                          return next
                        })

                        const label = loadedKeys.length === 1
                          ? `Active users in ${PHASE_DEFS.find((p) => p.key === loadedKeys[0])?.label}`
                          : `Users active across all ${loadedKeys.length} selected phases`

                        return (
                          <div className="rounded-xl border border-gray-200 overflow-hidden">
                            <div className="flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors cursor-pointer" onClick={toggleSection}>
                              <div className="flex items-center gap-3">
                                <span className="text-xs font-semibold text-gray-700">{label}</span>
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold border border-emerald-300">{crossActiveUsernames.length} users</span>
                              </div>
                              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={() => {
                                    const csvHeaders = ['Username', ...loadedKeys.map((k) => PHASE_DEFS.find((p) => p.key === k)?.label ?? k), 'Total Msgs']
                                    const csvRows: (string | number | null)[][] = crossActiveUsernames.map((name) => {
                                      const phaseMsgs = loadedKeys.map((k) => phaseData[k].find((u) => u.username === name)?.total_messages ?? null)
                                      const totalMsgs = phaseMsgs.reduce((s: number, v) => s + (v ?? 0), 0)
                                      return [name, ...phaseMsgs, totalMsgs]
                                    })
                                    downloadTableAsCSV(csvHeaders, csvRows, 'cross-phase-active-users.csv')
                                  }}
                                  className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-white transition-colors"
                                  title="Export as CSV"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                  CSV
                                </button>
                                <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                                </svg>
                              </div>
                            </div>

                            {isExpanded && (
                              <div className="overflow-auto" style={{ maxHeight: '360px' }}>
                                <table className="w-full text-xs border-collapse">
                                  <thead className="sticky top-0 bg-white border-b border-gray-200 z-10">
                                    <tr>
                                      <th className="text-left px-3 py-2 font-semibold text-gray-500">Username</th>
                                      {loadedKeys.map((k) => {
                                        const def = PHASE_DEFS.find((p) => p.key === k)!
                                        return (
                                          <th key={k} className="text-right px-2 py-2 font-semibold text-gray-500 whitespace-nowrap">
                                            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] border ${def.chipCls}`}>{def.label}</span>
                                            <span className="block text-[9px] text-gray-400 font-normal">msgs</span>
                                          </th>
                                        )
                                      })}
                                      <th className="text-right px-3 py-2 font-semibold text-gray-500">Total Msgs</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {crossActiveUsernames.map((name) => {
                                      const totalMsgs = loadedKeys.reduce((s, k) => s + (phaseData[k].find((u) => u.username === name)?.total_messages ?? 0), 0)
                                      return (
                                        <tr
                                          key={name}
                                          className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                                          onClick={() => navigate(`/discord/search/users/${encodeURIComponent(name)}`)}
                                        >
                                          <td className="px-3 py-1.5 font-medium text-indigo-700 max-w-[140px] truncate">{name}</td>
                                          {loadedKeys.map((k) => {
                                            const u = phaseData[k].find((u) => u.username === name)
                                            return (
                                              <td key={k} className="text-right px-2 py-1.5 text-gray-600">{u?.total_messages ?? '—'}</td>
                                            )
                                          })}
                                          <td className="text-right px-3 py-1.5 font-semibold text-gray-700">{totalMsgs}</td>
                                        </tr>
                                      )
                                    })}
                                    {crossActiveUsernames.length === 0 && (
                                      <tr><td colSpan={loadedKeys.length + 2} className="text-center py-4 text-xs text-gray-400">No users found active across all selected phases.</td></tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )
                      })()}

                      {/* Section B: Username trend across phases */}
                      {(() => {
                        const loadedKeys = [...selectedPhases].filter((k) => k in phaseData)
                        if (loadedKeys.length === 0) return null

                        const isExpanded = expandedPhaseSections.has('username-trend')
                        const toggleSection = () => setExpandedPhaseSections((prev) => {
                          const next = new Set(prev)
                          if (next.has('username-trend')) next.delete('username-trend')
                          else next.add('username-trend')
                          return next
                        })

                        // Autocomplete candidates from all loaded phases
                        const allUsernames = [...new Set(loadedKeys.flatMap((k) => phaseData[k].map((u) => u.username)))].sort()
                        const query = phaseUsernameSearch.trim().toLowerCase()
                        const suggestions = query.length >= 1
                          ? allUsernames.filter((n) => n.toLowerCase().includes(query)).slice(0, 8)
                          : []

                        // Per-phase data for the searched username
                        const exactMatch = allUsernames.find((n) => n.toLowerCase() === query)
                        const trendRows = exactMatch
                          ? loadedKeys.map((key) => {
                              const def = PHASE_DEFS.find((p) => p.key === key)!
                              const u = phaseData[key].find((u) => u.username === exactMatch)
                              const filterEnd = def.to || phaseFilterEnd(key)
                              const info = u ? classifyEngagement(u, def.from, filterEnd) : null
                              return { key, def, u: u ?? null, info }
                            })
                          : []

                        const trendChartData = trendRows
                          .filter(({ u }) => u !== null)
                          .map(({ def, u, info }) => ({
                            phase: def.label,
                            Messages: u!.total_messages,
                            'Avg Words': Math.round(u!.avg_words ?? 0),
                            'Weeks Active': u!.weeks_active ?? 0,
                            '% Weeks': Math.round(u!.pct_weeks ?? 0),
                            status: info?.level ?? 'low',
                          }))

                        return (
                          <div className="rounded-xl border border-gray-200 overflow-hidden">
                            <button onClick={toggleSection} className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left">
                              <span className="text-xs font-semibold text-gray-700">Username Trend Across Phases</span>
                              <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>

                            {isExpanded && (
                              <div className="px-4 py-3 space-y-3 bg-white">
                                {/* Search input */}
                                <div className="relative">
                                  <input
                                    type="text"
                                    value={phaseUsernameSearch}
                                    onChange={(e) => setPhaseUsernameSearch(e.target.value)}
                                    placeholder="Type a username…"
                                    className="search-input w-full text-xs"
                                  />
                                  {suggestions.length > 0 && !exactMatch && (
                                    <div className="absolute top-full left-0 right-0 z-20 bg-white border border-gray-200 rounded-lg shadow-lg mt-0.5 overflow-hidden">
                                      {suggestions.map((name) => (
                                        <button
                                          key={name}
                                          onClick={() => setPhaseUsernameSearch(name)}
                                          className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 text-gray-700 border-b border-gray-100 last:border-0"
                                        >
                                          {name}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>

                                {/* Trend table */}
                                {exactMatch && trendRows.length > 0 && (
                                  <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                      <span className="text-xs font-semibold text-gray-600">{exactMatch}</span>
                                      <div className="flex items-center gap-2">
                                        <button
                                          onClick={() => {
                                            const csvHeaders = ['Phase', 'Messages', 'Avg Words', 'Weeks Active', '% Weeks', 'Engagement']
                                            const csvRows: (string | number | null)[][] = trendRows.map(({ def, u, info }) => [
                                              def.label,
                                              u?.total_messages ?? null,
                                              u?.avg_words != null ? Math.round(u.avg_words) : null,
                                              u?.weeks_active ?? null,
                                              u?.pct_weeks != null ? Math.round(u.pct_weeks) : null,
                                              info?.level ?? null,
                                            ])
                                            downloadTableAsCSV(csvHeaders, csvRows, `${exactMatch}-phase-trend.csv`)
                                          }}
                                          className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
                                          title="Export as CSV"
                                        >
                                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                          CSV
                                        </button>
                                        <button
                                          onClick={() => navigate(`/discord/search/users/${encodeURIComponent(exactMatch)}`)}
                                          className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline font-medium"
                                        >
                                          View Full Detail →
                                        </button>
                                      </div>
                                    </div>
                                    <div className="overflow-x-auto rounded-lg border border-gray-100">
                                      <table className="w-full text-xs border-collapse">
                                        <thead className="bg-gray-50 border-b border-gray-200">
                                          <tr>
                                            <th className="text-left px-3 py-2 font-semibold text-gray-500">Phase</th>
                                            <th className="text-right px-3 py-2 font-semibold text-gray-500">Messages</th>
                                            <th className="text-right px-3 py-2 font-semibold text-gray-500">Avg Words</th>
                                            <th className="text-right px-3 py-2 font-semibold text-gray-500">Weeks</th>
                                            <th className="text-right px-3 py-2 font-semibold text-gray-500">% Weeks</th>
                                            <th className="text-right px-3 py-2 font-semibold text-gray-500">Status</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {trendRows.map(({ key, def, u, info }) => {
                                            const sc = info ? ENGAGEMENT_COLORS[info.level] : null
                                            return (
                                              <tr
                                                key={key}
                                                className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                                                onClick={() => navigate(`/discord/search/users/${encodeURIComponent(exactMatch)}`)}
                                              >
                                                <td className="px-3 py-2">
                                                  <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${def.chipCls}`}>{def.label}</span>
                                                </td>
                                                <td className="text-right px-3 py-2 text-gray-600">{u?.total_messages ?? <span className="text-gray-300">—</span>}</td>
                                                <td className="text-right px-3 py-2 text-gray-600">{u?.avg_words != null ? u.avg_words.toFixed(1) : <span className="text-gray-300">—</span>}</td>
                                                <td className="text-right px-3 py-2 text-gray-600">{u?.weeks_active ?? <span className="text-gray-300">—</span>}</td>
                                                <td className="text-right px-3 py-2 text-gray-600">{u?.pct_weeks != null ? `${Math.round(u.pct_weeks)}%` : <span className="text-gray-300">—</span>}</td>
                                                <td className="text-right px-3 py-2">
                                                  {sc && info ? (
                                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${sc.bg} ${sc.text} ${sc.border}`}>
                                                      <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                                                      {{ high: 'High Eng.', medium: 'Med Eng.', low: 'Low Eng.' }[info.level] ?? info.level}
                                                    </span>
                                                  ) : <span className="text-gray-300 text-[10px]">not found</span>}
                                                </td>
                                              </tr>
                                            )
                                          })}
                                        </tbody>
                                      </table>
                                    </div>

                                    {/* Mini trend charts */}
                                    {trendChartData.length > 1 && (
                                      <div>
                                        <div className="flex items-center justify-between mb-2">
                                          <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Trend Charts</span>
                                          <button
                                            onClick={() => downloadChartAsPNG(chartUserTrendRef.current, `${exactMatch}-trend-charts.png`)}
                                            className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
                                            title="Export as PNG"
                                          >
                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                            PNG
                                          </button>
                                        </div>
                                        <div ref={chartUserTrendRef} className="grid grid-cols-2 gap-3">
                                          {([
                                            { key: 'Messages',     color: '#6366f1', label: 'Messages per Phase' },
                                            { key: 'Avg Words',    color: '#f59e0b', label: 'Avg Words per Phase' },
                                            { key: '% Weeks',      color: '#10b981', label: '% Weeks Active per Phase' },
                                          ] as { key: string; color: string; label: string }[]).map(({ key: dKey, color, label }) => (
                                            <div key={dKey}>
                                              <p className="text-[10px] text-gray-500 font-medium mb-1">{label}</p>
                                              <ResponsiveContainer width="100%" height={100}>
                                                <AreaChart data={trendChartData}>
                                                  <XAxis dataKey="phase" tick={{ fontSize: 8 }} />
                                                  <YAxis tick={{ fontSize: 8 }} width={28} />
                                                  <Tooltip contentStyle={{ fontSize: 10 }} />
                                                  <Area type="monotone" dataKey={dKey} stroke={color} fill={color + '22'} strokeWidth={1.5} dot={{ r: 3, fill: color }} />
                                                </AreaChart>
                                              </ResponsiveContainer>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}

                                {query && !exactMatch && (
                                  <p className="text-xs text-gray-400 text-center py-2">No exact match — select a username from the suggestions above.</p>
                                )}
                                {!query && (
                                  <p className="text-xs text-gray-400 text-center py-2">Type a username to see their activity trend across selected phases.</p>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })()}

                      {/* Section C: Archetype Trend Across Phases */}
                      {(() => {
                        if (personaSummary.length === 0) return null

                        const ALL_ARCHETYPES = [
                          { name: 'Contributor', color: '#3b82f6' },
                          { name: 'Explorer',    color: '#8b5cf6' },
                          { name: 'Help-Seeker', color: '#f59e0b' },
                          { name: 'Suno Team',   color: '#d946ef' },
                          { name: 'Uncategorized', color: '#94a3b8' },
                        ]

                        // Build per-phase archetype count map from personaSummary (fetched
                        // globally, independent of which phases' user lists are "Loaded" above).
                        const archByPhase: Record<string, Record<string, number>> = {}
                        for (const row of personaSummary) {
                          if (!archByPhase[row.phase]) archByPhase[row.phase] = {}
                          archByPhase[row.phase][row.persona] = (archByPhase[row.phase][row.persona] ?? 0) + row.count
                        }

                        // Show every phase that already has saved archetype data, not just the
                        // ones currently "Loaded" in the phase selector above — this section
                        // reflects prior computations, so a phase like 3D shouldn't appear
                        // empty just because its user list hasn't been (re)fetched this session.
                        const archetypePhaseDefs = PHASE_DEFS.filter(def => archByPhase[def.key])

                        const archetypeChartData = archetypePhaseDefs.map(def => {
                          const counts = archByPhase[def.key] ?? {}
                          const total = Object.values(counts).reduce((s, c) => s + c, 0)
                          const entry: Record<string, number | string> = { phase: def.label, total }
                          for (const { name } of ALL_ARCHETYPES) entry[name] = counts[name] ?? 0
                          return entry
                        }).filter(d => (d.total as number) > 0)

                        if (archetypeChartData.length === 0) return null

                        const archetypePctData = archetypeChartData.map(d => {
                          const total = d.total as number
                          const entry: Record<string, number | string> = { phase: d.phase }
                          for (const { name } of ALL_ARCHETYPES) {
                            entry[name] = total > 0 ? Math.round(((d[name] as number) / total) * 100) : 0
                          }
                          return entry
                        })

                        const isExpanded = expandedPhaseSections.has('archetype-trend')
                        const toggleSection = () => setExpandedPhaseSections(prev => {
                          const next = new Set(prev)
                          next.has('archetype-trend') ? next.delete('archetype-trend') : next.add('archetype-trend')
                          return next
                        })

                        return (
                          <div className="rounded-xl border border-gray-200 overflow-hidden">
                            <button onClick={toggleSection} className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left">
                              <div>
                                <span className="text-xs font-semibold text-gray-700">Archetype Trend Across Phases</span>
                                <span className="ml-2 text-[10px] text-gray-400">distribution of user archetypes per phase</span>
                              </div>
                              <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>

                            {isExpanded && (
                              <div className="px-4 py-4 space-y-6 bg-white">

                                {/* Stacked bar — absolute counts */}
                                <div>
                                  <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Archetype Counts per Phase</h4>
                                    <button onClick={() => downloadChartAsPNG(chartArchetypeRef.current, 'archetype-counts-per-phase.png')} className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors" title="PNG">
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                      PNG
                                    </button>
                                  </div>
                                  <div ref={chartArchetypeRef}>
                                    <ResponsiveContainer width="100%" height={220}>
                                      <BarChart data={archetypeChartData} barCategoryGap="25%">
                                        <XAxis dataKey="phase" tick={{ fontSize: 10 }} />
                                        <YAxis tick={{ fontSize: 10 }} />
                                        <Tooltip contentStyle={{ fontSize: 11 }} />
                                        {ALL_ARCHETYPES.map(({ name, color }) => (
                                          <Bar key={name} dataKey={name} stackId="a" fill={color} />
                                        ))}
                                      </BarChart>
                                    </ResponsiveContainer>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-2">
                                      {ALL_ARCHETYPES.map(({ name, color }) => (
                                        <span key={name} className="flex items-center gap-1 text-[10px] text-gray-500">
                                          <span className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
                                          {name}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                </div>

                                {/* % composition line chart */}
                                {archetypeChartData.length > 1 && (
                                  <div>
                                    <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Archetype Share (%) — Trend</h4>
                                    <ResponsiveContainer width="100%" height={200}>
                                      <AreaChart data={archetypePctData}>
                                        <XAxis dataKey="phase" tick={{ fontSize: 10 }} />
                                        <YAxis tick={{ fontSize: 10 }} unit="%" domain={[0, 100]} />
                                        <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => `${v}%`} />
                                        {ALL_ARCHETYPES.map(({ name, color }) => (
                                          <Area key={name} type="monotone" dataKey={name} stackId="b" stroke={color} fill={color + '55'} strokeWidth={1.5} />
                                        ))}
                                      </AreaChart>
                                    </ResponsiveContainer>
                                  </div>
                                )}

                                {/* Dominant archetype + diversity table */}
                                <div>
                                  <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Phase Summary</h4>
                                    <button
                                      onClick={() => {
                                        const csvHeaders = ['Phase', 'Total Computed', 'Dominant Archetype', 'Dominant %', ...ALL_ARCHETYPES.map(a => a.name)]
                                        const csvRows = archetypeChartData.map(d => {
                                          const total = d.total as number
                                          const dominant = ALL_ARCHETYPES.reduce((best, { name }) =>
                                            (d[name] as number) > (d[best] as number) ? name : best, ALL_ARCHETYPES[0].name)
                                          const domPct = total > 0 ? Math.round(((d[dominant] as number) / total) * 100) : 0
                                          return [d.phase, total, dominant, `${domPct}%`, ...ALL_ARCHETYPES.map(({ name }) => d[name])]
                                        })
                                        downloadTableAsCSV(csvHeaders, csvRows, 'archetype-phase-summary.csv')
                                      }}
                                      className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
                                    >
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                      CSV
                                    </button>
                                  </div>
                                  <div className="overflow-x-auto rounded-lg border border-gray-100">
                                    <table className="w-full text-xs border-collapse">
                                      <thead className="bg-gray-50 border-b border-gray-200">
                                        <tr>
                                          <th className="text-left px-3 py-2 font-semibold text-gray-500">Phase</th>
                                          <th className="text-right px-3 py-2 font-semibold text-gray-500">Total</th>
                                          <th className="text-center px-3 py-2 font-semibold text-gray-500">Dominant</th>
                                          {ALL_ARCHETYPES.map(({ name, color }) => (
                                            <th key={name} className="text-right px-2 py-2 font-semibold text-[10px] whitespace-nowrap" style={{ color }}>{name.split(' ')[0]}</th>
                                          ))}
                                          <th className="text-center px-2 py-2 font-semibold text-gray-400 text-[10px]"></th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {archetypeChartData.map(d => {
                                          const total = d.total as number
                                          const dominant = ALL_ARCHETYPES.reduce((best, { name }) =>
                                            (d[name] as number) > (d[best.name] as number) ? { name, color: best.color } : best,
                                            ALL_ARCHETYPES[0])
                                          const domPct = total > 0 ? Math.round(((d[dominant.name] as number) / total) * 100) : 0
                                          const def = archetypePhaseDefs.find(p => p.label === d.phase)
                                          const isReanalyzing = def ? reanalyzingPhases.has(def.key) : false
                                          return (
                                            <tr key={d.phase as string} className="border-b border-gray-50 hover:bg-gray-50">
                                              <td className="px-3 py-2 font-medium text-gray-700">{d.phase}</td>
                                              <td className="text-right px-3 py-2 font-bold text-gray-800">{total}</td>
                                              <td className="text-center px-3 py-2">
                                                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: dominant.color + '22', color: dominant.color }}>
                                                  {dominant.name} · {domPct}%
                                                </span>
                                              </td>
                                              {ALL_ARCHETYPES.map(({ name }) => {
                                                const cnt = d[name] as number
                                                const pct = total > 0 ? Math.round((cnt / total) * 100) : 0
                                                return (
                                                  <td key={name} className="text-right px-2 py-2 text-gray-600">
                                                    {cnt > 0 ? <><span className="font-semibold">{cnt}</span><span className="text-gray-400 ml-0.5 text-[10px]"> {pct}%</span></> : <span className="text-gray-200">—</span>}
                                                  </td>
                                                )
                                              })}
                                              <td className="text-center px-2 py-2">
                                                {def && (
                                                  <button
                                                    onClick={() => reanalyzePhaseFull(def.key, def.label, def.from, def.to ?? '')}
                                                    disabled={isReanalyzing || batchPersonaClassifying}
                                                    title={`Reanalyze all ${phaseData[def.key]?.length ?? 0} users in ${def.label}`}
                                                    className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-indigo-200 text-indigo-600 hover:bg-indigo-50 hover:border-indigo-300"
                                                  >
                                                    {isReanalyzing
                                                      ? <><svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>…</>
                                                      : <><svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>Reanalyze</>
                                                    }
                                                  </button>
                                                )}
                                              </td>
                                            </tr>
                                          )
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>

                                {/* Secondary archetype (Evangelist / Scrutinizer) distribution */}
                                {(() => {
                                  const readySecKeys = archetypePhaseDefs.filter(def => phaseSecondaryPersonas[def.key])
                                  if (readySecKeys.length === 0) return null
                                  const secByPhase: Record<string, Record<string, number>> = {}
                                  for (const def of readySecKeys) {
                                    const secMap = phaseSecondaryPersonas[def.key] ?? {}
                                    const counts: Record<string, number> = { Evangelist: 0, Scrutinizer: 0, None: 0 }
                                    const total = (archByPhase[def.key] ? Object.values(archByPhase[def.key]).reduce((s, c) => s + c, 0) : 0)
                                    for (const [, sec] of Object.entries(secMap)) {
                                      if (sec === 'Evangelist') counts.Evangelist++
                                      else if (sec === 'Scrutinizer') counts.Scrutinizer++
                                    }
                                    counts.None = Math.max(0, total - counts.Evangelist - counts.Scrutinizer)
                                    secByPhase[def.key] = counts
                                  }
                                  const ALL_SEC_WITH_NONE = [
                                    { name: 'Evangelist',  color: '#10b981' },
                                    { name: 'Scrutinizer', color: '#f43f5e' },
                                    { name: 'None',        color: '#d1d5db' },
                                  ]
                                  const secChartData = readySecKeys.map(def => {
                                    const counts = secByPhase[def.key] ?? { Evangelist: 0, Scrutinizer: 0, None: 0 }
                                    const total = counts.Evangelist + counts.Scrutinizer + counts.None
                                    return { phase: def.label, ...counts, total }
                                  }).filter(d => d.total > 0)
                                  if (secChartData.length === 0) return null
                                  return (
                                    <div>
                                      <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Secondary Archetype — Stance per Phase</h4>
                                      <ResponsiveContainer width="100%" height={180}>
                                        <BarChart data={secChartData} barCategoryGap="25%">
                                          <XAxis dataKey="phase" tick={{ fontSize: 10 }} />
                                          <YAxis tick={{ fontSize: 10 }} />
                                          <Tooltip contentStyle={{ fontSize: 11 }} />
                                          {ALL_SEC_WITH_NONE.map(({ name, color }) => (
                                            <Bar key={name} dataKey={name} stackId="s" fill={color} />
                                          ))}
                                        </BarChart>
                                      </ResponsiveContainer>
                                      <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-2">
                                        {ALL_SEC_WITH_NONE.map(({ name, color }) => (
                                          <span key={name} className="flex items-center gap-1 text-[10px] text-gray-500">
                                            <span className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
                                            {name}
                                          </span>
                                        ))}
                                      </div>
                                      <div className="overflow-x-auto rounded-lg border border-gray-100 mt-3">
                                        <table className="w-full text-xs border-collapse">
                                          <thead className="bg-gray-50 border-b border-gray-200">
                                            <tr>
                                              <th className="text-left px-3 py-2 font-semibold text-gray-500">Phase</th>
                                              <th className="text-right px-2 py-2 font-semibold text-[10px]" style={{ color: '#10b981' }}>Evangelist</th>
                                              <th className="text-right px-2 py-2 font-semibold text-[10px]" style={{ color: '#f43f5e' }}>Scrutinizer</th>
                                              <th className="text-right px-2 py-2 font-semibold text-gray-400 text-[10px]">None</th>
                                              <th className="text-right px-3 py-2 font-semibold text-gray-400 text-[10px]">Total</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {secChartData.map(d => (
                                              <tr key={d.phase} className="border-b border-gray-50 hover:bg-gray-50">
                                                <td className="px-3 py-2 font-medium text-gray-700">{d.phase}</td>
                                                {(['Evangelist', 'Scrutinizer', 'None'] as const).map(k => {
                                                  const cnt = (d as unknown as Record<string, number>)[k] ?? 0
                                                  const pct = d.total > 0 ? Math.round((cnt / d.total) * 100) : 0
                                                  return (
                                                    <td key={k} className="text-right px-2 py-2">
                                                      {cnt > 0
                                                        ? <><span className="font-semibold text-gray-800">{cnt}</span><span className="text-[9px] text-gray-400 ml-0.5">{pct}%</span></>
                                                        : <span className="text-gray-200">—</span>}
                                                    </td>
                                                  )
                                                })}
                                                <td className="text-right px-3 py-2 font-bold text-gray-700">{d.total}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  )
                                })()}
                              </div>
                            )}
                          </div>
                        )
                      })()}

                      {/* Section D: Community Sentiment Trend */}
                      {(() => {
                        const sentRows = phaseSentiment.filter(r =>
                          loadedSorted.includes(r.phase) && r.total > 0
                        ).sort((a, b) => loadedSorted.indexOf(a.phase) - loadedSorted.indexOf(b.phase))
                        if (sentRows.length === 0) return null

                        const sentChartData = sentRows.map(r => {
                          const def = PHASE_DEFS.find(p => p.key === r.phase)
                          const label = def?.label ?? r.phase
                          return {
                            phase: label,
                            Positive: r.total > 0 ? Math.round((r.positive / r.total) * 100) : 0,
                            Negative: r.total > 0 ? Math.round((r.negative / r.total) * 100) : 0,
                            Neutral:  r.total > 0 ? Math.round((r.neutral  / r.total) * 100) : 0,
                            posCount: r.positive, negCount: r.negative, neuCount: r.neutral,
                            total: r.total,
                          }
                        })

                        const isExpanded = expandedPhaseSections.has('sentiment-trend')
                        const toggleSection = () => setExpandedPhaseSections(prev => {
                          const next = new Set(prev)
                          next.has('sentiment-trend') ? next.delete('sentiment-trend') : next.add('sentiment-trend')
                          return next
                        })

                        return (
                          <div className="rounded-xl border border-gray-200 overflow-hidden">
                            <button onClick={toggleSection} className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left">
                              <div>
                                <span className="text-xs font-semibold text-gray-700">Community Sentiment Trend</span>
                                <span className="ml-2 text-[10px] text-gray-400">positive / negative / neutral messages per phase</span>
                              </div>
                              <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>

                            {isExpanded && (
                              <div className="px-4 py-4 space-y-6 bg-white">

                                {/* Sentiment line trend */}
                                <div>
                                  <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Sentiment Share (%) — Trend</h4>
                                    <button onClick={() => downloadChartAsPNG(chartSentimentRef.current, 'community-sentiment-trend.png')} className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors" title="PNG">
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                      PNG
                                    </button>
                                  </div>
                                  <div ref={chartSentimentRef}>
                                    <ResponsiveContainer width="100%" height={200}>
                                      <AreaChart data={sentChartData}>
                                        <XAxis dataKey="phase" tick={{ fontSize: 10 }} />
                                        <YAxis tick={{ fontSize: 10 }} unit="%" domain={[0, 100]} />
                                        <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => `${v}%`} />
                                        <Area type="monotone" dataKey="Positive" stroke="#10b981" fill="none" strokeWidth={2} dot={{ r: 4, fill: '#10b981' }} />
                                        <Area type="monotone" dataKey="Negative" stroke="#f43f5e" fill="none" strokeWidth={2} dot={{ r: 4, fill: '#f43f5e' }} />
                                        <Area type="monotone" dataKey="Neutral"  stroke="#9ca3af" fill="none" strokeWidth={2} dot={{ r: 4, fill: '#9ca3af' }} />
                                      </AreaChart>
                                    </ResponsiveContainer>
                                    <div className="flex gap-4 justify-center mt-1">
                                      {([['#10b981','Positive'],['#f43f5e','Negative'],['#9ca3af','Neutral']] as [string,string][]).map(([color, label]) => (
                                        <span key={label} className="flex items-center gap-1 text-[10px] text-gray-500">
                                          <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: color }} />
                                          {label}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                </div>

                                {/* Stacked 100% bar */}
                                {sentChartData.length > 1 && (
                                  <div>
                                    <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Sentiment Composition — Stacked</h4>
                                    <ResponsiveContainer width="100%" height={160}>
                                      <BarChart data={sentChartData} barCategoryGap="30%">
                                        <XAxis dataKey="phase" tick={{ fontSize: 10 }} />
                                        <YAxis tick={{ fontSize: 10 }} unit="%" domain={[0, 100]} />
                                        <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => `${v}%`} />
                                        <Bar dataKey="Positive" stackId="s" fill="#10b981" />
                                        <Bar dataKey="Neutral"  stackId="s" fill="#9ca3af" />
                                        <Bar dataKey="Negative" stackId="s" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                                      </BarChart>
                                    </ResponsiveContainer>
                                  </div>
                                )}

                                {/* Summary table */}
                                <div>
                                  <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Per-Phase Breakdown</h4>
                                    <button
                                      onClick={() => {
                                        const csvHeaders = ['Phase', 'Total Analyzed', 'Positive', 'Pos %', 'Negative', 'Neg %', 'Neutral', 'Neu %', 'Net Sentiment']
                                        const csvRows = sentChartData.map(d => [
                                          d.phase, d.total,
                                          d.posCount, `${d.Positive}%`,
                                          d.negCount, `${d.Negative}%`,
                                          d.neuCount, `${d.Neutral}%`,
                                          `${d.Positive - d.Negative > 0 ? '+' : ''}${d.Positive - d.Negative}%`,
                                        ])
                                        downloadTableAsCSV(csvHeaders, csvRows, 'community-sentiment-phases.csv')
                                      }}
                                      className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
                                    >
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                      CSV
                                    </button>
                                  </div>
                                  <div className="overflow-x-auto rounded-lg border border-gray-100">
                                    <table className="w-full text-xs border-collapse">
                                      <thead className="bg-gray-50 border-b border-gray-200">
                                        <tr>
                                          <th className="text-left px-3 py-2 font-semibold text-gray-500">Phase</th>
                                          <th className="text-right px-3 py-2 font-semibold text-gray-500">Analyzed</th>
                                          <th className="text-right px-3 py-2 font-semibold text-emerald-600">Positive</th>
                                          <th className="text-right px-3 py-2 font-semibold text-rose-500">Negative</th>
                                          <th className="text-right px-3 py-2 font-semibold text-gray-400">Neutral</th>
                                          <th className="text-right px-3 py-2 font-semibold text-gray-500">Net</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {sentChartData.map(d => {
                                          const net = d.Positive - d.Negative
                                          return (
                                            <tr key={d.phase as string} className="border-b border-gray-50 hover:bg-gray-50">
                                              <td className="px-3 py-2 font-medium text-gray-700">{d.phase}</td>
                                              <td className="text-right px-3 py-2 text-gray-600">{(d.total as number).toLocaleString()}</td>
                                              <td className="text-right px-3 py-2">
                                                <span className="font-semibold text-emerald-700">{d.posCount.toLocaleString()}</span>
                                                <span className="text-[10px] text-emerald-400 ml-1">{d.Positive}%</span>
                                              </td>
                                              <td className="text-right px-3 py-2">
                                                <span className="font-semibold text-rose-600">{d.negCount.toLocaleString()}</span>
                                                <span className="text-[10px] text-rose-400 ml-1">{d.Negative}%</span>
                                              </td>
                                              <td className="text-right px-3 py-2">
                                                <span className="text-gray-500">{d.neuCount.toLocaleString()}</span>
                                                <span className="text-[10px] text-gray-300 ml-1">{d.Neutral}%</span>
                                              </td>
                                              <td className="text-right px-3 py-2">
                                                <span className={`font-semibold text-sm ${net > 0 ? 'text-emerald-600' : net < 0 ? 'text-rose-600' : 'text-gray-400'}`}>
                                                  {net > 0 ? '+' : ''}{net}%
                                                </span>
                                              </td>
                                            </tr>
                                          )
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })()}

                      {/* Section E: Archetype × Engagement Cross-Tab */}
                      {(() => {
                        // Need at least one phase with both phaseData and phasePersonas loaded
                        const readyKeys = loadedSorted.filter(k => phasePersonas[k] && phaseData[k])
                        if (readyKeys.length === 0) return null

                        const ALL_ARCHETYPES = ['Contributor','Explorer','Help-Seeker','Suno Team']
                        const ENG_LEVELS = ['high','medium','low'] as const
                        const ENG_LABELS: Record<string, string> = { high: 'High Eng.', medium: 'Med Eng.', low: 'Low Eng.' }
                        const ENG_COLORS: Record<string, string> = { high: '#10b981', medium: '#0ea5e9', low: '#f59e0b' }
                        const ARCH_COLORS: Record<string, string> = {
                          'Contributor': '#3b82f6',
                          'Explorer':    '#8b5cf6',
                          'Help-Seeker': '#f59e0b',
                          'Suno Team':   '#d946ef',
                        }

                        // Build the cross-tab data — one record per (phase, username)
                        type CrossRow = { archetype: string; engagement: string; phase: string }
                        const rows: CrossRow[] = []
                        for (const key of readyKeys) {
                          const def = PHASE_DEFS.find(p => p.key === key)!
                          const filterEnd = phaseFilterEnd(key)
                          const personaMap = phasePersonas[key]
                          for (const u of phaseData[key]) {
                            const archetype = personaMap[u.username]
                            if (!archetype) continue
                            const eng = classifyEngagement(u, def.from, filterEnd).level
                            rows.push({ archetype, engagement: eng, phase: def.label })
                          }
                        }

                        if (rows.length === 0) return null

                        // Aggregate: archetype × engagement count matrix
                        type Matrix = Record<string, Record<string, number>>
                        const buildMatrix = (subset: CrossRow[]): Matrix => {
                          const m: Matrix = {}
                          for (const a of ALL_ARCHETYPES) {
                            m[a] = { high: 0, medium: 0, low: 0 }
                          }
                          for (const r of subset) {
                            if (!m[r.archetype]) m[r.archetype] = { high: 0, medium: 0, low: 0 }
                            m[r.archetype][r.engagement] = (m[r.archetype][r.engagement] ?? 0) + 1
                          }
                          return m
                        }
                        const aggMatrix = buildMatrix(rows)
                        const archTotals = (m: Matrix) =>
                          Object.fromEntries(ALL_ARCHETYPES.map(a => [a, Object.values(m[a] ?? {}).reduce((s, c) => s + c, 0)]))
                        const aggTotals = archTotals(aggMatrix)
                        const engTotals = Object.fromEntries(ENG_LEVELS.map(e => [e, rows.filter(r => r.engagement === e).length]))
                        const grandTotal = rows.length

                        // Per-phase matrices
                        const phaseMatrices = readyKeys.map(key => {
                          const def = PHASE_DEFS.find(p => p.key === key)!
                          const subset = rows.filter(r => r.phase === def.label)
                          return { key, def, matrix: buildMatrix(subset), total: subset.length, totals: archTotals(buildMatrix(subset)) }
                        })

                        // Stacked bar data: per-archetype, split by engagement (for bar chart)
                        const stackedBarData = ALL_ARCHETYPES
                          .filter(a => aggTotals[a] > 0)
                          .map(a => ({
                            archetype: a.replace(' ', '\n'),
                            High:   aggMatrix[a]?.high   ?? 0,
                            Medium: aggMatrix[a]?.medium ?? 0,
                            Low:    aggMatrix[a]?.low    ?? 0,
                          }))

                        // Reverse bar: per-engagement, split by archetype
                        const engBarData = ENG_LEVELS.map(e => {
                          const entry: Record<string, number | string> = { eng: ENG_LABELS[e] }
                          for (const a of ALL_ARCHETYPES) entry[a] = aggMatrix[a]?.[e] ?? 0
                          return entry
                        })

                        const isExpanded = expandedPhaseSections.has('archetype-engagement')
                        const toggleSection = () => setExpandedPhaseSections(prev => {
                          const next = new Set(prev)
                          next.has('archetype-engagement') ? next.delete('archetype-engagement') : next.add('archetype-engagement')
                          return next
                        })

                        const maxCell = Math.max(...ALL_ARCHETYPES.flatMap(a => ENG_LEVELS.map(e => aggMatrix[a]?.[e] ?? 0)))
                        const cellBg = (count: number) => {
                          if (count === 0 || maxCell === 0) return 'transparent'
                          const alpha = 0.08 + (count / maxCell) * 0.55
                          return `rgba(99,102,241,${alpha.toFixed(2)})`
                        }

                        return (
                          <div className="rounded-xl border border-gray-200 overflow-hidden">
                            <button onClick={toggleSection} className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left">
                              <div>
                                <span className="text-xs font-semibold text-gray-700">Archetype × Engagement Cross-Tab</span>
                                <span className="ml-2 text-[10px] text-gray-400">how engagement levels distribute across archetypes</span>
                              </div>
                              <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>

                            {isExpanded && (
                              <div className="px-4 py-4 space-y-6 bg-white">

                                {/* Aggregate heatmap table */}
                                <div>
                                  <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                                      Heatmap — Aggregated Across {readyKeys.length} Phase{readyKeys.length > 1 ? 's' : ''}
                                    </h4>
                                    <button
                                      onClick={() => {
                                        const csvHeaders = ['Archetype', 'High Eng.', 'High %', 'Med Eng.', 'Med %', 'Low Eng.', 'Low %', 'Total']
                                        const csvRows = ALL_ARCHETYPES.filter(a => aggTotals[a] > 0).map(a => {
                                          const t = aggTotals[a]
                                          return [a,
                                            aggMatrix[a].high,   t > 0 ? `${Math.round(aggMatrix[a].high / t * 100)}%` : '0%',
                                            aggMatrix[a].medium, t > 0 ? `${Math.round(aggMatrix[a].medium / t * 100)}%` : '0%',
                                            aggMatrix[a].low,    t > 0 ? `${Math.round(aggMatrix[a].low / t * 100)}%` : '0%',
                                            t,
                                          ]
                                        })
                                        downloadTableAsCSV(csvHeaders, csvRows, 'archetype-engagement-crosstab.csv')
                                      }}
                                      className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
                                    >
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                      CSV
                                    </button>
                                  </div>
                                  <div className="overflow-x-auto rounded-lg border border-gray-100">
                                    <table className="w-full text-xs border-collapse">
                                      <thead className="bg-gray-50 border-b border-gray-200">
                                        <tr>
                                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Archetype</th>
                                          {ENG_LEVELS.map(e => (
                                            <th key={e} className="text-center px-3 py-2 font-semibold text-[11px]" style={{ color: ENG_COLORS[e] }}>{ENG_LABELS[e]}</th>
                                          ))}
                                          <th className="text-right px-3 py-2 font-semibold text-gray-400 text-[10px]">Total</th>
                                          <th className="text-left px-3 py-2 font-semibold text-gray-400 text-[10px]">Engagement Mix</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {ALL_ARCHETYPES.filter(a => aggTotals[a] > 0).map(a => {
                                          const t = aggTotals[a]
                                          const dominantEng = ENG_LEVELS.reduce((best, e) =>
                                            (aggMatrix[a][e] ?? 0) > (aggMatrix[a][best] ?? 0) ? e : best, ENG_LEVELS[0])
                                          return (
                                            <tr key={a} className="border-b border-gray-50 hover:bg-gray-50">
                                              <td className="px-3 py-2">
                                                <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: ARCH_COLORS[a] }}>
                                                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: ARCH_COLORS[a] }} />
                                                  {a}
                                                </span>
                                              </td>
                                              {ENG_LEVELS.map(e => {
                                                const count = aggMatrix[a]?.[e] ?? 0
                                                const pct = t > 0 ? Math.round((count / t) * 100) : 0
                                                return (
                                                  <td key={e} className="text-center px-3 py-2" style={{ backgroundColor: cellBg(count) }}>
                                                    {count > 0 ? (
                                                      <div className="flex flex-col items-center gap-0.5">
                                                        <span className="font-bold text-gray-800">{count}</span>
                                                        <span className="text-[9px] text-gray-500">{pct}%</span>
                                                      </div>
                                                    ) : <span className="text-gray-200 text-[10px]">—</span>}
                                                  </td>
                                                )
                                              })}
                                              <td className="text-right px-3 py-2 font-bold text-gray-700">{t}</td>
                                              <td className="px-3 py-2">
                                                <div className="flex gap-0.5 items-center w-32">
                                                  {ENG_LEVELS.map(e => {
                                                    const pct = t > 0 ? (aggMatrix[a]?.[e] ?? 0) / t * 100 : 0
                                                    return pct > 0 ? (
                                                      <div key={e} title={`${ENG_LABELS[e]}: ${Math.round(pct)}%`}
                                                        className="h-4 rounded-sm transition-all"
                                                        style={{ width: `${pct}%`, backgroundColor: ENG_COLORS[e] }}
                                                      />
                                                    ) : null
                                                  })}
                                                </div>
                                                <span className="text-[9px] text-gray-400 mt-0.5 block">{ENG_LABELS[dominantEng]} dominant</span>
                                              </td>
                                            </tr>
                                          )
                                        })}
                                        {/* Column totals */}
                                        <tr className="border-t-2 border-gray-200 bg-gray-50">
                                          <td className="px-3 py-2 font-semibold text-gray-500 text-[10px] uppercase">Total</td>
                                          {ENG_LEVELS.map(e => (
                                            <td key={e} className="text-center px-3 py-2">
                                              <div className="flex flex-col items-center gap-0.5">
                                                <span className="font-bold text-gray-700">{engTotals[e]}</span>
                                                <span className="text-[9px] text-gray-400">{grandTotal > 0 ? Math.round(engTotals[e] / grandTotal * 100) : 0}%</span>
                                              </div>
                                            </td>
                                          ))}
                                          <td className="text-right px-3 py-2 font-bold text-gray-800">{grandTotal}</td>
                                          <td />
                                        </tr>
                                      </tbody>
                                    </table>
                                  </div>
                                </div>

                                {/* Stacked bar: per-archetype, engagement composition */}
                                <div>
                                  <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Engagement Composition per Archetype</h4>
                                  <ResponsiveContainer width="100%" height={200}>
                                    <BarChart data={stackedBarData} barCategoryGap="30%">
                                      <XAxis dataKey="archetype" tick={{ fontSize: 9 }} />
                                      <YAxis tick={{ fontSize: 10 }} />
                                      <Tooltip contentStyle={{ fontSize: 11 }} />
                                      <Bar dataKey="High"   stackId="e" fill={ENG_COLORS.high}   name="High Eng." />
                                      <Bar dataKey="Medium" stackId="e" fill={ENG_COLORS.medium} name="Med Eng." />
                                      <Bar dataKey="Low"    stackId="e" fill={ENG_COLORS.low}    name="Low Eng." radius={[3,3,0,0]} />
                                    </BarChart>
                                  </ResponsiveContainer>
                                  <div className="flex gap-4 justify-center mt-1">
                                    {ENG_LEVELS.map(e => (
                                      <span key={e} className="flex items-center gap-1 text-[10px] text-gray-500">
                                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: ENG_COLORS[e] }} />
                                        {ENG_LABELS[e]}
                                      </span>
                                    ))}
                                  </div>
                                </div>

                                {/* Stacked bar: per-engagement, archetype composition */}
                                <div>
                                  <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Archetype Composition per Engagement Level</h4>
                                  <ResponsiveContainer width="100%" height={160}>
                                    <BarChart data={engBarData} barCategoryGap="40%">
                                      <XAxis dataKey="eng" tick={{ fontSize: 10 }} />
                                      <YAxis tick={{ fontSize: 10 }} />
                                      <Tooltip contentStyle={{ fontSize: 11 }} />
                                      {ALL_ARCHETYPES.filter(a => aggTotals[a] > 0).map(a => (
                                        <Bar key={a} dataKey={a} stackId="a" fill={ARCH_COLORS[a]} name={a} />
                                      ))}
                                    </BarChart>
                                  </ResponsiveContainer>
                                  <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-2">
                                    {ALL_ARCHETYPES.filter(a => aggTotals[a] > 0).map(a => (
                                      <span key={a} className="flex items-center gap-1 text-[10px] text-gray-500">
                                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: ARCH_COLORS[a] }} />
                                        {a}
                                      </span>
                                    ))}
                                  </div>
                                </div>

                                {/* Per-phase breakdown tables */}
                                {phaseMatrices.length > 1 && (
                                  <div>
                                    <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-3">Per-Phase Breakdown</h4>
                                    <div className="space-y-4">
                                      {phaseMatrices.map(({ def, matrix, total, totals }) => {
                                        if (total === 0) return null
                                        return (
                                          <div key={def.key}>
                                            <div className="flex items-center gap-2 mb-1.5">
                                              <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold border ${def.chipCls}`}>{def.label}</span>
                                              <span className="text-[10px] text-gray-400">{def.sub} · {total} users with archetypes</span>
                                            </div>
                                            <div className="overflow-x-auto rounded-lg border border-gray-100">
                                              <table className="w-full text-xs border-collapse">
                                                <thead className="bg-gray-50 border-b border-gray-100">
                                                  <tr>
                                                    <th className="text-left px-3 py-1.5 font-semibold text-gray-500 text-[10px]">Archetype</th>
                                                    {ENG_LEVELS.map(e => (
                                                      <th key={e} className="text-center px-2 py-1.5 font-semibold text-[10px]" style={{ color: ENG_COLORS[e] }}>{ENG_LABELS[e]}</th>
                                                    ))}
                                                    <th className="text-right px-3 py-1.5 font-semibold text-gray-400 text-[10px]">Total</th>
                                                  </tr>
                                                </thead>
                                                <tbody>
                                                  {ALL_ARCHETYPES.filter(a => totals[a] > 0).map(a => (
                                                    <tr key={a} className="border-b border-gray-50 hover:bg-gray-50">
                                                      <td className="px-3 py-1.5 font-medium text-[11px]" style={{ color: ARCH_COLORS[a] }}>{a}</td>
                                                      {ENG_LEVELS.map(e => {
                                                        const cnt = matrix[a]?.[e] ?? 0
                                                        const pct = totals[a] > 0 ? Math.round((cnt / totals[a]) * 100) : 0
                                                        return (
                                                          <td key={e} className="text-center px-2 py-1.5">
                                                            {cnt > 0
                                                              ? <><span className="font-semibold text-gray-700">{cnt}</span><span className="text-[9px] text-gray-400 ml-0.5">{pct}%</span></>
                                                              : <span className="text-gray-200 text-[10px]">—</span>}
                                                          </td>
                                                        )
                                                      })}
                                                      <td className="text-right px-3 py-1.5 font-bold text-gray-600">{totals[a]}</td>
                                                    </tr>
                                                  ))}
                                                </tbody>
                                              </table>
                                            </div>
                                          </div>
                                        )
                                      })}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )}

                  {selectedPhases.size > 0 && phaseLoadingSet.size === 0 && pendingFetch.length === 0 && !hasData && (
                    <p className="text-xs text-gray-400 text-center py-4">No data returned for selected phases.</p>
                  )}
                  {selectedPhases.size === 0 && (
                    <p className="text-xs text-gray-400 text-center py-6">Select one or more phases above, then click Load to see user status breakdowns and trends.</p>
                  )}
                </div>
              )
            })()}
          </>
        )}
      </section>

      {/* Users results table */}
      {userStats.length > 0 && (
        <section className="bg-white rounded-2xl shadow p-5 flex flex-col" style={{ height: 'calc(100vh - 80px)', minHeight: '900px' }}>
          {/* Dropout summary bar */}
          {dropoutMap.size > 0 && (() => {
            const counts = { high: 0, medium: 0, low: 0 }
            for (const info of dropoutMap.values()) counts[info.level as keyof typeof counts]++
            const decreasedCount = [...crossPhaseMap.values()].filter(v => v.startsWith('dec-')).length
            const dropoutCrossCount = [...crossPhaseMap.values()].filter(v => v.startsWith('dropout-')).length
            return (
              <div className="shrink-0 mb-3 space-y-2">
                {/* Status chips */}
                <div className="flex flex-wrap items-center gap-2">
                  {([
                    ['all',       `All  ${userStats.length}`,            'bg-gray-100 text-gray-700 border-gray-300'],
                    ['high',      `High Eng.  ${counts.high}`,           'bg-emerald-100 text-emerald-700 border-emerald-300'],
                    ['medium',    `Med Eng.  ${counts.medium}`,          'bg-sky-100 text-sky-700 border-sky-300'],
                    ['low',       `Low Eng.  ${counts.low}`,             'bg-amber-100 text-amber-700 border-amber-300'],
                    ...(crossPhaseMap.size > 0 ? [
                      ['decreased', `Decreased  ${decreasedCount}`,  'bg-orange-100 text-orange-700 border-orange-300'] as [string, string, string],
                      ['dropout',   `Dropout  ${dropoutCrossCount}`,     'bg-rose-100 text-rose-700 border-rose-300'] as [string, string, string],
                    ] : []),
                  ] as [string, string, string][]).map(([status, label, cls]) => (
                    <button
                      key={status}
                      onClick={() => setDropoutStatusFilter(status as typeof dropoutStatusFilter)}
                      className={`text-xs px-3 py-1 rounded-full border font-semibold transition-colors ${cls} ${
                        dropoutStatusFilter === status ? 'ring-2 ring-offset-1 ring-gray-400' : 'opacity-70 hover:opacity-100'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="text-[10px] text-gray-400 ml-1">
                    end: {filterEndDate || '(max last_date)'}
                  </span>
                </div>
                {/* Criteria legend */}
                <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-[10px] text-gray-400">
                  <span><span className="text-emerald-600 font-medium">High</span> — ≥50% weeks active · msgs ≥ 20 × ⌈50% of phase weeks⌉</span>
                  <span><span className="text-sky-600 font-medium">Medium</span> — 20–49% weeks, or ≥50% weeks but below msg floor</span>
                  <span><span className="text-amber-600 font-medium">Low</span> — &lt;20% weeks active (regardless of message count)</span>
                  <span><span className="text-rose-500 font-medium">Dropout</span> — absent in current window vs prev phase</span>
                </div>
              </div>
            )
          })()}

          {/* Archetype filter chips — visible whenever archetypes have been computed */}
          {Object.keys(tablePersonas).length > 0 && (() => {
            const ALL_PERSONA_CHIPS = [
              { name: 'Contributor', cls: 'bg-blue-100 text-blue-800 border-blue-300' },
              { name: 'Explorer',    cls: 'bg-violet-100 text-violet-800 border-violet-300' },
              { name: 'Help-Seeker', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
              { name: 'Evangelist',  cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
              { name: 'Scrutinizer', cls: 'bg-rose-100 text-rose-800 border-rose-300' },
              { name: 'Suno Team',   cls: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300' },
            ]
            const ALL_SECONDARY_CHIPS = [
              { name: 'Evangelist',  cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
              { name: 'Scrutinizer', cls: 'bg-rose-100 text-rose-800 border-rose-300' },
              { name: 'None',        cls: 'bg-gray-100 text-gray-600 border-gray-300' },
            ]
            const archetypeCounts: Record<string, number> = {}
            const secondaryCounts: Record<string, number> = {}
            for (const [username, p] of Object.entries(tablePersonas)) {
              if (userStats.some(u => u.username === username)) {
                archetypeCounts[p.persona] = (archetypeCounts[p.persona] ?? 0) + 1
                const sec = p.secondary_persona ?? 'None'
                secondaryCounts[sec] = (secondaryCounts[sec] ?? 0) + 1
              }
            }
            const computedTotal = Object.values(archetypeCounts).reduce((s, c) => s + c, 0)
            const hasSecondary = ALL_SECONDARY_CHIPS.some(({ name }) => (secondaryCounts[name] ?? 0) > 0)
            return (
              <div className="shrink-0 mb-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wide shrink-0 w-20">Primary:</span>
                  <button
                    onClick={() => setArchetypeFilter('all')}
                    className={`text-xs px-3 py-1 rounded-full border font-semibold transition-colors bg-gray-100 text-gray-700 border-gray-300 ${archetypeFilter === 'all' ? 'ring-2 ring-offset-1 ring-gray-400' : 'opacity-70 hover:opacity-100'}`}
                  >
                    All · {computedTotal}
                  </button>
                  {ALL_PERSONA_CHIPS.filter(({ name }) => (archetypeCounts[name] ?? 0) > 0).map(({ name, cls }) => (
                    <button
                      key={name}
                      onClick={() => setArchetypeFilter(archetypeFilter === name ? 'all' : name)}
                      className={`text-xs px-3 py-1 rounded-full border font-semibold transition-colors ${cls} ${archetypeFilter === name ? 'ring-2 ring-offset-1 ring-gray-400' : 'opacity-70 hover:opacity-100'}`}
                    >
                      {name} · {archetypeCounts[name]}
                    </button>
                  ))}
                </div>
                {hasSecondary && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wide shrink-0 w-20">Secondary:</span>
                    <button
                      onClick={() => setSecondaryArchetypeFilter('all')}
                      className={`text-xs px-3 py-1 rounded-full border font-semibold transition-colors bg-gray-100 text-gray-700 border-gray-300 ${secondaryArchetypeFilter === 'all' ? 'ring-2 ring-offset-1 ring-gray-400' : 'opacity-70 hover:opacity-100'}`}
                    >
                      All
                    </button>
                    {ALL_SECONDARY_CHIPS.filter(({ name }) => (secondaryCounts[name] ?? 0) > 0).map(({ name, cls }) => (
                      <button
                        key={name}
                        onClick={() => setSecondaryArchetypeFilter(secondaryArchetypeFilter === name ? 'all' : name)}
                        className={`text-xs px-3 py-1 rounded-full border font-semibold transition-colors ${cls} ${secondaryArchetypeFilter === name ? 'ring-2 ring-offset-1 ring-gray-400' : 'opacity-70 hover:opacity-100'}`}
                      >
                        {name} · {secondaryCounts[name]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}


          {/* REFINE bar — always visible, never scrolls */}
          <div className="shrink-0 mb-3 bg-gray-50 rounded-xl border border-gray-200 px-4 py-3">
            <div className="flex flex-wrap gap-x-4 gap-y-2 items-end">
              <div className="flex flex-col gap-1">
                <label className="filter-label">Username</label>
                <input value={userNameFilter} onChange={(e) => setUserNameFilter(e.target.value)} placeholder="any" className="search-input text-xs py-1 w-32" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="filter-label">Active from</label>
                <input type="date" value={refineFirstMsgIn} onChange={(e) => setRefineFirstMsgIn(e.target.value)} className="search-input text-xs py-1" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="filter-label">Active until</label>
                <input type="date" value={refineLastMsgFrom} onChange={(e) => setRefineLastMsgFrom(e.target.value)} className="search-input text-xs py-1" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="filter-label">Min messages</label>
                <input type="text" inputMode="numeric" value={refineMinMessages} onChange={(e) => setRefineMinMessages(e.target.value.replace(/\D/g, ''))} placeholder="any" className="search-input text-xs py-1 w-20" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="filter-label">Max messages</label>
                <input type="text" inputMode="numeric" value={refineMaxMessages} onChange={(e) => setRefineMaxMessages(e.target.value.replace(/\D/g, ''))} placeholder="any" className="search-input text-xs py-1 w-20" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="filter-label">Min weeks</label>
                <input type="text" inputMode="numeric" value={refineMinWeeks} onChange={(e) => setRefineMinWeeks(e.target.value.replace(/\D/g, ''))} placeholder="any" className="search-input text-xs py-1 w-20" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="filter-label">Avg words ≥</label>
                <input type="text" inputMode="numeric" value={refineAvgWordsMin} onChange={(e) => setRefineAvgWordsMin(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="any" className="search-input text-xs py-1 w-20" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="filter-label">Avg words ≤</label>
                <input type="text" inputMode="numeric" value={refineAvgWordsMax} onChange={(e) => setRefineAvgWordsMax(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="any" className="search-input text-xs py-1 w-20" />
              </div>
              <span className="self-end pb-1 text-xs text-gray-500 ml-1">
                {filteredUsers.length.toLocaleString()}{filteredUsers.length !== userStats.length ? ` / ${userStats.length.toLocaleString()}` : ''} users
              </span>
              {(userNameFilter || refineFirstMsgIn || refineLastMsgFrom || refineMinMessages || refineMaxMessages || refineMinWeeks || refineAvgWordsMin || refineAvgWordsMax) && (
                <button
                  onClick={clearRefine}
                  className="self-end pb-1 text-xs text-gray-400 hover:text-red-500 transition-colors flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Batch persona classification toolbar */}
          {filteredUsers.length > 0 && (
            <div className="px-3 py-2 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Archetype</span>
                <span className="text-[10px] text-gray-400">
                  {(() => {
                    const matched = PHASE_DEFS.find(def =>
                      def.from === filterStartDate && (def.to === filterEndDate || (!def.to && !filterEndDate))
                    )
                    return matched
                      ? <span className={`font-semibold px-1.5 py-0.5 rounded border text-[9px] ${matched.chipCls}`}>{matched.label}</span>
                      : <span className="italic">{filterStartDate || 'all'} → {filterEndDate || 'present'}</span>
                  })()}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {batchSentimentRunning && (
                  <div className="flex items-center gap-1.5">
                    <div className="animate-spin w-3 h-3 border-2 border-emerald-400 border-t-transparent rounded-full" />
                    {sentimentProgress ? (
                      <span className="text-[10px] text-gray-500 tabular-nums">
                        <span className="font-semibold text-emerald-600">{sentimentProgress.msgs.toLocaleString()}</span>
                        {sentimentProgress.totalMsgs > 0
                          ? <span>/{sentimentProgress.totalMsgs.toLocaleString()}</span>
                          : null}
                        {' msgs · '}
                        <span className="font-semibold">{sentimentProgress.users}</span>/<span>{sentimentProgress.totalUsers}</span> users
                      </span>
                    ) : (
                      <span className="text-[10px] text-gray-500">Preparing…</span>
                    )}
                  </div>
                )}
                {batchPersonaClassifying && batchPersonaProgress && (
                  <div className="flex items-center gap-1.5">
                    <div className="animate-spin w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full" />
                    <span className="text-[10px] text-gray-500">
                      {batchPersonaProgress.done}/{batchPersonaProgress.total}
                      {batchPersonaProgress.errors > 0 && <span className="text-rose-500 ml-1">{batchPersonaProgress.errors} errors</span>}
                    </span>
                    {batchPersonaProgress.total > 1 && (
                      <div className="w-24 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-500 rounded-full transition-all"
                          style={{ width: `${(batchPersonaProgress.done / batchPersonaProgress.total) * 100}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
                {batchTopicRunning && batchTopicProgress && (
                  <div className="flex items-center gap-1.5">
                    <div className="animate-spin w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full" />
                    <span className="text-[10px] text-gray-500">
                      {batchTopicProgress.done}/{batchTopicProgress.total} topics
                      {batchTopicProgress.errors > 0 && <span className="text-rose-500 ml-1">{batchTopicProgress.errors} errors</span>}
                    </span>
                    {batchTopicProgress.total > 1 && (
                      <div className="w-24 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-amber-400 rounded-full transition-all"
                          style={{ width: `${(batchTopicProgress.done / batchTopicProgress.total) * 100}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
                {relabelAllProgress && (
                  <div className="flex items-center gap-1.5">
                    <div className="animate-spin w-3 h-3 border-2 border-amber-300 border-t-transparent rounded-full" />
                    <span className="text-[10px] text-gray-500">
                      🤖 {relabelAllProgress.done}/{relabelAllProgress.total} users relabeled
                      {relabelAllProgress.errors > 0 && <span className="text-rose-500 ml-1">{relabelAllProgress.errors} errors</span>}
                    </span>
                    {relabelAllProgress.total > 1 && (
                      <div className="w-24 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-amber-300 rounded-full transition-all"
                          style={{ width: `${(relabelAllProgress.done / relabelAllProgress.total) * 100}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-0.5">
                  <button
                    disabled={batchSentimentRunning || batchPersonaClassifying}
                    onClick={runBatchSentimentAll}
                    className="text-[10px] font-semibold px-2.5 py-1 rounded-l-lg bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50 transition-colors border border-emerald-200"
                    title={`Re-analyse all messages for ${filteredUsers.length} users`}
                  >
                    {batchSentimentRunning ? '⏳ ' : ''}All Sentiment ({filteredUsers.length})
                  </button>
                  <button
                    disabled={batchSentimentRunning || batchPersonaClassifying}
                    onClick={runBatchSentimentNew}
                    className="text-[10px] font-semibold px-2.5 py-1 rounded-r-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-100 disabled:opacity-50 transition-colors border border-emerald-200 border-l-0"
                    title={`Analyse only messages not yet in the database for ${filteredUsers.length} users`}
                  >
                    Sentiment (New Only)
                  </button>
                </div>
                <button
                  disabled={batchPersonaClassifying || batchSentimentRunning}
                  onClick={() => computeBatchArchetypes(filteredUsers)}
                  className="text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-indigo-100 text-indigo-700 hover:bg-indigo-200 disabled:opacity-50 transition-colors border border-indigo-200"
                  title={`Compute archetype (primary + secondary) for all ${filteredUsers.length} filtered users from stored signals — no LLM calls`}
                >
                  {batchPersonaClassifying ? '⏳ ' : ''}Archetypes ({filteredUsers.length})
                </button>
                <div className="flex items-center gap-0.5">
                  <button
                    disabled={batchTopicRunning || batchSentimentRunning || batchPersonaClassifying}
                    onClick={() => runBatchTopicForUsers(false)}
                    className="text-[10px] font-semibold px-2.5 py-1 rounded-l-lg bg-amber-100 text-amber-700 hover:bg-amber-200 disabled:opacity-50 transition-colors border border-amber-200"
                    title={`Run BERTopic analysis for all ${filteredUsers.length} users`}
                  >
                    {batchTopicRunning ? '⏳ ' : ''}All Topic ({filteredUsers.length})
                  </button>
                  <button
                    disabled={batchTopicRunning || batchSentimentRunning || batchPersonaClassifying}
                    onClick={() => runBatchTopicForUsers(true)}
                    className="text-[10px] font-semibold px-2.5 py-1 rounded-r-lg bg-amber-50 text-amber-600 hover:bg-amber-100 disabled:opacity-50 transition-colors border border-amber-200 border-l-0"
                    title={`Run BERTopic only for users not yet analyzed`}
                  >
                    Topic (New Only)
                  </button>
                </div>
                {(() => {
                  const usersWithTopics = filteredUsers.filter(u =>
                    (tableTopics[u.username]?.topics ?? []).some(tp => tp.id !== -1)
                  )
                  if (usersWithTopics.length === 0) return null
                  const isRunning = !!relabelAllProgress
                  return (
                    <button
                      disabled={isRunning || batchTopicRunning}
                      onClick={() => runRelabelAllUsers(
                        usersWithTopics.map(u => ({
                          username: u.username,
                          topicIds: (tableTopics[u.username]?.topics ?? []).filter(tp => tp.id !== -1).map(tp => tp.id),
                        })).filter(u => u.topicIds.length > 0)
                      )}
                      className="text-[10px] font-semibold px-2.5 py-1 rounded-lg border border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100 disabled:opacity-50 transition-colors"
                      title={`Relabel all topics for all ${usersWithTopics.length} users with AI`}
                    >
                      {isRunning ? '⏳' : '🤖'} Relabel All ({usersWithTopics.length})
                    </button>
                  )
                })()}
                {(() => {
                  const failedUsers = filteredUsers.filter(u => {
                    const t = tableTopics[u.username]
                    return t?.warning && (t.topics?.length ?? 0) > 0
                  })
                  if (failedUsers.length === 0) return null
                  return (
                    <button
                      onClick={() => setShowOnlyFailedTopics(v => !v)}
                      className={`text-[10px] font-semibold px-2.5 py-1 rounded-lg border transition-colors ${showOnlyFailedTopics ? 'bg-amber-500 text-white border-amber-500' : 'bg-amber-50 text-amber-600 border-amber-200 hover:bg-amber-100'}`}
                      title="Show only users where BERTopic clustering failed (keyword-fallback used)"
                    >
                      ⚠ Failed ({failedUsers.length})
                    </button>
                  )
                })()}
                {(() => {
                  const anomalyUsers = filteredUsers.filter(u => {
                    const topics = (tableTopics[u.username]?.topics ?? []).filter(tp => tp.id !== -1)
                    const topicCount = topics.length
                    const msgCount = u.total_messages ?? 0
                    return topicCount > 0 && msgCount > 0 && topicCount > msgCount
                  })
                  if (anomalyUsers.length === 0) return null
                  return (
                    <button
                      onClick={() => setShowOnlyAnomalyTopics(v => !v)}
                      className={`text-[10px] font-semibold px-2.5 py-1 rounded-lg border transition-colors ${showOnlyAnomalyTopics ? 'bg-orange-500 text-white border-orange-500' : 'bg-orange-50 text-orange-600 border-orange-200 hover:bg-orange-100'}`}
                      title="Show only users where topic count is suspiciously high relative to their message count"
                    >
                      ⚡ Anomaly ({anomalyUsers.length})
                    </button>
                  )
                })()}
              </div>
            </div>
          )}

          <div ref={userTableScrollRef} className="flex-1 overflow-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide select-none">
                  {(
                    [
                      { col: 'username', label: 'Username', cls: '' },
                      { col: 'total_messages', label: 'Messages', cls: 'text-right' },
                      { col: 'first_date', label: 'First Message', cls: '' },
                      { col: 'last_date', label: 'Last Message', cls: '' },
                      { col: 'avg_words', label: 'Avg Words', cls: 'text-right' },
                      { col: 'weeks_active', label: 'Weeks Active', cls: 'text-right' },
                      { col: 'pct_weeks', label: '% Weeks', cls: 'text-right' },
                    ] as { col: typeof userSortCol; label: string; cls: string }[]
                  ).map(({ col, label, cls }) => (
                    <th
                      key={col}
                      className={`px-3 py-2 border-b border-gray-200 cursor-pointer hover:text-gray-800 bg-gray-50 ${cls}`}
                      onClick={() => handleUserSortCol(col)}
                    >
                      {label} {userSortCol === col ? (userSortDir === 'asc' ? '↑' : '↓') : '↕'}
                    </th>
                  ))}
                  {dropoutMap.size > 0 && (
                    <th className="px-3 py-2 border-b border-gray-200 bg-gray-50">Status</th>
                  )}
                  <th className="px-3 py-2 border-b border-gray-200 bg-gray-50 text-center text-emerald-600 whitespace-nowrap">
                    Sentiment
                    {batchSentimentRunning && (
                      <span className="ml-1.5 inline-flex items-center gap-1 text-[9px] font-normal text-gray-400 align-middle">
                        <span className="inline-block w-2 h-2 border border-emerald-400 border-t-transparent rounded-full animate-spin" />
                        {sentimentProgress
                          ? sentimentProgress.totalMsgs > 0
                            ? `${sentimentProgress.msgs.toLocaleString()}/${sentimentProgress.totalMsgs.toLocaleString()} msgs`
                            : `${sentimentProgress.msgs.toLocaleString()} msgs`
                          : '…'}
                      </span>
                    )}
                  </th>
                  <th className="px-3 py-2 border-b border-gray-200 bg-gray-50 text-center text-amber-600 whitespace-nowrap">
                    Topics
                    {batchTopicRunning && (
                      <span className="ml-1.5 inline-flex items-center gap-1 text-[9px] font-normal text-gray-400 align-middle">
                        <span className="inline-block w-2 h-2 border border-amber-400 border-t-transparent rounded-full animate-spin" />
                        {batchTopicProgress ? `${batchTopicProgress.done}/${batchTopicProgress.total}` : '…'}
                      </span>
                    )}
                  </th>
                  <th className="px-3 py-2 border-b border-gray-200 bg-gray-50 text-center text-indigo-600">Archetype</th>
                </tr>
              </thead>
              <tbody>
                {sortedUsers.slice(0, visibleUserCount).map((u) => (
                  <Fragment key={u.username}>
                  <tr className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <button
                        onClick={() => openUserDetail(u)}
                        className="ubadge text-left hover:underline"
                        style={getUserStyle(u.username)}
                      >
                        {u.username}
                      </button>
                      {u.is_suno_team && (
                        <span className="ml-1.5 text-[10px] font-semibold bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full">Team</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{u.total_messages.toLocaleString()}</td>
                    <td className="px-3 py-2 text-xs text-gray-500 tabular-nums">{u.first_date?.replace('T', ' ').slice(0, 19)}</td>
                    <td className="px-3 py-2 text-xs text-gray-500 tabular-nums">{u.last_date?.replace('T', ' ').slice(0, 19)}</td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{u.avg_words?.toFixed(1) ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                      {u.weeks_active}/{u.total_weeks}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{u.pct_weeks?.toFixed(1) ?? '—'}%</td>
                    {dropoutMap.size > 0 && (() => {
                      const di = dropoutMap.get(u.username)
                      const cp = crossPhaseMap.get(u.username)
                      if (!di && !cp) return <td className="px-3 py-2" />
                      return (
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-0.5 items-start">
                            {di && (() => {
                              const sc = ENGAGEMENT_COLORS[di.level]
                              return (
                                <span
                                  className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${sc.bg} ${sc.text} border ${sc.border}`}
                                  title={`${di.pctWeeks}% of weeks active`}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                                  {{ high: 'High Eng.', medium: 'Med Eng.', low: 'Low Eng.' }[di.level] ?? di.level}
                                </span>
                              )
                            })()}
                            {cp === 'dec-hm' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 border border-orange-300 whitespace-nowrap" title="High → Medium engagement">↓ H→M</span>}
                            {cp === 'dec-hl' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 border border-orange-300 whitespace-nowrap" title="High → Low engagement">↓ H→L</span>}
                            {cp === 'dec-ml' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-600 border border-amber-300 whitespace-nowrap" title="Medium → Low engagement">↓ M→L</span>}
                            {cp === 'dropout-high' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-300 whitespace-nowrap" title="Was high-engagement in previous phase, now absent">↓ Out (High)</span>}
                            {cp === 'dropout-med'  && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-600 border border-rose-300 whitespace-nowrap" title="Was medium-engagement in previous phase, now absent">↓ Out (Med)</span>}
                            {cp === 'dropout-low'  && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-500 border border-rose-200 whitespace-nowrap" title="Was low-engagement in previous phase, now absent">↓ Out (Low)</span>}
                          </div>
                        </td>
                      )
                    })()}
                    {(() => {
                      const s = tableSentiments[u.username]
                      if (!s) return (
                        <td className="px-2 py-2 text-center">
                          {batchSentimentRunning
                            ? <span className="inline-block w-3 h-3 border-2 border-emerald-300 border-t-transparent rounded-full animate-spin" />
                            : <span className="text-gray-300 text-[10px]">—</span>}
                        </td>
                      )
                      const isOpen = sentimentDetailUser === u.username
                      const dominant = s.positive >= s.negative && s.positive >= s.neutral ? 'positive'
                        : s.negative >= s.neutral ? 'negative' : 'neutral'
                      const domColor = dominant === 'positive' ? '#10b981' : dominant === 'negative' ? '#f43f5e' : '#9ca3af'
                      const domBg = dominant === 'positive' ? '#d1fae5' : dominant === 'negative' ? '#ffe4e6' : '#f3f4f6'
                      const pos = Math.round(s.positive * 100)
                      const neg = Math.round(s.negative * 100)
                      const neu = 100 - pos - neg
                      const topLabel = s.top_emotions?.[0]?.label ?? null
                      return (
                        <td className="px-2 py-2 min-w-[96px]">
                          {/* Sentiment breakdown bar */}
                          <div className="flex h-2 w-full rounded-full overflow-hidden mb-1">
                            {pos > 0 && <div style={{ width: `${pos}%` }} className="bg-emerald-400" />}
                            {neg > 0 && <div style={{ width: `${neg}%` }} className="bg-rose-400" />}
                            {neu > 0 && <div style={{ width: `${neu}%` }} className="bg-gray-300" />}
                          </div>
                          {/* Percentage row */}
                          <div className="flex justify-between text-[9px] tabular-nums mb-1">
                            <span className="text-emerald-600">{pos}%</span>
                            <span className="text-rose-500">{neg}%</span>
                            <span className="text-gray-400">{neu}%</span>
                          </div>
                          {/* Dominant badge + top emotion — clickable to expand */}
                          <button
                            onClick={() => setSentimentDetailUser(prev => prev === u.username ? null : u.username)}
                            className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity w-full"
                            title={`Click to ${isOpen ? 'collapse' : 'expand'} sentiment detail`}
                          >
                            <span
                              className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full capitalize whitespace-nowrap"
                              style={{ color: domColor, backgroundColor: domBg }}
                            >
                              {dominant}
                            </span>
                            {topLabel && (
                              <span
                                className="text-[9px] truncate"
                                style={{ color: emotionSentimentColor(topLabel) }}
                              >
                                {topLabel}
                              </span>
                            )}
                          </button>
                        </td>
                      )
                    })()}
                    {(() => {
                      const t = tableTopics[u.username]
                      const isAnalyzing = batchTopicCurrentUser === u.username
                      if (isAnalyzing) return (
                        <td className="px-2 py-2 text-center">
                          <span className="inline-block w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                        </td>
                      )
                      if (!t) return (
                        <td className="px-2 py-2 text-center">
                          <span className="text-gray-300 text-[10px]">—</span>
                        </td>
                      )
                      const nonOutlier = t.topics.filter(tp => tp.id !== -1)
                      const topicCount = nonOutlier.length
                      const topLabel = nonOutlier[0]?.label ?? null
                      const isOpen = topicDetailUser === u.username
                      return (
                        <td className="px-2 py-2 text-center">
                          <button
                            onClick={() => setTopicDetailUser(prev => prev === u.username ? null : u.username)}
                            className="flex flex-col items-center gap-0.5 cursor-pointer hover:opacity-80 transition-opacity w-full"
                            title={`${topicCount} topic${topicCount !== 1 ? 's' : ''} · click to ${isOpen ? 'collapse' : 'expand'}`}
                          >
                            <span className="text-[11px] font-semibold text-amber-700 tabular-nums">
                              {topicCount} topic{topicCount !== 1 ? 's' : ''}
                            </span>
                            {topLabel && (
                              <span className="text-[9px] text-amber-500 truncate max-w-[80px]">{topLabel}</span>
                            )}
                          </button>
                        </td>
                      )
                    })()}
                    {(() => {
                      const a = tablePersonas[u.username]
                      const PERSONA_BG: Record<string, string> = {
                        'Suno Team':         'bg-fuchsia-100 text-fuchsia-700',
                        'Power Contributor': 'bg-blue-100 text-blue-700',
                        'Help-Seeker':       'bg-amber-100 text-amber-700',
                        'Evangelist':        'bg-emerald-100 text-emerald-700',
                        'Scrutinizer':       'bg-rose-100 text-rose-700',
                        'Casual Explorer':   'bg-violet-100 text-violet-700',
                      }
                      return (
                        <td className="px-2 py-2 text-center">
                          {a ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span
                                className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full cursor-help whitespace-nowrap leading-tight ${PERSONA_BG[a.persona] ?? 'bg-gray-100 text-gray-600'}`}
                                title={`${Math.round(a.confidence * 100)}% confidence\n${a.reasoning}`}
                              >
                                {a.persona}
                              </span>
                              {a.secondary_persona && (
                                <span
                                  className={`inline-block text-[9px] font-medium px-1.5 py-0 rounded-full opacity-70 ${PERSONA_BG[a.secondary_persona] ?? 'bg-gray-100 text-gray-600'}`}
                                  title={`Secondary: ${Math.round((a.secondary_confidence ?? 0) * 100)}%`}
                                >
                                  +{a.secondary_persona}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-gray-300 text-[10px]">—</span>
                          )}
                        </td>
                      )
                    })()}
                  </tr>
                  {sentimentDetailUser === u.username && tableSentiments[u.username] && (() => {
                    const s = tableSentiments[u.username]
                    return (
                      <tr className="bg-emerald-50/30 border-b border-emerald-100">
                        <td colSpan={20} className="px-4 py-3">
                          <div className="grid grid-cols-3 gap-3">
                            {(['positive', 'negative', 'neutral'] as const).map(bucket => {
                              const b = s.by_sentiment?.[bucket]
                              const count = b?.count ?? 0
                              const total = s.analyzed
                              const pct = total > 0 ? Math.round(count / total * 100) : 0
                              const color = bucket === 'positive' ? '#10b981' : bucket === 'negative' ? '#f43f5e' : '#9ca3af'
                              const bgCls = bucket === 'positive' ? 'bg-emerald-50' : bucket === 'negative' ? 'bg-rose-50' : 'bg-gray-50'
                              return (
                                <div key={bucket} className={`${bgCls} rounded-lg p-2.5 border`} style={{ borderColor: color + '40' }}>
                                  <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[11px] font-semibold capitalize" style={{ color }}>{bucket}</span>
                                    <span className="text-[10px] text-gray-500">{count} msgs · {pct}%</span>
                                  </div>
                                  {(b?.top_emotions ?? []).length > 0 ? (
                                    <div className="flex flex-wrap gap-1">
                                      {(b?.top_emotions ?? []).map(e => (
                                        <span
                                          key={e.label}
                                          className="text-[9px] px-1.5 py-0.5 rounded-full text-white"
                                          style={{ backgroundColor: emotionSentimentColor(e.label) }}
                                        >
                                          {e.label} {Math.round(e.score * 100)}%
                                        </span>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-[9px] text-gray-300">—</span>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                          <div className="mt-1.5 text-[9px] text-gray-400">{s.analyzed} messages analyzed · click badge to collapse</div>
                        </td>
                      </tr>
                    )
                  })()}
                  {topicDetailUser === u.username && tableTopics[u.username] && (() => {
                    const t = tableTopics[u.username]
                    const visibleTopics = t.topics.filter(tp => tp.id !== -1)
                    const relabelingSet = relabelingInTable[u.username] ?? new Set<number>()
                    const anyRelabeling = relabelingSet.size > 0
                    return (
                      <tr className="bg-amber-50/30 border-b border-amber-100">
                        <td colSpan={20} className="px-4 py-3">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-[11px] font-semibold text-amber-700">
                              {visibleTopics.length} topic{visibleTopics.length !== 1 ? 's' : ''} · {t.filtered_docs} / {t.total_docs} messages assigned
                            </span>
                            {t.warning && (
                              <span className="text-[10px] text-amber-500 italic">⚠ {t.warning}</span>
                            )}
                            {visibleTopics.length > 0 && (
                              <button
                                disabled={anyRelabeling}
                                onClick={() => relabelAllTopicsInTable(u.username, visibleTopics.map(tp => tp.id))}
                                className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-700 hover:bg-amber-200 disabled:opacity-50 transition-colors border border-amber-200 shrink-0"
                                title="Relabel all topics for this user with AI (diverse sample per cluster)"
                              >
                                {anyRelabeling ? '⏳ Relabeling…' : '🤖 Relabel All'}
                              </button>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
                            {visibleTopics.map(tp => {
                              const isRelabeling = relabelingSet.has(tp.id)
                              return (
                                <div key={tp.id} className="bg-white rounded-lg p-2 border border-amber-100 flex flex-col gap-1">
                                  <div className="flex items-start justify-between gap-1">
                                    <span className="text-[11px] font-semibold text-amber-800 leading-snug">{tp.label}</span>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <span className="text-[10px] text-gray-400">{tp.message_count}m</span>
                                      <button
                                        disabled={isRelabeling}
                                        onClick={() => relabelTopicInTable(u.username, tp.id)}
                                        className="text-[10px] px-1 py-0.5 rounded bg-amber-50 text-amber-600 hover:bg-amber-100 disabled:opacity-40 transition-colors border border-amber-200"
                                        title={`Relabel "${tp.label}" with AI (${tp.message_count} msgs in cluster)`}
                                      >
                                        {isRelabeling ? '⏳' : '🤖'}
                                      </button>
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {tp.keywords.slice(0, 8).map(kw => (
                                      <span key={kw} className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">{kw}</span>
                                    ))}
                                  </div>
                                  <button
                                    onClick={() => openStatsTopicModal(u.username, tp.id, tp.label, tp.keywords, tp.message_count, filterStartDate, filterEndDate, scopeParam)}
                                    className="mt-1 flex items-center gap-1 text-[10px] text-violet-600 hover:text-violet-800 font-medium transition-colors"
                                  >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                                    </svg>
                                    View all {tp.message_count} messages
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                          <div className="mt-1.5 text-[9px] text-gray-400">click topic count to collapse</div>
                        </td>
                      </tr>
                    )
                  })()}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {sortedUsers.length === 0 && (
              <p className="text-center text-sm text-gray-400 py-6">No users match the current filters.</p>
            )}
            {visibleUserCount < sortedUsers.length && (
              <div ref={setUserTableSentinelEl} className="h-8 flex items-center justify-center">
                <span className="text-xs text-gray-300">↓ scroll to load more</span>
              </div>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-3">
            {sortedUsers.length > 0
              ? <>Showing {Math.min(visibleUserCount, sortedUsers.length).toLocaleString()} of {sortedUsers.length.toLocaleString()} users · scroll to load more · Click a username to open their message detail view.</>
              : 'Click a username to open their message detail view.'}
          </p>
        </section>
      )}

      {/* Flow Analysis user detail modal */}
      {flowModal && (() => {
        const cols: { key: typeof flowModalSortCol; label: string }[] = [
          { key: 'username',       label: 'Username'     },
          { key: 'total_messages', label: 'Messages'     },
          { key: 'weeks_active',   label: 'Active Weeks' },
          { key: 'pct_weeks',      label: '% Weeks'      },
          { key: 'avg_words',      label: 'Avg Words'    },
        ]
        const sorted = [...flowModal.users].sort((a, b) => {
          const av = a[flowModalSortCol] ?? (flowModalSortCol === 'username' ? '' : -1)
          const bv = b[flowModalSortCol] ?? (flowModalSortCol === 'username' ? '' : -1)
          if (typeof av === 'string' && typeof bv === 'string')
            return flowModalSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
          return flowModalSortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
        })
        const toggleSort = (col: typeof flowModalSortCol) => {
          if (flowModalSortCol === col) setFlowModalSortDir(d => d === 'asc' ? 'desc' : 'asc')
          else { setFlowModalSortCol(col); setFlowModalSortDir(col === 'username' ? 'asc' : 'desc') }
        }
        const SortIcon = ({ col }: { col: typeof flowModalSortCol }) =>
          flowModalSortCol === col
            ? <span className="ml-0.5 opacity-60">{flowModalSortDir === 'asc' ? '↑' : '↓'}</span>
            : <span className="ml-0.5 opacity-20">↕</span>
        const statusBadge = (s: EngagementLevel | 'no-data' | null) => {
          if (!s) return <span className="text-[10px] text-gray-400">—</span>
          if (s === 'no-data') return <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-gray-100 text-gray-400">No Data</span>
          const cls = { high: 'bg-emerald-100 text-emerald-700', medium: 'bg-sky-100 text-sky-700', low: 'bg-amber-100 text-amber-700' }[s]
          const label = { high: 'High Eng.', medium: 'Med Eng.', low: 'Low Eng.' }[s] ?? s
          return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${cls}`}>{label}</span>
        }
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onClick={() => setFlowModal(null)}
          >
            <div
              className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4 flex flex-col overflow-hidden"
              style={{ maxHeight: '80vh' }}
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
                <div>
                  <h3 className="font-semibold text-gray-800 text-sm">{flowModal.title}</h3>
                  <p className="text-[10px] text-gray-400 mt-0.5">{flowModal.users.length} user{flowModal.users.length !== 1 ? 's' : ''}</p>
                </div>
                <button onClick={() => setFlowModal(null)} className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded-lg hover:bg-gray-100">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* Table */}
              <div className="overflow-y-auto">
                {flowModal.users.length === 0
                  ? <p className="text-sm text-gray-400 italic text-center py-8">No users</p>
                  : (
                    <table className="w-full text-xs border-collapse">
                      <thead className="sticky top-0 bg-gray-50 z-10">
                        <tr className="border-b border-gray-200 text-[11px]">
                          <th className="px-3 py-2 text-left text-gray-500 font-semibold w-6 tabular-nums">#</th>
                          {cols.map(c => (
                            <th
                              key={c.key}
                              className={`px-3 py-2 font-semibold text-gray-600 cursor-pointer select-none hover:bg-gray-100 ${c.key === 'username' ? 'text-left' : 'text-right'}`}
                              onClick={() => toggleSort(c.key)}
                            >
                              {c.label}<SortIcon col={c.key} />
                            </th>
                          ))}
                          <th className="px-3 py-2 font-semibold text-gray-600 text-center">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((u, idx) => (
                          <tr key={u.username} className="border-b border-gray-100 hover:bg-gray-50">
                            <td className="px-3 py-2 text-gray-400 tabular-nums text-[10px]">{idx + 1}</td>
                            <td className="px-3 py-2">
                              <button
                                onClick={() => {
                                  const found = [...Object.values(phaseData)].flat().find(x => x.username === u.username)
                                  if (found) openUserDetail(found)
                                  setFlowModal(null)
                                }}
                                className="font-semibold hover:underline text-left"
                                style={getUserStyle(u.username)}
                              >
                                {u.username}
                              </button>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-700 font-semibold">{u.status === 'no-data' ? <span className="text-gray-300">—</span> : u.total_messages}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-600">{u.status === 'no-data' ? <span className="text-gray-300">—</span> : u.weeks_active != null ? <span>{u.weeks_active}<span className="text-gray-400">/{flowModal.totalWeeks ?? '?'}</span></span> : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-600">{u.status === 'no-data' ? <span className="text-gray-300">—</span> : (u.pct_weeks != null ? `${u.pct_weeks}%` : '—')}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-500">{u.status === 'no-data' ? <span className="text-gray-300">—</span> : (u.avg_words != null ? u.avg_words.toFixed(1) : '—')}</td>
                            <td className="px-3 py-2 text-center">{statusBadge(u.status)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                }
              </div>
            </div>
          </div>
        )
      })()}

      {/* Stats-table topic messages modal (rendered here so it works without a selected user) */}
      {statsTopicModal !== null && (() => {
        const colors = [
          'bg-violet-600','bg-indigo-600','bg-blue-600','bg-cyan-600',
          'bg-teal-600','bg-emerald-600','bg-amber-600','bg-orange-600',
          'bg-rose-600','bg-gray-600',
        ]
        const accentColor = colors[Math.abs(statsTopicModal.topicId) % colors.length]
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            onClick={() => setStatsTopicModal(null)}
          >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div
              className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className={`${accentColor} px-5 py-4 flex items-start justify-between gap-3`}>
                <div>
                  <p className="text-white/70 text-[11px] font-medium uppercase tracking-wide mb-0.5">
                    {statsTopicModal.username} · Topic #{statsTopicModal.topicId}
                  </p>
                  <h3 className="text-white font-semibold text-base leading-snug">
                    {statsTopicModal.label}
                  </h3>
                  {statsTopicModal.keywords.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {statsTopicModal.keywords.slice(0, 6).map(kw => (
                        <span key={kw} className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/20 text-white font-medium">{kw}</span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setStatsTopicModal(null)}
                  className="text-white/80 hover:text-white transition-colors shrink-0 mt-0.5"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="px-5 py-2 border-b border-gray-100 bg-gray-50">
                <span className="text-xs text-gray-500">
                  {statsTopicLoading
                    ? 'Loading messages…'
                    : `${statsTopicMessages.length.toLocaleString()} message${statsTopicMessages.length !== 1 ? 's' : ''}`
                  }
                </span>
              </div>
              <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
                {statsTopicLoading ? (
                  <p className="text-sm text-gray-400 text-center py-10">Loading…</p>
                ) : statsTopicMessages.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-10">No messages found.</p>
                ) : (
                  statsTopicMessages.map((msg, i) => (
                    <TopicMsgRow
                      key={msg.id ?? i}
                      msg={msg}
                      isBookmarked={bookmarkedIds.has(msg.id)}
                      onBookmarkToggle={handleBookmarkToggle}
                      ctxBefore={userDetailCtxBefore}
                      ctxAfter={userDetailCtxAfter}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )
      })()}

    </div>
  )
}
