import { useState, useEffect, useRef, useMemo } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api/client'
import ColorPicker from '../components/ui/ColorPicker'
import type { Code, CodeCategory, Bookmark, BookmarkCode, ContextMessage, InterviewBookmark } from '../types'

type PageTab = 'manager' | 'table'
type AuthorFilter = 'all' | 'only' | 'exclude'
type DetailMode = 'code' | 'category' | 'excerpt' | null

interface CodeExt extends Code {
  groundedness?: number
  density?: number
}

interface CodeCategoryExt extends CodeCategory {
  color?: string
  parent_id?: number | null
}

interface TreeNode extends CodeCategoryExt {
  children: TreeNode[]
  codes: CodeExt[]
}

function labelTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#1f2937' : '#ffffff'
}

function isTruthy(v: unknown): boolean {
  return v === true || v === 'True' || v === '1' || v === 1
}

interface DndHandlers {
  onCodeDragStart: (e: React.DragEvent, codeId: number) => void
  onCodeDrop: (e: React.DragEvent, catId: number | null) => void
  onExcerptDragStart: (e: React.DragEvent, bookmarkId: number, fromCodeId: number) => void
  onExcerptDrop: (e: React.DragEvent, toCodeId: number) => void
  dragOverCatId: number | null
  setDragOverCatId: (id: number | null) => void
  dragOverCodeId: number | null
  setDragOverCodeId: (id: number | null) => void
}

interface CodeCardProps {
  code: CodeExt
  depth: number
  expanded: boolean
  excerpts: BookmarkCode[] | undefined
  filteredBmIds: Set<number>
  bookmarks: Bookmark[]
  mergeMode: boolean
  mergeSelected: boolean
  onMergeToggle: (id: number) => void
  isActive: boolean
  onToggle: (code: CodeExt) => void
  dnd: DndHandlers
  onOpenExcerpt: (bc: BookmarkCode, bm: Bookmark, mode?: 'add' | 'change') => void
  onDeleteExcerptCode: (bc: BookmarkCode, bookmarkId: number) => void
  activeExcerptKey: string | null
}

function CodeCard({ code, depth, expanded, excerpts, filteredBmIds, bookmarks, mergeMode, mergeSelected, onMergeToggle, isActive, onToggle, dnd, onOpenExcerpt, onDeleteExcerptCode, activeExcerptKey }: CodeCardProps) {
  const tc = labelTextColor(code.color)
  const quoteCount = (excerpts || []).length
  const isDragOver = dnd.dragOverCodeId === code.id
  const selCls = mergeMode && mergeSelected
    ? 'ring-2 ring-amber-400 bg-amber-50'
    : isActive
      ? 'border-indigo-400 bg-indigo-50'
      : isDragOver
        ? 'border-purple-400 bg-purple-50 ring-2 ring-purple-300'
        : 'bg-white hover:border-indigo-200'

  const filteredExcerpts = (excerpts || []).filter(bc => filteredBmIds.has(bc.bookmark_id))

  const [ctxMenu, setCtxMenu] = useState<{ bc: BookmarkCode; bm: Bookmark; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [!!ctxMenu])

  return (
    <>
    <div style={{ marginLeft: `${8 + depth * 18}px` }}>
      <div
        className={`border rounded-xl p-2.5 flex items-start gap-2 cursor-pointer transition-all ${selCls}`}
        draggable={!mergeMode}
        onDragStart={e => { if (mergeMode) return; e.stopPropagation(); dnd.onCodeDragStart(e, code.id) }}
        onDragEnd={() => { dnd.setDragOverCatId(null); dnd.setDragOverCodeId(null) }}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); dnd.setDragOverCodeId(code.id) }}
        onDragLeave={e => { e.stopPropagation(); dnd.setDragOverCodeId(null) }}
        onDrop={e => { e.stopPropagation(); dnd.onExcerptDrop(e, code.id) }}
        onClick={() => mergeMode ? onMergeToggle(code.id) : onToggle(code)}
      >
        {mergeMode && (
          <input type="checkbox" checked={mergeSelected} readOnly className="mt-0.5 accent-amber-500 shrink-0" />
        )}
        {!mergeMode && (
          <span className="text-gray-300 hover:text-gray-500 cursor-grab shrink-0 mt-0.5 text-xs select-none" title="Drag to move to another category">⠿</span>
        )}
        <span className="w-3 h-3 rounded-full shrink-0 mt-0.5" style={{ background: code.color }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-800">{code.name}</span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
              style={{ background: code.color, color: tc }}
            >
              {quoteCount} quotes
            </span>
          </div>
          {code.description && (
            <p className="text-xs text-gray-500 mt-0.5 truncate">{code.description}</p>
          )}
        </div>
        <span className="text-[10px] text-gray-400 shrink-0 mt-0.5 select-none">
          {expanded ? '▲' : '▼'}
        </span>
      </div>
      {expanded && (
        <div className="mt-1 ml-3 space-y-1.5">
          {filteredExcerpts.length === 0 ? (
            <div className="text-xs text-gray-400 italic text-center py-1.5 border-l-2 border-indigo-200 pl-2">
              {excerpts === undefined ? 'Loading excerpts…' : 'No excerpts yet.'}
            </div>
          ) : (
            filteredExcerpts.map((bc, i) => {
              const bm = bookmarks.find(b => b.id === bc.bookmark_id)
              const excKey = `${bc.bookmark_id}-${code.id}`
              const isExcActive = activeExcerptKey === excKey
              return (
                <div key={i}>
                  <div
                    className={`border-l-2 pl-2 py-1 rounded-r-md transition-colors cursor-pointer ${isExcActive ? 'bg-indigo-100/60 border-indigo-400' : 'hover:bg-indigo-50/60'}`}
                    style={{ borderColor: isExcActive ? undefined : code.color }}
                    draggable
                    onDragStart={e => { e.stopPropagation(); dnd.onExcerptDragStart(e, bc.bookmark_id, code.id) }}
                    onDragEnd={() => dnd.setDragOverCodeId(null)}
                    onClick={e => { e.stopPropagation(); if (bm) onOpenExcerpt(bc, bm) }}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (bm) setCtxMenu({ bc, bm, x: e.clientX, y: e.clientY }) }}
                  >
                    <div className="flex items-start gap-1.5">
                      <span
                        className="text-gray-300 text-xs shrink-0 mt-0.5 select-none cursor-grab"
                        title="Drag to reassign to another code"
                        onClick={e => e.stopPropagation()}
                      >⠿</span>
                      <div className="flex-1 min-w-0">
                        {bc.highlighted_text ? (
                          <p className="text-xs italic text-gray-800 leading-relaxed font-medium">
                            &ldquo;{bc.highlighted_text}&rdquo;
                          </p>
                        ) : (
                          <p className="text-xs italic text-gray-700 leading-relaxed">
                            &ldquo;{(bm?.content || '').substring(0, 180)}{(bm?.content || '').length > 180 ? '…' : ''}&rdquo;
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-0.5">
                          <p className="text-[10px] text-gray-400">
                            {bm?.username || ''}{bm?.date ? ' · ' + bm.date.substring(0, 10) : ''}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
    {ctxMenu && (
      <div
        className="fixed z-[300] bg-white border border-gray-200 shadow-lg rounded-lg py-1 min-w-[170px]"
        style={{ left: ctxMenu.x, top: ctxMenu.y }}
        onMouseDown={e => e.stopPropagation()}
      >
        <button
          className="w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-50 text-gray-700 transition-colors"
          onClick={() => { onOpenExcerpt(ctxMenu.bc, ctxMenu.bm, 'add'); setCtxMenu(null) }}
        >
          + Add open coding
        </button>
        <button
          className="w-full text-left px-3 py-1.5 text-xs hover:bg-amber-50 text-gray-700 transition-colors"
          onClick={() => { onOpenExcerpt(ctxMenu.bc, ctxMenu.bm, 'change'); setCtxMenu(null) }}
        >
          ↔ Change coding
        </button>
        <div className="border-t border-gray-100 my-0.5" />
        <button
          className="w-full text-left px-3 py-1.5 text-xs hover:bg-red-50 text-red-500 transition-colors"
          onClick={() => { onDeleteExcerptCode(ctxMenu.bc, ctxMenu.bm.id); setCtxMenu(null) }}
        >
          × Delete coding
        </button>
      </div>
    )}
    </>
  )
}

interface CatNodeProps {
  node: TreeNode
  depth: number
  collapsedCats: Set<number>
  onToggleCollapse: (id: number) => void
  expandedCodes: Set<number>
  onToggleCode: (code: CodeExt) => void
  filteredBmIds: Set<number>
  bookmarks: Bookmark[]
  bookmarkCodes: BookmarkCode[]
  mergeMode: boolean
  mergeSelected: Set<number>
  onMergeToggle: (id: number) => void
  activeCodeId: number | null
  activeCatId: number | null
  onOpenCat: (cat: CodeCategoryExt) => void
  dnd: DndHandlers
  filterActive: boolean
  onOpenExcerpt: (bc: BookmarkCode, bm: Bookmark, mode?: 'add' | 'change') => void
  onDeleteExcerptCode: (bc: BookmarkCode, bookmarkId: number) => void
  activeExcerptKey: string | null
}

function CatNode({
  node, depth, collapsedCats, onToggleCollapse, expandedCodes, onToggleCode,
  filteredBmIds, bookmarks, bookmarkCodes, mergeMode, mergeSelected, onMergeToggle,
  activeCodeId, activeCatId, onOpenCat, dnd, filterActive, onOpenExcerpt, onDeleteExcerptCode, activeExcerptKey,
}: CatNodeProps) {
  const codeHasFilteredExcerpts = (code: CodeExt) =>
    bookmarkCodes.some(bc => bc.code_id === code.id && filteredBmIds.has(bc.bookmark_id))

  const nodeHasVisible = (n: TreeNode): boolean => {
    if (!filterActive) return true
    const hasCodes = n.codes.some(codeHasFilteredExcerpts)
    return hasCodes || n.children.some(ch => nodeHasVisible(ch))
  }

  const visibleCodes = filterActive ? node.codes.filter(codeHasFilteredExcerpts) : node.codes
  const visibleChildren = filterActive ? node.children.filter(ch => nodeHasVisible(ch)) : node.children

  const isCollapsed = collapsedCats.has(node.id)
  const isActive = activeCatId === node.id
  const isDragOver = dnd.dragOverCatId === node.id
  const pl = 8 + depth * 18
  const headerBg = isDragOver
    ? 'bg-indigo-100 ring-2 ring-indigo-400'
    : isActive
      ? 'bg-slate-100'
      : 'hover:bg-gray-50'
  const hasContent = visibleCodes.length > 0 || visibleChildren.length > 0
  const toggleIcon = hasContent ? (isCollapsed ? '▶' : '▼') : ''
  const totalCodes = (function countCodes(n: TreeNode): number {
    return n.codes.length + n.children.reduce((s, ch) => s + countCodes(ch), 0)
  })(node)

  return (
    <div>
      <div
        className={`flex items-center gap-2 py-1.5 rounded-lg cursor-pointer group transition-colors ${headerBg}`}
        style={{ paddingLeft: `${pl}px`, paddingRight: '8px' }}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); dnd.setDragOverCatId(node.id) }}
        onDragLeave={e => { e.stopPropagation(); dnd.setDragOverCatId(null) }}
        onDrop={e => { e.stopPropagation(); dnd.onCodeDrop(e, node.id) }}
        onClick={() => { onToggleCollapse(node.id); onOpenCat(node) }}
      >
        <span className="w-3 text-[9px] text-gray-400 shrink-0">{toggleIcon}</span>
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: node.color || '#94a3b8' }} />
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide flex-1 truncate">{node.name}</span>
        {isDragOver && <span className="text-[10px] text-indigo-600 font-semibold shrink-0">Drop here</span>}
        {!isDragOver && totalCodes > 0 && (
          <span className="text-[10px] text-gray-400 shrink-0">{totalCodes} open codings</span>
        )}
        <button
          className="hidden group-hover:inline text-[10px] text-indigo-500 hover:text-indigo-700 ml-1 shrink-0"
          onClick={e => { e.stopPropagation(); onOpenCat(node) }}
        >
          edit
        </button>
      </div>
      {!isCollapsed && (
        <div className="space-y-1 mt-0.5">
          {visibleChildren.map(child => (
            <CatNode
              key={child.id}
              node={child}
              depth={depth + 1}
              collapsedCats={collapsedCats}
              onToggleCollapse={onToggleCollapse}
              expandedCodes={expandedCodes}
              onToggleCode={onToggleCode}
              filteredBmIds={filteredBmIds}
              bookmarks={bookmarks}
              bookmarkCodes={bookmarkCodes}
              mergeMode={mergeMode}
              mergeSelected={mergeSelected}
              onMergeToggle={onMergeToggle}
              activeCodeId={activeCodeId}
              activeCatId={activeCatId}
              onOpenCat={onOpenCat}
              dnd={dnd}
              filterActive={filterActive}
              onOpenExcerpt={onOpenExcerpt}
              onDeleteExcerptCode={onDeleteExcerptCode}
              activeExcerptKey={activeExcerptKey}
            />
          ))}
          <div className="space-y-1">
            {visibleCodes.map(code => {
              const codeExcerpts = bookmarkCodes.filter(bc => bc.code_id === code.id)
              return (
                <CodeCard
                  key={code.id}
                  code={{ ...code, groundedness: codeExcerpts.length }}
                  depth={depth + 1}
                  expanded={expandedCodes.has(code.id)}
                  excerpts={codeExcerpts}
                  filteredBmIds={filteredBmIds}
                  bookmarks={bookmarks}
                  mergeMode={mergeMode}
                  mergeSelected={mergeSelected.has(code.id)}
                  onMergeToggle={onMergeToggle}
                  isActive={activeCodeId === code.id}
                  onToggle={onToggleCode}
                  dnd={dnd}
                  onOpenExcerpt={onOpenExcerpt}
                  onDeleteExcerptCode={onDeleteExcerptCode}
                  activeExcerptKey={activeExcerptKey}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function normalizeInterviewBookmark(bm: InterviewBookmark): Bookmark {
  return {
    id: bm.id,
    msg_id: bm.id,
    content: bm.excerpt,
    username: bm.interviewees || bm.interview_id,
    date: bm.source_date || bm.created_at,
    codes: bm.codes,
    is_suno_team: false,
    note: bm.note,
    created_at: bm.created_at,
  }
}

interface NewsBookmark {
  id: number
  article_id: string
  excerpt: string
  note: string
  char_start?: number
  char_end?: number
  created_at: string
  codes: Code[]
}

function normalizeNewsBookmark(bm: NewsBookmark): Bookmark {
  return {
    id: bm.id,
    msg_id: bm.id,
    content: bm.excerpt,
    username: bm.article_id,
    date: bm.created_at,
    codes: bm.codes,
    is_suno_team: false,
    note: bm.note,
    created_at: bm.created_at,
  }
}

type CodingSource = 'all' | 'discord' | 'interview' | 'news'

export default function CodingPage() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const pageTab: PageTab = pathname.endsWith('/table') ? 'table' : 'manager'
  const setPageTab = (tab: PageTab) => {
    localStorage.setItem('coding_tab', tab)
    // Preserve source query param when switching tabs
    const source = searchParams.get('source')
    const suffix = source ? `?source=${source}` : ''
    navigate(`../${tab}${suffix}`, { relative: 'path' })
  }

  const module = pathname.split('/')[1] // 'discord', 'coding', 'interview', 'news'
  const sourceParam = searchParams.get('source') as CodingSource | null
  const defaultSrc: CodingSource =
    sourceParam === 'interview' || sourceParam === 'news' ? sourceParam :
    module === 'interview' ? 'interview' :
    module === 'news' ? 'news' : 'discord'
  const [sourceFilter, setSourceFilter] = useState<CodingSource>(defaultSrc)
  const isAllSrc = sourceFilter === 'all'
  const isDiscordSrc = sourceFilter === 'discord' || isAllSrc
  const isInterviewSrc = sourceFilter === 'interview' || isAllSrc
  const isNewsSrc = sourceFilter === 'news' || isAllSrc

  const queryClient = useQueryClient()
  const { data: _codes } = useQuery<CodeExt[]>({ queryKey: ['codes'], queryFn: () => apiFetch('/codes') })
  const { data: _categories } = useQuery<CodeCategoryExt[]>({ queryKey: ['code-categories'], queryFn: () => apiFetch('/code-categories') })

  // Always fetch all sources; merge based on filter
  const { data: _discordBookmarks } = useQuery<Bookmark[]>({
    queryKey: ['bookmarks'],
    queryFn: () => apiFetch('/bookmarks'),
  })
  const { data: _discordBookmarkCodes } = useQuery<BookmarkCode[]>({
    queryKey: ['bookmark-codes'],
    queryFn: () => apiFetch('/bookmark-codes'),
  })
  const { data: _interviewBookmarks } = useQuery<InterviewBookmark[]>({
    queryKey: ['interview-bookmarks'],
    queryFn: () => apiFetch('/interview-bookmarks'),
  })
  const { data: _interviewBookmarkCodes } = useQuery<BookmarkCode[]>({
    queryKey: ['interview-bookmark-codes'],
    queryFn: () => apiFetch('/interview-bookmark-codes'),
  })
  const { data: _newsBookmarks } = useQuery<NewsBookmark[]>({
    queryKey: ['news-bookmarks'],
    queryFn: () => apiFetch('/news-bookmarks'),
    retry: false,
  })
  const { data: _newsBookmarkCodes } = useQuery<BookmarkCode[]>({
    queryKey: ['news-bookmark-codes'],
    queryFn: () => apiFetch('/news-bookmark-codes'),
    retry: false,
  })

  // Merge bookmarks and codes based on source filter
  const _rawBookmarks = useMemo(() => {
    const result: (Bookmark | InterviewBookmark | NewsBookmark)[] = []
    if (isDiscordSrc) result.push(...(_discordBookmarks ?? []))
    if (isInterviewSrc) result.push(...(_interviewBookmarks ?? []))
    if (isNewsSrc) result.push(...(_newsBookmarks ?? []))
    return result
  }, [isDiscordSrc, isInterviewSrc, isNewsSrc, _discordBookmarks, _interviewBookmarks, _newsBookmarks])

  const _bookmarkCodes = useMemo(() => {
    const result: BookmarkCode[] = []
    if (isDiscordSrc) result.push(...(_discordBookmarkCodes ?? []))
    if (isInterviewSrc) result.push(...(_interviewBookmarkCodes ?? []))
    if (isNewsSrc) result.push(...(_newsBookmarkCodes ?? []))
    return result
  }, [isDiscordSrc, isInterviewSrc, isNewsSrc, _discordBookmarkCodes, _interviewBookmarkCodes, _newsBookmarkCodes])

  // Source-aware endpoints (used for mutations - determine source from bookmark context)
  const bmCodesEndpoint = '/bookmark-codes' // default for discord; overridden per-mutation
  const rmBmCodeEndpoint = (bmId: number, codeId: number, source?: string) =>
    source === 'interview' ? `/interview-bookmark-codes/${bmId}/${codeId}` :
    source === 'news' ? `/news-bookmark-codes/${bmId}/${codeId}` :
    `/bookmark-codes/${bmId}/${codeId}`

  // Initialize from cache so navigating back shows data instantly (no empty flash)
  const [codes, setCodes] = useState<CodeExt[]>(() => queryClient.getQueryData<CodeExt[]>(['codes']) ?? [])
  const [categories, setCategories] = useState<CodeCategoryExt[]>(() => queryClient.getQueryData<CodeCategoryExt[]>(['code-categories']) ?? [])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => {
    const d = queryClient.getQueryData<Bookmark[]>(['bookmarks']) ?? []
    const i = (queryClient.getQueryData<InterviewBookmark[]>(['interview-bookmarks']) ?? []).map(normalizeInterviewBookmark)
    const n = (queryClient.getQueryData<NewsBookmark[]>(['news-bookmarks']) ?? []).map(normalizeNewsBookmark)
    return [...d, ...i, ...n]
  })
  const [bookmarkCodes, setBookmarkCodes] = useState<BookmarkCode[]>(() =>
    (queryClient.getQueryData<BookmarkCode[]>(['bookmark-codes']) ?? [])
      .concat(queryClient.getQueryData<BookmarkCode[]>(['interview-bookmark-codes']) ?? [])
      .concat(queryClient.getQueryData<BookmarkCode[]>(['news-bookmark-codes']) ?? [])
  )

  useEffect(() => { if (_codes) setCodes(_codes) }, [_codes])
  useEffect(() => { if (_categories) setCategories(_categories) }, [_categories])
  useEffect(() => {
    const normalized = (_rawBookmarks as any[]).map((bm: any) => {
      if (bm.interview_id !== undefined) return normalizeInterviewBookmark(bm as InterviewBookmark)
      if (bm.article_id !== undefined) return normalizeNewsBookmark(bm as NewsBookmark)
      return bm as Bookmark
    })
    setBookmarks(normalized)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_rawBookmarks])
  useEffect(() => { setBookmarkCodes(_bookmarkCodes ?? []) }, [_bookmarkCodes])

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [authorFilter, setAuthorFilter] = useState<AuthorFilter>('all')

  const [collapsedCats, setCollapsedCats] = useState<Set<number>>(new Set())
  const [expandedCodes, setExpandedCodes] = useState<Set<number>>(new Set())
  const [mergeMode, setMergeMode] = useState(false)
  const [mergeSelected, setMergeSelected] = useState<Set<number>>(new Set())
  const [dragOverCatId, setDragOverCatId] = useState<number | null>(null)
  const [dragOverCodeId, setDragOverCodeId] = useState<number | null>(null)
  const [showNewCode, setShowNewCode] = useState(false)
  const [showNewCat, setShowNewCat] = useState(false)
  const [codeSearchFilter, setCodeSearchFilter] = useState('')

  const [newCodeName, setNewCodeName] = useState('')
  const [newCodeColor, setNewCodeColor] = useState('#0d3e7f')
  const [newCodeCatId, setNewCodeCatId] = useState('')
  const [newCodeMsg, setNewCodeMsg] = useState('')

  const [newCatName, setNewCatName] = useState('')
  const [newCatColor, setNewCatColor] = useState('#94a3b8')
  const [newCatParentId, setNewCatParentId] = useState('')
  const [newCatMsg, setNewCatMsg] = useState('')

  const [detailMode, setDetailMode] = useState<DetailMode>(null)
  const [detailCode, setDetailCode] = useState<CodeExt | null>(null)
  const [detailCat, setDetailCat] = useState<CodeCategoryExt | null>(null)
  const [detailExcerptBm, setDetailExcerptBm] = useState<Bookmark | null>(null)
  const [detailExcerptBc, setDetailExcerptBc] = useState<BookmarkCode | null>(null)
  const [excMode, setExcMode] = useState<'view' | 'add' | 'change'>('view')
  const [excSearchText, setExcSearchText] = useState('')
  const [excShowSugg, setExcShowSugg] = useState(false)
  const [excSuggFocusIdx, setExcSuggFocusIdx] = useState(-1)
  const [excMsg, setExcMsg] = useState('')
  const [excCtxOpen, setExcCtxOpen] = useState(false)
  const [excCtxLoading, setExcCtxLoading] = useState(false)
  const [excCtxMessages, setExcCtxMessages] = useState<ContextMessage[]>([])
  const [excCtxBefore, setExcCtxBefore] = useState(3)
  const [excCtxAfter, setExcCtxAfter] = useState(3)
  const excSearchRef = useRef<HTMLInputElement>(null)

  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#0d3e7f')
  const [editDesc, setEditDesc] = useState('')
  const [editCatId, setEditCatId] = useState('')
  const [editMsg, setEditMsg] = useState('')

  const [catEditName, setCatEditName] = useState('')
  const [catEditColor, setCatEditColor] = useState('#94a3b8')
  const [catEditParentId, setCatEditParentId] = useState('')
  const [catEditMsg, setCatEditMsg] = useState('')

  const loadAll = () => {
    queryClient.invalidateQueries({ queryKey: ['codes'] })
    queryClient.invalidateQueries({ queryKey: ['code-categories'] })
    queryClient.invalidateQueries({ queryKey: ['bookmarks'] })
    queryClient.invalidateQueries({ queryKey: ['bookmark-codes'] })
    queryClient.invalidateQueries({ queryKey: ['interview-bookmarks'] })
    queryClient.invalidateQueries({ queryKey: ['interview-bookmark-codes'] })
    queryClient.invalidateQueries({ queryKey: ['news-bookmarks'] })
    queryClient.invalidateQueries({ queryKey: ['news-bookmark-codes'] })
  }

  const filterActive = !!(dateFrom || dateTo || authorFilter !== 'all')

  const filteredBookmarks = bookmarks.filter(bm => {
    if (dateFrom && bm.date && bm.date.slice(0, 10) < dateFrom) return false
    if (dateTo && bm.date && bm.date.slice(0, 10) > dateTo) return false
    if (authorFilter === 'only' && !isTruthy(bm.is_suno_team)) return false
    if (authorFilter === 'exclude' && isTruthy(bm.is_suno_team)) return false
    return true
  })

  // When no filter is active, derive IDs from bookmarkCodes directly so quotes
  // are visible even if the bookmarks array hasn't finished loading yet.
  const filteredBmIds = filterActive
    ? new Set(filteredBookmarks.map(b => b.id))
    : new Set(bookmarkCodes.map(bc => bc.bookmark_id))
  const filteredCodes = bookmarkCodes.filter(bc => filteredBmIds.has(bc.bookmark_id))

  const setPhase = (phase: 1 | 2 | 3) => {
    if (phase === 1) { setDateFrom('2023-04-01'); setDateTo('2023-07-18') }
    else if (phase === 2) { setDateFrom('2023-07-19'); setDateTo('2023-09-05') }
    else { setDateFrom('2023-09-06'); setDateTo('') }
  }
  const activePhase =
    dateFrom === '2023-04-01' && dateTo === '2023-07-18' ? 1 :
    dateFrom === '2023-07-19' && dateTo === '2023-09-05' ? 2 :
    dateFrom === '2023-09-06' && dateTo === '' ? 3 : null

  const openCodeDetail = (code: CodeExt) => {
    const withCount = { ...code, groundedness: bookmarkCodes.filter(bc => bc.code_id === code.id).length }
    setDetailMode('code')
    setDetailCode(withCount)
    setEditName(code.name)
    setEditColor(code.color || '#0d3e7f')
    setEditDesc(code.description || '')
    setEditCatId(code.category_id != null ? String(code.category_id) : '')
    setEditMsg('')
    setExpandedCodes(prev => {
      const next = new Set(prev); next.has(code.id) ? next.delete(code.id) : next.add(code.id); return next
    })
  }

  const openCatDetail = (cat: CodeCategoryExt) => {
    setDetailMode('category')
    setDetailCat(cat)
    setCatEditName(cat.name)
    setCatEditColor(cat.color || '#94a3b8')
    setCatEditParentId(cat.parent_id != null ? String(cat.parent_id) : '')
    setCatEditMsg('')
  }

  const closeDetail = () => {
    setDetailMode(null); setDetailCode(null); setDetailCat(null)
    setDetailExcerptBm(null); setDetailExcerptBc(null); setExcMsg('')
  }

  const openExcerptDetail = (bc: BookmarkCode, bm: Bookmark, mode: 'view' | 'add' | 'change' = 'view') => {
    setDetailMode('excerpt')
    setDetailCode(null)
    setDetailCat(null)
    setDetailExcerptBc(bc)
    setDetailExcerptBm(bm)
    setExcMode(mode)
    setExcSearchText('')
    setExcShowSugg(false)
    setExcSuggFocusIdx(-1)
    setExcMsg('')
    setExcCtxOpen(false)
    setExcCtxMessages([])
    setExpandedCodes(prev => { const n = new Set(prev); n.add(bc.code_id); return n })
    if (mode !== 'view') setTimeout(() => excSearchRef.current?.focus(), 60)
  }

  const deleteExcerptCode = async (bc: BookmarkCode, bookmarkId: number) => {
    await apiFetch(rmBmCodeEndpoint(bookmarkId, bc.code_id), { method: 'DELETE' }).catch(console.error)
    if (detailExcerptBc?.code_id === bc.code_id && detailExcerptBm?.id === bookmarkId) closeDetail()
    setBookmarkCodes(prev => prev.filter(x => !(x.bookmark_id === bookmarkId && x.code_id === bc.code_id)))
  }

  const applyExcSearch = async (selectedCode?: CodeExt) => {
    if (!detailExcerptBm || !detailExcerptBc) return
    const name = excSearchText.trim()
    if (!name && !selectedCode) return
    const currentMode = excMode
    setExcMsg('')
    try {
      let codeId: number
      let resolvedCode: CodeExt | undefined = selectedCode
      if (selectedCode) {
        codeId = selectedCode.id
      } else {
        const pool = currentMode === 'change'
          ? codes.filter(c => c.id !== detailExcerptBc!.code_id)
          : excAddableCodes
        const exact = pool.find(c => c.name.toLowerCase() === name.toLowerCase())
        if (exact) {
          codeId = exact.id
          resolvedCode = exact
        } else {
          const created = await apiFetch<CodeExt>('/codes', {
            method: 'POST',
            body: JSON.stringify({ name, color: '#0d3e7f' }),
          })
          codeId = created.id
          resolvedCode = created
          setCodes(prev => [...prev, created])
        }
      }
      if (currentMode === 'change') {
        await apiFetch(bmCodesEndpoint, { method: 'POST', body: JSON.stringify({ bookmark_id: detailExcerptBm.id, code_id: codeId }) })
        await apiFetch(rmBmCodeEndpoint(detailExcerptBm.id, detailExcerptBc.code_id), { method: 'DELETE' })
        setBookmarkCodes(prev => [
          ...prev.filter(x => !(x.bookmark_id === detailExcerptBm.id && x.code_id === detailExcerptBc.code_id)),
          { bookmark_id: detailExcerptBm.id, code_id: codeId, code_name: resolvedCode?.name ?? '', color: resolvedCode?.color ?? '#0d3e7f' },
        ])
      } else {
        await apiFetch(bmCodesEndpoint, { method: 'POST', body: JSON.stringify({ bookmark_id: detailExcerptBm.id, code_id: codeId }) })
        setBookmarkCodes(prev => [
          ...prev,
          { bookmark_id: detailExcerptBm.id, code_id: codeId, code_name: resolvedCode?.name ?? '', color: resolvedCode?.color ?? '#0d3e7f' },
        ])
      }
      setExcMode('view')
      setExcSearchText('')
      setExcShowSugg(false)
      setExcMsg(currentMode === 'change' ? 'Coding changed!' : 'Added!')
    } catch (e: unknown) { setExcMsg((e as Error).message || 'Error') }
  }

  const loadExcCtx = async () => {
    if (!detailExcerptBm?.msg_id) return
    if (excCtxOpen) { setExcCtxOpen(false); return }
    setExcCtxLoading(true)
    try {
      const data = await apiFetch<ContextMessage[]>(
        `/context/${detailExcerptBm.msg_id}?before=${excCtxBefore}&after=${excCtxAfter}`
      )
      setExcCtxMessages(data)
      setExcCtxOpen(true)
    } catch { } finally { setExcCtxLoading(false) }
  }


  const createCode = async () => {
    if (!newCodeName.trim()) { setNewCodeMsg('Name is required.'); return }
    try {
      const created = await apiFetch<Code>('/codes', {
        method: 'POST',
        body: JSON.stringify({ name: newCodeName.trim(), color: newCodeColor, category_id: newCodeCatId ? Number(newCodeCatId) : null }),
      })
      setCodes(prev => [...prev, created])
      setNewCodeName(''); setNewCodeColor('#0d3e7f'); setNewCodeCatId(''); setNewCodeMsg(''); setShowNewCode(false)
    } catch (e: unknown) { setNewCodeMsg((e as Error).message || 'Error creating code') }
  }

  const createCat = async () => {
    if (!newCatName.trim()) { setNewCatMsg('Name is required.'); return }
    try {
      const created = await apiFetch<CodeCategory>('/code-categories', {
        method: 'POST',
        body: JSON.stringify({
          name: newCatName.trim(),
          color: newCatColor,
          parent_id: newCatParentId ? Number(newCatParentId) : null,
        }),
      })
      setCategories(prev => [...prev, created])
      setNewCatName(''); setNewCatColor('#94a3b8'); setNewCatParentId(''); setNewCatMsg(''); setShowNewCat(false)
    } catch (e: unknown) { setNewCatMsg((e as Error).message || 'Error creating category') }
  }

  const saveCodeEdit = async () => {
    if (!detailCode) return
    try {
      const catId = editCatId ? Number(editCatId) : null
      await apiFetch(`/codes/${detailCode.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName, color: editColor, description: editDesc || null, category_id: catId }),
      })
      setCodes(prev => prev.map(c => c.id === detailCode.id
        ? { ...c, name: editName, color: editColor, description: editDesc || undefined, category_id: catId }
        : c
      ))
      setEditMsg('Saved!')
    } catch (e: unknown) { setEditMsg((e as Error).message || 'Error saving') }
  }

  const deleteCode = async (id: number) => {
    if (!confirm('Delete this code? All assignments will be removed.')) return
    await apiFetch(`/codes/${id}`, { method: 'DELETE' })
    if (detailCode?.id === id) closeDetail()
    setCodes(prev => prev.filter(c => c.id !== id))
    setBookmarkCodes(prev => prev.filter(bc => bc.code_id !== id))
  }

  const saveCatEdit = async () => {
    if (!detailCat) return
    try {
      const parentId = catEditParentId ? Number(catEditParentId) : null
      await apiFetch(`/code-categories/${detailCat.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: catEditName,
          color: catEditColor,
          parent_id: parentId,
        }),
      })
      setCategories(prev => prev.map(c => c.id === detailCat.id
        ? { ...c, name: catEditName, color: catEditColor, parent_id: parentId }
        : c
      ))
      setCatEditMsg('Saved!')
    } catch (e: unknown) { setCatEditMsg((e as Error).message || 'Error saving') }
  }

  const deleteCat = async (id: number) => {
    if (!confirm('Delete this category? Codes inside will become uncategorized.')) return
    await apiFetch(`/code-categories/${id}`, { method: 'DELETE' })
    if (detailCat?.id === id) closeDetail()
    setCategories(prev => prev.filter(c => c.id !== id))
    setCodes(prev => prev.map(c => c.category_id === id ? { ...c, category_id: null } : c))
  }

  const toggleMergeSelect = (id: number) => setMergeSelected(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
  })

  const doMerge = async () => {
    if (mergeSelected.size < 2) { alert('Select at least 2 codes to merge.'); return }
    const ids = [...mergeSelected]; const target = ids[0]
    for (const id of ids.slice(1)) {
      const assignments = bookmarkCodes.filter(bc => bc.code_id === id)
      for (const a of assignments) {
        await apiFetch(bmCodesEndpoint, { method: 'POST', body: JSON.stringify({ bookmark_id: a.bookmark_id, code_id: target }) }).catch(() => {})
        await apiFetch(rmBmCodeEndpoint(a.bookmark_id, id), { method: 'DELETE' }).catch(() => {})
      }
      await apiFetch(`/codes/${id}`, { method: 'DELETE' }).catch(() => {})
    }
    setMergeSelected(new Set()); setMergeMode(false); loadAll()
  }

  const exportCSV = () => {
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`
    const rows = [['2nd-order Coding', 'Open Coding', 'Quote / Excerpt', 'Source Username', 'Source Date', 'Source', 'Note'].join(',')]

    const emitCode = (catName: string, code: CodeExt) => {
      const excerpts = filteredCodes.filter(bc => bc.code_id === code.id)
      if (excerpts.length === 0) {
        rows.push([q(catName), q(code.name), '', '', '', '', ''].join(','))
      } else {
        for (const bc of excerpts) {
          const bm = bookmarks.find(b => b.id === bc.bookmark_id)
          const quote = bc.highlighted_text || bm?.content || ''
          rows.push([
            q(catName),
            q(code.name),
            q(quote),
            q(bm?.username || ''),
            bm?.date?.slice(0, 19).replace('T', ' ') || '',
            interviewBmIds.has(bc.bookmark_id) ? 'Interview' : newsBmIds.has(bc.bookmark_id) ? 'News' : 'Discord',
            q(bm?.note || ''),
          ].join(','))
        }
      }
    }

    sortedCats.forEach(cat => {
      const catCodes = codeSourceFiltered.filter(c => c.category_id === cat.id).sort((a, b) => a.name.localeCompare(b.name))
      const visibleCatCodes = catCodes.filter(code => filteredCodes.some(bc => bc.code_id === code.id))
      visibleCatCodes.forEach(code => emitCode(cat.name, code))
    })
    visibleUncategorized.forEach(code => emitCode('', code))

    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'coding_table.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const onCodeDragStart = (e: React.DragEvent, codeId: number) => {
    e.dataTransfer.setData('drag_type', 'code')
    e.dataTransfer.setData('drag_id', String(codeId))
    e.dataTransfer.effectAllowed = 'move'
  }
  const onCodeDrop = async (e: React.DragEvent, catId: number | null) => {
    e.preventDefault(); e.stopPropagation()
    if (e.dataTransfer.getData('drag_type') !== 'code') return
    const codeId = parseInt(e.dataTransfer.getData('drag_id'))
    if (!codeId) return
    setDragOverCatId(null)
    const code = codes.find(c => c.id === codeId)
    if (!code || code.category_id === catId) return
    await apiFetch(`/codes/${codeId}`, { method: 'PUT', body: JSON.stringify({ name: code.name, color: code.color, description: code.description || null, category_id: catId }) }).catch(console.error)
    setCodes(prev => prev.map(c => c.id === codeId ? { ...c, category_id: catId } : c))
  }
  const onExcerptDragStart = (e: React.DragEvent, bookmarkId: number, fromCodeId: number) => {
    e.dataTransfer.setData('drag_type', 'excerpt')
    e.dataTransfer.setData('bookmark_id', String(bookmarkId))
    e.dataTransfer.setData('from_code_id', String(fromCodeId))
    e.dataTransfer.effectAllowed = 'move'
  }
  const onExcerptDrop = async (e: React.DragEvent, toCodeId: number) => {
    e.preventDefault(); e.stopPropagation()
    if (e.dataTransfer.getData('drag_type') !== 'excerpt') return
    const bookmarkId = parseInt(e.dataTransfer.getData('bookmark_id'))
    const fromCodeId = parseInt(e.dataTransfer.getData('from_code_id'))
    setDragOverCodeId(null)
    if (!bookmarkId || !fromCodeId || fromCodeId === toCodeId) return
    await apiFetch(bmCodesEndpoint, { method: 'POST', body: JSON.stringify({ bookmark_id: bookmarkId, code_id: toCodeId }) }).catch(() => {})
    await apiFetch(rmBmCodeEndpoint(bookmarkId, fromCodeId), { method: 'DELETE' }).catch(() => {})
    const toCode = codes.find(c => c.id === toCodeId)
    setBookmarkCodes(prev => prev.map(bc =>
      bc.bookmark_id === bookmarkId && bc.code_id === fromCodeId
        ? { ...bc, code_id: toCodeId, code_name: toCode?.name ?? '', color: toCode?.color ?? '#0d3e7f' }
        : bc
    ))
  }
  const dnd: DndHandlers = { onCodeDragStart, onCodeDrop, onExcerptDragStart, onExcerptDrop, dragOverCatId, setDragOverCatId, dragOverCodeId, setDragOverCodeId }

  const activeExcerptKey = detailExcerptBm && detailExcerptBc
    ? `${detailExcerptBm.id}-${detailExcerptBc.code_id}`
    : null

  // Live codes assigned to the open excerpt's bookmark
  const excAddableCodes = detailExcerptBm
    ? codes.filter(code => !bookmarkCodes.some(bc => bc.bookmark_id === detailExcerptBm.id && bc.code_id === code.id))
    : []

  const excSuggestions: CodeExt[] = (() => {
    const term = excSearchText.trim().toLowerCase()
    if (!term) return []
    const pool = excMode === 'change'
      ? codes.filter(c => c.id !== detailExcerptBc?.code_id)
      : excAddableCodes
    return pool.filter(c => c.name.toLowerCase().includes(term)).slice(0, 8)
  })()

  // Build sets of bookmark IDs per source for source-aware code filtering
  const discordBmIds = useMemo(() => new Set((_discordBookmarks ?? []).map(b => b.id)), [_discordBookmarks])
  const interviewBmIds = useMemo(() => new Set((_interviewBookmarks ?? []).map(b => b.id)), [_interviewBookmarks])
  const newsBmIds = useMemo(() => new Set((_newsBookmarks ?? []).map(b => b.id)), [_newsBookmarks])

  // Source-aware code filter: only show codes that have quotes from the selected source
  const codeSourceFiltered = useMemo(() => {
    if (sourceFilter === 'all') return codes
    const sourceBmIds = sourceFilter === 'discord' ? discordBmIds :
      sourceFilter === 'interview' ? interviewBmIds : newsBmIds
    return codes.filter(code =>
      bookmarkCodes.some(bc => bc.code_id === code.id && sourceBmIds.has(bc.bookmark_id))
    )
  }, [sourceFilter, codes, bookmarkCodes, discordBmIds, interviewBmIds, newsBmIds])

  // Build tree
  const buildTree = (): TreeNode[] => {
    const catMap = new Map<number, TreeNode>()
    categories.forEach(c => catMap.set(c.id, { ...c, children: [], codes: [] }))
    codeSourceFiltered.forEach(code => {
      if (code.category_id != null) {
        const node = catMap.get(code.category_id as number)
        if (node) node.codes.push(code)
      }
    })
    const roots: TreeNode[] = []
    categories.forEach(c => {
      const node = catMap.get(c.id)!
      if (c.parent_id != null && catMap.has(c.parent_id as number)) {
        catMap.get(c.parent_id as number)!.children.push(node)
      } else {
        roots.push(node)
      }
    })
    const sort = (arr: TreeNode[]) => {
      arr.sort((a, b) => a.name.localeCompare(b.name))
      arr.forEach(n => { sort(n.children); n.codes.sort((a, b) => a.name.localeCompare(b.name)) })
    }
    sort(roots)
    return roots
  }

  const treeRoots = buildTree()
  const uncategorized = codeSourceFiltered.filter(c => c.category_id == null).sort((a, b) => a.name.localeCompare(b.name))
  const sortedCats = [...categories].sort((a, b) => a.name.localeCompare(b.name))

  const codeHasFilteredExcerpts = (code: CodeExt) =>
    bookmarkCodes.some(bc => bc.code_id === code.id && filteredBmIds.has(bc.bookmark_id)) &&
    codeSourceFiltered.some(c => c.id === code.id)

  const treeNodeHasVisible = (node: TreeNode): boolean => {
    if (!filterActive && sourceFilter === 'all') return true
    return node.codes.some(codeHasFilteredExcerpts) || node.children.some(treeNodeHasVisible)
  }

  const visibleTreeRoots = (filterActive || sourceFilter !== 'all') ? treeRoots.filter(treeNodeHasVisible) : treeRoots
  const visibleUncategorized = (filterActive || sourceFilter !== 'all') ? uncategorized.filter(codeHasFilteredExcerpts) : uncategorized

  const codeFilterLower = codeSearchFilter.trim().toLowerCase()
  const flatSearchResults = codeFilterLower
    ? codes.filter(c =>
        c.name.toLowerCase().includes(codeFilterLower) ||
        (c.description ?? '').toLowerCase().includes(codeFilterLower)
      ).sort((a, b) => a.name.localeCompare(b.name))
    : []

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 space-y-4">

      {/* Tab switcher */}
      <div className="bg-white rounded-2xl shadow p-1 flex gap-1">
        {(['manager', 'table'] as PageTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setPageTab(tab)}
            className={`flex-1 py-2 text-xs font-semibold rounded-xl transition-colors ${
              pageTab === tab ? 'bg-indigo-700 text-white' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {tab === 'manager' ? 'Coding Manager' : 'Coding Table'}
          </button>
        ))}
      </div>

      {/* Source filter chips */}
      <div className="flex items-center gap-2 px-1 flex-wrap">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide shrink-0">Source</span>
        {([
          { value: 'all' as const, label: 'All', active: 'bg-gray-700 text-white', inactive: 'bg-gray-100 text-gray-600 hover:bg-gray-200' },
          { value: 'discord' as const, label: 'Discord', active: 'bg-indigo-600 text-white', inactive: 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100' },
          { value: 'interview' as const, label: 'Interview', active: 'bg-teal-600 text-white', inactive: 'bg-teal-50 text-teal-700 hover:bg-teal-100' },
          { value: 'news' as const, label: 'News', active: 'bg-amber-600 text-white', inactive: 'bg-amber-50 text-amber-700 hover:bg-amber-100' },
        ]).map(({ value, label, active, inactive }) => (
          <button
            key={value}
            onClick={() => setSourceFilter(value as CodingSource)}
            className={`text-xs px-3 py-1 rounded-full font-semibold transition-colors ${sourceFilter === value ? active : inactive}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Shared filter bar */}
      <div className="bg-white rounded-2xl shadow px-4 py-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="filter-label">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="search-input text-xs py-1 cursor-pointer"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="filter-label">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="search-input text-xs py-1 cursor-pointer"
          />
        </div>
        {filterActive && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); setAuthorFilter('all') }}
            className="self-end pb-1 text-xs text-gray-400 hover:text-red-500 transition-colors flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            Clear
          </button>
        )}

        <div className="w-full flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
          <span className="filter-label self-center shrink-0">Phase</span>
          <button
            onClick={() => activePhase === 1 ? (setDateFrom(''), setDateTo('')) : setPhase(1)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${activePhase === 1 ? 'border-blue-400 bg-blue-100 text-blue-800' : 'border-blue-300 text-blue-700 hover:bg-blue-50'}`}
          >
            Phase 1 — Capability Surfacing <span className="opacity-60 ml-1">Apr - 18 Jul 2023</span>
          </button>
          <button
            onClick={() => activePhase === 2 ? (setDateFrom(''), setDateTo('')) : setPhase(2)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${activePhase === 2 ? 'border-amber-400 bg-amber-100 text-amber-800' : 'border-amber-300 text-amber-700 hover:bg-amber-50'}`}
          >
            Phase 2 — Enclosure &amp; Scrutiny <span className="opacity-60 ml-1">19 Jul - 5 Sep 2023</span>
          </button>
          <button
            onClick={() => activePhase === 3 ? (setDateFrom(''), setDateTo('')) : setPhase(3)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${activePhase === 3 ? 'border-emerald-400 bg-emerald-100 text-emerald-800' : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'}`}
          >
            Phase 3 — Commercialization <span className="opacity-60 ml-1">Sep 2023 - onward</span>
          </button>
        </div>

        <div className="w-full flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
          <span className="filter-label self-center shrink-0">Author</span>
          <button
            onClick={() => setAuthorFilter('all')}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              authorFilter === 'all' ? 'border-gray-400 bg-gray-100 text-gray-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            All authors
          </button>
          <button
            onClick={() => setAuthorFilter(authorFilter === 'only' ? 'all' : 'only')}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              authorFilter === 'only' ? 'border-violet-400 bg-violet-100 text-violet-800' : 'border-violet-300 text-violet-700 hover:bg-violet-50'
            }`}
          >
            Suno team only
          </button>
          <button
            onClick={() => setAuthorFilter(authorFilter === 'exclude' ? 'all' : 'exclude')}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              authorFilter === 'exclude' ? 'border-rose-400 bg-rose-100 text-rose-800' : 'border-rose-300 text-rose-700 hover:bg-rose-50'
            }`}
          >
            Exclude Suno team
          </button>
        </div>
      </div>

      {/* ── Coding Manager section ── */}
      {pageTab === 'manager' && (
        <div className="flex gap-4 items-start">

          {/* Left column: toolbar + forms + tree */}
          <div className="flex-1 min-w-0 space-y-3">

            {/* Toolbar */}
            <div className="bg-white rounded-2xl shadow px-4 py-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => { setShowNewCode(v => !v); setShowNewCat(false) }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${showNewCode ? 'bg-indigo-100 text-indigo-700 border border-indigo-300' : 'bg-indigo-700 text-white hover:bg-indigo-800'}`}
              >
                + Open Coding
              </button>
              <button
                onClick={() => { setShowNewCat(v => !v); setShowNewCode(false) }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${showNewCat ? 'bg-slate-100 text-slate-700 border border-slate-300' : 'bg-slate-600 text-white hover:bg-slate-700'}`}
              >
                + Higher Level Coding
              </button>
              <div className="flex items-center gap-1 ml-auto">
                <button onClick={() => setCollapsedCats(new Set(categories.map(c => c.id)))} title="Collapse all" className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1 transition-colors">⊟ Collapse</button>
                <button onClick={() => { setCollapsedCats(new Set()); setExpandedCodes(new Set(codes.map(c => c.id))) }} title="Expand all" className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded px-2 py-1 transition-colors">⊞ Expand</button>
                <label className="flex items-center gap-1.5 cursor-pointer text-xs border border-amber-200 rounded px-2 py-1 select-none hover:bg-amber-50 text-amber-700">
                  <input type="checkbox" checked={mergeMode} onChange={e => { setMergeMode(e.target.checked); setMergeSelected(new Set()) }} className="accent-amber-500" />
                  Merge
                </label>
                <button onClick={loadAll} title="Refresh" className="text-xs text-gray-400 hover:text-indigo-600 border border-gray-200 rounded px-2 py-1">↻</button>
              </div>
            </div>

            {/* Merge action bar */}
            {mergeMode && mergeSelected.size >= 2 && (
              <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-2 flex items-center gap-3">
                <span className="text-xs text-amber-700 font-semibold">{mergeSelected.size} codes selected</span>
                <button onClick={doMerge} className="px-3 py-1 text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 rounded transition-colors">Merge into first selected</button>
                <button onClick={() => { setMergeMode(false); setMergeSelected(new Set()) }} className="text-xs text-gray-500 hover:text-gray-700 ml-auto">Cancel</button>
              </div>
            )}

            {/* New open coding form */}
            {showNewCode && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3">
                <h3 className="text-xs font-semibold text-indigo-800 mb-2">New Open Coding</h3>
                <div className="flex flex-wrap gap-2 items-end">
                  <div className="flex-1 min-w-[10rem]">
                    <label className="filter-label mb-1 block">Name *</label>
                    <input type="text" maxLength={80} value={newCodeName} onChange={e => setNewCodeName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createCode()} placeholder="Open coding name…" className="w-full search-input text-sm" />
                  </div>
                  <div>
                    <label className="filter-label mb-1 block">Color</label>
                    <ColorPicker value={newCodeColor} onChange={setNewCodeColor} />
                  </div>
                  <div className="flex-1 min-w-[9rem]">
                    <label className="filter-label mb-1 block">Higher level coding (optional)</label>
                    <select value={newCodeCatId} onChange={e => setNewCodeCatId(e.target.value)} className="w-full search-input text-sm">
                      <option value="">— Uncategorized —</option>
                      {sortedCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="flex gap-1.5 self-end">
                    <button onClick={createCode} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-700 text-white hover:bg-indigo-800 transition-colors">Create</button>
                    <button onClick={() => { setShowNewCode(false); setNewCodeMsg('') }} className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-600 hover:bg-white transition-colors">✕</button>
                  </div>
                </div>
                {newCodeMsg && <p className="text-xs text-red-600 mt-1.5">{newCodeMsg}</p>}
              </div>
            )}

            {/* New higher level coding form */}
            {showNewCat && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                <h3 className="text-xs font-semibold text-slate-700 mb-2">New Higher Level Coding</h3>
                <div className="flex flex-wrap gap-2 items-end">
                  <div className="flex-1 min-w-[10rem]">
                    <label className="filter-label mb-1 block">Name *</label>
                    <input type="text" maxLength={60} value={newCatName} onChange={e => setNewCatName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createCat()} placeholder="Higher level coding name…" className="w-full search-input text-sm" />
                  </div>
                  <div>
                    <label className="filter-label mb-1 block">Color</label>
                    <ColorPicker value={newCatColor} onChange={setNewCatColor} />
                  </div>
                  <div className="flex-1 min-w-[9rem]">
                    <label className="filter-label mb-1 block">Parent (optional)</label>
                    <select value={newCatParentId} onChange={e => setNewCatParentId(e.target.value)} className="w-full search-input text-sm">
                      <option value="">— Root level —</option>
                      {sortedCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="flex gap-1.5 self-end">
                    <button onClick={createCat} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-colors">Create</button>
                    <button onClick={() => { setShowNewCat(false); setNewCatMsg('') }} className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-600 hover:bg-white transition-colors">✕</button>
                  </div>
                </div>
                {newCatMsg && <p className="text-xs text-red-600 mt-1.5">{newCatMsg}</p>}
              </div>
            )}

            {/* Tree / search results panel */}
            <section className="bg-white rounded-2xl shadow p-4">

              {/* Tree header: stats + keyword search */}
              <div className="flex items-center gap-3 mb-3 pb-3 border-b border-gray-100">
                <div>
                  <span className="text-sm font-semibold text-gray-700">{codeFilterLower ? 'Search Results' : 'Code Tree'}</span>
                  <span className="ml-2 text-xs text-gray-400">{visibleTreeRoots.length} categories · {codeSourceFiltered.length} codes · {bookmarkCodes.length} quotes</span>
                </div>
                <div className="relative ml-auto w-52">
                  <input
                    type="text"
                    value={codeSearchFilter}
                    onChange={e => setCodeSearchFilter(e.target.value)}
                    placeholder="Filter codes…"
                    className="w-full border border-gray-300 rounded-lg pl-3 pr-7 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  />
                  {codeSearchFilter
                    ? <button onClick={() => setCodeSearchFilter('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm leading-none">×</button>
                    : <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 text-xs pointer-events-none">⌕</span>
                  }
                </div>
                {codeFilterLower && (
                  <span className="text-xs text-indigo-600 font-medium shrink-0">{flatSearchResults.length} match{flatSearchResults.length !== 1 ? 'es' : ''}</span>
                )}
              </div>

              {codeSourceFiltered.length === 0 && categories.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No codes yet. Click &ldquo;+ Open Coding&rdquo; to get started.</p>
              ) : codeFilterLower && flatSearchResults.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">No codes match &ldquo;{codeSearchFilter}&rdquo;</p>
              ) : codeFilterLower ? (
                <div className="space-y-0.5">
                  {flatSearchResults.map(code => {
                    const codeExcerpts = bookmarkCodes.filter(bc => bc.code_id === code.id)
                    const cat = categories.find(c => c.id === code.category_id)
                    return (
                      <div
                        key={code.id}
                        onClick={() => openCodeDetail(code)}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${detailMode === 'code' && detailCode?.id === code.id ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-gray-50'}`}
                      >
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: code.color }} />
                        <span className="text-sm text-gray-800 flex-1 min-w-0 truncate">{code.name}</span>
                        {cat && <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 shrink-0">{cat.name}</span>}
                        <span className="text-[10px] text-gray-400 shrink-0">{codeExcerpts.length} quotes</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
              <div className="space-y-1">
                {visibleTreeRoots.map(node => (
                  <CatNode
                    key={node.id}
                    node={node}
                    depth={0}
                    collapsedCats={collapsedCats}
                    onToggleCollapse={id => setCollapsedCats(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })}
                    expandedCodes={expandedCodes}
                    onToggleCode={openCodeDetail}
                    filteredBmIds={filteredBmIds}
                    bookmarks={bookmarks}
                    bookmarkCodes={bookmarkCodes}
                    mergeMode={mergeMode}
                    mergeSelected={mergeSelected}
                    onMergeToggle={toggleMergeSelect}
                    activeCodeId={detailMode === 'code' ? (detailCode?.id ?? null) : null}
                    activeCatId={detailMode === 'category' ? (detailCat?.id ?? null) : null}
                    onOpenCat={openCatDetail}
                    dnd={dnd}
                    filterActive={filterActive}
                    onOpenExcerpt={openExcerptDetail}
                    onDeleteExcerptCode={deleteExcerptCode}
                    activeExcerptKey={activeExcerptKey}
                  />
                ))}
                {(!filterActive || visibleUncategorized.length > 0 || dragOverCatId === 0) && (
                <div className="mt-2">
                  <div
                    className={`flex items-center gap-2 py-1.5 rounded-lg px-2 transition-colors ${dragOverCatId === 0 ? 'bg-indigo-100 ring-2 ring-indigo-400' : 'hover:bg-gray-50'}`}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverCatId(0) }}
                    onDragLeave={e => { e.stopPropagation(); setDragOverCatId(null) }}
                    onDrop={e => { e.stopPropagation(); dnd.onCodeDrop(e, null) }}
                  >
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex-1">Uncategorized Open Codings</span>
                    {visibleUncategorized.length > 0 && <span className="text-[10px] text-gray-400">{visibleUncategorized.length} codes</span>}
                    {dragOverCatId === 0 && <span className="text-[10px] text-indigo-600 font-semibold">Drop here</span>}
                  </div>
                  <div className="space-y-1 mt-1">
                    {visibleUncategorized.map(code => {
                      const codeExcerpts = bookmarkCodes.filter(bc => bc.code_id === code.id)
                      return (
                            <CodeCard
                              key={code.id}
                              code={{ ...code, groundedness: codeExcerpts.length }}
                              depth={0}
                              expanded={expandedCodes.has(code.id)}
                              excerpts={codeExcerpts}
                              filteredBmIds={filteredBmIds}
                              bookmarks={bookmarks}
                              mergeMode={mergeMode}
                              mergeSelected={mergeSelected.has(code.id)}
                              onMergeToggle={toggleMergeSelect}
                              isActive={detailMode === 'code' && detailCode?.id === code.id}
                              onToggle={openCodeDetail}
                              dnd={dnd}
                              onOpenExcerpt={openExcerptDetail}
                              onDeleteExcerptCode={deleteExcerptCode}
                              activeExcerptKey={activeExcerptKey}
                            />
                          )
                        })}
                      </div>
                    </div>
                    )}
                </div>
                )}
            </section>

          </div>

          {/* Detail panel */}
            {detailMode && (
              <aside className="w-80 shrink-0 bg-white rounded-2xl shadow p-4 space-y-3 sticky top-0 max-h-screen overflow-y-auto">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-gray-700">
                    {detailMode === 'code' ? 'Edit Open Coding' : detailMode === 'excerpt' ? 'Quote Detail' : 'Edit Coding'}
                  </h2>
                  <button onClick={closeDetail} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
                </div>

                {detailMode === 'code' && detailCode && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-gray-600 mb-1 block">Name</label>
                      <input type="text" maxLength={80} value={editName} onChange={e => setEditName(e.target.value)} className="w-full border border-gray-300 px-3 py-1.5 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600 mb-1 block">Color</label>
                      <ColorPicker value={editColor} onChange={setEditColor} />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600 mb-1 block">Description</label>
                      <input type="text" maxLength={200} value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Optional description…" className="w-full border border-gray-300 px-3 py-1.5 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600 mb-1 block">Higher-Order Coding</label>
                      <select value={editCatId} onChange={e => setEditCatId(e.target.value)} className="w-full border border-gray-300 px-3 py-1.5 text-sm">
                        <option value="">— Uncategorized —</option>
                        {sortedCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    <div className="flex gap-6 pt-1">
                      <div className="text-center">
                        <p className="text-2xl font-bold text-indigo-700">{detailCode.groundedness ?? '—'}</p>
                        <p className="text-xs text-gray-500 mt-0.5">Groundedness</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-slate-600">{detailCode.density ?? '—'}</p>
                        <p className="text-xs text-gray-500 mt-0.5">Density</p>
                      </div>
                    </div>
                    {editMsg && (
                      <p className={`text-xs ${editMsg.startsWith('Error') || editMsg.startsWith('error') ? 'text-red-600' : 'text-green-600'}`}>{editMsg}</p>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button onClick={saveCodeEdit} className="flex-1 px-3 py-1.5 text-xs font-semibold bg-indigo-700 text-white hover:bg-indigo-800 transition-colors">
                        Save
                      </button>
                      <button onClick={() => deleteCode(detailCode.id)} className="px-3 py-1.5 text-xs font-semibold border border-red-200 text-red-600 hover:bg-red-50 transition-colors">
                        Delete
                      </button>
                    </div>
                  </div>
                )}

                {detailMode === 'category' && detailCat && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-gray-600 mb-1 block">Name</label>
                      <input type="text" maxLength={60} value={catEditName} onChange={e => setCatEditName(e.target.value)} className="w-full border border-gray-300 px-3 py-1.5 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600 mb-1 block">Color</label>
                      <ColorPicker value={catEditColor} onChange={setCatEditColor} />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600 mb-1 block">Parent Coding (sets order level)</label>
                      <select value={catEditParentId} onChange={e => setCatEditParentId(e.target.value)} className="w-full border border-gray-300 px-3 py-1.5 text-sm">
                        <option value="">— Root level (2nd-order) —</option>
                        {sortedCats.filter(c => c.id !== detailCat.id).map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                    {catEditMsg && (
                      <p className={`text-xs ${catEditMsg.startsWith('Error') || catEditMsg.startsWith('error') ? 'text-red-600' : 'text-green-600'}`}>{catEditMsg}</p>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button onClick={saveCatEdit} className="flex-1 px-3 py-1.5 text-xs font-semibold bg-slate-600 text-white hover:bg-slate-700 transition-colors">
                        Save
                      </button>
                      <button onClick={() => deleteCat(detailCat.id)} className="px-3 py-1.5 text-xs font-semibold border border-red-200 text-red-600 hover:bg-red-50 transition-colors">
                        Delete
                      </button>
                    </div>
                  </div>
                )}

                {detailMode === 'excerpt' && detailExcerptBm && detailExcerptBc && (() => {
                  const srcCode = codes.find(c => c.id === detailExcerptBc.code_id)
                  return (
                    <div className="space-y-3">
                      {/* Excerpt text */}
                      <div
                        className="border-l-4 pl-3 py-1.5 rounded-r-lg bg-gray-50"
                        style={{ borderColor: srcCode?.color || '#6366f1' }}
                      >
                        <p className="text-xs italic text-gray-800 leading-relaxed">
                          &ldquo;{detailExcerptBc.highlighted_text || detailExcerptBm.content}&rdquo;
                        </p>
                      </div>
                      {/* Source */}
                      <div className="flex items-center gap-1.5 text-xs text-gray-500 flex-wrap">
                        <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold bg-indigo-100 text-indigo-700">
                          {detailExcerptBm.username}
                        </span>
                        <span>{detailExcerptBm.date?.slice(0, 19).replace('T', ' ')}</span>
                      </div>
                      {/* Current coding */}
                      <div>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold mb-1.5">
                          {excMode === 'change' ? 'Changing from' : 'Open Coding'}
                        </p>
                        {srcCode && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                              style={{ background: srcCode.color, color: labelTextColor(srcCode.color) }}
                            >
                              {srcCode.name}
                            </span>
                            {excMode === 'view' && (
                              <>
                                <button onClick={() => setExcMode('change')} className="text-[10px] text-indigo-600 hover:text-indigo-800">Change</button>
                                <button onClick={() => deleteExcerptCode(detailExcerptBc, detailExcerptBm.id)} className="text-[10px] text-red-400 hover:text-red-600">Delete</button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      {/* Change / Add mode with autocomplete */}
                      {(excMode === 'change' || excMode === 'add') && (
                        <div className="space-y-2">
                          <p className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold">
                            {excMode === 'change' ? 'Replace with' : 'Add Open Coding'}
                          </p>
                          <div className="relative">
                            <input
                              ref={excSearchRef}
                              type="text"
                              value={excSearchText}
                              onChange={e => { setExcSearchText(e.target.value); setExcShowSugg(true); setExcSuggFocusIdx(-1) }}
                              onFocus={() => setExcShowSugg(true)}
                              onBlur={() => setTimeout(() => setExcShowSugg(false), 150)}
                              onKeyDown={e => {
                                if (e.key === 'ArrowDown') { e.preventDefault(); setExcSuggFocusIdx(i => Math.min(i + 1, excSuggestions.length)) }
                                else if (e.key === 'ArrowUp') { e.preventDefault(); setExcSuggFocusIdx(i => Math.max(i - 1, -1)) }
                                else if (e.key === 'Enter') {
                                  e.preventDefault()
                                  if (excSuggFocusIdx >= 0 && excSuggFocusIdx < excSuggestions.length) applyExcSearch(excSuggestions[excSuggFocusIdx])
                                  else applyExcSearch()
                                }
                                else if (e.key === 'Escape') { setExcShowSugg(false); setExcSuggFocusIdx(-1) }
                              }}
                              placeholder="Search or create code…"
                              className="w-full border border-gray-300 px-2.5 py-1.5 text-xs rounded"
                              autoComplete="off"
                            />
                            {excShowSugg && (excSuggestions.length > 0 || excSearchText.trim()) && (
                              <div className="absolute left-0 right-0 top-full mt-0.5 bg-white border border-gray-200 rounded shadow-lg z-[100] max-h-48 overflow-y-auto">
                                {excSuggestions.map((c, idx) => (
                                  <button
                                    key={c.id}
                                    className={`w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 transition-colors ${excSuggFocusIdx === idx ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}
                                    onMouseDown={e => { e.preventDefault(); applyExcSearch(c) }}
                                  >
                                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />
                                    {c.name}
                                  </button>
                                ))}
                                {excSearchText.trim() && !excSuggestions.some(c => c.name.toLowerCase() === excSearchText.trim().toLowerCase()) && (
                                  <button
                                    className={`w-full text-left px-2.5 py-1.5 text-xs text-indigo-600 border-t border-gray-100 transition-colors ${excSuggFocusIdx === excSuggestions.length ? 'bg-indigo-50' : 'hover:bg-indigo-50'}`}
                                    onMouseDown={e => { e.preventDefault(); applyExcSearch() }}
                                  >
                                    + Create &ldquo;{excSearchText.trim()}&rdquo;
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => applyExcSearch()} disabled={!excSearchText.trim()}
                              className="flex-1 px-3 py-1.5 text-xs font-semibold bg-indigo-700 text-white hover:bg-indigo-800 disabled:opacity-40 transition-colors">
                              {excMode === 'change' ? 'Apply' : 'Add'}
                            </button>
                            <button onClick={() => { setExcMode('view'); setExcSearchText(''); setExcShowSugg(false) }}
                              className="px-3 py-1.5 text-xs font-semibold border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                      {excMode === 'view' && (
                        <button
                          onClick={() => setExcMode('add')}
                          className="w-full text-center text-xs text-indigo-600 hover:text-indigo-800 border border-dashed border-indigo-300 hover:border-indigo-500 px-2.5 py-1.5 rounded-lg transition-colors"
                        >
                          + Add another open coding
                        </button>
                      )}
                      {excMsg && <p className={`text-xs ${excMsg.startsWith('Error') ? 'text-red-500' : 'text-green-600'}`}>{excMsg}</p>}
                      {/* View Context */}
                      <div className="pt-2 border-t border-gray-100 space-y-2">
                        {/* Controls row */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold shrink-0">Context</span>
                          <label className="flex items-center gap-1 text-[10px] text-gray-500">
                            Before
                            <input
                              type="number"
                              min={0}
                              max={20}
                              value={excCtxBefore}
                              onChange={e => {
                                setExcCtxBefore(Math.max(0, Math.min(20, Number(e.target.value))))
                                if (excCtxOpen) setExcCtxOpen(false)
                              }}
                              className="w-10 border border-gray-300 rounded px-1 py-0.5 text-[10px] text-center"
                            />
                          </label>
                          <label className="flex items-center gap-1 text-[10px] text-gray-500">
                            After
                            <input
                              type="number"
                              min={0}
                              max={20}
                              value={excCtxAfter}
                              onChange={e => {
                                setExcCtxAfter(Math.max(0, Math.min(20, Number(e.target.value))))
                                if (excCtxOpen) setExcCtxOpen(false)
                              }}
                              className="w-10 border border-gray-300 rounded px-1 py-0.5 text-[10px] text-center"
                            />
                          </label>
                          <button
                            onClick={loadExcCtx}
                            disabled={!detailExcerptBm?.msg_id || excCtxLoading}
                            className="ml-auto text-xs text-indigo-600 hover:text-indigo-800 disabled:opacity-40 flex items-center gap-1 transition-colors"
                          >
                            {excCtxLoading ? '…' : excCtxOpen ? '▲ Hide' : '▼ View Context'}
                          </button>
                        </div>
                        {excCtxOpen && excCtxMessages.length > 0 && (
                          <div className="space-y-1 bg-slate-50 rounded-lg p-2">
                            {excCtxMessages.map((cm, j) => (
                              <div
                                key={j}
                                className={`text-[11px] px-1.5 py-1 rounded ${cm.is_target ? 'bg-yellow-50 border border-yellow-200' : 'bg-slate-50'}`}
                              >
                                <div className="flex items-center gap-1.5 mb-0.5">
                                  <span className="font-semibold text-gray-700">{cm.username}</span>
                                  <span className="text-gray-400 text-[10px]">{cm.date?.slice(0, 19).replace('T', ' ')}</span>
                                </div>
                                <p className="text-gray-700 leading-snug">{cm.content}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })()}
              </aside>
            )}
          </div>
      )}

      {/* ── Coding Table section ── */}
      {pageTab === 'table' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl shadow p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-base font-bold text-gray-900">Coding Structure Table</h2>
                <p className="text-xs text-gray-400 mt-0.5">Classic QDA coding table — hierarchy, open codings, and coded excerpts.</p>
              </div>
              <div className="flex gap-2 items-center">
                <button onClick={loadAll} className="px-3 py-1.5 text-xs font-semibold border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                  ↺ Reload
                </button>
                <button onClick={exportCSV} className="px-3 py-1.5 text-xs font-semibold border border-indigo-300 text-indigo-600 hover:bg-indigo-50 transition-colors">
                  ⬇ Export CSV
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-3 py-2 border-b border-gray-200 w-36">2nd-order Coding</th>
                    <th className="px-3 py-2 border-b border-gray-200 w-44">Open Coding</th>
                    <th className="px-3 py-2 border-b border-gray-200">Quote / Excerpt</th>
                    <th className="px-3 py-2 border-b border-gray-200 w-32">Source</th>
                    <th className="px-3 py-2 border-b border-gray-200 w-28">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const rows: React.ReactElement[] = []

                    // Helper to resolve bookmark source label
                    const getBmSource = (bmId: number): string => {
                      if (interviewBmIds.has(bmId)) return 'Interview'
                      if (newsBmIds.has(bmId)) return 'News'
                      return 'Discord'
                    }
                    const sourceStyle = (src: string) => {
                      if (src === 'Interview') return 'bg-teal-100 text-teal-700'
                      if (src === 'News') return 'bg-amber-100 text-amber-700'
                      return 'bg-indigo-100 text-indigo-700'
                    }

                    sortedCats.forEach(cat => {
                      const allCatCodes = codeSourceFiltered.filter(c => c.category_id === cat.id).sort((a, b) => a.name.localeCompare(b.name))
                      const catCodes = allCatCodes.filter(code => filteredCodes.some(bc => bc.code_id === code.id))
                      if (catCodes.length === 0) return
                      const catTotalRows = catCodes.reduce((sum, code) => {
                        return sum + Math.max(filteredCodes.filter(bc => bc.code_id === code.id).length, 1)
                      }, 0)
                      let catCellEmitted = false

                      catCodes.forEach(code => {
                        const excerpts = filteredCodes.filter(bc => bc.code_id === code.id)
                        const codeRowCount = Math.max(excerpts.length, 1)
                        const tc = labelTextColor(code.color)

                        const catCell = !catCellEmitted ? (
                          <td
                            key={`cat-${cat.id}`}
                            rowSpan={catTotalRows}
                            className="px-3 py-2 align-top border-b border-gray-200 border-r border-gray-100 bg-gray-50/60 text-xs font-semibold text-gray-700"
                          >
                            <div className="flex items-center gap-1.5">
                              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: cat.color || '#94a3b8' }} />
                              {cat.name}
                            </div>
                          </td>
                        ) : null
                        if (!catCellEmitted) catCellEmitted = true

                        const codeCell = (
                          <td
                            key={`code-${code.id}`}
                            rowSpan={codeRowCount}
                            className="px-3 py-2 align-top border-b border-gray-100 border-r border-gray-100"
                          >
                            <div className="flex items-start gap-1.5">
                              <div className="w-2.5 h-2.5 rounded-full shrink-0 mt-0.5" style={{ background: code.color }} />
                              <div>
                                <div className="font-medium text-gray-800 text-xs leading-snug">{code.name}</div>
                                <div className="flex gap-1.5 mt-1 flex-wrap">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: code.color, color: tc }}>
                                    {excerpts.length}
                                  </span>
                                  <span className="text-[10px] text-gray-400">G:{excerpts.length} D:0</span>
                                </div>
                              </div>
                            </div>
                          </td>
                        )

                        if (excerpts.length === 0) {
                          rows.push(
                            <tr key={`code-${code.id}-empty`} className="hover:bg-gray-50/80">
                              {catCell}
                              {codeCell}
                              <td className="px-3 py-2 text-xs text-gray-400 italic border-b border-gray-100">—</td>
                              <td className="px-3 py-2 text-xs text-gray-400 border-b border-gray-100">—</td>
                              <td className="px-3 py-2 border-b border-gray-100"></td>
                            </tr>
                          )
                        } else {
                          excerpts.forEach((bc, qi) => {
                            const bm = bookmarks.find(b => b.id === bc.bookmark_id)
                            const text = bc.highlighted_text || (bm?.content || '').slice(0, 240)
                            const truncated = text.length >= 240
                            rows.push(
                              <tr key={`bc-${bc.bookmark_id}-${code.id}-${qi}`} className="hover:bg-gray-50/80">
                                {qi === 0 && catCell}
                                {qi === 0 && codeCell}
                                <td className="px-3 py-2 text-xs text-gray-700 border-b border-gray-100 max-w-sm">
                                  <p className="italic leading-relaxed">&ldquo;{text}{truncated ? '…' : ''}&rdquo;</p>
                                </td>
                                <td className="px-3 py-2 text-xs text-gray-500 border-b border-gray-100 whitespace-nowrap">
                                  <div className="font-medium">{bm?.username || '—'}</div>
                                  <div className="text-gray-400">{bm?.date?.slice(0, 19).replace('T', ' ') || ''}</div>
                                  <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full mt-1 inline-block ${sourceStyle(getBmSource(bc.bookmark_id))}`}>{getBmSource(bc.bookmark_id)}</span>
                                </td>
                                <td className="px-3 py-2 text-xs text-gray-400 border-b border-gray-100"></td>
                              </tr>
                            )
                          })
                        }
                      })
                    })

                    if (visibleUncategorized.length > 0) {
                      const uncatTotalRows = visibleUncategorized.reduce((sum, code) => {
                        return sum + Math.max(filteredCodes.filter(bc => bc.code_id === code.id).length, 1)
                      }, 0)
                      let uncatCellEmitted = false

                      visibleUncategorized.forEach(code => {
                        const excerpts = filteredCodes.filter(bc => bc.code_id === code.id)
                        const codeRowCount = Math.max(excerpts.length, 1)
                        const tc = labelTextColor(code.color)

                        const uncatCell = !uncatCellEmitted ? (
                          <td
                            key="uncat"
                            rowSpan={uncatTotalRows}
                            className="px-3 py-2 align-top border-b border-gray-200 border-r border-gray-100 bg-gray-50/60 text-xs text-gray-400 italic"
                          >—</td>
                        ) : null
                        if (!uncatCellEmitted) uncatCellEmitted = true

                        const codeCell = (
                          <td
                            key={`code-${code.id}`}
                            rowSpan={codeRowCount}
                            className="px-3 py-2 align-top border-b border-gray-100 border-r border-gray-100"
                          >
                            <div className="flex items-start gap-1.5">
                              <div className="w-2.5 h-2.5 rounded-full shrink-0 mt-0.5" style={{ background: code.color }} />
                              <div>
                                <div className="font-medium text-gray-800 text-xs leading-snug">{code.name}</div>
                                <div className="flex gap-1.5 mt-1 flex-wrap">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: code.color, color: tc }}>
                                    {excerpts.length}
                                  </span>
                                  <span className="text-[10px] text-gray-400">G:{excerpts.length} D:0</span>
                                </div>
                              </div>
                            </div>
                          </td>
                        )

                        if (excerpts.length === 0) {
                          rows.push(
                            <tr key={`code-${code.id}-empty`} className="hover:bg-gray-50/80">
                              {uncatCell}
                              {codeCell}
                              <td className="px-3 py-2 text-xs text-gray-400 italic border-b border-gray-100">—</td>
                              <td className="px-3 py-2 text-xs text-gray-400 border-b border-gray-100">—</td>
                              <td className="px-3 py-2 border-b border-gray-100"></td>
                            </tr>
                          )
                        } else {
                          excerpts.forEach((bc, qi) => {
                            const bm = bookmarks.find(b => b.id === bc.bookmark_id)
                            const text = bc.highlighted_text || (bm?.content || '').slice(0, 240)
                            const truncated = text.length >= 240
                            rows.push(
                              <tr key={`bc-${bc.bookmark_id}-${code.id}-${qi}`} className="hover:bg-gray-50/80">
                                {qi === 0 && uncatCell}
                                {qi === 0 && codeCell}
                                <td className="px-3 py-2 text-xs text-gray-700 border-b border-gray-100 max-w-sm">
                                  <p className="italic leading-relaxed">&ldquo;{text}{truncated ? '…' : ''}&rdquo;</p>
                                </td>
                                <td className="px-3 py-2 text-xs text-gray-500 border-b border-gray-100 whitespace-nowrap">
                                  <div className="font-medium">{bm?.username || '—'}</div>
                                  <div className="text-gray-400">{bm?.date?.slice(0, 19).replace('T', ' ') || ''}</div>
                                  <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full mt-1 inline-block ${sourceStyle(getBmSource(bc.bookmark_id))}`}>{getBmSource(bc.bookmark_id)}</span>
                                </td>
                                <td className="px-3 py-2 text-xs text-gray-400 border-b border-gray-100"></td>
                              </tr>
                            )
                          })
                        }
                      })
                    }

                    if (codeSourceFiltered.length === 0) {
                      rows.push(
                        <tr key="empty">
                          <td colSpan={5} className="px-3 py-8 text-center text-sm text-gray-400">
                            No codes yet. Create codes in the Coding Manager tab.
                          </td>
                        </tr>
                      )
                    }

                    return rows
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
