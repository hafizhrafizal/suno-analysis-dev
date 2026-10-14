export interface Message {
  id: number
  msg_uuid?: string
  username: string
  date: string
  content: string
  attachments?: string
  reactions?: string
  is_suno_team?: string | boolean
  upload_id?: string
  row_index?: number
  similarity?: number
}

export interface Upload {
  id: string
  filename: string
  row_count: number
  upload_time: string
  embedded_models?: Record<string, boolean>
}

export interface User {
  id: number
  username: string
  is_admin: boolean
  created_at?: string
}

export interface Bookmark {
  id: number
  msg_id: number
  note?: string
  created_at: string
  content?: string
  username?: string
  date?: string
  is_suno_team?: string | boolean
  codes: Code[]
}

export interface Code {
  id: number
  name: string
  color: string
  description?: string
  category_id?: number | null
}

export interface CodeCategory {
  id: number
  name: string
  color?: string
  parent_id?: number | null
  description?: string
}

export interface BookmarkCode {
  bookmark_id: number
  code_id: number
  code_name: string
  color: string
  highlighted_text?: string
  type?: 'excerpt' | 'highlight'
}

export interface Stats {
  total_messages: number
  total_uploads: number
  embedded_messages: number
  api_key_set: boolean
  current_model?: string
  vector_db_label?: string
}

export interface EmbeddingModel {
  id: string
  label: string
  description: string
  dims: number
  embedded_count: number
  active: boolean
  local: boolean
  available?: boolean
  vector_count?: number
}

export interface SunoTeamMember {
  username: string
  message_count: number
}

export interface UserInRange {
  username: string
  total_messages: number
  is_suno_team?: boolean
  first_date?: string
  last_date?: string
  avg_words?: number
  weeks_active?: number
  total_weeks?: number
  pct_weeks?: number
}

export interface UserTopic {
  id: number
  label: string
  keywords: string[]
  message_count: number
  representative_docs?: string[]
}

export interface UserTopicsResult {
  topics: UserTopic[]
  doc_assignments?: Record<string, number>  // msg_uuid → topic_id
  total_docs: number
  filtered_docs: number
  warning?: string
  // Set when the loaded run's date range differs from the requested filter
  date_from?: string
  date_to?: string
}

export type TopicPipelineStage = 'prepare' | 'fetch_embeddings' | 'align_docs' | 'bertopic' | 'complete' | 'error'
export type TopicPipelineStatus = 'pending' | 'running' | 'done' | 'error'

export interface TopicPipelineStep {
  stage: TopicPipelineStage
  status: TopicPipelineStatus
  message: string
}

export interface ContextMessage {
  id: number
  username: string
  date: string
  content: string
  is_target?: boolean
  is_suno_team?: string | boolean
}

export interface EmotionScore {
  label: string
  score: number
}

export interface EmotionPerMessage {
  msg_uuid: string
  date: string
  top_emotions: EmotionScore[]
  sentiment: 'positive' | 'negative' | 'neutral'
}

export interface EmotionTimeline {
  period: string
  positive: number
  negative: number
  neutral: number
  count: number
}

export interface EmotionResult {
  per_message: EmotionPerMessage[]
  summary: {
    sentiment_ratio: { positive: number; negative: number; neutral: number }
    top_emotions: EmotionScore[]
    timeline: EmotionTimeline[]
  }
  total_messages: number
  analyzed_messages: number
}
