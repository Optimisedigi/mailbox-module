import { describe, expect, it } from 'vitest'
import { mailDraftPath, mailThreadPath, mailWindowPath } from '@/lib/mail/drafts'

describe('Mail links', () => {
  it('opens a thread, in an extra account when given', () => {
    expect(mailThreadPath('19a2b3c4d5')).toBe('/admin/mail?thread=19a2b3c4d5')
    expect(mailThreadPath('19a2b3c4d5', 'sales@team.test')).toBe('/admin/mail?thread=19a2b3c4d5&account=sales%40team.test')
  })

  it('opens the single-email window and a Gmail draft in the compose window', () => {
    expect(mailWindowPath('19a2b3c4d5')).toBe('/admin/mail/window?thread=19a2b3c4d5')
    expect(mailDraftPath('19a2b3c4d5')).toBe('/admin/mail?draft=19a2b3c4d5')
  })
})
