import { useEffect, useState } from 'react'
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  Outlet,
  useParams,
} from 'react-router-dom'
import { apiFetch, ApiError } from './api/client'
import { useAuthStore } from './store/authStore'
import type { User } from './types'

import Layout from './components/layout/Layout'
import LoginPage from './pages/LoginPage'
import OnboardingPage from './pages/OnboardingPage'
import SearchPage from './pages/search/SearchPage'
import BookmarksPage from './pages/BookmarksPage'
import AdminPage from './pages/AdminPage'
import SettingsPage from './pages/SettingsPage'
import CodingPage from './pages/CodingPage'
import NotFoundPage from './pages/NotFoundPage'
import ErrorPage from './pages/ErrorPage'

function CodingRedirect({ basePath }: { basePath: string }) {
  const last = localStorage.getItem('coding_tab') || 'manager'
  return <Navigate to={`${basePath}/coding/${last}`} replace />
}

function UserSearchRedirect() {
  return <Navigate to="/discord/search/users" replace />
}

function UserDetailRedirect() {
  const { username } = useParams<{ username?: string }>()
  return <Navigate to={`/discord/search/users/${encodeURIComponent(username ?? '')}`} replace />
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
      { path: '/', element: <Navigate to="/discord/search" replace /> },

      // ── Chat Search & Analysis ────────────────────────────────────────────
      {
        path: '/discord',
        element: <Layout basePath="/discord" />,
        errorElement: <ErrorPage />,
        children: [
          { index: true, element: <Navigate to="/discord/search" replace /> },
          { path: 'search', element: <SearchPage /> },
          { path: 'search/users', element: <SearchPage /> },
          { path: 'search/users/:username', element: <SearchPage /> },
          { path: 'users', element: <UserSearchRedirect /> },
          { path: 'users/:username', element: <UserDetailRedirect /> },
          { path: 'bookmarks', element: <BookmarksPage /> },
          { path: 'coding', element: <CodingRedirect basePath="/discord" /> },
          { path: 'coding/manager', element: <CodingPage /> },
          { path: 'coding/table', element: <CodingPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'admin', element: <AdminPage /> },
        ],
      },

      // Backward-compat redirects for old un-prefixed routes
      { path: '/search', element: <Navigate to="/discord/search" replace /> },
      { path: '/bookmarks', element: <Navigate to="/discord/bookmarks" replace /> },
      { path: '/settings', element: <Navigate to="/discord/settings" replace /> },
      { path: '/admin', element: <Navigate to="/discord/admin" replace /> },
      // Backward-compat: old standalone Coding Manager module
      { path: '/coding', element: <Navigate to="/discord/coding" replace /> },
      { path: '/coding/bookmarks', element: <Navigate to="/discord/bookmarks" replace /> },
      { path: '/coding/manager', element: <Navigate to="/discord/coding/manager" replace /> },
      { path: '/coding/table', element: <Navigate to="/discord/coding/table" replace /> },
      { path: '/coding-manager/*', element: <Navigate to="/discord/coding" replace /> },

      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} future={{ v7_startTransition: true }} />
}
