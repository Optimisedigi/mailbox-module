import { NextResponse } from 'next/server'
import { headers as nextHeaders } from 'next/headers'
import { getPayload } from 'payload'
import config from '@/payload.config'
import { getMailAiSettings } from '@/lib/ai/mail-ai-settings'
import { resolveCredential } from '@/lib/ai/llm/auth/resolver'
import { userHasFeature } from '@/lib/access'

export const runtime = 'nodejs'

const REALTIME_VOICE = 'marin'
const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe'
const DEFAULT_SAMPLE_RATE = 24_000
const MAIL_VOICE_MODEL = 'gpt-realtime-2.1'

type TurnDetectionConfig = {
  type?: unknown
  threshold?: unknown
  prefix_padding_ms?: unknown
  silence_duration_ms?: unknown
  create_response?: unknown
  interrupt_response?: unknown
}

/**
 * POST /api/mail/voice/realtime-secret
 *
 * Mints a short-lived OpenAI Realtime client secret (`ek_...`) for the compose
 * window's voice drafting. The browser sends the session (instructions and the
 * two browser-side draft tools); this route adds the model and audio config.
 *
 * Billing follows Mail Settings → "Use OpenAI API key for voice":
 *  - off (default): the connected ChatGPT plan (AI Auth → Codex OAuth) only.
 *  - on: OPENAI_API_KEY. The response reports `billing: 'api-key'` so the UI
 *    shows the "Using API credits" badge. The key never leaves the server.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const payload = await getPayload({ config })
    const headersList = await nextHeaders()
    const { user } = await payload.auth({ headers: headersList })
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!userHasFeature(user, 'nav:mail')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const body = (await request.json().catch(() => null)) as { session?: unknown } | null
    const settings = await getMailAiSettings(payload)

    let authHeaders: Record<string, string>
    // Reported to the browser so the voice UI can warn when a call bills API credits.
    let billing: 'oauth' | 'api-key'
    if (settings.voiceApiKeyEnabled) {
      const apiKey = process.env.OPENAI_API_KEY?.trim()
      if (!apiKey) {
        return NextResponse.json(
          {
            error:
              '"Use OpenAI API key for voice" is on, but OPENAI_API_KEY is not set. Set it and restart, or turn the setting off in Mail Settings to use the ChatGPT plan.',
          },
          { status: 500 },
        )
      }
      authHeaders = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      billing = 'api-key'
    } else {
      try {
        const resolved = await resolveCredential('openai-codex')
        if (resolved.source !== 'oauth') {
          return NextResponse.json(
            {
              error:
                'Voice drafting uses a connected ChatGPT plan (Codex OAuth), but none is connected. Connect one in AI Auth, or turn on "Use OpenAI API key for voice" in Mail Settings.',
            },
            { status: 400 },
          )
        }
        authHeaders = { ...resolved.authHeader, 'Content-Type': 'application/json' }
        billing = 'oauth'
      } catch (err) {
        const reason = (err as Error).message || 'Unknown error'
        console.error('[mail-voice-secret] Codex OAuth resolution failed:', reason)
        return NextResponse.json(
          { error: `ChatGPT plan (Codex OAuth) sign-in failed: ${reason}. Reconnect it in AI Auth.` },
          { status: 502 },
        )
      }
    }

    const requestedSession = isRecord(body?.session) ? body.session : null
    if (!requestedSession) {
      return NextResponse.json({ error: 'session is required' }, { status: 400 })
    }
    const instructions = readNonEmptyString(requestedSession.instructions)
    if (!instructions) {
      return NextResponse.json({ error: 'session.instructions is required' }, { status: 400 })
    }

    const session = buildRealtimeSession({
      model: MAIL_VOICE_MODEL,
      instructions,
      tools: Array.isArray(requestedSession.tools) ? requestedSession.tools : [],
      turnDetection: normalizeTurnDetection(requestedSession.turnDetection),
    })

    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ session }),
    })

    const rawText = await response.text()
    let raw: unknown = null
    try {
      raw = rawText ? JSON.parse(rawText) : null
    } catch {
      raw = null
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          error: describeOpenAIError(raw, rawText, response.status),
        },
        { status: response.status },
      )
    }

    if (!isRecord(raw) || typeof raw.value !== 'string' || raw.value.length === 0) {
      return NextResponse.json(
        { error: 'OpenAI did not return a Realtime client secret.' },
        { status: 502 },
      )
    }

    const mintedSession = isRecord(raw.session) ? raw.session : null
    const mintedModel = readNonEmptyString(mintedSession?.model) ?? String(session.model)
    return NextResponse.json({
      value: raw.value,
      expires_at: typeof raw.expires_at === 'number' ? raw.expires_at : null,
      model: mintedModel,
      billing,
    })
  } catch (err) {
    console.error('[mail-voice-secret] error:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Failed to mint Realtime secret' },
      { status: 500 },
    )
  }
}

function buildRealtimeSession(input: {
  model: string
  instructions: string
  tools: unknown[]
  turnDetection: TurnDetectionConfig
}): Record<string, unknown> {
  const model = input.model

  return {
    type: 'realtime',
    model,
    instructions: input.instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: DEFAULT_SAMPLE_RATE },
        noise_reduction: { type: 'near_field' },
        transcription: { model: DEFAULT_REALTIME_TRANSCRIPTION_MODEL },
        turn_detection: input.turnDetection,
      },
      output: {
        format: { type: 'audio/pcm', rate: DEFAULT_SAMPLE_RATE },
        voice: REALTIME_VOICE,
        speed: 1.0,
      },
    },
    max_output_tokens: 4096,
    ...(model.startsWith('gpt-realtime-2') ? { reasoning: { effort: 'minimal' } } : {}),
    tools: input.tools,
    tool_choice: 'auto',
    tracing: 'auto',
  }
}


function normalizeTurnDetection(value: unknown): TurnDetectionConfig {
  if (!isRecord(value)) {
    return {
      type: 'server_vad',
      threshold: 0.65,
      prefix_padding_ms: 500,
      silence_duration_ms: 1400,
      create_response: true,
      interrupt_response: false,
    }
  }

  return {
    type: value.type === 'semantic_vad' ? 'semantic_vad' : 'server_vad',
    threshold: typeof value.threshold === 'number' ? value.threshold : 0.65,
    prefix_padding_ms:
      typeof value.prefix_padding_ms === 'number' ? value.prefix_padding_ms : 500,
    silence_duration_ms:
      typeof value.silence_duration_ms === 'number' ? value.silence_duration_ms : 1400,
    create_response: typeof value.create_response === 'boolean' ? value.create_response : true,
    interrupt_response:
      typeof value.interrupt_response === 'boolean' ? value.interrupt_response : false,
  }
}

function describeOpenAIError(raw: unknown, text: string, status: number): string {
  if (isRecord(raw) && isRecord(raw.error) && typeof raw.error.message === 'string') {
    return raw.error.message
  }
  const trimmed = text.trim()
  return trimmed || `OpenAI Realtime client secret request failed (${status}).`
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
