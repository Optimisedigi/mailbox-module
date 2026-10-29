'use client'

import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { matchMailContacts, type MailContact } from '../../lib/mail/contacts-shared'
import styles from './MailApp.module.css'

interface Props {
  value: string
  onChange: (value: string) => void
  /** Runs the search for the text in the box. */
  onSubmit: (value: string) => void
  /** Runs a search for one person picked from the suggestions. */
  onPickSender: (contact: MailContact) => void
  /**
   * People to suggest (regular senders first, then people you email); empty
   * while loading or for no suggestions.
   */
  senders: readonly MailContact[]
  /** Called on focus so the people list loads before the first letters are typed. */
  onWantSenders: () => void
  label: string
}

/**
 * The Mail list's search box. It suggests people from your mail as you type
 * (from the second letter, or "@" and a letter for a domain); picking one
 * lists their mail. Enter runs the typed search unless a suggestion is
 * highlighted with the arrow keys; Escape closes the list. The search always
 * looks at the person's name and address, the subject and the email's text.
 */
export function InboxSearch({ value, onChange, onSubmit, onPickSender, senders, onWantSenders, label }: Props) {
  const listId = useId()
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // -1: nothing highlighted, so Enter searches the typed text.
  const [active, setActive] = useState(-1)

  const suggestions = useMemo(
    () => (focused && !dismissed ? matchMailContacts(senders, value) : []),
    [senders, focused, dismissed, value],
  )
  const open = suggestions.length > 0
  const highlighted = active < suggestions.length ? active : -1

  const pick = (contact: MailContact) => {
    setDismissed(true)
    setActive(-1)
    onPickSender(contact)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(highlighted + 1 >= suggestions.length ? 0 : highlighted + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(highlighted <= 0 ? suggestions.length - 1 : highlighted - 1)
    } else if (e.key === 'Enter' && highlighted >= 0) {
      const choice = suggestions[highlighted]
      if (!choice) return
      e.preventDefault()
      pick(choice)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setDismissed(true)
    }
  }

  return (
    <form
      className={styles.search}
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        setDismissed(true)
        onSubmit(value)
      }}
    >
      <div className={styles.searchBox}>
        <input
          type="search"
          value={value}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={label}
          onChange={(e) => {
            onChange(e.target.value)
            setDismissed(false)
            setActive(-1)
          }}
          onFocus={() => {
            setFocused(true)
            onWantSenders()
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {open ? (
          <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className={styles.searchList}>
            {suggestions.map((contact, i) => (
              <li
                key={contact.email}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === highlighted}
                className={styles.searchOption}
                // Keep focus in the box so the click lands as a pick, not a blur.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(contact)}
              >
                {contact.name ? <span className={styles.searchOptionName}>{contact.name}</span> : null}
                <span className={styles.searchOptionEmail}>{contact.email}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </form>
  )
}
