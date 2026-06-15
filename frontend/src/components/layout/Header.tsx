import { useState, useRef, useEffect } from 'react'
import { NavLink, Link, useNavigate } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { useAuthStore } from '../../store/authStore'
import type { AppMode } from './Layout'
import type { Stats } from '../../types'

export default function Header({ basePath, mode }: { basePath: string; mode: AppMode }) {
  const { user, appMode, setUser, setShowKeyModal } = useAuthStore()
  const navigate = useNavigate()
  const [stats, setStats] = useState<Stats | null>(null)
  const [bookmarkCount, setBookmarkCount] = useState(0)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [moduleDropdownOpen, setModuleDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const moduleDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    apiFetch<Stats>('/stats').then(setStats).catch(() => {})
    apiFetch<number[]>('/bookmarks/ids').then((ids) => setBookmarkCount(ids.length)).catch(() => {})
    const interval = setInterval(() => {
      apiFetch<Stats>('/stats').then(setStats).catch(() => {})
    }, 60_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    if (dropdownOpen) document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [dropdownOpen])

  // Click-outside for module dropdown
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (moduleDropdownRef.current && !moduleDropdownRef.current.contains(e.target as Node)) {
        setModuleDropdownOpen(false)
      }
    }
    if (moduleDropdownOpen) document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [moduleDropdownOpen])

  const handleLogout = async () => {
    setDropdownOpen(false)
    try { await apiFetch('/auth/logout', { method: 'POST' }) } catch { }
    setUser(null)
    navigate('/login')
  }

  const navCls = ({ isActive }: { isActive: boolean }) =>
    `nav-tab${isActive ? ' nav-active' : ''}`

  const isAdmin = appMode !== 'multi' || user?.is_admin === true

  const modeLabel =
    mode === 'discord' ? 'Discord Chat Analysis'
    : mode === 'interview' ? 'Online Interview Analysis'
    : mode === 'news' ? 'News & Document Analysis'
    : mode === 'github' ? 'GitHub Activity Analysis'
    : 'Coding Manager'

  const modules: { mode: AppMode; label: string; path: string; color: string }[] = [
    { mode: 'discord', label: 'Discord Chat Analysis', path: '/discord/search', color: 'bg-indigo-500' },
    { mode: 'coding', label: 'Coding Manager', path: '/coding/bookmarks', color: 'bg-violet-500' },
    { mode: 'interview', label: 'Online Interview Analysis', path: '/interview', color: 'bg-teal-500' },
    { mode: 'news', label: 'News & Document Analysis', path: '/news', color: 'bg-amber-500' },
    { mode: 'github', label: 'GitHub Activity Analysis', path: '/github', color: 'bg-slate-600' },
  ]

  return (
    <header className="bg-indigo-700 text-white shadow-lg sticky top-0 z-40">
      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-2 sm:py-3 flex items-center gap-2 sm:gap-4">

        {/* Home button */}
        <Link
          to="/"
          className="shrink-0 w-7 h-7 rounded-lg bg-indigo-600 hover:bg-indigo-500 flex items-center justify-center transition-colors"
          title="Back to module selector"
          aria-label="Home"
        >
          <svg className="w-4 h-4 text-indigo-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
        </Link>

        {/* Title + module switcher */}
        <div className="flex-1 min-w-0 relative" ref={moduleDropdownRef}>
          <button
            onClick={() => setModuleDropdownOpen(v => !v)}
            className="flex items-center gap-1.5 hover:opacity-80 transition-opacity cursor-pointer select-none"
            aria-label="Switch module"
            aria-expanded={moduleDropdownOpen}
          >
            <h1 className="text-sm sm:text-base font-bold tracking-tight leading-none text-left">
              {modeLabel}
            </h1>
            <svg className={`w-3.5 h-3.5 text-indigo-300 transition-transform ${moduleDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {moduleDropdownOpen && (
            <div className="absolute left-0 top-full mt-1.5 w-64 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-50">
              <div className="px-4 py-2 border-b border-gray-100">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Switch Module</p>
              </div>
              {modules.map((m) => (
                <button
                  key={m.mode}
                  onClick={() => {
                    setModuleDropdownOpen(false)
                    navigate(m.path)
                  }}
                  className={`w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-3 transition-colors ${
                    mode === m.mode ? 'bg-indigo-50' : ''
                  }`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${m.color}`} />
                  <span className={`font-medium ${mode === m.mode ? 'text-indigo-700' : 'text-gray-700'}`}>
                    {m.label}
                  </span>
                  {mode === m.mode && (
                    <svg className="w-4 h-4 text-indigo-500 ml-auto shrink-0" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
          {mode === 'discord' && stats ? (
            <p className="text-indigo-200 text-xs mt-0.5 truncate" aria-live="polite">
              <span className="hidden sm:inline">
                {stats.total_messages.toLocaleString()} msgs &bull; {stats.total_uploads} uploads &bull; {stats.embedded_messages.toLocaleString()} embedded
              </span>
              <span className="sm:hidden">
                {stats.total_messages.toLocaleString()} msgs &bull; {stats.embedded_messages.toLocaleString()} vecs
              </span>
            </p>
          ) : mode === 'discord' ? (
            <p className="text-indigo-300 text-xs mt-0.5">Loading…</p>
          ) : null}
        </div>

        {/* Nav tabs */}
        <nav className="flex gap-0 sm:gap-0.5 bg-indigo-800 rounded-lg p-0.5 shrink-0">
          {mode === 'github' ? (
            <>
              <NavLink to={`${basePath}`} end className={navCls} aria-label="Repositories">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11h8M8 15h5" />
                </svg>
                <span className="hidden sm:inline">Repos</span>
              </NavLink>
              <NavLink to={`${basePath}/bookmarks`} className={navCls} aria-label="Bookmarks">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                <span className="hidden sm:inline">Bookmarks</span>
              </NavLink>
              <NavLink to={`${basePath}/coding`} className={navCls} aria-label="Coding">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                <span className="hidden sm:inline">Coding</span>
              </NavLink>
            </>
          ) : mode === 'interview' ? (
            <>
              <NavLink to={`${basePath}`} end className={navCls} aria-label="Interviews">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                <span className="hidden sm:inline">Interviews</span>
              </NavLink>
              <NavLink to={`${basePath}/bookmarks`} className={navCls} aria-label="Bookmarks">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                <span className="hidden sm:inline">Bookmarks</span>
              </NavLink>
              <NavLink to={`${basePath}/coding`} className={navCls} aria-label="Coding">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                <span className="hidden sm:inline">Coding</span>
              </NavLink>
            </>
          ) : mode === 'news' ? (
            <>
              <NavLink to={`${basePath}`} end className={navCls} aria-label="Articles">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
                </svg>
                <span className="hidden sm:inline">Articles</span>
              </NavLink>
              <NavLink to={`${basePath}/bookmarks`} className={navCls} aria-label="Bookmarks">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                <span className="hidden sm:inline">Bookmarks</span>
              </NavLink>
              <NavLink to={`${basePath}/coding`} className={navCls} aria-label="Coding">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                <span className="hidden sm:inline">Coding</span>
              </NavLink>
            </>
          ) : (
            <>
              {mode === 'discord' && (
                <NavLink to={`${basePath}/search`} className={navCls} aria-label="Search">
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span className="hidden sm:inline">Search</span>
                </NavLink>
              )}

              <NavLink to={`${basePath}/bookmarks`} className={navCls} aria-label="Bookmarks">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
                <span className="hidden sm:inline">Bookmarks</span>
                {bookmarkCount > 0 && (
                  <span className="text-[10px] bg-white text-indigo-800 rounded-full px-1.5 py-0.5 font-bold leading-none" aria-label={`${bookmarkCount} bookmarks`}>
                    {bookmarkCount}
                  </span>
                )}
              </NavLink>

              <NavLink to={mode === 'coding' ? `${basePath}/manager` : `${basePath}/coding`} className={navCls} aria-label="Coding">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                <span className="hidden sm:inline">Coding</span>
              </NavLink>

              {mode === 'discord' && appMode !== 'multi' && (
                <NavLink to={`${basePath}/settings`} className={navCls} aria-label="Settings">
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <span className="hidden sm:inline">Settings</span>
                </NavLink>
              )}
            </>
          )}
        </nav>

        {/* API key indicator (single/demo mode) */}
        {appMode !== 'multi' && (
          <button
            onClick={() => setShowKeyModal(true)}
            className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
              localStorage.getItem('openai_api_key')
                ? 'bg-green-500 hover:bg-green-400'
                : 'bg-red-500 hover:bg-red-400 animate-pulse'
            }`}
            title={localStorage.getItem('openai_api_key') ? 'API key set — tap to change' : 'No API key — tap to set'}
            aria-label="OpenAI API key"
          >
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </button>
        )}

        {/* User avatar dropdown (multi mode only) */}
        {appMode === 'multi' && user && (
          <div className="shrink-0 relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              className="w-8 h-8 rounded-full bg-indigo-500 border-2 border-indigo-300 flex items-center justify-center text-white font-bold text-sm select-none cursor-pointer hover:bg-indigo-400 transition-colors"
              aria-label="User menu"
              aria-expanded={dropdownOpen}
            >
              {user.username.charAt(0).toUpperCase()}
            </button>

            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-50">
                <div className="px-4 py-2.5 border-b border-gray-100">
                  <p className="text-sm font-semibold text-gray-900 truncate">{user.username}</p>
                  <p className="text-xs text-gray-500">{user.is_admin ? 'Administrator' : 'User'}</p>
                </div>
                <button
                  onClick={() => { setDropdownOpen(false); setShowKeyModal(true) }}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${localStorage.getItem('openai_api_key') ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className={localStorage.getItem('openai_api_key') ? 'text-gray-700' : 'text-red-600 font-semibold'}>
                    {localStorage.getItem('openai_api_key') ? 'API key set' : 'Set API key'}
                  </span>
                </button>
                {mode === 'discord' && isAdmin && (
                  <button
                    onClick={() => { setDropdownOpen(false); navigate(`${basePath}/admin`) }}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                  >
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    Admin
                  </button>
                )}
                {mode === 'discord' && (
                  <button
                    onClick={() => { setDropdownOpen(false); navigate(`${basePath}/settings`) }}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                  >
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    Settings
                  </button>
                )}
                <button
                  onClick={handleLogout}
                  className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  Log Out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
