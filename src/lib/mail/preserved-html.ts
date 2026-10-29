/**
 * Report blocks the Mail compose window keeps exactly as they were written.
 *
 * Generated reports (weekly metric emails, budget trackers, dashboard
 * charts) are laid out with styled cards and nested layout tables. The compose
 * editor (Lexical) can only hold plain paragraphs, lists and simple tables, so
 * loading such a draft into it threw the layout away and the send path then
 * drew grid borders on every cell. Those blocks are instead carried through
 * the editor and the send path untouched, wrapped in a marked <div>.
 */

export const PRESERVED_HTML_ATTR = "data-mailbox-preserved-html";

const BLOCK_CHILD_SELECTOR = "table, div, p, h1, h2, h3, h4, h5, h6, ul, ol";

/**
 * Whether a top-level element of a loaded email is report layout the editor
 * can't represent: already marked, a styled wrapper holding tables or nested
 * blocks, or a layout table nested in a table. Reply quotes are left to the
 * editor so notes can still be added inside them.
 */
export function isPreservedLayoutElement(element: Element): boolean {
  if (element.hasAttribute(PRESERVED_HTML_ATTR)) return true;
  if (element.matches(".gmail_quote, blockquote") || element.querySelector(".gmail_quote, blockquote")) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "table") return element.querySelector("table") !== null;
  if (tag === "p" || !element.hasAttribute("style")) return false;
  return element.querySelector(BLOCK_CHILD_SELECTOR) !== null;
}

const PRESERVED_OPEN_RE = new RegExp(`<div\\b(?:[^>"']|"[^"]*"|'[^']*')*\\s${PRESERVED_HTML_ATTR}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
const DIV_TAG_RE = /<(\/?)div\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/**
 * Apply `transform` to the HTML outside preserved blocks only. Preserved
 * blocks (with their marked wrapper) are passed through byte-for-byte.
 */
export function mapOutsidePreservedHtml(html: string, transform: (segment: string) => string): string {
  if (!html.includes(PRESERVED_HTML_ATTR)) return transform(html);
  let out = "";
  let cursor = 0;
  PRESERVED_OPEN_RE.lastIndex = 0;
  for (let open = PRESERVED_OPEN_RE.exec(html); open; open = PRESERVED_OPEN_RE.exec(html)) {
    // Find the </div> that closes this wrapper, counting nested divs.
    DIV_TAG_RE.lastIndex = open.index + open[0].length;
    let depth = 1;
    let end = html.length;
    for (let tag = DIV_TAG_RE.exec(html); tag; tag = DIV_TAG_RE.exec(html)) {
      depth += tag[1] ? -1 : 1;
      if (depth === 0) {
        end = tag.index + tag[0].length;
        break;
      }
    }
    out += transform(html.slice(cursor, open.index)) + html.slice(open.index, end);
    cursor = end;
    PRESERVED_OPEN_RE.lastIndex = end;
  }
  return out + transform(html.slice(cursor));
}
