'use client'

import ClientEmailAlert from './ClientEmailAlert'

/**
 * Admin header slot (Payload `admin.components.actions`): a Mail link that
 * anchors the "new client email" drop-down. Hosts with their own
 * notifications bell can render <ClientEmailAlert> inside it instead.
 */
export default function MailHeaderAlerts() {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <a
        href="/admin/mail"
        aria-label="Open Mail"
        title="Mail"
        style={{ display: 'inline-flex', padding: 6, color: 'var(--theme-elevation-800)', borderRadius: 6 }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M4 7l8 6 8-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
      <ClientEmailAlert suppressed={false} onArrive={() => undefined} />
    </span>
  )
}
