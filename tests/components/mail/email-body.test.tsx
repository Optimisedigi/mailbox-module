import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import EmailBody from '@/components/mail/EmailBody'

afterEach(cleanup)

/**
 * jsdom has no layout, so fake the document's scrollHeight the way browsers
 * report it: never less than the frame itself (its viewport).
 */
function fakeLayout(frame: HTMLIFrameElement, contentHeight: number) {
  const root = frame.contentDocument?.documentElement
  if (!root) throw new Error('no frame document')
  Object.defineProperty(root, 'scrollHeight', {
    configurable: true,
    get: () => Math.max(contentHeight, Number.parseInt(frame.style.height || '0', 10)),
  })
}

describe('EmailBody', () => {
  it('sizes the frame to the email, not to itself, so there is no empty space to scroll past', () => {
    render(<EmailBody html="<p>Hi</p>" title="Email" />)
    const frame = screen.getByTitle('Email') as HTMLIFrameElement
    fakeLayout(frame, 120)
    fireEvent.load(frame)
    expect(frame.style.height).toBe('124px')
    // Refitting (images loading, resizes) never makes it grow on its own.
    fireEvent.load(frame)
    fireEvent.load(frame)
    expect(frame.style.height).toBe('124px')
  })

  it('shrinks when the content is shorter than the frame', () => {
    render(<EmailBody html="<p>Hi</p>" title="Email" />)
    const frame = screen.getByTitle('Email') as HTMLIFrameElement
    fakeLayout(frame, 80)
    fireEvent.load(frame)
    expect(frame.style.height).toBe('84px')
  })

  it('stops full-height templates from sizing the email to the frame', () => {
    render(<EmailBody html="<p>Hi</p>" title="Email" />)
    const frame = screen.getByTitle('Email') as HTMLIFrameElement
    fakeLayout(frame, 80)
    fireEvent.load(frame)
    const styles = Array.from(frame.contentDocument?.querySelectorAll('style') ?? []).map((style) => style.textContent)
    expect(styles).toContain('html,body{height:auto !important;min-height:0 !important;}')
  })
})
