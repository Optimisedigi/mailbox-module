'use client'

import { type MouseEvent, type ReactNode } from 'react'
import { addressInEntry, senderAddress, senderName, splitAddressList } from '../../lib/mail/contacts-shared'
import appStyles from './MailApp.module.css'
import pillStyles from './copied-pill.module.css'
import { pillLeft, useAddressCopy } from './use-address-copy'
import styles from './MessageAddresses.module.css'

/**
 * From / To / Cc on an open inbox message. Double-click a person, or the
 * address next to their name, to copy that address.
 */
export function MessageAddresses({ from, to, cc }: { from: string; to: string; cc: string }) {
  const fromAddress = senderAddress(from)
  const fromEmail = addressInEntry(fromAddress)
  return (
    <div>
      <CopyHit email={fromEmail}>
        <strong>{senderName(from)}</strong> <span className={appStyles.muted}>&lt;{fromAddress}&gt;</span>
      </CopyHit>
      <div className={appStyles.muted}>
        To <AddressList value={to} />
        {cc ? (
          <>
            {' '}
            · Cc <AddressList value={cc} />
          </>
        ) : null}
      </div>
    </div>
  )
}

function AddressList({ value }: { value: string }) {
  if (!value) return null
  const parts = splitAddressList(value).map((part) => part.trim()).filter(Boolean)
  return parts.map((part, index) => (
    <span key={`${index}-${part}`}>
      {index > 0 ? ', ' : null}
      <CopyHit email={addressInEntry(part)}>{part}</CopyHit>
    </span>
  ))
}

function CopyHit({ email, children }: { email: string | null; children: ReactNode }) {
  const { copied, copyAddress } = useAddressCopy()
  const onDoubleClick = (e: MouseEvent<HTMLSpanElement>) => {
    if (!email) return
    e.preventDefault()
    copyAddress(email, pillLeft(e.currentTarget.getBoundingClientRect(), e.clientX))
  }
  return (
    <span className={styles.hit} onDoubleClick={onDoubleClick}>
      {children}
      {copied ? (
        <span key={copied.id} className={pillStyles.copiedPill} style={{ left: copied.left }} role="status">
          Copied
        </span>
      ) : null}
    </span>
  )
}
