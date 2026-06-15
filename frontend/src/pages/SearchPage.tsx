import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import ReactMarkdown from 'react-markdown'
import { apiFetch, streamEvents } from '../api/client'
import { useSearchStore } from '../store/searchStore'
import { useAuthStore } from '../store/authStore'
import { getUserStyle, getUserColor, highlightText, highlightTerms } from '../utils/colors'
import type { Message, Upload, UserInRange, Stats, UserTopicsResult, TopicPipelineStep, EmotionResult, EmotionTimeline } from '../types'

const POSITIVE_EMOTION_SET = new Set([
  'admiration','amusement','approval','caring','excitement',
  'gratitude','joy','love','optimism','pride','relief',
])
const NEGATIVE_EMOTION_SET = new Set([
  'anger','annoyance','disappointment','disapproval','disgust',
  'embarrassment','fear','grief','nervousness','remorse','sadness',
])
const emotionSentimentColor = (label: string) =>
  POSITIVE_EMOTION_SET.has(label) ? '#10b981'
  : NEGATIVE_EMOTION_SET.has(label) ? '#f43f5e'
  : '#9ca3af'

const TOPIC_COLORS = [
  '#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6',
  '#8b5cf6','#ef4444','#14b8a6','#f97316','#84cc16',
]

function heatmapColor(positive: number, negative: number, neutral: number, maxCount: number): string {
  const total = positive + negative + neutral
  if (total === 0) return '#f3f4f6'
  const score = (positive - negative) / total
  const alpha = Math.min(0.18 + (total / maxCount) * 0.72, 0.92)
  if (score > 0.12) return `rgba(16,185,129,${alpha.toFixed(2)})`
  if (score < -0.12) return `rgba(244,63,94,${alpha.toFixed(2)})`
  return `rgba(107,114,128,${alpha.toFixed(2)})`
}

type SearchTab = 'keyword' | 'semantic' | 'username' | 'range' | 'browse'
type MatchType = 'fuzzy' | 'exact' | 'any'
type SearchCat = 'chat' | 'users'
type TrendBucket = 'month' | 'week' | 'day'
type AnalysisTab = 'none' | 'summarize' | 'viz'
type FilterMode = 'exact' | 'any' | 'fuzzy' | 'semantic'

interface TrendPoint {
  period: string
  count: number
  from: string
  to: string
}

interface SrLogEntry {
  step: string
  label: string
  msg: string
}

const LOG_ICONS: Record<string, string> = {
  filter: '🔍',
  retrieval: '📡',
  dedup: '🧹',
  cluster: '🔮',
  sample: '🎯',
  llm: '✨',
  fallback: '⚠️',
  meta: '📅',
  instruction: '📝',
}

function UsernameTag({ username }: { username: string }) {
  return (
    <span className="ubadge text-xs font-semibold" style={getUserStyle(username)}>
      {username}
    </span>
  )
}

// Discord timestamps are stored as UTC strings ("YYYY-MM-DD HH:MM:SS" or ISO).
// Parse as UTC and display in the browser's local timezone with seconds + tz abbrev.
function formatMsgDate(raw: string | undefined): string {
  if (!raw) return ''
  const normalized = raw.trim().replace(' ', 'T')
  const iso = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : normalized + 'Z'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return raw.slice(0, 19).replace('T', ' ')
  return d.toLocaleString('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short', hour12: false,
  })
}

interface MessageCardProps {
  msg: Message
  keyword: string
  tokens: string[]
  isBookmarked: boolean
  isSelected: boolean
  onBookmarkToggle: (msg: Message) => void
  onSelectToggle: (id: number) => void
  ctxBefore: number
  ctxAfter: number
  isGrouped?: boolean
}

function MessageCard({ msg, keyword, tokens, isBookmarked, isSelected, onBookmarkToggle, onSelectToggle, ctxBefore, ctxAfter, isGrouped = false }: MessageCardProps) {
  const [copied, setCopied] = useState(false)
  const [ctxOpen, setCtxOpen] = useState(false)
  const [ctxMessages, setCtxMessages] = useState<Message[]>([])
  const [ctxLoading, setCtxLoading] = useState(false)

  const [, textColor] = getUserColor(msg.username)
  const initials = (msg.username || '?').slice(0, 2).toUpperCase()

  const highlighted = tokens.length > 0
    ? highlightTerms(msg.content, tokens)
    : keyword
      ? highlightText(msg.content, keyword)
      : msg.content

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleCtxToggle = async () => {
    if (ctxOpen) { setCtxOpen(false); return }
    setCtxLoading(true)
    setCtxOpen(true)
    try {
      const data = await apiFetch<Message[]>(`/context/${msg.id}?before=${ctxBefore}&after=${ctxAfter}`)
      setCtxMessages(data)
    } catch { } finally { setCtxLoading(false) }
  }

  const rowBg = isBookmarked
    ? 'bg-amber-50 border-l-4 border-amber-300'
    : 'hover:bg-gray-50 border-l-4 border-transparent'

  return (
    <div id={`card-${msg.id}`} className={`group flex gap-3 px-2 py-1 rounded-lg transition-colors ${rowBg} ${isGrouped ? 'mt-0' : 'mt-3'}`}>
      {/* Avatar column */}
      <div className="w-8 shrink-0 pt-0.5 flex flex-col items-center">
        {!isGrouped && (
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold select-none"
            style={{ background: textColor }}
          >
            {initials}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {!isGrouped && (
          <div className="flex items-baseline gap-2 flex-wrap mb-0.5">
            <UsernameTag username={msg.username} />
            <span className="text-xs text-gray-400 tabular-nums">{formatMsgDate(msg.date)}</span>
            {(msg.is_suno_team === 'True' || msg.is_suno_team === true || msg.is_suno_team === '1') && (
              <span className="text-[10px] font-semibold bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full">Suno Team</span>
            )}
            {msg.similarity != null && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-600 border border-indigo-200 px-1.5 py-0.5 rounded-full tabular-nums">
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                {(msg.similarity * 100).toFixed(1)}%
              </span>
            )}
          </div>
        )}

        <p
          className="text-sm text-gray-800 whitespace-pre-wrap break-words leading-relaxed"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />

        {/* Action buttons — horizontal row below text, fade in on hover */}
        <div className="flex items-center gap-0.5 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onBookmarkToggle(msg)}
            className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-lg transition-colors whitespace-nowrap ${isBookmarked ? 'text-amber-600 hover:bg-amber-100' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
            title={isBookmarked ? 'Remove bookmark' : 'Save bookmark'}
          >
            {isBookmarked ? (
              <svg className="w-3 h-3 text-amber-500 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
            ) : (
              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
            )}
            <span>{isBookmarked ? 'Bookmarked' : 'Bookmark'}</span>
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600 whitespace-nowrap"
          >
            {copied ? (
              <svg className="w-3 h-3 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            ) : (
              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            )}
            <span>{copied ? 'Copied!' : 'Copy'}</span>
          </button>
          <button
            onClick={handleCtxToggle}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600 whitespace-nowrap"
          >
            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
            <span>View context</span>
          </button>
        </div>

        {ctxOpen && (
          <div className="mt-2 border-t border-gray-100 pt-2">
            {ctxLoading ? (
              <p className="text-xs text-gray-400 text-center py-2">Loading context…</p>
            ) : (
              <div className="space-y-1">
                {ctxMessages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex gap-2 text-xs px-2 py-1 rounded ${m.id === msg.id ? 'bg-amber-50 border border-amber-200' : 'bg-gray-50'}`}
                  >
                    <span className="shrink-0 font-semibold" style={getUserStyle(m.username)}>{m.username}</span>
                    <span className="text-gray-400 shrink-0">{formatMsgDate(m.date)}</span>
                    <span className="text-gray-700 flex-1">{m.content}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Chat-style row for Browse All ---
function BrowseChatRow({
  msg,
  isGrouped,
  isBookmarked,
  onBookmarkToggle,
  tokens = [],
}: {
  msg: Message
  isGrouped: boolean
  isBookmarked: boolean
  onBookmarkToggle: (msg: Message) => void
  tokens?: string[]
}) {
  const [copied, setCopied] = useState(false)
  const [, textColor] = getUserColor(msg.username)
  const initials = (msg.username || '?').slice(0, 2).toUpperCase()

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const rowBg = isBookmarked
    ? 'bg-amber-50 border-l-4 border-amber-300'
    : 'hover:bg-gray-50 border-l-4 border-transparent'

  return (
    <div className={`group flex gap-3 px-2 py-1 rounded-lg transition-colors ${rowBg} ${isGrouped ? 'mt-0' : 'mt-3'}`}>
      {/* Avatar column — 32 px wide always so messages align */}
      <div className="w-8 shrink-0 flex flex-col items-center pt-0.5">
        {!isGrouped && (
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold select-none"
            style={{ background: textColor }}
          >
            {initials}
          </div>
        )}
      </div>

      {/* Message body */}
      <div className="flex-1 min-w-0">
        {!isGrouped && (
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="text-sm font-semibold" style={{ color: textColor }}>{msg.username}</span>
            <span className="text-xs text-gray-400 tabular-nums">{formatMsgDate(msg.date)}</span>
            {(msg.is_suno_team === 'True' || msg.is_suno_team === true || msg.is_suno_team === '1') && (
              <span className="text-[10px] font-semibold bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full">Suno Team</span>
            )}
          </div>
        )}
        <p
          className="text-sm text-gray-800 whitespace-pre-wrap break-words leading-relaxed"
          dangerouslySetInnerHTML={{ __html: tokens.length > 0 ? highlightTerms(msg.content, tokens) : msg.content }}
        />

        {/* Action buttons — horizontal row below text, fade in on hover */}
        <div className="flex items-center gap-0.5 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onBookmarkToggle(msg)}
            className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-lg transition-colors whitespace-nowrap ${isBookmarked ? 'text-amber-600 hover:bg-amber-100' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
            title={isBookmarked ? 'Remove bookmark' : 'Bookmark'}
          >
            {isBookmarked ? (
              <svg className="w-3 h-3 text-amber-500 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
            ) : (
              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
            )}
            <span>{isBookmarked ? 'Bookmarked' : 'Bookmark'}</span>
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600 whitespace-nowrap"
            title="Copy message"
          >
            {copied ? (
              <svg className="w-3 h-3 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            ) : (
              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            )}
            <span>{copied ? 'Copied!' : 'Copy'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Client-side filter helpers ---

function fuzzyMatch(text: string, pattern: string): boolean {
  // Each char in pattern must appear in text in order
  let pi = 0
  const lText = text.toLowerCase()
  const lPat = pattern.toLowerCase()
  for (let i = 0; i < lText.length && pi < lPat.length; i++) {
    if (lText[i] === lPat[pi]) pi++
  }
  return pi === lPat.length
}

function applyExactFilter(messages: Message[], term: string): Message[] {
  if (!term.trim()) return messages
  const words = term.trim().toLowerCase().split(/\s+/)
  return messages.filter((m) => {
    const lc = m.content.toLowerCase()
    return words.every((w) => lc.includes(w))
  })
}

function applyAnyFilter(messages: Message[], term: string): Message[] {
  if (!term.trim()) return messages
  const words = term.trim().toLowerCase().split(/\s+/)
  return messages.filter((m) => {
    const lc = m.content.toLowerCase()
    return words.some((w) => lc.includes(w))
  })
}

function applyFuzzyFilter(messages: Message[], term: string): Message[] {
  if (!term.trim()) return messages
  const words = term.trim().split(/\s+/)
  return messages.filter((m) =>
    words.every((w) => fuzzyMatch(m.content, w))
  )
}

function computeFilterTokens(mode: FilterMode, term: string): string[] {
  if (!term.trim()) return []
  const words = term.trim().split(/\s+/).filter(Boolean)
  if (mode === 'exact') {
    return words.length > 1 ? [term.trim(), ...words] : [term.trim()]
  }
  if (mode === 'any' || mode === 'fuzzy') {
    return words
  }
  // semantic: no highlighting
  return []
}

// Returns the Monday date string (YYYY-MM-DD) for any date
function getMondayKey(dateStr: string): string {
  const d = new Date(dateStr)
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}

// --- Dropout analysis helpers ---

type DropoutStatus = 'active' | 'dropout' | 'transient'
type DropoutTier = 'recent' | 'faded' | 'gone'
interface DropoutInfo { status: DropoutStatus; silenceDays: number; tier?: DropoutTier; activeSpan: number }

function daysBetween(dateA: string, dateB: string): number {
  return Math.round((new Date(dateB).getTime() - new Date(dateA).getTime()) / 86400000)
}

function computeDropout(
  u: UserInRange,
  filterEnd: string,
  silenceThreshold: number,
  transientMinMessages: number,
  transientMinActiveDays: number,
  activeMinMessages: number,
  activeMinWeeks: number,
): DropoutInfo {
  const silenceDays = u.last_date ? daysBetween(u.last_date.slice(0, 10), filterEnd) : 9999
  const activeSpan = (u.first_date && u.last_date)
    ? daysBetween(u.first_date.slice(0, 10), u.last_date.slice(0, 10))
    : 0
  // Never meaningfully engaged → transient (low-engagement / burst / one-time)
  if (u.total_messages < transientMinMessages || activeSpan < transientMinActiveDays) {
    return { status: 'transient', silenceDays, activeSpan }
  }
  // Engaged but doesn't meet the "active" bar → still transient
  if (u.total_messages < activeMinMessages || (u.weeks_active ?? 0) < activeMinWeeks) {
    return { status: 'transient', silenceDays, activeSpan }
  }
  // Meaningfully engaged and now silent → dropout
  if (silenceDays >= silenceThreshold) {
    const tier: DropoutTier = silenceDays < 60 ? 'recent' : silenceDays < 90 ? 'faded' : 'gone'
    return { status: 'dropout', silenceDays, tier, activeSpan }
  }
  // Meaningfully engaged and still posting → active
  return { status: 'active', silenceDays, activeSpan }
}

const STATUS_COLORS: Record<DropoutStatus, { bg: string; text: string; dot: string; border: string }> = {
  active:    { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500', border: 'border-emerald-200' },
  dropout:   { bg: 'bg-rose-50',    text: 'text-rose-700',    dot: 'bg-rose-500',    border: 'border-rose-200'    },
  transient: { bg: 'bg-amber-50',   text: 'text-amber-600',   dot: 'bg-amber-400',   border: 'border-amber-200'   },
}

// --- Main component ---

// Safe sessionStorage helpers
function ssGet<T>(key: string, fallback: T): T {
  try { const v = sessionStorage.getItem(key); return v !== null ? (JSON.parse(v) as T) : fallback } catch { return fallback }
}
function ssSet(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)) } catch {}
}

const SEARCHING_MESSAGES = [
  'Scanning the archives…',
  'Hunting through thousands of messages…',
  'Finding the signal in the noise…',
  'Sifting through the data…',
  'Turning over every stone…',
  'Almost there…',
]

function SearchingAnimation() {
  const [msgIdx, setMsgIdx] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setMsgIdx((i) => (i + 1) % SEARCHING_MESSAGES.length), 1800)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="bg-white rounded-2xl shadow px-6 py-12 flex flex-col items-center gap-5">
      <div className="relative w-14 h-14">
        <div className="absolute inset-0 rounded-full border-[3px] border-gray-100" />
        <div
          className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-indigo-500 border-r-indigo-300 animate-spin"
          style={{ animationDuration: '0.85s' }}
        />
      </div>
      <p
        key={msgIdx}
        className="text-sm font-medium text-gray-500 tracking-wide"
      >
        {SEARCHING_MESSAGES[msgIdx]}
      </p>
    </div>
  )
}

function mergeEmotionResults(a: EmotionResult, b: EmotionResult): EmotionResult {
  const perMessage = [...a.per_message, ...b.per_message]
  const sentCounts = { positive: 0, negative: 0, neutral: 0 }
  for (const m of perMessage) sentCounts[m.sentiment]++
  const total = perMessage.length || 1
  const sentiment_ratio = {
    positive: sentCounts.positive / total,
    negative: sentCounts.negative / total,
    neutral: sentCounts.neutral / total,
  }
  const emotionMap = new Map<string, number>()
  for (const e of [...a.summary.top_emotions, ...b.summary.top_emotions]) {
    emotionMap.set(e.label, (emotionMap.get(e.label) ?? 0) + e.score)
  }
  const top_emotions = [...emotionMap.entries()]
    .map(([label, score]) => ({ label, score: score / 2 }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 10)
  const timelineMap = new Map<string, EmotionTimeline>()
  for (const t of [...a.summary.timeline, ...b.summary.timeline]) {
    const ex = timelineMap.get(t.period)
    if (ex) {
      timelineMap.set(t.period, {
        period: t.period,
        positive: ex.positive + t.positive,
        negative: ex.negative + t.negative,
        neutral: ex.neutral + t.neutral,
        count: ex.count + t.count,
      })
    } else {
      timelineMap.set(t.period, { ...t })
    }
  }
  const timeline = [...timelineMap.values()].sort((x, y) => x.period.localeCompare(y.period))
  return {
    per_message: perMessage,
    summary: { sentiment_ratio, top_emotions, timeline },
    total_messages: a.total_messages + b.total_messages,
    analyzed_messages: a.analyzed_messages + b.analyzed_messages,
  }
}

export default function SearchPage() {
  const { results, setResults, selectedIds, toggleSelected, selectAll, clearSelected, bookmarkedIds, setBookmarkedIds, toggleBookmarked } = useSearchStore()
  const { setShowKeyModal } = useAuthStore()

  // Search state
  const [searchCat, setSearchCat] = useState<SearchCat>(() => (localStorage.getItem('search_cat') as SearchCat) || 'chat')
  const [activeTab, setActiveTab] = useState<SearchTab>(() => (localStorage.getItem('search_tab') as SearchTab) || 'keyword')
  const [matchType, setMatchType] = useState<MatchType>(() => ssGet('sr_match_type', 'any'))
  const [query, setQuery] = useState(() => ssGet('sr_query', ''))
  const [filterUsername, setFilterUsername] = useState(() => ssGet('sr_filter_username', ''))
  const [dateFrom, setDateFrom] = useState(() => ssGet('sr_date_from', ''))
  const [dateTo, setDateTo] = useState(() => ssGet('sr_date_to', ''))
  const [rangeDateFrom, setRangeDateFrom] = useState(() => ssGet('sr_range_date_from', ''))
  const [rangeDateTo, setRangeDateTo] = useState(() => ssGet('sr_range_date_to', ''))
  const [sunoTeam, setSunoTeam] = useState('all')
  const [maxResults, setMaxResults] = useState(10000)
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
  const [userStats, setUserStats] = useState<UserInRange[]>(() => ssGet<UserInRange[]>('sr_user_stats', []))
  const [userSortCol, setUserSortCol] = useState<'username' | 'total_messages' | 'first_date' | 'last_date' | 'avg_words' | 'weeks_active' | 'pct_weeks'>('total_messages')
  const [userSortDir, setUserSortDir] = useState<'asc' | 'desc'>('desc')
  const [userNameFilter, setUserNameFilter] = useState('')
  const [refineFirstMsgIn, setRefineFirstMsgIn] = useState('')
  const [refineLastMsgFrom, setRefineLastMsgFrom] = useState('')
  const [refineMinMessages, setRefineMinMessages] = useState('')
  const [refineMinWeeks, setRefineMinWeeks] = useState('')
  const [refineAvgWordsMin, setRefineAvgWordsMin] = useState('')
  const [refineAvgWordsMax, setRefineAvgWordsMax] = useState('')
  const [trendData, setTrendData] = useState<TrendPoint[]>(() => ssGet<TrendPoint[]>('sr_trend_data', []))
  const [trendBucket, setTrendBucket] = useState<TrendBucket>('month')
  const [lastKeyword, setLastKeyword] = useState(() => ssGet('sr_last_keyword', ''))
  const [lastTokens, setLastTokens] = useState<string[]>(() => ssGet<string[]>('sr_last_tokens', []))
  const [showSearchPanel, setShowSearchPanel] = useState(true)
  const [rangeLimit, setRangeLimit] = useState(200)
  const [rangeOffset, setRangeOffset] = useState(0)
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
  const [userSumVisible, setUserSumVisible] = useState(false)
  const [userSumFollowUp, setUserSumFollowUp] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [userSumFollowUpInput, setUserSumFollowUpInput] = useState('')
  const [userSumFollowUpLoading, setUserSumFollowUpLoading] = useState(false)
  const [userDetailPage, setUserDetailPage] = useState(0)
  const msgContainerRef = useRef<HTMLDivElement>(null)
  const userSumStopRef = useRef<(() => void) | null>(null)

  // BERTopic analysis state
  const [userTopicsResult, setUserTopicsResult] = useState<UserTopicsResult | null>(null)
  const [userTopicsLoading, setUserTopicsLoading] = useState(false)
  const [userTopicsVisible, setUserTopicsVisible] = useState(false)
  const [expandedTopicSamples, setExpandedTopicSamples] = useState<Set<number>>(new Set())
  const [userTopicsSteps, setUserTopicsSteps] = useState<TopicPipelineStep[]>([])
  const [topicModalId, setTopicModalId] = useState<number | null>(null)
  const [userAnalysisTab, setUserAnalysisTab] = useState<'topics' | 'emotion' | 'timeline' | 'dropout' | 'summary' | 'strategy'>('topics')
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
  const [dropoutSilenceDays, setDropoutSilenceDays] = useState(30)
  const [dropoutMinMessages, setDropoutMinMessages] = useState(5)
  const [dropoutMinActiveDays, setDropoutMinActiveDays] = useState(14)
  const [activeMinMessages, setActiveMinMessages] = useState(10)
  const [activeMinWeeks, setActiveMinWeeks] = useState(2)
  const [dropoutStatusFilter, setDropoutStatusFilter] = useState<'all' | DropoutStatus>('all')

  // Timeline interactivity
  const [selectedTopicIds, setSelectedTopicIds] = useState<Set<number> | null>(null)
  const [heatmapCell, setHeatmapCell] = useState<{ topicId: number; period: string } | null>(null)

  // Analysis result cache — persists across user navigation, keyed by username
  const topicsCacheRef = useRef<Map<string, { result: UserTopicsResult; uuids: Set<string> }>>(new Map())
  const emotionCacheRef = useRef<Map<string, { result: EmotionResult; uuids: Set<string> }>>(new Map())

  // Semantic filter debounce ref
  const semanticFilterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Infinite scroll
  const [visibleCount, setVisibleCount] = useState(50)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Browse All tab — server-side pagination
  const [browseMessages, setBrowseMessages] = useState<Message[]>([])
  const [browseFetching, setBrowseFetching] = useState(false)
  const [browseHasMore, setBrowseHasMore] = useState(true)
  const resultsAnchorRef = useRef<HTMLDivElement>(null)
  const browseOffsetRef = useRef(0)
  const browseHasMoreRef = useRef(true)
  const browseIsFetchingRef = useRef(false)
  const browseSentinelRef = useRef<HTMLDivElement>(null)
  // Browse filters (date: server-side re-fetch; username+keyword: client-side)
  const [browseUsernameFilter, setBrowseUsernameFilter] = useState('')
  const [browseKeywordFilter, setBrowseKeywordFilter] = useState('')
  const [browseDateFrom, setBrowseDateFrom] = useState('')
  const [browseDateTo, setBrowseDateTo] = useState('')
  const browseDateFromRef = useRef('')
  const browseDateToRef = useRef('')
  const browseScopeRef = useRef('')

  const { data: _uploads } = useQuery<Upload[]>({ queryKey: ['uploads'], queryFn: () => apiFetch('/uploads') })
  const { data: _bookmarkIds } = useQuery<number[]>({ queryKey: ['bookmark-ids'], queryFn: () => apiFetch('/bookmarks/ids') })
  const { data: _stats } = useQuery<Stats>({ queryKey: ['stats'], queryFn: () => apiFetch('/stats') })
  const vdbName = _stats?.vector_db_label ?? 'ChromaDB'
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

  // Sync key state to sessionStorage so it survives navigation and page refresh
  useEffect(() => { ssSet('sr_results', results) }, [results])
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

  // Apply text filter + optional chart range filter on top of full results
  const applyFilters = useCallback((
    allResults: Message[],
    mode: FilterMode,
    text: string,
    range: { from: string; to: string; label: string } | null,
    tokens: string[],
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
      // Deselect
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
    clearSelected()
    setFilterText('')
    setFilterMode('any')
    setFilterCount(null)
    setFilterTokens([])
    setChartRange(null)
    setAnalysisTab('none')
    setResults([])
    setDisplayedResults([])

    // Range tab validation
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
  }, [query, activeTab, matchType, filterUsername, buildParams, rangeLimit, rangeOffset, sortBy, trendBucket, setResults, clearSelected, buildTrend, dateFrom, dateTo, rangeDateFrom, rangeDateTo, sunoTeam, minWords, scopeParam, setShowKeyModal])

  const doUserSearch = async () => {
    setSearching(true)
    setTimeout(() => resultsAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30)
    setError(null)
    try {
      const params = buildParams()
      const data = await apiFetch<UserInRange[]>(`/search/users-in-range?${params}`)
      setUserStats(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearching(false)
      setDidSearch(true)
      setTimeout(() => resultsAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
    }
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
    clearSelected()
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

  const handleCatSwitch = (cat: SearchCat) => {
    localStorage.setItem('search_cat', cat)
    setSearchCat(cat)
    setResults([])
    setDisplayedResults([])
    setUserStats([])
    setTrendData([])
    setFilterText('')
    setFilterCount(null)
    setFilterTokens([])
    setChartRange(null)
    setAnalysisTab('none')
    setDidSearch(false)
    clearSelected()
    // flush browse all data so switching back starts fresh
    browseOffsetRef.current = 0
    browseHasMoreRef.current = true
    browseIsFetchingRef.current = false
    setBrowseMessages([])
    setBrowseFetching(false)
    setBrowseHasMore(true)
  }

  const exportCSV = () => {
    const sel = results.filter((r) => selectedIds.has(r.id))
    const rows = sel.length > 0 ? sel : results
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

  const copySelected = () => {
    const sel = results.filter((r) => selectedIds.has(r.id))
    if (sel.length === 0) return
    const text = sel.map((r) => `[${r.username} @ ${r.date?.slice(0, 19).replace('T', ' ')}]\n${r.content}`).join('\n\n---\n\n')
    navigator.clipboard.writeText(text)
  }

  const handleSummarize = () => {
    if (!localStorage.getItem('openai_api_key')) { setShowKeyModal(true); return }
    const sel = results.filter((r) => selectedIds.has(r.id))
    const msgs = sel.length > 0 ? sel : results
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

  // Filter end date: explicit dateTo or max last_date in dataset
  const filterEndDate = useMemo(() => {
    if (dateTo) return dateTo
    return userStats.reduce((max, u) =>
      (u.last_date && u.last_date > max ? u.last_date.slice(0, 10) : max), '')
  }, [dateTo, userStats])

  // Dropout status map for all users
  const dropoutMap = useMemo(() => {
    if (!filterEndDate || userStats.length === 0) return new Map<string, DropoutInfo>()
    const map = new Map<string, DropoutInfo>()
    for (const u of userStats) {
      map.set(u.username, computeDropout(u, filterEndDate, dropoutSilenceDays, dropoutMinMessages, dropoutMinActiveDays, activeMinMessages, activeMinWeeks))
    }
    return map
  }, [userStats, filterEndDate, dropoutSilenceDays, dropoutMinMessages, dropoutMinActiveDays, activeMinMessages, activeMinWeeks])

  const filteredUsers = userStats.filter((u) => {
    if (userNameFilter.trim() && !u.username.toLowerCase().includes(userNameFilter.trim().toLowerCase())) return false
    if (refineFirstMsgIn && (u.first_date ?? '') < refineFirstMsgIn) return false
    if (refineLastMsgFrom && (u.last_date ?? '') < refineLastMsgFrom) return false
    if (refineMinMessages && u.total_messages < parseInt(refineMinMessages)) return false
    if (refineMinWeeks && (u.weeks_active ?? 0) < parseInt(refineMinWeeks)) return false
    if (refineAvgWordsMin && (u.avg_words ?? 0) < parseFloat(refineAvgWordsMin)) return false
    if (refineAvgWordsMax && (u.avg_words ?? 0) > parseFloat(refineAvgWordsMax)) return false
    if (dropoutStatusFilter !== 'all') {
      const info = dropoutMap.get(u.username)
      if (!info || info.status !== dropoutStatusFilter) return false
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
    setRefineMinWeeks('')
    setRefineAvgWordsMin('')
    setRefineAvgWordsMax('')
    setDropoutStatusFilter('all')
  }

  const toggleAnalysisTab = (tab: 'summarize' | 'viz') => {
    setAnalysisTab((prev) => prev === tab ? 'none' : tab)
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
    const cached = topicsCacheRef.current.get(selectedUser.username)
    if (!cached) return 0
    return userDetailFiltered.filter(m => !cached.uuids.has(m.msg_uuid ?? '')).length
  }, [selectedUser, userTopicsResult, userDetailFiltered])

  const emotionRemainingCount = useMemo(() => {
    if (!selectedUser || !userEmotionResult) return 0
    const cached = emotionCacheRef.current.get(selectedUser.username)
    if (!cached) return 0
    return userDetailFiltered.filter(m => !cached.uuids.has(m.msg_uuid ?? '')).length
  }, [selectedUser, userEmotionResult, userDetailFiltered])

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
    setSelectedUser(u)
    setUserMsgsLoading(true)
    setUserMsgs([])
    setUserDetailDateFrom(dateFrom)
    setUserDetailDateTo(dateTo)
    setUserDetailContains('')
    setUserDetailMinWords(0)
    setUserSumResult('')
    setUserSumVisible(false)
    setUserSumFollowUp([])
    setUserDetailPage(0)
    const cachedTopics = topicsCacheRef.current.get(u.username)
    setUserTopicsResult(cachedTopics?.result ?? null)
    setUserTopicsVisible(!!cachedTopics)
    setUserTopicsSteps([])
    setUserEmotionResult(emotionCacheRef.current.get(u.username)?.result ?? null)
    setEmotionMsgFilter(null)
    setSelectedTopicIds(null)
    setHeatmapCell(null)
    setStrategyResult(null)
    setStrategyError(null)
    setExpandedStrategyIds(new Set())
    try {
      const userMsgParams = new URLSearchParams({ username: u.username, limit: '10000' })
      if (scopeParam) userMsgParams.set('upload_ids', scopeParam)
      const data = await apiFetch<Message[]>(`/search/user-messages?${userMsgParams}`)
      setUserMsgs(data)
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
    setUserSumVisible(true)
    if (userSumStopRef.current) userSumStopRef.current()
    userSumStopRef.current = streamEvents(
      '/summarize-results',
      {
        messages: userDetailFiltered.map(m => ({ username: m.username, date: m.date, content: m.content })),
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
    const cached = topicsCacheRef.current.get(selectedUser.username)
    const msgs = mode === 'remaining' && cached
      ? userDetailFiltered.filter(m => !cached.uuids.has(m.msg_uuid ?? ''))
      : userDetailFiltered
    if (msgs.length === 0) return
    setUserAnalysisTab('topics')
    setUserTopicsLoading(true)
    setUserTopicsResult(null)
    setUserTopicsVisible(true)
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
      { docs, msg_uuids },
      (event) => {
        const stage = event.stage as string
        const status = event.status as string
        const message = event.message as string
        if (stage === 'complete' && event.result) {
          const result = event.result as UserTopicsResult
          setUserTopicsResult(result)
          // Mark all current filtered msgs as analyzed (old + new)
          const allUuids = new Set(userDetailFiltered.map(m => m.msg_uuid ?? ''))
          topicsCacheRef.current.set(username, { result, uuids: allUuids })
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
    const cached = emotionCacheRef.current.get(selectedUser.username)
    const msgs = mode === 'remaining' && cached
      ? userDetailFiltered.filter(m => !cached.uuids.has(m.msg_uuid ?? ''))
      : userDetailFiltered
    if (msgs.length === 0) return
    setUserAnalysisTab('emotion')
    setUserEmotionLoading(true)
    setUserEmotionResult(null)
    const username = selectedUser.username
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
      emotionCacheRef.current.set(username, { result: finalResult, uuids: allUuids })
      setUserEmotionResult(finalResult)
    } catch (err) {
      console.error('Emotion analysis failed:', err)
    } finally {
      setUserEmotionLoading(false)
    }
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
  const tabs: { id: SearchTab; label: string }[] = [
    { id: 'browse', label: 'Browse All' },
    { id: 'keyword', label: 'Keyword Search' },
    { id: 'semantic', label: 'Semantic Search' },
    { id: 'username', label: 'Username Search' },
    { id: 'range', label: 'Time Range' },
  ]

  const selectedCount = selectedIds.size

  // Determine which tokens to use for card highlighting
  const activeTokens = filterText.trim() ? filterTokens : lastTokens
  const activeKeyword = filterText.trim() ? '' : lastKeyword

  // Filter mode placeholder text
  const filterPlaceholder: Record<FilterMode, string> = {
    exact: 'Filter: all words must match…',
    any: 'Filter: any word matches…',
    fuzzy: 'Filter: fuzzy char-order match…',
    semantic: 'Filter: semantic similarity…',
  }

  // Retrieval mode hint
  const retrievalHint: Record<'cluster' | 'all', string> = {
    cluster: 'Groups messages by topic and samples representatives. Best for large result sets.',
    all: 'Passes all messages directly to the model. Use for small result sets (<100 msgs).',
  }

  // User detail full-panel view
  if (selectedUser) {
    const u = selectedUser
    const PAGE_SIZE = 50
    const totalPages = Math.max(1, Math.ceil(userDetailFiltered.length / PAGE_SIZE))
    const visibleMsgs = userDetailFiltered.slice(userDetailPage * PAGE_SIZE, (userDetailPage + 1) * PAGE_SIZE)
    return (
      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 space-y-4">
        {/* Header bar */}
        <div className="bg-indigo-700 text-white rounded-2xl shadow px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => setSelectedUser(null)}
            className="flex items-center gap-1.5 text-sm font-semibold text-indigo-200 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Back
          </button>
          <span className="text-base font-bold flex-1 truncate">{u.username}</span>
          {(() => {
            const di = dropoutMap.get(u.username)
            if (!di) return null
            const badge: Record<DropoutStatus, { label: string; cls: string }> = {
              active:    { label: 'Active',   cls: 'bg-emerald-500 text-white' },
              dropout:   { label: di.tier ? `Dropout · ${di.tier}` : 'Dropout', cls: 'bg-rose-500 text-white' },
              transient: { label: 'Transient', cls: 'bg-amber-500 text-white' },
            }
            const b = badge[di.status]
            return (
              <span
                className={`shrink-0 text-xs font-bold px-2.5 py-1 rounded-full ${b.cls}`}
                title={di.silenceDays < 9999 ? `${di.silenceDays} days silent before filter end` : undefined}
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
          </div>

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
                onClick={() => setUserAnalysisTab('topics')}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors ${
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
                onClick={() => setUserAnalysisTab('dropout')}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors border-l border-gray-200 ${
                  userAnalysisTab === 'dropout' ? 'bg-rose-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Dropout
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
              <div className="flex items-center gap-2 flex-wrap">
                {!userTopicsResult ? (
                  <button onClick={() => runUserTopics('all')} disabled={userTopicsLoading} className="search-btn">
                    {userTopicsLoading ? 'Analysing…' : 'Run Analysis'}
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
                    {userTopicsResult.filtered_docs.toLocaleString()} of {userTopicsResult.total_docs.toLocaleString()} messages analysed · real BERTopic
                  </span>
                )}
              </div>

              {userTopicsSteps.length > 0 && (
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

              {userTopicsResult && userTopicsResult.topics.length === 0 && !userTopicsLoading && (
                <p className="text-sm text-gray-400">No topics identified — not enough message content.</p>
              )}

              {userTopicsResult && userTopicsResult.topics.length > 0 && (
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
                    return (
                      <div key={topic.id} className={`rounded-xl border px-3 py-2.5 ${colors[colorIdx]}`}>
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold text-gray-400 uppercase w-6 shrink-0">#{topic.id}</span>
                            <span className="text-sm font-semibold text-gray-800">{topic.label}</span>
                          </div>
                          <span className="text-xs text-gray-500 shrink-0">{topic.message_count.toLocaleString()} msgs · {pct}%</span>
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
                      <div key={msg.id ?? i} className="px-5 py-3 hover:bg-gray-50 transition-colors">
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className="text-[11px] font-semibold"
                            style={{ color: getUserColor(msg.username)[1] }}
                          >
                            {msg.username}
                          </span>
                          <span className="text-[10px] text-gray-400">{msg.date}</span>
                        </div>
                        <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
                          {msg.content}
                        </p>
                      </div>
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
              {/* Run button */}
              <div className="flex items-center gap-2 flex-wrap">
                {!userEmotionResult ? (
                  <button onClick={() => runUserEmotion('all')} disabled={userEmotionLoading} className="search-btn">
                    {userEmotionLoading ? 'Analysing…' : 'Run Analysis'}
                  </button>
                ) : (
                  <>
                    <button onClick={() => runUserEmotion('all')} disabled={userEmotionLoading} className="search-btn">
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
                  {/* Sentiment ratio bar */}
                  <div>
                    <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Sentiment Distribution</p>
                    <div className="flex rounded-lg overflow-hidden h-7 text-xs font-semibold text-white">
                      {userEmotionResult.summary.sentiment_ratio.positive > 0 && (
                        <div
                          style={{ width: `${userEmotionResult.summary.sentiment_ratio.positive * 100}%` }}
                          className="bg-emerald-500 flex items-center justify-center"
                          title="Positive"
                        >
                          {(userEmotionResult.summary.sentiment_ratio.positive * 100).toFixed(0)}%
                        </div>
                      )}
                      {userEmotionResult.summary.sentiment_ratio.negative > 0 && (
                        <div
                          style={{ width: `${userEmotionResult.summary.sentiment_ratio.negative * 100}%` }}
                          className="bg-rose-500 flex items-center justify-center"
                          title="Negative"
                        >
                          {(userEmotionResult.summary.sentiment_ratio.negative * 100).toFixed(0)}%
                        </div>
                      )}
                      {userEmotionResult.summary.sentiment_ratio.neutral > 0 && (
                        <div
                          style={{ width: `${userEmotionResult.summary.sentiment_ratio.neutral * 100}%` }}
                          className="bg-gray-400 flex items-center justify-center"
                          title="Neutral"
                        >
                          {(userEmotionResult.summary.sentiment_ratio.neutral * 100).toFixed(0)}%
                        </div>
                      )}
                    </div>
                    <div className="flex gap-4 mt-1.5">
                      <span className="text-xs text-emerald-600 font-medium">● Positive</span>
                      <span className="text-xs text-rose-500 font-medium">● Negative</span>
                      <span className="text-xs text-gray-400 font-medium">● Neutral/Ambiguous</span>
                    </div>
                  </div>

                  {/* Top emotions horizontal bar chart */}
                  {userEmotionResult.summary.top_emotions.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Top Emotions (avg score)</p>
                        <span className="text-[10px] text-gray-400">Click a bar to see messages</span>
                      </div>
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart
                          data={userEmotionResult.summary.top_emotions.slice(0, 8).map(e => ({
                            name: e.label,
                            value: Math.round(e.score * 100),
                          }))}
                          layout="vertical"
                          margin={{ left: 12, right: 24, top: 4, bottom: 4 }}
                        >
                          <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} />
                          <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} />
                          <Tooltip formatter={(v: number) => [`${v}%`, 'Avg score']} />
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
            const dropInfo = selectedUser ? dropoutMap.get(selectedUser.username) : undefined
            const sc = dropInfo ? STATUS_COLORS[dropInfo.status] : STATUS_COLORS.transient

            // Weekly activity chart data
            const weekCounts: Record<string, number> = {}
            for (const m of userDetailFiltered) {
              if (!m.date) continue
              const d = new Date(m.date)
              const mon = new Date(d)
              mon.setDate(d.getDate() - ((d.getDay() + 6) % 7))
              const key = mon.toISOString().slice(0, 10)
              weekCounts[key] = (weekCounts[key] || 0) + 1
            }
            const weeklyData = Object.entries(weekCounts)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([week, count]) => ({ week, count }))

            // Pre-dropout window: last 30 days of activity
            const lastDate = selectedUser?.last_date?.slice(0, 10) ?? ''
            const windowStart = lastDate
              ? new Date(new Date(lastDate).getTime() - 30 * 86400000).toISOString().slice(0, 10)
              : ''
            const preDropoutMsgs = windowStart
              ? userDetailFiltered.filter(m => (m.date?.slice(0, 10) ?? '') >= windowStart)
              : []
            const lastMsgs = [...userDetailFiltered]
              .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
              .slice(0, 10)

            // Sentiment in pre-dropout window (if emotion run)
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

            // Topics in pre-dropout window (if BERTopic run)
            const preDropoutTopics = (userTopicsResult && preDropoutMsgs.length > 0)
              ? (() => {
                  const assignments = userTopicsResult.doc_assignments
                  if (!assignments) return null
                  const tCounts: Record<number, number> = {}
                  for (const m of preDropoutMsgs) {
                    const tid = m.msg_uuid ? assignments[m.msg_uuid] : undefined
                    if (tid !== undefined) tCounts[tid] = (tCounts[tid] || 0) + 1
                  }
                  return Object.entries(tCounts)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 5)
                    .map(([tid, count]) => {
                      const id = Number(tid)
                      const topic = userTopicsResult.topics.find(t => t.id === id)
                      return { id, label: id === -1 ? 'Outliers' : (topic?.label ?? `Topic ${id}`), count }
                    })
                })()
              : null

            return (
              <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">
                {/* Dropout parameters */}
                <div className="flex flex-wrap gap-x-4 gap-y-2 items-end text-xs bg-gray-50 rounded-xl px-3 py-2.5 border border-gray-200">
                  <span className="font-semibold text-gray-600 uppercase tracking-wide text-[10px] self-center">Transient if</span>
                  <label className="flex items-center gap-1.5">
                    <span className="text-gray-500">Msg &lt;</span>
                    <input
                      type="text" inputMode="numeric"
                      value={String(dropoutMinMessages)}
                      onChange={e => setDropoutMinMessages(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
                      className="w-10 border border-gray-300 rounded px-1 py-0.5 text-center text-gray-800"
                    />
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span className="text-gray-500">Span &lt;</span>
                    <input
                      type="text" inputMode="numeric"
                      value={String(dropoutMinActiveDays)}
                      onChange={e => setDropoutMinActiveDays(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
                      className="w-10 border border-gray-300 rounded px-1 py-0.5 text-center text-gray-800"
                    />
                    <span className="text-gray-500">days</span>
                  </label>
                  <span className="text-gray-300 self-center">|</span>
                  <span className="font-semibold text-gray-600 uppercase tracking-wide text-[10px] self-center">Active needs</span>
                  <label className="flex items-center gap-1.5">
                    <span className="text-gray-500">Msg ≥</span>
                    <input
                      type="text" inputMode="numeric"
                      value={String(activeMinMessages)}
                      onChange={e => setActiveMinMessages(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
                      className="w-10 border border-gray-300 rounded px-1 py-0.5 text-center text-gray-800"
                    />
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span className="text-gray-500">Weeks ≥</span>
                    <input
                      type="text" inputMode="numeric"
                      value={String(activeMinWeeks)}
                      onChange={e => setActiveMinWeeks(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
                      className="w-10 border border-gray-300 rounded px-1 py-0.5 text-center text-gray-800"
                    />
                  </label>
                  <span className="text-gray-300 self-center">|</span>
                  <span className="font-semibold text-gray-600 uppercase tracking-wide text-[10px] self-center">Dropout if</span>
                  <label className="flex items-center gap-1.5">
                    <span className="text-gray-500">Silence ≥</span>
                    <input
                      type="text" inputMode="numeric"
                      value={String(dropoutSilenceDays)}
                      onChange={e => setDropoutSilenceDays(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
                      className="w-10 border border-gray-300 rounded px-1 py-0.5 text-center text-gray-800"
                    />
                    <span className="text-gray-500">days</span>
                  </label>
                </div>

                {/* Status card */}
                <div className={`rounded-xl px-4 py-3 flex items-start gap-3 ${sc.bg} border ${sc.border}`}>
                  <div className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${sc.dot}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-sm font-bold capitalize ${sc.text}`}>
                        {dropInfo?.status ?? 'Unknown'}
                        {dropInfo?.tier ? ` · ${dropInfo.tier}` : ''}
                      </span>
                      {dropInfo && dropInfo.silenceDays < 9999 && (
                        <span className="text-xs text-gray-500">
                          {dropInfo.silenceDays} day{dropInfo.silenceDays !== 1 ? 's' : ''} silent before period end
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      Filter end: <strong>{filterEndDate || '—'}</strong> · Last active: <strong>{lastDate || '—'}</strong>
                      {dropInfo && <span className="ml-2">· Active span: {dropInfo.activeSpan} days</span>}
                    </p>
                  </div>
                </div>

                {!filterEndDate && (
                  <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 border border-amber-200">
                    Set a "To" date in the search filter for accurate dropout calculation.
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
                          {weeklyData.map((entry, idx) => (
                            <Cell
                              key={idx}
                              fill={
                                dropInfo?.status === 'dropout' && idx >= weeklyData.length - 4
                                  ? '#f43f5e'
                                  : '#6366f1'
                              }
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    {dropInfo?.status === 'dropout' && (
                      <p className="text-[10px] text-rose-500 mt-0.5">● Last 4 weeks highlighted in red</p>
                    )}
                  </div>
                )}

                {/* Pre-dropout sentiment */}
                {preDropoutSentiment && preDropoutMsgs.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Sentiment in Final 30 Days ({preDropoutMsgs.length} messages)
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
                      Topics in Final 30 Days
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
                      Last {lastMsgs.length} Messages{dropInfo?.status === 'dropout' ? ' Before Dropout' : ''}
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
                  isSelected={selectedIds.has(msg.id)}
                  onBookmarkToggle={handleBookmarkToggle}
                  onSelectToggle={toggleSelected}
                  ctxBefore={userDetailCtxBefore}
                  ctxAfter={userDetailCtxAfter}
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
          if (searchCat === 'users') doUserSearch()
          else doSearch()
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
            {/* Chat / Users top toggle */}
            <div className="flex gap-1 mb-4">
              <button onClick={() => handleCatSwitch('chat')} className={`subtab-btn${searchCat === 'chat' ? ' subtab-btn-active' : ''}`}>Chat Data</button>
              <button onClick={() => handleCatSwitch('users')} className={`subtab-btn${searchCat === 'users' ? ' subtab-btn-active' : ''}`}>Users Data</button>
            </div>

            {/* Chat search */}
            {searchCat === 'chat' && (
              <>
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
                          <input type="text" inputMode="numeric" value={String(maxResults)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMaxResults(d ? parseInt(d) : 10000) }} className={inputCls} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="filter-label">Min Words</label>
                          <input type="text" inputMode="numeric" value={String(minWords)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinWords(d ? parseInt(d) : 0) }} className={inputCls} />
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
                          <input type="text" inputMode="numeric" value={String(maxResults)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMaxResults(d ? parseInt(d) : 10000) }} className={inputCls} />
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
                          <input type="text" inputMode="numeric" value={String(maxResults)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMaxResults(d ? parseInt(d) : 10000) }} className={inputCls} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="filter-label">Min Words</label>
                          <input type="text" inputMode="numeric" value={String(minWords)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinWords(d ? parseInt(d) : 0) }} className={inputCls} />
                        </div>
                      </div>
                    )}
                    <p className="text-xs text-gray-500 mt-3">Partial match, case-insensitive.</p>
                  </>
                )}

                {/* Time Range tab */}
                {activeTab === 'range' && (
                  <>
                    <div className="inline-flex mb-3">
                      <button onClick={() => setRangeMode('exact')} className={`range-mode-btn${rangeMode === 'exact' ? ' range-mode-active' : ''}`}>Exact Date Range</button>
                      <button onClick={() => setRangeMode('month')} className={`range-mode-btn${rangeMode === 'month' ? ' range-mode-active' : ''}`}>By Month &amp; Year</button>
                    </div>

                    {/* Phase template shortcuts */}
                    {(() => {
                      const rangeActivePhase =
                        rangeDateFrom === '2023-04-01' && rangeDateTo === '2023-07-18' ? 1 :
                        rangeDateFrom === '2023-07-19' && rangeDateTo === '2023-09-05' ? 2 :
                        rangeDateFrom === '2023-09-06' && rangeDateTo === '' ? 3 : null

                      const applyPhase = (p: 1 | 2 | 3) => {
                        if (rangeActivePhase === p) {
                          setRangeDateFrom(''); setRangeDateTo('')
                        } else {
                          setRangeMode('exact')
                          if (p === 1) { setRangeDateFrom('2023-04-01'); setRangeDateTo('2023-07-18') }
                          else if (p === 2) { setRangeDateFrom('2023-07-19'); setRangeDateTo('2023-09-05') }
                          else { setRangeDateFrom('2023-09-06'); setRangeDateTo('') }
                        }
                      }

                      return (
                        <div className="flex flex-wrap gap-2 mb-3">
                          <span className="filter-label self-center shrink-0">Phase</span>
                          <button
                            onClick={() => applyPhase(1)}
                            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${rangeActivePhase === 1 ? 'border-blue-400 bg-blue-100 text-blue-800 font-semibold' : 'border-blue-300 text-blue-700 hover:bg-blue-50'}`}
                          >
                            Phase 1 — Capability Surfacing <span className="opacity-60 ml-1">Apr–18 Jul 2023</span>
                          </button>
                          <button
                            onClick={() => applyPhase(2)}
                            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${rangeActivePhase === 2 ? 'border-amber-400 bg-amber-100 text-amber-800 font-semibold' : 'border-amber-300 text-amber-700 hover:bg-amber-50'}`}
                          >
                            Phase 2 — Enclosure &amp; Scrutiny <span className="opacity-60 ml-1">19 Jul–5 Sep 2023</span>
                          </button>
                          <button
                            onClick={() => applyPhase(3)}
                            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${rangeActivePhase === 3 ? 'border-emerald-400 bg-emerald-100 text-emerald-800 font-semibold' : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'}`}
                          >
                            Phase 3 — Commercialization <span className="opacity-60 ml-1">Sep 2023 onward</span>
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
                        <input type="text" inputMode="numeric" value={String(maxResults)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMaxResults(d ? parseInt(d) : 10000) }} className={inputCls} />
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

            {/* Users search */}
            {searchCat === 'users' && (
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
                    <label className="filter-label">Min Words</label>
                    <input type="text" inputMode="numeric" value={String(minWords)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setMinWords(d ? parseInt(d) : 0) }} className={inputCls} />
                  </div>
                </div>

                {/* Phase template shortcuts */}
                {(() => {
                  const usersActivePhase =
                    dateFrom === '2023-04-01' && dateTo === '2023-07-18' ? 1 :
                    dateFrom === '2023-07-19' && dateTo === '2023-09-05' ? 2 :
                    dateFrom === '2023-09-06' && dateTo === '' ? 3 : null

                  const applyPhase = (p: 1 | 2 | 3) => {
                    if (usersActivePhase === p) {
                      setDateFrom(''); setDateTo('')
                    } else {
                      if (p === 1) { setDateFrom('2023-04-01'); setDateTo('2023-07-18') }
                      else if (p === 2) { setDateFrom('2023-07-19'); setDateTo('2023-09-05') }
                      else { setDateFrom('2023-09-06'); setDateTo('') }
                    }
                  }

                  return (
                    <div className="flex flex-wrap gap-2 mb-1">
                      <span className="filter-label self-center shrink-0">Phase</span>
                      <button
                        onClick={() => applyPhase(1)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${usersActivePhase === 1 ? 'border-blue-400 bg-blue-100 text-blue-800 font-semibold' : 'border-blue-300 text-blue-700 hover:bg-blue-50'}`}
                      >
                        Phase 1 — Capability Surfacing <span className="opacity-60 ml-1">Apr–18 Jul 2023</span>
                      </button>
                      <button
                        onClick={() => applyPhase(2)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${usersActivePhase === 2 ? 'border-amber-400 bg-amber-100 text-amber-800 font-semibold' : 'border-amber-300 text-amber-700 hover:bg-amber-50'}`}
                      >
                        Phase 2 — Enclosure &amp; Scrutiny <span className="opacity-60 ml-1">19 Jul–5 Sep 2023</span>
                      </button>
                      <button
                        onClick={() => applyPhase(3)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${usersActivePhase === 3 ? 'border-emerald-400 bg-emerald-100 text-emerald-800 font-semibold' : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'}`}
                      >
                        Phase 3 — Commercialization <span className="opacity-60 ml-1">Sep 2023 onward</span>
                      </button>
                    </div>
                  )
                })()}

                <button onClick={doUserSearch} disabled={searching} className="search-btn mb-4">{searching ? 'Searching…' : 'Search'}</button>
                <p className="text-xs text-gray-500 mb-4">Returns all users active in the selected date range with message statistics. Leave dates empty to include all data.</p>
              </div>
            )}

            {/* Context window */}
            {activeTab !== 'browse' && searchCat === 'chat' && (
              <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label className="filter-label">Context Before</label>
                  <div className="flex items-center gap-1">
                    <input type="text" inputMode="numeric" value={String(ctxBefore)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setCtxBefore(d ? parseInt(d) : 0) }} className="search-input text-xs py-1 w-16 text-center" />
                    <span className="text-xs text-gray-400">msgs</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="filter-label">Context After</label>
                  <div className="flex items-center gap-1">
                    <input type="text" inputMode="numeric" value={String(ctxAfter)} onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setCtxAfter(d ? parseInt(d) : 0) }} className="search-input text-xs py-1 w-16 text-center" />
                    <span className="text-xs text-gray-400">msgs</span>
                  </div>
                </div>
                <span className="self-end pb-1 text-xs text-gray-400">(same CSV, original order)</span>
              </div>
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
      {!searching && !error && didSearch && searchCat === 'chat' && results.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-sm text-gray-500 text-center">
          {activeTab === 'range'
            ? 'No results found for the selected date range. The dataset may not have data for that period.'
            : lastKeyword
              ? <>No results for <span className="font-semibold text-gray-700">"{lastKeyword}"</span>. Try a different query, match type, or date range.</>
              : 'No results found. Try adjusting the username or date filter.'}
        </div>
      )}

      {/* Users results table */}
      {searchCat === 'users' && userStats.length > 0 && (
        <section className="bg-white rounded-2xl shadow p-5 flex flex-col" style={{ maxHeight: 'calc(100vh - 180px)' }}>
          {/* Dropout summary bar */}
          {dropoutMap.size > 0 && (() => {
            const counts = { active: 0, dropout: 0, transient: 0 }
            for (const info of dropoutMap.values()) counts[info.status]++
            return (
              <div className="shrink-0 mb-3 space-y-2">
                {/* Status chips */}
                <div className="flex flex-wrap items-center gap-2">
                  {([
                    ['all',       `All  ${userStats.length}`,    'bg-gray-100 text-gray-700 border-gray-300'],
                    ['active',    `Active  ${counts.active}`,    'bg-emerald-100 text-emerald-700 border-emerald-300'],
                    ['dropout',   `Dropout  ${counts.dropout}`,  'bg-rose-100 text-rose-700 border-rose-300'],
                    ['transient', `Transient  ${counts.transient}`, 'bg-amber-100 text-amber-700 border-amber-300'],
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
                {/* Threshold params — two rows: transient floor + active bar */}
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 items-center text-xs text-gray-500">
                  <span className="font-semibold text-[10px] uppercase tracking-wide text-gray-400">Transient if</span>
                  <label className="flex items-center gap-1">
                    Msg &lt;
                    <input
                      type="text" inputMode="numeric"
                      value={String(dropoutMinMessages)}
                      onChange={e => setDropoutMinMessages(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
                      className="w-11 ml-1 border border-gray-300 rounded px-1 py-0.5 text-center text-gray-800 text-xs"
                    />
                  </label>
                  <span className="text-gray-400">or</span>
                  <label className="flex items-center gap-1">
                    Span &lt;
                    <input
                      type="text" inputMode="numeric"
                      value={String(dropoutMinActiveDays)}
                      onChange={e => setDropoutMinActiveDays(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
                      className="w-11 ml-1 border border-gray-300 rounded px-1 py-0.5 text-center text-gray-800 text-xs"
                    />
                    days
                  </label>
                  <span className="mx-1 text-gray-300">|</span>
                  <span className="font-semibold text-[10px] uppercase tracking-wide text-gray-400">Active needs</span>
                  <label className="flex items-center gap-1">
                    Msg ≥
                    <input
                      type="text" inputMode="numeric"
                      value={String(activeMinMessages)}
                      onChange={e => setActiveMinMessages(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
                      className="w-11 ml-1 border border-gray-300 rounded px-1 py-0.5 text-center text-gray-800 text-xs"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    Weeks ≥
                    <input
                      type="text" inputMode="numeric"
                      value={String(activeMinWeeks)}
                      onChange={e => setActiveMinWeeks(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
                      className="w-11 ml-1 border border-gray-300 rounded px-1 py-0.5 text-center text-gray-800 text-xs"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 items-center text-xs text-gray-500">
                  <span className="font-semibold text-[10px] uppercase tracking-wide text-gray-400">Dropout if</span>
                  <label className="flex items-center gap-1">
                    Silence ≥
                    <input
                      type="text" inputMode="numeric"
                      value={String(dropoutSilenceDays)}
                      onChange={e => setDropoutSilenceDays(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
                      className="w-11 ml-1 border border-gray-300 rounded px-1 py-0.5 text-center text-gray-800 text-xs"
                    />
                    days
                  </label>
                </div>
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
              {(userNameFilter || refineFirstMsgIn || refineLastMsgFrom || refineMinMessages || refineMinWeeks || refineAvgWordsMin || refineAvgWordsMax) && (
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

          <div className="flex-1 overflow-auto">
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
                </tr>
              </thead>
              <tbody>
                {sortedUsers.map((u) => (
                  <tr key={u.username} className="border-b border-gray-100 hover:bg-gray-50">
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
                      if (!di) return <td className="px-3 py-2" />
                      const sc = STATUS_COLORS[di.status]
                      return (
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${sc.bg} ${sc.text} border ${sc.border}`}
                            title={di.silenceDays < 9999 ? `${di.silenceDays}d silent` : undefined}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                            {di.status === 'dropout' && di.tier ? `Dropout · ${di.tier}` : di.status}
                          </span>
                        </td>
                      )
                    })()}
                  </tr>
                ))}
              </tbody>
            </table>
            {sortedUsers.length === 0 && (
              <p className="text-center text-sm text-gray-400 py-6">No users match the current filters.</p>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-3">Click a username to open their message detail view.</p>
        </section>
      )}

      {/* Chat results */}
      {searchCat === 'chat' && results.length > 0 && (
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
            {displayedResults.slice(0, visibleCount).map((msg, idx) => {
              const sliced = displayedResults.slice(0, visibleCount)
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
                    isSelected={selectedIds.has(msg.id)}
                    onBookmarkToggle={handleBookmarkToggle}
                    onSelectToggle={toggleSelected}
                    ctxBefore={ctxBefore}
                    ctxAfter={ctxAfter}
                    isGrouped={isGrouped && !showDateSep}
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
      {activeTab === 'browse' && searchCat === 'chat' && (
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
              <span className="self-end pb-1 ml-auto text-xs text-gray-400">
                {filteredBrowseMessages.length !== browseMessages.length
                  ? `${filteredBrowseMessages.length.toLocaleString()} / ${browseMessages.length.toLocaleString()} loaded`
                  : `${browseMessages.length.toLocaleString()} loaded`}
              </span>
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
