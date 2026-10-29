'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './ComposeWindow.module.css'
import EmailBody from './EmailBody'
import RichEmailEditor, { type EditorSnapshot, type EmailSelectionFormat, type RichEmailEditorHandle } from './RichEmailEditor'
import type { BlockEdit } from '../../lib/mail/revise-edits'
import FormatBar from './FormatBar'
import { buildEmailDocument } from '../../lib/mail/email-html'
import { MAX_SIGN_OFF_CHARS, splitSignatureSignOff } from '../../lib/mail/signature'
import { markdownLiteToBlocksHtml } from '../../lib/email-draft-markdown'
import { MAIL_LENGTH_INSTRUCTIONS, type MailLengthMode } from '../../lib/mail/prompts'
import { base64Bytes, extractInlineImages, type InlineImagePayload } from '../../lib/mail/compose-html'
import { MAIL_ATTACHMENT_LIMITS } from '../../lib/mail/compose-limits'
import SchedulePicker from './SchedulePicker'
import { fitImageForChat } from '../chat-image-fit'
import { bakeImageInBrowser, bakeShadowedImages, type BakeImage, type BakedImage } from './email-image-bake'
import { browserStorage, clearPrompt, loadPrompt, promptKeys, savePrompt } from '../../lib/mail/ai-prompt-store'
import { MAIL_ASSISTANT_OPENED_EVENT } from '../../lib/mail/host-events'
import { FOLLOW_UP_DAY_OPTIONS } from '../../lib/mail/schedule-times'
import { mailAccountHeaders } from '../../lib/mail/accounts-shared'
import { finishedRecipientAddresses } from '../../lib/mail/contacts-shared'
import { useMailContacts } from './use-mail-contacts'
import { recipientGreetingName } from '../../lib/mail/greeting'
import { RecipientInput } from './RecipientInput'
import { appendReplyQuote, replyQuoteHeader, replyQuoteStartHtml, type ReplyQuote } from '../../lib/mail/reply-quote'
import {
  MAIL_VOICE_GREETING,
  MAIL_VOICE_READ_TOOL,
  MAIL_VOICE_TOOLS,
  MAIL_VOICE_WRITE_TOOL,
  buildMailVoiceInstructions,
  describeDraftForVoice,
} from '../../lib/mail/voice-draft'
import MailVoice, { type LocalVoiceSession } from './MailVoice'
import { useIsMobileViewport, useSwipeBack } from '../../lib/swipe'

/**
 * Gmail-style compose window docked bottom right.
 *
 * The AI works like a chat assistant: each prompt produces a draft, and every further
 * prompt revises the current draft (including the user's own edits) until it
 * is right. A revision changes only the parts the request needs (the server
 * returns block edits, see lib/mail/revise-edits); everything else stays as
 * written, formatting included. Undo puts the body back as it was before the
 * last AI change, one change at a time. The model only ever sees the one email being replied to (server
 * enforced) plus this conversation. Nothing is sent until Send is clicked.
 * The user's Gmail signature is previewed at the end of the scrolling draft;
 * the server appends it on Send and Save as draft, so it is never part of the
 * editable text. Its sign-off ("Thanks, Pat") is the exception: it is shown
 * in the body font and can be edited for each email (see lib/mail/signature).
 *
 * The body is a rich editor (see RichEmailEditor), always Verdana at Gmail's
 * Normal size: Cmd/Ctrl+B/I/U, text colour, bulleted and numbered lists (the
 * formatting bar under the body), pasted or inserted tables, inline images,
 * and attached files (3 MB in total). Files dropped anywhere on the window
 * are attached (listed under the signature); pasted images go inline.
 *
 * Opened from the Scheduled tab (scheduledId set), the schedule picker opens
 * on the email's send time and Schedule send updates it in place.
 *
 * Send waits UNDO_SEND_MS before sending, like Gmail's undo send: the button
 * shows it is sending and an Undo button stops it. Closing the window during
 * the wait sends straight away (Send was pressed; only Undo cancels).
 *
 * Replies opened from an email can show that email under the reply ("•••",
 * see lib/mail/reply-quote) in its own editor, so notes can be typed into it.
 *
 * The mic next to Write with AI starts a GPT Realtime 2.1 voice call (see
 * lib/mail/voice-draft): the user talks the email through, the agent writes
 * it into the editor with the same Write with AI request, keeps revising it,
 * and can read it back. It can only draft; Send is always the user's click.
 *
 * On phones (full screen, see COMPOSE_PHONE_MAX_WIDTH) the body gets the room:
 * the mic, Write with AI, Schedule send (an icon) and Send share one bottom
 * row, Save as draft and Delete draft sit in its ⋯ menu, and "Remind me if no
 * reply" is left out. A swipe right saves the draft and goes back to the inbox.
 */

/** Widest viewport where compose fills the screen (matches the CSS breakpoint). */
const COMPOSE_PHONE_MAX_WIDTH = 640

/** How long Send waits, with Undo available, before the email actually goes. */
export const UNDO_SEND_MS = 3100

export interface ComposeReplyTarget {
  messageId: string
  from: string
  subject: string
  /** CMS client the message is stored against or matches, if any (offers "Use client data"). */
  client?: { id: number; name: string } | null
  /** The email itself, so it can be shown (and annotated) under the reply. */
  quote?: ReplyQuote
  /**
   * Recipients for a plain reply and a reply all, when the email had other
   * participants. Offers the reply all toggle next to Cc.
   */
  recipients?: { reply: { to: string; cc: string }; replyAll: { to: string; cc: string } }
}

export interface ComposeFile {
  name: string
  mediaType: string
  /** Raw base64, no data: prefix. */
  data: string
}

export interface ComposeState {
  mode: 'reply' | 'new'
  replyTo: ComposeReplyTarget | null
  /** A forward of an email in the reader (a new email with it as the starting body). */
  forward?: boolean
  to: string
  cc: string
  /** Blind copy; shown with Cc. */
  bcc?: string
  /**
   * The signature's sign-off ("Thanks,\nPat") as edited for this email.
   * Undefined until edited: the Gmail signature's own sign-off is used.
   */
  signOff?: string
  /** Signature toggle off: send/save this email without the Gmail signature. Undefined = signature on. */
  noSignature?: boolean
  subject: string
  /** Starting body HTML (the editor owns it after that). */
  html: string
  attachments: ComposeFile[]
  /** Gmail draft this compose window is editing (opened from a Gmail draft link or saved once). */
  draftId?: string
  /**
   * Scheduled email this window is editing (Scheduled tab → Edit). It stays
   * queued as it was until Update schedule or Send; nothing is autosaved to
   * Gmail Drafts, and closing keeps the scheduled version.
   */
  scheduledId?: number
  /** Its current send time (ISO), preselected in the schedule picker. */
  scheduledFor?: string
  /**
   * "Remind me if no reply" in business days (0 = off). Undefined until
   * chosen, which means off. Always resolved before onSend/onSchedule.
   */
  followUpDays?: number
  /** Pre-filled Write with AI instruction (e.g. Awaiting reply → Draft follow-up). */
  aiPrompt?: string
  /**
   * The extra Gmail account this email is written in ("" or undefined = the
   * main Gmail). Fixed when the window opens, so switching accounts in Mail
   * never moves a half-written email to another mailbox.
   */
  account?: string
}

/** What Send / Save as draft post to the server. */
export interface ComposeContent {
  html: string
  inlineImages: InlineImagePayload[]
  attachments: ComposeFile[]
}

interface Turn {
  instruction: string
  draft: string
}

/** The body before one AI change, for Undo. */
interface AiUndoEntry {
  snapshot: EditorSnapshot
  /** AI rounds before the change, so the next revision's history matches the restored body. */
  turnCount: number
  /** Subject the AI filled in with this change, cleared again on undo if still unedited. */
  subject?: string
}

type RecipientField = 'to' | 'cc' | 'bcc'

/** AI changes that can be undone, newest last. */
const MAX_AI_UNDO = 20

interface Props {
  initial: ComposeState
  title: string
  onClose: () => void
  onSend: (state: ComposeState, content: ComposeContent) => Promise<void>
  /** Queue the email to send at `when` instead of now. */
  onSchedule: (state: ComposeState, content: ComposeContent, when: Date) => Promise<void>
  /** Resolves to the Gmail draft id, so later saves update the same draft. */
  onSaveDraft: (state: ComposeState, content: ComposeContent) => Promise<string | undefined>
  /** Permanently delete the Gmail draft this window saved or opened. */
  onDeleteDraft: (draftId: string) => Promise<void>
  /** Gmail signature HTML; '' when none is set, null while unknown. */
  signatureHtml: string | null
  /**
   * "Open in new window": called with a function that saves the email and
   * returns its current state (stopping this window's autosave), for the new
   * window to carry on with. Not passed where popping out makes no sense.
   */
  onPopOut?: (snapshot: () => Promise<ComposeState>) => boolean | void
  /** This compose window is the whole browser window (the pop-out). */
  popout?: boolean
  /**
   * Phone swipe back: called instead of onClose once the draft is saved, to
   * go back to the inbox rather than the email being replied to.
   */
  onBack?: () => void
}

interface MoreMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
}

/** The phone compose row's ⋯ menu; opens upwards, closes on outside tap and Escape. */
function ComposeMoreMenu({ items }: { items: MoreMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('touchstart', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('touchstart', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={wrapRef} className={styles.more}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.roundIcon}
        aria-label="More options"
        title="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label="More options" className={styles.moreMenu}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={styles.moreItem}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

async function postJson<T>(url: string, body: unknown, account?: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...mailAccountHeaders(account) },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string }
  if (!res.ok) throw new Error(data.reason || data.error || `Request failed (${res.status})`)
  return data
}

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

function naturalWidth(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img.naturalWidth || null)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** Pasted images display at most this wide in the email. */
const DISPLAY_WIDTH = 600
const LIMIT_NOTE = `Images and attachments can total up to ${formatSize(MAIL_ATTACHMENT_LIMITS.maxTotalBytes)} per email.`

export default function ComposeWindow({
  initial,
  title,
  onClose,
  onSend,
  onSchedule,
  onSaveDraft,
  onDeleteDraft,
  signatureHtml,
  onPopOut,
  popout = false,
  onBack,
}: Props) {
  const [state, setState] = useState<ComposeState>(initial)
  const signatureParts = useMemo(() => (signatureHtml ? splitSignatureSignOff(signatureHtml) : null), [signatureHtml])
  const signatureRef = useRef(signatureParts)
  signatureRef.current = signatureParts
  // The reminder choice as shown (the client default applied), read when sending.
  const followUpDaysRef = useRef(0)
  /** What is sent: always the shown sign-off, so the email matches the preview (Verdana, Normal). */
  const outgoing = useCallback((s: ComposeState): ComposeState => {
    const withFollowUp = { ...s, followUpDays: followUpDaysRef.current }
    const parts = signatureRef.current
    if (!parts) return withFollowUp
    return { ...withFollowUp, signOff: s.signOff ?? parts.signOff }
  }, [])
  const [turns, setTurns] = useState<Turn[]>([])
  const [aiUndo, setAiUndo] = useState<AiUndoEntry[]>([])
  // Text highlighted in the body (kept while focus is in the AI box), and which length change is running.
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [lengthBusy, setLengthBusy] = useState<MailLengthMode | null>(null)
  // Images the user pasted or inserted into the body (what "- image" / "+ image" resize).
  const [pastedImages, setPastedImages] = useState(0)
  // The unsent AI instruction is kept in this browser as you type (see ai-prompt-store).
  const [prompt, setPrompt] = useState(() =>
    initial.aiPrompt ??
    loadPrompt(
      browserStorage(),
      promptKeys({
        mode: initial.mode,
        replyToMessageId: initial.replyTo?.messageId,
        draftId: initial.draftId,
        startedNew: !initial.draftId,
      }),
      Date.now(),
    ),
  )
  const [busy, setBusy] = useState<'' | 'ai' | 'subject' | 'send' | 'draft' | 'schedule' | 'delete'>('')
  const [note, setNote] = useState('')
  const [minimised, setMinimised] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const isPhone = useIsMobileViewport(COMPOSE_PHONE_MAX_WIDTH)
  const windowRef = useRef<HTMLDivElement>(null)
  const [showCc, setShowCc] = useState(Boolean(initial.cc || initial.bcc))
  const replyChoices = initial.mode === 'reply' ? (initial.replyTo?.recipients ?? null) : null
  const [replyAll, setReplyAll] = useState(
    () => replyChoices !== null && initial.to === replyChoices.replyAll.to && initial.cc === replyChoices.replyAll.cc,
  )
  const toggleReplyAll = () => {
    if (!replyChoices) return
    const next = !replyAll
    const target = next ? replyChoices.replyAll : replyChoices.reply
    setReplyAll(next)
    setState((s) => ({ ...s, to: target.to, cc: target.cc }))
    setSettledRecipients((s) => ({ ...s, to: target.to, cc: target.cc }))
    if (next && target.cc) setShowCc(true)
  }
  // To/Cc/Bcc suggestions (see use-mail-contacts).
  const { contacts, loadContacts } = useMailContacts(initial.account)
  // Waiting out the undo window after Send; the timer is in sendTimerRef.
  const [sendPending, setSendPending] = useState(false)
  const sendTimerRef = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [hasDraft, setHasDraft] = useState(Boolean(initial.html.trim()))
  const [tableOpen, setTableOpen] = useState(false)
  const [selectionFormat, setSelectionFormat] = useState<EmailSelectionFormat>({ list: null, color: null })
  const editingScheduled = initial.scheduledId !== undefined
  const [scheduleOpen, setScheduleOpen] = useState(editingScheduled)
  const [tableSize, setTableSize] = useState({ rows: 3, columns: 3 })
  // Opt-in: also give the AI the rest of this email's thread. Off by default.
  const [useThread, setUseThread] = useState(false)
  // Opt-in: also give the AI client facts from the CMS. Off by default; the
  // server resolves the client itself (never from this id).
  const [useClientData, setUseClientData] = useState(false)
  // New email: the client the recipients match (checked server-side, debounced).
  const [recipientClient, setRecipientClient] = useState<{ id: number; name: string } | null>(null)
  // Shown under the AI box after a draft that used client data.
  const [clientDataUsed, setClientDataUsed] = useState('')
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const editorRef = useRef<RichEmailEditorHandle>(null)
  // The quoted email under a reply ("•••"): shown or not, and its own editor.
  const quote = initial.replyTo?.quote ?? null
  const quoteHeader = useMemo(() => (quote ? replyQuoteHeader(quote) : ''), [quote])
  const quoteStartHtml = useMemo(() => (quote ? replyQuoteStartHtml(quote) : ''), [quote])
  const [quoteOpen, setQuoteOpen] = useState(false)
  // Mounted on first open, then only hidden, so notes typed into it survive closing it.
  const [quoteMounted, setQuoteMounted] = useState(false)
  const quoteOpenRef = useRef(false)
  quoteOpenRef.current = quoteOpen
  const quoteEditorRef = useRef<RichEmailEditorHandle>(null)
  const quoteBaseline = useRef<string | null>(null)
  // The formatting bar acts on whichever editor (reply or quote) was used last.
  const activeEditor = useRef<'body' | 'quote'>('body')
  const formatTarget = () => (activeEditor.current === 'quote' && quoteOpenRef.current ? quoteEditorRef.current : editorRef.current)
  /** What is sent and saved: the reply, plus the quoted email when it is shown. */
  const composedHtml = useCallback((): string => {
    const body = editorRef.current?.getHtml() ?? ''
    if (!quoteOpenRef.current || !quoteHeader) return body
    return appendReplyQuote(body, { header: quoteHeader, html: quoteEditorRef.current?.getHtml() ?? '' })
  }, [quoteHeader])
  const attachInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  // Autosave: the latest state, the Gmail draft id, and the in-flight save.
  const stateRef = useRef(state)
  stateRef.current = state

  /**
   * To / Cc / Bcc as of the last finished address. Typing a recipient changes
   * the fields on every letter, but only finishing an address (a comma, or
   * picking a suggestion), removing one, or leaving the field updates this, so
   * a half-typed address never sets off a draft save or a client lookup.
   */
  const [settledRecipients, setSettledRecipients] = useState(() => ({ to: initial.to, cc: initial.cc, bcc: initial.bcc ?? '' }))
  const setRecipient = (field: RecipientField, value: string) => {
    const previous = (field === 'bcc' ? stateRef.current.bcc : stateRef.current[field]) ?? ''
    setState((s) => ({ ...s, [field]: value }))
    if (finishedRecipientAddresses(previous).join(',') !== finishedRecipientAddresses(value).join(',')) {
      setSettledRecipients((s) => ({ ...s, [field]: value }))
    }
  }
  const settleRecipient = (field: RecipientField) => {
    const value = (field === 'bcc' ? stateRef.current.bcc : stateRef.current[field]) ?? ''
    setSettledRecipients((s) => (s[field] === value ? s : { ...s, [field]: value }))
  }
  const draftIdRef = useRef(initial.draftId)
  const savingRef = useRef<Promise<void> | null>(null)
  const dirtyRef = useRef(false)
  const closedRef = useRef(false)
  const promptTextRef = useRef(prompt)
  promptTextRef.current = prompt

  const currentPromptKeys = useCallback(
    () =>
      promptKeys({
        mode: initial.mode,
        replyToMessageId: initial.replyTo?.messageId,
        draftId: draftIdRef.current,
        startedNew: !initial.draftId,
      }),
    [initial.mode, initial.replyTo?.messageId, initial.draftId],
  )
  const persistPrompt = useCallback(() => {
    savePrompt(browserStorage(), currentPromptKeys(), promptTextRef.current, Date.now())
  }, [currentPromptKeys])
  const [edits, setEdits] = useState(0)
  const baselineHtml = useRef<string | null>(null)
  const fieldsMounted = useRef(false)
  const [autoStatus, setAutoStatus] = useState('')

  useEffect(() => {
    promptRef.current?.focus()
  }, [])

  // Opening the host assistant (MAIL_ASSISTANT_OPENED_EVENT) minimises this window so it doesn't cover the panel (not in its own window).
  useEffect(() => {
    if (popout) return
    const minimise = () => setMinimised(true)
    window.addEventListener(MAIL_ASSISTANT_OPENED_EVENT, minimise)
    return () => window.removeEventListener(MAIL_ASSISTANT_OPENED_EVENT, minimise)
  }, [popout])

  // Leaving the page (or closing another way) mid-wait cancels the timer; nothing is sent.
  useEffect(
    () => () => {
      if (sendTimerRef.current !== null) window.clearTimeout(sendTimerRef.current)
    },
    [],
  )

  const attachmentBytes = state.attachments.reduce((sum, file) => sum + base64Bytes(file.data), 0)

  /** Bytes of the images currently in the body plus attachments. */
  const usedBytes = useCallback((): number => {
    const { inlineImages } = extractInlineImages(composedHtml())
    return inlineImages.reduce((sum, image) => sum + base64Bytes(image.data), 0) + attachmentBytes
  }, [attachmentBytes, composedHtml])

  const addAttachments = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      setNote('')
      let budget = MAIL_ATTACHMENT_LIMITS.maxTotalBytes - usedBytes()
      const added: ComposeFile[] = []
      for (const file of files) {
        if (state.attachments.length + added.length >= MAIL_ATTACHMENT_LIMITS.maxAttachments) {
          setNote(`Attach up to ${MAIL_ATTACHMENT_LIMITS.maxAttachments} files.`)
          break
        }
        if (file.size > budget) {
          setNote(`${file.name} is too big. ${LIMIT_NOTE}`)
          continue
        }
        try {
          added.push({ name: file.name || 'attachment', mediaType: file.type || 'application/octet-stream', data: await readBase64(file) })
          budget -= file.size
        } catch {
          setNote(`Could not read ${file.name}.`)
        }
      }
      if (added.length > 0) setState((current) => ({ ...current, attachments: [...current.attachments, ...added] }))
    },
    [state.attachments.length, usedBytes],
  )

  const addInlineImages = useCallback(
    async (files: File[]) => {
      setNote('')
      for (const file of files) {
        const budget = MAIL_ATTACHMENT_LIMITS.maxTotalBytes - usedBytes()
        const fitted = await fitImageForChat(file, file.name || 'image', {
          maxBytes: Math.max(0, Math.min(budget, MAIL_ATTACHMENT_LIMITS.maxTotalBytes)),
          maxEdge: MAIL_ATTACHMENT_LIMITS.maxImageEdge,
          // Screenshots stay PNG: JPEG blurs text, and the shadow is drawn in on send.
          preferPng: true,
        })
        if (!fitted.ok) {
          setNote(budget <= 0 ? LIMIT_NOTE : fitted.error)
          continue
        }
        const src = `data:${fitted.value.mediaType};base64,${fitted.value.data}`
        const width = await naturalWidth(src)
        editorRef.current?.insertImage(src, fitted.value.name, width ? Math.min(width, DISPLAY_WIDTH) : null)
      }
    },
    [usedBytes],
  )

  /** Pasted/dropped files: images go into the body, everything else is attached. */
  const onPasteFiles = useCallback(
    (files: File[]) => {
      const images = files.filter((file) => IMAGE_TYPES.has(file.type))
      const others = files.filter((file) => !IMAGE_TYPES.has(file.type))
      void addInlineImages(images).then(() => addAttachments(others))
    },
    [addAttachments, addInlineImages],
  )

  /** Save whatever is typed to Gmail Drafts; never throws, never overlaps itself. */
  const autosave = useCallback(async (): Promise<void> => {
    // A scheduled email is saved with Update schedule, never to Gmail Drafts.
    if (closedRef.current || stateRef.current.scheduledId !== undefined) return
    if (savingRef.current) {
      dirtyRef.current = true
      return
    }
    const current = stateRef.current
    const { html, inlineImages } = extractInlineImages(composedHtml())
    const hasText = html.replace(/<[^>]*>/g, '').trim() !== '' || inlineImages.length > 0
    if (!hasText && !current.to.trim() && !current.subject.trim() && current.attachments.length === 0) return
    const total = inlineImages.reduce((sum, image) => sum + base64Bytes(image.data), 0) + attachmentBytesRef.current
    if (total > MAIL_ATTACHMENT_LIMITS.maxTotalBytes) return
    dirtyRef.current = false
    setAutoStatus('Saving…')
    const job = (async () => {
      try {
        const draftId = await onSaveDraftRef.current(
          outgoing({ ...current, ...(draftIdRef.current ? { draftId: draftIdRef.current } : {}) }),
          { html, inlineImages, attachments: current.attachments },
        )
        if (draftId && draftId !== draftIdRef.current) {
          draftIdRef.current = draftId
          persistPrompt()
        }
        setAutoStatus('Saved')
      } catch {
        setAutoStatus('Not saved')
      }
    })()
    savingRef.current = job
    await job
    savingRef.current = null
    if (dirtyRef.current) void autosave()
  }, [persistPrompt, outgoing, composedHtml])

  const attachmentBytesRef = useRef(attachmentBytes)
  attachmentBytesRef.current = attachmentBytes
  const onSaveDraftRef = useRef(onSaveDraft)
  onSaveDraftRef.current = onSaveDraft

  // Save the AI instruction on every keystroke (localStorage is synchronous and cheap).
  useEffect(() => {
    persistPrompt()
  }, [prompt, persistPrompt])

  // Save shortly after typing stops, and when the tab is hidden or closed.
  useEffect(() => {
    if (edits === 0) return
    const timer = window.setTimeout(() => void autosave(), 1500)
    return () => window.clearTimeout(timer)
  }, [edits, autosave])

  // Recipients, subject and attachments count as edits too (not the initial values).
  // Recipients count once an address is finished, not on every letter (see setRecipient).
  useEffect(() => {
    if (!fieldsMounted.current) {
      fieldsMounted.current = true
      return
    }
    setEdits((n) => n + 1)
  }, [settledRecipients.to, settledRecipients.cc, settledRecipients.bcc, state.subject, state.signOff, state.noSignature, state.attachments])

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') void autosave()
    }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [autosave])

  const linkedClient = state.mode === 'reply' ? (initial.replyTo?.client ?? null) : recipientClient
  // Off unless chosen for this email.
  const followUpDays = state.followUpDays ?? 0
  followUpDaysRef.current = followUpDays
  // Something to send: a reply body, or notes in the quoted email.
  const hasContent = hasDraft || quoteOpen

  useEffect(() => {
    if (state.mode !== 'new') return
    const to = settledRecipients.to.trim()
    const cc = settledRecipients.cc.trim()
    if (!to && !cc) {
      setRecipientClient(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      postJson<{ client: { id: number; name: string } | null }>('/api/mail/client-match', { to, cc }, initial.account)
        .then((data) => {
          if (!cancelled) setRecipientClient(data.client ?? null)
        })
        .catch(() => {
          if (!cancelled) setRecipientClient(null)
        })
    }, 500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [state.mode, settledRecipients.to, settledRecipients.cc, initial.account])

  function setBodyFromText(text: string) {
    // Blank lines stay as empty lines: each editor paragraph is one line, as in Gmail.
    editorRef.current?.setHtml(text ? markdownLiteToBlocksHtml(text, { blankLines: true }) : '')
  }

  // One AI request at a time, whether typed or spoken.
  const aiInFlight = useRef(false)

  /**
   * Write or revise the body with the AI (the Write with AI button and the
   * voice agent both come here). Only ever drafts: it never sends or saves
   * anything itself; the new body autosaves to Drafts like typing does.
   */
  async function runAi(instruction: string): Promise<{ ok: true; text: string; subject?: string } | { ok: false; error: string }> {
    if (aiInFlight.current || (busy !== '' && busy !== 'ai')) return { ok: false, error: 'Still busy with the last request. Try again in a moment.' }
    aiInFlight.current = true
    setBusy('ai')
    setNote('')
    try {
      // The draft as blocks: a revision's edits name the blocks to change.
      const blocks = hasDraft ? (editorRef.current?.getBlocks() ?? []) : []
      // First AI request on a new email with no subject yet: the AI suggests one too.
      const suggestSubject = state.mode === 'new' && turns.length === 0 && blocks.length === 0 && !state.subject.trim()
      const withClientData = useClientData && linkedClient !== null
      // "Hi <name>," for the one person this email goes to, when we know their name.
      const recipientName = recipientGreetingName(state.to, contacts)
      const data = await postJson<{
        text: string
        edits?: BlockEdit[]
        subject?: string
        clientContext?: { id: number; name: string } | null
      }>(
        '/api/mail/ai',
        {
          action: state.mode === 'reply' ? 'reply' : 'draft',
          ...(state.mode === 'reply' ? { gmailMessageId: state.replyTo?.messageId, includeThread: useThread } : {}),
          ...(withClientData
            ? { includeClientData: true, ...(state.mode === 'new' ? { to: state.to, cc: state.cc } : {}) }
            : {}),
          ...(suggestSubject ? { suggestSubject: true } : {}),
          ...(recipientName ? { recipientName } : {}),
          instruction,
          history: turns,
          currentBlocks: blocks.map((block) => block.markdown),
        },
        initial.account,
      )
      setClientDataUsed(data.clientContext ? data.clientContext.name || 'this client' : '')
      if (data.edits && data.edits.length === 0) {
        setNote('The AI found nothing to change. Try saying what to change in another way.')
        return { ok: true, text: data.text }
      }
      const editor = editorRef.current
      const snapshot = editor?.snapshot() ?? null
      // Only the blocks the revision changes are touched; if the body changed too much
      // while the AI was working, the whole revised text goes in instead.
      const applied = data.edits && blocks.length > 0 ? (editor?.applyBlockEdits(blocks.map((block) => block.key), data.edits) ?? false) : false
      if (!applied) setBodyFromText(data.text)
      const subject = data.subject?.trim()
      // Never overwrite a subject typed while the AI was writing.
      const fillSubject = Boolean(subject) && !stateRef.current.subject.trim()
      if (subject && fillSubject) setState((current) => (current.subject.trim() ? current : { ...current, subject }))
      if (snapshot) {
        const entry: AiUndoEntry = { snapshot, turnCount: turns.length, ...(subject && fillSubject ? { subject } : {}) }
        setAiUndo((current) => [...current, entry].slice(-MAX_AI_UNDO))
      }
      setTurns((current) => [...current, { instruction: instruction || 'Draft a reply', draft: data.text }])
      return { ok: true, text: data.text, ...(subject ? { subject } : {}) }
    } catch (err) {
      const message = (err as Error).message
      setNote(message)
      return { ok: false, error: message }
    } finally {
      aiInFlight.current = false
      setBusy('')
    }
  }
  const runAiRef = useRef(runAi)

  /** Fill the subject line with a short AI subject written from the body so far. */
  async function suggestSubjectLine() {
    const body = editorRef.current?.getMarkdown().trim() ?? ''
    if (busy !== '' || !body) return
    const before = stateRef.current.subject
    setBusy('subject')
    setNote('')
    try {
      const data = await postJson<{ subject: string }>('/api/mail/subject', { body }, initial.account)
      const subject = data.subject.trim()
      // Leave a subject typed while the AI was working alone.
      if (subject) setState((current) => (current.subject === before ? { ...current, subject } : current))
    } catch (err) {
      setNote((err as Error).message)
    } finally {
      setBusy('')
    }
  }
  runAiRef.current = runAi

  /** Put the body back as it was before the last AI change (edits made since then go too). */
  function undoAi() {
    const entry = aiUndo[aiUndo.length - 1]
    if (!entry || busy !== '') return
    editorRef.current?.restore(entry.snapshot)
    setAiUndo((current) => current.slice(0, -1))
    setTurns((current) => current.slice(0, entry.turnCount))
    if (entry.subject) setState((current) => (current.subject === entry.subject ? { ...current, subject: '' } : current))
    setNote('')
  }

  /**
   * Revise with an empty instruction: tidy the layout without the AI (table
   * columns sized to their text, empty lines between sections). Undo puts it back.
   */
  function tidyLayout() {
    const editor = editorRef.current
    if (!editor || busy !== '') return
    const snapshot = editor.snapshot()
    if (!editor.tidyLayout()) {
      setNote('The layout is already tidy. To change the wording, say what to change.')
      return
    }
    if (snapshot) setAiUndo((current) => [...current, { snapshot, turnCount: turns.length }].slice(-MAX_AI_UNDO))
    setNote('')
  }

  /**
   * Rewrite only the highlighted text: Shorten, Lengthen, or the AI box's
   * request. The rest of the email is untouched; Undo puts the text back.
   */
  async function rewriteHighlight(mode: MailLengthMode | 'instruction', instruction = ''): Promise<boolean> {
    const editor = editorRef.current
    const selection = editor?.getHighlightedText() ?? null
    if (!editor || !selection || aiInFlight.current || busy !== '') return false
    aiInFlight.current = true
    setBusy('ai')
    setNote('')
    try {
      // "Use client data" applies here too, so "add the monthly budget" can fill it in.
      const withClientData = useClientData && linkedClient !== null
      const data = await postJson<{ text: string; clientContext?: { id: number; name: string } | null }>(
        '/api/mail/ai/selection',
        {
          mode,
          ...(mode === 'instruction' ? { instruction } : {}),
          selection,
          draft: editor.getMarkdown(),
          ...(withClientData
            ? {
                includeClientData: true,
                ...(state.mode === 'reply' ? { gmailMessageId: state.replyTo?.messageId } : { to: state.to, cc: state.cc }),
              }
            : {}),
        },
        initial.account,
      )
      setClientDataUsed(data.clientContext ? data.clientContext.name || 'this client' : '')
      const snapshot = editor.snapshot()
      if (!editor.replaceHighlighted(selection, data.text)) {
        setNote('The highlighted text changed while the AI was working. Highlight it again and try again.')
        return false
      }
      if (snapshot) setAiUndo((current) => [...current, { snapshot, turnCount: turns.length }].slice(-MAX_AI_UNDO))
      return true
    } catch (err) {
      setNote((err as Error).message)
      return false
    } finally {
      aiInFlight.current = false
      setBusy('')
    }
  }

  /** Shorten / Lengthen: the highlighted text when there is some, otherwise the whole email. */
  async function changeLength(mode: MailLengthMode) {
    if (busy !== '' || !hasDraft) return
    setLengthBusy(mode)
    try {
      if (highlighted) await rewriteHighlight(mode)
      else await runAi(MAIL_LENGTH_INSTRUCTIONS.email[mode])
    } finally {
      setLengthBusy(null)
    }
  }

  /** "- image" / "+ image": every pasted image in this email, 10% at a time. */
  function scaleImages(direction: 1 | -1) {
    if (busy !== '') return
    const changed = editorRef.current?.scalePastedImages(direction) ?? 0
    setNote(changed > 0 ? '' : direction < 0 ? 'The images are already as small as they go.' : 'The images already fill the width of the email.')
  }

  async function askAi() {
    const instruction = prompt.trim()
    if (busy) return
    if (highlighted && hasDraft) {
      if (!instruction) {
        setNote('Say what to change in the highlighted text.')
        return
      }
      if (await rewriteHighlight('instruction', instruction)) {
        setPrompt('')
        promptRef.current?.focus()
      }
      return
    }
    if (!instruction && hasDraft) {
      tidyLayout()
      return
    }
    if (!instruction && state.mode === 'new') {
      setNote('Say what the email should be about.')
      return
    }
    const result = await runAi(instruction)
    if (result.ok) {
      setPrompt('')
      promptRef.current?.focus()
    }
  }

  // The voice agent's only two abilities: write/revise the draft, and read it back.
  const voiceSession = useMemo<LocalVoiceSession>(
    () => ({
      instructions: buildMailVoiceInstructions({
        mode: initial.mode,
        replyTo: initial.replyTo?.from,
        subject: initial.subject,
      }),
      tools: MAIL_VOICE_TOOLS,
      greeting: MAIL_VOICE_GREETING,
      executeTool: async (name, args) => {
        if (name === MAIL_VOICE_WRITE_TOOL) {
          const instruction = typeof args.instruction === 'string' ? args.instruction.trim().slice(0, 4000) : ''
          if (!instruction) return { ok: false, error: 'Say what the email should say.' }
          const result = await runAiRef.current(instruction)
          return result.ok
            ? { ok: true, data: { drafted: true, subject: result.subject ?? stateRef.current.subject, draft: result.text } }
            : { ok: false, error: result.error }
        }
        if (name === MAIL_VOICE_READ_TOOL) {
          const current = stateRef.current
          return {
            ok: true,
            data: describeDraftForVoice({ to: current.to, subject: current.subject, body: editorRef.current?.getMarkdown() ?? '' }),
          }
        }
        return { ok: false, error: 'That is not something I can do here.' }
      },
    }),
    // The window's opening context; the tools read the live state through refs.
    [initial.mode, initial.replyTo?.from, initial.subject],
  )

  // Baked copies of shadowed images, so a second Send/Schedule does not redraw them.
  const bakedImagesRef = useRef(new Map<string, BakedImage | null>())
  const cachedBake: BakeImage = async (src, width) => {
    const key = `${width}|${src}`
    const cache = bakedImagesRef.current
    if (!cache.has(key)) cache.set(key, await bakeImageInBrowser(src, width).catch(() => null))
    return cache.get(key) ?? null
  }

  /** What is sent: pasted images get their shadow drawn in, so Gmail and Outlook show it too. */
  async function buildOutgoingContent(): Promise<ComposeContent | null> {
    return buildContent(await bakeShadowedImages(composedHtml(), cachedBake))
  }

  function buildContent(bodyHtml: string = composedHtml()): ComposeContent | null {
    const { html, inlineImages } = extractInlineImages(bodyHtml)
    const total = inlineImages.reduce((sum, image) => sum + base64Bytes(image.data), 0) + attachmentBytes
    if (total > MAIL_ATTACHMENT_LIMITS.maxTotalBytes) {
      setNote(`This email has ${formatSize(total)} of images and attachments. ${LIMIT_NOTE}`)
      return null
    }
    return { html, inlineImages, attachments: state.attachments }
  }

  /** Send button: check the email, then wait UNDO_SEND_MS (Undo stops it) before sending. */
  function startSend() {
    if (busy || !hasContent) return
    setNote('')
    if (!buildContent()) return
    setBusy('send')
    setSendPending(true)
    // No autosave during the wait: it would re-create the draft that Send removes.
    closedRef.current = true
    sendTimerRef.current = window.setTimeout(() => {
      sendTimerRef.current = null
      void deliverNow()
    }, UNDO_SEND_MS)
  }

  function undoSend() {
    if (sendTimerRef.current === null) return
    window.clearTimeout(sendTimerRef.current)
    sendTimerRef.current = null
    setSendPending(false)
    setBusy('')
    closedRef.current = false
    setNote('Sending undone.')
    editorRef.current?.focus()
  }

  /** Close during the wait: Send was pressed, so send now rather than lose it. */
  function flushSend(): boolean {
    if (sendTimerRef.current === null) return false
    window.clearTimeout(sendTimerRef.current)
    sendTimerRef.current = null
    void deliverNow()
    return true
  }

  async function deliverNow() {
    setSendPending(false)
    // Built again so edits made during the wait are what gets sent.
    const content = await buildOutgoingContent()
    if (!content) {
      closedRef.current = false
      setBusy('')
      return
    }
    try {
      await savingRef.current
      const current = stateRef.current
      await onSend(outgoing({ ...current, ...(draftIdRef.current ? { draftId: draftIdRef.current } : {}) }), content)
      clearPrompt(browserStorage(), currentPromptKeys())
    } catch (err) {
      closedRef.current = false
      setNote((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function saveDraftNow() {
    if (busy || !hasContent) return
    setNote('')
    const content = buildContent()
    if (!content) return
    setBusy('draft')
    try {
      await savingRef.current
      const draftId = await onSaveDraft(outgoing({ ...state, ...(draftIdRef.current ? { draftId: draftIdRef.current } : {}) }), content)
      if (draftId && draftId !== draftIdRef.current) {
        draftIdRef.current = draftId
        persistPrompt()
      }
      setAutoStatus('Saved')
      setNote('Saved to Gmail Drafts.')
    } catch (err) {
      setNote((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  // Files dragged onto the window are attached (images too); pasted images go inline instead.
  const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
  const dragHandlers = {
    onDragEnter: (event: React.DragEvent) => {
      if (!hasFiles(event) || minimised) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    },
    onDragOver: (event: React.DragEvent) => {
      if (!hasFiles(event) || minimised) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!hasFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDrop: (event: React.DragEvent) => {
      dragDepth.current = 0
      setDragging(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0 || minimised) return
      event.preventDefault()
      if (busy !== '') return
      void addAttachments(files)
    },
  }

  async function runSchedule(when: Date | null) {
    if (busy || !hasContent) return
    setNote('')
    if (!when || when.getTime() < Date.now() + 60_000) {
      setNote('Choose a send time at least a minute from now.')
      return
    }
    setBusy('schedule')
    const content = await buildOutgoingContent()
    if (!content) {
      setBusy('')
      return
    }
    try {
      await savingRef.current
      closedRef.current = true
      await onSchedule(outgoing({ ...state, ...(draftIdRef.current ? { draftId: draftIdRef.current } : {}) }), content, when)
      clearPrompt(browserStorage(), currentPromptKeys())
    } catch (err) {
      closedRef.current = false
      setNote((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  /** Trash icon: stop autosaving, delete the Gmail draft (if one was saved) and close. */
  async function discardDraft() {
    if (busy) return
    if (!window.confirm("Delete this draft? This can't be undone.")) return
    setBusy('delete')
    setNote('')
    closedRef.current = true
    try {
      await savingRef.current
      const draftId = draftIdRef.current
      if (draftId) await onDeleteDraft(draftId)
      clearPrompt(browserStorage(), currentPromptKeys())
      onClose()
    } catch (err) {
      closedRef.current = false
      setNote((err as Error).message)
      setBusy('')
    }
  }

  /** Close (✕ or a phone swipe back): typed text is autosaved to Gmail Drafts first, so closing never loses it. */
  function closeWindow(done: () => void) {
    if (flushSend()) return
    if (editingScheduled && edits > 0 && !window.confirm('Close without saving? The scheduled email stays as it was.')) return
    void autosave().then(() => savingRef.current).finally(() => {
      closedRef.current = true
      done()
    })
  }

  // Phone: swipe right to save the draft and go back to the inbox.
  const swipeBackRef = useRef<() => void>(() => undefined)
  swipeBackRef.current = () => closeWindow(onBack ?? onClose)
  const onSwipeBack = useCallback(() => swipeBackRef.current(), [])
  useSwipeBack(windowRef, onSwipeBack, isPhone && !popout && !minimised, { ignoreHorizontalScrollers: true })

  function toggleSchedule() {
    setScheduleOpen((open) => !open)
  }

  function insertTable() {
    const rows = Math.min(Math.max(Math.round(tableSize.rows) || 1, 1), 50)
    const columns = Math.min(Math.max(Math.round(tableSize.columns) || 1, 1), 10)
    editorRef.current?.focus()
    editorRef.current?.insertTable(rows, columns)
    setTableOpen(false)
  }

  /**
   * Open in new window: save what is typed, stop autosaving here (the new
   * window carries on with the same Gmail draft) and hand over the email as
   * it is now, with any shown quote folded into the body.
   */
  const popOutSnapshot = useCallback(async (): Promise<ComposeState> => {
    await autosave()
    while (savingRef.current) await savingRef.current
    closedRef.current = true
    const current = outgoing(stateRef.current)
    const quoteShown = quoteOpenRef.current && quoteHeader !== ''
    return {
      ...current,
      html: composedHtml(),
      ...(draftIdRef.current ? { draftId: draftIdRef.current } : {}),
      ...(promptTextRef.current.trim() ? { aiPrompt: promptTextRef.current } : {}),
      replyTo: current.replyTo && quoteShown ? { ...current.replyTo, quote: undefined } : current.replyTo,
    }
  }, [autosave, outgoing, composedHtml, quoteHeader])

  // Shared by the desktop layout and the phone's single bottom row.
  const voiceButton = (
    // Talk the email through; it drafts and revises without pressing Write with AI. It cannot send.
    <span className={styles.voice} title="Draft by voice (GPT Realtime 2.1). It writes and reads back drafts; only you can send.">
      <MailVoice
        localSession={voiceSession}
        triggerSize={isPhone ? 44 : 34}
        // Phones: one button that starts the call, stays green while on, and ends it.
        variant={isPhone ? 'toggle' : 'full'}
      />
    </span>
  )
  const aiUndoButton =
    aiUndo.length > 0 ? (
      <button
        type="button"
        className={styles.aiUndo}
        onClick={undoAi}
        disabled={busy !== ''}
        title="Put the email back as it was before the last Revise"
        // Phones show an icon so Revise keeps its full label in the bottom row.
        aria-label={isPhone ? 'Undo' : undefined}
      >
        {isPhone ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
        ) : (
          'Undo'
        )}
      </button>
    ) : null
  const aiButton = (
    <button type="button" className={styles.aiButton} onClick={() => void askAi()} disabled={busy !== ''}>
      {busy === 'ai' && !lengthBusy ? 'Writing…' : highlighted && hasDraft ? 'Revise highlight' : hasDraft ? 'Revise' : 'Write with AI'}
    </button>
  )
  const sendButtons = (
    <>
      <button
        type="button"
        className={styles.send}
        onClick={startSend}
        disabled={busy !== '' || !hasContent || !state.to.trim()}
        aria-busy={busy === 'send'}
      >
        {busy === 'send' ? (
          <>
            <span className={styles.spinner} aria-hidden="true" />
            Sending…
          </>
        ) : (
          'Send'
        )}
      </button>
      {sendPending ? (
        <button type="button" className={styles.undoSend} onClick={undoSend} autoFocus>
          Undo
        </button>
      ) : null}
    </>
  )
  const scheduleLabel = editingScheduled ? 'Change schedule' : 'Schedule send'

  const windowClass = [
    styles.window,
    popout ? styles.popout : '',
    minimised && !popout ? styles.minimised : '',
    expanded && !minimised && !popout ? styles.expanded : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Portalled to <body>: inside the admin layout an ancestor's stacking context
  // capped the z-index, so other overlays covered it.
  return createPortal(
    <div ref={windowRef} className={windowClass} role="dialog" aria-label={title} {...dragHandlers}>
      {dragging ? (
        <div className={styles.dropOverlay} aria-hidden="true">
          Drop files to attach
        </div>
      ) : null}
      <header className={styles.header} onClick={() => minimised && setMinimised(false)}>
        <span className={styles.title}>
          {title}
          {autoStatus ? <span aria-live="polite"> · {autoStatus}</span> : null}
        </span>
        <span className={styles.headerButtons}>
          {onPopOut && !popout && !minimised ? (
            <button
              type="button"
              aria-label="Open in new window"
              title="Open in new window"
              disabled={busy !== '' || sendPending}
              onClick={(e) => {
                e.stopPropagation()
                // The new window takes over: tuck this one away straight away (it closes once the email is handed over).
                if (onPopOut(popOutSnapshot) !== false) setMinimised(true)
              }}
            >
              ⧉
            </button>
          ) : null}
          {popout ? null : (
          <button
            type="button"
            aria-label={minimised ? 'Restore' : 'Minimise'}
            title={minimised ? 'Restore' : 'Minimise'}
            onClick={(e) => {
              e.stopPropagation()
              setMinimised((m) => !m)
            }}
          >
            {minimised ? '▴' : '▁'}
          </button>
          )}
          {/* Phones are already full screen. */}
          {!minimised && !popout && !isPhone ? (
            <button type="button" aria-label={expanded ? 'Exit full size' : 'Full size'} title={expanded ? 'Exit full size' : 'Full size'} onClick={() => setExpanded((x) => !x)}>
              {expanded ? '⤡' : '⤢'}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={(e) => {
              e.stopPropagation()
              closeWindow(onClose)
            }}
          >
            ✕
          </button>
        </span>
      </header>

      {/* Hidden, not unmounted, when minimised so the editor keeps its content. */}
      <div className={styles.content} hidden={minimised}>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span>To</span>
            <RecipientInput label="To" value={state.to} onChange={(to) => setRecipient('to', to)} onBlur={() => settleRecipient('to')} contacts={contacts} onWantContacts={loadContacts} />
            {replyChoices ? (
              <button
                type="button"
                className={`${styles.replyAllToggle} ${replyAll ? styles.replyAllOn : ''}`}
                onClick={toggleReplyAll}
                aria-pressed={replyAll}
                aria-label="Reply all"
                title={replyAll ? 'Reply to the sender only' : 'Reply all: include everyone on the email'}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="7 17 2 12 7 7" />
                  <polyline points="12 17 7 12 12 7" />
                  <path d="M22 18v-2a4 4 0 0 0-4-4H7" />
                </svg>
              </button>
            ) : null}
            {!showCc ? (
              <button type="button" className={styles.ccToggle} onClick={() => setShowCc(true)} title="Add Cc and Bcc recipients">
                Cc
              </button>
            ) : null}
          </label>
          {showCc ? (
            <>
              <label className={styles.field}>
                <span>Cc</span>
                <RecipientInput label="Cc" value={state.cc} onChange={(cc) => setRecipient('cc', cc)} onBlur={() => settleRecipient('cc')} contacts={contacts} onWantContacts={loadContacts} />
              </label>
              <label className={styles.field}>
                <span>Bcc</span>
                <RecipientInput label="Bcc" value={state.bcc ?? ''} onChange={(bcc) => setRecipient('bcc', bcc)} onBlur={() => settleRecipient('bcc')} contacts={contacts} onWantContacts={loadContacts} />
              </label>
            </>
          ) : null}
          <label className={styles.field}>
            <input
              value={state.subject}
              onChange={(e) => setState({ ...state, subject: e.target.value })}
              placeholder="Subject"
              aria-label="Subject"
            />
            {state.mode === 'new' ? (
              <button
                type="button"
                className={styles.aiSubject}
                onClick={() => void suggestSubjectLine()}
                disabled={busy !== '' || !hasDraft}
                title={hasDraft ? 'Write a subject line from the email with AI' : 'Write the email first, then let AI suggest a subject'}
                aria-label="Write subject with AI"
              >
                {busy === 'subject' ? 'Writing…' : '✨ AI subject'}
              </button>
            ) : null}
          </label>
        </div>

        {/* The body and signature scroll together so the whole email is visible. */}
        <div className={styles.draftScroll}>
          <div onFocus={() => (activeEditor.current = 'body')}>
            <RichEmailEditor
              ref={editorRef}
              initialHtml={initial.html}
              preserveLayout
              ariaLabel="Email body"
              placeholder="Write here, or ask the AI below. Cmd+B, I and U format text; Cmd+K adds a link. Paste images and tables straight in. Nothing is sent until you click Send."
              onContentChange={(has) => {
                setHasDraft(has)
                // The first change report is the editor loading its initial body, not an edit.
                const html = editorRef.current?.getHtml() ?? ''
                if (baselineHtml.current === null) baselineHtml.current = html
                else if (html !== baselineHtml.current) {
                  baselineHtml.current = html
                  setEdits((n) => n + 1)
                }
              }}
              onPasteFiles={onPasteFiles}
              onFormatChange={setSelectionFormat}
              mentions={{ contacts, onWantContacts: loadContacts }}
              onHighlightChange={setHighlighted}
              onPastedImagesChange={setPastedImages}
            />
          </div>

          {signatureHtml === null || state.noSignature ? null : (
            <div className={styles.signature}>
              {signatureParts ? (
                <textarea
                  className={styles.signOff}
                  value={state.signOff ?? signatureParts.signOff}
                  rows={Math.max(1, (state.signOff ?? signatureParts.signOff).split('\n').length)}
                  maxLength={MAX_SIGN_OFF_CHARS}
                  onChange={(e) => setState((current) => ({ ...current, signOff: e.target.value }))}
                  aria-label="Sign-off"
                  title="Sign-off for this email. Edit it here; the rest of your signature is added from Gmail."
                  spellCheck
                />
              ) : null}
              {signatureParts && !signatureParts.rest ? null : signatureHtml ? (
                <EmailBody
                  html={buildEmailDocument(signatureParts ? signatureParts.rest : signatureHtml)}
                  title="Your Gmail signature (added automatically)"
                />
              ) : (
                <span className={styles.signatureLabel}>No Gmail signature set. Add one in Gmail settings, then reopen this window.</span>
              )}
            </div>
          )}

          {/* "•••" (the email being replied to) comes after the signature. */}
          {quote ? (
            <div className={styles.quote}>
              <button
                type="button"
                className={`${styles.quoteToggle} ${quoteOpen ? styles.quoteToggleOpen : ''}`}
                onClick={() => {
                  setQuoteMounted(true)
                  setQuoteOpen((open) => !open)
                  setEdits((n) => n + 1)
                }}
                aria-expanded={quoteOpen}
                aria-label={quoteOpen ? 'Hide the email you are replying to' : 'Show the email you are replying to'}
                title={quoteOpen ? 'Hide the email you are replying to (it is then left out of your reply)' : 'Show the email you are replying to, to add notes into it'}
              >
                •••
              </button>
              {quoteMounted ? (
                <div className={styles.quoteBody} hidden={!quoteOpen} onFocus={() => (activeEditor.current = 'quote')}>
                  <p className={styles.quoteHeader}>{quoteHeader}</p>
                  <div className={styles.quoteEditor}>
                    <RichEmailEditor
                      ref={quoteEditorRef}
                      initialHtml={quoteStartHtml}
                      ariaLabel="Email you are replying to (add your notes here)"
                      placeholder="The email you are replying to."
                      onContentChange={() => {
                        const html = quoteEditorRef.current?.getHtml() ?? ''
                        if (quoteBaseline.current === null) quoteBaseline.current = html
                        else if (html !== quoteBaseline.current) {
                          quoteBaseline.current = html
                          setEdits((n) => n + 1)
                        }
                      }}
                      // Files pasted into the quote are attached; images only go inline in the reply.
                      onPasteFiles={(files) => void addAttachments(files)}
                      onFormatChange={setSelectionFormat}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Attachments sit under the signature, as in Gmail. */}
          {state.attachments.length > 0 ? (
            <ul className={styles.attachments} aria-label="Attachments">
              {state.attachments.map((file, index) => (
                <li key={`${index}-${file.name}`} className={styles.attachment}>
                  <span className={styles.attachmentName} title={file.name}>
                    {file.name}
                  </span>
                  <span className={styles.signatureLabel}>{formatSize(base64Bytes(file.data))}</span>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      setState((current) => ({ ...current, attachments: current.attachments.filter((_, i) => i !== index) }))
                    }
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className={styles.ai}>
          {/* Attach / image / table / colour / lists, with "Use whole thread" on the same row (right). */}
          <div className={styles.aiTools}>
            <div className={styles.toolbar}>
              <button
                type="button"
                className={`${styles.toolButton} ${styles.iconButton}`}
                onClick={() => attachInputRef.current?.click()}
                disabled={busy !== ''}
                aria-label="Attach files"
                title="Attach files"
              >
                <span aria-hidden="true">📎</span>
              </button>
              <button
                type="button"
                className={`${styles.toolButton} ${styles.iconButton}`}
                onClick={() => imageInputRef.current?.click()}
                disabled={busy !== ''}
                aria-label="Insert image"
                title="Insert image"
              >
                <span aria-hidden="true">🖼</span>
              </button>
              <button
                type="button"
                className={styles.toolButton}
                onClick={() => setTableOpen((open) => !open)}
                aria-expanded={tableOpen}
                disabled={busy !== ''}
              >
                ⊞ Insert table
              </button>
              <FormatBar
                format={selectionFormat}
                disabled={busy !== ''}
                onColor={(color) => formatTarget()?.setTextColor(color)}
                onList={(type) => formatTarget()?.toggleList(type)}
              />
              {pastedImages > 0 ? (
                <>
                  <button
                    type="button"
                    className={styles.toolButton}
                    onClick={() => scaleImages(-1)}
                    disabled={busy !== ''}
                    title={pastedImages > 1 ? 'Make all your pasted images 10% smaller' : 'Make the pasted image 10% smaller'}
                  >
                    − image
                  </button>
                  <button
                    type="button"
                    className={styles.toolButton}
                    onClick={() => scaleImages(1)}
                    disabled={busy !== ''}
                    title={pastedImages > 1 ? 'Make all your pasted images 10% larger' : 'Make the pasted image 10% larger'}
                  >
                    + image
                  </button>
                </>
              ) : null}
              {hasDraft ? (
                <>
                  <button
                    type="button"
                    className={styles.toolButton}
                    onClick={() => void changeLength('shorten')}
                    disabled={busy !== ''}
                    aria-busy={lengthBusy === 'shorten'}
                    title={highlighted ? 'Make the highlighted text more concise' : 'Make the email more concise, keeping every point'}
                  >
                    {lengthBusy === 'shorten' ? 'Shortening…' : highlighted ? 'Shorten highlight' : 'Shorten email'}
                  </button>
                  <button
                    type="button"
                    className={styles.toolButton}
                    onClick={() => void changeLength('lengthen')}
                    disabled={busy !== ''}
                    aria-busy={lengthBusy === 'lengthen'}
                    title={
                      highlighted
                        ? 'Make the highlighted text a little longer and more professional'
                        : 'Make the email slightly more detailed, keeping every point'
                    }
                  >
                    {lengthBusy === 'lengthen' ? 'Lengthening…' : highlighted ? 'Lengthen highlight' : 'Detailed email'}
                  </button>
                </>
              ) : null}
              {/* Desktop: Undo sits right of the AI change buttons. Phones keep it in the bottom row. */}
              {!isPhone && aiUndo.length > 0 ? (
                <button
                  type="button"
                  className={styles.toolButton}
                  onClick={undoAi}
                  disabled={busy !== ''}
                  title="Put the email back as it was before the last AI change"
                >
                  Undo
                </button>
              ) : null}
              {tableOpen ? (
                <span className={styles.tablePicker}>
                  <label>
                    Rows
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={tableSize.rows}
                      onChange={(e) => setTableSize({ ...tableSize, rows: Number(e.target.value) })}
                      aria-label="Table rows"
                    />
                  </label>
                  <label>
                    Columns
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={tableSize.columns}
                      onChange={(e) => setTableSize({ ...tableSize, columns: Number(e.target.value) })}
                      aria-label="Table columns"
                    />
                  </label>
                  <button type="button" className={styles.toolButton} onClick={insertTable}>
                    Insert
                  </button>
                </span>
              ) : null}
              <input
                ref={attachInputRef}
                type="file"
                multiple
                hidden
                aria-label="Attach files"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  void addAttachments(files)
                }}
              />
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                aria-label="Insert image"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  void addInlineImages(files)
                }}
              />
            </div>
            {state.mode === 'reply' ? (
              <label className={styles.threadToggle}>
                <input type="checkbox" checked={useThread} onChange={(e) => setUseThread(e.target.checked)} disabled={busy !== ''} />
                <span>Use whole thread</span>
              </label>
            ) : null}
            {signatureHtml ? (
              <label className={styles.threadToggle} title="Untick to send this email without your Gmail signature">
                <input
                  type="checkbox"
                  checked={!state.noSignature}
                  onChange={(e) => setState((current) => ({ ...current, noSignature: !e.target.checked }))}
                  disabled={busy !== ''}
                />
                <span>Signature</span>
              </label>
            ) : null}
            {linkedClient ? (
              <label className={styles.threadToggle}>
                <input
                  type="checkbox"
                  checked={useClientData}
                  onChange={(e) => setUseClientData(e.target.checked)}
                  disabled={busy !== ''}
                />
                <span>Use client data{linkedClient.name ? ` (${linkedClient.name})` : ''}</span>
              </label>
            ) : null}
          </div>
          <div className={styles.promptRow}>
            <textarea
              ref={promptRef}
              className={styles.prompt}
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void askAi()
                }
              }}
              placeholder={
                highlighted && hasDraft
                  ? 'Tell the AI what to change in the highlighted text'
                  : hasDraft
                  ? 'Tell the AI what to change, e.g. "shorter" or "mention Thursday". Leave empty and press Revise to tidy the layout'
                  : state.mode === 'reply'
                    ? 'What should the reply say? e.g. "say Thursday works, keep it short"'
                    : 'What should the email say?'
              }
              aria-label="Instruction for the AI"
            />
            {/* On phones these move to the bottom row with Send (see below). */}
            {isPhone ? null : (
              <>
                {voiceButton}
                {aiButton}
              </>
            )}
          </div>
          {clientDataUsed ? <p className={styles.clientDataNote}>Used CMS data for {clientDataUsed}</p> : null}
        </div>

        {note ? <p className={styles.note}>{note}</p> : null}

        {scheduleOpen ? (
          <SchedulePicker
            busy={busy !== ''}
            scheduling={busy === 'schedule'}
            canSchedule={hasContent && (state.to.trim() !== '' || editingScheduled)}
            onSchedule={(when) => void runSchedule(when)}
            {...(initial.scheduledFor ? { initial: new Date(initial.scheduledFor) } : {})}
            {...(editingScheduled ? { actionLabel: 'Update schedule' } : {})}
          />
        ) : null}

        {isPhone ? (
          // Phone: one row for the mic, AI, schedule and Send; the rest is in ⋯.
          <footer className={styles.footer}>
            {voiceButton}
            {/* While a send waits (AI is disabled then), its Undo takes their room. */}
            {sendPending ? null : (
              <>
                {aiUndoButton}
                {aiButton}
              </>
            )}
            <button
              type="button"
              className={styles.roundIcon}
              onClick={toggleSchedule}
              disabled={busy !== '' || !hasContent}
              aria-expanded={scheduleOpen}
              aria-label={scheduleLabel}
              title={scheduleLabel}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            </button>
            {sendButtons}
            {editingScheduled ? null : (
              <ComposeMoreMenu
                items={[
                  {
                    label: busy === 'draft' ? 'Saving…' : 'Save as draft',
                    onSelect: () => void saveDraftNow(),
                    disabled: busy !== '' || !hasContent,
                  },
                  { label: 'Delete draft', onSelect: () => void discardDraft(), disabled: busy !== '' },
                ]}
              />
            )}
          </footer>
        ) : (
          <footer className={styles.footer}>
            {sendButtons}
            <button
              type="button"
              className={styles.secondary}
              onClick={toggleSchedule}
              disabled={busy !== '' || !hasContent}
              aria-expanded={scheduleOpen}
            >
              {scheduleLabel}
            </button>
            <label className={styles.followUp}>
              <span>Remind me if no reply</span>
              <select
                value={followUpDays}
                onChange={(e) => setState((current) => ({ ...current, followUpDays: Number(e.target.value) }))}
                disabled={busy !== ''}
              >
                <option value={0}>Off</option>
                {FOLLOW_UP_DAY_OPTIONS.map((days) => (
                  <option key={days} value={days}>
                    {days} business day{days === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
            {editingScheduled ? null : (
              <button type="button" className={styles.secondary} onClick={() => void saveDraftNow()} disabled={busy !== '' || !hasContent}>
                {busy === 'draft' ? 'Saving…' : 'Save as draft'}
              </button>
            )}
            {editingScheduled ? null : (
              <button
                type="button"
                className={styles.trash}
                onClick={() => void discardDraft()}
                disabled={busy !== ''}
                aria-label="Delete draft"
                title="Delete draft"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                </svg>
              </button>
            )}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  )
}
