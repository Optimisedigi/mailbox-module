'use client'

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@payloadcms/ui'
import { userHasFeature } from '@/lib/access'
import { openMailLink } from '@/lib/mail/drafts'

/**
 * "Client email" drop-down notification, shown under the top-bar bell
 * (rendered by MailHeaderAlerts).
 *
 * Every client-email alert is a normal notification, so it is always in the
 * bell's list. This drop-down is only the "it just arrived" heads-up, and it
 * shows each alert ONCE, only when it arrives while the CMS is open:
 *
 *  - Alerts that already exist when the page opens (including ones the first
 *    sync of this visit creates for mail that came in while the CMS was
 *    closed) are the baseline and never drop down. The baseline lasts until
 *    this page has run one Gmail sync of its own (`synced: true`), so a
 *    throttled first sync cannot let older mail through on the next poll.
 *  - Ids that have dropped down are remembered in localStorage, so a reload or
 *    another tab never shows the same one again.
 *  - Only alerts created within FRESH_MS drop down.
 *
 * It hides itself after VISIBLE_MS (paused while hovered or focused).
 * "Open email" marks the alert read and opens the thread; × / Later only hide
 * the drop-down, leaving the alert unread in the bell.
 *
 * Polls GET /api/mail/client-alerts?sync=1 every POLL_MS while the tab is
 * visible; the server throttles the Gmail sync itself.
 */

export const POLL_MS = 60_000
export const VISIBLE_MS = 12_000
export const FRESH_MS = 10 * 60_000
export const SHOWN_STORAGE_KEY = 'mailbox-client-email-alerts-shown'
const MAX_REMEMBERED = 200
const MAIL_FEATURE = 'nav:mail'

export interface ClientEmailAlertRow {
  id: number | string
  title: string
  body: string
  url: string
  createdAt: string
}

/** "Client email – please read: Acme" -> "Acme". */
function clientNameFromTitle(title: string): string {
  const idx = title.indexOf(':')
  return idx >= 0 ? title.slice(idx + 1).trim() : title
}

function readShown(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SHOWN_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function rememberShown(ids: string[]): void {
  try {
    const next = [...readShown().filter((id) => !ids.includes(id)), ...ids].slice(-MAX_REMEMBERED)
    window.localStorage.setItem(SHOWN_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable: the session baseline still stops repeats in this tab.
  }
}

export default function ClientEmailAlert({
  suppressed,
  onArrive,
}: {
  /** The bell's list is open: hold the drop-down back (the alert is in the list). */
  suppressed: boolean
  /** A new alert dropped down (the bell refreshes its count and rings). */
  onArrive: () => void
}): ReactElement | null {
  const { user } = useAuth()
  const router = useRouter()
  const enabled = Boolean(user) && userHasFeature(user as { role?: unknown; featureAccess?: unknown } | null, MAIL_FEATURE)

  const [shown, setShown] = useState<ClientEmailAlertRow[]>([])
  const known = useRef<Set<string>>(new Set())
  const baselineDone = useRef(false)
  const hideTimer = useRef<number | null>(null)
  const onArriveRef = useRef(onArrive)
  onArriveRef.current = onArrive

  const clearTimer = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = null
  }, [])

  const startTimer = useCallback(() => {
    clearTimer()
    hideTimer.current = window.setTimeout(() => setShown([]), VISIBLE_MS)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  const load = useCallback(
    async (sync: boolean) => {
      try {
        const res = await fetch(`/api/mail/client-alerts${sync ? '?sync=1' : ''}`, { credentials: 'include' })
        if (!res.ok) return
        const data = (await res.json()) as { alerts?: ClientEmailAlertRow[]; synced?: boolean }
        const alerts = Array.isArray(data.alerts) ? data.alerts : []
        const unseen = alerts.filter((alert) => !known.current.has(String(alert.id)))
        for (const alert of alerts) known.current.add(String(alert.id))
        if (!baselineDone.current) {
          // Everything up to and including this page's own first sync is old news.
          if (data.synced === true) baselineDone.current = true
          return
        }
        const already = new Set(readShown())
        const now = Date.now()
        const fresh = unseen.filter((alert) => {
          const created = new Date(alert.createdAt).getTime()
          return !already.has(String(alert.id)) && Number.isFinite(created) && now - created <= FRESH_MS
        })
        if (fresh.length === 0) return
        rememberShown(fresh.map((alert) => String(alert.id)))
        setShown(fresh)
        startTimer()
        onArriveRef.current()
      } catch {
        // Silent: the bell list still has every alert.
      }
    },
    [startTimer],
  )

  useEffect(() => {
    if (!enabled) return
    void load(true)
    const tick = (): void => {
      if (document.visibilityState === 'visible') void load(true)
    }
    const id = window.setInterval(tick, POLL_MS)
    return () => window.clearInterval(id)
  }, [enabled, load])

  const hide = useCallback(() => {
    clearTimer()
    setShown([])
  }, [clearTimer])

  const current = shown[0]

  const open = useCallback(() => {
    if (!current) return
    hide()
    void fetch(`/api/notifications/${encodeURIComponent(String(current.id))}/mark-read`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => undefined)
    openMailLink(current.url || '/admin/mail', (url) => router.push(url))
  }, [current, hide, router])

  if (!enabled || !current || suppressed) return null
  const clientName = clientNameFromTitle(current.title)
  const more = shown.length - 1

  return (
    <section
      className="cea-drop"
      data-testid="client-email-alert"
      aria-label="New client email"
      onMouseEnter={clearTimer}
      onMouseLeave={startTimer}
      onFocus={clearTimer}
      onBlur={startTimer}
    >
      <style>{CSS}</style>
      <div role="status" aria-live="polite" className="cea-live">
        New client email from {clientName}
      </div>
      <div className="cea-row">
        <span className="cea-dot" aria-hidden="true" />
        <div className="cea-text">
          <div className="cea-top">
            <span className="cea-client">{clientName}</span>
            <span className="cea-kind">Client email{more > 0 ? ` · +${more} more` : ''}</span>
          </div>
          {current.body ? <div className="cea-body">{current.body}</div> : null}
        </div>
        <button type="button" className="cea-x" onClick={hide} aria-label="Hide (stays in notifications)" title="Hide (stays in notifications)">
          ×
        </button>
      </div>
      <div className="cea-actions">
        <button type="button" className="cea-primary" onClick={open}>
          Open email
        </button>
        <button type="button" className="cea-secondary" onClick={hide}>
          Later
        </button>
      </div>
    </section>
  )
}

const CSS = `
.cea-drop {
  position: absolute; top: calc(100% + 10px); right: -4px; z-index: 10001;
  width: 440px; max-width: calc(100vw - 24px); box-sizing: border-box;
  background: var(--theme-elevation-0, #fff); color: var(--theme-elevation-1000, #11141a);
  border: 1px solid var(--theme-elevation-150, #e5e7eb); border-radius: 12px; padding: 12px 12px 12px 14px;
  box-shadow: 0 12px 32px rgba(16, 20, 28, 0.18);
  font-family: 'Manrope', Helvetica, Arial, sans-serif; text-align: left;
  transform-origin: top right; animation: cea-drop 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.cea-drop::before {
  content: ''; position: absolute; top: -6px; right: 16px; width: 10px; height: 10px; transform: rotate(45deg);
  background: inherit; border-left: 1px solid var(--theme-elevation-150, #e5e7eb); border-top: 1px solid var(--theme-elevation-150, #e5e7eb);
}
.cea-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.cea-row { display: flex; align-items: flex-start; gap: 10px; }
.cea-dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 999px; background: #dc2626; flex: 0 0 8px; }
.cea-text { flex: 1; min-width: 0; }
.cea-top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.cea-client { font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cea-kind { margin-left: auto; flex: 0 0 auto; font-size: 11px; color: var(--theme-elevation-500, #6b7280); }
.cea-body { margin-top: 2px; font-size: 13px; line-height: 1.4; color: var(--theme-elevation-700, #374151);
  overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.cea-x { border: none; background: none; cursor: pointer; font-size: 18px; line-height: 1; color: var(--theme-elevation-500, #6b7280); padding: 0 4px; border-radius: 6px; }
.cea-x:hover, .cea-x:focus-visible { color: var(--theme-elevation-1000, #11141a); background: var(--theme-elevation-100, #f3f4f6); outline: none; }
.cea-actions { margin-top: 10px; padding-left: 18px; display: flex; gap: 8px; }
.cea-primary { border: none; cursor: pointer; background: #dc2626; color: #fff; font-weight: 700; font-size: 12px; padding: 6px 12px; border-radius: 7px; }
.cea-primary:hover, .cea-primary:focus-visible { background: #b91c1c; outline: none; }
.cea-secondary { border: 1px solid var(--theme-elevation-200, #d1d5db); cursor: pointer; background: none; color: inherit; font-weight: 600; font-size: 12px; padding: 5px 12px; border-radius: 7px; }
.cea-secondary:hover, .cea-secondary:focus-visible { background: var(--theme-elevation-100, #f3f4f6); outline: none; }
@keyframes cea-drop { from { transform: translateY(-8px) scale(0.98); opacity: 0 } to { transform: none; opacity: 1 } }
@media (max-width: 768px) {
  .cea-drop { position: fixed; top: 64px; left: 12px; right: 12px; width: auto; max-width: none; }
  .cea-drop::before { display: none; }
  .cea-primary, .cea-secondary { min-height: 40px; padding-left: 16px; padding-right: 16px; }
}
@media (prefers-reduced-motion: reduce) { .cea-drop { animation: none } }
`
