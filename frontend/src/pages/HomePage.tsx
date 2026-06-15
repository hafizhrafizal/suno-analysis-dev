import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../api/client'
import { useAuthStore } from '../store/authStore'

export default function HomePage() {
  const navigate = useNavigate()
  const { user, appMode, setUser } = useAuthStore()

  const handleLogout = async () => {
    try { await apiFetch('/auth/logout', { method: 'POST' }) } catch {}
    setUser(null)
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">

      {/* Header — matches the app's main Header style */}
      <header className="bg-indigo-700 text-white shadow-lg sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-3 sm:px-4 py-2 sm:py-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-sm sm:text-base font-bold tracking-tight leading-none">
              Qualitative Analysis Tool
            </h1>
            {appMode === 'multi' && user ? (
              <p className="text-indigo-200 text-xs mt-0.5 truncate">
                {user.username}{user.is_admin ? ' · Administrator' : ''}
              </p>
            ) : (
              <p className="text-indigo-300 text-xs mt-0.5">Select a module to get started</p>
            )}
          </div>
          {appMode === 'multi' && user && (
            <button
              onClick={handleLogout}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-200 hover:text-white border border-indigo-600 hover:border-indigo-400 rounded-lg transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Log Out
            </button>
          )}
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="text-center mb-8">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">Choose a Module</h2>
          <p className="text-gray-500 mt-1.5 text-sm">Select the type of analysis you want to perform</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 w-full max-w-4xl">

          {/* Coding Manager */}
          <button
            onClick={() => navigate('/coding/bookmarks')}
            className="group text-left p-6 bg-white rounded-2xl shadow border border-gray-200 hover:border-violet-300 hover:shadow-md transition-all"
          >
            <div className="w-11 h-11 rounded-xl bg-violet-100 flex items-center justify-center mb-4 group-hover:bg-violet-200 transition-colors">
              <svg className="w-5 h-5 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
            </div>
            <h3 className="text-gray-900 font-semibold text-base mb-1.5">Coding Manager</h3>
            <p className="text-gray-500 text-xs leading-relaxed">
              Manage bookmarks and apply qualitative codes and highlights to annotated messages.
            </p>
            <div className="mt-4 flex items-center gap-1 text-violet-600 text-xs font-semibold group-hover:text-violet-800 transition-colors">
              Open
              <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </button>

          {/* Discord Chat Analysis */}
          <button
            onClick={() => navigate('/discord/search')}
            className="group text-left p-6 bg-white rounded-2xl shadow border border-gray-200 hover:border-indigo-300 hover:shadow-md transition-all"
          >
            <div className="w-11 h-11 rounded-xl bg-indigo-100 flex items-center justify-center mb-4 group-hover:bg-indigo-200 transition-colors">
              <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <h3 className="text-gray-900 font-semibold text-base mb-1.5">Discord Chat Analysis</h3>
            <p className="text-gray-500 text-xs leading-relaxed">
              Search, browse, and analyse Discord message exports with semantic search, bookmarks, and AI-assisted summarization.
            </p>
            <div className="mt-4 flex items-center gap-1 text-indigo-600 text-xs font-semibold group-hover:text-indigo-800 transition-colors">
              Open
              <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </button>

          {/* Online Interview Analysis */}
          <button
            onClick={() => navigate('/interview')}
            className="group text-left p-6 bg-white rounded-2xl shadow border border-gray-200 hover:border-teal-300 hover:shadow-md transition-all"
          >
            <div className="w-11 h-11 rounded-xl bg-teal-100 flex items-center justify-center mb-4 group-hover:bg-teal-200 transition-colors">
              <svg className="w-5 h-5 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h3 className="text-gray-900 font-semibold text-base mb-1.5">Online Interview Analysis</h3>
            <p className="text-gray-500 text-xs leading-relaxed">
              Upload transcripts or transcribe YouTube videos. Bookmark excerpts, apply qualitative codes, and annotate passages.
            </p>
            <div className="mt-4 flex items-center gap-1 text-teal-600 text-xs font-semibold group-hover:text-teal-800 transition-colors">
              Open
              <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </button>

          {/* News & Document Analysis */}
          <button
            onClick={() => navigate('/news')}
            className="group text-left p-6 bg-white rounded-2xl shadow border border-gray-200 hover:border-amber-300 hover:shadow-md transition-all"
          >
            <div className="w-11 h-11 rounded-xl bg-amber-100 flex items-center justify-center mb-4 group-hover:bg-amber-200 transition-colors">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
              </svg>
            </div>
            <h3 className="text-gray-900 font-semibold text-base mb-1.5">News & Document Analysis</h3>
            <p className="text-gray-500 text-xs leading-relaxed">
              Extract articles from URLs or upload documents (HTML, PDF, Word, Markdown). Bookmark passages and apply qualitative codes.
            </p>
            <div className="mt-4 flex items-center gap-1 text-amber-600 text-xs font-semibold group-hover:text-amber-800 transition-colors">
              Open
              <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </button>

          {/* GitHub Activity Analysis */}
          <button
            onClick={() => navigate('/github')}
            className="group text-left p-6 bg-white rounded-2xl shadow border border-gray-200 hover:border-slate-400 hover:shadow-md transition-all"
          >
            <div className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center mb-4 group-hover:bg-slate-200 transition-colors">
              <svg className="w-5 h-5 text-slate-700" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
            </div>
            <h3 className="text-gray-900 font-semibold text-base mb-1.5">GitHub Activity Analysis</h3>
            <p className="text-gray-500 text-xs leading-relaxed">
              Analyse GitHub repository activity — commits, issues, pull requests, releases, and discussions — for qualitative research.
            </p>
            <div className="mt-4 flex items-center gap-1 text-slate-600 text-xs font-semibold group-hover:text-slate-900 transition-colors">
              Open
              <svg className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </button>

        </div>
      </main>
    </div>
  )
}
