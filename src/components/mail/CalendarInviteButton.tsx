'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { mailAccountHeaders } from '../../lib/mail/accounts-shared'
import { RecipientInput } from './RecipientInput'
import MailDateTimePicker from './MailDateTimePicker'
import { dateKey } from '../../lib/mail/schedule-times'
import { useMailContacts } from './use-mail-contacts'
import pillStyles from './copied-pill.module.css'
import styles from './CalendarInviteButton.module.css'

const DURATIONS = [15, 30, 45, 60, 90, 120] as const
const PILL_MS = 1000

interface Created {
  eventLink: string
  meetLink: string
  sent: boolean
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Today and the next half hour in this browser's time zone, as the form's starting values. */
function startingSlot(now: Date): { date: string; time: string } {
  const next = new Date(now)
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() < 30 ? 30 : 60)
  return { date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`, time: `${pad(next.getHours())}:${pad(next.getMinutes())}` }
}

function durationLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : minutes % 60 === 0 ? `${minutes / 60} hr` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
}

/**
 * Mail toolbar → "Add calendar invite". A small pop-up under the button to
 * pick the date, time and length, and search for guests. The event (with a
 * Google Meet link) is saved on the calendar of the mailbox Mail is showing.
 * "Send to client / user" ticked: Google emails the guests the invite.
 * Unticked: nobody is emailed and the Meet link is copied to the clipboard,
 * with the same small pill as double-clicking an address.
 */
export default function CalendarInviteButton({ account, now = () => new Date() }: { account: string; now?: () => Date }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [duration, setDuration] = useState<number>(30)
  const [guests, setGuests] = useState('')
  const [sendInvites, setSendInvites] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Saved, but the link could not be copied for you: shown so it can be copied by hand.
  const [saved, setSaved] = useState<Created | null>(null)
  const [pill, setPill] = useState<{ id: number; text: string } | null>(null)
  const pillSeq = useRef(0)
  const pillTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const dialogId = useId()
  const headingId = useId()
  const whenId = useId()
  const { contacts, loadContacts } = useMailContacts(account)

  useEffect(() => () => {
    if (pillTimer.current) clearTimeout(pillTimer.current)
  }, [])

  const showPill = (text: string) => {
    const id = ++pillSeq.current
    setPill({ id, text })
    if (pillTimer.current) clearTimeout(pillTimer.current)
    pillTimer.current = setTimeout(() => setPill((current) => (current?.id === id ? null : current)), PILL_MS)
  }

  const close = (restoreFocus = true) => {
    setOpen(false)
    setSaved(null)
    setError('')
    if (restoreFocus) triggerRef.current?.focus()
  }

  const openForm = () => {
    const slot = startingSlot(now())
    setTitle('')
    setDate(slot.date)
    setTime(slot.time)
    setDuration(30)
    setGuests('')
    setSendInvites(false)
    setError('')
    setSaved(null)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    titleRef.current?.focus()
    const onPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node) && !busy) close(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
    // close only reads refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy])

  const copyLink = async (link: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(link)
      return true
    } catch {
      return false
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/mail/calendar-event', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', ...mailAccountHeaders(account) },
        body: JSON.stringify({
          title,
          date,
          time,
          durationMinutes: duration,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          guests,
          sendInvites,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as Partial<Created> & { error?: string; reason?: string }
      if (!res.ok) throw new Error(data.reason || data.error || `Request failed (${res.status})`)
      const created: Created = { eventLink: data.eventLink ?? '', meetLink: data.meetLink ?? '', sent: data.sent === true }
      if (created.sent) {
        close()
        showPill('Invite sent')
        return
      }
      if (created.meetLink && (await copyLink(created.meetLink))) {
        close()
        showPill('Meeting link copied')
        return
      }
      setSaved(created)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span ref={wrapRef} className={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => (open ? close() : openForm())}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M16 3v4M8 3v4M3 10h18" />
        </svg>
        Add calendar invite
      </button>
      {pill ? (
        <span key={pill.id} className={`${pillStyles.copiedPill} ${styles.pill}`} role="status">
          {pill.text}
        </span>
      ) : null}
      {open ? (
        <div id={dialogId} className={styles.popover} role="dialog" aria-labelledby={headingId}>
          <h3 id={headingId} className={styles.heading}>
            New calendar invite
          </h3>
          {saved ? (
            <div className={styles.saved}>
              <p>Saved to your calendar. Nobody was emailed.</p>
              {saved.meetLink ? (
                <>
                  <input className={styles.input} readOnly value={saved.meetLink} aria-label="Meeting link" onFocus={(e) => e.currentTarget.select()} />
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.primary}`}
                      onClick={async () => {
                        if (await copyLink(saved.meetLink)) {
                          close()
                          showPill('Meeting link copied')
                        }
                      }}
                    >
                      Copy meeting link
                    </button>
                    <button type="button" className={styles.btn} onClick={() => close()}>
                      Done
                    </button>
                  </div>
                </>
              ) : (
                <div className={styles.actions}>
                  <p className={styles.muted}>Google didn&apos;t add a Meet link to this event.</p>
                  {saved.eventLink ? (
                    <a className={styles.btn} href={saved.eventLink} target="_blank" rel="noopener noreferrer">
                      Open in Google Calendar
                    </a>
                  ) : null}
                  <button type="button" className={styles.btn} onClick={() => close()}>
                    Done
                  </button>
                </div>
              )}
            </div>
          ) : (
            <form className={styles.form} onSubmit={(e) => void submit(e)}>
              <label className={styles.label}>
                Title
                <input ref={titleRef} className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting" maxLength={200} />
              </label>
              <div className={styles.label} role="group" aria-labelledby={whenId}>
                <span id={whenId}>When</span>
                <MailDateTimePicker
                  date={date}
                  time={time}
                  onDateChange={setDate}
                  onTimeChange={setTime}
                  today={dateKey(now())}
                  dateLabel="Date"
                  timeLabel="Start"
                  disabled={busy}
                >
                  <select
                    className={`${styles.input} ${styles.length}`}
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                    aria-label="Length"
                    disabled={busy}
                  >
                    {DURATIONS.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {durationLabel(minutes)}
                      </option>
                    ))}
                  </select>
                </MailDateTimePicker>
              </div>
              <div className={styles.label}>
                <span aria-hidden="true">Guests</span>
                <div className={styles.guests}>
                  <RecipientInput label="Guests" value={guests} onChange={setGuests} contacts={contacts} onWantContacts={loadContacts} />
                </div>
              </div>
              <label className={styles.check}>
                <input type="checkbox" checked={sendInvites} onChange={(e) => setSendInvites(e.target.checked)} />
                Send to client / user
              </label>
              {!sendInvites ? <p className={styles.muted}>Nobody is emailed. The meeting link is copied for you.</p> : null}
              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}
              <div className={styles.actions}>
                <button type="submit" className={`${styles.btn} ${styles.primary}`} disabled={busy}>
                  {busy ? 'Saving…' : sendInvites ? 'Send invite' : 'Save and copy link'}
                </button>
                <button type="button" className={styles.btn} disabled={busy} onClick={() => close()}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </span>
  )
}
