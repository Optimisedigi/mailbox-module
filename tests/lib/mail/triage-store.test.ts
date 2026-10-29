import { beforeEach, describe, expect, it } from 'vitest'
import { loadSavedTriage, saveTriage, TRIAGE_MAX_AGE_MS, type SavedTriage } from '@/lib/mail/triage-store'

const triage = (messageIds: string[], savedAt = 1000): SavedTriage => ({
  savedAt,
  selected: ['ann@seo.io'],
  result: {
    scanned: messageIds.length,
    truncated: false,
    failedBatches: 0,
    categories: [
      {
        key: 'ai-1',
        label: 'Sales pitches',
        count: messageIds.length,
        defaultSelected: true,
        senders: [{ address: 'ann@seo.io', name: 'Ann', count: messageIds.length, subjects: ['Rank #1'], messageIds }],
      },
    ],
  },
})

beforeEach(() => localStorage.clear())

describe('saved triage', () => {
  it('keeps one triage per account, and a new run replaces the old one', () => {
    saveTriage(localStorage, '', triage(['a1', 'a2']))
    saveTriage(localStorage, 'Sales@Team.test', triage(['s1']))
    saveTriage(localStorage, '', triage(['a3'], 2000))
    expect(loadSavedTriage(localStorage, '', 3000)).toEqual(triage(['a3'], 2000))
    expect(loadSavedTriage(localStorage, 'sales@team.test', 3000)?.result.categories[0]?.senders[0]?.messageIds).toEqual(['s1'])
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '')
    expect(keys.filter((key) => key.startsWith('mail-triage:')).sort()).toEqual(['mail-triage:main', 'mail-triage:sales@team.test'])
  })

  it('deletes the triage once nothing is left to action', () => {
    saveTriage(localStorage, '', triage(['a1']))
    const done = triage([])
    done.result.categories = []
    saveTriage(localStorage, '', done)
    expect(localStorage.getItem('mail-triage:main')).toBeNull()
    expect(loadSavedTriage(localStorage, '', 2000)).toBeNull()
  })

  it('drops a triage that is too old, from the future or not readable', () => {
    saveTriage(localStorage, '', triage(['a1']))
    expect(loadSavedTriage(localStorage, '', 1000 + TRIAGE_MAX_AGE_MS + 1)).toBeNull()
    expect(localStorage.getItem('mail-triage:main')).toBeNull()
    saveTriage(localStorage, '', triage(['a1'], 5000))
    expect(loadSavedTriage(localStorage, '', 1000)).toBeNull()
    localStorage.setItem('mail-triage:main', JSON.stringify({ savedAt: 1, selected: [], result: { categories: [{ key: 1 }] } }))
    expect(loadSavedTriage(localStorage, '', 2)).toBeNull()
    localStorage.setItem('mail-triage:main', '{nope')
    expect(loadSavedTriage(localStorage, '', 2)).toBeNull()
    expect(loadSavedTriage(null, '', 2)).toBeNull()
  })
})
