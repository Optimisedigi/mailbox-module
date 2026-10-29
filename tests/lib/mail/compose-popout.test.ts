import { describe, expect, it } from 'vitest'
import {
  composePopoutPath,
  isPopoutReady,
  parsePopoutId,
  popoutReadyMessage,
  popoutStateMessage,
  readPopoutState,
} from '@/lib/mail/compose-popout'
import type { ComposeState } from '@/components/mail/ComposeWindow'

const STATE: ComposeState = { mode: 'new', replyTo: null, to: 'jo@x.com', cc: '', subject: 'Hi', html: '<p>Hello</p>', attachments: [], draftId: 'd1' }

describe('compose pop-out handoff', () => {
  it('builds the window path with the handoff id and account', () => {
    expect(composePopoutPath('abc12345-6789')).toBe('/admin/mail/window?compose=abc12345-6789')
    expect(composePopoutPath('abc12345-6789', 'sales@team.test')).toBe('/admin/mail/window?compose=abc12345-6789&account=sales%40team.test')
    expect(parsePopoutId('abc12345-6789')).toBe('abc12345-6789')
    expect(parsePopoutId('x')).toBeNull()
    expect(parsePopoutId('<script>alert(1)</script>')).toBeNull()
  })

  it('only accepts messages for the same id that look like a compose window', () => {
    expect(isPopoutReady(popoutReadyMessage('id-123456'), 'id-123456')).toBe(true)
    expect(isPopoutReady(popoutReadyMessage('id-other1'), 'id-123456')).toBe(false)
    expect(readPopoutState(popoutStateMessage('id-123456', STATE), 'id-123456')).toEqual(STATE)
    expect(readPopoutState(popoutStateMessage('id-123456', STATE), 'id-999999')).toBeNull()
    expect(readPopoutState({ type: 'mailbox:mail-compose-state', id: 'id-123456', state: { ...STATE, to: 5 } }, 'id-123456')).toBeNull()
    expect(readPopoutState({ type: 'mailbox:mail-compose-state', id: 'id-123456', state: { ...STATE, attachments: [{ name: 'a' }] } }, 'id-123456')).toBeNull()
    expect(readPopoutState(null, 'id-123456')).toBeNull()
  })
})
