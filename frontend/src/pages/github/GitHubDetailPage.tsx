import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, streamEvents } from '../../api/client'

type Tab = 'overview' | 'commits' | 'issues' | 'pulls' | 'releases' | 'discussions' | 'forks'

interface Repo {
  id: string; owner: string; name: string; full_name: string
  description: string | null; html_url: string; stars: number; forks: number
  open_issues: number; language: string | null; is_private: boolean
  default_branch: string | null; created_at_gh: string | null
  updated_at_gh: string | null; fetched_at: string
}

interface PagedResult<T> { items: T[]; total: number; page: number; per_page: number }

interface Commit {
  id: string; sha: string; author_name: string | null; author_email: string | null
  author_login: string | null; message: string; committed_at: string | null; html_url: string | null
}

interface CommitDetail extends Commit {
  additions: number | null; deletions: number | null; changed_files: number | null
  files: { filename: string; status: string; additions: number; deletions: number; changes: number }[]
}

interface Comment {
  id: string; author_login: string | null; body: string
  created_at: string | null; html_url?: string | null
}

interface Issue {
  id: string; number: number; title: string; body: string | null; state: string
  author_login: string | null; labels: string[]; created_at: string | null
  closed_at: string | null; comments: number | null; html_url: string | null
}

interface PullRequest extends Issue { merged_at: string | null }

interface Release {
  id: string; tag_name: string; name: string | null; body: string | null
  is_draft: boolean; is_prerelease: boolean; author_login: string | null
  published_at: string | null; html_url: string | null
}

interface Discussion {
  id: string; number: number; title: string; body: string | null
  category: string | null; author_login: string | null
  created_at: string | null; comments: number | null; html_url: string | null
}

interface Fork {
  full_name: string; owner_login: string | null; html_url: string | null
  stars: number; forks: number; language: string | null
  description: string | null; created_at: string | null; updated_at: string | null
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function fmtDate(s: string | null | undefined) {
  if (!s) return '—'
  return s.slice(0, 10)
}

function Spinner() {
  return (
    <div className="flex justify-center py-10">
      <span className="animate-spin w-7 h-7 border-4 border-slate-600 border-t-transparent rounded-full" />
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="text-center py-10 text-gray-400 text-sm">{text}</div>
}

function StatBadge({ label, value, onClick }: {
  label: string; value: number | string; onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-center transition-colors w-full ${onClick ? 'hover:bg-slate-100 cursor-pointer' : 'cursor-default'}`}
    >
      <div className="text-xl font-bold text-slate-800">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </button>
  )
}

function Pagination({ page, total, perPage, onChange }: {
  page: number; total: number; perPage: number; onChange: (p: number) => void
}) {
  const pages = Math.ceil(total / perPage)
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-center gap-2 pt-4">
      <button onClick={() => onChange(page - 1)} disabled={page <= 1}
        className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-40 hover:bg-slate-50">‹ Prev</button>
      <span className="text-sm text-gray-500">
        Page {page} of {pages} <span className="text-gray-400">({total.toLocaleString()} total)</span>
      </span>
      <button onClick={() => onChange(page + 1)} disabled={page >= pages}
        className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-40 hover:bg-slate-50">Next ›</button>
    </div>
  )
}

// ── Thread / comment view ─────────────────────────────────────────────────────

function CommentBubble({ comment }: { comment: Comment }) {
  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <div className="bg-gray-50 border-b border-gray-200 px-4 py-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-700">
          {comment.author_login ? `@${comment.author_login}` : 'Unknown'}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400">{fmtDate(comment.created_at)}</span>
          {comment.html_url && (
            <a href={comment.html_url} target="_blank" rel="noopener noreferrer"
              className="text-xs text-slate-500 hover:text-slate-800 underline">↗</a>
          )}
        </div>
      </div>
      <div className="px-4 py-3 text-sm text-gray-700 whitespace-pre-wrap leading-relaxed bg-white">
        {comment.body || <span className="text-gray-400 italic">No content</span>}
      </div>
    </div>
  )
}

function ThreadLoader({ endpoint }: { endpoint: string }) {
  const { data: comments, isLoading, isError } = useQuery<Comment[]>({
    queryKey: ['gh-thread', endpoint],
    queryFn: () => apiFetch(endpoint),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
  if (isLoading) return (
    <div className="flex items-center gap-2 py-3 text-sm text-gray-400">
      <span className="animate-spin w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full" />
      Loading thread…
    </div>
  )
  if (isError) return (
    <p className="text-xs text-amber-600 py-2">
      Could not load comments (API may require a GitHub token, or feature not enabled on this repo).
    </p>
  )
  if (!comments?.length) return <p className="text-xs text-gray-400 py-2 italic">No comments.</p>
  return (
    <div className="mt-3 space-y-2">
      {comments.map(c => <CommentBubble key={c.id} comment={c} />)}
    </div>
  )
}

// ── Commit detail (lazy stats + files) ───────────────────────────────────────

function CommitDetailLoader({ repoId, sha }: { repoId: string; sha: string }) {
  const { data, isLoading, isError } = useQuery<CommitDetail>({
    queryKey: ['gh-commit-detail', repoId, sha],
    queryFn: () => apiFetch(`/github/repos/${repoId}/commits/${sha}`),
    retry: false,
    staleTime: Infinity,
  })
  if (isLoading) return (
    <div className="flex items-center gap-2 py-2 text-sm text-gray-400">
      <span className="animate-spin w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full" />
      Fetching stats from GitHub…
    </div>
  )
  if (isError || !data) return <p className="text-xs text-red-500 py-1">Could not load commit details.</p>
  return (
    <div className="mt-3 space-y-3">
      {(data.additions != null || data.deletions != null) && (
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          {data.additions != null && (
            <span className="text-green-700 bg-green-50 border border-green-200 px-2.5 py-1 rounded-lg">
              +{data.additions.toLocaleString()} additions
            </span>
          )}
          {data.deletions != null && (
            <span className="text-red-700 bg-red-50 border border-red-200 px-2.5 py-1 rounded-lg">
              −{data.deletions.toLocaleString()} deletions
            </span>
          )}
          {data.changed_files != null && (
            <span className="text-slate-600 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg">
              {data.changed_files} file{data.changed_files !== 1 ? 's' : ''} changed
            </span>
          )}
        </div>
      )}
      {data.files && data.files.length > 0 && (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <div className="bg-gray-50 border-b border-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Files changed ({data.files.length})
          </div>
          <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
            {data.files.map(f => (
              <li key={f.filename} className="px-3 py-2 flex items-center gap-3 text-xs font-mono">
                <span className={`shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                  f.status === 'added' ? 'bg-green-100 text-green-700' :
                  f.status === 'removed' ? 'bg-red-100 text-red-700' :
                  f.status === 'renamed' ? 'bg-yellow-100 text-yellow-700' :
                  'bg-slate-100 text-slate-600'
                }`}>{f.status}</span>
                <span className="flex-1 text-gray-700 truncate">{f.filename}</span>
                <span className="shrink-0 text-green-600 tabular-nums">+{f.additions}</span>
                <span className="shrink-0 text-red-500 tabular-nums">−{f.deletions}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── Commits tab ───────────────────────────────────────────────────────────────

const COMMITS_PER_PAGE = 50

function CommitsTab({ repoId }: { repoId: string }) {
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [expandedSha, setExpandedSha] = useState<string | null>(null)

  const { data, isLoading } = useQuery<PagedResult<Commit>>({
    // include per_page in key to avoid collision with stat queries
    queryKey: ['gh-commits', repoId, page, search, COMMITS_PER_PAGE],
    queryFn: () => apiFetch(
      `/github/repos/${repoId}/commits?page=${page}&per_page=${COMMITS_PER_PAGE}${search ? `&q=${encodeURIComponent(search)}` : ''}`
    ),
  })

  return (
    <div className="space-y-3">
      <form onSubmit={e => { e.preventDefault(); setPage(1); setSearch(q) }} className="flex gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search commit messages…"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400" />
        <button type="submit" className="px-4 py-2 bg-slate-700 text-white text-sm rounded-lg hover:bg-slate-800">Search</button>
      </form>
      {isLoading ? <Spinner /> : !data?.items.length ? <Empty text="No commits found." /> : (
        <>
          <div className="space-y-2">
            {data.items.map(c => {
              const isOpen = expandedSha === c.sha
              const firstLine = c.message.split('\n')[0]
              const rest = c.message.split('\n').slice(1).join('\n').trim()
              return (
                <div key={c.sha} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setExpandedSha(isOpen ? null : c.sha)}
                    className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900">{firstLine}</p>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500">
                          {c.author_login
                            ? <span className="font-medium text-slate-700">@{c.author_login}</span>
                            : c.author_name ? <span>{c.author_name}</span> : null}
                          <span className="text-gray-400">{fmtDate(c.committed_at)}</span>
                          <code className="font-mono text-gray-400 bg-gray-100 px-1 rounded">{c.sha.slice(0, 7)}</code>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {c.html_url && (
                          <a href={c.html_url} target="_blank" rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="text-xs text-slate-500 hover:text-slate-800 underline">GitHub</a>
                        )}
                        <svg className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-gray-100 px-4 py-4 bg-gray-50 space-y-3">
                      {rest && (
                        <pre className="text-xs text-gray-600 whitespace-pre-wrap font-mono bg-white border border-gray-200 rounded-lg p-3 max-h-48 overflow-y-auto">
                          {c.message}
                        </pre>
                      )}
                      <CommitDetailLoader repoId={repoId} sha={c.sha} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <Pagination page={page} total={data.total} perPage={data.per_page} onChange={setPage} />
        </>
      )}
    </div>
  )
}

// ── Issue / PR row ────────────────────────────────────────────────────────────

function IssueRow({ item, showMerged, commentEndpoint }: {
  item: Issue | PullRequest
  showMerged?: boolean
  commentEndpoint: string
}) {
  const [open, setOpen] = useState(false)
  const pr = item as PullRequest
  const isMerged = !!(showMerged && pr.merged_at)
  const stateColor = isMerged
    ? 'bg-purple-100 text-purple-700'
    : item.state === 'open' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
  const stateLabel = isMerged ? 'merged' : item.state
  const labels = Array.isArray(item.labels) ? item.labels as string[] : []

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(v => !v)}
        className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2 flex-wrap">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 mt-0.5 ${stateColor}`}>
                {stateLabel}
              </span>
              <span className="text-sm font-medium text-gray-900 leading-snug">#{item.number} {item.title}</span>
            </div>
            {labels.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {labels.map(l => (
                  <span key={l} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold">{l}</span>
                ))}
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500">
              {item.author_login && <span>by @{item.author_login}</span>}
              <span>{fmtDate(item.created_at)}</span>
              {item.closed_at && <span>· closed {fmtDate(item.closed_at)}</span>}
              {isMerged && <span>· merged {fmtDate(pr.merged_at)}</span>}
              {(item.comments ?? 0) > 0 && (
                <span className="font-medium text-slate-600">
                  · {item.comments} comment{item.comments !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {item.html_url && (
              <a href={item.html_url} target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="text-xs text-slate-500 hover:text-slate-800 underline">GitHub</a>
            )}
            <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-gray-100 px-4 py-4 bg-gray-50 space-y-3">
          {item.body && (
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="bg-white border-b border-gray-100 px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-700">
                  @{item.author_login || 'Unknown'}{' '}
                  <span className="font-normal text-gray-400">opened this</span>
                </span>
                <span className="text-xs text-gray-400">{fmtDate(item.created_at)}</span>
              </div>
              <div className="px-4 py-3 text-sm text-gray-700 whitespace-pre-wrap leading-relaxed bg-white">
                {item.body}
              </div>
            </div>
          )}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Comments</p>
            <ThreadLoader endpoint={commentEndpoint} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Issues tab ────────────────────────────────────────────────────────────────

const ISSUES_PER_PAGE = 50

function IssuesTab({ repoId }: { repoId: string }) {
  const [page, setPage] = useState(1)
  const [stateFilter, setStateFilter] = useState('all')
  const { data, isLoading } = useQuery<PagedResult<Issue>>({
    queryKey: ['gh-issues', repoId, page, stateFilter, ISSUES_PER_PAGE],
    queryFn: () => apiFetch(
      `/github/repos/${repoId}/issues?page=${page}&per_page=${ISSUES_PER_PAGE}&state=${stateFilter}`
    ),
  })
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(['all', 'open', 'closed'] as const).map(s => (
          <button key={s} onClick={() => { setStateFilter(s); setPage(1) }}
            className={`px-3 py-1 text-xs font-semibold rounded-full border transition-colors ${
              stateFilter === s ? 'bg-slate-700 text-white border-slate-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      {isLoading ? <Spinner /> : !data?.items.length
        ? <Empty text={`No ${stateFilter === 'all' ? '' : stateFilter + ' '}issues found. Re-analyze the repo if you expect issues.`} />
        : (
          <>
            {data.items.map(iss => (
              <IssueRow key={iss.id} item={iss}
                commentEndpoint={`/github/repos/${repoId}/issues/${iss.number}/comments`} />
            ))}
            <Pagination page={page} total={data.total} perPage={data.per_page} onChange={setPage} />
          </>
        )}
    </div>
  )
}

// ── Pull Requests tab ─────────────────────────────────────────────────────────

const PULLS_PER_PAGE = 50

function PullsTab({ repoId }: { repoId: string }) {
  const [page, setPage] = useState(1)
  const [stateFilter, setStateFilter] = useState('all')
  const { data, isLoading } = useQuery<PagedResult<PullRequest>>({
    queryKey: ['gh-pulls', repoId, page, stateFilter, PULLS_PER_PAGE],
    queryFn: () => apiFetch(
      `/github/repos/${repoId}/pulls?page=${page}&per_page=${PULLS_PER_PAGE}&state=${stateFilter}`
    ),
  })
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(['all', 'open', 'closed'] as const).map(s => (
          <button key={s} onClick={() => { setStateFilter(s); setPage(1) }}
            className={`px-3 py-1 text-xs font-semibold rounded-full border transition-colors ${
              stateFilter === s ? 'bg-slate-700 text-white border-slate-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      {isLoading ? <Spinner /> : !data?.items.length
        ? <Empty text={`No ${stateFilter === 'all' ? '' : stateFilter + ' '}pull requests found. Re-analyze the repo if you expect PRs.`} />
        : (
          <>
            {data.items.map(pr => (
              <IssueRow key={pr.id} item={pr} showMerged
                commentEndpoint={`/github/repos/${repoId}/pulls/${pr.number}/comments`} />
            ))}
            <Pagination page={page} total={data.total} perPage={data.per_page} onChange={setPage} />
          </>
        )}
    </div>
  )
}

// ── Releases tab ──────────────────────────────────────────────────────────────

const RELEASES_PER_PAGE = 50

function ReleasesTab({ repoId }: { repoId: string }) {
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data, isLoading } = useQuery<PagedResult<Release>>({
    queryKey: ['gh-releases', repoId, page, RELEASES_PER_PAGE],
    queryFn: () => apiFetch(`/github/repos/${repoId}/releases?page=${page}&per_page=${RELEASES_PER_PAGE}`),
  })
  return (
    <div className="space-y-2">
      {isLoading ? <Spinner /> : !data?.items.length ? <Empty text="No releases found." /> : (
        <>
          {data.items.map(rel => {
            const isOpen = expanded === rel.tag_name
            return (
              <div key={rel.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <button onClick={() => setExpanded(isOpen ? null : rel.tag_name)}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-semibold text-slate-800">{rel.tag_name}</span>
                        {rel.name && rel.name !== rel.tag_name && (
                          <span className="text-sm text-gray-600">{rel.name}</span>
                        )}
                        {rel.is_prerelease && (
                          <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Pre-release</span>
                        )}
                        {rel.is_draft && (
                          <span className="text-[10px] font-bold bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Draft</span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-500 flex gap-2">
                        {rel.author_login && <span>by @{rel.author_login}</span>}
                        <span>{fmtDate(rel.published_at)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {rel.html_url && (
                        <a href={rel.html_url} target="_blank" rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-xs text-slate-500 hover:text-slate-800 underline">GitHub</a>
                      )}
                      <svg className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                </button>
                {isOpen && rel.body && (
                  <div className="border-t border-gray-100 px-4 py-4 bg-gray-50">
                    <pre className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed font-sans">{rel.body}</pre>
                  </div>
                )}
              </div>
            )
          })}
          <Pagination page={page} total={data.total} perPage={data.per_page} onChange={setPage} />
        </>
      )}
    </div>
  )
}

// ── Discussions tab ───────────────────────────────────────────────────────────

const DISCUSSIONS_PER_PAGE = 50

function DiscussionsTab({ repoId }: { repoId: string }) {
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)
  const { data, isLoading, isError } = useQuery<PagedResult<Discussion>>({
    queryKey: ['gh-discussions', repoId, page, DISCUSSIONS_PER_PAGE],
    queryFn: () => apiFetch(`/github/repos/${repoId}/discussions?page=${page}&per_page=${DISCUSSIONS_PER_PAGE}`),
    retry: false,
  })
  return (
    <div className="space-y-2">
      {isLoading ? <Spinner />
        : (isError || !data?.items.length)
          ? <Empty text="No discussions found. Discussions may not be enabled on this repo, or a GitHub token may be required." />
          : (
            <>
              {data.items.map(d => {
                const isOpen = expanded === d.number
                return (
                  <div key={d.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                    <button onClick={() => setExpanded(isOpen ? null : d.number)}
                      className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-gray-900 text-sm">#{d.number} {d.title}</span>
                            {d.category && (
                              <span className="text-[10px] font-semibold bg-teal-100 text-teal-700 px-2 py-0.5 rounded-full">{d.category}</span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-gray-500">
                            {d.author_login && <span>@{d.author_login}</span>}
                            <span>{fmtDate(d.created_at)}</span>
                            {(d.comments ?? 0) > 0 && (
                              <span className="font-medium text-slate-600">· {d.comments} comment{d.comments !== 1 ? 's' : ''}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {d.html_url && (
                            <a href={d.html_url} target="_blank" rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="text-xs text-slate-500 hover:text-slate-800 underline">GitHub</a>
                          )}
                          <svg className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                            fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="border-t border-gray-100 px-4 py-4 bg-gray-50 space-y-3">
                        {d.body && (
                          <div className="border border-gray-200 rounded-xl overflow-hidden">
                            <div className="bg-white border-b border-gray-100 px-4 py-2 flex items-center justify-between">
                              <span className="text-xs font-semibold text-gray-700">@{d.author_login || 'Unknown'}</span>
                              <span className="text-xs text-gray-400">{fmtDate(d.created_at)}</span>
                            </div>
                            <div className="px-4 py-3 text-sm text-gray-700 whitespace-pre-wrap leading-relaxed bg-white">{d.body}</div>
                          </div>
                        )}
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Comments</p>
                          <ThreadLoader endpoint={`/github/repos/${repoId}/discussions/${d.number}/comments`} />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              <Pagination page={page} total={data.total} perPage={data.per_page} onChange={setPage} />
            </>
          )}
    </div>
  )
}

// ── Forks tab ─────────────────────────────────────────────────────────────────

const FORKS_PER_PAGE = 50

type ForkSort = 'stars' | 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc'
type ForkActivity = 'all' | 'active' | 'inactive'

const SORT_OPTIONS: { key: ForkSort; label: string }[] = [
  { key: 'stars', label: 'Most starred' },
  { key: 'updated-desc', label: 'Latest updated' },
  { key: 'updated-asc', label: 'Oldest updated' },
  { key: 'created-desc', label: 'Latest created' },
  { key: 'created-asc', label: 'Oldest created' },
]

const ACTIVITY_OPTIONS: { key: ForkActivity; label: string }[] = [
  { key: 'all', label: 'All forks' },
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
]

function ForksTab({ repoId }: { repoId: string }) {
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<ForkSort>('stars')
  const [activity, setActivity] = useState<ForkActivity>('all')
  const [minStars, setMinStars] = useState('')
  const [sortOpen, setSortOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeProgress, setAnalyzeProgress] = useState('')
  const [notif, setNotif] = useState<{ type: 'success' | 'error'; message: string; link?: string; linkLabel?: string } | null>(null)
  const qc = useQueryClient()

  // Reset page when filters change
  const applyFilter = (fn: () => void) => {
    fn()
    setPage(1)
    setSortOpen(false)
    setActivityOpen(false)
  }

  // Parse sort key into sort + order params
  const sortKey = sort.includes('-') ? sort.split('-')[0] : sort
  const sortOrder = sort.includes('-') ? sort.split('-')[1] : 'desc'

  const queryParams = new URLSearchParams()
  queryParams.set('page', String(page))
  queryParams.set('per_page', String(FORKS_PER_PAGE))
  queryParams.set('sort', sortKey)
  queryParams.set('order', sortOrder)
  if (activity === 'active') queryParams.set('active_months', '12')
  if (activity === 'inactive') queryParams.set('inactive_months', '12')
  if (minStars.trim()) queryParams.set('min_stars', minStars.trim())

  const { data, isLoading, isError } = useQuery<PagedResult<Fork>>({
    queryKey: ['gh-forks', repoId, page, FORKS_PER_PAGE, sort, activity, minStars],
    queryFn: () => apiFetch(`/github/repos/${repoId}/forks?${queryParams.toString()}`),
  })

  const handleAnalyzeFork = (fullName: string) => {
    setAnalyzing(true)
    setAnalyzeProgress('Starting…')
    setNotif(null)
    let doneResult: any = null
    streamEvents(
      '/github/repos',
      { url: fullName },
      (ev) => {
        if (ev.type === 'progress') setAnalyzeProgress(ev.message as string)
        if (ev.type === 'error') {
          setNotif({ type: 'error', message: (ev.message as string) || 'Fetch failed' })
          setAnalyzing(false); setAnalyzeProgress('')
        }
        if (ev.type === 'done') {
          doneResult = ev.result
          qc.invalidateQueries({ queryKey: ['github-repos'] })
        }
      },
      () => {
        setAnalyzing(false)
        setAnalyzeProgress('')
        if (doneResult) {
          setNotif({
            type: 'success',
            message: `${fullName} fetched successfully!`,
            link: `/github/${(doneResult as any)?.id}`,
            linkLabel: `View ${(doneResult as any)?.full_name || fullName} →`,
          })
        }
      },
      (err) => {
        setNotif({ type: 'error', message: err.message })
        setAnalyzing(false); setAnalyzeProgress('')
      },
    )
  }

  const ret = (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Sort dropdown */}
        <div className="relative">
          <button
            onClick={() => { setSortOpen(o => !o); setActivityOpen(false) }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
            </svg>
            {SORT_OPTIONS.find(o => o.key === sort)?.label ?? 'Sort'}
          </button>
          {sortOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setSortOpen(false)} />
              <div className="absolute left-0 top-8 z-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-48">
                {SORT_OPTIONS.map(o => (
                  <button
                    key={o.key}
                    onClick={() => applyFilter(() => setSort(o.key))}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-slate-50 ${
                      sort === o.key ? 'font-semibold text-slate-700' : 'text-gray-600'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Activity filter */}
        <div className="relative">
          <button
            onClick={() => { setActivityOpen(o => !o); setSortOpen(false) }}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              activity !== 'all'
                ? 'border-slate-400 bg-slate-50 text-slate-700 font-semibold'
                : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            {ACTIVITY_OPTIONS.find(o => o.key === activity)?.label ?? 'Activity'}
          </button>
          {activityOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setActivityOpen(false)} />
              <div className="absolute left-0 top-8 z-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 w-32">
                {ACTIVITY_OPTIONS.map(o => (
                  <button
                    key={o.key}
                    onClick={() => applyFilter(() => setActivity(o.key))}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-slate-50 ${
                      activity === o.key ? 'font-semibold text-slate-700' : 'text-gray-600'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Min stars input */}
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min="0"
            placeholder="Min ★"
            value={minStars}
            onChange={e => setMinStars(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && setPage(1)}
            onBlur={() => setPage(1)}
            className="w-20 text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-600 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-transparent"
          />
        </div>

        {/* Total count */}
        {data && (
          <span className="text-xs text-gray-400 ml-auto">
            {data.total.toLocaleString()} fork{data.total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Notification popup */}
      {notif && (
        <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl text-sm ${
          notif.type === 'success'
            ? 'bg-green-50 border border-green-200 text-green-800'
            : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0">{notif.type === 'success' ? '✓' : '✕'}</span>
            <span className="truncate">{notif.message}</span>
            {notif.link && (
              <a href={notif.link} className="font-semibold hover:underline whitespace-nowrap shrink-0">
                {notif.linkLabel || 'View →'}
              </a>
            )}
          </div>
          <button onClick={() => setNotif(null)} className="shrink-0 text-current opacity-50 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      {/* Fork list */}
      {isLoading ? <Spinner />
        : (isError || !data?.items.length)
          ? <Empty text="No forks match the current filters." />
          : (
            <>
              {data.items.map(fork => (
                <div key={fork.full_name} className="bg-white border border-gray-200 rounded-xl px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <a href={fork.html_url ?? '#'} target="_blank" rel="noopener noreferrer"
                          className="font-semibold text-slate-700 hover:underline text-sm">{fork.full_name}</a>
                        {fork.language && (
                          <span className="text-[10px] font-semibold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{fork.language}</span>
                        )}
                      </div>
                      {fork.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{fork.description}</p>
                      )}
                      <div className="mt-1 flex flex-wrap gap-3 text-xs text-gray-500">
                        <span>⭐ {fork.stars.toLocaleString()}</span>
                        <span>🔀 {fork.forks.toLocaleString()}</span>
                        {fork.created_at && <span>forked {fmtDate(fork.created_at)}</span>}
                        {fork.updated_at && fork.updated_at !== fork.created_at && (
                          <span className="text-gray-400">updated {fmtDate(fork.updated_at)}</span>
                        )}
                      </div>
                    </div>
                    {fork.html_url && (
                      <a href={fork.html_url} target="_blank" rel="noopener noreferrer"
                        className="shrink-0 px-3 py-1.5 text-xs font-semibold border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-700 transition-colors">
                        View ↗
                      </a>
                    )}
                    <button
                      onClick={() => handleAnalyzeFork(fork.full_name)}
                      disabled={analyzing}
                      className="shrink-0 px-3 py-1.5 text-xs font-semibold border border-slate-300 rounded-lg hover:bg-slate-700 hover:text-white text-slate-600 transition-colors disabled:opacity-50"
                    >
                      {analyzing ? (
                        <span className="flex items-center gap-1.5">
                          <span className="animate-spin w-3 h-3 border-2 border-current border-t-transparent rounded-full" />
                          <span className="max-w-[120px] truncate">{analyzeProgress}</span>
                        </span>
                      ) : 'Fetch detail'}
                    </button>
                  </div>
                </div>
              ))}
              <Pagination page={page} total={data.total} perPage={data.per_page} onChange={setPage} />
            </>
          )}
    </div>
  )
  return ret
}

// ── Re-analyze button ─────────────────────────────────────────────────────────

function ReanalyzeButton({ repoId }: { repoId: string }) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [progress, setProgress] = useState('')

  const handleReanalyze = () => {
    setFetching(true)
    setProgress('Connecting…')
    const stop = streamEvents(
      `/github/repos/${repoId}/reanalyze`,
      {},
      (ev) => {
        if (ev.type === 'progress') setProgress(ev.message as string)
        if (ev.type === 'error') {
          setProgress('')
          setFetching(false)
          setConfirm(false)
          stop()
        }
        if (ev.type === 'done') {
          qc.invalidateQueries({ queryKey: ['gh-repo', repoId] })
          qc.invalidateQueries({ queryKey: ['gh-forks', repoId] })
          qc.invalidateQueries({ queryKey: ['gh-commits', repoId] })
          qc.invalidateQueries({ queryKey: ['gh-issues', repoId] })
          qc.invalidateQueries({ queryKey: ['gh-pulls', repoId] })
          qc.invalidateQueries({ queryKey: ['gh-releases', repoId] })
          qc.invalidateQueries({ queryKey: ['gh-discussions', repoId] })
          setProgress('')
          setFetching(false)
          setConfirm(false)
          stop()
        }
      },
      () => { setFetching(false); setProgress(''); setConfirm(false) },
      () => { setFetching(false); setProgress(''); setConfirm(false) },
      'POST',
    )
  }

  if (fetching) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-600 shrink-0">
        <span className="animate-spin w-3.5 h-3.5 border-2 border-slate-400 border-t-transparent rounded-full shrink-0" />
        <span className="truncate max-w-[200px]">{progress}</span>
      </div>
    )
  }

  if (confirm) {
    return (
      <span className="flex items-center gap-1.5 text-xs shrink-0">
        <span className="text-amber-600">Re-fetch all data?</span>
        <button onClick={handleReanalyze} className="text-amber-700 font-semibold hover:underline">Yes</button>
        <button onClick={() => setConfirm(false)} className="text-gray-400 hover:underline">No</button>
      </span>
    )
  }

  return (
    <button
      onClick={() => setConfirm(true)}
      className="px-3 py-1.5 text-xs font-semibold border border-amber-300 rounded-lg hover:bg-amber-50 text-amber-700 transition-colors flex items-center gap-1 shrink-0"
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      Re-fetch
    </button>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'commits', label: 'Commits' },
  { id: 'issues', label: 'Issues' },
  { id: 'pulls', label: 'Pull Requests' },
  { id: 'releases', label: 'Releases' },
  { id: 'discussions', label: 'Discussions' },
  { id: 'forks', label: 'Forks' },
]

export default function GitHubDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('overview')

  const { data: repo, isLoading, isError } = useQuery<Repo>({
    queryKey: ['gh-repo', id],
    queryFn: () => apiFetch(`/github/repos/${id}`),
    enabled: !!id,
  })

  // Stats queries use 'gh-stat-XXX' prefix to avoid key collision with tab queries
  const { data: commitStats } = useQuery<PagedResult<Commit>>({
    queryKey: ['gh-stat-commits', id],
    queryFn: () => apiFetch(`/github/repos/${id}/commits?page=1&per_page=1`),
    enabled: !!id,
  })
  const { data: issueStats } = useQuery<PagedResult<Issue>>({
    queryKey: ['gh-stat-issues', id],
    queryFn: () => apiFetch(`/github/repos/${id}/issues?page=1&per_page=1&state=all`),
    enabled: !!id,
  })
  const { data: prStats } = useQuery<PagedResult<PullRequest>>({
    queryKey: ['gh-stat-pulls', id],
    queryFn: () => apiFetch(`/github/repos/${id}/pulls?page=1&per_page=1&state=all`),
    enabled: !!id,
  })
  const { data: releaseStats } = useQuery<PagedResult<Release>>({
    queryKey: ['gh-stat-releases', id],
    queryFn: () => apiFetch(`/github/repos/${id}/releases?page=1&per_page=1`),
    enabled: !!id,
  })
  const { data: forkStats } = useQuery<PagedResult<Fork>>({
    queryKey: ['gh-stat-forks', id],
    queryFn: () => apiFetch(`/github/repos/${id}/forks?page=1&per_page=1`),
    enabled: !!id,
  })

  if (isLoading) return (
    <div className="flex justify-center py-20">
      <span className="animate-spin w-10 h-10 border-4 border-slate-600 border-t-transparent rounded-full" />
    </div>
  )
  if (isError || !repo) return (
    <div className="max-w-3xl mx-auto px-4 py-12 text-center text-red-600 text-sm">
      Repository not found.
      <button onClick={() => navigate('/github')} className="ml-3 text-slate-600 underline">Back</button>
    </div>
  )

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">

      {/* Repo header */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow p-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
            <svg className="w-6 h-6 text-slate-600" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900">{repo.full_name}</h1>
              {repo.is_private && (
                <span className="text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Private</span>
              )}
              {repo.language && (
                <span className="text-xs font-semibold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{repo.language}</span>
              )}
            </div>
            {repo.description && <p className="mt-1 text-gray-500 text-sm">{repo.description}</p>}
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
              <span>⭐ {repo.stars.toLocaleString()}</span>
              <span>🔀 {repo.forks.toLocaleString()} forks</span>
              <span>{repo.open_issues.toLocaleString()} open issues</span>
              {repo.default_branch && <span>Branch: {repo.default_branch}</span>}
              {repo.created_at_gh && <span>Created {fmtDate(repo.created_at_gh)}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ReanalyzeButton repoId={repo.id} />
            <a href={repo.html_url} target="_blank" rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs font-semibold border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-700 transition-colors">
              GitHub ↗
            </a>
          </div>
        </div>

        {/* Clickable stat badges jump to tab */}
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatBadge label="Commits" value={commitStats?.total ?? '—'} onClick={() => setTab('commits')} />
          <StatBadge label="Issues" value={issueStats?.total ?? '—'} onClick={() => setTab('issues')} />
          <StatBadge label="Pull Requests" value={prStats?.total ?? '—'} onClick={() => setTab('pulls')} />
          <StatBadge label="Releases" value={releaseStats?.total ?? '—'} onClick={() => setTab('releases')} />
          <StatBadge label="Forks (stored)" value={forkStats?.total ?? '—'} onClick={() => setTab('forks')} />
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow">
        <div className="border-b border-gray-200 px-4 pt-4">
          <div className="flex gap-0.5 overflow-x-auto">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-4 py-2 text-sm font-semibold rounded-t-lg transition-colors whitespace-nowrap ${
                  tab === t.id ? 'bg-slate-700 text-white' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                }`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-5">
          {tab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-3">Repository Info</h3>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between"><dt className="text-gray-500">Owner</dt><dd className="font-medium">{repo.owner}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Name</dt><dd className="font-medium">{repo.name}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Default branch</dt><dd className="font-mono text-xs">{repo.default_branch ?? '—'}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Language</dt><dd>{repo.language ?? '—'}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Visibility</dt><dd>{repo.is_private ? 'Private' : 'Public'}</dd></div>
                  </dl>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-3">Activity Summary</h3>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between"><dt className="text-gray-500">Stars</dt><dd className="font-semibold">{repo.stars.toLocaleString()}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Forks (GitHub)</dt><dd className="font-semibold">{repo.forks.toLocaleString()}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Open Issues</dt><dd className="font-semibold">{repo.open_issues.toLocaleString()}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Created</dt><dd>{fmtDate(repo.created_at_gh)}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Last updated (GH)</dt><dd>{fmtDate(repo.updated_at_gh)}</dd></div>
                  </dl>
                </div>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700">
                <strong>Note:</strong> Data was fetched on {repo.fetched_at.slice(0, 16)} UTC.
                Commit stats and thread comments load on-demand when you expand an item.
                Issues and forks may be empty if the repo was analyzed before those features were added — re-analyze from the list page to refresh all data.
              </div>
            </div>
          )}
          {tab === 'commits' && id && <CommitsTab repoId={id} />}
          {tab === 'issues' && id && <IssuesTab repoId={id} />}
          {tab === 'pulls' && id && <PullsTab repoId={id} />}
          {tab === 'releases' && id && <ReleasesTab repoId={id} />}
          {tab === 'discussions' && id && <DiscussionsTab repoId={id} />}
          {tab === 'forks' && id && <ForksTab repoId={id} />}
        </div>
      </div>
    </div>
  )
}
