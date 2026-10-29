/**
 * The email being replied to, quoted under a reply (the compose window's
 * "•••" button, like Gmail's "Show trimmed content"). Client-safe.
 *
 * The quote opens in its own editor under the reply so the user can type
 * notes straight into the other person's email. The AI only ever rewrites
 * the reply above it, never the quote. When the email is sent or saved, the
 * quote follows the reply as a Gmail-style "On <date>, <sender> wrote:" line
 * and a blockquote (the server appends the Gmail signature after it, as
 * Gmail does by default).
 */

export interface ReplyQuote {
  from: string
  /** ISO or RFC 2822 date of the email being replied to. */
  date: string
  /** Sanitised HTML (the reading pane's document), or '' for plain-text emails. */
  html: string
  /** Plain-text body, used when there is no HTML. */
  text: string
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function quoteDate(raw: string): string {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw.trim()
  return date.toLocaleString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** "On Tue, 21 Oct 2026, 10:04 am, Jo Smith <jo@x.com> wrote:" (plain text). */
export function replyQuoteHeader(quote: Pick<ReplyQuote, 'from' | 'date'>): string {
  const date = quoteDate(quote.date)
  const from = quote.from.trim() || 'they'
  return date ? `On ${date}, ${from} wrote:` : `${from} wrote:`
}

/** Starting HTML for the quote editor: the email's HTML, or its text as paragraphs. */
export function replyQuoteStartHtml(quote: Pick<ReplyQuote, 'html' | 'text'>): string {
  if (quote.html.trim()) return quote.html
  const paragraphs = quote.text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
  return paragraphs.map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`).join('')
}

const BLOCKQUOTE_STYLE = 'margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex'

/** The reply followed by the quoted email (with the user's notes), as sent. */
export function appendReplyQuote(replyHtml: string, quote: { header: string; html: string }): string {
  if (!quote.html.trim()) return replyHtml
  return `${replyHtml}<div><br></div><div>${escapeHtml(quote.header)}</div><blockquote style="${BLOCKQUOTE_STYLE}">${quote.html}</blockquote>`
}
