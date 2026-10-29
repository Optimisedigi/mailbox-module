import { describe, expect, it } from 'vitest'
import { clearPrompt, loadPrompt, promptKeys, savePrompt } from '@/lib/mail/ai-prompt-store'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

describe('ai-prompt-store', () => {
  it('keys a reply by the message, then its draft', () => {
    expect(promptKeys({ mode: 'reply', replyToMessageId: 'm1', draftId: 'd1', startedNew: false })).toEqual(['reply:m1', 'draft:d1'])
    expect(promptKeys({ mode: 'new', startedNew: true })).toEqual(['new'])
    expect(promptKeys({ mode: 'new', draftId: 'd2', startedNew: true })).toEqual(['draft:d2', 'new'])
  })

  it('restores a new email prompt from its draft key after it became a draft', () => {
    const storage = memoryStorage()
    savePrompt(storage, promptKeys({ mode: 'new', draftId: 'd2', startedNew: true }), 'mention Thursday', 1000)
    expect(loadPrompt(storage, promptKeys({ mode: 'new', draftId: 'd2', startedNew: false }), 2000)).toBe('mention Thursday')
  })

  it('clears on empty text and expires after 30 days', () => {
    const storage = memoryStorage()
    savePrompt(storage, ['reply:m1'], 'shorter', 0)
    expect(loadPrompt(storage, ['reply:m1'], 31 * 24 * 60 * 60 * 1000)).toBe('')
    savePrompt(storage, ['reply:m1'], 'shorter', 0)
    clearPrompt(storage, ['reply:m1'])
    expect(storage.length).toBe(0)
  })

  it('never throws when storage is blocked or full', () => {
    const blocked = { ...memoryStorage(), setItem: () => { throw new Error('QuotaExceeded') } } as Storage
    expect(() => savePrompt(blocked, ['new'], 'x', 0)).not.toThrow()
    expect(loadPrompt(null, ['new'], 0)).toBe('')
  })
})
