/**
 * The sign-off at the top of a Gmail signature ("Thanks,\nPat") is shown
 * and edited in the compose window as plain text in the body font (Verdana,
 * Normal); the rest of the signature (phone, logo, links) is appended as
 * Gmail has it. Pure string code, used in the browser and on the server so
 * both split the signature the same way.
 *
 * The sign-off is the first 1 to 3 short plain-text lines of the signature,
 * ending at a blank line, a line with a link/image/table, or the end. Anything
 * else (no blank line, long lines, a logo first) is left as it is: no split.
 */

export interface SignatureParts {
  /** Sign-off lines, newline separated. */
  signOff: string;
  /** The signature after the sign-off, still valid HTML (open wrappers re-opened). */
  rest: string;
}

/** Marks the sign-off in sent/saved mail, so a reopened draft can find and edit it. */
const SIGN_OFF_ATTR = "data-mailbox-signoff";
const MAX_LINES = 3;
const MAX_LINE_CHARS = 60;
/** Limits on the edited sign-off accepted from the compose window. */
export const MAX_SIGN_OFF_CHARS = 300;
const MAX_SIGN_OFF_LINES = 6;

const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const BLOCK = new Set([
  "address", "blockquote", "center", "dd", "div", "dl", "dt", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
const RICH = new Set(["a", "img", "table", "svg", "video", "picture", "iframe"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "wbr"]);

interface Line {
  text: string;
  rich: boolean;
  /** Where the line (and its terminator) ends in the HTML. */
  end: number;
  /** Raw opening tags still open at `end`. */
  open: string[];
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, "&");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Visual lines of an HTML fragment: <br> and block boundaries break lines. */
function htmlLines(html: string): Line[] {
  const lines: Line[] = [];
  const stack: Array<{ name: string; raw: string }> = [];
  let current = { text: "", rich: false };
  const hasContent = () => current.text.trim() !== "" || current.rich;
  const finish = (end: number) => {
    lines.push({ text: current.text.replace(/\s+/g, " ").trim(), rich: current.rich, end, open: stack.map((tag) => tag.raw) });
    current = { text: "", rich: false };
  };

  let last = 0;
  for (const match of html.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    const token = match[0];
    current.text += decodeEntities(html.slice(last, start));
    last = start + token.length;
    const name = (match[2] ?? "").toLowerCase();
    if (!name) continue; // comment
    const closing = match[1] === "/";

    if (name === "br") {
      finish(last);
      continue;
    }
    if (BLOCK.has(name) && hasContent()) {
      if (closing) {
        popTo(stack, name);
        finish(last);
        continue;
      }
      // An opening block starts a new line: the current one ends just before it.
      finish(start);
    }
    if (RICH.has(name) && !closing) current.rich = true;
    if (closing) popTo(stack, name);
    else if (!VOID.has(name) && !/\/\s*$/.test(match[3] ?? "")) stack.push({ name, raw: token });
  }
  current.text += decodeEntities(html.slice(last));
  if (hasContent()) finish(html.length);
  return lines;
}

function popTo(stack: Array<{ name: string }>, name: string): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]?.name === name) {
      stack.splice(i);
      return;
    }
  }
}

/** Split a Gmail signature into its sign-off and the rest, or null when it has no clear sign-off. */
export function splitSignatureSignOff(signatureHtml: string): SignatureParts | null {
  const html = signatureHtml.trim();
  if (!html) return null;
  const lines = htmlLines(html);
  let index = 0;
  while (index < lines.length && lines[index]?.text === "" && !lines[index]?.rich) index++;
  const signOff: Line[] = [];
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line || line.rich || line.text === "") break;
    if (line.text.length > MAX_LINE_CHARS) return null;
    signOff.push(line);
  }
  const lastLine = signOff[signOff.length - 1];
  if (!lastLine || signOff.length > MAX_LINES) return null;
  const tail = html.slice(lastLine.end);
  const rest = /<(img|a|table)\b/i.test(tail) || decodeEntities(tail.replace(/<[^>]*>/g, "")).trim() !== "" ? lastLine.open.join("") + tail : "";
  return { signOff: signOff.map((line) => line.text).join("\n"), rest };
}

/** The sign-off as sent: plain text in the body font, marked so a reopened draft can find it. */
export function signOffHtml(signOff: string): string {
  const lines = signOff.split("\n").map((line) => escapeHtml(line.trim()));
  return `<div ${SIGN_OFF_ATTR}="true">${lines.join("<br>")}</div>`;
}

/** The signature to append: the edited sign-off in place of the original one. */
export function withEditedSignOff(signatureHtml: string, signOff: string): string {
  const parts = splitSignatureSignOff(signatureHtml);
  if (!parts) return signatureHtml;
  // An emptied sign-off still leaves its (empty, invisible) marker, so a reopened draft finds it.
  return `${signOff.trim() ? signOffHtml(signOff) : `<div ${SIGN_OFF_ATTR}="true"></div>`}${parts.rest}`;
}

/** Validate the edited sign-off from a request: plain text, a few short lines, or undefined if absent. */
export function cleanSignOff(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\0-\x08\x0b-\x1f\x7f]/g, "")
    .split("\n")
    .slice(0, MAX_SIGN_OFF_LINES)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
    .slice(0, MAX_SIGN_OFF_CHARS);
}

const SIGN_OFF_TAIL_RE = new RegExp(`<div ${SIGN_OFF_ATTR}="true">([\\s\\S]*?)</div>\\s*$`);

/** If `html` ends with a marked sign-off, return it as text plus the HTML before it. */
export function takeTrailingSignOff(html: string): { html: string; signOff: string } | null {
  const match = html.match(SIGN_OFF_TAIL_RE);
  if (!match || match.index === undefined) return null;
  const signOff = decodeEntities((match[1] ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""));
  return { html: html.slice(0, match.index), signOff: signOff.trim() };
}
