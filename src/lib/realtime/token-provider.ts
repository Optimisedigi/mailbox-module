/**
 * Where the OpenAI Realtime ephemeral secret comes from: the app's own
 * /api/mail/voice/realtime-secret route. Browser-safe (no server imports).
 */

/** The minted ephemeral secret the browser uses to open the WebRTC call. */
export interface RealtimeSecret {
  /** Ephemeral client secret, e.g. `ek_...`. Send as `Bearer <value>`. */
  value: string
  /** Epoch ms the secret expires, or null when not reported. */
  expiresAt: number | null
  /** Realtime model id the secret was minted for. */
  model: string
  /** How the secret was paid for: ChatGPT plan OAuth, OpenAI API credits, or not reported. */
  billing: RealtimeBilling
}

export type RealtimeBilling = 'oauth' | 'api-key' | 'unknown'

export function parseRealtimeBilling(value: unknown): RealtimeBilling {
  return value === 'oauth' || value === 'api-key' ? value : 'unknown'
}

export const REALTIME_SECRET_PATH = '/api/mail/voice/realtime-secret'

/** Mint a fresh ephemeral secret for this session config (instructions + tools + turn detection). */
export async function getRealtimeSecret(session: Record<string, unknown>, signal?: AbortSignal): Promise<RealtimeSecret> {
  const response = await fetch(REALTIME_SECRET_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
    signal,
  })
  const text = await response.text()
  if (!response.ok) {
    let message = text
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (parsed.error) message = parsed.error
    } catch {
      // keep raw text
    }
    throw new Error(`The voice secret request was rejected (${response.status}): ${message}`)
  }
  const raw = JSON.parse(text) as { value?: unknown; expires_at?: unknown; model?: unknown; billing?: unknown }
  if (typeof raw.value !== 'string' || raw.value.length === 0) {
    throw new Error('The voice secret route did not include a secret value.')
  }
  return {
    value: raw.value,
    expiresAt: typeof raw.expires_at === 'number' ? raw.expires_at : null,
    model: typeof raw.model === 'string' ? raw.model : 'gpt-realtime-2.1',
    billing: parseRealtimeBilling(raw.billing),
  }
}
