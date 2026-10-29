'use client'

import { useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  addressesIn,
  applyRecipient,
  emailAtCaret,
  matchMailContacts,
  recipientTokenAt,
  type MailContact,
} from '../../lib/mail/contacts-shared'
import styles from './ComposeWindow.module.css'
import pillStyles from './copied-pill.module.css'
import { pillLeft, useAddressCopy } from './use-address-copy'

interface Props {
  value: string
  onChange: (value: string) => void
  /** People to suggest; null while still loading. */
  contacts: readonly MailContact[] | null
  /** Called on focus so the contact list loads before the first letters are typed. */
  onWantContacts: () => void
  /** Leaving the field: whatever was typed counts as finished. */
  onBlur?: () => void
  label: string
}

/**
 * A To / Cc / Bcc field with address suggestions from the user's own sent and
 * received mail. Suggestions show from the second letter of the address being
 * typed (after the last comma). Tab, Enter or a click picks the highlighted
 * one; the arrow keys move the highlight and Escape closes the list.
 * Double-clicking an address copies it and shows a short "Copied" pill.
 */
export function RecipientInput({ value, onChange, contacts, onWantContacts, onBlur, label }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [caret, setCaret] = useState(value.length)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const { copied, copyAddress } = useAddressCopy()

  const token = useMemo(() => recipientTokenAt(value, caret), [value, caret])
  const suggestions = useMemo(
    () => (contacts && focused && !dismissed ? matchMailContacts(contacts, token.text, addressesIn(value)) : []),
    [contacts, focused, dismissed, token.text, value],
  )
  const open = suggestions.length > 0
  const highlighted = Math.min(active, Math.max(0, suggestions.length - 1))

  const pick = (contact: MailContact) => {
    const next = applyRecipient(value, token, contact.email)
    onChange(next.value)
    setCaret(next.caret)
    setActive(0)
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.setSelectionRange(next.caret, next.caret)
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return
    const choice = suggestions[highlighted]
    if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') {
      if (!choice) return
      e.preventDefault()
      pick(choice)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((highlighted + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((highlighted - 1 + suggestions.length) % suggestions.length)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setDismissed(true)
    }
  }

  const onDoubleClick = (e: MouseEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    const at = input.selectionStart ?? input.selectionEnd ?? value.length
    const found = emailAtCaret(input.value, at)
    if (!found) return
    input.setSelectionRange(found.start, found.end)
    copyAddress(found.email, pillLeft(input.getBoundingClientRect(), e.clientX))
  }

  return (
    <div className={styles.recipientBox}>
      <input
        ref={inputRef}
        value={value}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${highlighted}` : undefined}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart ?? e.target.value.length)
          setDismissed(false)
          setActive(0)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? value.length)}
        onFocus={() => {
          setFocused(true)
          onWantContacts()
        }}
        onBlur={() => {
          setFocused(false)
          onBlur?.()
        }}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
      />
      {copied ? (
        <span key={copied.id} className={pillStyles.copiedPill} style={{ left: copied.left }} role="status">
          Copied
        </span>
      ) : null}
      {open ? (
        <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className={styles.recipientList}>
          {suggestions.map((contact, i) => (
            <li
              key={contact.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlighted}
              className={styles.recipientOption}
              // Keep focus in the field so the click lands as a pick, not a blur.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(contact)}
            >
              {contact.name ? <span className={styles.recipientName}>{contact.name}</span> : null}
              <span className={styles.recipientEmail}>{contact.email}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
