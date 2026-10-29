import { describe, expect, it } from 'vitest'
import {
  buildFrequentSenders,
  buildMailContacts,
  isSpamLikeMessage,
  looksLikeSpamSender,
  parseAddressList,
  type ContactSourceMessage,
} from '@/lib/mail/contacts'
import { addressInEntry, addressesIn, applyRecipient, emailAtCaret, matchMailContacts, recipientTokenAt, searchSenderAddresses, senderAddress, senderName, splitAddressList, suggestionPeople } from '@/lib/mail/contacts-shared'

const msg = (m: Partial<ContactSourceMessage>): ContactSourceMessage => ({ sent: false, from: '', to: 'me@team.test', cc: '', labelIds: ['INBOX'], ...m })
const OWN = ['me@team.test']

describe('parseAddressList', () => {
  it('reads names, quoted names with commas and bare addresses', () => {
    expect(parseAddressList('Jo Smith <Jo@X.com>, "Lee, Sam" <sam@y.com>; kim@z.com')).toEqual([
      { email: 'jo@x.com', name: 'Jo Smith' },
      { email: 'sam@y.com', name: 'Lee, Sam' },
      { email: 'kim@z.com', name: '' },
    ])
  })

  it('drops invalid entries and names that are just the address', () => {
    expect(parseAddressList('not an email, "a@b.com" <a@b.com>')).toEqual([{ email: 'a@b.com', name: '' }])
  })
})

describe('buildMailContacts', () => {
  it('uses people you emailed and senders who emailed you more than once, never your own address', () => {
    const contacts = buildMailContacts(
      [
        msg({ sent: true, labelIds: ['SENT'], from: 'me@team.test', to: 'Casey <casey@client.com>', cc: 'me@team.test' }),
        msg({ from: 'Dan Lee <dan@other.com>', to: 'me@team.test', cc: 'cc-only@other.com' }),
        msg({ from: 'dan@other.com', to: 'me@team.test' }),
        msg({ from: 'Once <once@other.com>', to: 'me@team.test' }),
      ],
      OWN,
    )
    expect(contacts).toEqual([
      { email: 'casey@client.com', name: 'Casey' },
      { email: 'dan@other.com', name: 'Dan Lee' },
    ])
  })

  it('leaves out marketing and account emails', () => {
    const contacts = buildMailContacts(
      [
        msg({ from: 'Shop <deals@shop.com>', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
        msg({ from: 'Xero <messaging@xero.com>', labelIds: ['INBOX', 'CATEGORY_UPDATES'] }),
        msg({ from: 'News <hello@brand.com>', listUnsubscribe: '<mailto:u@brand.com>' }),
        msg({ from: 'Google <no-reply@accounts.google.com>' }),
        msg({ from: 'Stripe <billing@stripe.com>' }),
        msg({ from: 'Real Person <real@person.com>' }),
        msg({ from: 'Real Person <real@person.com>' }),
        // Even when you wrote to one, a no-reply/account mailbox is not a person.
        msg({ sent: true, labelIds: ['SENT'], to: 'noreply@app.com, accounts@vendor.com' }),
      ],
      OWN,
    )
    expect(contacts.map((c) => c.email)).toEqual(['real@person.com'])
  })

  it('ranks people you emailed first, then by how often, then most recent', () => {
    const contacts = buildMailContacts(
      [
        msg({ from: 'often@x.com' }),
        msg({ from: 'new@x.com' }),
        msg({ from: 'often@x.com' }),
        msg({ from: 'often@x.com' }),
        msg({ from: 'new@x.com' }),
        msg({ sent: true, labelIds: ['SENT'], to: 'wrote@x.com' }),
      ],
      OWN,
    )
    expect(contacts.map((c) => c.email)).toEqual(['wrote@x.com', 'often@x.com', 'new@x.com'])
  })
})

describe('matchMailContacts', () => {
  const contacts = [
    { email: 'casey@client.com', name: 'Casey Brown' },
    { email: 'cameron@agency.com', name: '' },
    { email: 'jo@brookco.com', name: 'Jo Smith' },
  ]

  it('waits for two letters', () => {
    expect(matchMailContacts(contacts, 'c')).toEqual([])
    expect(matchMailContacts(contacts, 'ca').map((c) => c.email)).toEqual(['casey@client.com', 'cameron@agency.com'])
  })

  it('matches name words and domains, and skips addresses already added', () => {
    expect(matchMailContacts(contacts, 'bro').map((c) => c.email)).toEqual(['casey@client.com', 'jo@brookco.com'])
    expect(matchMailContacts(contacts, 'agen').map((c) => c.email)).toEqual(['cameron@agency.com'])
    expect(matchMailContacts(contacts, 'ca', new Set(['casey@client.com'])).map((c) => c.email)).toEqual(['cameron@agency.com'])
  })
})

describe('recipient field editing', () => {
  it('replaces only the address being typed and leaves room for the next', () => {
    const value = 'a@b.com, car'
    const token = recipientTokenAt(value, value.length)
    expect(token.text).toBe('car')
    expect(applyRecipient(value, token, 'casey@client.com')).toEqual({ value: 'a@b.com, casey@client.com, ', caret: 27 })
    expect(addressesIn('A@B.com, x')).toEqual(new Set(['a@b.com']))
  })

  it('finds the address under the caret, including one written with a name', () => {
    const list = 'frank@ledgerworks.com.au, simon@brightclinic.example'
    const simon = list.indexOf('simon@')
    expect(emailAtCaret(list, simon + 3)).toEqual({
      email: 'simon@brightclinic.example',
      start: simon,
      end: simon + 'simon@brightclinic.example'.length,
    })
    const named = 'Frank <Frank@Solve.com.au>'
    expect(emailAtCaret(named, 1)?.email).toBe('Frank@Solve.com.au')
    expect(emailAtCaret('still typing', 4)).toBeNull()
  })

  it('reads a header name and the address beside it, including quoted names', () => {
    expect(senderName('Saul Morgan <saul@acmeclient.com.au>')).toBe('Saul Morgan')
    expect(senderAddress('Saul Morgan <saul@acmeclient.com.au>')).toBe('saul@acmeclient.com.au')
    expect(senderName('"Pat Lee" <pat@ourteam.example>')).toBe('Pat Lee')
    expect(addressInEntry('"Pat Lee" <pat@ourteam.example>')).toBe('pat@ourteam.example')
    expect(addressInEntry('not an address')).toBeNull()
    expect(splitAddressList('"Lee, Sam" <sam@y.com>, bare@z.com')).toEqual(['"Lee, Sam" <sam@y.com>', ' bare@z.com'])
  })
})

describe('buildFrequentSenders', () => {
  const from = (sender: string, extra: Partial<ContactSourceMessage> = {}) => msg({ from: sender, to: 'me@team.test', ...extra })

  it('lists people who emailed you more than once, most emails first', () => {
    const senders = buildFrequentSenders(
      [
        from('Rebecca Stone <rebecca@acmeclient.com.au>'),
        from('dan@other.com'),
        from('Rebecca Stone <rebecca@acmeclient.com.au>'),
        from('Dan Lee <dan@other.com>'),
        from('Rebecca Stone <rebecca@acmeclient.com.au>'),
        from('dan@other.com'),
        from('Rebecca Stone <rebecca@acmeclient.com.au>'),
        from('Twice <twice@x.com>'),
        from('Twice <twice@x.com>'),
        from('Once <once@x.com>'),
        // Your own sent mail never counts towards anyone.
        msg({ sent: true, labelIds: ['SENT'], from: 'me@team.test', to: 'once@x.com' }),
        from('me@team.test'),
        from('me@team.test'),
        from('me@team.test'),
      ],
      OWN,
    )
    expect(senders).toEqual([
      { email: 'rebecca@acmeclient.com.au', name: 'Rebecca Stone' },
      { email: 'dan@other.com', name: 'Dan Lee' },
      { email: 'twice@x.com', name: 'Twice' },
    ])
  })

  it('leaves out marketing and automated senders however often they email', () => {
    const promo = Array.from({ length: 4 }, () => from('Shop <deals@shop.com>', { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }))
    const noReply = Array.from({ length: 4 }, () => from('Calendly <no-reply@calendly.com>'))
    expect(buildFrequentSenders([...promo, ...noReply], OWN)).toEqual([])
  })
})

describe('searchSenderAddresses', () => {
  it('finds people by part of their name, frequent senders first, without repeats', () => {
    const senders = [{ email: 'rebecca@acmeclient.com.au', name: 'Rebecca Stone' }]
    const contacts = [
      { email: 'casey@acmeclient.com.au', name: 'Casey Morgan' },
      { email: 'rebecca@acmeclient.com.au', name: 'Rebecca Stone' },
      { email: 'rebecca@x.com', name: '' },
    ]
    expect(searchSenderAddresses(senders, contacts, 'rebe')).toEqual(['rebecca@acmeclient.com.au', 'rebecca@x.com'])
    expect(searchSenderAddresses(senders, contacts, 'ston')).toEqual(['rebecca@acmeclient.com.au'])
    expect(searchSenderAddresses(senders, contacts, 'acmeclient')).toEqual(['rebecca@acmeclient.com.au', 'casey@acmeclient.com.au'])
    expect(searchSenderAddresses(senders, contacts, 'r')).toEqual([])
  })
})

describe('spam and shared-inbox senders', () => {
  it('never learns hello@ style shared inboxes, spam-looking or undisclosed-recipient senders from received mail', () => {
    const twice = (m: Partial<ContactSourceMessage>) => [msg(m), msg(m)]
    const contacts = buildMailContacts(
      [
        ...twice({ from: 'Brand <hello@brand.com>' }),
        ...twice({ from: 'Info <info@agency.com>' }),
        ...twice({ from: 'Offers <jane@news.brand.com>' }),
        ...twice({ from: 'x7fk3q9z2wbt@spam.biz' }),
        ...twice({ from: 'user84733921@cheap.biz' }),
        ...twice({ from: 'Mass <mass@x.com>', to: 'undisclosed-recipients:;' }),
        ...twice({ from: 'Real <real@person.com>' }),
        // You emailed this shared inbox yourself, so it stays suggestible.
        msg({ sent: true, labelIds: ['SENT'], to: 'hello@client.com' }),
      ],
      OWN,
    )
    expect(contacts.map((c) => c.email)).toEqual(['hello@client.com', 'real@person.com'])
    expect(buildFrequentSenders([...twice({ from: 'hello@brand.com' }), ...twice({ from: 'real@person.com' })], OWN).map((c) => c.email)).toEqual([
      'real@person.com',
    ])
  })

  it('tells bulk-mailer addresses apart from ordinary ones', () => {
    expect(looksLikeSpamSender('jane@news.brand.com')).toBe(true)
    expect(looksLikeSpamSender('bounce=123@mailer.x.com')).toBe(true)
    expect(looksLikeSpamSender('jane.smith@brand.com')).toBe(false)
    expect(looksLikeSpamSender('editor@news.com.au')).toBe(false)
    expect(looksLikeSpamSender('rebecca@acmeclient.com.au')).toBe(false)
    expect(isSpamLikeMessage({ to: '', cc: '' })).toBe(true)
    expect(isSpamLikeMessage({ to: 'me@team.test', cc: '' })).toBe(false)
  })
})

describe('address suggestions', () => {
  const people = [
    { email: 'casey@acmeclient.com.au', name: 'Casey' },
    { email: 'jo@client.com', name: 'Jo' },
  ]

  it('matches the part after the @ when the text starts with @, and partial addresses with an @', () => {
    expect(matchMailContacts(people, '@acmec').map((c) => c.email)).toEqual(['casey@acmeclient.com.au'])
    expect(matchMailContacts(people, 'jo@cl').map((c) => c.email)).toEqual(['jo@client.com'])
    expect(matchMailContacts(people, '@')).toEqual([])
  })

  it('suggests regular senders first, then everyone else, each once', () => {
    expect(
      suggestionPeople({ senders: [people[1]!], contacts: [people[0]!, people[1]!] }).map((c) => c.email),
    ).toEqual(['jo@client.com', 'casey@acmeclient.com.au'])
  })
})
