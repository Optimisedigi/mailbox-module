import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const appendTimelineEntry = vi.fn(async (..._args: unknown[]) => ({ added: true }))
const user = { id: 3, name: 'Pat Lee', email: 'pat@team.test', role: 'editor' }
let hasClients = true

const extension = vi.hoisted(() => ({ clientListExtension: {} as Record<string, unknown> }))
vi.mock('@/extensions/client-list', () => extension)
vi.mock('@/lib/access', () => ({ userHasFeature: () => hasClients }))
vi.mock('@/lib/mail/route-helpers', () => ({
  readJson: async (req: NextRequest) => req.json(),
  requireMailUser: vi.fn(async () => ({
    payload: { findByID: vi.fn(async ({ id }: { id: number }) => (id === 7 ? { id: 7 } : Promise.reject(new Error('Not Found')))) },
    user,
  })),
}))

const { POST } = await import('@/app/(frontend)/api/mail/client-timeline/route')

const post = (body: unknown) =>
  new NextRequest('https://mail.test/api/mail/client-timeline', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  vi.clearAllMocks()
  hasClients = true
  extension.clientListExtension = { appendTimelineEntry }
})
extension.clientListExtension = { appendTimelineEntry }

describe('POST /api/mail/client-timeline', () => {
  it('hands the key date to the client-list extension, tidied', async () => {
    const res = await POST(post({ clientId: 7, day: '2026-06-23', description: '  Search   query review. ' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ added: true })
    expect(appendTimelineEntry).toHaveBeenCalledWith({
      payload: expect.anything(),
      clientId: 7,
      day: '2026-06-23',
      description: 'Search query review.',
      addedBy: 'Pat Lee',
    })
  })

  it('reports a date already on the timeline, and refuses bad input, unknown clients and users without client access', async () => {
    appendTimelineEntry.mockResolvedValueOnce({ added: false })
    expect(await (await POST(post({ clientId: 7, day: '2026-06-23', description: 'x' }))).json()).toEqual({ added: false })
    expect((await POST(post({ clientId: 7, day: '23 Jun 2026', description: 'x' }))).status).toBe(400)
    expect((await POST(post({ clientId: 7, day: '2026-06-23', description: ' ' }))).status).toBe(400)
    expect((await POST(post({ clientId: 99, day: '2026-06-23', description: 'x' }))).status).toBe(404)
    hasClients = false
    expect((await POST(post({ clientId: 7, day: '2026-06-23', description: 'x' }))).status).toBe(403)
    expect(appendTimelineEntry).toHaveBeenCalledTimes(1)
  })

  it('answers 501 when no client timeline is connected', async () => {
    extension.clientListExtension = {}
    const res = await POST(post({ clientId: 7, day: '2026-06-23', description: 'x' }))
    expect(res.status).toBe(501)
    expect((await res.json()).error).toBe('Client timelines are not connected in this app.')
  })
})
