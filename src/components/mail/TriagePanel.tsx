'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { findTagByName, MAX_TAG_NAME, senderMatchesSearch, type MailTag } from '../../lib/mail/tags'
import { browserStorage } from '../../lib/mail/ai-prompt-store'
import { loadSavedTriage, saveTriage } from '../../lib/mail/triage-store'
import styles from './TriagePanel.module.css'

/** Mirrors the /api/mail/triage response (src/lib/mail/triage.ts). */
export interface TriageSenderRow {
  address: string
  name: string
  count: number
  subjects: string[]
  messageIds: string[]
  /** A message whose sender offers one-click unsubscribe; missing when they do not. */
  unsubscribeId?: string
}

export interface TriageCategoryRow {
  key: string
  label: string
  count: number
  defaultSelected: boolean
  /** What the AI said belongs in this category. */
  description?: string
  senders: TriageSenderRow[]
}

interface TriageResult {
  categories: TriageCategoryRow[]
  scanned: number
  truncated: boolean
  failedBatches: number
}

/** Ids per apply request (the route's cap). */
const APPLY_CHUNK = 1000
/** Senders per unsubscribe request (the route's cap). */
const UNSUBSCRIBE_CHUNK = 25
/** Ids per "read" step (the route's cap, TRIAGE_READ_CHUNK). */
const READ_CHUNK = 200
/** Gmail's per-account read rate the route keeps to (TRIAGE_READS_PER_MINUTE). */
const READS_PER_MINUTE = 250

/** A message's sender and subject, as the "read" step returns them. */
type TriageMessage = Record<string, unknown>

/** "about 12 minutes" / "under a minute" for the reads still to do. */
function timeLeft(remaining: number): string {
  const minutes = Math.ceil(remaining / READS_PER_MINUTE)
  return minutes <= 1 ? 'under a minute' : `about ${minutes} minutes`
}
const SUBJECTS_SHOWN = 3

/** Progress and result wording for the footer actions. */
const APPLY_WORDS = {
  archive: { doing: 'Archiving', done: 'Archived' },
  read: { doing: 'Marking read', done: 'Marked read' },
  trash: { doing: 'Deleting', done: 'Deleted' },
} as const

/** Fixed colours for the two groups that always exist. */
const CATEGORY_TONES: Record<string, string> = {
  keep: '#5b8c5a',
  clients: '#1f6f8b',
}
/** Colours for the AI's own categories ("ai-1", "ai-2", ...), in order. */
const AI_TONES = ['#e4572e', '#2c97c9', '#f0a202', '#8e7cc3', '#d36ba6', '#3fa796', '#a0522d', '#6c7a89']

const fmt = (n: number) => n.toLocaleString('en-AU')
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`

/** Which tag to apply: one already saved, or a new one by name (saved first). */
type TagChoice = { kind: 'existing'; id: string } | { kind: 'new'; name: string }

const NEW_TAG = '__new'

/** "Tag N emails as [tag ▾] [Tag]": pick a saved tag or type a new one. */
function TagPicker({
  tags,
  emails,
  scope,
  disabled,
  busy,
  onApply,
}: {
  tags: MailTag[]
  emails: number
  /** "selected" / "matching": says which emails the button tags. */
  scope: string
  disabled: boolean
  busy: boolean
  onApply: (choice: TagChoice) => void
}) {
  const [value, setValue] = useState('')
  const [name, setName] = useState('')
  const isNew = value === NEW_TAG || (value === '' && tags.length === 0)
  const ready = emails > 0 && (isNew ? name.trim() !== '' : tags.some((tag) => tag.id === value))
  return (
    <form
      className={styles.tagPicker}
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready || disabled) return
        onApply(isNew ? { kind: 'new', name } : { kind: 'existing', id: value })
        setName('')
      }}
    >
      {tags.length > 0 ? (
        <select
          className={styles.select}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          aria-label={`Tag for the ${scope} emails`}
        >
          <option value="">Choose a tag…</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
          <option value={NEW_TAG}>New tag…</option>
        </select>
      ) : null}
      {isNew ? (
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={MAX_TAG_NAME}
          placeholder="New tag, e.g. Baby reads"
          disabled={disabled}
          aria-label={`New tag name for the ${scope} emails`}
        />
      ) : null}
      <button type="submit" className={styles.btn} disabled={disabled || !ready}>
        {busy ? 'Tagging…' : `Tag ${plural(emails, `${scope} email`)}`}
      </button>
    </form>
  )
}

function defaultSelection(categories: TriageCategoryRow[]): Set<string> {
  return new Set(categories.filter((category) => category.defaultSelected).flatMap((category) => category.senders.map((sender) => sender.address)))
}

/**
 * On-request inbox triage: the AI proposes categories for this inbox and
 * sorts unread senders (sender + subject only) into them; the user unticks anything to keep and archives or marks
 * the rest read. Nothing changes in Gmail until Archive / Mark read is clicked.
 * The search finds senders (name, address or subject) to tick or untick
 * together, and emails can be tagged (Gmail labels) to work through later.
 *
 * With `account` set, the results are kept in this browser (see
 * triage-store) until they are all actioned: closing the panel or reloading
 * Mail shows them again, and triaging again replaces them.
 */
export default function TriagePanel({
  api,
  onApplied,
  onClose,
  fullView = true,
  onFullViewChange,
  onOpenTag,
  account,
}: {
  api: <T>(url: string, init?: RequestInit) => Promise<T>
  /** The Gmail account on screen ('' = main Gmail); set to keep the last triage in this browser. */
  account?: string
  onApplied: () => void
  onClose: () => void
  /** Expanded: the panel takes the whole mail area. Collapsed: a one-line bar (results and any run are kept). */
  fullView?: boolean
  onFullViewChange?: (fullView: boolean) => void
  /** List a tag's emails in Mail, to work through them. */
  onOpenTag?: (tag: MailTag) => void
}) {
  // The last triage saved for this account, if any (read once; MailApp keys the panel by account).
  const [saved] = useState(() => (account === undefined ? null : loadSavedTriage(browserStorage(), account, Date.now())))
  const [result, setResult] = useState<TriageResult | null>(saved?.result ?? null)
  // When the results on screen were made, so saved results say how old they are.
  const [ranAt, setRanAt] = useState<number | null>(saved?.savedAt ?? null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(saved?.selected ?? []))
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'' | 'archive' | 'read' | 'trash' | 'tag' | 'unsubscribe'>('')
  const [note, setNote] = useState('')
  // Finds senders in the results (name, address or subject) to tick or untick together.
  const [search, setSearch] = useState('')
  // The account's saved tags (Gmail labels); null until loaded.
  const [tags, setTags] = useState<MailTag[] | null>(null)
  const [tagsError, setTagsError] = useState('')
  // Stops a running triage when the panel closes.
  const runRef = useRef<AbortController | null>(null)
  useEffect(() => () => runRef.current?.abort(), [])

  // Keep the results (and what is ticked) until they are all actioned; a new run overwrites them.
  // False when the browser would not store them (storage full or blocked), so the panel can say so.
  const [kept, setKept] = useState(true)
  useEffect(() => {
    if (account === undefined || !result || ranAt === null) return
    setKept(saveTriage(browserStorage(), account, { result, selected: [...selected].sort(), savedAt: ranAt }))
  }, [account, result, selected, ranAt])

  const loadTags = useCallback(async () => {
    try {
      const data = await api<{ tags: MailTag[] }>('/api/mail/tags')
      setTags(Array.isArray(data.tags) ? data.tags : [])
      setTagsError('')
    } catch (err) {
      setTagsError(`Could not load your tags: ${(err as Error).message}`)
    }
  }, [api])
  // Tags are a cheap Gmail lookup (no AI), so the list is there to open straight away.
  useEffect(() => {
    void loadTags()
    // Once per panel (MailApp keys it by account); `api` is a new function every render.
  }, [])

  /**
   * List the unread ids, read their senders and subjects in chunks (Gmail lets
   * one account read only about 300 a minute, so a big inbox takes minutes),
   * then sort. If Gmail stops a later chunk, what was read so far is sorted.
   */
  async function runTriage() {
    runRef.current?.abort()
    const run = new AbortController()
    runRef.current = run
    const post = <T,>(body: unknown) =>
      api<T>('/api/mail/triage', { method: 'POST', body: JSON.stringify(body), signal: run.signal })
    setLoading(true)
    setNote('Finding unread emails…')
    try {
      const listed = await post<{ ids: string[]; truncated: boolean }>({ step: 'list' })
      const messages: TriageMessage[] = []
      let stoppedEarly = ''
      for (let i = 0; i < listed.ids.length; i += READ_CHUNK) {
        setNote(
          `Reading senders and subjects: ${fmt(i)} of ${fmt(listed.ids.length)}. Gmail allows about ${READS_PER_MINUTE} a minute, so this takes ${timeLeft(listed.ids.length - i)}. You can keep using Mail.`,
        )
        try {
          const read = await post<{ messages: TriageMessage[] }>({ step: 'read', ids: listed.ids.slice(i, i + READ_CHUNK) })
          messages.push(...read.messages)
        } catch (err) {
          if (run.signal.aborted || messages.length === 0) throw err
          stoppedEarly = (err as Error).message
          break
        }
      }
      if (run.signal.aborted) return
      setNote(`Sorting ${plural(messages.length, 'email')} by sender…`)
      const sorted = await post<Omit<TriageResult, 'truncated'>>({ step: 'sort', messages })
      if (run.signal.aborted) return
      setResult({ ...sorted, truncated: listed.truncated || stoppedEarly !== '' })
      setRanAt(Date.now())
      setSelected(defaultSelection(sorted.categories))
      setExpanded(new Set())
      setNote(stoppedEarly ? `Gmail stopped the reading early (${stoppedEarly}). These are the emails read so far.` : '')
    } catch (err) {
      if (!run.signal.aborted) setNote((err as Error).message)
    } finally {
      if (runRef.current === run) {
        runRef.current = null
        setLoading(false)
      }
    }
  }

  const totals = useMemo(() => {
    const senders = result?.categories.flatMap((category) => category.senders) ?? []
    const picked = senders.filter((sender) => selected.has(sender.address))
    return {
      emails: senders.reduce((sum, sender) => sum + sender.count, 0),
      senders: senders.length,
      pickedEmails: picked.reduce((sum, sender) => sum + sender.count, 0),
      pickedSenders: picked.length,
      pickedIds: picked.flatMap((sender) => sender.messageIds),
      /** Ticked senders offering one-click unsubscribe. */
      unsubscribable: picked.filter((sender) => sender.unsubscribeId),
    }
  }, [result, selected])

  /** Senders matching the search, with their category; null when not searching. */
  const matches = useMemo(() => {
    if (!result || !search.trim()) return null
    return result.categories.flatMap((category) =>
      category.senders.filter((sender) => senderMatchesSearch(sender, search)).map((sender) => ({ sender, category })),
    )
  }, [result, search])
  const matchTotals = useMemo(() => {
    const senders = matches?.map((match) => match.sender) ?? []
    const picked = senders.filter((sender) => selected.has(sender.address))
    return {
      emails: senders.reduce((sum, sender) => sum + sender.count, 0),
      pickedEmails: picked.reduce((sum, sender) => sum + sender.count, 0),
      pickedSenders: picked.length,
      ids: senders.flatMap((sender) => sender.messageIds),
      addresses: senders.map((sender) => sender.address),
    }
  }, [matches, selected])

  function setMany(addresses: string[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      for (const address of addresses) {
        if (on) next.add(address)
        else next.delete(address)
      }
      return next
    })
  }

  /**
   * Add a tag (Gmail label) to these emails, saving a new tag first. Their
   * senders are then unticked, so Archive / Mark read leave tagged mail alone.
   */
  async function tagEmails(target: { ids: string[]; addresses: string[] }, choice: TagChoice) {
    if (busy !== '' || target.ids.length === 0) return
    setBusy('tag')
    setNote('')
    let done = 0
    try {
      let tag = choice.kind === 'existing' ? tags?.find((entry) => entry.id === choice.id) : findTagByName(tags ?? [], choice.name)
      if (!tag && choice.kind === 'new') {
        setNote(`Saving the tag "${choice.name.trim()}"…`)
        tag = (await api<{ tag: MailTag }>('/api/mail/tags', { method: 'POST', body: JSON.stringify({ name: choice.name }) })).tag
        const saved = tag
        setTags((current) => (current && !current.some((entry) => entry.id === saved.id) ? [...current, saved].sort((a, b) => a.name.localeCompare(b.name)) : current))
      }
      if (!tag) throw new Error('Choose a tag first.')
      for (let i = 0; i < target.ids.length; i += APPLY_CHUNK) {
        const chunk = target.ids.slice(i, i + APPLY_CHUNK)
        setNote(`Tagging ${fmt(Math.min(i + chunk.length, target.ids.length))} of ${fmt(target.ids.length)} as "${tag.name}"…`)
        await api('/api/mail/triage/apply', { method: 'POST', body: JSON.stringify({ messageIds: chunk, action: 'tag', tagId: tag.id }) })
        done += chunk.length
      }
      setMany(target.addresses, false)
      setNote(`Tagged ${plural(done, 'email')} "${tag.name}". Their senders are now unticked, so Archive and Mark read leave them alone.`)
    } catch (err) {
      setNote(`${(err as Error).message}${done ? ` (${fmt(done)} tagged before it stopped)` : ''}`)
    } finally {
      setBusy('')
      void loadTags()
    }
  }

  function toggleSender(address: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(address)
      else next.delete(address)
      return next
    })
  }

  function toggleCategory(category: TriageCategoryRow, on: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      for (const sender of category.senders) {
        if (on) next.add(sender.address)
        else next.delete(sender.address)
      }
      return next
    })
  }

  function toggleExpanded(key: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function apply(action: 'archive' | 'read' | 'trash') {
    const ids = totals.pickedIds
    if (busy !== '' || ids.length === 0) return
    if (
      action === 'trash' &&
      !window.confirm(`Delete ${plural(ids.length, 'email')}? They go to Gmail's Bin, where you can restore them for 30 days.`)
    ) {
      return
    }
    const words = APPLY_WORDS[action]
    setBusy(action)
    setNote('')
    const done = new Set<string>()
    try {
      for (let i = 0; i < ids.length; i += APPLY_CHUNK) {
        const chunk = ids.slice(i, i + APPLY_CHUNK)
        setNote(`${words.doing} ${fmt(Math.min(i + chunk.length, ids.length))} of ${fmt(ids.length)}…`)
        await api('/api/mail/triage/apply', { method: 'POST', body: JSON.stringify({ messageIds: chunk, action }) })
        for (const id of chunk) done.add(id)
      }
      setNote(`${words.done} ${plural(done.size, 'email')}${action === 'trash' ? " (in Gmail's Bin for 30 days)" : ''}.`)
    } catch (err) {
      setNote(`${(err as Error).message}${done.size ? ` (${fmt(done.size)} done before it stopped)` : ''}`)
    } finally {
      dropCleared(done)
      setBusy('')
    }
  }

  /** Drop what was cleared from the summary; senders with emails left stay listed. */
  function dropCleared(done: Set<string>) {
    if (done.size === 0) return
    setResult((current) =>
      current
        ? {
            ...current,
            categories: current.categories
              .map((category) => {
                const senders = category.senders
                  .map((sender) => {
                    const messageIds = sender.messageIds.filter((id) => !done.has(id))
                    return { ...sender, messageIds, count: Math.max(0, sender.count - (sender.messageIds.length - messageIds.length)) }
                  })
                  .filter((sender) => sender.count > 0)
                return { ...category, senders, count: senders.reduce((sum, sender) => sum + sender.count, 0) }
              })
              .filter((category) => category.senders.length > 0),
          }
        : current,
    )
    onApplied()
  }

  /**
   * One-click unsubscribe from the ticked senders that offer it, then archive
   * the emails of each sender that was unsubscribed. Senders that could not be
   * unsubscribed keep their emails and stay ticked.
   */
  async function unsubscribeAndArchive() {
    const senders = totals.unsubscribable
    if (busy !== '' || senders.length === 0) return
    const skipped = totals.pickedSenders - senders.length
    if (
      !window.confirm(
        `Unsubscribe from ${plural(senders.length, 'sender')} and archive their emails?${skipped ? ` ${plural(skipped, 'other ticked sender')} without one-click unsubscribe will be left alone.` : ''}`,
      )
    ) {
      return
    }
    setBusy('unsubscribe')
    setNote('')
    const unsubscribed: TriageSenderRow[] = []
    let failed = 0
    let unavailable = 0
    const done = new Set<string>()
    try {
      for (let i = 0; i < senders.length; i += UNSUBSCRIBE_CHUNK) {
        const chunk = senders.slice(i, i + UNSUBSCRIBE_CHUNK)
        setNote(`Unsubscribing ${fmt(Math.min(i + chunk.length, senders.length))} of ${fmt(senders.length)} senders…`)
        const data = await api<{ results: Array<{ messageId: string; status: string }> }>('/api/mail/triage/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({ messageIds: chunk.map((sender) => sender.unsubscribeId) }),
        })
        const status = new Map((data.results ?? []).map((row) => [row.messageId, row.status]))
        for (const sender of chunk) {
          const outcome = status.get(sender.unsubscribeId ?? '')
          if (outcome === 'unsubscribed') unsubscribed.push(sender)
          else if (outcome === 'unavailable') unavailable += 1
          else failed += 1
        }
      }
      const ids = unsubscribed.flatMap((sender) => sender.messageIds)
      for (let i = 0; i < ids.length; i += APPLY_CHUNK) {
        const chunk = ids.slice(i, i + APPLY_CHUNK)
        setNote(`Archiving ${fmt(Math.min(i + chunk.length, ids.length))} of ${fmt(ids.length)}…`)
        await api('/api/mail/triage/apply', { method: 'POST', body: JSON.stringify({ messageIds: chunk, action: 'archive' }) })
        for (const id of chunk) done.add(id)
      }
      const left = failed + unavailable
      setNote(
        `Unsubscribed from ${plural(unsubscribed.length, 'sender')} and archived ${plural(done.size, 'email')}.` +
          (left ? ` ${plural(left, 'sender')} could not be unsubscribed; their emails were left alone.` : ''),
      )
    } catch (err) {
      setNote(
        `${(err as Error).message}${unsubscribed.length ? ` (unsubscribed from ${plural(unsubscribed.length, 'sender')}, ${fmt(done.size)} emails archived before it stopped)` : ''}`,
      )
    } finally {
      dropCleared(done)
      setBusy('')
    }
  }

  const categoryTone = (key: string) => {
    const aiIndex = /^ai-(\d+)$/.exec(key)?.[1]
    if (aiIndex) return AI_TONES[(Number(aiIndex) - 1) % AI_TONES.length] ?? 'var(--theme-elevation-400)'
    return CATEGORY_TONES[key] ?? 'var(--theme-elevation-400)'
  }

  const senderRow = (sender: TriageSenderRow, category?: TriageCategoryRow) => (
    <tr key={sender.address} className={selected.has(sender.address) ? undefined : styles.kept}>
      <td className={styles.checkCol}>
        <input
          type="checkbox"
          checked={selected.has(sender.address)}
          onChange={(e) => toggleSender(sender.address, e.target.checked)}
          disabled={busy !== ''}
          aria-label={`Clear ${sender.name} (${sender.address})`}
        />
      </td>
      <td className={styles.senderCell}>
        <span className={styles.senderName}>{sender.name}</span>
        {sender.name !== sender.address ? <span className={styles.senderAddress}>{sender.address}</span> : null}
        {sender.unsubscribeId ? <span className={styles.senderAddress}>One-click unsubscribe</span> : null}
      </td>
      {category ? (
        <td>
          <span className={styles.categoryCell}>
            <span className={styles.swatch} style={{ background: categoryTone(category.key) }} aria-hidden="true" />
            {category.label}
          </span>
        </td>
      ) : null}
      <td className={`${styles.num} ${styles.strong}`}>{fmt(sender.count)}</td>
      <td className={styles.subjects}>
        {sender.subjects.slice(0, SUBJECTS_SHOWN).join(' · ')}
        {sender.subjects.length > SUBJECTS_SHOWN ? (
          <details className={styles.more}>
            <summary>+{fmt(sender.subjects.length - SUBJECTS_SHOWN)} more subjects</summary>
            <ul>
              {sender.subjects.slice(SUBJECTS_SHOWN).map((subject) => (
                <li key={subject}>{subject}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </td>
    </tr>
  )

  return (
    <div className={`${styles.panel} ${fullView ? styles.full : styles.collapsed}`} aria-label="Inbox triage">
      <div className={styles.head}>
        <h3 className={styles.title}>Triage unread</h3>
        {!fullView ? (
          <span className={`${styles.muted} ${styles.collapsedSummary}`}>
            {loading
              ? 'Sorting unread emails…'
              : result
                ? `${plural(totals.emails, 'unread email')} in ${plural(result.categories.length, 'category', 'categories')}, ${fmt(totals.pickedEmails)} selected`
                : 'Not run yet'}
          </span>
        ) : null}
        <span className={styles.headActions}>
          {onFullViewChange ? (
            <button type="button" className={styles.linkBtn} onClick={() => onFullViewChange(!fullView)} aria-expanded={fullView}>
              {fullView ? 'Collapse' : 'Expand'}
            </button>
          ) : null}
          <button type="button" className={styles.linkBtn} onClick={onClose}>
            Close
          </button>
        </span>
      </div>
      <div className={styles.body} hidden={!fullView}>
      <p className={styles.muted}>
        Runs only when you click the button below. The AI sees each sender and subject line, never the emails themselves, and makes up
        categories to fit your inbox. Untick anything
        you want to keep, or find a sender to untick all of theirs at once. Tag emails to keep them in a pile you can open
        later; tagged senders are unticked. Nothing changes in Gmail until you click Mark read, Archive, Delete, Unsubscribe or Tag. Delete moves emails to Gmail's Bin, where they can be restored for 30 days.
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={() => void runTriage()} disabled={loading || busy !== ''}>
          {loading ? 'Sorting unread emails…' : result ? 'Triage again' : 'Triage unread emails'}
        </button>
      </div>
      {tags && tags.length > 0 && onOpenTag ? (
        <nav className={styles.tags} aria-label="Your tags">
          <span className={styles.muted}>Your tags:</span>
          {tags.map((tag) => (
            <button key={tag.id} type="button" className={styles.tagChip} onClick={() => onOpenTag(tag)} aria-label={`Open tag ${tag.name}`}>
              {tag.name}
              {tag.unread !== null ? <span className={styles.tagCount}>{tag.unread ? `${fmt(tag.unread)} unread` : fmt(tag.total ?? 0)}</span> : null}
            </button>
          ))}
        </nav>
      ) : null}
      {tagsError ? <p className={styles.muted}>{tagsError}</p> : null}

      {result ? (
        <>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.statValue}>{fmt(totals.emails)}</span>
              <span className={styles.statLabel}>unread emails</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{fmt(totals.senders)}</span>
              <span className={styles.statLabel}>senders</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{fmt(totals.pickedEmails)}</span>
              <span className={styles.statLabel}>selected to clear</span>
            </div>
          </div>
          {totals.emails > 0 ? (
            <div className={styles.stack} aria-hidden="true">
              {result.categories.map((category) => (
                <span
                  key={category.key}
                  className={styles.stackPart}
                  style={{ flexGrow: category.count, background: categoryTone(category.key) }}
                  title={`${category.label}: ${fmt(category.count)}`}
                />
              ))}
            </div>
          ) : null}
          {!kept ? (
            <p className={styles.muted} role="alert">
              This browser would not keep these results (its storage is full or blocked), so they will be gone once you close this
              panel or leave Mail.
            </p>
          ) : null}
          {saved && ranAt === saved.savedAt ? (
            <p className={styles.muted}>
              Saved results from {new Date(ranAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.
              They stay here until you action them; Triage again replaces them.
            </p>
          ) : null}
          <p className={styles.summary}>
            {totals.emails === 0
              ? 'No unread emails left to triage.'
              : `${plural(totals.emails, 'unread email')} from ${plural(totals.senders, 'sender')}.`}
            {result.truncated ? ` Only the newest ${fmt(result.scanned)} were checked; triage again after clearing these.` : ''}
            {result.failedBatches > 0 ? ' Some senders could not be sorted and are under Might need a look.' : ''}
          </p>

          {result.categories.length > 0 ? (
            <div className={styles.searchBar} role="search">
              <input
                type="search"
                className={styles.input}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find a sender, address or subject"
                aria-label="Find senders"
              />
              {matches ? (
                <>
                  <span className={styles.muted}>
                    {matches.length === 0
                      ? 'No senders match.'
                      : `${plural(matches.length, 'matching sender')}, ${plural(matchTotals.emails, 'email')}; ${fmt(matchTotals.pickedEmails)} selected`}
                  </span>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => setMany(matchTotals.addresses, false)}
                    disabled={busy !== '' || matchTotals.pickedSenders === 0}
                  >
                    Untick all matching
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => setMany(matchTotals.addresses, true)}
                    disabled={busy !== '' || matchTotals.pickedSenders === (matches?.length ?? 0)}
                  >
                    Tick all matching
                  </button>
                  <button type="button" className={styles.linkBtn} onClick={() => setSearch('')}>
                    Clear search
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {matches && matches.length > 0 ? (
            <>
              <TagPicker
                tags={tags ?? []}
                emails={matchTotals.emails}
                scope="matching"
                disabled={busy !== ''}
                busy={busy === 'tag'}
                onApply={(choice) => void tagEmails({ ids: matchTotals.ids, addresses: matchTotals.addresses }, choice)}
              />
              <div className={styles.tableWrap}>
                <table className={styles.senderTable}>
                  <caption className={styles.srOnly}>Senders matching the search</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={styles.checkCol}>
                        <span className={styles.srOnly}>Clear</span>
                      </th>
                      <th scope="col">Sender</th>
                      <th scope="col">Category</th>
                      <th scope="col" className={styles.num}>
                        Emails
                      </th>
                      <th scope="col">Subjects</th>
                    </tr>
                  </thead>
                  <tbody>{matches.map(({ sender, category }) => senderRow(sender, category))}</tbody>
                </table>
              </div>
            </>
          ) : null}
          {result.categories.length > 0 && !matches ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>Unread emails by category</caption>
                <thead>
                  <tr>
                    <th scope="col" className={styles.checkCol}>
                      <span className={styles.srOnly}>Clear</span>
                    </th>
                    <th scope="col">Category</th>
                    <th scope="col" className={styles.num}>
                      Emails
                    </th>
                    <th scope="col" className={styles.num}>
                      Senders
                    </th>
                    <th scope="col" className={styles.shareCol}>
                      Share
                    </th>
                    <th scope="col" className={styles.num}>
                      Selected
                    </th>
                  </tr>
                </thead>
                {result.categories.map((category) => {
                  const pickedSenders = category.senders.filter((sender) => selected.has(sender.address))
                  const picked = pickedSenders.length
                  const pickedEmails = pickedSenders.reduce((sum, sender) => sum + sender.count, 0)
                  const open = expanded.has(category.key)
                  const share = totals.emails ? Math.round((category.count / totals.emails) * 100) : 0
                  return (
                    <tbody key={category.key} className={styles.group}>
                      <tr className={styles.categoryRow}>
                        <td className={styles.checkCol}>
                          <input
                            type="checkbox"
                            checked={picked === category.senders.length}
                            ref={(el) => {
                              if (el) el.indeterminate = picked > 0 && picked < category.senders.length
                            }}
                            onChange={(e) => toggleCategory(category, e.target.checked)}
                            disabled={busy !== ''}
                            aria-label={`Select all ${category.label}`}
                          />
                        </td>
                        <th scope="row">
                          <button
                            type="button"
                            className={styles.categoryToggle}
                            onClick={() => toggleExpanded(category.key)}
                            aria-expanded={open}
                          >
                            <span aria-hidden="true" className={styles.chevron}>
                              {open ? '▾' : '▸'}
                            </span>
                            <span className={styles.swatch} style={{ background: categoryTone(category.key) }} aria-hidden="true" />
                            {category.label}
                          </button>
                        </th>
                        <td className={`${styles.num} ${styles.strong}`}>{fmt(category.count)}</td>
                        <td className={styles.num}>{fmt(category.senders.length)}</td>
                        <td className={styles.shareCol}>
                          <span className={styles.bar} aria-hidden="true">
                            <span style={{ width: `${share}%`, background: categoryTone(category.key) }} />
                          </span>
                          <span className={styles.shareText}>{share}%</span>
                        </td>
                        <td className={styles.num}>{fmt(pickedEmails)}</td>
                      </tr>
                      {open ? (
                        <tr className={styles.detailRow}>
                          <td colSpan={6}>
                            {category.description ? <p className={styles.muted}>{category.description}</p> : null}
                            <table className={styles.senderTable}>
                              <caption className={styles.srOnly}>{category.label} by sender</caption>
                              <thead>
                                <tr>
                                  <th scope="col" className={styles.checkCol}>
                                    <span className={styles.srOnly}>Clear</span>
                                  </th>
                                  <th scope="col">Sender</th>
                                  <th scope="col" className={styles.num}>
                                    Emails
                                  </th>
                                  <th scope="col">Subjects</th>
                                </tr>
                              </thead>
                              <tbody>
                                {category.senders.map((sender) => senderRow(sender))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  )
                })}
                <tfoot>
                  <tr>
                    <td />
                    <th scope="row">Total</th>
                    <td className={`${styles.num} ${styles.strong}`}>{fmt(totals.emails)}</td>
                    <td className={styles.num}>{fmt(totals.senders)}</td>
                    <td className={styles.shareCol} />
                    <td className={`${styles.num} ${styles.strong}`}>{fmt(totals.pickedEmails)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : null}
          {totals.emails > 0 ? (
            <div className={styles.footer}>
              <span className={styles.muted}>
                Selected: {plural(totals.pickedEmails, 'email')} from {plural(totals.pickedSenders, 'sender')}
                {matches ? ' (across all categories, not just the search)' : ''}
              </span>
              {/* Actions sit on the left, clear of anything floating in the bottom right. */}
              <button type="button" className={styles.btn} onClick={() => void apply('read')} disabled={busy !== '' || totals.pickedEmails === 0}>
                {busy === 'read' ? 'Marking read…' : 'Mark selected read'}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.primary}`}
                onClick={() => void apply('archive')}
                disabled={busy !== '' || totals.pickedEmails === 0}
              >
                {busy === 'archive' ? 'Archiving…' : 'Archive selected'}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.danger}`}
                onClick={() => void apply('trash')}
                disabled={busy !== '' || totals.pickedEmails === 0}
              >
                {busy === 'trash' ? 'Deleting…' : 'Delete selected'}
              </button>
              <button
                type="button"
                className={styles.btn}
                onClick={() => void unsubscribeAndArchive()}
                disabled={busy !== '' || totals.unsubscribable.length === 0}
                title="Only senders offering one-click unsubscribe; their emails are then archived"
              >
                {busy === 'unsubscribe'
                  ? 'Unsubscribing…'
                  : `Unsubscribe and archive (${plural(totals.unsubscribable.length, 'sender')})`}
              </button>
              {!matches ? (
                <TagPicker
                  tags={tags ?? []}
                  emails={totals.pickedEmails}
                  scope="selected"
                  disabled={busy !== ''}
                  busy={busy === 'tag'}
                  onApply={(choice) => void tagEmails({ ids: totals.pickedIds, addresses: [...selected] }, choice)}
                />
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {note ? (
        <p className={styles.note} role="status">
          {note}
        </p>
      ) : null}
      </div>
    </div>
  )
}
