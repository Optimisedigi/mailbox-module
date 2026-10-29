'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { normaliseMailAccount } from '../../lib/mail/accounts-shared'
import { createPortal } from 'react-dom'
import { useStepNav, type StepNavItem } from '@payloadcms/ui'
import styles from './MailApp.module.css'

/**
 * Mail's breadcrumb: [Home] / Mail / [email]. The email is the account
 * switcher: it lists the user's main Gmail and their extra Gmail accounts,
 * switches Mail between them, and adds another one: "+ Add email account"
 * asks for the address, and the connect route picks the right Google sign-in
 * for it (the CMS's own app, or another Workspace's / a personal Gmail's). The menu
 * is portalled to <body> because the breadcrumb bar clips overflow.
 */

export interface MailAccountMenuProps {
  /** The address Mail is showing ('' while unknown). */
  current: string
  /** Every account to offer, main Gmail first. */
  accounts: Array<{ email: string; main: boolean }>
  onSelect: (email: string, main: boolean) => void
  onRemove: (email: string) => void
  /** Where "Add email account" goes (`&email=` is added), or null when the user cannot add one. */
  addUrl: string | null
}

/** The connect link for one address: `addUrl` plus `email=`. */
export function addAccountUrl(addUrl: string, email: string): string {
  return `${addUrl}${addUrl.includes('?') ? '&' : '?'}email=${encodeURIComponent(email)}`
}

export function MailAccountMenu({ current, accounts, onSelect, onRemove, addUrl }: MailAccountMenuProps) {
  const [open, setOpen] = useState(false)
  // "+ Add email account" opens a small address box in the menu.
  const [adding, setAdding] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [addError, setAddError] = useState('')
  const addInputRef = useRef<HTMLInputElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (open) return
    setAdding(false)
    setNewEmail('')
    setAddError('')
  }, [open])

  useEffect(() => {
    if (adding) addInputRef.current?.focus()
  }, [adding])

  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (rect) setPosition({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 300)) })
    }
    place()
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (open && position) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open, position])

  const label = current || 'Gmail account'
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.accountSwitch}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Switch Gmail account"
        onClick={() => setOpen((value) => !value)}
      >
        {current ? <span className={styles.accountSwitchDot} aria-hidden="true" /> : null}
        <span className={styles.accountSwitchLabel}>{label}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label="Gmail accounts"
              className={styles.accountMenu}
              style={{ top: position.top, left: position.left }}
            >
              {accounts.length === 0 ? <p className={styles.accountMenuNote}>No Gmail account connected yet.</p> : null}
              {accounts.map((account) => {
                const active = account.email === current
                return (
                  <div key={account.email} className={styles.accountMenuRow}>
                    <button
                      type="button"
                      role="menuitem"
                      className={`${styles.accountMenuItem} ${active ? styles.accountMenuItemActive : ''}`}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => {
                        setOpen(false)
                        if (!active) onSelect(account.email, account.main)
                      }}
                    >
                      <span aria-hidden="true" className={styles.accountMenuCheck}>
                        {active ? '✓' : ''}
                      </span>
                      <span className={styles.accountMenuEmail}>{account.email}</span>
                      {account.main ? <span className={styles.accountMenuTag}>Main</span> : null}
                    </button>
                    {account.main ? null : (
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.accountMenuRemove}
                        aria-label={`Remove ${account.email} from Mail`}
                        title="Remove from Mail (Gmail is not changed)"
                        onClick={() => {
                          if (!window.confirm(`Remove ${account.email} from Mail? Gmail is not changed; you can add it again later.`)) return
                          setOpen(false)
                          onRemove(account.email)
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )
              })}
              {addUrl && !adding ? (
                <button type="button" role="menuitem" className={styles.accountMenuAdd} onClick={() => setAdding(true)}>
                  + Add email account
                </button>
              ) : null}
              {addUrl && adding ? (
                <form
                  className={styles.accountMenuAddForm}
                  onSubmit={(event) => {
                    event.preventDefault()
                    const email = normaliseMailAccount(newEmail)
                    if (!email) {
                      setAddError('Enter a full email address.')
                      return
                    }
                    if (accounts.some((account) => account.email === email)) {
                      setAddError('That account is already in Mail.')
                      return
                    }
                    window.location.assign(addAccountUrl(addUrl, email))
                  }}
                >
                  <input
                    ref={addInputRef}
                    type="email"
                    className={styles.accountMenuAddInput}
                    value={newEmail}
                    onChange={(event) => {
                      setNewEmail(event.target.value)
                      setAddError('')
                    }}
                    placeholder="name@example.com"
                    aria-label="Email account to add"
                    aria-invalid={addError ? true : undefined}
                    autoComplete="off"
                  />
                  <button type="submit" className={styles.accountMenuAddGo}>
                    Continue
                  </button>
                  {addError ? (
                    <p className={styles.accountMenuNote} role="alert">
                      {addError}
                    </p>
                  ) : null}
                </form>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

/** Sets the admin breadcrumb to Mail / [account switcher] while Mail is open. */
export default function MailStepNav(props: MailAccountMenuProps) {
  const { setStepNav } = useStepNav()
  // Callbacks read through a ref so the breadcrumb only changes when what it shows changes.
  const latest = useRef(props)
  latest.current = props
  const accountsKey = props.accounts.map((account) => `${account.main ? '*' : ''}${account.email}`).join(',')
  const nav = useMemo<StepNavItem[]>(() => {
    const items: StepNavItem[] = [{ label: 'Mail', url: '/admin/mail' }]
    // No account yet: an empty switcher would render as a blank pill.
    if (!props.current && props.accounts.length === 0) return items
    items.push({
      label: (
        <MailAccountMenu
          current={props.current}
          accounts={props.accounts}
          addUrl={props.addUrl}
          onSelect={(email, main) => latest.current.onSelect(email, main)}
          onRemove={(email) => latest.current.onRemove(email)}
        />
      ),
    })
    return items
    // props.accounts is keyed by accountsKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.current, accountsKey, props.addUrl])

  useEffect(() => {
    setStepNav(nav)
  }, [nav, setStepNav])
  useEffect(() => () => setStepNav([]), [setStepNav])
  return null
}
