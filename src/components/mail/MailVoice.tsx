'use client'

/**
 * MailVoice: live OpenAI Realtime voice drafting for the compose window.
 *
 *   1. The compose window supplies the session (instructions, greeting and its
 *      two browser-side tools: write_email_draft and read_current_draft).
 *   2. The server mints an ephemeral secret (/api/mail/voice/realtime-secret).
 *   3. A WebRTC peer opens: mic out, model audio in, `oai-events` data channel.
 *   4. Tool calls run in the browser against the compose window only. There is
 *      no send, schedule or Gmail tool.
 *
 * A single-in-flight `response.create` coordinator avoids
 * `conversation_already_has_active_response`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiCreditsNotice } from '../ApiCreditsNotice'
import { getRealtimeSecret } from '@/lib/realtime/token-provider'

/**
 * A voice session whose instructions and tools come from the host component
 * and whose tools run in the browser. Only the listed tools can be called.
 */
export interface LocalVoiceSession {
  instructions: string
  /** Realtime function tool definitions (type, name, description, parameters). */
  tools: Array<{ name: string }>
  /** Instruction for the opening greeting turn. */
  greeting: string
  executeTool: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>
}

interface MailVoiceProps {
  /** The host's session and browser-side tools. */
  localSession?: LocalVoiceSession
  /** Report the live call status (e.g. "Listening…"), or null when idle. */
  onStatusChange?: (status: string | null) => void
  /** When given, the active call controls are portalled into this element. */
  controlsContainer?: HTMLElement | null
  /** Diameter (px) of the idle round mic trigger. Defaults to 40. */
  triggerSize?: number
  /**
   * 'toggle': one round button instead of the trigger plus orb / mute / end
   * controls. Pressing it starts the call; it shows green while the call is on
   * (connecting included); pressing it again ends the call. For tight rows
   * such as the phone mail composer.
   */
  variant?: 'full' | 'toggle'
}

type VoiceState = 'idle' | 'connecting' | 'connected' | 'error'

// --- response.create coordinator (ported from Brah) ---------------------------

interface ResponseCoordinator {
  requestCreate: (event: RealtimeOutboundEvent) => RealtimeOutboundEvent | null
  observe: (event: { type?: string }) => RealtimeOutboundEvent | null
  noteActiveResponseConflict: () => void
  reset: () => void
}

type RealtimeOutboundEvent = Record<string, unknown> & { type: string }

function createResponseCoordinator(): ResponseCoordinator {
  let activeResponse = false
  let pendingCreate: RealtimeOutboundEvent | null = null
  let lastSentCreate: RealtimeOutboundEvent | null = null
  return {
    requestCreate(event) {
      if (activeResponse) {
        pendingCreate = event
        return null
      }
      activeResponse = true
      pendingCreate = null
      lastSentCreate = event
      return event
    },
    observe(event) {
      switch (event?.type) {
        case 'response.created':
          activeResponse = true
          return null
        case 'response.done': {
          activeResponse = false
          const flush = pendingCreate
          pendingCreate = null
          return flush
        }
        default:
          return null
      }
    },
    noteActiveResponseConflict() {
      activeResponse = true
      if (pendingCreate === null) pendingCreate = lastSentCreate
    },
    reset() {
      activeResponse = false
      pendingCreate = null
      lastSentCreate = null
    },
  }
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Realtime turn detection. A slower server VAD so natural pauses do not end the
 * user's turn too soon. Realtime creates the reply itself, and barge-in is on:
 * speaking while the assistant talks cancels its reply, as in ChatGPT voice.
 */
export function voiceTurnDetection() {
  return {
    type: 'server_vad',
    threshold: 0.65,
    prefix_padding_ms: 500,
    silence_duration_ms: 1400,
    create_response: true,
    interrupt_response: true,
  }
}

// Standard microphone glyph used across most chat UIs (rounded capsule mic on
// a stand). When muted, a diagonal slash is drawn through it.
function MicIcon({ muted = false }: { muted?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M5 11a7 7 0 0 0 14 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {muted && <path d="M4 3l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  )
}

// --- audio level monitor (ported from Brah's renderer waveform) --------------

interface AnalyserBundle {
  analyser: AnalyserNode
  data: Uint8Array<ArrayBuffer>
  freq: Uint8Array<ArrayBuffer>
}

function createAnalyser(ctx: AudioContext, stream: MediaStream): AnalyserBundle {
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.55
  ctx.createMediaStreamSource(stream).connect(analyser)
  return {
    analyser,
    data: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
    freq: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
  }
}

function readLevel({ analyser, data }: AnalyserBundle): number {
  analyser.getByteTimeDomainData(data)
  let sum = 0
  for (const v of data) {
    const centered = (v - 128) / 128
    sum += centered * centered
  }
  const rms = Math.sqrt(sum / data.length)
  return Math.min(1, Math.max(0, (rms - 0.015) * 8))
}

/**
 * ChatGPT-style connected voice orb. The glow gently breathes while connected
 * and reacts to the louder of mic or assistant audio so it feels alive without
 * taking over the compose toolbar.
 */
function VoiceConnectionOrb({
  micStream,
  remoteStream,
  active,
  muted,
}: {
  micStream: MediaStream | null
  remoteStream: MediaStream | null
  active: boolean
  muted: boolean
}) {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!active || muted || !micStream) {
      setLevel(0)
      return
    }

    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioCtx()
    const mic = createAnalyser(ctx, micStream)
    let remote: AnalyserBundle | null = null
    try {
      if (remoteStream) remote = createAnalyser(ctx, remoteStream)
    } catch {
      remote = null
    }

    let smoothed = 0
    let raf = 0
    const tick = () => {
      const micLevel = readLevel(mic)
      const remoteLevel = remote ? readLevel(remote) : 0
      smoothed = smoothed * 0.78 + Math.max(micLevel, remoteLevel * 1.15) * 0.22
      setLevel(smoothed)
      raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      void ctx.close()
    }
  }, [active, micStream, muted, remoteStream])

  const scale = 1 + Math.min(0.18, level * 0.3)

  return (
    <span
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        opacity: muted ? 0.5 : 1,
      }}
    >
      <span
        style={{
          position: 'absolute',
          inset: 2,
          borderRadius: '50%',
          border: '2px solid #059669',
          opacity: muted ? 0.35 : 0.9,
          animation: muted ? undefined : 'mailVoicePulse 1.5s ease-in-out infinite',
        }}
      />
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: '#047857',
          boxShadow: muted ? undefined : '0 0 12px rgba(5,150,105,0.55)',
          transform: `scale(${scale})`,
          transition: 'transform 90ms linear, opacity 160ms ease',
        }}
      />
    </span>
  )
}

// -----------------------------------------------------------------------------

export default function MailVoice({
  localSession,
  onStatusChange,
  controlsContainer,
  triggerSize = 40,
  variant = 'full',
}: MailVoiceProps) {
  // Latest host session (its tools read the host's current state).
  const localSessionRef = useRef(localSession)
  localSessionRef.current = localSession
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  // True when the live call's secret was minted with OPENAI_API_KEY (billed API credits).
  const [usingApiCredits, setUsingApiCredits] = useState(false)
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const coordinatorRef = useRef<ResponseCoordinator>(createResponseCoordinator())
  const handledToolCallIds = useRef<Set<string>>(new Set())

  const sendEvent = useCallback((event: RealtimeOutboundEvent) => {
    const dc = dcRef.current
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(event))
    }
  }, [])

  // Request a response.create through the coordinator (single in-flight).
  const requestResponse = useCallback(
    (event: RealtimeOutboundEvent) => {
      const toSend = coordinatorRef.current.requestCreate(event)
      if (toSend) sendEvent(toSend)
    },
    [sendEvent],
  )

  // The host's own tools run here in the browser; nothing else is callable.
  const executeToolCall = useCallback(
    async (callId: string, name: string, rawArgs: unknown) => {
      if (handledToolCallIds.current.has(callId)) return
      handledToolCallIds.current.add(callId)
      const args = parseToolArguments(rawArgs)
      const session = localSessionRef.current
      let output: unknown
      if (!session || !session.tools.some((tool) => tool.name === name)) {
        output = { error: `Tool "${name}" is not available.` }
      } else {
        try {
          const result = await session.executeTool(name, args)
          output = result.ok ? (result.data ?? { ok: true }) : { error: result.error ?? 'That did not work.' }
        } catch (err) {
          output = { error: err instanceof Error ? err.message : 'That did not work.' }
        }
      }
      sendEvent({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
      })
      requestResponse({ type: 'response.create' })
    },
    [sendEvent, requestResponse],
  )

  const handleRealtimeEvent = useCallback(
    (event: { type?: string; item?: Record<string, unknown>; error?: { code?: string; message?: string } }) => {
      // Flush a queued response.create when the active response ends.
      const flush = coordinatorRef.current.observe(event)
      if (flush) sendEvent(flush)

      if (event.type === 'error') {
        const code = event.error?.code ?? ''
        if (
          code === 'conversation_already_has_active_response' ||
          /already has an? active response/i.test(event.error?.message ?? '')
        ) {
          coordinatorRef.current.noteActiveResponseConflict()
        }
        return
      }

      // A finalized function call to execute.
      if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
        if (event.item.status === 'incomplete') return
        const callId = event.item.call_id
        const name = event.item.name
        if (typeof callId === 'string' && typeof name === 'string') {
          void executeToolCall(callId, name, event.item.arguments)
        }
      }
    },
    [sendEvent, executeToolCall],
  )

  const stop = useCallback(() => {
    dcRef.current?.close()
    dcRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
    coordinatorRef.current.reset()
    handledToolCallIds.current.clear()
    setUsingApiCredits(false)
    setState('idle')
    setMicStream(null)
    setRemoteStream(null)
  }, [])

  useEffect(() => stop, [stop])

  useEffect(() => {
    if (!onStatusChange) return
    if (state === 'connecting') onStatusChange('Connecting…')
    else if (state === 'connected') onStatusChange(muted ? 'Muted' : 'Listening…')
    else onStatusChange(null)
  }, [state, muted, onStatusChange])

  const start = useCallback(async () => {
    setError(null)
    try {
      const local = localSessionRef.current
      if (!local) throw new Error('Voice drafting is not available here.')
      setState('connecting')

      // Mint the ephemeral secret right before the offer.
      const secret = await getRealtimeSecret({
        instructions: local.instructions,
        tools: local.tools,
        turnDetection: voiceTurnDetection(),
      })
      setUsingApiCredits(secret.billing === 'api-key')

      const pc = new RTCPeerConnection()
      pcRef.current = pc
      pc.ontrack = (e) => {
        if (audioRef.current) audioRef.current.srcObject = e.streams[0] ?? null
        setRemoteStream(e.streams[0] ?? null)
      }
      pc.onconnectionstatechange = () => {
        const cs = pc.connectionState
        if (cs === 'connected') setState('connected')
        if (cs === 'closed' || cs === 'disconnected' || cs === 'failed') stop()
      }

      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      dc.addEventListener('open', () => {
        // Controlled opening turn: greet briefly and then wait.
        const greeting = coordinatorRef.current.requestCreate({
          type: 'response.create',
          response: {
            output_modalities: ['audio'],
            instructions:
              localSessionRef.current?.greeting ?? 'Greet the user in one short sentence, then wait for them to speak.',
          },
        })
        if (greeting) dc.send(JSON.stringify(greeting))
      })
      dc.addEventListener('message', (e) => {
        try {
          handleRealtimeEvent(JSON.parse(e.data))
        } catch {
          // ignore malformed event frames
        }
      })

      // Echo cancellation stops the mic hearing the assistant through the
      // speakers; noise suppression keeps background sound off the VAD.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      setMicStream(stream)
      for (const track of stream.getTracks()) pc.addTrack(track, stream)

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      // The model is bound to the ephemeral secret's session.
      const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: { Authorization: `Bearer ${secret.value}`, 'Content-Type': 'application/sdp' },
      })
      if (!sdpRes.ok) {
        const rawBody = await sdpRes.text()
        const requestId = sdpRes.headers.get('x-request-id') ?? sdpRes.headers.get('openai-request-id')
        let detail = rawBody.trim()
        try {
          const parsed = JSON.parse(rawBody) as { error?: { message?: string; code?: string } }
          if (parsed.error?.message) {
            detail = parsed.error.code ? `${parsed.error.message} (${parsed.error.code})` : parsed.error.message
          }
        } catch {
          // Non-JSON body: keep the raw text.
        }
        throw new Error(
          `Realtime call failed (${sdpRes.status})${detail ? `: ${detail}` : ''} [model: ${secret.model}${requestId ? `, request id: ${requestId}` : ''}]`,
        )
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      stop()
      setState('error')
    }
  }, [handleRealtimeEvent, stop])

  const toggleMute = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    const next = !muted
    for (const track of stream.getAudioTracks()) track.enabled = !next
    setMuted(next)
  }, [muted])

  const active = state === 'connecting' || state === 'connected'

  const controls = active ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8 }}>
      <style>{`
        @keyframes mailVoicePulse {
          0%, 100% { transform: scale(0.92); opacity: 0.9; }
          50% { transform: scale(1.18); opacity: 0.35; }
        }
      `}</style>
      <VoiceConnectionOrb micStream={micStream} remoteStream={remoteStream} active={state === 'connected'} muted={muted} />
      {usingApiCredits && <ApiCreditsNotice />}
      {(state !== 'connected' || muted) && (
        <span style={{ fontSize: 11, color: muted ? '#9ca3af' : '#4b5563', whiteSpace: 'nowrap' }}>
          {state === 'connected' ? 'Muted' : 'Connecting…'}
        </span>
      )}
      <button
        type="button"
        onClick={toggleMute}
        disabled={state !== 'connected'}
        title={muted ? 'Unmute' : 'Mute'}
        aria-label={muted ? 'Unmute' : 'Mute'}
        style={iconButtonStyle(muted ? '#9ca3af' : '#6b7280')}
      >
        <MicIcon muted={muted} />
      </button>
      <button type="button" onClick={stop} title="End call" aria-label="End call" style={iconButtonStyle('#dc2626')}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      </button>
    </div>
  ) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', position: 'relative' }}>
      {/* Hidden element that plays the model's voice. */}
      {/* biome-ignore lint/a11y/useMediaCaption: realtime model audio has no caption track */}
      <audio ref={audioRef} autoPlay style={{ display: 'none' }} />

      {variant === 'toggle' ? (
        <button
          type="button"
          onClick={active ? stop : start}
          aria-pressed={active}
          aria-label="Voice call"
          title={
            active
              ? `${state === 'connected' ? 'Voice call on' : 'Connecting…'}. Press to end the call.${usingApiCredits ? ' Billed to the OpenAI API key, not the ChatGPT plan.' : ''}`
              : 'Start a voice call about this email'
          }
          data-call-state={active ? state : 'idle'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: triggerSize,
            height: triggerSize,
            borderRadius: '50%',
            border: 'none',
            background: active ? '#16a34a' : '#111827',
            boxShadow: active ? '0 0 0 3px rgba(22, 163, 74, 0.28)' : undefined,
            opacity: active && state !== 'connected' ? 0.75 : 1,
            color: '#fff',
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'background-color 150ms ease, box-shadow 150ms ease, opacity 150ms ease',
          }}
        >
          <MicIcon />
        </button>
      ) : null}

      {variant === 'full' && !active && (
        <button
          type="button"
          onClick={start}
          title="Start a voice call about this email"
          aria-label="Start voice"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: triggerSize,
            height: triggerSize,
            borderRadius: '50%',
            border: 'none',
            background: '#111827',
            color: '#fff',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <MicIcon />
        </button>
      )}

      {variant === 'full' && controls && (controlsContainer ? createPortal(controls, controlsContainer) : controls)}

      {error && <div style={{ fontSize: 12, color: '#dc2626' }}>{error}</div>}
    </div>
  )
}

// Subtle, compact icon-only control (End / Mute) shown during a call.
function iconButtonStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    padding: 0,
    borderRadius: 6,
    border: '1px solid var(--theme-border-color, #e5e7eb)',
    background: 'transparent',
    color,
    fontSize: 13,
    lineHeight: 1,
    cursor: 'pointer',
  }
}
