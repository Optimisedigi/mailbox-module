'use client'

import styles from './MailSplash.module.css'

/** Loading state for the email list: a spinner with a label (also its accessible name). */
export default function MailSplash({ label = 'Loading' }: { label?: string }) {
  return (
    <div className={styles.splash} role="status" aria-live="polite" aria-label={label}>
      <span className={styles.spinner} aria-hidden="true" />
      <span className={styles.text}>{label}</span>
    </div>
  )
}
