import { useState } from 'react'
import { Link } from 'react-router-dom'
import { getUserColor, highlightTerms } from '../../utils/colors'
import type { Message } from '../../types'
import { formatMsgDate } from './utils'

interface BrowseChatRowProps {
  msg: Message
  isGrouped: boolean
  isBookmarked: boolean
  onBookmarkToggle: (msg: Message) => void
  tokens?: string[]
}

export default function BrowseChatRow({
  msg,
  isGrouped,
  isBookmarked,
  onBookmarkToggle,
  tokens = [],
}: BrowseChatRowProps) {
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
            <Link
              to={`/discord/search/users/${encodeURIComponent(msg.username)}`}
              className="text-sm font-semibold hover:underline"
              style={{ color: textColor }}
              onClick={e => e.stopPropagation()}
            >{msg.username}</Link>
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
