import { afterEach, describe, expect, it } from 'vitest'
import {
  createGmailOAuthClient,
  gmailAppForEmail,
  gmailAppMatchesEmail,
  gmailExtraAppTargets,
  gmailSignInHint,
  parseGmailExtraApp,
} from '@/lib/gmail-oauth-apps'

const ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GMAIL_REDIRECT_URI',
  ...['GMAIL_ALT', 'GMAIL_ALT2', 'GMAIL_ALT3'].flatMap((prefix) => [
    `${prefix}_CLIENT_ID`,
    `${prefix}_CLIENT_SECRET`,
    `${prefix}_DOMAINS`,
    `${prefix}_ACCOUNTS`,
  ]),
]
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const setApps = () => {
  for (const key of ENV) delete process.env[key]
  process.env.GOOGLE_CLIENT_ID = 'main-id'
  process.env.GOOGLE_CLIENT_SECRET = 'main-secret'
  process.env.GMAIL_REDIRECT_URI = 'https://mail.test/api/gmail/callback'
  // Another Workspace, by domain (the partnerco setup).
  process.env.GMAIL_ALT_CLIENT_ID = 'alt-id'
  process.env.GMAIL_ALT_CLIENT_SECRET = 'alt-secret'
  process.env.GMAIL_ALT_DOMAINS = ' @PartnerCo.com.au ,not a domain, partnerco.com.au'
  // A personal Gmail, by exact address.
  process.env.GMAIL_ALT2_CLIENT_ID = 'alt2-id'
  process.env.GMAIL_ALT2_CLIENT_SECRET = 'alt2-secret'
  process.env.GMAIL_ALT2_ACCOUNTS = 'Pat.Lee.Home@gmail.com'
}

describe('Gmail OAuth app per account', () => {
  it('reads each extra app’s domains and addresses', () => {
    setApps()
    expect(gmailExtraAppTargets()).toEqual([
      { app: 'alt', domains: ['partnerco.com.au'], addresses: [] },
      { app: 'alt2', domains: [], addresses: ['pat.lee.home@gmail.com'] },
    ])
    expect(parseGmailExtraApp('alt2')).toBe('alt2')
    // Not set up, or not an app at all.
    expect(parseGmailExtraApp('alt3')).toBeNull()
    expect(parseGmailExtraApp('main')).toBeNull()
    expect(parseGmailExtraApp(null)).toBeNull()
  })

  it('maps an exact address first, then a domain, else the main app', () => {
    setApps()
    expect(gmailAppForEmail('Pat@PartnerCo.com.au')).toBe('alt')
    expect(gmailAppForEmail(' pat.lee.home@GMAIL.com ')).toBe('alt2')
    // Only that one Gmail address, not everyone on gmail.com.
    expect(gmailAppForEmail('someone@gmail.com')).toBe('main')
    expect(gmailAppForEmail('pat@ourteam.example')).toBe('main')
    // A subdomain or look-alike is not the domain.
    expect(gmailAppForEmail('x@mail.partnerco.com.au')).toBe('main')
    expect(gmailAppForEmail('x@partnerco.com.au.evil.com')).toBe('main')
    expect(gmailAppForEmail('')).toBe('main')
    expect(gmailAppForEmail('partnerco.com.au')).toBe('main')
    // An address listed on one app beats a domain listed on another.
    process.env.GMAIL_ALT2_ACCOUNTS = 'pat.lee.home@gmail.com, boss@partnerco.com.au'
    expect(gmailAppForEmail('boss@partnerco.com.au')).toBe('alt2')
    expect(gmailAppMatchesEmail('alt', 'boss@partnerco.com.au')).toBe(false)
    expect(gmailAppMatchesEmail('alt', 'pat@partnerco.com.au')).toBe(true)
    expect(gmailAppMatchesEmail('main', 'pat@partnerco.com.au')).toBe(false)
  })

  it('treats a half-configured app as absent', () => {
    setApps()
    delete process.env.GMAIL_ALT_CLIENT_SECRET
    delete process.env.GMAIL_ALT2_ACCOUNTS
    expect(gmailExtraAppTargets()).toEqual([])
    expect(gmailAppForEmail('pat@partnerco.com.au')).toBe('main')
    expect(() => createGmailOAuthClient('alt')).toThrow(/not configured/)
    expect(() => createGmailOAuthClient('alt2')).toThrow(/not configured/)
  })

  it('hints Google’s account picker with the one domain or address an app serves', () => {
    setApps()
    expect(gmailSignInHint('alt')).toEqual({ hd: 'partnerco.com.au' })
    expect(gmailSignInHint('alt2')).toEqual({ login_hint: 'pat.lee.home@gmail.com' })
    expect(gmailSignInHint('main')).toEqual({})
    process.env.GMAIL_ALT2_ACCOUNTS = 'pat.lee.home@gmail.com, other@gmail.com'
    expect(gmailSignInHint('alt2')).toEqual({})
  })

  it('builds each app’s client with its own credentials and the shared redirect', () => {
    setApps()
    const alt2 = createGmailOAuthClient('alt2') as unknown as { _clientId: string; _clientSecret: string; redirectUri: string }
    const main = createGmailOAuthClient('main') as unknown as { _clientId: string; redirectUri: string }
    expect(alt2._clientId).toBe('alt2-id')
    expect(alt2._clientSecret).toBe('alt2-secret')
    expect(alt2.redirectUri).toBe('https://mail.test/api/gmail/callback')
    expect(main._clientId).toBe('main-id')
    expect(main.redirectUri).toBe('https://mail.test/api/gmail/callback')
  })
})
