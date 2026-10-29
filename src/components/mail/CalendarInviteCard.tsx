'use client'

import { useEffect, useState } from 'react'
import styles from './CalendarInviteCard.module.css'
import type { InviteResponse, InviteStatus, ThreadInvite } from '../../lib/mail/calendar-invite'
import { mailAccountHeaders } from '../../lib/mail/accounts-shared'

/**
 * Gmail-style invite card at the top of the reading pane: when, what, who,
 * the owner's other events that day, and Yes / No / Maybe.
 */

interface DayEvent {
  summary: string
  start: string
  end: string
  allDay: boolean
}

interface CalendarContext {
  calendar: boolean
  status: InviteStatus | null
  dayEvents: DayEvent[]
}

const CHOICES: Array<{ value: InviteResponse; label: string }> = [
  { value: 'accepted', label: 'Yes' },
  { value: 'declined', label: 'No' },
  { value: 'tentative', label: 'Maybe' },
]

const STATUS_TEXT: Record<InviteStatus, string> = {
  accepted: 'Going',
  declined: 'Not going',
  tentative: 'Maybe',
  needsAction: '',
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString()
}

/** "Tue, 27 Oct • 10:00 am – 10:15 am" in the viewer's time zone. */
export function formatInviteWhen(start: string, end: string, allDay: boolean): string {
  const from = new Date(start)
  const to = new Date(end)
  const day = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(allDay ? { timeZone: 'UTC' } : {}) })
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (allDay) {
    // DTEND of an all-day event is the day after it ends.
    const last = new Date(to.getTime() - 86_400_000)
    return last > from ? `${day(from)} – ${day(last)}` : `${day(from)} • All day`
  }
  return sameDay(from, to) ? `${day(from)} • ${time(from)} – ${time(to)}` : `${day(from)} ${time(from)} – ${day(to)} ${time(to)}`
}

function PeopleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 5.2a3 3 0 0 1 0 5.6M17.5 13.8c2 .6 3.5 2.4 3.5 5.2" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </svg>
  )
}

/** `account`: the Gmail account the invite email is in ('' or omitted = the main Gmail). */
export default function CalendarInviteCard({ data, account = '' }: { data: ThreadInvite; account?: string }) {
  const { invite, messageId } = data
  const [status, setStatus] = useState<InviteStatus>(data.selfStatus)
  const [context, setContext] = useState<CalendarContext | null>(null)
  const [busy, setBusy] = useState<InviteResponse | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    if (invite.method === 'CANCEL') return
    const controller = new AbortController()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    fetch(`/api/mail/invite?messageId=${encodeURIComponent(messageId)}&tz=${encodeURIComponent(tz)}`, {
      credentials: 'include',
      headers: mailAccountHeaders(account),
      signal: controller.signal,
    })
      .then((res) => (res.ok ? (res.json() as Promise<CalendarContext>) : null))
      .then((next) => {
        if (!next) return
        setContext(next)
        if (next.status) setStatus(next.status)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [messageId, invite.method, account])

  async function respond(response: InviteResponse) {
    if (busy) return
    setBusy(response)
    setNote('')
    try {
      const res = await fetch('/api/mail/invite', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', ...mailAccountHeaders(account) },
        body: JSON.stringify({ messageId, response }),
      })
      const body = (await res.json().catch(() => ({}))) as { status?: InviteStatus; via?: string; error?: string; reason?: string }
      if (!res.ok) throw new Error(body.reason || body.error || `Request failed (${res.status})`)
      setStatus(body.status ?? response)
      setNote(body.via === 'email' ? 'Reply emailed to the organiser.' : 'Updated in your calendar.')
    } catch (err) {
      setNote((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const cancelled = invite.method === 'CANCEL'
  const people = [
    ...(invite.organizer ? [{ key: `o-${invite.organizer.email}`, name: invite.organizer.name || invite.organizer.email, role: 'Organiser' }] : []),
    ...invite.attendees
      .filter((a) => a.email !== invite.organizer?.email)
      .map((a) => ({ key: a.email, name: a.name || a.email, role: '' })),
  ]

  return (
    <section className={`${styles.card} ${cancelled ? styles.cancelled : ''}`} aria-label="Calendar invitation">
      <div className={styles.when}>
        {formatInviteWhen(invite.start, invite.end, invite.allDay)}
        {cancelled ? <span className={styles.cancelTag}>Cancelled</span> : null}
      </div>
      <h3 className={styles.title}>{invite.summary}</h3>

      <div className={styles.details}>
        {people.length > 0 ? (
          <div className={styles.detail}>
            <span className={styles.icon}>
              <PeopleIcon />
            </span>
            <ul className={styles.people}>
              {people.slice(0, 6).map((p) => (
                <li key={p.key}>
                  {p.name}
                  {p.role ? <span className={styles.muted}> – {p.role}</span> : null}
                </li>
              ))}
              {people.length > 6 ? <li className={styles.muted}>and {people.length - 6} more</li> : null}
            </ul>
          </div>
        ) : null}

        {context?.calendar ? (
          <div className={styles.detail}>
            <span className={styles.icon}>
              <CalendarIcon />
            </span>
            {context.dayEvents.length === 0 ? (
              <span>No events on this date</span>
            ) : (
              <ul className={styles.people}>
                {context.dayEvents.slice(0, 3).map((event, i) => (
                  <li key={`${event.start}-${i}`}>
                    <span className={styles.muted}>
                      {event.allDay ? 'All day' : new Date(event.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </span>{' '}
                    {event.summary}
                  </li>
                ))}
                {context.dayEvents.length > 3 ? <li className={styles.muted}>and {context.dayEvents.length - 3} more that day</li> : null}
              </ul>
            )}
          </div>
        ) : null}

        {invite.location ? (
          <div className={styles.detail}>
            <span className={styles.icon}>
              <PinIcon />
            </span>
            <span className={styles.location} title={invite.location}>
              {/^https?:\/\//i.test(invite.location) ? (
                <a href={invite.location} target="_blank" rel="noopener noreferrer">
                  {invite.location}
                </a>
              ) : (
                invite.location
              )}
            </span>
          </div>
        ) : null}
      </div>

      {data.canRespond && !cancelled ? (
        <div className={styles.actions}>
          <div className={styles.choices} role="group" aria-label="Going?">
            {CHOICES.map((choice) => {
              const chosen = status === choice.value
              return (
                <button
                  key={choice.value}
                  type="button"
                  className={`${styles.choice} ${status !== 'needsAction' && !chosen ? styles.choiceIdle : ''}`}
                  aria-pressed={chosen}
                  onClick={() => void respond(choice.value)}
                  disabled={busy !== null}
                >
                  {chosen ? '✓ ' : ''}
                  {busy === choice.value ? 'Saving…' : choice.label}
                </button>
              )
            })}
          </div>
          {status !== 'needsAction' ? <span className={styles.muted}>{STATUS_TEXT[status]}</span> : null}
        </div>
      ) : null}
      {note ? (
        <p className={styles.note} role="status">
          {note}
        </p>
      ) : null}
    </section>
  )
}
