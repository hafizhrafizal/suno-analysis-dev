import { useEffect, useState } from 'react'
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  Outlet,
} from 'react-router-dom'
import { apiFetch, ApiError } from './api/client'
import { useAuthStore } from './store/authStore'
import type { User } from './types'

import Layout from './components/layout/Layout'
import LoginPage from './pages/LoginPage'
import OnboardingPage from './pages/OnboardingPage'
import HomePage from './pages/HomePage'
import SearchPage from './pages/SearchPage'
import BookmarksPage from './pages/BookmarksPage'
import AdminPage from './pages/AdminPage'
import SettingsPage from './pages/SettingsPage'
import CodingPage from './pages/CodingPage'
import NotFoundPage from './pages/NotFoundPage'
import ErrorPage from './pages/ErrorPage'
import InterviewListPage from './pages/interview/InterviewListPage'
import InterviewDetailPage from './pages/interview/InterviewDetailPage'
import NewsListPage from './pages/news/NewsListPage'
import NewsDetailPage from './pages/news/NewsDetailPage'
import GitHubListPage from './pages/github/GitHubListPage'
import GitHubDetailPage from './pages/github/GitHubDetailPage'

function CodingRedirect({ basePath }: { basePath: string }) {
  const last = localStorage.getItem('coding_tab') || 'manager'
  return <Navigate to={`${basePath}/coding/${last}`} replace />
}

function ProtectedRoute() {
  const { user, setUser, setAppMode } = useAuthStore()
  const [loading, setLoading] = useState(true)
  const [redirect, setRedirect] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const modeData = await apiFetch<{ mode: string }>('/auth/app-mode').catch(() => ({ mode: 'single' }))
        const mode = modeData?.mode ?? 'single'
        setAppMode(mode)

        if (mode !== 'multi') {
          return
        }

        if (user) return
        try {
          const me = await apiFetch<User>('/auth/me')
          setUser(me)
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            setRedirect('/login')
          }
        }
      } finally {
        setLoading(false)
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-indigo-700 border-t-transparent" />
      </div>
    )
  }

  if (redirect) return <Navigate to={redirect} replace />

  return <Outlet />
}

const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
    errorElement: <ErrorPage />,
  },
  {
    path: '/onboarding',
    element: <OnboardingPage />,
    errorElement: <ErrorPage />,
  },
  {
    element: <ProtectedRoute />,
    errorElement: <ErrorPage />,
    children: [
      // Module selector home
      { path: '/', element: <HomePage /> },

      // ── Discord Chat Analysis ─────────────────────────────────────────────
      {
        path: '/discord',
        element: <Layout basePath="/discord" mode="discord" />,
        errorElement: <ErrorPage />,
        children: [
          { index: true, element: <Navigate to="/discord/search" replace /> },
          { path: 'search', element: <SearchPage /> },
          { path: 'users/:username', element: <SearchPage /> },
          { path: 'bookmarks', element: <BookmarksPage /> },
          { path: 'coding', element: <CodingRedirect basePath="/discord" /> },
          { path: 'coding/manager', element: <CodingPage /> },
          { path: 'coding/table', element: <CodingPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'admin', element: <AdminPage /> },
        ],
      },

      // ── Coding Manager ────────────────────────────────────────────────────
      {
        path: '/coding',
        element: <Layout basePath="/coding" mode="coding" />,
        errorElement: <ErrorPage />,
        children: [
          { index: true, element: <Navigate to="/coding/bookmarks" replace /> },
          { path: 'bookmarks', element: <BookmarksPage /> },
          { path: 'manager', element: <CodingPage /> },
          { path: 'table', element: <CodingPage /> },
        ],
      },

      // ── Online Interview Analysis ──────────────────────────────────────────
      {
        path: '/interview',
        element: <Layout basePath="/interview" mode="interview" />,
        errorElement: <ErrorPage />,
        children: [
          { index: true, element: <InterviewListPage /> },
          { path: 'bookmarks', element: <BookmarksPage /> },
          { path: 'coding', element: <CodingRedirect basePath="/interview" /> },
          { path: 'coding/manager', element: <CodingPage /> },
          { path: 'coding/table', element: <CodingPage /> },
          { path: ':id', element: <InterviewDetailPage /> },
        ],
      },

      // ── News & Document Analysis ───────────────────────────────────────────
      {
        path: '/news',
        element: <Layout basePath="/news" mode="news" />,
        errorElement: <ErrorPage />,
        children: [
          { index: true, element: <NewsListPage /> },
          { path: 'bookmarks', element: <BookmarksPage /> },
          { path: 'coding', element: <CodingRedirect basePath="/news" /> },
          { path: 'coding/manager', element: <CodingPage /> },
          { path: 'coding/table', element: <CodingPage /> },
          { path: ':id', element: <NewsDetailPage /> },
        ],
      },

      // ── GitHub Activity Analysis ───────────────────────────────────────────
      {
        path: '/github',
        element: <Layout basePath="/github" mode="github" />,
        errorElement: <ErrorPage />,
        children: [
          { index: true, element: <GitHubListPage /> },
          { path: 'bookmarks', element: <BookmarksPage /> },
          { path: 'coding', element: <CodingRedirect basePath="/github" /> },
          { path: 'coding/manager', element: <CodingPage /> },
          { path: 'coding/table', element: <CodingPage /> },
          { path: ':id', element: <GitHubDetailPage /> },
        ],
      },

      // Backward-compat redirects for old un-prefixed routes
      { path: '/search', element: <Navigate to="/discord/search" replace /> },
      { path: '/bookmarks', element: <Navigate to="/discord/bookmarks" replace /> },
      { path: '/settings', element: <Navigate to="/discord/settings" replace /> },
      { path: '/admin', element: <Navigate to="/discord/admin" replace /> },
      // Backward-compat: old coding-manager routes
      { path: '/coding-manager', element: <Navigate to="/coding" replace /> },
      { path: '/coding-manager/*', element: <Navigate to="/coding" replace /> },

      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} future={{ v7_startTransition: true }} />
}
