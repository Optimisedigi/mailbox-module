'use client'

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import MailCalendar from './MailCalendar'
import { formatTime12, parseDateKey, parseTypedTime, timeOptions } from '../../lib/mail/schedule-times'
import styles from './MailDateTimePicker.module.css'

/**
 * Date and time picker for Mail (Schedule send, Add calendar invite). Two
 * boxes, the date and the time, open one panel: the month calendar beside a
 * list of times every 15 minutes. Picking a day moves straight on to the
 * times; picking a time closes the panel. Any exact time ("7:48am", "905",
 * "21:30") can be typed above the list.
 *
 * The panel sits in the page flow (not floating), so it is never cut off by
 * the compose window or the invite pop-up. Escape or a click outside closes it.
 *
 * Keyboard in the time list: Up/Down move 15 minutes, Page Up/Down an hour,
 * Home/End the first/last time, Enter or Space picks.
 */

interface Props {
  /** YYYY-MM-DD. */
  date: string
  /** HH:MM (24-hour), or '' for none yet. */
  time: string
  onDateChange: (date: string) => void
  onTimeChange: (time: string) => void
  /** Today, YYYY-MM-DD: earlier days can't be picked. */
  today: string
  /** Times at or before this (HH:MM) can't be picked, e.g. already passed today. */
  minTime?: string
  /** "Send date" / "Date": the date box's name. */
  dateLabel: string
  /** "Send time" / "Start": the time box's and the list's name. */
  timeLabel: string
  disabled?: boolean
  /** More controls at the end of the row (Schedule send, meeting length). */
  children?: ReactNode
}

type Mode = 'date' | 'time'

const DEFAULT_TIME = '09:00'
const HOUR_STEPS = 4

function CalendarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

export default function MailDateTimePicker({
  date,
  time,
  onDateChange,
  onTimeChange,
  today,
  minTime,
  dateLabel,
  timeLabel,
  disabled = false,
  children,
}: Props) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [active, setActive] = useState(0)
  const [typed, setTyped] = useState('')
  const [typedError, setTypedError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const dateRef = useRef<HTMLButtonElement>(null)
  const timeRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const listId = useId()
  const typedId = useId()
  const errorId = useId()

  const options = timeOptions(time)
  const isDisabled = useCallback((value: string) => minTime !== undefined && value <= minTime, [minTime])
  const day = parseDateKey(date)
  const dayLabel = day ? day.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'Pick a date'
  const timeText = time ? formatTime12(time) : 'Pick a time'
  const optionId = (value: string) => `${listId}-${value.replace(':', '')}`

  const close = useCallback((restore: Mode | null) => {
    setMode(null)
    setTypedError('')
    if (restore === 'date') dateRef.current?.focus()
    if (restore === 'time') timeRef.current?.focus()
  }, [])

  // Opening the panel: start the list on the chosen time (or the nearest one ahead) and centre it.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (!mode) {
      wasOpen.current = false
      return
    }
    if (!wasOpen.current) {
      wasOpen.current = true
      setTyped('')
      setTypedError('')
      const target = time || DEFAULT_TIME
      let index = options.findIndex((value) => value >= target)
      if (index < 0) index = options.length - 1
      setActive(index)
      const list = listRef.current
      const option = list?.children[index] as HTMLElement | undefined
      if (list && option) list.scrollTop = option.offsetTop - list.clientHeight / 2 + option.offsetHeight / 2
    }
    if (mode === 'date') {
      const panel = panelRef.current
      const button =
        panel?.querySelector<HTMLButtonElement>(`[data-day="${date}"]:not(:disabled)`) ??
        panel?.querySelector<HTMLButtonElement>('[data-day][tabindex="0"]')
      button?.focus()
    } else {
      listRef.current?.focus()
    }
    // Runs when the panel opens or switches between the calendar and the times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Keep the highlighted time in view while moving through the list.
  useEffect(() => {
    if (!mode) return
    const option = listRef.current?.children[active] as HTMLElement | undefined
    option?.scrollIntoView?.({ block: 'nearest' })
  }, [active, mode])

  // A click anywhere outside closes the panel, like the browser's own pickers.
  useEffect(() => {
    if (!mode) return
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(null)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [mode, close])

  const toggle = (next: Mode) => setMode((current) => (current === next ? null : next))

  const pickTime = (value: string) => {
    if (isDisabled(value)) return
    onTimeChange(value)
    close('time')
  }

  const moveActive = (from: number, step: number) => {
    let index = Math.min(Math.max(from + step, 0), options.length - 1)
    // Skip times that can't be picked, in the direction of travel.
    const direction = step < 0 ? -1 : 1
    while (index >= 0 && index < options.length && isDisabled(options[index] ?? '')) index += direction
    if (index >= 0 && index < options.length) setActive(index)
  }

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const steps: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: HOUR_STEPS,
      PageUp: -HOUR_STEPS,
    }
    if (event.key in steps) {
      event.preventDefault()
      moveActive(active, steps[event.key] ?? 0)
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveActive(-1, 1)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveActive(options.length, -1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const value = options[active]
      if (value) pickTime(value)
    }
  }

  const applyTyped = () => {
    const value = parseTypedTime(typed)
    if (!value) {
      setTypedError('Try a time like 9:05am')
      return
    }
    if (isDisabled(value)) {
      setTypedError('That time has already passed')
      return
    }
    pickTime(value)
  }

  return (
    <div
      ref={rootRef}
      className={styles.picker}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !mode) return
        // Only the panel closes, not the window or pop-up it sits in.
        event.preventDefault()
        event.stopPropagation()
        close(mode)
      }}
    >
      <div className={styles.row}>
        <button
          ref={dateRef}
          type="button"
          className={styles.box}
          onClick={() => toggle('date')}
          aria-expanded={mode === 'date'}
          aria-controls={mode ? panelId : undefined}
          aria-label={`${dateLabel}: ${dayLabel}`}
          disabled={disabled}
        >
          <CalendarIcon />
          {dayLabel}
        </button>
        <button
          ref={timeRef}
          type="button"
          className={styles.box}
          onClick={() => toggle('time')}
          aria-expanded={mode === 'time'}
          aria-controls={mode ? panelId : undefined}
          aria-label={`${timeLabel}: ${timeText}`}
          disabled={disabled}
        >
          <ClockIcon />
          {timeText}
        </button>
        {children}
      </div>

      {mode ? (
        <div id={panelId} ref={panelRef} className={styles.panel} role="group" aria-label={`${dateLabel} and time`}>
          <MailCalendar
            bare
            selected={date}
            min={today}
            today={today}
            onSelect={(next) => {
              onDateChange(next)
              setMode('time')
            }}
          />
          <div className={styles.times}>
            <label className={styles.typedLabel} htmlFor={typedId}>
              Type a time
            </label>
            <input
              id={typedId}
              className={styles.typed}
              value={typed}
              placeholder="e.g. 9:05am"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typedError ? true : undefined}
              aria-describedby={typedError ? errorId : undefined}
              onChange={(event) => {
                setTyped(event.target.value)
                setTypedError('')
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                // Inside the invite form, Enter must set the time, not submit.
                event.preventDefault()
                applyTyped()
              }}
            />
            {typedError ? (
              <span id={errorId} className={styles.typedError} role="alert">
                {typedError}
              </span>
            ) : null}
            <ul
              ref={listRef}
              className={styles.list}
              role="listbox"
              aria-label={timeLabel}
              tabIndex={0}
              aria-activedescendant={options[active] ? optionId(options[active] ?? '') : undefined}
              onKeyDown={onListKey}
            >
              {options.map((value, index) => {
                const blocked = isDisabled(value)
                return (
                  <li
                    key={value}
                    id={optionId(value)}
                    role="option"
                    aria-selected={value === time}
                    aria-disabled={blocked || undefined}
                    className={[
                      styles.option,
                      index === active ? styles.optionActive : '',
                      value.endsWith(':00') ? styles.optionHour : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => (blocked ? undefined : setActive(index))}
                    onClick={() => pickTime(value)}
                  >
                    {formatTime12(value)}
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  )
}
