'use client'

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import styles from './MailApp.module.css'
import { isKeyDatesHeading, parseKeyDateLine, type KeyDate } from '../../lib/mail/key-dates'
import { mailAccountHeaders } from '../../lib/mail/accounts-shared'

/**
 * Client profile → Emails tab → "What we've discussed".
 *
 * Pull emails (one click, one search): the server searches the chosen Gmail
 * account for this client's emails (last 12 months; later pulls only what is
 * new), saves them to the client and has the AI write or update a brief.
 * Nothing stays connected to the mailbox afterwards.
 *
 * Search settings (shared by the team, per client): the client's own domains
 * and contacts, and/or chosen senders and keywords, matching any of them or a
 * sender AND a keyword. For clients that email from a parent company's domain.
 * Changing them makes the next pull start the brief afresh.
 *
 * Ask: questions are answered from the saved briefs and emails only, with the
 * emails used listed under each answer. The conversation lives in this page
 * (it is gone on reload); the brief and emails stay saved.
 */

export interface ClientEmailBrief {
  id: number
  /** The search settings the brief was written with ("" = before settings existed, i.e. the defaults). */
  filterKey: string
  account: string
  ownerId: number | null
  brief: string
  emailCount: number
  firstEmailDate: string | null
  lastEmailDate: string | null
  lastPulledAt: string | null
}

interface PullSettings {
  useClientContacts: boolean
  senders: string[]
  keywords: string[]
  matchMode: 'any' | 'all'
}

interface SettingsView {
  settings: PullSettings
  filterKey: string
  defaultFilterKey: string
  description: string
  clientTargets: { domains: string[]; addresses: string[] }
}

interface AskSource {
  label: string
  id: number
  subject: string
  date: string | null
  gmailLink: string | null
}

interface AskTurn {
  question: string
  answer: string
  sources: AskSource[]
}

interface PullSummary {
  found: number
  saved: number
  more: boolean
  leftOut: number
  briefUpdated: boolean
}

function fmt(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

function pullMessage(result: PullSummary): string {
  const parts: string[] = []
  if (result.found === 0) parts.push('No new emails with this client.')
  else {
    parts.push(`Found ${result.found} email${result.found === 1 ? '' : 's'}${result.saved ? ` (${result.saved} newly saved)` : ''}.`)
    if (result.briefUpdated) parts.push('Brief updated.')
  }
  if (result.more) parts.push('Only the newest 300 were read.')
  if (result.leftOut) parts.push(`${result.leftOut} older email${result.leftOut === 1 ? '' : 's'} did not fit in the brief.`)
  return parts.join(' ')
}

/** The AI's error text, or a plain message for Gmail connection problems. */
function errorFrom(status: number, data: { error?: string; reason?: string }): string {
  if (data.error === 'gmail-not-connected') return 'Connect this Gmail account in Mail first, then pull again.'
  if (data.error === 'scope-insufficient') return data.reason || 'Reconnect Gmail in Mail, then pull again.'
  return data.error || `Request failed (${status}).`
}

/**
 * The brief as written by the AI: "## " headings, "- " bullets and **bold**,
 * rendered as React text (never as HTML), since it comes from email content.
 */
export function BriefText({
  text,
  bulletExtra,
}: {
  text: string
  /** Something to show right after a bullet (e.g. Add to timeline on key dates), given its section heading. */
  bulletExtra?: (heading: string, bullet: string) => ReactNode
}) {
  const blocks: ReactNode[] = []
  let bullets: string[] = []
  let heading = ''
  const inline = (line: string, key: string): ReactNode[] =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={`${key}-${index}`}>{part.slice(2, -2)}</strong> : part,
    )
  const flush = () => {
    if (bullets.length === 0) return
    const items = bullets
    const section = heading
    blocks.push(
      <ul key={`ul-${blocks.length}`} style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
        {items.map((item, index) => (
          <li key={index}>
            {inline(item, `li-${blocks.length}-${index}`)}
            {bulletExtra ? bulletExtra(section, item) : null}
          </li>
        ))}
      </ul>,
    )
    bullets = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/)
    if (bullet) {
      bullets.push(bullet[1] ?? '')
      continue
    }
    flush()
    const headingMatch = line.match(/^#{1,4}\s+(.*)$/)
    if (headingMatch) {
      heading = headingMatch[1] ?? ''
      blocks.push(
        <h4 key={`h-${blocks.length}`} style={{ margin: '12px 0 4px', fontSize: 14 }}>
          {heading}
        </h4>,
      )
    } else {
      blocks.push(
        <p key={`p-${blocks.length}`} style={{ margin: '4px 0' }}>
          {inline(line, `p-${blocks.length}`)}
        </p>,
      )
    }
  }
  flush()
  return <div style={{ lineHeight: 1.5 }}>{blocks}</div>
}

export default function ClientEmailBriefPanel({
  clientId,
  briefs,
  hasEmails,
  onPulled,
}: {
  clientId: number | string
  briefs: ClientEmailBrief[]
  hasEmails: boolean
  /** Reload the tab after a pull (new emails and the new brief). */
  onPulled: () => Promise<void> | void
}) {
  const accountId = useId()
  const questionId = useId()
  const [accounts, setAccounts] = useState<string[] | null>(null)
  const [account, setAccount] = useState('')
  const [pulling, setPulling] = useState(false)
  const [pullNote, setPullNote] = useState('')
  const [pullError, setPullError] = useState('')
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState('')
  const [turns, setTurns] = useState<AskTurn[]>([])
  const [search, setSearch] = useState<SettingsView | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/mail/client-pull-settings?clientId=${encodeURIComponent(String(clientId))}`, { credentials: 'include' })
      .then(async (res) => (res.ok ? ((await res.json()) as SettingsView) : null))
      .then((data) => {
        if (!cancelled && data?.settings) setSearch(data)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [clientId])

  // The Gmail accounts this person can pull from: their main Gmail first.
  useEffect(() => {
    let cancelled = false
    fetch('/api/mail/accounts', { credentials: 'include' })
      .then(async (res) => (res.ok ? ((await res.json()) as { primary: string | null; accounts: Array<{ email: string }> }) : null))
      .then((data) => {
        if (cancelled || !data) return
        const list = [...new Set([data.primary, ...data.accounts.map((item) => item.email)].filter((email): email is string => Boolean(email)))]
        setAccounts(list)
        setAccount((current) => current || list[0] || '')
      })
      .catch(() => {
        if (!cancelled) setAccounts([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const primary = accounts?.[0] ?? ''
  const selectedBrief = briefs.find((brief) => brief.account.toLowerCase() === account.toLowerCase()) ?? null
  // The settings changed since this brief was written: the next pull starts it afresh.
  const briefOutdated = Boolean(search && selectedBrief && (selectedBrief.filterKey || search.defaultFilterKey) !== search.filterKey)
  const otherBriefs = briefs.filter((brief) => brief !== selectedBrief)

  async function pull() {
    if (pulling) return
    setPulling(true)
    setPullError('')
    setPullNote('')
    try {
      const res = await fetch('/api/mail/client-pull', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', ...mailAccountHeaders(account === primary ? '' : account) },
        body: JSON.stringify({ clientId: Number(clientId) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(errorFrom(res.status, data))
      setPullNote(pullMessage(data as PullSummary))
      await onPulled()
    } catch (err) {
      setPullError((err as Error).message)
    } finally {
      setPulling(false)
    }
  }

  async function ask() {
    const text = question.trim()
    if (!text || asking) return
    setAsking(true)
    setAskError('')
    try {
      const res = await fetch('/api/mail/client-ask', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: Number(clientId),
          question: text,
          history: turns.map(({ question: q, answer }) => ({ question: q, answer })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(errorFrom(res.status, data))
      setTurns((current) => [...current, { question: text, answer: data.answer, sources: data.sources ?? [] }])
      setQuestion('')
    } catch (err) {
      setAskError((err as Error).message)
    } finally {
      setAsking(false)
    }
  }

  function onQuestionKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void ask()
    }
  }

  const canAsk = briefs.length > 0 || hasEmails

  return (
    <section className={styles.panel} style={{ marginTop: 0, marginBottom: 16 }}>
      <h3 className={styles.panelTitle}>What we’ve discussed</h3>
      <p className={styles.muted} style={{ margin: 0 }}>
        Pull emails searches one Gmail account for this client’s emails ({selectedBrief && !briefOutdated ? 'new since the last pull' : 'the last 12 months'}),
        saves them here and writes a brief. Questions are answered from what is saved; Gmail is only read when you pull.
      </p>

      {search ? (
        <SearchSettings
          clientId={clientId}
          view={search}
          disabled={pulling}
          onSaved={setSearch}
          briefOutdated={briefOutdated}
        />
      ) : null}

      <div className={styles.actions}>
        {accounts && accounts.length > 1 ? (
          <span className={styles.assign}>
            <label htmlFor={accountId} className={styles.muted}>
              Gmail account
            </label>
            <select id={accountId} value={account} onChange={(e) => setAccount(e.target.value)} disabled={pulling}>
              {accounts.map((email) => (
                <option key={email} value={email}>
                  {email}
                </option>
              ))}
            </select>
          </span>
        ) : account ? (
          <span className={styles.muted}>Searches {account}</span>
        ) : null}
        <button
          type="button"
          className={`${styles.btn} ${styles.primary}`}
          onClick={() => void pull()}
          disabled={pulling || accounts === null}
          aria-busy={pulling}
        >
          {pulling ? 'Pulling emails…' : selectedBrief && !briefOutdated ? 'Pull new emails' : 'Pull emails'}
        </button>
      </div>
      <p className={pullError ? styles.errorText : styles.muted} role="status" aria-live="polite" style={{ margin: 0 }}>
        {pulling ? 'Searching Gmail and writing the brief. This can take a minute.' : pullError || pullNote}
      </p>

      {selectedBrief ? <BriefCard brief={selectedBrief} clientId={clientId} /> : null}
      {otherBriefs.map((brief) => (
        <BriefCard key={brief.id} brief={brief} clientId={clientId} />
      ))}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        <label htmlFor={questionId} style={{ fontWeight: 600 }}>
          Ask about these emails
        </label>
        {turns.map((turn, index) => (
          <div key={index} className={styles.message} style={{ marginTop: 0, background: 'var(--theme-elevation-0)' }}>
            <p style={{ margin: '0 0 6px', fontWeight: 600 }}>{turn.question}</p>
            <p className={styles.body}>{turn.answer}</p>
            {turn.sources.length ? (
              <details style={{ marginTop: 8 }}>
                <summary className={styles.muted} style={{ cursor: 'pointer' }}>
                  Emails it read ({turn.sources.length})
                </summary>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {turn.sources.map((source) => (
                    <li key={source.label} className={styles.muted}>
                      {source.label} · {fmt(source.date) || 'undated'} · {source.subject || '(no subject)'}
                      {source.gmailLink ? (
                        <>
                          {' · '}
                          <a className={styles.linkBtn} href={source.gmailLink} target="_blank" rel="noreferrer">
                            Open in Gmail
                          </a>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ))}
        <textarea
          id={questionId}
          className={styles.textarea}
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onQuestionKey}
          maxLength={1000}
          disabled={!canAsk || asking}
          placeholder={canAsk ? 'e.g. What did we agree about the March budget?' : 'Pull emails first, then ask about them here.'}
        />
        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={() => void ask()} disabled={!canAsk || asking || !question.trim()} aria-busy={asking}>
            {asking ? 'Reading…' : 'Ask'}
          </button>
          {turns.length ? (
            <button type="button" className={styles.linkBtn} onClick={() => setTurns([])} disabled={asking}>
              Clear conversation
            </button>
          ) : null}
        </div>
        {askError ? (
          <p className={styles.errorText} role="alert" style={{ margin: 0 }}>
            {askError}
          </p>
        ) : null}
      </div>
    </section>
  )
}

type KeyDateState = { status: 'idle' | 'adding' | 'added' | 'exists' | 'error'; error?: string }

/** "Add to timeline" right after a key date: one click adds it to the client's Account Timeline. */
export function AddKeyDateButton({ clientId, keyDate }: { clientId: number | string; keyDate: KeyDate }) {
  const [state, setState] = useState<KeyDateState>({ status: 'idle' })

  async function add() {
    setState({ status: 'adding' })
    try {
      const res = await fetch('/api/mail/client-timeline', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: Number(clientId), day: keyDate.day, description: keyDate.description }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not add it (${res.status}).`)
      setState({ status: data.added ? 'added' : 'exists' })
    } catch (err) {
      setState({ status: 'error', error: (err as Error).message })
    }
  }

  if (state.status === 'added' || state.status === 'exists') {
    return (
      <span className={styles.muted} role="status" style={{ marginLeft: 8, fontSize: 12 }}>
        {state.status === 'added' ? 'Added to timeline ✓' : 'Already on timeline ✓'}
      </span>
    )
  }
  return (
    <>
      <button
        type="button"
        className={styles.linkBtn}
        style={{ marginLeft: 8, fontSize: 12 }}
        onClick={() => void add()}
        disabled={state.status === 'adding'}
        aria-busy={state.status === 'adding'}
        aria-label={`Add to account timeline: ${keyDate.day}, ${keyDate.description}`}
        title="Add this date to the client's Account Timeline"
      >
        {state.status === 'adding' ? 'Adding…' : '+ Timeline'}
      </button>
      {state.status === 'error' ? (
        <span className={styles.errorText} role="alert" style={{ marginLeft: 6, fontSize: 12 }}>
          {state.error}
        </span>
      ) : null}
    </>
  )
}

/** Bullet extra for BriefText: the add button on key-date bullets only. */
export function keyDateButtons(clientId: number | string) {
  return function KeyDateExtra(heading: string, bullet: string) {
    if (!isKeyDatesHeading(heading)) return null
    const keyDate = parseKeyDateLine(bullet)
    return keyDate ? <AddKeyDateButton clientId={clientId} keyDate={keyDate} /> : null
  }
}

function BriefCard({ brief, clientId }: { brief: ClientEmailBrief; clientId: number | string }) {
  const range = [fmt(brief.firstEmailDate), fmt(brief.lastEmailDate)].filter(Boolean).join(' – ')
  return (
    <div className={styles.message} style={{ marginTop: 4, background: 'var(--theme-elevation-0)' }}>
      <p className={styles.muted} style={{ margin: '0 0 6px' }}>
        {brief.account || 'Gmail'} · {brief.emailCount} saved email{brief.emailCount === 1 ? '' : 's'}
        {range ? ` · ${range}` : ''}
        {brief.lastPulledAt ? ` · pulled ${fmt(brief.lastPulledAt)}` : ''}
      </p>
      {brief.brief ? <BriefText text={brief.brief} bulletExtra={keyDateButtons(clientId)} /> : <p className={styles.muted}>No brief yet.</p>}
    </div>
  )
}

/** One entry per line (commas also split), for the two text boxes. */
function lines(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function SearchSettings({
  clientId,
  view,
  disabled,
  onSaved,
  briefOutdated,
}: {
  clientId: number | string
  view: SettingsView
  disabled: boolean
  onSaved: (view: SettingsView) => void
  briefOutdated: boolean
}) {
  const sendersId = useId()
  const keywordsId = useId()
  const [open, setOpen] = useState(false)
  const [useClientContacts, setUseClientContacts] = useState(view.settings.useClientContacts)
  const [senders, setSenders] = useState(view.settings.senders.join('\n'))
  const [keywords, setKeywords] = useState(view.settings.keywords.join('\n'))
  const [matchMode, setMatchMode] = useState<'any' | 'all'>(view.settings.matchMode)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const contacts = [...view.clientTargets.domains, ...view.clientTargets.addresses]
  const hasWho = useClientContacts || lines(senders).length > 0
  const hasWords = lines(keywords).length > 0

  async function save() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/mail/client-pull-settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: Number(clientId),
          useClientContacts,
          senders: lines(senders),
          keywords: lines(keywords),
          // "Both" only means something with a sender and a keyword.
          matchMode: hasWho && hasWords ? matchMode : 'any',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not save (${res.status}).`)
      const next = data as SettingsView
      onSaved(next)
      setSenders(next.settings.senders.join('\n'))
      setKeywords(next.settings.keywords.join('\n'))
      setOpen(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.message} style={{ marginTop: 0, background: 'var(--theme-elevation-0)' }}>
      <div className={styles.actions} style={{ justifyContent: 'space-between' }}>
        <span>
          <strong>Searches for:</strong> {view.description || 'nothing yet'}
        </span>
        <button type="button" className={styles.linkBtn} onClick={() => setOpen((value) => !value)} aria-expanded={open} disabled={disabled}>
          {open ? 'Close search settings' : 'Search settings'}
        </button>
      </div>
      {briefOutdated ? (
        <p className={styles.muted} style={{ margin: '6px 0 0' }}>
          The search settings changed since the brief below was written. The next pull searches the last 12 months again and writes a new brief.
        </p>
      ) : null}
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={useClientContacts} onChange={(e) => setUseClientContacts(e.target.checked)} />
            <span>
              The client’s website domain and contacts
              <span className={styles.muted} style={{ display: 'block' }}>
                {contacts.length ? contacts.join(', ') : 'None on the client record'}. Untick when these are a parent company’s domain shared with other clients.
              </span>
            </span>
          </label>
          <label htmlFor={sendersId} style={{ fontWeight: 600 }}>
            Senders or recipients
            <span className={styles.muted} style={{ display: 'block', fontWeight: 400 }}>
              Email addresses or domains, one per line, e.g. pmorris@northwind.com.au
            </span>
          </label>
          <textarea id={sendersId} className={styles.textarea} rows={3} value={senders} onChange={(e) => setSenders(e.target.value)} />
          <label htmlFor={keywordsId} style={{ fontWeight: 600 }}>
            Keywords
            <span className={styles.muted} style={{ display: 'block', fontWeight: 400 }}>
              Words or phrases in the subject or body, one per line, e.g. Custom Fluid Power
            </span>
          </label>
          <textarea id={keywordsId} className={styles.textarea} rows={3} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }} disabled={!hasWho || !hasWords}>
            <legend style={{ fontWeight: 600, padding: 0, marginBottom: 4 }}>Include an email when it matches</legend>
            <label style={{ display: 'flex', gap: 8 }}>
              <input type="radio" name={`match-${sendersId}`} checked={matchMode === 'any'} onChange={() => setMatchMode('any')} />
              Any of them: a sender or a keyword
            </label>
            <label style={{ display: 'flex', gap: 8 }}>
              <input type="radio" name={`match-${sendersId}`} checked={matchMode === 'all'} onChange={() => setMatchMode('all')} />
              Both: one of the senders and one of the keywords
            </label>
          </fieldset>
          {error ? (
            <p className={styles.errorText} role="alert" style={{ margin: 0 }}>
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={() => void save()} disabled={saving || disabled} aria-busy={saving}>
              {saving ? 'Saving…' : 'Save search settings'}
            </button>
            <span className={styles.muted}>Shared with the team for this client.</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
