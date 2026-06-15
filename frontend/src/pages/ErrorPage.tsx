import { useState } from 'react'
import { useNavigate, useRouteError, isRouteErrorResponse } from 'react-router-dom'

function errorDetails(error: unknown): { code: string; title: string; detail: string } {
  if (isRouteErrorResponse(error)) {
    if (error.status === 403) return {
      code: '403',
      title: 'Access denied',
      detail: 'You don\'t have permission to view this page.',
    }
    if (error.status === 401) return {
      code: '401',
      title: 'Not authenticated',
      detail: 'You need to log in to access this.',
    }
    if (error.status === 503) return {
      code: '503',
      title: 'Service unavailable',
      detail: 'The server is temporarily down. Try again in a moment.',
    }
    return {
      code: String(error.status),
      title: error.statusText || 'Something went wrong',
      detail: typeof error.data === 'string' ? error.data : 'An unexpected error occurred.',
    }
  }
  if (error instanceof Error) {
    return {
      code: 'ERR',
      title: 'Application error',
      detail: error.message,
    }
  }
  return {
    code: '???',
    title: 'Unknown error',
    detail: 'Something unexpected happened.',
  }
}

// Broken waveform — all bars glitched/uneven
const BROKEN_BARS = [0.6, 0.2, 0.9, 0.1, 0.7, 0.3, 1.0, 0.15, 0.5, 0.4, 0.8, 0.05, 0.6, 0.3]
const BAR_DELAYS  = [0, 0.3, 0.1, 0.5, 0.2, 0.4, 0.0, 0.6, 0.15, 0.35, 0.05, 0.45, 0.25, 0.55]

interface ErrorPageProps {
  /** Pass when used as a React error boundary fallback (not via router) */
  error?: unknown
  resetError?: () => void
}

export default function ErrorPage({ error: propError, resetError }: ErrorPageProps = {}) {
  const navigate = useNavigate()
  const routeError = useRouteError()
  const err = propError ?? routeError
  const { code, title, detail } = errorDetails(err)
  const [copied, setCopied] = useState(false)

  const fullErrorText = err instanceof Error && err.stack
    ? `${title}\n${detail}\n\n${err.stack}`
    : `${title}\n${detail}`

  const handleCopy = () => {
    navigator.clipboard.writeText(fullErrorText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg bg-white shadow-lg overflow-hidden">

        {/* Header */}
        <div className="bg-[#082b60] px-6 py-4 flex items-center gap-3">
          {/* Pulsing ring indicator */}
          <div className="relative flex-shrink-0 w-8 h-8 flex items-center justify-center">
            <div className="pulse-ring absolute inset-0 bg-red-400 opacity-30" />
            <div className="w-8 h-8 bg-red-600 flex items-center justify-center z-10">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
                  d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
          </div>
          <div>
            <p className="text-white font-semibold text-sm">Signal Lost</p>
            <p className="text-[#93bde5] text-xs">Suno Discord Analysis</p>
          </div>
          <span className="ml-auto text-red-400 text-xs font-mono font-bold">{code}</span>
        </div>

        {/* Broken waveform */}
        <div className="bg-[#f8fafc] border-b border-[#e2e8f0] px-6 py-3 flex items-end gap-[3px] h-14">
          {BROKEN_BARS.map((h, i) => (
            <div
              key={i}
              className="bar-live"
              style={{
                width: '13px',
                height: `${Math.max(h * 28, 3)}px`,
                background: h > 0.6 ? '#dc2626' : h > 0.3 ? '#f97316' : '#cbd5e1',
                animationDelay: `${BAR_DELAYS[i]}s`,
                animationDuration: `${0.7 + BAR_DELAYS[i] * 0.8}s`,
                flexShrink: 0,
              }}
            />
          ))}
        </div>

        {/* Body */}
        <div className="px-6 py-8 text-center">
          <div className="glitch inline-block mb-3">
            <p className="text-[4.5rem] font-black leading-none text-[#082b60] tracking-tight">
              {code}
            </p>
          </div>
          <p className="text-lg font-semibold text-gray-800">{title}</p>
          <p className="mt-1 text-sm text-gray-500 max-w-xs mx-auto select-text">{detail}</p>

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="mt-3 inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 border border-gray-200 hover:border-gray-400 rounded px-2.5 py-1 transition-colors"
          >
            {copied ? (
              <>
                <svg className="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copy error
              </>
            )}
          </button>

          {/* Console-style error box */}
          {err instanceof Error && err.stack && (
            <details className="mt-4 text-left">
              <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600 select-none">
                Show stack trace
              </summary>
              <pre className="mt-2 bg-[#1e293b] text-[#e2e8f0] text-[0.65rem] p-3 overflow-x-auto leading-relaxed max-h-32 select-text">
                {err.stack}
              </pre>
            </details>
          )}
        </div>

        {/* Actions */}
        <div className="border-t border-[#e2e8f0] px-6 py-4 flex flex-wrap gap-3 justify-center">
          {resetError ? (
            <button onClick={resetError} className="search-btn px-5 py-2 text-sm">
              ↺ Try again
            </button>
          ) : (
            <button onClick={() => window.location.reload()} className="search-btn px-5 py-2 text-sm">
              ↺ Reload
            </button>
          )}
          <button onClick={() => navigate('/')} className="action-btn-primary px-5 py-2 text-sm">
            ⌂ Go home
          </button>
        </div>
      </div>

      <p className="mt-5 text-xs text-gray-400">
        If this keeps happening, check that the backend is running on port 3000.
      </p>
    </div>
  )
}
