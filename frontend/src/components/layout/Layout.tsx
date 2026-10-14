import { useState, useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import Header from './Header'
import ApiKeyModal from '../modals/ApiKeyModal'
import HfTokenModal from '../modals/HfTokenModal'

export default function Layout({ basePath }: { basePath: string }) {
  const mainRef = useRef<HTMLElement>(null)
  const [showBackToTop, setShowBackToTop] = useState(false)

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const onScroll = () => setShowBackToTop(el.scrollTop > 400)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="flex flex-col h-screen bg-slate-100">
      <Header basePath={basePath} />
      <main ref={mainRef} className="flex-1 overflow-auto">
        <Outlet />
      </main>
      <ApiKeyModal />
      <HfTokenModal />
      {showBackToTop && (
        <button
          onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-6 right-6 z-50 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full w-11 h-11 flex items-center justify-center shadow-lg transition-colors"
          title="Back to top"
          aria-label="Back to top"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}
    </div>
  )
}
