'use client'

import { useCallback, useEffect, useState } from 'react'
import { useDocumentInfo } from '@payloadcms/ui'
import styles from './MailApp.module.css'
import ClientEmailBriefPanel, { type ClientEmailBrief } from './ClientEmailBriefPanel'

/**
 * Client profile → Emails tab. "What we've discussed" (Pull emails, the
 * brief and questions; see ClientEmailBriefPanel) sits on top. Lists emails linked to this client (by the
 * Mail view's domain matching or manual assignment) and the email timeline of
 * confirmed summaries. "Summarise to timeline" sends only that one email to
 * the model, shows the result for review, and saves only on "Add to timeline".
 */

interface StoredEmail {
  id: number
  gmailMessageId: string
  direction?: 'inbound' | 'outbound'
  matchedBy?: 'auto' | 'manual'
  matchedOn?: string
  from?: string
  to?: string
  cc?: string
  subject?: string
  date?: string
  body?: string
  gmailLink?: string
}

interface StoredSummary {
  id: number
  email: number | { id: number }
  summary: string
  emailDate?: string
  createdAt: string
}

function fmt(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function ClientEmailsPanel() {
  const { id } = useDocumentInfo()
  const [emails, setEmails] = useState<StoredEmail[]>([])
  const [summaries, setSummaries] = useState<StoredSummary[]>([])
  const [briefs, setBriefs] = useState<ClientEmailBrief[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [review, setReview] = useState<{ emailId: number; text: string; model: string; busy: boolean; note: string } | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const res = await fetch(`/api/mail/client-emails?clientId=${encodeURIComponent(String(id))}`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load emails.')
      setEmails(data.emails)
      setSummaries(data.summaries)
      setBriefs(data.briefs ?? [])
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  async function summarise(emailId: number) {
    setReview({ emailId, text: '', model: '', busy: true, note: '' })
    try {
      const res = await fetch('/api/mail/summarise', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmailId: emailId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Summary failed.')
      setReview({ emailId, text: data.summary, model: data.model, busy: false, note: '' })
    } catch (err) {
      setReview({ emailId, text: '', model: '', busy: false, note: (err as Error).message })
    }
  }

  async function confirm() {
    if (!review || !review.text.trim()) return
    setReview({ ...review, busy: true })
    try {
      const res = await fetch('/api/mail/summaries', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEmailId: review.emailId, summary: review.text, model: review.model }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not save the summary.')
      setReview(null)
      await load()
    } catch (err) {
      setReview({ ...review, busy: false, note: (err as Error).message })
    }
  }

  if (!id) return <p className={styles.muted}>Save the client first.</p>

  const emailById = new Map(emails.map((email) => [email.id, email]))

  return (
    <div className={styles.app} style={{ padding: '8px 0' }}>
      {error ? <p className={styles.errorText}>{error}</p> : null}

      <ClientEmailBriefPanel clientId={id} briefs={briefs} hasEmails={emails.length > 0} onPulled={load} />

      <section>
        <h3 className={styles.panelTitle}>Email timeline</h3>
        {summaries.length === 0 ? (
          <p className={styles.muted}>No summaries yet. Use “Summarise to timeline” on an email below.</p>
        ) : (
          <ul className={styles.list} style={{ maxHeight: 'none' }}>
            {summaries.map((item) => {
              const sourceId = typeof item.email === 'object' ? item.email.id : item.email
              const source = emailById.get(sourceId)
              return (
                <li key={item.id} className={styles.row} style={{ cursor: 'default' }}>
                  <span className={styles.rowTop}>
                    <span className={styles.subject}>{source?.subject || 'Email'}</span>
                    <span className={styles.date}>{fmt(item.emailDate || item.createdAt)}</span>
                  </span>
                  <span>{item.summary}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section>
        <h3 className={styles.panelTitle}>Emails</h3>
        <p className={styles.muted}>
          Linked automatically when a sender or recipient is on this client’s website domain or is a client contact. Open Mail to sync.
        </p>
        {loading ? <p className={styles.muted}>Loading…</p> : null}
        {!loading && emails.length === 0 ? <p className={styles.muted}>No emails linked yet.</p> : null}
        <ul className={styles.list} style={{ maxHeight: 'none' }}>
          {emails.map((email) => (
            <li key={email.id}>
              <button type="button" className={styles.row} onClick={() => setOpenId(openId === email.id ? null : email.id)}>
                <span className={styles.rowTop}>
                  <span className={styles.sender}>
                    {email.direction === 'outbound' ? `To ${email.to}` : email.from}
                  </span>
                  <span className={styles.date}>{fmt(email.date)}</span>
                </span>
                <span className={styles.subject}>{email.subject || '(no subject)'}</span>
              </button>
              {openId === email.id ? (
                <div className={styles.message} style={{ margin: '0 12px 12px' }}>
                  <div className={styles.muted}>
                    From {email.from} · To {email.to}
                    {email.cc ? ` · Cc ${email.cc}` : ''} · {email.matchedBy === 'manual' ? 'Assigned manually' : `Matched on ${email.matchedOn}`}
                  </div>
                  <pre className={styles.body} style={{ marginTop: 8 }}>{email.body}</pre>
                  <div className={styles.messageFoot}>
                    <button type="button" className={styles.linkBtn} onClick={() => void summarise(email.id)} disabled={review?.busy}>
                      Summarise to timeline
                    </button>
                    {email.gmailLink ? (
                      <a className={styles.linkBtn} href={email.gmailLink} target="_blank" rel="noreferrer">
                        Open in Gmail
                      </a>
                    ) : null}
                  </div>
                  {review?.emailId === email.id ? (
                    <div className={styles.panel}>
                      <p className={styles.muted}>The AI saw only this one email. Review and edit before adding.</p>
                      {review.busy && !review.text ? <p className={styles.muted}>Summarising…</p> : null}
                      {review.text || !review.busy ? (
                        <textarea
                          className={styles.textarea}
                          rows={4}
                          value={review.text}
                          onChange={(e) => setReview({ ...review, text: e.target.value })}
                        />
                      ) : null}
                      {review.note ? <p className={styles.errorText}>{review.note}</p> : null}
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.primary}`}
                          disabled={review.busy || !review.text.trim()}
                          onClick={() => void confirm()}
                        >
                          Add to timeline
                        </button>
                        <button type="button" className={styles.btn} onClick={() => setReview(null)}>
                          Discard
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
