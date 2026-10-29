'use client'

import { useAuth } from '@payloadcms/ui'
import { userHasFeature } from '@/lib/access'

/** Sidebar link to Mail (Payload `admin.components.beforeNavLinks`), shown to users with the Mail feature. */
export default function MailNavLink() {
  const { user } = useAuth()
  if (!userHasFeature(user as { role?: unknown; featureAccess?: unknown } | null, 'nav:mail')) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
      <a className="nav__link" href="/admin/mail">
        <span className="nav__link-label">Mail</span>
      </a>
      <a className="nav__link" href="/admin/ai-auth">
        <span className="nav__link-label">AI Auth</span>
      </a>
    </div>
  )
}
