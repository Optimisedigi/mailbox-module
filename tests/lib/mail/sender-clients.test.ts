import { describe, expect, it } from 'vitest'
import { buildClientDomainIndex, chosenClientsFor, matchMessageToClient, type MatchableClient } from '@/lib/mail/client-matching'
import { cleanSenderClients, normaliseSenderEntry, saveSenderClients, SENDER_CLIENTS_PREF_KEY, senderClientFor, withSenderClient } from '@/lib/mail/sender-clients'
import { vi } from 'vitest'

const CLIENTS: MatchableClient[] = [
  { id: 1, name: 'Acme', websiteUrl: 'https://acme.com.au', contactEmail: 'jo@acme.com.au' },
  { id: 2, name: 'Beta', websiteUrl: 'beta.com' },
]

describe('sender → client choices in matching', () => {
  it('a chosen client beats automatic matching, exact address before domain', () => {
    const index = buildClientDomainIndex(CLIENTS, {
      overrides: [
        { sender: '@acme.com.au', clientIds: [2] },
        { sender: 'jo@acme.com.au', clientIds: [1] },
      ],
    })
    expect(matchMessageToClient(index, { from: 'Sam <sam@mail.acme.com.au>' })).toMatchObject({ clientId: 2, clientName: 'Beta', matchType: 'domain' })
    expect(matchMessageToClient(index, { from: 'Jo <jo@acme.com.au>' })).toMatchObject({ clientId: 1, matchedOn: 'jo@acme.com.au' })
    // A sender no client claims can be given one too, even on a shared provider.
    const gmail = buildClientDomainIndex(CLIENTS, { overrides: [{ sender: 'owner@gmail.com', clientIds: [1] }] })
    expect(matchMessageToClient(gmail, { from: 'owner@gmail.com' })).toMatchObject({ clientId: 1 })
  })

  it('"No client" makes the sender unmatched, and choices naming a missing client are ignored', () => {
    const index = buildClientDomainIndex(CLIENTS, {
      overrides: [
        { sender: '@beta.com', clientIds: [] },
        { sender: 'jo@acme.com.au', clientIds: [99] },
      ],
    })
    expect(matchMessageToClient(index, { from: 'pat@beta.com' })).toBeNull()
    expect(matchMessageToClient(index, { from: 'jo@acme.com.au' })).toMatchObject({ clientId: 1, matchType: 'address' })
  })

  it('never lets a choice claim our own addresses', () => {
    const index = buildClientDomainIndex(CLIENTS, {
      ownAddresses: ['pat@ourteam.example'],
      overrides: [{ sender: '@ourteam.example', clientIds: [1] }],
    })
    expect(matchMessageToClient(index, { from: 'pat@ourteam.example', to: 'pat@beta.com' })).toMatchObject({ clientId: 2 })
  })
})

describe('sender → client storage helpers', () => {
  it('normalises entries and refuses whole shared providers', () => {
    expect(normaliseSenderEntry('Jo <JO@Acme.com.au>')).toBe('jo@acme.com.au')
    expect(normaliseSenderEntry('acme.com.au')).toBe('@acme.com.au')
    expect(normaliseSenderEntry('@gmail.com')).toBeNull()
    expect(normaliseSenderEntry('someone@gmail.com')).toBe('someone@gmail.com')
  })

  it('cleans stored lists: bad rows dropped, latest choice per sender wins', () => {
    expect(
      cleanSenderClients([
        { sender: 'jo@acme.com.au', clientId: 1 },
        { sender: 'bad', clientId: 1 },
        { sender: '@beta.com', clientId: 'x' },
        { sender: 'JO@acme.com.au', clientIds: [2, 2] },
        { sender: '@beta.com', clientId: null },
      ]),
    ).toEqual([
      { sender: 'jo@acme.com.au', clientIds: [2] },
      { sender: '@beta.com', clientIds: [] },
    ])
    expect(cleanSenderClients('nope')).toEqual([])
  })

  it('finds the choice for a From header and updates or removes one', () => {
    const list = [
      { sender: '@acme.com.au', clientIds: [2] },
      { sender: 'jo@acme.com.au', clientIds: [1] },
    ]
    expect(senderClientFor('"jo@acme.com.au" <x@evil.com>', list)).toBeUndefined()
    expect(senderClientFor('Jo <jo@acme.com.au>', list)).toEqual({ sender: 'jo@acme.com.au', clientIds: [1] })
    expect(senderClientFor('sam@mail.acme.com.au', list)).toEqual({ sender: '@acme.com.au', clientIds: [2] })
    expect(withSenderClient(list, '@acme.com.au', undefined)).toEqual([{ sender: 'jo@acme.com.au', clientIds: [1] }])
    expect(withSenderClient(list, 'jo@acme.com.au', [])).toEqual([
      { sender: '@acme.com.au', clientIds: [2] },
      { sender: 'jo@acme.com.au', clientIds: [] },
    ])
  })
})

describe('several clients for one sender (agencies)', () => {
  it('shows every chosen client but never files the email to just one of them', () => {
    const index = buildClientDomainIndex(CLIENTS, { overrides: [{ sender: '@agency.com', clientIds: [1, 2] }] })
    expect(chosenClientsFor(index, 'sam@agency.com')).toEqual([
      { id: 1, name: 'Acme' },
      { id: 2, name: 'Beta' },
    ])
    // Not even through a client in Cc: the user assigns these by hand.
    expect(matchMessageToClient(index, { from: 'sam@agency.com', cc: 'jo@acme.com.au' })).toBeNull()
    expect(chosenClientsFor(index, 'jo@acme.com.au')).toEqual([])
  })

  it('drops deleted clients from a choice, and ignores a choice left with none', () => {
    const index = buildClientDomainIndex(CLIENTS, {
      overrides: [
        { sender: '@agency.com', clientIds: [2, 99] },
        { sender: 'jo@acme.com.au', clientIds: [98] },
      ],
    })
    expect(matchMessageToClient(index, { from: 'sam@agency.com' })).toMatchObject({ clientId: 2 })
    expect(matchMessageToClient(index, { from: 'jo@acme.com.au' })).toMatchObject({ clientId: 1, matchType: 'address' })
  })
})

describe('saving sender → client choices', () => {
  it('upserts straight to the database for the given user (regression: payload.create dropped the user and never saved)', async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const payload = { find: vi.fn(), db: { upsert } }
    await saveSenderClients(payload as never, 7, [{ sender: 'JO@agency.com', clientIds: [1, 2] }])
    expect(upsert).toHaveBeenCalledTimes(1)
    const args = upsert.mock.calls[0]?.[0]
    expect(args.collection).toBe('payload-preferences')
    expect(args.data).toEqual({
      key: SENDER_CLIENTS_PREF_KEY,
      user: { relationTo: 'users', value: 7 },
      value: { entries: [{ sender: 'jo@agency.com', clientIds: [1, 2] }] },
    })
    expect(args.where.and).toContainEqual({ 'user.value': { equals: 7 } })
    expect(args.where.and).toContainEqual({ key: { equals: SENDER_CLIENTS_PREF_KEY } })
  })
})
