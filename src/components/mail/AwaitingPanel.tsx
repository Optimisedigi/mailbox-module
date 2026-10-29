'use client'

import { useState } from 'react'
import styles from './MailApp.module.css'
import SchedulePicker from './SchedulePicker'
import { addBusinessDays, followUpDueLabel } from '../../lib/mail/schedule-times'

/**
 * The Awaiting reply tab: sent emails with a "Remind me if no reply"
 * reminder that nobody has answered yet, soonest reminder first. Each row has
 * Draft follow-up (a reply with Write with AI pre-filled), Open thread,
 * Snooze (+2 business days, or a custom time) and Done. Replied threads drop
 * off automatically once the hourly check sees the reply.
 */

export interface FollowUpItem {
  id: number
  threadId: string
  sentMessageId: string
  to: string
  subject: string
  clientId: number | null
  clientName: string
  sentAt: string
  remindAt: string
  status: 'waiting' | 'due' | 'replied' | 'dismissed'
}

interface Props {
  items: FollowUpItem[]
  loading: boolean
  onDraftFollowUp: (item: FollowUpItem) => void
  onOpenThread: (item: FollowUpItem) => void
  onSnooze: (id: number, when: Date) => Promise<void>
  onDismiss: (id: number) => Promise<void>
  /** Injected for tests; defaults to the real clock. */
  now?: () => Date
}

/** Snooze button: push the reminder this many business days from now. */
const SNOOZE_DAYS = 2

function sentLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
}

export default function AwaitingPanel({ items, loading, onDraftFollowUp, onOpenThread, onSnooze, onDismiss, now = () => new Date() }: Props) {
  const [busyId, setBusyId] = useState<number | null>(null)
  const [pickingId, setPickingId] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const current = now()

  async function act(id: number, action: () => Promise<void>) {
    setBusyId(id)
    setNote('')
    try {
      await action()
      setPickingId(null)
    } catch (err) {
      setNote((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className={styles.awaiting}>
      {note ? (
        <p className={styles.errorText} role="alert">
          {note}
        </p>
      ) : null}
      <ul className={styles.awaitingList} aria-label="Awaiting reply">
        {items.map((item) => {
          const overdue = item.status === 'due' || new Date(item.remindAt).getTime() <= current.getTime()
          const busy = busyId === item.id
          return (
            <li key={item.id} className={styles.awaitingRow}>
              <div className={styles.awaitingInfo}>
                <span className={styles.sender}>
                  <span className={overdue ? styles.draftTag : styles.scheduledTag}>{followUpDueLabel(item.remindAt, current)}</span>
                  To {item.to || '(recipient)'}
                </span>
                <span className={styles.subject}>{item.subject || '(no subject)'}</span>
                <span className={styles.snippet}>
                  {[item.clientName, item.sentAt ? `Sent ${sentLabel(item.sentAt)}` : ''].filter(Boolean).join(' · ')}
                </span>
              </div>
              <div className={styles.actions}>
                <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={busy} onClick={() => onDraftFollowUp(item)}>
                  Draft follow-up
                </button>
                <button type="button" className={styles.btn} disabled={busy} onClick={() => onOpenThread(item)}>
                  Open thread
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={busy}
                  onClick={() => void act(item.id, () => onSnooze(item.id, addBusinessDays(now(), SNOOZE_DAYS)))}
                >
                  Snooze {SNOOZE_DAYS} days
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={busy}
                  aria-expanded={pickingId === item.id}
                  onClick={() => setPickingId((id) => (id === item.id ? null : item.id))}
                >
                  Remind me on…
                </button>
                <button type="button" className={styles.btn} disabled={busy} onClick={() => void act(item.id, () => onDismiss(item.id))}>
                  {busy ? 'Working…' : 'Done'}
                </button>
              </div>
              {pickingId === item.id ? (
                <SchedulePicker
                  busy={busy}
                  scheduling={busy}
                  canSchedule
                  initial={addBusinessDays(current, SNOOZE_DAYS)}
                  actionLabel="Set reminder"
                  onSchedule={(when) => {
                    if (!when || when.getTime() < Date.now() + 60 * 60 * 1000) {
                      setNote('Choose a reminder at least an hour from now.')
                      return
                    }
                    void act(item.id, () => onSnooze(item.id, when))
                  }}
                />
              ) : null}
            </li>
          )
        })}
        {loading ? <li className={styles.empty}>Loading…</li> : null}
        {!loading && items.length === 0 ? (
          <li className={styles.empty}>No emails awaiting a reply. Choose “Remind me if no reply” when you send one.</li>
        ) : null}
      </ul>
    </div>
  )
}
