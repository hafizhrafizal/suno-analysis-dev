import { useEffect, useState } from 'react'
import { apiFetch } from '../../api/client'
import { getUserColor, getUserStyle } from '../../utils/colors'
import type { Message } from '../../types'
import { formatMsgDate } from './utils'

interface TopicMsgRowProps {
  msg: Message
  isBookmarked: boolean
  onBookmarkToggle: (msg: Message) => void
  ctxBefore: number
  ctxAfter: number
}

export default function TopicMsgRow({
  msg,
  isBookmarked,
  onBookmarkToggle,
  ctxBefore,
  ctxAfter,
}: TopicMsgRowProps) {
  const [copied, setCopied] = useState(false)
  const [ctxOpen, setCtxOpen] = useState(false)
  const [ctxMessages, setCtxMessages] = useState<Message[]>([])
  const [ctxLoading, setCtxLoading] = useState(false)
  const [, textColor] = getUserColor(msg.username)

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
    } catch {} finally { setCtxLoading(false) }
  }

  const handleCtxToggle = () => {
    if (ctxOpen) { setCtxOpen(false); return }
    setCtxOpen(true)
    fetchContext()
  }

  // Re-fetch with the new window size while the panel is already open.
  useEffect(() => {
    if (ctxOpen) fetchContext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxBefore, ctxAfter])

  return (
    <div className={`group px-5 py-3 transition-colors ${isBookmarked ? 'bg-amber-50' : 'hover:bg-gray-50'}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-semibold" style={{ color: textColor }}>
          {msg.username}
        </span>
        <span className="text-[10px] text-gray-400">{msg.date}</span>
      </div>
      <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
        {msg.content}
      </p>
      <div className="flex items-center gap-0.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
  )
}
