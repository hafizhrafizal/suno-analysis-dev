// Shared type definitions for the Search / Users split

// ─── Search/UI types ──────────────────────────────────────────────────────────

export type SearchTab = 'keyword' | 'semantic' | 'username' | 'range' | 'browse'
export type MatchType = 'fuzzy' | 'exact' | 'any'
export type UsersDataTab = 'search' | 'phases'
export type TrendBucket = 'month' | 'week' | 'day'
export type AnalysisTab = 'none' | 'summarize' | 'viz'
export type FilterMode = 'exact' | 'any' | 'fuzzy' | 'semantic'

export interface TrendPoint {
  period: string
  count: number
  from: string
  to: string
}

export interface SrLogEntry {
  step: string
  label: string
  msg: string
}

export const LOG_ICONS: Record<string, string> = {
  filter: '🔍',
  retrieval: '📡',
  dedup: '🧹',
  cluster: '🔮',
  sample: '🎯',
  llm: '✨',
  fallback: '⚠️',
  meta: '📅',
  instruction: '📝',
}

// ─── Engagement types ─────────────────────────────────────────────────────────

export type EngagementLevel = 'high' | 'medium' | 'low'
export interface EngagementInfo {
  level: EngagementLevel
  pctWeeks: number
}

export type CrossPhaseTransition = 'dropout-high' | 'dropout-med' | 'dropout-low' | 'dec-hm' | 'dec-hl' | 'dec-ml'

export const ENGAGEMENT_COLORS: Record<EngagementLevel, { bg: string; text: string; dot: string; border: string }> = {
  high:   { bg: 'bg-emerald-50',  text: 'text-emerald-700', dot: 'bg-emerald-500',  border: 'border-emerald-200'  },
  medium: { bg: 'bg-sky-50',      text: 'text-sky-700',     dot: 'bg-sky-500',      border: 'border-sky-200'      },
  low:    { bg: 'bg-amber-50',    text: 'text-amber-600',   dot: 'bg-amber-400',    border: 'border-amber-200'    },
}

// ─── Emotion / sentiment helper constants ─────────────────────────────────────

export const POSITIVE_EMOTION_SET = new Set([
  'admiration','amusement','approval','caring','excitement',
  'gratitude','joy','love','optimism','pride','relief',
])
export const NEGATIVE_EMOTION_SET = new Set([
  'anger','annoyance','disappointment','disapproval','disgust',
  'embarrassment','fear','grief','nervousness','remorse','sadness',
])
export const emotionSentimentColor = (label: string) =>
  POSITIVE_EMOTION_SET.has(label) ? '#10b981'
  : NEGATIVE_EMOTION_SET.has(label) ? '#f43f5e'
  : '#9ca3af'

export const TOPIC_COLORS = [
  '#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6',
  '#8b5cf6','#ef4444','#14b8a6','#f97316','#84cc16',
]

// ─── MessageCard types ────────────────────────────────────────────────────────

export type MsgEmotion = {
  sentiment: string
  dominant_emotion: string
  top_emotions: { label: string; score: number }[]
}

// ─── UsersPage-specific types ─────────────────────────────────────────────────

export type PersonaResult = {
  persona: string
  confidence: number
  secondary_persona?: string | null
  secondary_confidence?: number | null
  reasoning: string
  created_at?: string
}
export type UserPersonas = Record<string, PersonaResult>

export type EmotionEntry = { label: string; score: number }
export type SentBucket = { count: number; top_emotions: EmotionEntry[] }
export type TableSentiment = {
  positive: number
  negative: number
  neutral: number
  analyzed: number
  top_emotions: EmotionEntry[]
  by_sentiment: { positive: SentBucket; negative: SentBucket; neutral: SentBucket }
}

export type FlowModalUser = {
  username: string
  total_messages: number
  weeks_active: number | null
  pct_weeks: number | null
  avg_words: number | null
  status: EngagementLevel | 'no-data' | null
}

export type ArchetypeRow = {
  username: string
  persona: string
  confidence: number
  secondary_persona?: string | null
  secondary_confidence?: number | null
  reasoning: string
  scores?: Record<string, number>
}
