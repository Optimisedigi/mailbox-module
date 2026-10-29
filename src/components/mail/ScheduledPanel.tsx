'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './MailApp.module.css'
import EmailBody from './EmailBody'
import SchedulePicker from './SchedulePicker'
import { buildEmailDocument } from '../../lib/mail/email-html'

/**
 * The Scheduled tab, laid out like Drafts: the queue on the left, the
 * selected email on the right with Edit, Send now, Change time and Cancel.
 * The list only carries recipient, subject and time; the body is loaded when
 * an email is opened. On phones the email slides over the list, with a back
 * button, like the inbox reader.
 */

export interface ScheduledItem {
  id: number
  to: string
  cc: string
  subject: string
  scheduledFor: string
  status: 'pending' | 'sending' | 'sent' | 'failed'
  lastError: string
  attachmentCount: number
  isReply: boolean
}

/** GET /api/mail/schedule/:id */
export interface ScheduledDetail {
  item: ScheduledItem
  replyToMessageId: string | null
  /** Body HTML with inline images as data: URLs. */
  html: string
  attachments: Array<{ name: string; mediaType: string; data: string }>
  bcc: string
  signOff?: string
  /** Queued without the Gmail signature. */
  noSignature?: boolean
  /** "Remind me if no reply" business days, when set. */
  followUpDays?: number
}

interface Props {
  items: ScheduledItem[]
  loading: boolean
  selectedId: number | null
  onSelect: (id: number | null) => void
  isMobile: boolean
  loadDetail: (id: number) => Promise<ScheduledDetail>
  onEdit: (detail: ScheduledDetail) => void
  onSendNow: (id: number) => Promise<void>
  onReschedule: (id: number, when: Date) => Promise<void>
  onCancel: (id: number) => Promise<void>
}

function whenLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

function statusLabel(item: ScheduledItem): string {
  if (item.status === 'failed') return 'Not sent'
  if (item.status === 'sending') return 'Sending now'
  return `Sends ${whenLabel(item.scheduledFor)}`
}

export default function ScheduledPanel({
  items,
  loading,
  selectedId,
  onSelect,
  isMobile,
  loadDetail,
  onEdit,
  onSendNow,
  onReschedule,
  onCancel,
}: Props) {
  const [detail, setDetail] = useState<ScheduledDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [busy, setBusy] = useState(false)
  const [changingTime, setChangingTime] = useState(false)
  const [note, setNote] = useState('')
  const request = useRef(0)
  const loadRef = useRef(loadDetail)
  loadRef.current = loadDetail

  const selected = items.find((item) => item.id === selectedId) ?? null
  // Reload the body when another email is opened or the list changed it (time, status).
  const selectedVersion = selected ? `${selected.id}|${selected.scheduledFor}|${selected.status}` : ''

  useEffect(() => {
    setChangingTime(false)
    setNote('')
    if (selectedId === null) {
      setDetail(null)
      return
    }
    const current = ++request.current
    setDetailLoading(true)
    setDetailError('')
    loadRef
      .current(selectedId)
      .then((data) => {
        if (current === request.current) setDetail(data)
      })
      .catch((err: unknown) => {
        if (current === request.current) setDetailError((err as Error).message)
      })
      .finally(() => {
        if (current === request.current) setDetailLoading(false)
      })
  }, [selectedId, selectedVersion])

  async function act(action: () => Promise<void>) {
    setBusy(true)
    setNote('')
    try {
      await action()
      setChangingTime(false)
    } catch (err) {
      setNote((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const open = isMobile && selected !== null
  const sending = selected?.status === 'sending'
  const shown = detail && selected && detail.item.id === selected.id ? detail : null

  return (
    <div className={styles.panes}>
      <ul className={styles.list} aria-label="Scheduled">
        {items.map((item) => (
          <li key={item.id} className={styles.rowItem}>
            <button
              type="button"
              className={`${styles.row} ${item.id === selectedId ? styles.selected : ''}`}
              onClick={() => onSelect(item.id)}
            >
              <span className={styles.rowTop}>
                <span className={styles.senderLine}>
                  <span className={styles.sender}>
                    <span className={item.status === 'failed' ? styles.draftTag : styles.scheduledTag}>
                      {item.status === 'failed' ? 'Not sent' : 'Scheduled'}
                    </span>
                    To {item.to || '(reply recipient)'}
                  </span>
                </span>
              </span>
              <span className={styles.subject}>{item.subject || '(no subject)'}</span>
              <span className={styles.snippet}>
                {statusLabel(item)}
                {item.attachmentCount > 0 ? ` · ${item.attachmentCount} attachment${item.attachmentCount === 1 ? '' : 's'}` : ''}
              </span>
            </button>
          </li>
        ))}
        {loading ? <li className={styles.empty}>Loading…</li> : null}
        {!loading && items.length === 0 ? <li className={styles.empty}>No scheduled emails.</li> : null}
      </ul>

      <section
        className={`${styles.reader} ${open ? styles.readerOpen : ''}`}
        aria-label="Scheduled email"
        aria-hidden={isMobile && !open ? true : undefined}
      >
        {isMobile && selected ? (
          <div className={styles.mobileBar}>
            <button type="button" className={styles.backBtn} onClick={() => onSelect(null)} aria-label="Back to scheduled">
              ‹ Scheduled
            </button>
          </div>
        ) : null}
        {!selected ? (
          <p className={styles.empty}>Select a scheduled email to see or edit it.</p>
        ) : (
          <>
            <div className={styles.readerHead}>
              <h2 className={styles.threadSubject}>{selected.subject || '(no subject)'}</h2>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.primary}`}
                  disabled={busy || sending || !shown}
                  onClick={() => shown && onEdit(shown)}
                >
                  Edit
                </button>
                <button type="button" className={styles.btn} disabled={busy || sending} onClick={() => void act(() => onSendNow(selected.id))}>
                  {busy ? 'Working…' : selected.status === 'failed' ? 'Retry now' : 'Send now'}
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={busy || sending}
                  onClick={() => setChangingTime((open) => !open)}
                  aria-expanded={changingTime}
                >
                  Change time
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={busy || sending}
                  onClick={() => {
                    if (window.confirm('Cancel this scheduled email? It will not be sent and cannot be recovered.')) {
                      void act(() => onCancel(selected.id))
                    }
                  }}
                >
                  Cancel send
                </button>
              </div>
            </div>
            {note ? (
              <p className={styles.note} role="alert">
                {note}
              </p>
            ) : null}
            {changingTime ? (
              <SchedulePicker
                key={selected.id}
                busy={busy}
                scheduling={busy}
                canSchedule
                initial={new Date(selected.scheduledFor)}
                actionLabel="Save time"
                onSchedule={(when) => {
                  if (!when || when.getTime() < Date.now() + 60_000) {
                    setNote('Choose a send time at least a minute from now.')
                    return
                  }
                  void act(() => onReschedule(selected.id, when))
                }}
              />
            ) : null}

            <article className={styles.message}>
              <header className={styles.messageHead}>
                <div>
                  <strong>To {selected.to || '(reply recipient)'}</strong>
                  {selected.cc ? <div className={styles.muted}>Cc {selected.cc}</div> : null}
                  {shown?.bcc ? <div className={styles.muted}>Bcc {shown.bcc}</div> : null}
                </div>
                <span className={selected.status === 'failed' ? styles.scheduledError : styles.muted}>{statusLabel(selected)}</span>
              </header>
              {selected.status === 'failed' && selected.lastError ? <p className={styles.scheduledError}>{selected.lastError}</p> : null}
              {detailLoading && !shown ? (
                <p className={styles.empty}>Loading…</p>
              ) : detailError ? (
                <p className={styles.errorText}>{detailError}</p>
              ) : shown ? (
                <>
                  <EmailBody html={buildEmailDocument(shown.html)} title={selected.subject || 'Scheduled email'} />
                  {shown.signOff ? <p className={styles.scheduledSignOff}>{shown.signOff}</p> : null}
                  <p className={styles.muted}>Your Gmail signature is added when it sends.</p>
                  {shown.attachments.length > 0 ? (
                    <ul className={styles.scheduledFiles} aria-label="Attachments">
                      {shown.attachments.map((file, index) => (
                        <li key={`${index}-${file.name}`}>📎 {file.name}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </article>
          </>
        )}
      </section>
    </div>
  )
}
