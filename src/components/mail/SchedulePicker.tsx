'use client'

import { useState } from 'react'
import MailDateTimePicker from './MailDateTimePicker'
import {
  addDays,
  addMinutesToTime,
  combineDateAndTime,
  dateKey,
  defaultScheduleChoice,
  formatTime12,
  QUICK_SEND_TIMES,
} from '../../lib/mail/schedule-times'
import styles from './ComposeWindow.module.css'

/**
 * Schedule send panel: Today / Tomorrow day pills, quick send times (7:48am,
 * 8:11am) each with a +2 button that moves that time two minutes later before
 * you pick it, and the date and time boxes (MailDateTimePicker), which open
 * one panel with the calendar and a list of times. Times already passed today
 * can't be picked.
 */

interface Props {
  busy: boolean
  scheduling: boolean
  canSchedule: boolean
  onSchedule: (when: Date | null) => void
  /** Preselected send time (editing a scheduled email); defaults to the next quick time. */
  initial?: Date
  /** Text on the confirm button. */
  actionLabel?: string
  /** Injected for tests; defaults to the real clock. */
  now?: () => Date
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export default function SchedulePicker({
  busy,
  scheduling,
  canSchedule,
  onSchedule,
  initial,
  actionLabel = 'Schedule send',
  now = () => new Date(),
}: Props) {
  const [choice, setChoice] = useState(() =>
    initial && !Number.isNaN(initial.getTime())
      ? { day: dateKey(initial), time: `${pad(initial.getHours())}:${pad(initial.getMinutes())}` }
      : defaultScheduleChoice(now()),
  )
  const [quickTimes, setQuickTimes] = useState<string[]>(() => [...QUICK_SEND_TIMES])

  const current = now()
  const today = dateKey(current)
  const tomorrow = dateKey(addDays(current, 1))
  const nowTime = `${pad(current.getHours())}:${pad(current.getMinutes())}`

  const pickDay = (next: string) => setChoice((current) => ({ ...current, day: next }))
  const pickTime = (next: string) => setChoice((current) => ({ ...current, time: next }))

  return (
    <div className={styles.schedulePicker} role="group" aria-label="Schedule send">
      <div className={styles.scheduleQuick}>
        {[
          { label: 'Today', value: today },
          { label: 'Tomorrow', value: tomorrow },
        ].map((pill) => (
          <button
            key={pill.label}
            type="button"
            className={styles.pill}
            aria-pressed={choice.day === pill.value}
            onClick={() => pickDay(pill.value)}
            disabled={busy}
          >
            {pill.label}
          </button>
        ))}
        {quickTimes.map((time, index) => (
          <span key={index} className={styles.quickTime}>
            <button
              type="button"
              className={styles.pill}
              aria-pressed={choice.time === time}
              onClick={() => pickTime(time)}
              disabled={busy}
            >
              {formatTime12(time)}
            </button>
            <button
              type="button"
              className={styles.plusTwo}
              aria-label={`Add 2 minutes to ${formatTime12(time)}`}
              title="2 minutes later"
              onClick={() => setQuickTimes((current) => current.map((t, i) => (i === index ? addMinutesToTime(t, 2) : t)))}
              disabled={busy}
            >
              +2
            </button>
          </span>
        ))}
      </div>

      <MailDateTimePicker
        date={choice.day}
        time={choice.time}
        onDateChange={pickDay}
        onTimeChange={pickTime}
        today={today}
        minTime={choice.day === today ? nowTime : undefined}
        dateLabel="Send date"
        timeLabel="Send time"
        disabled={busy}
      >
        <button
          type="button"
          className={styles.send}
          onClick={() => onSchedule(combineDateAndTime(choice.day, choice.time))}
          disabled={busy || !canSchedule || !choice.time}
        >
          {scheduling ? 'Scheduling…' : actionLabel}
        </button>
      </MailDateTimePicker>
    </div>
  )
}
