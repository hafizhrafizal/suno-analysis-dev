import { NavLink, useLocation } from 'react-router-dom'
import ChatSearchPage from './ChatSearchPage'
import UserSearchPage from './UserSearchPage'

export default function SearchPage() {
  const location = useLocation()
  const isUsers = location.pathname.includes('/search/users') || location.pathname.includes('/users')

  const tabCls = ({ isActive }: { isActive: boolean }) =>
    `search-tab whitespace-nowrap${isActive ? ' tab-active' : ''}`

  return (
    <>
      <div className="max-w-5xl mx-auto px-3 sm:px-4 pt-4">
        <section className="bg-white rounded-2xl shadow p-3">
          <div className="flex border-b">
            <NavLink to="/discord/search" end className={tabCls}>
              Chat Search
            </NavLink>
            <NavLink
              to="/discord/search/users"
              className={() => `search-tab whitespace-nowrap${isUsers ? ' tab-active' : ''}`}
            >
              User Search
            </NavLink>
          </div>
        </section>
      </div>
      {isUsers ? <UserSearchPage /> : <ChatSearchPage />}
    </>
  )
}
