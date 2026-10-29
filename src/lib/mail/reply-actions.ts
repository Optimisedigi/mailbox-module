/**
 * Reply, Reply all and Forward helpers for the Mail view. Client-safe: no
 * server imports.
 */

import { escapeHtml, quoteDate, replyQuoteStartHtml } from './reply-quote'

export interface ReplyRecipients {
  to: string
  cc: string
}

export interface ReplySource {
  from: string
  to: string
  cc: string
}

/** Splits a header address list on commas outside quoted display names. */
export function splitAddressList(value: string): string[] {
  return value
    .split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function addressOf(entry: string): string {
  return (entry.match(/<([^>]+)>/)?.[1] ?? entry).trim().toLowerCase()
}

/**
 * Who a reply and a reply all go to. A reply goes to the sender (or, for one
 * of our own sent messages, back to its recipients). A reply all keeps the
 * same To and Cc's everyone else on the email, never our own addresses and
 * never anyone twice.
 */
export function replyRecipients(message: ReplySource, ownAddresses: readonly string[]): { reply: ReplyRecipients; replyAll: ReplyRecipients } {
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean))
  const sender = message.from.trim()
  const fromSelf = own.has(addressOf(sender))
  const toList = fromSelf ? splitAddressList(message.to) : [sender]
  const reply = { to: fromSelf ? message.to.trim() : addressOf(sender), cc: '' }

  const seen = new Set<string>(own)
  const keep = (entries: string[]) =>
    entries.filter((entry) => {
      const address = addressOf(entry)
      if (!address || seen.has(address)) return false
      seen.add(address)
      return true
    })
  const allTo = keep(toList)
  const allCc = keep(fromSelf ? splitAddressList(message.cc) : [...splitAddressList(message.to), ...splitAddressList(message.cc)])
  return {
    reply,
    replyAll: { to: allTo.length ? allTo.join(', ') : reply.to, cc: allCc.join(', ') },
  }
}

/** Whether a reply all would reach anyone a plain reply does not (compared by address). */
export function hasOtherParticipants(reply: ReplyRecipients, replyAll: ReplyRecipients): boolean {
  const addresses = (value: string) => new Set(splitAddressList(value).map(addressOf))
  const replying = addresses(`${reply.to}, ${reply.cc}`)
  return [...addresses(`${replyAll.to}, ${replyAll.cc}`)].some((address) => !replying.has(address))
}

/** "Fwd: subject", without stacking prefixes. */
export function forwardSubject(subject: string): string {
  return /^(fwd?|fw)\s*:/i.test(subject) ? subject : `Fwd: ${subject || '(no subject)'}`
}

/** Starting body for a forward: Gmail's "Forwarded message" block, then the email. */
export function forwardStartHtml(message: ReplySource & { subject: string; date: string; html: string; text: string }): string {
  const lines = [
    '---------- Forwarded message ---------',
    `From: ${message.from}`,
    `Date: ${quoteDate(message.date)}`,
    `Subject: ${message.subject}`,
    `To: ${message.to}`,
    ...(message.cc.trim() ? [`Cc: ${message.cc}`] : []),
  ]
  return `<p><br></p><p>${lines.map(escapeHtml).join('<br>')}</p>${replyQuoteStartHtml(message)}`
}
