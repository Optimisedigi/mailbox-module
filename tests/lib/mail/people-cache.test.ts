import { beforeEach, describe, expect, it } from 'vitest'
import { loadSavedPeople, PEOPLE_MAX_AGE_MS, PEOPLE_REFRESH_MS, peopleNeedRefresh, savePeople } from '@/lib/mail/people-cache'

const PEOPLE = {
  contacts: [{ email: 'jo@client.com', name: 'Jo Lee' }],
  senders: [{ email: 'rebecca@acl.com.au', name: 'Rebecca' }],
}

beforeEach(() => localStorage.clear())

describe('saved search people', () => {
  it('keeps one list per Gmail account and reads it back', () => {
    savePeople(localStorage, '', PEOPLE, 1000)
    savePeople(localStorage, 'Sales@Team.test', { contacts: [], senders: [{ email: 's@x.com', name: '' }] }, 1000)
    expect(loadSavedPeople(localStorage, '', 2000)).toEqual({ ...PEOPLE, savedAt: 1000 })
    expect(loadSavedPeople(localStorage, 'sales@team.test', 2000)?.senders).toEqual([{ email: 's@x.com', name: '' }])
    expect(loadSavedPeople(localStorage, 'other@team.test', 2000)).toBeNull()
  })

  it('drops a list that is too old, from the future, or not readable, and only keeps names and addresses', () => {
    savePeople(localStorage, '', PEOPLE, 1000)
    expect(loadSavedPeople(localStorage, '', 1000 + PEOPLE_MAX_AGE_MS + 1)).toBeNull()
    expect(localStorage.length).toBe(0)
    savePeople(localStorage, '', PEOPLE, 5000)
    expect(loadSavedPeople(localStorage, '', 1000)).toBeNull()
    localStorage.setItem('mail-search-people:main', '{not json')
    expect(loadSavedPeople(localStorage, '', 1000)).toBeNull()
    localStorage.setItem(
      'mail-search-people:main',
      JSON.stringify({ savedAt: 1, senders: [{ email: 'a@b.com', name: 'A', body: 'secret' }, { email: 5 }], contacts: 'x' }),
    )
    expect(loadSavedPeople(localStorage, '', 2)).toEqual({ contacts: [], senders: [{ email: 'a@b.com', name: 'A' }], savedAt: 1 })
    expect(loadSavedPeople(null, '', 2)).toBeNull()
  })

  it('only asks Gmail again once the saved list is a few hours old', () => {
    savePeople(localStorage, '', PEOPLE, 1000)
    const saved = loadSavedPeople(localStorage, '', 2000)
    expect(peopleNeedRefresh(saved, 2000)).toBe(false)
    expect(peopleNeedRefresh(saved, 1000 + PEOPLE_REFRESH_MS)).toBe(true)
    expect(peopleNeedRefresh(null, 2000)).toBe(true)
  })
})
