import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api/client'
import { getUserStyle } from '../utils/colors'
import { randomPaletteColor } from '../utils/palette'
import ColorPicker from '../components/ui/ColorPicker'
import type { Code, Message, InterviewBookmark, BookmarkSource } from '../types'

type SourceFilter = 'all' | 'discord' | 'interview' | 'news'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BookmarkHighlight {
  id: number
  code_id: number
  code_name: string
  code_color: string
  highlighted_text: string
}

interface BookmarkWithAll {
  id: number
  msg_id: number
  note?: string
  created_at: string
  content: string
  username: string
  date: string
  is_suno_team?: string | boolean
  codes: Code[]
  highlights: BookmarkHighlight[]
  source: BookmarkSource
}

interface PopoverState {
  bmId: number
  text: string
  segs: string[]
  x: number
  y: number
}

type SortKey = 'date' | 'added' | 'username'
type SunoFilter = 'all' | 'only' | 'exclude'
type CodedFilter = 'all' | 'coded' | 'uncoded'

// ── Helpers ───────────────────────────────────────────────────────────────────

function labelTextColor(hex: string) {
  const r = parseInt((hex || '#000000').slice(1, 3), 16)
  const g = parseInt((hex || '#000000').slice(3, 5), 16)
  const b = parseInt((hex || '#000000').slice(5, 7), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#1f2937' : '#ffffff'
}

function isTruthy(v: unknown) {
  return v === true || v === 'True' || v === '1' || v === 1
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function annotateExcerpt(
  content: string,
  highlights: BookmarkHighlight[],
  pendingTexts: string[] = [],
): string {
  if (!content) return ''

  type Span = { start: number; end: number; color: string; pending: boolean }
  const spans: Span[] = []

  const addSpans = (text: string, color: string, pending: boolean) => {
    if (!text) return
    const lower = content.toLowerCase()
    const tLower = text.toLowerCase()
    let idx = 0
    while (idx < content.length) {
      const pos = lower.indexOf(tLower, idx)
      if (pos === -1) break
      spans.push({ start: pos, end: pos + text.length, color, pending })
      idx = pos + text.length
    }
  }

  for (const hl of highlights) addSpans(hl.highlighted_text, hl.code_color, false)
  for (const pt of pendingTexts) addSpans(pt, '#6366f1', true)

  if (spans.length === 0) return escapeHtml(content)

  // Build segment boundaries from all span start/end points
  const pointSet = new Set<number>([0, content.length])
  for (const sp of spans) { pointSet.add(sp.start); pointSet.add(sp.end) }
  const points = [...pointSet].sort((a, b) => a - b)

  let result = ''
  for (let i = 0; i < points.length - 1; i++) {
    const segStart = points[i]
    const segEnd = points[i + 1]
    const text = escapeHtml(content.slice(segStart, segEnd))
    const active = spans.filter((sp) => sp.start <= segStart && sp.end >= segEnd)

    if (active.length === 0) {
      result += text
    } else {
      const pending = active.some((s) => s.pending)
      const nonPending = active.filter((s) => !s.pending)
      let style = ''
      if (nonPending.length > 0) style += `background:${nonPending[0].color}28;border-bottom:2px solid ${nonPending[0].color};`
      if (pending) style += 'border-bottom:2px dashed #6366f1;background:#6366f115;'
      result += `<mark style="${style}">${text}</mark>`
    }
  }

  return result
}

function useDebounce<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

// ── BookmarkCard ──────────────────────────────────────────────────────────────

interface BookmarkCardProps {
  bookmark: BookmarkWithAll
  ctxBefore: number
  ctxAfter: number
  allCodes: Code[]
  isHlOpen: boolean
  hlText: string
  hlSegs: string[]
  closeAllStamp: number
  onDelete: () => void
  onAddCode: (codeId: number) => Promise<void>
  onRemoveCode: (codeId: number) => Promise<void>
  onNewCode: (name: string, color: string) => Promise<Code>
  onAddHighlight: (bmId: number, codeId: number, text: string) => Promise<BookmarkHighlight>
  onRemoveHighlight: (bmId: number, hlId: number) => void
  onOpenHlPanel: () => void
  onCloseHlPanel: () => void
}

function BookmarkCard({
  bookmark,
  ctxBefore,
  ctxAfter,
  allCodes,
  isHlOpen,
  hlText,
  hlSegs,
  closeAllStamp,
  onDelete,
  onAddCode,
  onRemoveCode,
  onNewCode,
  onAddHighlight,
  onRemoveHighlight,
  onOpenHlPanel,
  onCloseHlPanel,
}: BookmarkCardProps) {
  const [ctxOpen, setCtxOpen] = useState(false)
  const [ctxLoading, setCtxLoading] = useState(false)
  const [ctxMessages, setCtxMessages] = useState<Message[]>([])
  const [codeOpen, setCodeOpen] = useState(false)
  const [codeSearch, setCodeSearch] = useState('')
  const [newCodeColor, setNewCodeColor] = useState(() => randomPaletteColor())
  const [adding, setAdding] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggFocusIdx, setSuggFocusIdx] = useState(-1)
  const searchRef = useRef<HTMLInputElement>(null)
  const suggListRef = useRef<HTMLDivElement>(null)

  // HL panel state
  const [hlSearch, setHlSearch] = useState('')
  const [hlNewColor, setHlNewColor] = useState(() => randomPaletteColor())
  const [hlAdding, setHlAdding] = useState(false)
  const [hlShowSugg, setHlShowSugg] = useState(false)
  const [hlSuggFocusIdx, setHlSuggFocusIdx] = useState(-1)
  const hlSearchRef = useRef<HTMLInputElement>(null)

  // Close all panels on stamp change
  useEffect(() => {
    if (closeAllStamp > 0) {
      setCodeOpen(false)
      setCtxOpen(false)
      if (isHlOpen) onCloseHlPanel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeAllStamp])

  const bookmarkCodes = bookmark.codes ?? []
  const highlights = bookmark.highlights ?? []

  const suggestions = codeSearch.trim()
    ? allCodes
        .filter(
          (c) =>
            c.name.toLowerCase().includes(codeSearch.toLowerCase()) &&
            !bookmarkCodes.some((bc) => bc.id === c.id),
        )
        .slice(0, 8)
    : []

  const hlSuggestions = hlSearch.trim()
    ? allCodes.filter((c) => c.name.toLowerCase().includes(hlSearch.toLowerCase())).slice(0, 8)
    : []

  const handleCtxToggle = async () => {
    if (ctxOpen) {
      setCtxOpen(false)
      return
    }
    setCtxLoading(true)
    setCtxOpen(true)
    try {
      const data = await apiFetch<Message[]>(
        `/context/${bookmark.msg_id}?before=${ctxBefore}&after=${ctxAfter}`,
      )
      setCtxMessages(data)
    } catch {
      /* ignore */
    } finally {
      setCtxLoading(false)
    }
  }

  const handleAddExisting = async (codeId: number) => {
    await onAddCode(codeId)
    setCodeSearch('')
    setShowSuggestions(false)
    setSuggFocusIdx(-1)
    searchRef.current?.focus()
  }

  const handleCreate = async () => {
    const name = codeSearch.trim()
    if (!name) return
    const existing = allCodes.find((c) => c.name.toLowerCase() === name.toLowerCase())
    setAdding(true)
    try {
      if (existing) {
        if (!bookmarkCodes.some((bc) => bc.id === existing.id)) await onAddCode(existing.id)
      } else {
        const code = await onNewCode(name, newCodeColor)
        await onAddCode(code.id)
      }
      setCodeSearch('')
      setShowSuggestions(false)
    } finally {
      setAdding(false)
    }
  }

  const handleCodeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (suggestions.length > 0) {
        setSuggFocusIdx((i) => Math.min(i + 1, suggestions.length - 1))
        const el = suggListRef.current?.children[Math.min(suggFocusIdx + 1, suggestions.length - 1)] as HTMLElement
        el?.focus()
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      setSuggFocusIdx(-1)
    } else if (e.key === 'Enter') {
      handleCreate()
    }
  }

  const handleHlAddExisting = async (code: Code) => {
    if (!hlSegs.length && !hlText) return
    setHlAdding(true)
    try {
      const segsToAdd = hlSegs.length > 0 ? hlSegs : [hlText]
      for (const seg of segsToAdd) {
        await onAddHighlight(bookmark.id, code.id, seg)
      }
      setHlSearch('')
      setHlShowSugg(false)
      onCloseHlPanel()
    } finally {
      setHlAdding(false)
    }
  }

  const handleHlCreate = async () => {
    const name = hlSearch.trim()
    if (!name) return
    const segsToAdd = hlSegs.length > 0 ? hlSegs : [hlText]
    if (!segsToAdd.length || !segsToAdd[0]) return
    setHlAdding(true)
    try {
      const existing = allCodes.find((c) => c.name.toLowerCase() === name.toLowerCase())
      const code = existing ?? (await onNewCode(name, hlNewColor))
      for (const seg of segsToAdd) {
        await onAddHighlight(bookmark.id, code.id, seg)
      }
      setHlSearch('')
      setHlShowSugg(false)
      onCloseHlPanel()
    } finally {
      setHlAdding(false)
    }
  }

  const handleHlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (hlSuggestions.length > 0) {
        setHlSuggFocusIdx((i) => Math.min(i + 1, hlSuggestions.length - 1))
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHlSuggFocusIdx((i) => {
        if (i <= 0) { hlSearchRef.current?.focus(); return -1 }
        return i - 1
      })
    } else if (e.key === 'Escape') {
      setHlShowSugg(false)
      setHlSuggFocusIdx(-1)
      onCloseHlPanel()
    } else if (e.key === 'Enter') {
      if (hlSuggFocusIdx >= 0 && hlSuggestions[hlSuggFocusIdx]) {
        handleHlAddExisting(hlSuggestions[hlSuggFocusIdx])
      } else {
        handleHlCreate()
      }
    }
  }

  // Focus hl search when panel opens
  useEffect(() => {
    if (isHlOpen) {
      setHlSearch('')
      setHlShowSugg(false)
      setHlSuggFocusIdx(-1)
      setTimeout(() => hlSearchRef.current?.focus(), 50)
    }
  }, [isHlOpen])

  // Group highlights by code_id
  const hlByCode = highlights.reduce<Record<number, { code: { id: number; name: string; color: string }; texts: { id: number; text: string }[] }>>(
    (acc, hl) => {
      if (!acc[hl.code_id]) {
        acc[hl.code_id] = {
          code: { id: hl.code_id, name: hl.code_name, color: hl.code_color },
          texts: [],
        }
      }
      acc[hl.code_id].texts.push({ id: hl.id, text: hl.highlighted_text })
      return acc
    },
    {},
  )

  const pendingTexts = isHlOpen ? (hlSegs.length > 0 ? hlSegs : hlText ? [hlText] : []) : []
  const annotatedHtml = annotateExcerpt(bookmark.content || '', highlights, pendingTexts)

  const savedAt = bookmark.created_at ? new Date(bookmark.created_at).toLocaleString() : ''

  return (
    <div className="bg-white shadow-md border border-amber-100 rounded-2xl overflow-hidden">
      {/* Amber header */}
      <div className="bg-amber-50 px-4 py-2 flex items-center justify-between gap-2 border-b border-amber-100">
        <span className="text-xs text-amber-700 flex items-center gap-1">
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          Saved {savedAt}
        </span>
        <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-600 font-medium">
          Remove
        </button>
      </div>

      {/* Body */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center flex-wrap gap-1.5">
              <span className="ubadge" style={getUserStyle(bookmark.username || '')}>
                {bookmark.username}
              </span>
              {isTruthy(bookmark.is_suno_team) && (
                <span
                  className="text-xs px-2 py-0.5 font-medium"
                  style={{ background: '#fef3c7', color: '#92400e' }}
                >
                  Suno Team
                </span>
              )}
            </div>
            <span className="text-xs text-gray-400">{bookmark.date?.slice(0, 19).replace('T', ' ')}</span>
          </div>
        </div>

        {/* Annotated excerpt */}
        <p
          className="bm-excerpt-text text-sm leading-relaxed text-gray-800 whitespace-pre-wrap break-words"
          data-bm-id={bookmark.id}
          dangerouslySetInnerHTML={{ __html: annotatedHtml }}
          onContextMenu={(e) => {
            // handled at page level; just prevent default so page handler fires
            e.preventDefault()
          }}
        />

        {/* Codes row */}
        <div className="flex items-center flex-wrap gap-1.5 mt-3 min-h-[1.5rem]">
          {bookmarkCodes.map((c) => (
            <span
              key={c.id}
              className="text-xs px-2.5 py-0.5 rounded-full font-medium cursor-pointer select-none transition-opacity hover:opacity-80"
              style={{ background: c.color, color: labelTextColor(c.color) }}
              onClick={() => onRemoveCode(c.id)}
              title="Click to remove code"
            >
              {c.name} ×
            </span>
          ))}
          <button
            onClick={() => {
              setCodeOpen((v) => !v)
              setTimeout(() => searchRef.current?.focus(), 50)
            }}
            className="text-xs text-gray-500 hover:text-indigo-600 border border-dashed border-gray-300 hover:border-indigo-400 px-2.5 py-0.5 rounded-full transition-colors"
          >
            + code
          </button>
        </div>

        {/* Inline code picker (whole-bookmark) */}
        {codeOpen && (
          <div className="mt-1 p-2 border border-dashed border-indigo-200 bg-indigo-50/30">
            <div className="flex items-start justify-between gap-2 mb-2">
              <p className="text-xs font-medium text-indigo-700">Coding whole quote</p>
              <button
                onClick={() => setCodeOpen(false)}
                className="text-gray-400 hover:text-gray-600 leading-none text-sm"
              >
                ✕
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1 min-w-0">
                <input
                  ref={searchRef}
                  value={codeSearch}
                  onChange={(e) => {
                    setCodeSearch(e.target.value)
                    setShowSuggestions(true)
                    setSuggFocusIdx(-1)
                  }}
                  onKeyDown={handleCodeKeyDown}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  placeholder="Type to search or create a code…"
                  className="w-full border border-gray-200 px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  autoComplete="off"
                />
                {showSuggestions && suggestions.length > 0 && (
                  <div
                    ref={suggListRef}
                    className="absolute left-0 top-full mt-0.5 z-50 bg-white border border-gray-200 shadow py-1 w-full max-h-44 overflow-y-auto"
                  >
                    {suggestions.map((c, idx) => (
                      <button
                        key={c.id}
                        type="button"
                        tabIndex={0}
                        data-sugg-idx={idx}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          handleAddExisting(c.id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowDown') {
                            e.preventDefault()
                            const next = suggListRef.current?.children[idx + 1] as HTMLElement
                            next?.focus()
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault()
                            if (idx === 0) searchRef.current?.focus()
                            else {
                              const prev = suggListRef.current?.children[idx - 1] as HTMLElement
                              prev?.focus()
                            }
                          } else if (e.key === 'Enter') {
                            handleAddExisting(c.id)
                          } else if (e.key === 'Escape') {
                            setShowSuggestions(false)
                            searchRef.current?.focus()
                          }
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-50 flex items-center gap-2 transition-colors focus:bg-indigo-100 outline-none"
                      >
                        <span className="w-2.5 h-2.5 shrink-0" style={{ background: c.color }} />
                        <span className="truncate">{c.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ColorPicker value={newCodeColor} onChange={setNewCodeColor} />
              <button
                onClick={handleCreate}
                disabled={adding || !codeSearch.trim()}
                className="text-xs px-2.5 py-1 bg-indigo-600 text-white hover:bg-indigo-500 shrink-0 disabled:opacity-50"
              >
                {adding ? '…' : 'Add'}
              </button>
            </div>
          </div>
        )}

        {/* Coded spans — one row per highlight */}
        {highlights.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Coded Spans</p>
            <div className="space-y-1.5">
              {highlights.map((hl) => (
                <div
                  key={hl.id}
                  className="flex items-start gap-2 border-l-4 pl-2.5 py-0.5"
                  style={{ borderColor: hl.code_color }}
                >
                  <p className="flex-1 min-w-0 text-xs italic text-gray-600 leading-relaxed">
                    &ldquo;{hl.highlighted_text}&rdquo;
                  </p>
                  <span
                    className="text-xs px-2.5 py-0.5 rounded-full font-medium shrink-0 leading-snug"
                    style={{ background: hl.code_color, color: labelTextColor(hl.code_color) }}
                  >
                    {hl.code_name}
                  </span>
                  <button
                    onClick={() => onRemoveHighlight(bookmark.id, hl.id)}
                    className="text-sm text-gray-400 hover:text-red-500 leading-none shrink-0 mt-0.5"
                    title="Remove highlight"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Highlight picker panel */}
        {isHlOpen && (
          <div className="mt-2 p-2 border border-dashed border-indigo-400 bg-indigo-50/50">
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <div className="min-w-0">
                <p className="text-xs font-medium text-indigo-700">Open coding span</p>
                <p className="text-xs text-gray-500 italic truncate">
                  Coding:{' '}
                  <span className="font-medium text-indigo-800">
                    «{hlSegs.length > 0 ? hlSegs.join(' … ') : hlText}»
                  </span>
                </p>
              </div>
              <button
                onClick={onCloseHlPanel}
                className="text-gray-400 hover:text-gray-600 leading-none text-sm shrink-0"
              >
                ✕
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1 min-w-0">
                <input
                  ref={hlSearchRef}
                  value={hlSearch}
                  onChange={(e) => {
                    setHlSearch(e.target.value)
                    setHlShowSugg(true)
                    setHlSuggFocusIdx(-1)
                  }}
                  onKeyDown={handleHlKeyDown}
                  onFocus={() => setHlShowSugg(true)}
                  onBlur={() => setTimeout(() => setHlShowSugg(false), 150)}
                  placeholder="Type to search or create a code…"
                  className="w-full border border-gray-200 px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  autoComplete="off"
                />
                {hlShowSugg && hlSuggestions.length > 0 && (
                  <div className="absolute left-0 top-full mt-0.5 z-50 bg-white border border-gray-200 shadow py-1 w-full max-h-44 overflow-y-auto">
                    {hlSuggestions.map((c, idx) => (
                      <button
                        key={c.id}
                        type="button"
                        tabIndex={0}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-50 flex items-center gap-2 transition-colors outline-none ${hlSuggFocusIdx === idx ? 'bg-indigo-100' : ''}`}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          handleHlAddExisting(c)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleHlAddExisting(c)
                          else if (e.key === 'ArrowDown') {
                            e.preventDefault()
                            setHlSuggFocusIdx((i) => Math.min(i + 1, hlSuggestions.length - 1))
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault()
                            if (idx === 0) { hlSearchRef.current?.focus(); setHlSuggFocusIdx(-1) }
                            else setHlSuggFocusIdx((i) => i - 1)
                          } else if (e.key === 'Escape') {
                            setHlShowSugg(false)
                            onCloseHlPanel()
                          }
                        }}
                      >
                        <span className="w-2.5 h-2.5 shrink-0" style={{ background: c.color }} />
                        <span className="truncate">{c.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ColorPicker value={hlNewColor} onChange={setHlNewColor} />
              <button
                onClick={handleHlCreate}
                disabled={hlAdding || !hlSearch.trim()}
                className="text-xs px-2.5 py-1 bg-indigo-600 text-white hover:bg-indigo-500 shrink-0 disabled:opacity-50"
              >
                {hlAdding ? '…' : 'Add'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t bg-gray-50 px-4 py-2 flex justify-end">
        <button
          onClick={handleCtxToggle}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
        >
          {ctxLoading ? 'Loading…' : ctxOpen ? 'Hide context ↕' : 'Show context ↕'}
        </button>
      </div>

      {/* Context panel */}
      {ctxOpen && !ctxLoading && (
        <div className="border-t bg-slate-50 p-4 space-y-2">
          <p className="text-xs text-gray-500 font-medium mb-3">
            Context {ctxMessages.length} messages ({ctxBefore} before · {ctxAfter} after)
          </p>
          {ctxMessages.map((m) => (
            <div
              key={m.id}
              className={`flex gap-2 text-xs px-2 py-1.5 ${
                m.id === bookmark.msg_id
                  ? 'bg-yellow-50 border border-yellow-200 rounded-lg'
                  : 'bg-slate-50'
              }`}
            >
              <span className="shrink-0 font-semibold" style={getUserStyle(m.username || '')}>
                {m.username}
              </span>
              <span className="text-gray-400 shrink-0 whitespace-nowrap">{m.date?.slice(0, 19).replace('T', ' ')}</span>
              <span className="text-gray-700 flex-1 break-words">{m.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── BookmarksPage ─────────────────────────────────────────────────────────────

export default function BookmarksPage() {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const module = pathname.split('/')[1] // 'discord', 'coding', etc.
  const sourceParam = searchParams.get('source') as SourceFilter | null

  const defaultSource: SourceFilter =
    sourceParam === 'interview' || sourceParam === 'news' ? sourceParam :
    module === 'interview' ? 'interview' :
    module === 'news' ? 'news' :
    module === 'coding' ? 'all' : 'discord'
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(defaultSource)

  const [ctxBefore, setCtxBefore] = useState(10)
  const [ctxAfter, setCtxAfter] = useState(10)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [filterUserRaw, setFilterUserRaw] = useState('')
  const [filterSuno, setFilterSuno] = useState<SunoFilter>('all')
  const [filterCoded, setFilterCoded] = useState<CodedFilter>('all')
  const [filterTextRaw, setFilterTextRaw] = useState('')
  const [periodFrom, setPeriodFrom] = useState('')
  const [periodTo, setPeriodTo] = useState('')
  const [closeAllStamp, setCloseAllStamp] = useState(0)

  const filterUser = useDebounce(filterUserRaw, 250)
  const filterText = useDebounce(filterTextRaw, 250)

  // Popover state
  const [popover, setPopover] = useState<PopoverState | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Active highlight panel
  const [activeHl, setActiveHl] = useState<{ bmId: number; text: string; segs: string[] } | null>(null)

  // Bookmarks local state (for optimistic updates)
  const [bookmarks, setBookmarks] = useState<BookmarkWithAll[]>([])
  const bookmarksRef = useRef<BookmarkWithAll[]>([])
  const activeHlRef = useRef(activeHl)
  const popoverRefState = useRef(popover)

  useEffect(() => { bookmarksRef.current = bookmarks }, [bookmarks])
  useEffect(() => { activeHlRef.current = activeHl }, [activeHl])
  useEffect(() => { popoverRefState.current = popover }, [popover])

  // Ctrl+click accumulation
  const ctrlSegsRef = useRef<{ bmId: number; segs: string[] } | null>(null)

  const queryClient = useQueryClient()

  const { data: rawBookmarks, isLoading, refetch } = useQuery<BookmarkWithAll[]>({
    queryKey: ['bookmarks'],
    queryFn: () => apiFetch('/bookmarks'),
  })

  const { data: allCodes = [] } = useQuery<Code[]>({
    queryKey: ['codes'],
    queryFn: () => apiFetch('/codes'),
  })

  const { data: interviewBookmarks = [] } = useQuery<InterviewBookmark[]>({
    queryKey: ['interview-bookmarks'],
    queryFn: () => apiFetch('/interview-bookmarks'),
  })

  const { data: newsBookmarks = [] } = useQuery<{ id: number; excerpt: string; note: string; created_at: string; codes: Code[] }[]>({
    queryKey: ['news-bookmarks'],
    queryFn: () => apiFetch('/news-bookmarks'),
    retry: false,
  })

  // Sync server data into local state — rawBookmarks is undefined until loaded (stable ref),
  // then the actual query result (also stable). Avoid inline `= []` default which creates a
  // new array reference every render and causes an infinite setState → re-render loop.
  useEffect(() => {
    if (rawBookmarks !== undefined) setBookmarks(rawBookmarks)
  }, [rawBookmarks])

  // ── Global mouseup for text selection ────────────────────────────────────────
  const handleMouseUp = useCallback((e: MouseEvent) => {
    // Don't react to clicks inside the popover
    if (popoverRef.current && popoverRef.current.contains(e.target as Node)) return

    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return

    const selectedText = sel.toString().trim()
    if (!selectedText) return

    // Find the nearest ancestor with data-bm-id
    let node: Node | null = sel.anchorNode
    let bmEl: HTMLElement | null = null
    while (node && node !== document.body) {
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
      if (el && el.classList.contains('bm-excerpt-text') && el.dataset.bmId) {
        bmEl = el
        break
      }
      node = node.parentNode
    }
    if (!bmEl) return

    const bmId = parseInt(bmEl.dataset.bmId!)

    // Ctrl+click accumulation
    if (e.ctrlKey || e.metaKey) {
      const current = ctrlSegsRef.current
      if (current && current.bmId === bmId) {
        ctrlSegsRef.current = { bmId, segs: [...current.segs, selectedText] }
      } else {
        ctrlSegsRef.current = { bmId, segs: [selectedText] }
      }
      sel.removeAllRanges()
      const allSegs = ctrlSegsRef.current.segs
      setPopover({
        bmId,
        text: selectedText,
        segs: allSegs,
        x: e.clientX,
        y: e.clientY,
      })
      return
    }

    // Reset ctrl segs if new selection on same or different bookmark without ctrl
    ctrlSegsRef.current = null

    setPopover({
      bmId,
      text: selectedText,
      segs: [],
      x: e.clientX,
      y: e.clientY,
    })
  }, [])

  // ── Global contextmenu for right-click ───────────────────────────────────────
  const handleContextMenu = useCallback((e: MouseEvent) => {
    let node: Node | null = e.target as Node
    let bmEl: HTMLElement | null = null
    while (node && node !== document.body) {
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
      if (el && el.classList.contains('bm-excerpt-text') && el.dataset.bmId) {
        bmEl = el
        break
      }
      node = node.parentNode
    }
    if (!bmEl) return

    e.preventDefault()
    const bmId = parseInt(bmEl.dataset.bmId!)
    const sel = window.getSelection()
    const selectedText = sel && !sel.isCollapsed ? sel.toString().trim() : ''
    if (!selectedText) return

    setPopover({
      bmId,
      text: selectedText,
      segs: [],
      x: e.clientX,
      y: e.clientY,
    })
  }, [])

  // ── Outside click closes popover ─────────────────────────────────────────────
  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
      setPopover(null)
    }
  }, [])

  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('contextmenu', handleContextMenu)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('contextmenu', handleContextMenu)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [handleMouseUp, handleContextMenu, handleMouseDown])

  // ── Mutations (source-aware) ──────────────────────────────────────────────────

  const deleteBookmark = async (bm: BookmarkWithAll) => {
    if (bm.source === 'interview') {
      await apiFetch(`/interview-bookmarks/${bm.id}`, { method: 'DELETE' })
      queryClient.invalidateQueries({ queryKey: ['interview-bookmarks'] })
    } else {
      await apiFetch(`/bookmarks/${bm.id}`, { method: 'DELETE' })
      setBookmarks((prev) => prev.filter((b) => b.id !== bm.id))
      queryClient.invalidateQueries({ queryKey: ['bookmark-ids'] })
    }
  }

  const addCode = async (bm: BookmarkWithAll, codeId: number) => {
    const endpoint = bm.source === 'interview' ? '/interview-bookmark-codes' : '/bookmark-codes'
    await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ bookmark_id: bm.id, code_id: codeId }),
    })
    const codeObj = allCodes.find((c) => c.id === codeId)
    if (codeObj) {
      if (bm.source === 'interview') {
        queryClient.setQueryData<InterviewBookmark[]>(['interview-bookmarks'], (prev) =>
          (prev ?? []).map((b) => b.id === bm.id ? { ...b, codes: [...b.codes, codeObj] } : b),
        )
      } else {
        setBookmarks((prev) =>
          prev.map((b) =>
            b.id === bm.id && !b.codes.some((c) => c.id === codeId)
              ? { ...b, codes: [...b.codes, codeObj] }
              : b,
          ),
        )
      }
    }
  }

  const removeCode = async (bm: BookmarkWithAll, codeId: number) => {
    const endpoint = bm.source === 'interview'
      ? `/interview-bookmark-codes/${bm.id}/${codeId}`
      : `/bookmark-codes/${bm.id}/${codeId}`
    await apiFetch(endpoint, { method: 'DELETE' })
    if (bm.source === 'interview') {
      queryClient.setQueryData<InterviewBookmark[]>(['interview-bookmarks'], (prev) =>
        (prev ?? []).map((b) => b.id === bm.id ? { ...b, codes: b.codes.filter((c) => c.id !== codeId) } : b),
      )
    } else {
      setBookmarks((prev) =>
        prev.map((b) =>
          b.id === bm.id ? { ...b, codes: b.codes.filter((c) => c.id !== codeId) } : b,
        ),
      )
    }
  }

  const createCode = async (name: string, color: string): Promise<Code> => {
    const code = await apiFetch<Code>('/codes', {
      method: 'POST',
      body: JSON.stringify({ name, color }),
    })
    queryClient.invalidateQueries({ queryKey: ['codes'] })
    return code
  }

  const addHighlight = async (
    bm: BookmarkWithAll,
    codeId: number,
    text: string,
  ): Promise<BookmarkHighlight> => {
    const baseEndpoint = bm.source === 'interview'
      ? `/interview-bookmarks/${bm.id}/highlights`
      : `/bookmarks/${bm.id}/highlights`
    const result = await apiFetch<{ id: number; bookmark_id: number; code_id: number; highlighted_text: string }>(
      baseEndpoint,
      {
        method: 'POST',
        body: JSON.stringify({ code_id: codeId, highlighted_text: text }),
      },
    )
    const codeObj = allCodes.find((c) => c.id === codeId)
    const hl: BookmarkHighlight = {
      id: result.id,
      code_id: codeId,
      code_name: codeObj?.name ?? '',
      code_color: codeObj?.color ?? '#888888',
      highlighted_text: text,
    }
    if (bm.source !== 'interview') {
      setBookmarks((prev) =>
        prev.map((b) => {
          if (b.id !== bm.id) return b
          const newCodes = codeObj && !b.codes.some((c) => c.id === codeId)
            ? [...b.codes, codeObj] : b.codes
          return { ...b, highlights: [...b.highlights, hl], codes: newCodes }
        }),
      )
    }
    return hl
  }

  const removeHighlight = async (bm: BookmarkWithAll, hlId: number) => {
    const baseEndpoint = bm.source === 'interview'
      ? `/interview-bookmarks/${bm.id}/highlights/${hlId}`
      : `/bookmarks/${bm.id}/highlights/${hlId}`
    await apiFetch(baseEndpoint, { method: 'DELETE' })
    if (bm.source !== 'interview') {
      setBookmarks((prev) =>
        prev.map((b) =>
          b.id === bm.id
            ? { ...b, highlights: b.highlights.filter((h) => h.id !== hlId) }
            : b,
        ),
      )
    }
  }

  // ── Merge all sources into unified list ───────────────────────────────────────

  const allBookmarks = useMemo(() => {
    const discordBms: BookmarkWithAll[] = (bookmarks ?? []).map(b => ({ ...b, source: 'discord' as const }))
    const interviewBms: BookmarkWithAll[] = (interviewBookmarks ?? []).map(b => ({
      id: b.id,
      msg_id: b.id,
      note: b.note,
      created_at: b.created_at,
      content: b.excerpt,
      username: b.interviewees || b.interview_id,
      date: b.source_date || b.created_at,
      is_suno_team: false,
      codes: b.codes,
      highlights: (b.highlights ?? []).map(h => ({
        id: h.id,
        code_id: h.code_id,
        code_name: h.code_name,
        code_color: h.code_color,
        highlighted_text: h.highlighted_text,
      })),
      source: 'interview' as const,
    }))
    const newsBms: BookmarkWithAll[] = (newsBookmarks ?? []).map(b => ({
      id: b.id,
      msg_id: b.id,
      note: b.note ?? '',
      created_at: b.created_at,
      content: b.excerpt,
      username: (b as any).article_id ?? '',
      date: b.created_at,
      is_suno_team: false,
      codes: b.codes ?? [],
      highlights: [],
      source: 'news' as const,
    }))
    return [...discordBms, ...interviewBms, ...newsBms]
  }, [bookmarks, interviewBookmarks, newsBookmarks])

  // ── Filter & sort ─────────────────────────────────────────────────────────────

  const filtered = allBookmarks.filter((bm) => {
    // Source filter
    if (sourceFilter !== 'all' && bm.source !== sourceFilter) return false
    if (filterUser && !(bm.username || '').toLowerCase().includes(filterUser.toLowerCase()))
      return false
    if (filterSuno === 'only' && !isTruthy(bm.is_suno_team)) return false
    if (filterSuno === 'exclude' && isTruthy(bm.is_suno_team)) return false
    const isCoded = (bm.codes?.length ?? 0) > 0 || (bm.highlights?.length ?? 0) > 0
    if (filterCoded === 'coded' && !isCoded) return false
    if (filterCoded === 'uncoded' && isCoded) return false
    if (filterText) {
      const words = filterText.toLowerCase().split(/\s+/).filter(Boolean)
      const hay = ((bm.username || '') + ' ' + (bm.content || '')).toLowerCase()
      if (!words.every((w) => hay.includes(w))) return false
    }
    if (periodFrom && (bm.date || '').slice(0, 10) < periodFrom) return false
    if (periodTo && (bm.date || '').slice(0, 10) > periodTo) return false
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortKey === 'date') return dir * ((a.date ?? '').localeCompare(b.date ?? ''))
    if (sortKey === 'added') return dir * ((a.created_at ?? '').localeCompare(b.created_at ?? ''))
    if (sortKey === 'username') return dir * ((a.username ?? '').localeCompare(b.username ?? ''))
    return 0
  })

  const total = allBookmarks.length
  const shown = sorted.length
  const codedCount = filtered.filter(
    (b) => (b.codes?.length ?? 0) > 0 || (b.highlights?.length ?? 0) > 0,
  ).length

  // ── Infinite scroll ───────────────────────────────────────────────────────────
  const [visibleCount, setVisibleCount] = useState(10)
  const ioRef = useRef<IntersectionObserver | null>(null)

  // Callback ref: fires whenever the sentinel mounts or unmounts
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    if (ioRef.current) { ioRef.current.disconnect(); ioRef.current = null }
    if (!node) return
    ioRef.current = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) setVisibleCount((c) => c + 20) },
      { rootMargin: '400px' },
    )
    ioRef.current.observe(node)
  }, [])

  // Reset to first page when filters or sort change
  useEffect(() => {
    setVisibleCount(10)
  }, [filterUser, filterText, filterSuno, filterCoded, periodFrom, periodTo, sortKey, sortDir])

  const handleCloseAll = () => {
    setCloseAllStamp((s) => s + 1)
    setActiveHl(null)
    setPopover(null)
  }

  // Popover: open hl panel for a bookmark
  const handlePopoverAddCode = () => {
    if (!popover) return
    setActiveHl({ bmId: popover.bmId, text: popover.text, segs: popover.segs })
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 space-y-4">

      {/* Source filter chips */}
      <div className="flex items-center gap-2 flex-wrap px-1">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Source</span>
        {(['all', 'discord', 'interview', 'news'] as SourceFilter[]).map((src) => {
          const active = sourceFilter === src
          const labels: Record<SourceFilter, string> = { all: 'All', discord: 'Discord', interview: 'Interview', news: 'News' }
          const colors: Record<SourceFilter, string> = {
            all: active ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
            discord: active ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100',
            interview: active ? 'bg-teal-600 text-white' : 'bg-teal-50 text-teal-700 hover:bg-teal-100',
            news: active ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-700 hover:bg-amber-100',
          }
          return (
            <button
              key={src}
              onClick={() => setSourceFilter(src)}
              className={`text-xs px-3 py-1 rounded-full font-semibold transition-colors ${colors[src]}`}
            >
              {labels[src]}
            </button>
          )
        })}
      </div>

      {/* Floating popover (fixed position) */}
      {popover && (
        <div
          ref={popoverRef}
          className="fixed z-[200] bg-white border border-indigo-300 shadow-lg rounded-lg px-3 py-2 flex flex-col gap-1.5 min-w-[220px]"
          style={{ left: popover.x + 8, top: popover.y - 8 }}
        >
          <button
            className="text-xs font-medium text-indigo-700 hover:text-indigo-900 text-left"
            onClick={handlePopoverAddCode}
          >
            {popover.segs.length > 1
              ? `Add open coding (${popover.segs.length} spans)`
              : 'Add open coding'}
          </button>
          {(popover.segs.length > 0 || true) && (
            <p className="text-[10px] text-gray-400">Ctrl+select to accumulate spans</p>
          )}
        </div>
      )}

      {/* Sticky filter bar */}
      <div
        className="sticky top-0 z-30 bg-white rounded-2xl border-b border-gray-100 shadow-sm px-4 py-3"
        role="search"
        aria-label="Bookmark filters"
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="filter-label">Username</label>
            <input
              type="text"
              value={filterUserRaw}
              onChange={(e) => setFilterUserRaw(e.target.value)}
              placeholder="filter…"
              className="search-input text-xs py-1 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="filter-label">Content</label>
            <input
              type="text"
              value={filterTextRaw}
              onChange={(e) => setFilterTextRaw(e.target.value)}
              placeholder="filter…"
              className="search-input text-xs py-1 w-40"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="filter-label">Suno Team</label>
            <select
              value={filterSuno}
              onChange={(e) => setFilterSuno(e.target.value as SunoFilter)}
              className="search-input text-xs py-1 cursor-pointer"
            >
              <option value="all">All</option>
              <option value="only">Only Suno</option>
              <option value="exclude">Exclude Suno</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="filter-label">Coded</label>
            <select
              value={filterCoded}
              onChange={(e) => setFilterCoded(e.target.value as CodedFilter)}
              className="search-input text-xs py-1 cursor-pointer"
            >
              <option value="all">All</option>
              <option value="coded">Coded only</option>
              <option value="uncoded">Uncoded only</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="filter-label">Sort</label>
            <div className="flex">
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="search-input text-xs py-1 cursor-pointer"
              >
                <option value="date">Msg Date</option>
                <option value="added">Saved Date</option>
                <option value="username">Username</option>
              </select>
              <button
                onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                className="search-input text-xs py-1 px-2 border-l-0 hover:bg-gray-100 select-none"
              >
                {sortDir === 'desc' ? '↓' : '↑'}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="filter-label">From</label>
            <input
              type="date"
              value={periodFrom}
              onChange={(e) => setPeriodFrom(e.target.value)}
              className="search-input text-xs py-1"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="filter-label">To</label>
            <input
              type="date"
              value={periodTo}
              onChange={(e) => setPeriodTo(e.target.value)}
              className="search-input text-xs py-1"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="filter-label">Context Window</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                value={ctxBefore}
                onChange={(e) => setCtxBefore(parseInt(e.target.value) || 0)}
                min={0}
                max={100}
                className="search-input text-xs py-1 w-14 text-center"
              />
              <span className="text-xs text-gray-400">↑</span>
              <input
                type="number"
                value={ctxAfter}
                onChange={(e) => setCtxAfter(parseInt(e.target.value) || 0)}
                min={0}
                max={100}
                className="search-input text-xs py-1 w-14 text-center"
              />
              <span className="text-xs text-gray-400">↓</span>
            </div>
          </div>
          {(filterUserRaw || filterTextRaw || filterSuno !== 'all' || filterCoded !== 'all' || periodFrom || periodTo) && (
            <button
              onClick={() => { setFilterUserRaw(''); setFilterTextRaw(''); setFilterSuno('all'); setFilterCoded('all'); setPeriodFrom(''); setPeriodTo('') }}
              className="self-end pb-1 text-xs text-gray-400 hover:text-red-500 transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              Clear
            </button>
          )}
          <button
            onClick={() => { refetch(); queryClient.invalidateQueries({ queryKey: ['interview-bookmarks'] }); queryClient.invalidateQueries({ queryKey: ['news-bookmarks'] }) }}
            className="self-end ml-auto pb-1 text-xs font-semibold text-indigo-700 hover:underline shrink-0"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Unified bookmarks section */}
      <section className="bg-white rounded-2xl shadow p-5" aria-labelledby="bookmarks-heading">
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <h2
            id="bookmarks-heading"
            className="font-semibold text-sm text-gray-700 uppercase tracking-wide"
          >
            Bookmarks
          </h2>
          <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
            sourceFilter === 'discord' ? 'bg-indigo-100 text-indigo-700' :
            sourceFilter === 'interview' ? 'bg-teal-100 text-teal-700' :
            sourceFilter === 'news' ? 'bg-amber-100 text-amber-700' :
            'bg-gray-100 text-gray-700'
          }`}>
            {sourceFilter === 'all' ? 'All Sources' : sourceFilter.charAt(0).toUpperCase() + sourceFilter.slice(1)}
          </span>
          {total > 0 && (
            <span className="text-xs font-semibold px-2 py-0.5 bg-gray-50 text-gray-600">
              {shown === total ? String(total) : `${shown} / ${total}`}
            </span>
          )}
          {shown > 0 && (
            <span className="text-xs font-semibold px-2 py-0.5 bg-green-50 text-green-700">
              coded {codedCount} / {shown}
            </span>
          )}
        </div>

        <div className="space-y-4" aria-live="polite">
          {isLoading && sourceFilter !== 'interview' && sourceFilter !== 'news' ? (
            <p className="text-sm text-gray-600 text-center py-8">Loading bookmarks…</p>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              {allBookmarks.length === 0
                ? 'No bookmarks yet. Bookmark messages, interview excerpts, or news passages to get started.'
                : 'No bookmarks match the current filters.'}
            </p>
          ) : (
            <>
              {sorted.slice(0, visibleCount).map((bm) => (
                <BookmarkCard
                  key={`${bm.source}-${bm.id}`}
                  bookmark={bm}
                  ctxBefore={ctxBefore}
                  ctxAfter={ctxAfter}
                  allCodes={allCodes}
                  isHlOpen={activeHl?.bmId === bm.id}
                  hlText={activeHl?.bmId === bm.id ? activeHl.text : ''}
                  hlSegs={activeHl?.bmId === bm.id ? activeHl.segs : []}
                  closeAllStamp={closeAllStamp}
                  onDelete={() => deleteBookmark(bm)}
                  onAddCode={(codeId) => addCode(bm, codeId)}
                  onRemoveCode={(codeId) => removeCode(bm, codeId)}
                  onNewCode={(name, color) => createCode(name, color)}
                  onAddHighlight={(bmId, codeId, text) => addHighlight(bm, codeId, text)}
                  onRemoveHighlight={(bmId, hlId) => removeHighlight(bm, hlId)}
                  onOpenHlPanel={() => setActiveHl({ bmId: bm.id, text: '', segs: [] })}
                  onCloseHlPanel={() => setActiveHl(null)}
                />
              ))}
              {visibleCount < sorted.length && (
                <div ref={sentinelRef} className="py-4 text-center text-xs text-gray-400">
                  Showing {Math.min(visibleCount, sorted.length)} of {sorted.length} — scroll for more
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  )
}
