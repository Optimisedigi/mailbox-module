'use client'

import { useEffect, useRef, useState } from 'react'
import { addDays, calendarWeeks, dateKey, parseDateKey } from '../../lib/mail/schedule-times'
import styles from './ComposeWindow.module.css'

/**
 * Month calendar for Schedule send, styled after the shadcn / react-day-picker
 * Calendar: centred month caption with ghost chevron buttons, 36px rounded
 * day cells, a dot under today, greyed neighbouring-month days and struck-out
 * past days. Built here so the admin needs no extra packages or Tailwind.
 *
 * Keyboard: arrow keys move a day or a week (changing month as needed),
 * Home/End jump to the start/end of the week, Enter/Space picks the day.
 */

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
    </svg>
  )
}

interface Props {
  /** Selected day, YYYY-MM-DD. */
  selected: string
  /** Earliest day that can be picked, YYYY-MM-DD (today). */
  min: string
  /** Today, YYYY-MM-DD (marked with a dot). */
  today: string
  onSelect: (day: string) => void
  /** No frame of its own (border, shadow): when it sits inside another panel. */
  bare?: boolean
}

export default function MailCalendar({ selected, min, today, onSelect, bare = false }: Props) {
  const initial = parseDateKey(selected) ?? parseDateKey(today) ?? new Date()
  const [view, setView] = useState({ year: initial.getFullYear(), month: initial.getMonth() })
  const [focused, setFocused] = useState(dateKey(initial))
  const gridRef = useRef<HTMLTableElement>(null)
  const moveFocus = useRef(false)

  useEffect(() => {
    if (!moveFocus.current) return
    moveFocus.current = false
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`)?.focus()
  }, [focused, view])

  const minDate = parseDateKey(min)
  const isBeforeMin = (date: Date) => minDate !== null && date < minDate
  const canGoBack = minDate === null || new Date(view.year, view.month, 1) > minDate
  const caption = new Date(view.year, view.month, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })

  const showMonth = (offset: number) => {
    const next = new Date(view.year, view.month + offset, 1)
    setView({ year: next.getFullYear(), month: next.getMonth() })
  }

  const focusDay = (date: Date) => {
    const target = minDate && date < minDate ? minDate : date
    moveFocus.current = true
    setFocused(dateKey(target))
    if (target.getMonth() !== view.month || target.getFullYear() !== view.year) {
      setView({ year: target.getFullYear(), month: target.getMonth() })
    }
  }

  const onKeyDown = (event: React.KeyboardEvent, date: Date) => {
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
      Home: -date.getDay(),
      End: 6 - date.getDay(),
    }
    const move = moves[event.key]
    if (move === undefined) return
    event.preventDefault()
    focusDay(addDays(date, move))
  }

  // Roving tab stop: the focused day if it is in view, else the first selectable day shown.
  const weeks = calendarWeeks(view.year, view.month)
  const inView = weeks.some((week) => week.some((date) => dateKey(date) === focused && date.getMonth() === view.month))
  const firstPickable = weeks.flat().find((date) => date.getMonth() === view.month && !isBeforeMin(date))
  const tabStop = inView ? focused : firstPickable ? dateKey(firstPickable) : ''

  return (
    <div className={bare ? styles.calendarBare : styles.calendar}>
      <div className={styles.calendarCaption}>
        <button
          type="button"
          className={styles.calendarNav}
          onClick={() => showMonth(-1)}
          disabled={!canGoBack}
          aria-label="Previous month"
        >
          <Chevron direction="left" />
        </button>
        <span className={styles.calendarLabel} aria-live="polite">
          {caption}
        </span>
        <button type="button" className={styles.calendarNav} onClick={() => showMonth(1)} aria-label="Next month">
          <Chevron direction="right" />
        </button>
      </div>
      <table ref={gridRef} className={styles.calendarGrid} role="grid" aria-label={caption}>
        <thead>
          <tr>
            {WEEKDAYS.map((day, index) => (
              <th key={day} scope="col" className={styles.calendarWeekday} abbr={WEEKDAY_NAMES[index]}>
                {day}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={dateKey(week[0] ?? new Date())}>
              {week.map((date) => {
                const key = dateKey(date)
                const outside = date.getMonth() !== view.month
                const disabled = isBeforeMin(date)
                const isSelected = key === selected
                return (
                  <td key={key} className={styles.calendarCell}>
                    <button
                      type="button"
                      data-day={key}
                      className={[
                        styles.calendarDay,
                        outside ? styles.calendarOutside : '',
                        key === today ? styles.calendarToday : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-label={date.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                      aria-pressed={isSelected}
                      aria-current={key === today ? 'date' : undefined}
                      tabIndex={key === tabStop ? 0 : -1}
                      disabled={disabled}
                      onClick={() => onSelect(key)}
                      onKeyDown={(event) => onKeyDown(event, date)}
                    >
                      {date.getDate()}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
