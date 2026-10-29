/**
 * Download emails from the Mail reading pane as files (browser side).
 *
 * - One email as Markdown: subject, From/To/Cc/Date, then the full body.
 * - A whole thread as one Markdown file holding, for each message, only the
 *   sender's name, when it was sent and what it says. Quoted earlier
 *   messages ("On … wrote:") are left out, since each one is already in
 *   the file as its own message.
 *
 * EML downloads come from /api/mail/message/[messageId]/eml (Gmail's raw message).
 * The HTML given here is the reading pane's sanitised email document.
 */

export interface ExportableMessage {
  from: string;
  to: string;
  cc: string;
  subject: string;
  /** ISO date. */
  date: string;
  /** Plain-text body. */
  body: string;
  /** Sanitised HTML document, or '' for plain-text emails. */
  html: string;
}

/** Display name from a From header ("Sam Lee <sam@x.com>" → "Sam Lee"), else the address. */
export function senderDisplayName(from: string): string {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (match) return (match[1] ?? "").trim() || (match[2] ?? "").trim();
  return from.trim();
}

/** "22 Oct 2026, 9:38 am AEDT" in the given time zone (default: the browser's). */
export function exportDate(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** Safe file name from an email subject. */
export function exportFileName(subject: string, extension: "md" | "eml"): string {
  const base = subject
    .replace(/[^\p{L}\p{N} _.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return `${base || "email"}.${extension}`;
}

// ── HTML → Markdown ────────────────────────────────────────────────────────

/** Stands in for a meaningful leading space (list indents, code) until whitespace is tidied. */
const INDENT = "\u0001";
const SKIP_TAGS = new Set(["HEAD", "SCRIPT", "STYLE", "TITLE", "META", "LINK", "NOSCRIPT", "TEMPLATE"]);
const LINE_TAGS = new Set(["DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "CENTER", "ADDRESS", "FIGURE", "TR"]);
/** Earlier messages quoted in a reply (Gmail, Apple Mail, Thunderbird, Outlook web). */
const QUOTE_SELECTOR = '.gmail_quote, .gmail_quote_container, .gmail_extra, blockquote[type="cite"], .moz-cite-prefix, #divRplyFwdMsg';

function wrap(text: string, mark: string): string {
  const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const core = match?.[2] ?? "";
  return core ? `${match?.[1] ?? ""}${mark}${core}${mark}${match?.[3] ?? ""}` : text;
}

function safeUrl(value: string | null): string | null {
  const url = (value ?? "").trim();
  return /^(?:https?:|mailto:)/i.test(url) ? url.replace(/\s/g, "%20").replace(/\)/g, "%29") : null;
}

function childrenToMarkdown(node: Node): string {
  return Array.from(node.childNodes).map(nodeToMarkdown).join("");
}

/** Collapse a converted fragment to its lines, for use inside a list item, table cell or quote. */
function innerLines(node: Node): string[] {
  return tidy(childrenToMarkdown(node)).split("\n");
}

function listToMarkdown(list: Element, ordered: boolean): string {
  const start = Number.parseInt(list.getAttribute("start") ?? "", 10);
  const first = Number.isFinite(start) ? start : 1;
  const items = Array.from(list.children).filter((child) => child.tagName === "LI");
  const lines = items.flatMap((item, index) => {
    const marker = ordered ? `${first + index}.` : "-";
    const [head = "", ...rest] = innerLines(item).filter((line) => line.trim() !== "");
    return [`${marker} ${head}`, ...rest.map((line) => `${INDENT.repeat(marker.length + 1)}${line}`)];
  });
  return `\n\n${lines.join("\n")}\n\n`;
}

function tableToMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr")).filter((row) => row.closest("table") === table);
  const cells = rows.map((row) => Array.from(row.children).filter((cell) => cell.tagName === "TD" || cell.tagName === "TH"));
  const width = Math.max(0, ...cells.map((row) => row.length));
  // Layout tables (newsletters, signatures) are read as plain blocks, not as data tables.
  if (width < 2 || table.querySelector("table")) {
    return `\n${cells.flat().map((cell) => `\n${childrenToMarkdown(cell)}\n`).join("")}\n`;
  }
  const text = (cell: Element | undefined) =>
    cell ? innerLines(cell).filter((line) => line.trim()).join(" ").replace(/\|/g, "\\|") : "";
  const line = (row: Element[]) => `| ${Array.from({ length: width }, (_, i) => text(row[i])).join(" | ")} |`;
  const [head = [], ...body] = cells;
  return `\n\n${[line(head), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n")}\n\n`;
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return "";
  switch (tag) {
    case "BR":
      return "\n";
    case "HR":
      return "\n\n---\n\n";
    case "P":
      return `\n\n${childrenToMarkdown(el)}\n\n`;
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return `\n\n${"#".repeat(Number(tag[1]))} ${tidy(childrenToMarkdown(el)).replace(/\n+/g, " ")}\n\n`;
    case "B":
    case "STRONG":
      return wrap(childrenToMarkdown(el), "**");
    case "I":
    case "EM":
      return wrap(childrenToMarkdown(el), "*");
    case "S":
    case "DEL":
    case "STRIKE":
      return wrap(childrenToMarkdown(el), "~~");
    case "CODE":
      return el.closest("pre") ? el.textContent ?? "" : wrap(el.textContent ?? "", "`");
    case "PRE": {
      const code = (el.textContent ?? "").replace(/\n$/, "").replace(/^[ \t]+/gm, (lead) => INDENT.repeat(lead.length));
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    }
    case "A": {
      const text = childrenToMarkdown(el);
      const href = safeUrl(el.getAttribute("href"));
      const label = text.trim();
      if (!href || !label) return text;
      if (label === href || `mailto:${label}` === href) return text;
      return `[${label}](${href})`;
    }
    case "IMG": {
      const src = safeUrl(el.getAttribute("src"));
      // Inline (cid:) and data: images have no address a Markdown file can show.
      return src ? `![${(el.getAttribute("alt") ?? "").replace(/[[\]]/g, "")}](${src})` : "";
    }
    case "UL":
      return listToMarkdown(el, false);
    case "OL":
      return listToMarkdown(el, true);
    case "BLOCKQUOTE":
      return `\n\n${innerLines(el).map((line) => (line ? `> ${line}` : ">")).join("\n")}\n\n`;
    case "TABLE":
      return tableToMarkdown(el);
    case "TD":
    case "TH":
      return ` ${childrenToMarkdown(el)} `;
    default:
      return LINE_TAGS.has(tag) ? `\n${childrenToMarkdown(el)}\n` : childrenToMarkdown(el);
  }
}

/** Trim each line, keep marked indents (turned into spaces only at the very end), and allow at most one blank line in a row. */
function tidy(markdown: string): string {
  return markdown
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown for an email's HTML. With dropQuotes, earlier messages quoted in a reply are left out. */
export function emailHtmlToMarkdown(html: string, options: { dropQuotes?: boolean } = {}): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (options.dropQuotes) {
    for (const quote of Array.from(doc.querySelectorAll(QUOTE_SELECTOR))) {
      if (!quote.isConnected) continue;
      if (quote.id === "divRplyFwdMsg") {
        // Outlook: a rule, the "From: … Sent: …" block, then the quoted message as siblings.
        while (quote.nextSibling) quote.nextSibling.remove();
        const before = quote.previousElementSibling;
        if (before?.tagName === "HR") before.remove();
      }
      quote.remove();
    }
  }
  return tidy(childrenToMarkdown(doc.body)).replaceAll(INDENT, " ");
}

/** A plain-text body without the quoted earlier messages a reply carries below it. */
export function stripQuotedText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cut = lines.findIndex(
    (line, index) =>
      /^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}$/i.test(line.trim()) ||
      /^On\s.+wrote:\s*$/i.test(line.trim()) ||
      // Gmail wraps a long "On … wrote:" across two lines.
      (/^On\s/i.test(line.trim()) && /wrote:\s*$/i.test(lines[index + 1] ?? "")),
  );
  const kept = cut >= 0 ? lines.slice(0, cut) : lines;
  return kept.filter((line) => !/^\s*>/.test(line)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function messageContent(message: ExportableMessage, dropQuotes: boolean): string {
  if (message.html) return emailHtmlToMarkdown(message.html, { dropQuotes });
  return dropQuotes ? stripQuotedText(message.body) : message.body.replace(/\r\n?/g, "\n").trim();
}

/** One email as Markdown: subject, sender, recipients, date and the full body. */
export function messageToMarkdown(message: ExportableMessage, timeZone?: string): string {
  const fields = [
    ["From", message.from],
    ["To", message.to],
    ["Cc", message.cc],
    ["Date", exportDate(message.date, timeZone)],
  ].filter(([, value]) => value);
  return [
    `# ${message.subject || "(no subject)"}`,
    fields.map(([name, value]) => `- **${name}:** ${value}`).join("\n"),
    messageContent(message, false),
  ].join("\n\n") + "\n";
}

/** A thread as Markdown: for each message, oldest first, only the sender's name, the date and time, and the content. */
export function threadToMarkdown(messages: ExportableMessage[], timeZone?: string): string {
  return (
    messages
      .map((message) => `**${senderDisplayName(message.from)}** · ${exportDate(message.date, timeZone)}\n\n${messageContent(message, true)}`)
      .join("\n\n---\n\n") + "\n"
  );
}

/** Save a file in the browser. */
export function saveFile(content: Blob, fileName: string): void {
  const url = URL.createObjectURL(content);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
