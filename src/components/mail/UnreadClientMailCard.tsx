'use client'

import { useCallback, useEffect, useState } from 'react'
import { senderLabel } from '../../lib/mail/client-email-alerts'
import { mailThreadPath } from '../../lib/mail/drafts'
import styles from './UnreadClientMailCard.module.css'

/**
 * Dashboard "Unread client emails" panel (Payload afterDashboard).
 *
 * Lists unread inbox emails from clients (senders on a client's website or
 * contact domains, plus senders starred as clients in Mail), via
 * GET /api/mail/client-unread (live Gmail, metadata only). Users
 * without the Mail feature see nothing; Gmail not connected shows a connect
 * link. Each row opens the thread in Mail.
 */

interface UnreadClientEmail {
  threadId: string
  from: string
  subject: string
  date: string
  messageCount: number
}

interface ClientUnreadResponse {
  clientSenderCount: number
  emails: UnreadClientEmail[]
  more: boolean
}

type CardState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'error'; message: string; connectUrl?: string }
  | { status: 'ready'; data: ClientUnreadResponse }

const GMAIL_SETUP_ERRORS = new Set(['gmail-not-connected', 'scope-insufficient'])

/** The API reason is also read by agents/tools, so it is reworded here rather than on the server. */
const GMAIL_NOT_CONNECTED_COPY = 'Gmail isn\u2019t connected yet. Connect it to see client emails here.'

function setupMessage(error: string, reason: string | undefined): string {
  if (error === 'gmail-not-connected' || (reason && /gmail not connected for this user/i.test(reason))) {
    return GMAIL_NOT_CONNECTED_COPY
  }
  return reason || 'Connect Gmail to see unread client emails.'
}

const connectButton = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 44,
  padding: '0 18px',
  borderRadius: 8,
  background: '#0b5394',
  color: '#fff',
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'none',
} as const

function isClientUnreadResponse(value: unknown): value is ClientUnreadResponse {
  const v = value as Partial<ClientUnreadResponse> | null
  return Boolean(v) && typeof v?.clientSenderCount === 'number' && Array.isArray(v?.emails)
}

function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

async function loadClientUnread(signal: AbortSignal): Promise<CardState> {
  const res = await fetch('/api/mail/client-unread', { credentials: 'include', signal })
  const body = (await res.json().catch(() => null)) as
    | (Partial<ClientUnreadResponse> & { error?: string; reason?: string; connectUrl?: string })
    | null
  if (res.ok) {
    return isClientUnreadResponse(body)
      ? { status: 'ready', data: body }
      : { status: 'error', message: 'Unexpected response from Mail.' }
  }
  if (body?.error && GMAIL_SETUP_ERRORS.has(body.error)) {
    return {
      status: 'error',
      message: setupMessage(body.error, body.reason),
      connectUrl: body.connectUrl,
    }
  }
  // Not logged in or no Mail feature: this panel is not for this user.
  if (res.status === 401 || res.status === 403) return { status: 'hidden' }
  return { status: 'error', message: body?.error || `Could not load unread client emails (${res.status}).` }
}

const mutedText = { color: 'var(--theme-elevation-400)', fontSize: 13, margin: 0 } as const
const headLink = { fontSize: 12, color: 'var(--theme-elevation-500)', textDecoration: 'none' } as const

export default function UnreadClientMailCard() {
  const [state, setState] = useState<CardState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    loadClientUnread(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setState(next)
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error', message: 'Could not load unread client emails.' })
      })
    return () => controller.abort()
  }, [attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  if (state.status === 'hidden') return null

  const emails = state.status === 'ready' ? state.data.emails : []

  return (
    <section
      className={`${styles.box}${state.status === 'loading' ? ` ${styles.muted}` : ''}`}
      aria-label="Unread client emails"
      aria-busy={state.status === 'loading'}
    >
      <div className={styles.head}>
        <div>
          <span className={styles.eyebrow}>Mail</span>
          <span className={styles.title}>Unread client emails</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {state.status === 'ready' && emails.length > 0 ? (
            <span className={styles.badge}>
              {emails.length}
              {state.data.more ? '+' : ''} unread
            </span>
          ) : null}
          <a href="/admin/mail" style={headLink}>
            Open Mail &rarr;
          </a>
        </div>
      </div>
      <div className={styles.body}>
        {state.status === 'loading' ? (
          <p style={mutedText}>Loading unread client emails...</p>
        ) : state.status === 'error' ? (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <p style={{ ...mutedText, color: state.connectUrl ? 'var(--theme-elevation-800)' : 'var(--theme-error-500, #dc2626)' }}>
              {state.message}
            </p>
            {state.connectUrl ? (
              <a href={state.connectUrl} style={connectButton}>
                Connect Gmail
              </a>
            ) : (
              <button type="button" className={styles.retry} onClick={retry}>
                Retry
              </button>
            )}
          </div>
        ) : state.data.clientSenderCount === 0 ? (
          <p style={mutedText}>
            No client senders yet. Add a Website URL to a client, or open an email in{' '}
            <a href="/admin/mail" style={{ color: 'inherit', textDecoration: 'underline' }}>
              Mail
            </a>{' '}
            and click ☆ Mark as client.
          </p>
        ) : emails.length === 0 ? (
          <p style={mutedText}>No unread emails from clients.</p>
        ) : (
          <ul className={styles.list}>
            {emails.map((email) => {
              const sender = senderLabel(email.from) || 'Unknown sender'
              const subject = `${email.subject || '(no subject)'}${email.messageCount > 1 ? ` (${email.messageCount})` : ''}`
              return (
                <li key={email.threadId}>
                  <a href={mailThreadPath(email.threadId)} className={styles.row} title={`${sender}: ${subject}`}>
                    <b className={styles.sender}>{sender}</b>
                    <span className={styles.subject}>{subject}</span>
                    <span className={styles.date}>{shortDate(email.date)}</span>
                  </a>
                </li>
              )
            })}
          </ul>
        )}
        {state.status === 'ready' && state.data.more ? (
          <p style={{ ...mutedText, fontSize: 12, marginTop: 12 }}>
            More unread client emails in{' '}
            <a href="/admin/mail" style={{ color: 'inherit', textDecoration: 'underline' }}>
              Mail
            </a>
            .
          </p>
        ) : null}
      </div>
    </section>
  )
}
