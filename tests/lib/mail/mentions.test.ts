import { describe, expect, it } from 'vitest'
import { matchMentionContacts, mentionLabel, type MailContact } from '@/lib/mail/contacts-shared'

const people: MailContact[] = [
  { email: 'rebecca@acmeclient.com.au', name: 'Rebecca Jones' },
  { email: 'john.smith@client.com', name: 'John Smith' },
  { email: 'accounts@client.com', name: '' },
]

describe('matchMentionContacts', () => {
  it('matches from the first letter on a name, a word of it, or the address', () => {
    expect(matchMentionContacts(people, 'r').map((c) => c.email)).toEqual(['rebecca@acmeclient.com.au'])
    expect(matchMentionContacts(people, 'smi').map((c) => c.email)).toEqual(['john.smith@client.com'])
    expect(matchMentionContacts(people, 'acc').map((c) => c.email)).toEqual(['accounts@client.com'])
  })

  it('matches a first and partial last name, and nothing for empty or unmatched text', () => {
    expect(matchMentionContacts(people, 'John  Sm').map((c) => c.email)).toEqual(['john.smith@client.com'])
    expect(matchMentionContacts(people, 'john and then more')).toEqual([])
    expect(matchMentionContacts(people, '  ')).toEqual([])
  })
})

describe('mentionLabel', () => {
  it('uses the name, else the part of the address before the @', () => {
    expect(mentionLabel(people[0]!)).toBe('Rebecca Jones')
    expect(mentionLabel(people[2]!)).toBe('accounts')
  })
})
