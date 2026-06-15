import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { useAuthStore } from '../../store/authStore'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Transcript {
  id: string
  title: string
  source_type: 'upload' | 'youtube'
  youtube_url?: string
  youtube_id?: string
  content: string
  created_at: string
  updated_at: string
  is_suno_team: boolean
  source_date?: string
  interviewees: string
}

interface Code {
  id: number
  name: string
  color: string
  description: string
  category_id: number | null
}

interface CodeCategory {
  id: number
  name: string
  color: string
  parent_id: number | null
}

interface HighlightEntry {
  id: number
  code_id: number
  code_name: string
  code_color: string
  highlighted_text: string
}

interface InterviewBookmark {
  id: number
  interview_id: string
  excerpt: string
  note: string
  char_start: number | null
  char_end: number | null
  created_at: string
  codes: { id: number; name: string; color: string }[]
  highlights: HighlightEntry[]
}

interface TextSelection {
  text: string
  start: number
  end: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getYouTubeEmbed(youtubeId: string) {
  return `https://www.youtube.com/embed/${youtubeId}`
}

// ── Main component ────────────────────────────────────────────────────────────

export default function InterviewDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { setShowKeyModal } = useAuthStore()

  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [bookmarks, setBookmarks] = useState<InterviewBookmark[]>([])
  const [codes, setCodes] = useState<Code[]>([])
  const [categories, setCategories] = useState<CodeCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Edit mode
  const [editMode, setEditMode] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editSourceDate, setEditSourceDate] = useState('')
  const [editInterviewees, setEditInterviewees] = useState('')
  const [saving, setSaving] = useState(false)

  // Text selection → bookmark creation
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [pendingNote, setPendingNote] = useState('')
  const [bookmarkPopupPos, setBookmarkPopupPos] = useState<{ x: number; y: number } | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)

  // Active bookmark for code assignment
  const [activeBookmark, setActiveBookmark] = useState<InterviewBookmark | null>(null)
  const [assigningCode, setAssigningCode] = useState<number | null>(null)
  const [highlightText, setHighlightText] = useState('')

  // Sidebar panel
  const [sidePanel, setSidePanel] = useState<'bookmarks' | 'codes'>('bookmarks')

  // Format as Q&A
  const [formatQaRunning, setFormatQaRunning] = useState(false)

  const handleFormatQa = async () => {
    if (!id || !transcript) return
    const apiKey = localStorage.getItem('openai_api_key')
    if (!apiKey) { setShowKeyModal(true); return }
    setFormatQaRunning(true)
    try {
      const updated = await apiFetch<{ content: string }>(`/interviews/${id}/format-qa`, {
        method: 'POST',
        headers: { 'X-OpenAI-Key': apiKey },
      })
      setTranscript((prev) => prev ? { ...prev, content: updated.content } : prev)
      setEditContent(updated.content)
    } catch { /* ignore */ }
    setFormatQaRunning(false)
  }

  const handleToggleSunoTeam = async () => {
    if (!id || !transcript) return
    const next = !transcript.is_suno_team
    try {
      await apiFetch(`/interviews/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_suno_team: next }),
      })
      setTranscript((prev) => prev ? { ...prev, is_suno_team: next } : prev)
    } catch { /* ignore */ }
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  const loadBookmarks = useCallback(async () => {
    if (!id) return
    try {
      const data = await apiFetch<InterviewBookmark[]>(`/interview-bookmarks?interview_id=${id}`)
      setBookmarks(data)
    } catch { /* ignore */ }
  }, [id])

  useEffect(() => {
    if (!id) return
    Promise.all([
      apiFetch<Transcript>(`/interviews/${id}`),
      apiFetch<InterviewBookmark[]>(`/interview-bookmarks?interview_id=${id}`),
      apiFetch<Code[]>('/codes'),
      apiFetch<CodeCategory[]>('/code-categories'),
    ])
      .then(([t, bm, c, cats]) => {
        setTranscript(t)
        setEditTitle(t.title)
        setEditContent(t.content)
        setEditSourceDate(t.source_date ?? '')
        setEditInterviewees(t.interviewees ?? '')
        setBookmarks(bm)
        setCodes(c)
        setCategories(cats)
      })
      .catch(() => setError('Failed to load transcript.'))
      .finally(() => setLoading(false))
  }, [id])

  // ── Edit ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!id) return
    setSaving(true)
    try {
      await apiFetch(`/interviews/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ title: editTitle, content: editContent, source_date: editSourceDate || null, interviewees: editInterviewees }),
      })
      setTranscript((prev) => prev ? { ...prev, title: editTitle, content: editContent, source_date: editSourceDate || undefined, interviewees: editInterviewees } : prev)
      setEditMode(false)
    } catch { /* ignore */ }
    setSaving(false)
  }

  // ── Text selection ────────────────────────────────────────────────────────

  const handleMouseUp = () => {
    if (editMode) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setSelection(null)
      setBookmarkPopupPos(null)
      return
    }
    const range = sel.getRangeAt(0)
    const text = sel.toString().trim()
    if (!text || text.length < 3) {
      setSelection(null)
      setBookmarkPopupPos(null)
      return
    }

    // Calculate char offset within the transcript text
    const container = transcriptRef.current
    if (!container || !container.contains(range.startContainer)) {
      setSelection(null)
      setBookmarkPopupPos(null)
      return
    }

    const preRange = document.createRange()
    preRange.selectNodeContents(container)
    preRange.setEnd(range.startContainer, range.startOffset)
    const start = preRange.toString().length

    const rect = range.getBoundingClientRect()
    setSelection({ text, start, end: start + text.length })
    setPendingNote('')
    setBookmarkPopupPos({ x: rect.left + rect.width / 2, y: rect.top - 8 })
  }

  const createBookmark = async () => {
    if (!selection || !id) return
    try {
      const bm = await apiFetch<InterviewBookmark>('/interview-bookmarks', {
        method: 'POST',
        body: JSON.stringify({
          interview_id: id,
          excerpt: selection.text,
          note: pendingNote,
          char_start: selection.start,
          char_end: selection.end,
        }),
      })
      setBookmarks((prev) => [...prev, { ...bm, codes: [], highlights: [] }])
      setSelection(null)
      setBookmarkPopupPos(null)
      setPendingNote('')
      window.getSelection()?.removeAllRanges()
      setSidePanel('bookmarks')
    } catch { /* ignore */ }
  }

  const deleteBookmark = async (bmId: number) => {
    await apiFetch(`/interview-bookmarks/${bmId}`, { method: 'DELETE' })
    setBookmarks((prev) => prev.filter((b) => b.id !== bmId))
    if (activeBookmark?.id === bmId) setActiveBookmark(null)
  }

  const updateBookmarkNote = async (bm: InterviewBookmark, note: string) => {
    await apiFetch(`/interview-bookmarks/${bm.id}`, {
      method: 'PUT',
      body: JSON.stringify({ note }),
    })
    setBookmarks((prev) => prev.map((b) => b.id === bm.id ? { ...b, note } : b))
    setActiveBookmark((prev) => prev?.id === bm.id ? { ...prev, note } : prev)
  }

  // ── Code assignment ───────────────────────────────────────────────────────

  const assignCode = async (bm: InterviewBookmark, codeId: number) => {
    await apiFetch('/interview-bookmark-codes', {
      method: 'POST',
      body: JSON.stringify({ bookmark_id: bm.id, code_id: codeId }),
    })
    await loadBookmarks()
    setActiveBookmark((prev) => {
      if (!prev || prev.id !== bm.id) return prev
      const code = codes.find((c) => c.id === codeId)
      if (!code || prev.codes.some((c) => c.id === codeId)) return prev
      return { ...prev, codes: [...prev.codes, code] }
    })
  }

  const removeCode = async (bm: InterviewBookmark, codeId: number) => {
    await apiFetch(`/interview-bookmark-codes/${bm.id}/${codeId}`, { method: 'DELETE' })
    await loadBookmarks()
    setActiveBookmark((prev) =>
      prev?.id === bm.id
        ? { ...prev, codes: prev.codes.filter((c) => c.id !== codeId) }
        : prev
    )
  }

  const addHighlight = async (bm: InterviewBookmark, codeId: number, text: string) => {
    if (!text.trim()) return
    const hl = await apiFetch<HighlightEntry>(`/interview-bookmarks/${bm.id}/highlights`, {
      method: 'POST',
      body: JSON.stringify({ code_id: codeId, highlighted_text: text.trim() }),
    })
    setActiveBookmark((prev) =>
      prev?.id === bm.id ? { ...prev, highlights: [...prev.highlights, hl] } : prev
    )
    setBookmarks((prev) =>
      prev.map((b) => b.id === bm.id ? { ...b, highlights: [...b.highlights, hl] } : b)
    )
    setHighlightText('')
    setAssigningCode(null)
  }

  const removeHighlight = async (bm: InterviewBookmark, hlId: number) => {
    await apiFetch(`/interview-bookmarks/${bm.id}/highlights/${hlId}`, { method: 'DELETE' })
    setActiveBookmark((prev) =>
      prev?.id === bm.id
        ? { ...prev, highlights: prev.highlights.filter((h) => h.id !== hlId) }
        : prev
    )
    setBookmarks((prev) =>
      prev.map((b) =>
        b.id === bm.id ? { ...b, highlights: b.highlights.filter((h) => h.id !== hlId) } : b
      )
    )
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  const categoryMap = Object.fromEntries(categories.map((c) => [c.id, c]))

  const groupedCodes: Record<string, Code[]> = {}
  codes.forEach((c) => {
    const key = c.category_id ? String(c.category_id) : '__none__'
    ;(groupedCodes[key] ??= []).push(c)
  })

  // ── Annotated transcript rendering ───────────────────────────────────────

  const renderAnnotatedContent = (content: string) => {
    if (bookmarks.length === 0) return content

    // Build spans sorted by position
    type Span = { start: number; end: number; bm: InterviewBookmark }
    const spans: Span[] = bookmarks
      .filter((b) => b.char_start != null && b.char_end != null)
      .map((b) => ({ start: b.char_start!, end: b.char_end!, bm: b }))
      .sort((a, b) => a.start - b.start)

    if (spans.length === 0) return content

    const parts: React.ReactNode[] = []
    let pos = 0

    for (const span of spans) {
      if (span.start > pos) {
        parts.push(content.slice(pos, span.start))
      }
      const highlighted = content.slice(span.start, span.end)
      const color = span.bm.codes[0]?.color ?? '#6366f1'
      parts.push(
        <mark
          key={span.bm.id}
          onClick={() => { setActiveBookmark(span.bm); setSidePanel('bookmarks') }}
          style={{ backgroundColor: color + '33', borderBottom: `2px solid ${color}`, cursor: 'pointer' }}
          title={span.bm.codes.map((c) => c.name).join(', ') || 'Bookmarked'}
        >
          {highlighted}
        </mark>
      )
      pos = span.end
    }
    if (pos < content.length) parts.push(content.slice(pos))
    return parts
  }

  // ── States ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-indigo-600 border-t-transparent" />
      </div>
    )
  }

  if (error || !transcript) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center">
        <p className="text-red-500 mb-4">{error || 'Transcript not found.'}</p>
        <button onClick={() => navigate('/interview')} className="text-indigo-600 hover:underline text-sm">
          ← Back to interviews
        </button>
      </div>
    )
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <div className="flex h-full">

      {/* ── Left: transcript ───────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="max-w-3xl mx-auto px-4 py-5 space-y-4">

          {/* Title row */}
          <div className="flex items-start gap-3">
            <button
              onClick={() => navigate('/interview')}
              className="shrink-0 mt-0.5 text-gray-400 hover:text-gray-700 transition-colors"
              title="Back"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex-1 min-w-0">
              {editMode ? (
                <div className="space-y-1.5">
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full text-xl font-bold text-gray-900 border-b-2 border-indigo-400 focus:outline-none bg-transparent"
                  />
                  <input
                    type="text"
                    placeholder="Interviewee name(s), comma-separated"
                    value={editInterviewees}
                    onChange={(e) => setEditInterviewees(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400 shrink-0">
                      {transcript.source_type === 'youtube' ? 'Published date/time' : 'Document date/time'}
                    </label>
                    <input
                      type="datetime-local"
                      value={editSourceDate}
                      onChange={(e) => setEditSourceDate(e.target.value)}
                      className="border border-gray-200 rounded px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 min-w-0">
                    <h1 className="text-xl font-bold text-gray-900 truncate">{transcript.title}</h1>
                    <button
                      onClick={handleToggleSunoTeam}
                      title={transcript.is_suno_team ? 'Remove Suno Team label' : 'Mark as Suno Team'}
                      className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full transition-colors ${
                        transcript.is_suno_team
                          ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'
                          : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                      }`}
                    >
                      {transcript.is_suno_team ? 'Suno Team' : '+ Suno Team'}
                    </button>
                  </div>
                  {transcript.interviewees && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {transcript.interviewees.split(',').map((n) => n.trim()).filter(Boolean).map((name) => (
                        <span key={name} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                          {name}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
              <p className="text-xs text-gray-400 mt-0.5">
                {transcript.source_type === 'youtube' ? 'YouTube' : 'Upload'}
                {transcript.source_date && (
                  <> · <span className="text-gray-500">
                    {transcript.source_type === 'youtube' ? 'Published' : 'Dated'} {transcript.source_date.slice(0, 19).replace('T', ' ')}
                  </span></>
                )}
                {' · '}Transcribed {transcript.created_at.slice(0, 19).replace('T', ' ')}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {editMode ? (
                <>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => { setEditMode(false); setEditTitle(transcript.title); setEditContent(transcript.content); setEditSourceDate(transcript.source_date ?? ''); setEditInterviewees(transcript.interviewees ?? '') }}
                    className="px-3 py-1.5 text-xs font-semibold border border-gray-300 text-gray-600 hover:text-gray-900 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={handleFormatQa}
                    disabled={formatQaRunning}
                    title="Reformat transcript as Q&A using GPT (requires OpenAI key)"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-gray-300 text-gray-600 hover:text-gray-900 hover:border-gray-400 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {formatQaRunning ? (
                      <div className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-3 3-3-3z" />
                      </svg>
                    )}
                    {formatQaRunning ? 'Formatting…' : 'Format Q&A'}
                  </button>
                  <button
                    onClick={() => setEditMode(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-gray-300 text-gray-600 hover:text-gray-900 hover:border-gray-400 rounded-lg transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    Edit
                  </button>
                </>
              )}
            </div>
          </div>

          {/* YouTube embed */}
          {transcript.source_type === 'youtube' && transcript.youtube_id && (
            <div className="aspect-video rounded-xl overflow-hidden shadow border border-gray-200">
              <iframe
                src={getYouTubeEmbed(transcript.youtube_id)}
                title={transcript.title}
                allowFullScreen
                className="w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              />
            </div>
          )}

          {/* Transcript content */}
          {editMode ? (
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full min-h-[60vh] border border-gray-300 rounded-xl p-4 text-sm text-gray-800 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-y font-mono"
            />
          ) : (
            <div className="relative">
              {!editMode && (
                <p className="text-xs text-gray-400 mb-2 select-none">
                  Select text to bookmark a passage.
                </p>
              )}
              <div
                ref={transcriptRef}
                onMouseUp={handleMouseUp}
                className="bg-white rounded-xl border border-gray-200 p-5 text-sm text-gray-800 leading-relaxed whitespace-pre-wrap select-text cursor-text"
                style={{ userSelect: 'text' }}
              >
                {renderAnnotatedContent(transcript.content)}
              </div>

              {/* Bookmark creation popup */}
              {selection && bookmarkPopupPos && (
                <div
                  className="fixed z-50 bg-white rounded-xl shadow-xl border border-gray-200 p-3 w-72"
                  style={{
                    left: Math.min(bookmarkPopupPos.x - 144, window.innerWidth - 300),
                    top: bookmarkPopupPos.y - 150,
                  }}
                >
                  <p className="text-xs font-semibold text-gray-700 mb-1">Bookmark selection</p>
                  <p className="text-xs text-gray-500 italic mb-2 line-clamp-2">"{selection.text}"</p>
                  <input
                    autoFocus
                    type="text"
                    placeholder="Add a note (optional)"
                    value={pendingNote}
                    onChange={(e) => setPendingNote(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') createBookmark() }}
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 mb-2"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={createBookmark}
                      className="flex-1 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
                    >
                      Save Bookmark
                    </button>
                    <button
                      onClick={() => { setSelection(null); setBookmarkPopupPos(null); window.getSelection()?.removeAllRanges() }}
                      className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: sidebar ─────────────────────────────────────────────────── */}
      <div className="w-80 xl:w-96 shrink-0 border-l border-gray-200 flex flex-col overflow-hidden">

        {/* Tab switcher */}
        <div className="flex border-b border-gray-100 shrink-0">
          <button
            onClick={() => setSidePanel('bookmarks')}
            className={`flex-1 py-2.5 text-xs font-semibold transition-colors ${
              sidePanel === 'bookmarks' ? 'text-indigo-700 border-b-2 border-indigo-500' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Bookmarks ({bookmarks.length})
          </button>
          <button
            onClick={() => setSidePanel('codes')}
            className={`flex-1 py-2.5 text-xs font-semibold transition-colors ${
              sidePanel === 'codes' ? 'text-violet-700 border-b-2 border-violet-500' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Codes ({codes.length})
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">

          {/* ── Bookmarks panel ─────────────────────────────────────────── */}
          {sidePanel === 'bookmarks' && (
            <div className="p-3 space-y-2">
              {bookmarks.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-8">
                  No bookmarks yet. Select text in the transcript to add one.
                </p>
              )}
              {bookmarks.map((bm) => (
                <div
                  key={bm.id}
                  onClick={() => setActiveBookmark(activeBookmark?.id === bm.id ? null : bm)}
                  className={`rounded-xl border p-3 cursor-pointer transition-all ${
                    activeBookmark?.id === bm.id
                      ? 'border-indigo-400 bg-indigo-50 shadow-sm'
                      : 'border-gray-200 bg-white hover:border-indigo-200'
                  }`}
                >
                  <p className="text-xs text-gray-600 italic line-clamp-2">"{bm.excerpt}"</p>
                  {bm.note && (
                    <p className="text-xs text-gray-500 mt-1">{bm.note}</p>
                  )}
                  {bm.codes.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {bm.codes.map((c) => (
                        <span
                          key={c.id}
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-white"
                          style={{ backgroundColor: c.color }}
                        >
                          {c.name}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Expanded bookmark actions */}
                  {activeBookmark?.id === bm.id && (
                    <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                      {/* Note editor */}
                      <NoteEditor
                        note={bm.note}
                        onSave={(note) => updateBookmarkNote(bm, note)}
                      />

                      {/* Highlights */}
                      {bm.highlights.length > 0 && (
                        <div className="space-y-1">
                          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Highlights</p>
                          {bm.highlights.map((hl) => (
                            <div key={hl.id} className="flex items-start gap-1.5 group">
                              <span
                                className="shrink-0 w-2.5 h-2.5 rounded-full mt-0.5"
                                style={{ backgroundColor: hl.code_color }}
                              />
                              <span className="text-xs text-gray-600 flex-1 min-w-0">
                                <span className="font-semibold" style={{ color: hl.code_color }}>{hl.code_name}:</span>{' '}
                                {hl.highlighted_text}
                              </span>
                              <button
                                onClick={() => removeHighlight(bm, hl.id)}
                                className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Code assignment */}
                      <div className="space-y-1">
                        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Assign codes</p>
                        <div className="flex flex-wrap gap-1">
                          {codes.map((code) => {
                            const assigned = bm.codes.some((c) => c.id === code.id)
                            return (
                              <button
                                key={code.id}
                                onClick={() => assigned ? removeCode(bm, code.id) : assignCode(bm, code.id)}
                                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border transition-all ${
                                  assigned
                                    ? 'text-white border-transparent'
                                    : 'bg-white border-gray-200 text-gray-600 hover:border-gray-400'
                                }`}
                                style={assigned ? { backgroundColor: code.color, borderColor: code.color } : undefined}
                                title={code.name}
                              >
                                {code.name}
                              </button>
                            )
                          })}
                        </div>

                        {/* Add highlight for specific code */}
                        {bm.codes.length > 0 && (
                          <div className="mt-1.5">
                            <p className="text-[10px] text-gray-400 mb-1">Add highlight to code:</p>
                            <div className="flex gap-1 flex-wrap mb-1">
                              {bm.codes.map((c) => (
                                <button
                                  key={c.id}
                                  onClick={() => setAssigningCode(assigningCode === c.id ? null : c.id)}
                                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-white"
                                  style={{ backgroundColor: c.color, opacity: assigningCode === c.id ? 1 : 0.6 }}
                                >
                                  {c.name}
                                </button>
                              ))}
                            </div>
                            {assigningCode != null && (
                              <div className="flex gap-1">
                                <input
                                  type="text"
                                  placeholder="Paste highlighted text…"
                                  value={highlightText}
                                  onChange={(e) => setHighlightText(e.target.value)}
                                  className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                />
                                <button
                                  onClick={() => addHighlight(bm, assigningCode, highlightText)}
                                  className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition-colors"
                                >
                                  Add
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <button
                        onClick={() => deleteBookmark(bm.id)}
                        className="text-[10px] text-red-400 hover:text-red-600 transition-colors"
                      >
                        Delete bookmark
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Codes panel ─────────────────────────────────────────────── */}
          {sidePanel === 'codes' && (
            <div className="p-3 space-y-3">
              {codes.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-8">
                  No codes yet. Create codes in the Coding Manager.
                </p>
              )}
              {Object.entries(groupedCodes).map(([catKey, catCodes]) => {
                const cat = catKey !== '__none__' ? categoryMap[Number(catKey)] : null
                return (
                  <div key={catKey}>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5 px-1">
                      {cat ? cat.name : 'Uncategorized'}
                    </p>
                    <div className="space-y-1">
                      {catCodes.map((code) => (
                        <div
                          key={code.id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-gray-100"
                        >
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: code.color }} />
                          <span className="text-xs font-medium text-gray-700">{code.name}</span>
                          {code.description && (
                            <span className="text-xs text-gray-400 truncate">{code.description}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── NoteEditor sub-component ──────────────────────────────────────────────────

function NoteEditor({ note, onSave }: { note: string; onSave: (note: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(note)

  const commit = () => {
    onSave(value)
    setEditing(false)
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="w-full text-left text-xs text-gray-400 hover:text-gray-600 transition-colors"
      >
        {note ? (
          <span className="text-gray-600">{note}</span>
        ) : (
          <span className="italic">+ Add note</span>
        )}
      </button>
    )
  }

  return (
    <div className="flex gap-1">
      <input
        autoFocus
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
        placeholder="Note…"
      />
      <button onClick={commit} className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition-colors">
        Save
      </button>
    </div>
  )
}
