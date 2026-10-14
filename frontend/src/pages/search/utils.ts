// Shared utility functions for the Search / Users split

import { apiFetch } from '../../api/client'
import { buildEmotionResult } from '../../lib/analysisCache'
import type { Message, UserInRange, EmotionResult, EmotionPerMessage, EmotionTimeline } from '../../types'
import type { FilterMode, EngagementInfo, EngagementLevel, MsgEmotion } from './types'

// ─── Date / formatting helpers ────────────────────────────────────────────────

// Discord timestamps are stored as UTC strings ("YYYY-MM-DD HH:MM:SS" or ISO).
// Parse as UTC and display in the browser's local timezone with seconds + tz abbrev.
export function formatMsgDate(raw: string | undefined): string {
  if (!raw) return ''
  const normalized = raw.trim().replace(' ', 'T')
  const iso = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : normalized + 'Z'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return raw.slice(0, 19).replace('T', ' ')
  return d.toLocaleString('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short', hour12: false,
  })
}

// Returns the Monday date string (YYYY-MM-DD) for any date
export function getMondayKey(dateStr: string): string {
  const d = new Date(dateStr)
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}

export function mondayKey(iso: string): string {
  const d = new Date(iso)
  const diff = (d.getUTCDay() + 6) % 7
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff))
  return mon.toISOString().slice(0, 10)
}

// ─── Heatmap coloring ─────────────────────────────────────────────────────────

export function heatmapColor(positive: number, negative: number, neutral: number, maxCount: number): string {
  const total = positive + negative + neutral
  if (total === 0) return '#f3f4f6'
  const score = (positive - negative) / total
  const alpha = Math.min(0.18 + (total / maxCount) * 0.72, 0.92)
  if (score > 0.12) return `rgba(16,185,129,${alpha.toFixed(2)})`
  if (score < -0.12) return `rgba(244,63,94,${alpha.toFixed(2)})`
  return `rgba(107,114,128,${alpha.toFixed(2)})`
}

// ─── Client-side filter helpers ───────────────────────────────────────────────

function fuzzyMatch(text: string, pattern: string): boolean {
  let pi = 0
  const lText = text.toLowerCase()
  const lPat = pattern.toLowerCase()
  for (let i = 0; i < lText.length && pi < lPat.length; i++) {
    if (lText[i] === lPat[pi]) pi++
  }
  return pi === lPat.length
}

export function applyExactFilter(messages: Message[], term: string): Message[] {
  if (!term.trim()) return messages
  const words = term.trim().toLowerCase().split(/\s+/)
  return messages.filter((m) => {
    const lc = m.content.toLowerCase()
    return words.every((w) => lc.includes(w))
  })
}

export function applyAnyFilter(messages: Message[], term: string): Message[] {
  if (!term.trim()) return messages
  const words = term.trim().toLowerCase().split(/\s+/)
  return messages.filter((m) => {
    const lc = m.content.toLowerCase()
    return words.some((w) => lc.includes(w))
  })
}

export function applyFuzzyFilter(messages: Message[], term: string): Message[] {
  if (!term.trim()) return messages
  const words = term.trim().split(/\s+/)
  return messages.filter((m) =>
    words.every((w) => fuzzyMatch(m.content, w))
  )
}

export function computeFilterTokens(mode: FilterMode, term: string): string[] {
  if (!term.trim()) return []
  const words = term.trim().split(/\s+/).filter(Boolean)
  if (mode === 'exact') {
    return words.length > 1 ? [term.trim(), ...words] : [term.trim()]
  }
  if (mode === 'any' || mode === 'fuzzy') {
    return words
  }
  // semantic: no highlighting
  return []
}

// ─── Engagement analysis helpers ─────────────────────────────────────────────

export function daysBetween(dateA: string, dateB: string): number {
  return Math.round((new Date(dateB).getTime() - new Date(dateA).getTime()) / 86400000)
}

export function deriveThresholds(windowDays: number) {
  const w = Math.max(14, windowDays)
  const wk = w / 7
  const extraWks = Math.max(0, wk - 7)
  return {
    minMessages:       Math.max(5,  Math.round(wk * 1.0)),
    activeMinMessages: Math.max(15, Math.round(wk * 3.0)),
    minAvgWords:       3,
    minPctWeeks:   Math.min(20, Math.round(12 + extraWks * 0.10)),
    activePctWeeks: 40,
    activeMinWeeks: Math.max(3, Math.ceil(wk * 0.12)),
    silenceDays: Math.min(120, Math.max(21, Math.round(w * 0.28))),
  }
}

export function classifyEngagement(u: UserInRange, filterStart: string, filterEnd: string): EngagementInfo {
  const windowDays = filterStart ? Math.max(14, daysBetween(filterStart, filterEnd)) : 90
  const windowWeeks = windowDays / 7
  const pctWeeks = windowWeeks > 0 ? Math.round(((u.weeks_active ?? 0) / windowWeeks) * 100) : 0
  const msgFloor = 20 * Math.ceil(windowWeeks * 0.5)
  const medFloor = Math.ceil(msgFloor / 4)
  let level: EngagementLevel
  if (pctWeeks >= 50 && u.total_messages >= msgFloor) level = 'high'
  else if (pctWeeks < 20 || u.total_messages < medFloor) level = 'low'
  else level = 'medium'
  return { level, pctWeeks }
}

export function classifyEngagementSingle(u: UserInRange, filterStart: string, filterEnd: string): EngagementInfo {
  const windowDays = filterStart ? Math.max(14, daysBetween(filterStart, filterEnd)) : 90
  const windowWeeks = windowDays / 7
  const pctWeeks = windowWeeks > 0 ? Math.round(((u.weeks_active ?? 0) / windowWeeks) * 100) : 0
  const msgFloor = 20 * Math.ceil(windowWeeks * 0.5)
  const medFloor = Math.ceil(msgFloor / 4)
  let level: EngagementLevel
  if (pctWeeks >= 50 && u.total_messages >= msgFloor) level = 'high'
  else if (pctWeeks < 20 || u.total_messages < medFloor) level = 'low'
  else level = 'medium'
  return { level, pctWeeks }
}

// ─── Shared session-storage helpers ──────────────────────────────────────────

export function ssGet<T>(key: string, fallback: T): T {
  try { const v = sessionStorage.getItem(key); return v !== null ? (JSON.parse(v) as T) : fallback } catch { return fallback }
}
export function ssSet(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)) } catch {}
}

export async function fetchMsgEmotionsBatched(
  uuids: string[],
  batchSize = 500,
): Promise<Record<string, MsgEmotion>> {
  const unique = Array.from(new Set(uuids.filter(Boolean)))
  const merged: Record<string, MsgEmotion> = {}
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize)
    const data = await apiFetch<Record<string, MsgEmotion>>('/messages/emotions', {
      method: 'POST',
      body: JSON.stringify({ msg_uuids: batch }),
    })
    Object.assign(merged, data)
  }
  return merged
}

// ─── User-in-range derivation ─────────────────────────────────────────────────

export function deriveUserInRange(username: string, messages: Message[]): UserInRange {
  if (messages.length === 0) return { username, total_messages: 0 }
  const dates = messages.map(m => m.date?.slice(0, 10) ?? '').filter(Boolean).sort()
  const total_words = messages.reduce(
    (sum, m) => sum + m.content.split(/\s+/).filter(Boolean).length, 0
  )
  const weekSet = new Set(messages.map(m => (m.date ? mondayKey(m.date) : '')).filter(Boolean))
  return {
    username,
    total_messages: messages.length,
    first_date: dates[0],
    last_date: dates[dates.length - 1],
    avg_words: Math.round((total_words / messages.length) * 10) / 10,
    weeks_active: weekSet.size,
    is_suno_team: messages.some(
      m => m.is_suno_team === 'True' || m.is_suno_team === true || m.is_suno_team === '1'
    ),
  }
}

// ─── Emotion analysis helpers ─────────────────────────────────────────────────

export function mergeEmotionResults(a: EmotionResult, b: EmotionResult): EmotionResult {
  const perMessage = [...a.per_message, ...b.per_message]
  const sentCounts = { positive: 0, negative: 0, neutral: 0 }
  for (const m of perMessage) sentCounts[m.sentiment]++
  const total = perMessage.length || 1
  const sentiment_ratio = {
    positive: sentCounts.positive / total,
    negative: sentCounts.negative / total,
    neutral: sentCounts.neutral / total,
  }
  const emotionMap = new Map<string, number>()
  for (const m of perMessage) {
    if (m.top_emotions.length > 0) {
      const dominant = m.top_emotions[0].label
      emotionMap.set(dominant, (emotionMap.get(dominant) ?? 0) + 1)
    }
  }
  const top_emotions = [...emotionMap.entries()]
    .map(([label, score]) => ({ label, score }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 10)
  const timelineMap = new Map<string, EmotionTimeline>()
  for (const t of [...a.summary.timeline, ...b.summary.timeline]) {
    const ex = timelineMap.get(t.period)
    if (ex) {
      timelineMap.set(t.period, {
        period: t.period,
        positive: ex.positive + t.positive,
        negative: ex.negative + t.negative,
        neutral: ex.neutral + t.neutral,
        count: ex.count + t.count,
      })
    } else {
      timelineMap.set(t.period, { ...t })
    }
  }
  const timeline = [...timelineMap.values()].sort((x, y) => x.period.localeCompare(y.period))
  return {
    per_message: perMessage,
    summary: { sentiment_ratio, top_emotions, timeline },
    total_messages: a.total_messages + b.total_messages,
    analyzed_messages: a.analyzed_messages + b.analyzed_messages,
  }
}

export async function fetchStoredEmotionFromDB(
  uuids: string[],
  dateByUuid: Map<string, string>,
  totalCount: number,
): Promise<EmotionResult | null> {
  if (uuids.length === 0) return null
  try {
    const resp = await fetchMsgEmotionsBatched(uuids)
    const perMessage: EmotionPerMessage[] = uuids
      .filter(uuid => resp[uuid])
      .map(uuid => ({
        msg_uuid: uuid,
        date: dateByUuid.get(uuid) ?? '',
        sentiment: resp[uuid].sentiment as 'positive' | 'negative' | 'neutral',
        top_emotions: resp[uuid].top_emotions,
      }))
    if (perMessage.length === 0) return null
    const result = buildEmotionResult(perMessage)
    result.total_messages = totalCount
    return result
  } catch {
    return null
  }
}

// ─── Chart / export helpers ───────────────────────────────────────────────────

export function downloadChartAsPNG(container: HTMLElement | null, filename: string): void {
  if (!container) return
  const svg = container.querySelector('svg')
  if (!svg) return
  const { width, height } = svg.getBoundingClientRect()
  const serialized = new XMLSerializer().serializeToString(svg)
  const blob = new Blob([serialized], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.onload = () => {
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)
    URL.revokeObjectURL(url)
    const a = document.createElement('a')
    a.download = filename
    a.href = canvas.toDataURL('image/png')
    a.click()
  }
  img.src = url
}

export function downloadTableAsCSV(headers: string[], rows: (string | number | null)[][], filename: string): void {
  const esc = (v: string | number | null) => {
    const s = String(v ?? '')
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
