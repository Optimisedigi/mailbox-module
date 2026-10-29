import { afterEach, describe, expect, it, vi } from 'vitest'

const auth = vi.fn()
vi.mock('payload', () => ({ getPayload: vi.fn(async () => ({ auth })) }))
vi.mock('@/payload.config', () => ({ default: {} }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
const settings = vi.fn(async () => ({ emailAssistantModel: 'kimi-k3', writingStyle: '', voiceApiKeyEnabled: true }))
vi.mock('@/lib/ai/mail-ai-settings', () => ({ getMailAiSettings: () => settings() }))
const resolveCredential = vi.fn()
vi.mock('@/lib/ai/llm/auth/resolver', () => ({ resolveCredential: (provider: string) => resolveCredential(provider) }))

const { POST } = await import('@/app/(frontend)/api/mail/voice/realtime-secret/route')

const request = (body: unknown) =>
  new Request('http://localhost/api/mail/voice/realtime-secret', { method: 'POST', body: JSON.stringify(body) })
const session = { instructions: 'Help draft this email.', tools: [{ type: 'function', name: 'write_email_draft' }] }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/mail/voice/realtime-secret', () => {
  it('needs a signed-in user with the Mail feature', async () => {
    auth.mockResolvedValueOnce({ user: null })
    expect((await POST(request({ session }))).status).toBe(401)
    auth.mockResolvedValueOnce({ user: { id: 1, role: 'user', featureAccess: [] } })
    expect((await POST(request({ session }))).status).toBe(403)
  })

  it('mints a secret with OPENAI_API_KEY when the setting is on, with the browser tools and the mail voice model', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    auth.mockResolvedValue({ user: { id: 1, role: 'admin' } })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ value: 'ek_1', expires_at: 99, session: { model: 'gpt-realtime-2.1' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await POST(request({ session }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ value: 'ek_1', expires_at: 99, model: 'gpt-realtime-2.1', billing: 'api-key' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const sent = JSON.parse(String(init.body)) as { session: { model: string; tools: Array<{ name: string }>; instructions: string } }
    expect(sent.session).toMatchObject({ model: 'gpt-realtime-2.1', instructions: 'Help draft this email.' })
    expect(sent.session.tools.map((tool) => tool.name)).toEqual(['write_email_draft'])
    expect(resolveCredential).not.toHaveBeenCalled()
  })

  it('uses only the connected ChatGPT plan when the setting is off, and never falls back to the key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    settings.mockResolvedValueOnce({ emailAssistantModel: 'kimi-k3', writingStyle: '', voiceApiKeyEnabled: false })
    auth.mockResolvedValue({ user: { id: 1, role: 'admin' } })
    resolveCredential.mockResolvedValueOnce({ source: 'api-key', authHeader: {} })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await POST(request({ session }))
    expect(res.status).toBe(400)
    expect(resolveCredential).toHaveBeenCalledWith('openai-codex')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires session instructions', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    auth.mockResolvedValue({ user: { id: 1, role: 'admin' } })
    expect((await POST(request({ session: { tools: [] } }))).status).toBe(400)
  })
})
