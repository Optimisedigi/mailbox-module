import { describe, expect, it } from 'vitest'
import { cleanTagName, findTagByName, parseTagId, senderMatchesSearch } from '@/lib/mail/tags'

describe('mail tags', () => {
  it('accepts only Gmail user label ids', () => {
    expect(parseTagId('Label_12')).toBe('Label_12')
    expect(parseTagId(' Label_3 ')).toBe('Label_3')
    for (const bad of ['INBOX', 'TRASH', 'Label_', 'Label_1 OR x', 'label_1', 12, null]) expect(parseTagId(bad)).toBeNull()
  })

  it('tidies tag names and refuses empty, too long or control characters', () => {
    expect(cleanTagName('  Baby   reads \n')).toBe('Baby reads')
    expect(cleanTagName('   ')).toBeNull()
    expect(cleanTagName('x'.repeat(41))).toBeNull()
    expect(cleanTagName('a\u0000b')).toBeNull()
    expect(cleanTagName(5)).toBeNull()
  })

  it('finds a saved tag by name, ignoring case', () => {
    const tags = [{ id: 'Label_1', name: 'Baby reads' }]
    expect(findTagByName(tags, ' baby READS ')?.id).toBe('Label_1')
    expect(findTagByName(tags, 'Work')).toBeUndefined()
  })

  it('matches a sender by name, address or subject, every word', () => {
    const sender = { name: 'Erin Olsen', address: 'emily@familyfacts.org', subjects: ['Sleep training, the data'] }
    expect(senderMatchesSearch(sender, 'emily')).toBe(true)
    expect(senderMatchesSearch(sender, 'familyfacts')).toBe(true)
    expect(senderMatchesSearch(sender, 'SLEEP data')).toBe(true)
    expect(senderMatchesSearch(sender, 'emily invoice')).toBe(false)
    expect(senderMatchesSearch(sender, '  ')).toBe(false)
  })
})
