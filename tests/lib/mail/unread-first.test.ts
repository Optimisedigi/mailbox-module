import { describe, expect, it } from 'vitest'
import { unreadFirst } from '@/lib/mail/folders'

describe('unreadFirst', () => {
  it('puts unread threads on top and keeps newest-first order within each group', () => {
    const rows = [
      { id: 'a', unread: false },
      { id: 'b', unread: true },
      { id: 'c', unread: false },
      { id: 'd', unread: true },
    ]
    expect(unreadFirst(rows).map((row) => row.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
