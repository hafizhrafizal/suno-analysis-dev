import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiFetch } from '../../api/client'

interface ArticleDetail {
  id: string
  title: string
  source_type: 'url' | 'upload'
  source_url?: string
  source_filename?: string
  content: string
  word_count: number
  published_at: string | null
  created_at: string
}

interface CodeRef {
  id: number
  name: string
  color: string
}

interface NewsBookmark {
  id: number
  article_id: string
  excerpt: string
  informant: string
  note: string
  char_start: number | null
  char_end: number | null
  created_at: string
  codes: CodeRef[]
}

interface AvailableCode {
  id: number
  name: string
  color: string
  category_id: number | null
}

function safeHostname(url?: string): string {
  if (!url) return ''
  try { return new URL(url).hostname } catch { return url }
}

// ── Floating bookmark pill (appears on highlight) ─────────────────────────────
function SelectionPill({ pos, onBookmark }: { pos: { top: number; left: number }; onBookmark: () => void }) {
  return (
    <div
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 50 }}
      onMouseDown={e => { e.preventDefault(); onBookmark() }}
      className="cursor-pointer bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg select-none flex items-center gap-1.5 transition-colors"
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4.5L5 21V5z" />
      </svg>
      Bookmark
    </div>
  )
}

// ── Right-click context menu ──────────────────────────────────────────────────
function ContextMenu({
  pos,
  hasSelection,
  onBookmark,
  onClose,
}: {
  pos: { x: number; y: number }
  hasSelection: boolean
  onBookmark: () => void
  onClose: () => void
}) {
  // Keep menu inside viewport
  const menuRef = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState(pos)

  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    let { x, y } = pos
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8
    setAdjustedPos({ x, y })
  }, [pos])

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div
        ref={menuRef}
        style={{ position: 'fixed', top: adjustedPos.y, left: adjustedPos.x, zIndex: 50 }}
        className="bg-white rounded-xl shadow-xl border border-gray-200 py-1 min-w-[180px]"
      >
        <button
          disabled={!hasSelection}
          onClick={() => { onBookmark(); onClose() }}
          className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2.5 transition-colors ${
            hasSelection
              ? 'text-gray-800 hover:bg-amber-50 hover:text-amber-700 cursor-pointer'
              : 'text-gray-300 cursor-not-allowed'
          }`}
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4.5L5 21V5z" />
          </svg>
          {hasSelection ? 'Bookmark selection' : 'Select text to bookmark'}
        </button>
        {!hasSelection && (
          <p className="px-4 pb-2 text-xs text-gray-400">Highlight text first, then right-click</p>
        )}
      </div>
    </>
  )
}

// ── Bookmark creation / edit modal ────────────────────────────────────────────
function BookmarkModal({
  excerpt,
  initial,
  onSave,
  onClose,
}: {
  excerpt: string
  initial?: { informant: string; note: string }
  onSave: (informant: string, note: string) => Promise<void>
  onClose: () => void
}) {
  const [informant, setInformant] = useState(initial?.informant ?? '')
  const [note, setNote] = useState(initial?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const submit = async () => {
    if (!informant.trim()) { setErr('Informant is required.'); return }
    setSaving(true); setErr('')
    try { await onSave(informant.trim(), note.trim()); onClose() }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Save failed') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-gray-900">Add Bookmark</h3>

        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <p className="text-xs text-amber-700 font-semibold mb-1">Selected excerpt</p>
          <p className="text-sm text-gray-800 line-clamp-4 italic">
            "{excerpt.length > 300 ? excerpt.slice(0, 300) + '…' : excerpt}"
          </p>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Informant / Source <span className="text-red-500">*</span>
          </label>
          <input
            ref={inputRef}
            type="text"
            placeholder="e.g. author name, spokesperson, interviewee…"
            value={informant}
            onChange={e => setInformant(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Note (optional)</label>
          <textarea
            rows={3}
            placeholder="Analytical memo, context, or observation…"
            value={note}
            onChange={e => setNote(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"
          />
        </div>

        {err && <p className="text-xs text-red-600">{err}</p>}

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button onClick={submit} disabled={saving} className="flex-1 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
            {saving ? 'Saving…' : 'Save Bookmark'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Code picker for a single bookmark ────────────────────────────────────────
function CodePicker({
  bookmark,
  allCodes,
  onAssign,
  onRemove,
}: {
  bookmark: NewsBookmark
  allCodes: AvailableCode[]
  onAssign: (bookmarkId: number, codeId: number) => Promise<void>
  onRemove: (bookmarkId: number, codeId: number) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const assignedIds = new Set(bookmark.codes.map(c => c.id))

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-xs text-gray-400 hover:text-amber-600 transition-colors flex items-center gap-1"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        Code
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-6 z-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-52 max-h-56 overflow-y-auto">
            {allCodes.length === 0 && <p className="text-xs text-gray-400 px-3 py-2">No codes defined yet.</p>}
            {allCodes.map(code => {
              const assigned = assignedIds.has(code.id)
              return (
                <button
                  key={code.id}
                  onClick={() => { assigned ? onRemove(bookmark.id, code.id) : onAssign(bookmark.id, code.id); setOpen(false) }}
                  className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-gray-50 ${assigned ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
                >
                  <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: code.color }} />
                  {code.name}
                  {assigned && <span className="ml-auto text-amber-600 text-[10px]">✓</span>}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function NewsDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [article, setArticle] = useState<ArticleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Bookmarks + codes
  const [bookmarks, setBookmarks] = useState<NewsBookmark[]>([])
  const [allCodes, setAllCodes] = useState<AvailableCode[]>([])

  // Selection / pill
  const [pillPos, setPillPos] = useState<{ top: number; left: number } | null>(null)
  const [selExcerpt, setSelExcerpt] = useState('')
  const [selRange, setSelRange] = useState<{ start: number; end: number } | null>(null)

  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  // Bookmark modal
  const [showModal, setShowModal] = useState(false)
  const [editBookmark, setEditBookmark] = useState<NewsBookmark | null>(null)

  // Delete confirm
  const [deleteId, setDeleteId] = useState<number | null>(null)

  // Edit mode
  const [editMode, setEditMode] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editPublishedAt, setEditPublishedAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState('')

  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!id) return
    Promise.all([
      apiFetch<ArticleDetail>(`/news/articles/${id}`),
      apiFetch<NewsBookmark[]>(`/news/bookmarks?article_id=${id}`),
      apiFetch<AvailableCode[]>('/codes'),
    ])
      .then(([art, bks, codes]) => { setArticle(art); setBookmarks(bks); setAllCodes(codes) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [id])

  const reloadBookmarks = useCallback(async () => {
    if (!id) return
    setBookmarks(await apiFetch<NewsBookmark[]>(`/news/bookmarks?article_id=${id}`))
  }, [id])

  // Capture selection state for both pill and context menu
  const captureSelection = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const text = sel.toString().trim()
    if (text.length < 10) return null
    const range = sel.getRangeAt(0)
    if (!contentRef.current?.contains(range.commonAncestorContainer)) return null

    // Get exact cursor (focus) position — where the user's pointer ended up
    let cursorRect: DOMRect | null = null
    if (sel.focusNode) {
      try {
        const focusRange = document.createRange()
        const offset = Math.min(sel.focusOffset, (sel.focusNode.textContent?.length ?? 0))
        focusRange.setStart(sel.focusNode, offset)
        focusRange.collapse(true)
        cursorRect = focusRange.getBoundingClientRect()
      } catch { /* ignore edge cases */ }
    }

    // Fall back to last client rect of the selection if focus rect is degenerate
    if (!cursorRect || (cursorRect.width === 0 && cursorRect.height === 0)) {
      const rects = Array.from(range.getClientRects())
      cursorRect = rects[rects.length - 1] ?? range.getBoundingClientRect()
    }

    const articleText = article?.content ?? ''
    const idx = articleText.indexOf(text)
    return {
      text,
      cursorRect,
      range: idx >= 0 ? { start: idx, end: idx + text.length } : null,
    }
  }, [article])

  // Selection change → show pill near cursor end position
  useEffect(() => {
    const handler = () => {
      if (ctxMenu) return
      const captured = captureSelection()
      if (!captured) { setPillPos(null); return }
      const { cursorRect } = captured
      // Clamp horizontally so pill stays inside viewport
      const left = Math.min(
        Math.max(cursorRect.left, 56),
        window.innerWidth - 110
      )
      setPillPos({ top: cursorRect.top - 42, left })
      setSelExcerpt(captured.text)
      setSelRange(captured.range)
    }
    document.addEventListener('selectionchange', handler)
    return () => document.removeEventListener('selectionchange', handler)
  }, [captureSelection, ctxMenu])

  // Right-click inside content
  const handleContextMenu = (e: React.MouseEvent) => {
    if (editMode) return  // don't intercept in edit mode
    e.preventDefault()
    setPillPos(null)  // hide pill while menu is open
    const captured = captureSelection()
    if (captured) {
      setSelExcerpt(captured.text)
      setSelRange(captured.range)
    }
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  const openCreateModal = () => {
    if (!selExcerpt) return
    setEditBookmark(null)
    setShowModal(true)
    setPillPos(null)
  }

  const handleSaveBookmark = async (informant: string, note: string) => {
    if (editBookmark) {
      await apiFetch(`/news/bookmarks/${editBookmark.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ informant, note }),
      })
    } else {
      await apiFetch('/news/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_id: id,
          excerpt: selExcerpt,
          informant,
          note,
          char_start: selRange?.start ?? null,
          char_end: selRange?.end ?? null,
        }),
      })
      window.getSelection()?.removeAllRanges()
    }
    await reloadBookmarks()
  }

  const handleDeleteBookmark = async (bmId: number) => {
    await apiFetch(`/news/bookmarks/${bmId}`, { method: 'DELETE' })
    setBookmarks(prev => prev.filter(b => b.id !== bmId))
    setDeleteId(null)
  }

  const handleAssignCode = async (bookmarkId: number, codeId: number) => {
    await apiFetch('/news/bookmark-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookmark_id: bookmarkId, code_id: codeId }),
    })
    await reloadBookmarks()
  }

  const handleRemoveCode = async (bookmarkId: number, codeId: number) => {
    await apiFetch(`/news/bookmark-codes/${bookmarkId}/${codeId}`, { method: 'DELETE' })
    await reloadBookmarks()
  }

  const enterEditMode = () => {
    if (!article) return
    setEditTitle(article.title)
    setEditContent(article.content)
    setEditPublishedAt(article.published_at ?? '')
    setSaveErr('')
    setEditMode(true)
    setPillPos(null)
  }

  const cancelEdit = () => {
    setEditMode(false)
    setSaveErr('')
  }

  const saveEdit = async () => {
    if (!article || !editTitle.trim()) { setSaveErr('Title cannot be empty.'); return }
    setSaving(true); setSaveErr('')
    const pa = editPublishedAt.trim() || null
    try {
      await apiFetch(`/news/articles/${article.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editTitle.trim(), content: editContent, published_at: pa }),
      })
      const words = editContent.trim() ? editContent.trim().split(/\s+/).length : 0
      setArticle(prev => prev
        ? { ...prev, title: editTitle.trim(), content: editContent, word_count: words, published_at: pa }
        : null
      )
      setEditMode(false)
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-amber-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !article) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12 text-center">
        <p className="text-red-500 text-sm">{error || 'Article not found.'}</p>
        <button onClick={() => navigate('/news')} className="mt-4 text-sm text-amber-600 hover:underline">
          ← Back to articles
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 space-y-4">

      {/* Floating bookmark pill */}
      {pillPos && !editMode && <SelectionPill pos={pillPos} onBookmark={openCreateModal} />}

      {/* Right-click context menu */}
      {ctxMenu && (
        <ContextMenu
          pos={ctxMenu}
          hasSelection={selExcerpt.length >= 10}
          onBookmark={openCreateModal}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Bookmark modal */}
      {showModal && (
        <BookmarkModal
          excerpt={editBookmark ? editBookmark.excerpt : selExcerpt}
          initial={editBookmark ? { informant: editBookmark.informant, note: editBookmark.note } : undefined}
          onSave={handleSaveBookmark}
          onClose={() => { setShowModal(false); setEditBookmark(null) }}
        />
      )}

      {/* Article header */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow p-6">
        <div className="flex items-start justify-between gap-4 mb-3">
          {editMode ? (
            <input
              type="text"
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              className="flex-1 text-xl font-bold text-gray-900 border-b-2 border-amber-400 focus:outline-none bg-transparent"
            />
          ) : (
            <h1 className="text-xl font-bold text-gray-900 leading-snug flex-1">{article.title}</h1>
          )}
          <button onClick={() => navigate('/news')} className="shrink-0 text-xs text-gray-400 hover:text-gray-600 transition-colors">
            ← Back
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
          {article.source_type === 'url' ? (
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              <a href={article.source_url} target="_blank" rel="noopener noreferrer" className="text-amber-600 hover:underline">
                {safeHostname(article.source_url)}
              </a>
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {article.source_filename}
            </span>
          )}
          <span>{(article.word_count ?? 0).toLocaleString()} words</span>
          {article.published_at && (() => {
            try {
              const d = new Date(article.published_at!)
              if (isNaN(d.getTime())) return <span>{article.published_at}</span>
              return (
                <span className="flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  {new Intl.DateTimeFormat(undefined, {
                    year: 'numeric', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
                  }).format(d)}
                </span>
              )
            } catch { return <span>{article.published_at}</span> }
          })()}
          <span>Added {article.created_at.slice(0, 10)}</span>
        </div>

        {/* Edit / Save / Cancel controls — separate row for visibility */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
          {editMode ? (
            <>
              {saveErr && <span className="text-xs text-red-500 mr-auto">{saveErr}</span>}
              <span className="flex-1" />
              <button
                onClick={cancelEdit}
                className="text-sm text-gray-600 hover:text-gray-800 border border-gray-300 px-4 py-1.5 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={saving}
                className="text-sm bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg font-semibold transition-colors"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={enterEditMode}
                className="flex items-center gap-1.5 text-sm font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-300 px-4 py-1.5 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit article
              </button>
              <span className="text-xs text-gray-400 ml-2">Right-click or highlight to bookmark</span>
            </>
          )}
        </div>
      </div>

      {/* Article content */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow p-6">
        {editMode ? (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Published date/time (optional)</label>
              <input
                type="text"
                placeholder="e.g. 2024-03-15T10:30:00Z or 2024-03-15 10:30"
                value={editPublishedAt}
                onChange={e => setEditPublishedAt(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <p className="text-xs text-gray-400 mt-1">Leave blank to clear. ISO 8601 format recommended.</p>
            </div>
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="w-full text-sm text-gray-800 leading-relaxed font-serif focus:outline-none resize-none min-h-[60vh]"
              style={{ height: Math.max(400, editContent.split('\n').length * 22) }}
            />
          </div>
        ) : (
          <div
            ref={contentRef}
            onContextMenu={handleContextMenu}
            className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed font-serif select-text cursor-text"
          >
            {article.content}
          </div>
        )}
      </div>

      {/* Bookmarks section — hidden in edit mode */}
      {!editMode && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900 text-sm">
              Bookmarks
              {bookmarks.length > 0 && (
                <span className="ml-2 bg-amber-100 text-amber-700 text-xs font-bold px-2 py-0.5 rounded-full">
                  {bookmarks.length}
                </span>
              )}
            </h2>
            <p className="text-xs text-gray-400">Highlight text or right-click to add</p>
          </div>

          {bookmarks.length === 0 ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">
              No bookmarks yet. Highlight text in the article to create one.
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {bookmarks.map(bm => (
                <div key={bm.id} className="px-5 py-4 space-y-2">
                  <blockquote className="border-l-4 border-amber-400 pl-3 text-sm text-gray-700 italic line-clamp-3">
                    "{bm.excerpt}"
                  </blockquote>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold px-2.5 py-0.5 rounded-full">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                      {bm.informant}
                    </span>
                    {bm.codes.map(c => (
                      <span
                        key={c.id}
                        className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full text-white"
                        style={{ background: c.color }}
                      >
                        {c.name}
                      </span>
                    ))}
                  </div>

                  {bm.note && (
                    <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">{bm.note}</p>
                  )}

                  <div className="flex items-center gap-4 pt-0.5">
                    <span className="text-xs text-gray-300">{bm.created_at.slice(0, 16).replace('T', ' ')}</span>
                    <div className="ml-auto flex items-center gap-3">
                      <CodePicker bookmark={bm} allCodes={allCodes} onAssign={handleAssignCode} onRemove={handleRemoveCode} />
                      <button
                        onClick={() => { setEditBookmark(bm); setSelExcerpt(bm.excerpt); setShowModal(true) }}
                        className="text-xs text-gray-400 hover:text-amber-600 transition-colors"
                      >
                        Edit
                      </button>
                      {deleteId === bm.id ? (
                        <span className="flex items-center gap-1.5 text-xs">
                          <span className="text-gray-500">Delete?</span>
                          <button onClick={() => handleDeleteBookmark(bm.id)} className="text-red-600 font-semibold hover:underline">Yes</button>
                          <button onClick={() => setDeleteId(null)} className="text-gray-400 hover:underline">No</button>
                        </span>
                      ) : (
                        <button onClick={() => setDeleteId(bm.id)} className="text-xs text-gray-300 hover:text-red-400 transition-colors">
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
