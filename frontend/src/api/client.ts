export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function openaiKeyHeader(): Record<string, string> {
  const k = localStorage.getItem('openai_api_key')
  return k ? { 'X-OpenAI-Key': k } : {}
}

function hfTokenHeader(): Record<string, string> {
  const t = localStorage.getItem('hf_token')
  return t ? { 'X-HF-Token': t } : {}
}

function aiHeaders(): Record<string, string> {
  return { ...openaiKeyHeader(), ...hfTokenHeader() }
}

export async function apiFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const isFormData = options?.body instanceof FormData
  const res = await fetch(`/api${path}`, {
    headers: isFormData
      ? { ...aiHeaders(), ...(options?.headers ?? {}) }
      : {
          'Content-Type': 'application/json',
          ...aiHeaders(),
          ...(options?.headers ?? {}),
        },
    credentials: 'include',
    ...options,
  })

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const data = await res.json()
      msg = data.detail ?? data.error ?? data.message ?? msg
    } catch {
      const text = await res.text().catch(() => '')
      if (text.trimStart().startsWith('<')) {
        msg = `Server returned an HTML error page (HTTP ${res.status}). Check backend is running.`
      } else {
        msg = text || msg
      }
    }
    throw new ApiError(res.status, msg)
  }

  if (res.status === 204) return null as T
  return res.json()
}

// Generic SSE streaming that handles events with { type, data, step, message, result } shapes
// used by the chat/summarize endpoints
export function streamEvents(
  path: string,
  body: unknown,
  onEvent: (event: Record<string, unknown>) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  method: string = 'POST',
): () => void {
  let aborted = false
  const controller = new AbortController()

  ;(async () => {
    try {
      const res = await fetch(`/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...aiHeaders() },
        body: JSON.stringify(body),
        signal: controller.signal,
        credentials: 'include',
      })

      if (!res.ok || !res.body) {
        let msg = `HTTP ${res.status}`
        try {
          const d = await res.json()
          msg = d.detail ?? d.error ?? msg
        } catch { /* ignore */ }
        throw new Error(msg)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const jsonStr = trimmed.slice(6)
          if (jsonStr === '[DONE]') continue
          try {
            const event = JSON.parse(jsonStr) as Record<string, unknown>
            onEvent(event)
          } catch { /* skip malformed lines */ }
        }
      }
      if (!aborted) onDone()
    } catch (err) {
      if (!aborted) {
        onError(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })()

  return () => {
    aborted = true
    controller.abort()
  }
}
