import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'
import type { EmotionPerMessage, EmotionResult, UserTopicsResult } from '../types'

const DB_NAME = 'retrieval_analysis_v1'
const DB_VERSION = 2

let _db: Promise<IDBPDatabase> | null = null

function db(): Promise<IDBPDatabase> {
  if (!_db) {
    _db = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('emotion_messages')) {
          database.createObjectStore('emotion_messages', { keyPath: 'msg_uuid' })
        }
        if (!database.objectStoreNames.contains('bertopic_results')) {
          database.createObjectStore('bertopic_results')
        }
        // Tracks which username|dateFrom|dateTo combos have been emotion-analyzed.
        // Without this, all-dates analysis bleeds into per-phase views via UUID lookup.
        if (!database.objectStoreNames.contains('emotion_completed')) {
          database.createObjectStore('emotion_completed')
        }
      },
    })
  }
  return _db
}

export function makeBertopicKey(
  username: string,
  dateFrom: string,
  dateTo: string,
  scope: string,
): string {
  return `${username}|${dateFrom}|${dateTo}|${scope}`
}

export function makeEmotionKey(username: string, dateFrom: string, dateTo: string): string {
  return `${username}|${dateFrom}|${dateTo}`
}

// ── Emotion ──────────────────────────────────────────────────────────────────

export async function checkEmotionCompleted(key: string): Promise<boolean> {
  const val = await (await db()).get('emotion_completed', key)
  return val === true
}

export async function markEmotionCompleted(key: string): Promise<void> {
  await (await db()).put('emotion_completed', true, key)
}

export async function getEmotionMessages(
  uuids: string[],
): Promise<Map<string, EmotionPerMessage>> {
  if (uuids.length === 0) return new Map()
  const store = (await db()).transaction('emotion_messages', 'readonly').store
  const entries = await Promise.all(uuids.map(uuid => store.get(uuid)))
  const map = new Map<string, EmotionPerMessage>()
  for (let i = 0; i < uuids.length; i++) {
    if (entries[i]) map.set(uuids[i], entries[i] as EmotionPerMessage)
  }
  return map
}

export async function saveEmotionMessages(messages: EmotionPerMessage[]): Promise<void> {
  if (messages.length === 0) return
  const tx = (await db()).transaction('emotion_messages', 'readwrite')
  await Promise.all(messages.map(m => tx.store.put(m)))
  await tx.done
}

/** Rebuild a full EmotionResult from per-message cache entries. */
export function buildEmotionResult(perMessage: EmotionPerMessage[]): EmotionResult {
  const sentCounts = { positive: 0, negative: 0, neutral: 0 }
  for (const m of perMessage) sentCounts[m.sentiment]++
  const total = perMessage.length || 1
  const sentiment_ratio = {
    positive: sentCounts.positive / total,
    negative: sentCounts.negative / total,
    neutral: sentCounts.neutral / total,
  }

  const emotionAcc = new Map<string, number>()
  for (const m of perMessage) {
    const seen = new Set<string>()
    for (const e of m.top_emotions) {
      if (!seen.has(e.label)) {
        emotionAcc.set(e.label, (emotionAcc.get(e.label) ?? 0) + 1)
        seen.add(e.label)
      }
    }
  }
  const top_emotions = [...emotionAcc.entries()]
    .map(([label, count]) => ({ label, score: count }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  const tlMap = new Map<string, { positive: number; negative: number; neutral: number; count: number }>()
  for (const m of perMessage) {
    const period = (m.date ?? '').slice(0, 7)
    if (!period) continue
    const ex = tlMap.get(period) ?? { positive: 0, negative: 0, neutral: 0, count: 0 }
    ex[m.sentiment]++
    ex.count++
    tlMap.set(period, ex)
  }
  const timeline = [...tlMap.entries()]
    .map(([period, v]) => ({ period, ...v }))
    .sort((a, b) => a.period.localeCompare(b.period))

  return {
    per_message: perMessage,
    summary: { sentiment_ratio, top_emotions, timeline },
    total_messages: perMessage.length,
    analyzed_messages: perMessage.length,
  }
}

// ── BERTopic ─────────────────────────────────────────────────────────────────

export async function getBertopicResult(key: string): Promise<UserTopicsResult | null> {
  const val = await (await db()).get('bertopic_results', key)
  return (val as UserTopicsResult | undefined) ?? null
}

export async function saveBertopicResult(key: string, result: UserTopicsResult): Promise<void> {
  await (await db()).put('bertopic_results', result, key)
}
