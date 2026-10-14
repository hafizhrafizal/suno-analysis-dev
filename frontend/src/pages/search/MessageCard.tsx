import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { getUserColor, getUserStyle, highlightText, highlightTerms } from '../../utils/colors'
import type { Message } from '../../types'
import type { MsgEmotion } from './types'
import UsernameTag from './UsernameTag'
import { formatMsgDate } from './utils'

interface MessageCardProps {
  msg: Message
  keyword: string
  tokens: string[]
  isBookmarked: boolean
  onBookmarkToggle: (msg: Message) => void
  ctxBefore: number
  ctxAfter: number
  isGrouped?: boolean
  emotion?: MsgEmotion
  archetype?: string
}

export default function MessageCard({ msg, keyword, tokens, isBookmarked, onBookmarkToggle, ctxBefore, ctxAfter, isGrouped = false, emotion, archetype }: MessageCardProps) {
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

  const fetchContext = async () => {
    setCtxLoading(true)
    try {
      const data = await apiFetch<Message[]>(`/context/${msg.id}?before=${ctxBefore}&after=${ctxAfter}`)
      setCtxMessages(data)
    } catch { } finally { setCtxLoading(false) }
  }

  const handleCtxToggle = () => {
    if (ctxOpen) { setCtxOpen(false); return }
    setCtxOpen(true)
    fetchContext()
  }

  // Re-fetch with the new window size while the panel is already open, so
  // changing the "Context" inputs updates visible panels instead of only
  // affecting the next "View context" click.
  useEffect(() => {
    if (ctxOpen) fetchContext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxBefore, ctxAfter])

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
            {(() => {
              const isSunoTeam = msg.is_suno_team === 'True' || msg.is_suno_team === true || msg.is_suno_team === '1'
              return (
                <>
                  {isSunoTeam && (
                    <span className="text-[10px] font-semibold bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full">Suno Team</span>
                  )}
                  {archetype && !isSunoTeam && (() => {
                    const cls = archetype === 'Contributor' ? 'bg-blue-100 text-blue-700'
                      : archetype === 'Explorer' ? 'bg-violet-100 text-violet-700'
                      : archetype === 'Help-Seeker' ? 'bg-amber-100 text-amber-700'
                      : archetype === 'Evangelist' ? 'bg-green-100 text-green-700'
                      : archetype === 'Scrutinizer' ? 'bg-red-100 text-red-700'
                      : archetype === 'Uncategorized' ? 'bg-slate-100 text-slate-500'
                      : 'bg-gray-100 text-gray-600'
                    return <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${cls}`}>{archetype}</span>
                  })()}
                </>
              )
            })()}
            {msg.similarity != null && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-600 border border-indigo-200 px-1.5 py-0.5 rounded-full tabular-nums">
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                {(msg.similarity * 100).toFixed(1)}%
              </span>
            )}
            {emotion && (() => {
              const sentColor = emotion.sentiment === 'positive' ? '#10b981' : emotion.sentiment === 'negative' ? '#f43f5e' : '#9ca3af'
              const sentBg   = emotion.sentiment === 'positive' ? '#d1fae5' : emotion.sentiment === 'negative' ? '#ffe4e6' : '#f3f4f6'
              const tooltip = [
                `Sentiment: ${emotion.sentiment}`,
                emotion.dominant_emotion ? `Dominant emotion: ${emotion.dominant_emotion}` : '',
                ...(emotion.top_emotions?.length ? ['Top emotions: ' + emotion.top_emotions.map(e => `${e.label} (${(e.score * 100).toFixed(0)}%)`).join(', ')] : []),
              ].filter(Boolean).join('\n')
              return (
                <span
                  className="inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded-full capitalize"
                  style={{ color: sentColor, backgroundColor: sentBg }}
                  title={tooltip}
                >
                  💬 {emotion.sentiment}
                  {emotion.dominant_emotion && <span className="opacity-70">· {emotion.dominant_emotion}</span>}
                </span>
              )
            })()}
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
                    <Link to={`/discord/search/users/${encodeURIComponent(m.username)}`} className="shrink-0 font-semibold hover:underline" style={getUserStyle(m.username)} onClick={e => e.stopPropagation()}>{m.username}</Link>
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
