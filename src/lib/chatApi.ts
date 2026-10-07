import type { Transcript } from '../types'
import { API_BASE } from './apiBase'
import { PredictError } from './predictApi'

// AI assistant chat over the loaded transcript (full/police build only).
// Same local FastAPI service as /focus_llm — a LOCAL Ollama model answers,
// grounded in segment citations that the server validates against the
// transcript. Nothing leaves the machine; nothing is cached or stored.
const CHAT_URL = `${API_BASE}/chat`

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** A server-VERIFIED citation: the id exists in this transcript, and the seek
 *  time + evidence text come from the transcript, never from the model. An
 *  unverifiable quote arrives blanked (the id still stands). */
export interface ChatCitation {
  id: number
  segment_start: number
  evidence: string
  quote: string
}

export interface ChatResponse {
  answer: string
  citations: ChatCitation[]
  model: string
}

// Client-side history trim (the server enforces its own cap too): the last N
// turns plus the new user message keep long conversations from crowding the
// transcript out of the model's context window.
export const CHAT_HISTORY_TURNS = 6

export async function runChat(
  transcript: Transcript,
  messages: ChatMessage[],
): Promise<ChatResponse> {
  let res: Response
  try {
    res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript,
        messages: messages.slice(-(CHAT_HISTORY_TURNS + 1)),
      }),
    })
  } catch (err) {
    throw new PredictError(
      `Could not reach the assistant service at ${CHAT_URL}. Start it with:\n` +
        `cd server && uvicorn serve_model:app --port 8000`,
      err,
    )
  }

  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { detail?: string }
      detail = body.detail ?? ''
    } catch {
      /* non-JSON error body */
    }
    // 503 carries Ollama's actionable message (`ollama serve` / `ollama pull`).
    throw new PredictError(`Assistant failed (HTTP ${res.status}). ${detail}`)
  }

  return (await res.json()) as ChatResponse
}
