import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signOAuthState } from '@/lib/oauth-state'

const mockPayload = {
  auth: vi.fn(),
  find: vi.fn(),
  findByID: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}
const cookieJar = new Map<string, string>()

vi.mock('payload', () => ({ getPayload: vi.fn(() => Promise.resolve(mockPayload)) }))
vi.mock('@/payload.config', () => ({ default: Promise.resolve({}) }))
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
    set: (name: string, value: string) => cookieJar.set(name, value),
    delete: (name: string) => cookieJar.delete(name),
  })),
}))
const getGmailOAuthUrl = vi.fn(
  (state: string, options?: { selectAccount?: boolean; app?: string; loginHint?: string }) =>
    `https://google.test/?state=${state}&select=${options?.selectAccount ? 1 : 0}&app=${options?.app ?? 'main'}&hint=${options?.loginHint ?? ''}`,
)
const exchangeGmailCode = vi.fn()
const refreshGmailAccessToken = vi.fn()
vi.mock('@/lib/gmail-service', () => ({
  getGmailOAuthUrl: (state: string, options?: { selectAccount?: boolean; app?: string; loginHint?: string }) => getGmailOAuthUrl(state, options),
  exchangeGmailCode: (code: string, app?: string) => exchangeGmailCode(code, app),
  refreshGmailAccessToken: (token: string, email?: string) => refreshGmailAccessToken(token, email),
}))

const connect = await import('@/app/(frontend)/api/gmail/connect/route')
const callback = await import('@/app/(frontend)/api/gmail/callback/route')
const { getValidGmailToken } = await import('@/lib/user-gmail-tokens')

const location = (res: Response) => new URL(res.headers.get('location') ?? 'http://x/')

beforeEach(() => {
  vi.clearAllMocks()
  cookieJar.clear()
  process.env.PAYLOAD_SECRET = 'test-secret'
  process.env.GOOGLE_CLIENT_ID = 'id'
  process.env.GOOGLE_CLIENT_SECRET = 'secret'
  process.env.GMAIL_REDIRECT_URI = 'http://localhost/api/gmail/callback'
  delete process.env.GMAIL_ALT_CLIENT_ID
  delete process.env.GMAIL_ALT_CLIENT_SECRET
  delete process.env.GMAIL_ALT_DOMAINS
  delete process.env.GMAIL_ALT2_CLIENT_ID
  delete process.env.GMAIL_ALT2_CLIENT_SECRET
  delete process.env.GMAIL_ALT2_ACCOUNTS
  mockPayload.auth.mockResolvedValue({ user: { id: 7, role: 'admin' } })
  mockPayload.find.mockResolvedValue({ docs: [] })
})

describe('adding another Gmail account', () => {
  it('?add=1 marks the flow with its own nonce cookie and lets the user pick a Google login', async () => {
    const res = await connect.GET(new NextRequest('http://localhost/api/gmail/connect?add=1'))
    expect(cookieJar.has('oauth_nonce_gmail_add')).toBe(true)
    expect(cookieJar.has('oauth_nonce_gmail')).toBe(false)
    expect(location(res).searchParams.get('select')).toBe('1')
  })

  it('saves a different address as an extra account and leaves the main Gmail untouched', async () => {
    const { state, nonce } = signOAuthState(7, 7)
    cookieJar.set('oauth_nonce_gmail_add', nonce)
    mockPayload.findByID.mockResolvedValue({ id: 7, gmailConnected: true, gmailEmail: 'me@team.test' })
    exchangeGmailCode.mockResolvedValue({ email: 'Sales@Team.test', accessToken: 'a', refreshToken: 'r', expiry: null })
    const res = await callback.GET(new NextRequest(`http://localhost/api/gmail/callback?code=c&state=${encodeURIComponent(state)}`))
    expect(location(res).pathname).toBe('/admin/mail')
    expect(location(res).searchParams.get('account')).toBe('sales@team.test')
    expect(mockPayload.update).not.toHaveBeenCalledWith(expect.objectContaining({ collection: 'users' }))
    expect(mockPayload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'mail-accounts',
        data: expect.objectContaining({ owner: 7, email: 'sales@team.test', accessToken: 'a', refreshToken: 'r' }),
      }),
    )
    expect(cookieJar.has('oauth_nonce_gmail_add')).toBe(false)
  })

  it('picking the main address again just refreshes the main Gmail', async () => {
    const { state, nonce } = signOAuthState(7, 7)
    cookieJar.set('oauth_nonce_gmail_add', nonce)
    mockPayload.findByID.mockResolvedValue({ id: 7, gmailConnected: true, gmailEmail: 'me@team.test' })
    exchangeGmailCode.mockResolvedValue({ email: 'me@team.test', accessToken: 'a', refreshToken: 'r', expiry: null })
    await callback.GET(new NextRequest(`http://localhost/api/gmail/callback?code=c&state=${encodeURIComponent(state)}`))
    expect(mockPayload.update).toHaveBeenCalledWith(expect.objectContaining({ collection: 'users', id: 7 }))
    expect(mockPayload.create).not.toHaveBeenCalled()
  })

  it('the normal connect flow still replaces the main Gmail', async () => {
    const { state, nonce } = signOAuthState(7, 7)
    cookieJar.set('oauth_nonce_gmail', nonce)
    exchangeGmailCode.mockResolvedValue({ email: 'other@team.test', accessToken: 'a', refreshToken: 'r', expiry: null })
    const res = await callback.GET(new NextRequest(`http://localhost/api/gmail/callback?code=c&state=${encodeURIComponent(state)}`))
    expect(location(res).pathname).toBe('/admin/ai-auth')
    expect(mockPayload.update).toHaveBeenCalledWith(expect.objectContaining({ collection: 'users', data: expect.objectContaining({ gmailEmail: 'other@team.test' }) }))
    expect(mockPayload.create).not.toHaveBeenCalled()
  })
})

describe('adding an account through the second Gmail app (another Google Workspace)', () => {
  const setAlt = () => {
    process.env.GMAIL_ALT_CLIENT_ID = 'alt-id'
    process.env.GMAIL_ALT_CLIENT_SECRET = 'alt-secret'
    process.env.GMAIL_ALT_DOMAINS = 'PartnerCo.com.au, not a domain'
  }
  const callbackWith = async (cookie: string, email: string) => {
    const { state, nonce } = signOAuthState(7, 7)
    cookieJar.set(cookie, nonce)
    mockPayload.findByID.mockResolvedValue({ id: 7, gmailConnected: true, gmailEmail: 'me@team.test' })
    exchangeGmailCode.mockResolvedValue({ email, accessToken: 'a', refreshToken: 'r', expiry: null })
    return callback.GET(new NextRequest(`http://localhost/api/gmail/callback?code=c&state=${encodeURIComponent(state)}`))
  }

  it('is refused until the second app is fully set up', async () => {
    process.env.GMAIL_ALT_CLIENT_ID = 'alt-id'
    process.env.GMAIL_ALT_DOMAINS = 'partnerco.com.au'
    const res = await connect.GET(new NextRequest('http://localhost/api/gmail/connect?add=1&app=alt'))
    expect(res.status).toBe(400)
    expect(cookieJar.size).toBe(0)
  })

  it('signs in through the second app with its own nonce cookie', async () => {
    setAlt()
    const res = await connect.GET(new NextRequest('http://localhost/api/gmail/connect?add=1&app=alt'))
    expect(cookieJar.has('oauth_nonce_gmail_add_alt')).toBe(true)
    expect(cookieJar.has('oauth_nonce_gmail_add')).toBe(false)
    expect(location(res).searchParams.get('app')).toBe('alt')
    // app=alt without add=1 is the normal main-Gmail connect.
    cookieJar.clear()
    const main = await connect.GET(new NextRequest('http://localhost/api/gmail/connect?app=alt'))
    expect(cookieJar.has('oauth_nonce_gmail')).toBe(true)
    expect(location(main).searchParams.get('app')).toBe('main')
  })

  it('exchanges the code with the second app and saves the account', async () => {
    setAlt()
    const res = await callbackWith('oauth_nonce_gmail_add_alt', 'Pat@PartnerCo.com.au')
    expect(exchangeGmailCode).toHaveBeenCalledWith('c', 'alt')
    expect(location(res).searchParams.get('account')).toBe('pat@partnerco.com.au')
    expect(mockPayload.create).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'mail-accounts', data: expect.objectContaining({ email: 'pat@partnerco.com.au' }) }),
    )
    expect(cookieJar.has('oauth_nonce_gmail_add_alt')).toBe(false)
  })

  it('keeps no tokens when the signed-in address does not belong to the app that signed it in', async () => {
    setAlt()
    // Second app, but an address outside its domains.
    const wrongAlt = await callbackWith('oauth_nonce_gmail_add_alt', 'someone@team.test')
    expect(location(wrongAlt).searchParams.get('mail_account_error')).toMatch(/not an account this sign-in option is set up for/)
    // Main app, but an address on the second app's domain.
    const wrongMain = await callbackWith('oauth_nonce_gmail_add', 'pat@partnerco.com.au')
    expect(exchangeGmailCode).toHaveBeenLastCalledWith('c', 'main')
    expect(location(wrongMain).searchParams.get('mail_account_error')).toMatch(/its own sign-in option/)
    expect(mockPayload.create).not.toHaveBeenCalled()
    expect(mockPayload.update).not.toHaveBeenCalled()
  })

  it('a nonce minted for the normal add flow cannot be replayed as the second-app flow', async () => {
    setAlt()
    const { state, nonce } = signOAuthState(7, 7)
    cookieJar.set('oauth_nonce_gmail_add', nonce)
    cookieJar.set('oauth_nonce_gmail_add_alt', 'different')
    exchangeGmailCode.mockResolvedValue({ email: 'sales@team.test', accessToken: 'a', refreshToken: 'r', expiry: null })
    mockPayload.findByID.mockResolvedValue({ id: 7, gmailConnected: true, gmailEmail: 'me@team.test' })
    await callback.GET(new NextRequest(`http://localhost/api/gmail/callback?code=c&state=${encodeURIComponent(state)}`))
    expect(exchangeGmailCode).toHaveBeenCalledWith('c', 'main')
  })
})

describe('adding an account by typing its address (?add=1&email=)', () => {
  const setApps = () => {
    process.env.GMAIL_ALT_CLIENT_ID = 'alt-id'
    process.env.GMAIL_ALT_CLIENT_SECRET = 'alt-secret'
    process.env.GMAIL_ALT_DOMAINS = 'partnerco.com.au'
    process.env.GMAIL_ALT2_CLIENT_ID = 'alt2-id'
    process.env.GMAIL_ALT2_CLIENT_SECRET = 'alt2-secret'
    process.env.GMAIL_ALT2_ACCOUNTS = 'pat.lee.home@gmail.com'
  }

  it('picks the sign-in app from the address and pre-fills it', async () => {
    setApps()
    const cases: Array<[string, string, string]> = [
      ['Support@PartnerCo.com.au', 'alt', 'oauth_nonce_gmail_add_alt'],
      ['pat.lee.home@gmail.com', 'alt2', 'oauth_nonce_gmail_add_alt2'],
      ['sales@team.test', 'main', 'oauth_nonce_gmail_add'],
    ]
    for (const [email, app, cookie] of cases) {
      cookieJar.clear()
      const res = await connect.GET(new NextRequest(`http://localhost/api/gmail/connect?add=1&email=${encodeURIComponent(email)}`))
      expect(location(res).searchParams.get('app')).toBe(app)
      expect(location(res).searchParams.get('hint')).toBe(email.toLowerCase())
      expect([...cookieJar.keys()]).toEqual([cookie])
    }
  })

  it('refuses an address that is not an email, setting no cookie', async () => {
    const res = await connect.GET(new NextRequest('http://localhost/api/gmail/connect?add=1&email=pat'))
    expect(res.status).toBe(400)
    expect(cookieJar.size).toBe(0)
  })
})

describe('adding a personal Gmail through its own app (matched by exact address)', () => {
  const setPersonal = () => {
    process.env.GMAIL_ALT2_CLIENT_ID = 'alt2-id'
    process.env.GMAIL_ALT2_CLIENT_SECRET = 'alt2-secret'
    process.env.GMAIL_ALT2_ACCOUNTS = 'pat.lee.home@gmail.com'
  }
  const callbackWith = async (cookie: string, email: string) => {
    const { state, nonce } = signOAuthState(7, 7)
    cookieJar.set(cookie, nonce)
    mockPayload.findByID.mockResolvedValue({ id: 7, gmailConnected: true, gmailEmail: 'me@team.test' })
    exchangeGmailCode.mockResolvedValue({ email, accessToken: 'a', refreshToken: 'r', expiry: null })
    return callback.GET(new NextRequest(`http://localhost/api/gmail/callback?code=c&state=${encodeURIComponent(state)}`))
  }

  it('signs in through that app with its own nonce cookie, and refuses apps that are not set up', async () => {
    setPersonal()
    const res = await connect.GET(new NextRequest('http://localhost/api/gmail/connect?add=1&app=alt2'))
    expect(cookieJar.has('oauth_nonce_gmail_add_alt2')).toBe(true)
    expect(location(res).searchParams.get('app')).toBe('alt2')
    cookieJar.clear()
    for (const app of ['alt3', 'alt', 'main', 'nope']) {
      expect((await connect.GET(new NextRequest(`http://localhost/api/gmail/connect?add=1&app=${app}`))).status).toBe(400)
    }
    expect(cookieJar.size).toBe(0)
  })

  it('saves only the listed address; any other Gmail signed in through it keeps no tokens', async () => {
    setPersonal()
    const ok = await callbackWith('oauth_nonce_gmail_add_alt2', 'Pat.Lee.Home@gmail.com')
    expect(exchangeGmailCode).toHaveBeenCalledWith('c', 'alt2')
    expect(location(ok).searchParams.get('account')).toBe('pat.lee.home@gmail.com')
    expect(mockPayload.create).toHaveBeenCalledTimes(1)
    const other = await callbackWith('oauth_nonce_gmail_add_alt2', 'someone@gmail.com')
    expect(location(other).searchParams.get('mail_account_error')).toMatch(/not an account this sign-in option is set up for/)
    expect(mockPayload.create).toHaveBeenCalledTimes(1)
  })
})

describe('getValidGmailToken with an account', () => {
  const user = { id: 7, email: 'pat@team.test', gmailConnected: true, gmailEmail: 'Me@team.test', gmailAccessToken: 'main', gmailRefreshToken: 'r', gmailTokenExpiry: '2999-01-01T00:00:00.000Z' }

  it('uses the main Gmail with no account or the main address', async () => {
    mockPayload.findByID.mockResolvedValue(user)
    expect(await getValidGmailToken(7)).toMatchObject({ ok: true, accessToken: 'main', account: '' })
    expect(await getValidGmailToken(7, 'me@team.test')).toMatchObject({ ok: true, accessToken: 'main', account: '' })
    expect(mockPayload.find).not.toHaveBeenCalled()
  })

  it('uses one of the user’s own extra accounts, refreshing an expired token', async () => {
    mockPayload.findByID.mockResolvedValue(user)
    mockPayload.find.mockResolvedValue({ docs: [{ id: 3, email: 'sales@team.test', accessToken: 'old', refreshToken: 'sr', tokenExpiry: '2000-01-01T00:00:00.000Z' }] })
    refreshGmailAccessToken.mockResolvedValue({ accessToken: 'fresh', expiry: '2999-01-01T00:00:00.000Z' })
    expect(await getValidGmailToken(7, 'Sales@team.test')).toMatchObject({ ok: true, accessToken: 'fresh', email: 'sales@team.test', account: 'sales@team.test' })
    // The account's address goes with the refresh, so its own Google app renews it.
    expect(refreshGmailAccessToken).toHaveBeenCalledWith('sr', 'sales@team.test')
    expect(mockPayload.find).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'mail-accounts', where: { and: [{ owner: { equals: 7 } }, { email: { equals: 'sales@team.test' } }] } }),
    )
    expect(mockPayload.update).toHaveBeenCalledWith(expect.objectContaining({ collection: 'mail-accounts', id: 3, data: { accessToken: 'fresh', tokenExpiry: '2999-01-01T00:00:00.000Z' } }))
  })

  it('refuses an account the user has not connected', async () => {
    mockPayload.findByID.mockResolvedValue(user)
    mockPayload.find.mockResolvedValue({ docs: [] })
    const result = await getValidGmailToken(7, 'someone-else@team.test')
    expect(result.ok).toBe(false)
  })
})
