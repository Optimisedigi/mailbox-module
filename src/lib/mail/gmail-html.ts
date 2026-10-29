/**
 * Makes the Mail editor's HTML render the same in Gmail as in the CMS.
 *
 * The compose window styles tables with CSS classes (borders, padding, header
 * shading). Classes are stripped before sending (and Gmail ignores them), so
 * without this a table that looks ruled and padded in the CMS arrives as bare,
 * borderless text. Here the same look is written as inline styles on each
 * table, th and td, filling in only what the HTML does not already set, so
 * pasted tables (Sheets, Excel) keep their own formatting.
 */

import {
  cellStyleDefaults,
  parseEmailTableFormat,
  TABLE_FORMAT_ATTR,
  tableStyleDefaults,
  type EmailTableFormat,
  type StyleDefaults,
  type TableCellKind,
} from "@/lib/mail/table-formats";

const TABLE_TAG_RE = /<(\/?)(table|tr|th|td)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const TABLE_FORMAT_ATTR_RE = new RegExp(`\\s${TABLE_FORMAT_ATTR}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
const STYLE_ATTR_RE = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/i;

/** Split CSS declarations on `;`, ignoring semicolons inside quotes or parentheses. */
export function splitDeclarations(style: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const char of style) {
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === ";" && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function declarationProperty(declaration: string): string {
  return declaration.slice(0, Math.max(declaration.indexOf(":"), 0)).trim().toLowerCase();
}

export { EMAIL_FONT_FAMILY, EMAIL_FONT_SIZE } from "@/lib/mail/table-formats";

const isBorderProperty = (prop: string) => /^border(?:$|-)/.test(prop) && prop !== "border-collapse" && prop !== "border-spacing";

function withDefaults(tag: string, attrs: string, defaults: StyleDefaults): string {
  const match = attrs.match(STYLE_ATTR_RE);
  const existing = splitDeclarations(match?.[2] ?? match?.[3] ?? "");
  const props = existing.map(declarationProperty);
  // A side-specific border or padding means the author styled it; do not stack a shorthand on top.
  // Any border of their own also means the format adds none (no rule stacked on a pasted border).
  const has = (prop: string) =>
    isBorderProperty(prop) ? props.some(isBorderProperty) : props.some((p) => p === prop || p.startsWith(`${prop}-`));
  const added = defaults
    .filter(([prop]) => !has(prop))
    .map(([prop, value]) => `${prop}:${value}`);
  const style = [...existing, ...added].join(";");

  let next = attrs;
  if (match) {
    const quote = match[2] !== undefined ? '"' : "'";
    next = attrs.replace(STYLE_ATTR_RE, `${match[1]}${quote}${style}${quote}`);
  } else if (style) {
    next = `${attrs} style="${style}"`;
  }
  // Older mail clients read spacing from the attribute, not CSS.
  if (tag === "table" && !/\scellspacing\s*=/i.test(next)) next += ' cellspacing="0"';
  return next;
}

const OPEN_TAG_RE = /<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const FONT_PROPERTIES = new Set(["font", "font-family", "font-size"]);

/**
 * The compose body has one font: Verdana, Normal, set once on the wrapper by
 * formatGmailDraftHtml. Any font or size inside the body (pasted, or from an
 * older draft) is removed so nothing overrides it; colour, weight and the
 * rest are kept. CSS custom properties (Lexical's list-marker variables) are
 * dropped too, as mail clients ignore them.
 */
export function stripEmailFonts(html: string): string {
  return html.replace(OPEN_TAG_RE, (tag: string, name: string, attrs: string) => {
    let next = name.toLowerCase() === "font" ? attrs.replace(/\s(?:face|size)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "") : attrs;
    const match = next.match(STYLE_ATTR_RE);
    if (match) {
      const declarations = splitDeclarations(match[2] ?? match[3] ?? "");
      const kept = declarations.filter((declaration) => {
        const prop = declarationProperty(declaration);
        return !FONT_PROPERTIES.has(prop) && !prop.startsWith("--");
      });
      if (kept.length !== declarations.length) {
        const quote = match[2] !== undefined ? '"' : "'";
        next = kept.length > 0 ? next.replace(STYLE_ATTR_RE, () => `${match[1]}${quote}${kept.join(";")}${quote}`) : next.replace(STYLE_ATTR_RE, "");
      }
    }
    return next === attrs ? tag : `<${name}${next}>`;
  });
}

const LIST_TAG_RE = /<(\/?)(ul|ol|li)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

function addStyleDefaults(attrs: string, defaults: Array<[string, string]>): string {
  const match = attrs.match(STYLE_ATTR_RE);
  const existing = splitDeclarations(match?.[2] ?? match?.[3] ?? "");
  const props = existing.map(declarationProperty);
  const added = defaults.filter(([prop]) => !props.some((p) => p === prop)).map(([prop, value]) => `${prop}:${value}`);
  if (added.length === 0) return attrs;
  const style = [...existing, ...added].join(";");
  if (!match) return `${attrs} style="${style}"`;
  const quote = match[2] !== undefined ? '"' : "'";
  return attrs.replace(STYLE_ATTR_RE, () => `${match[1]}${quote}${style}${quote}`);
}

/**
 * Lists as the compose editor shows them (its CSS never reaches Gmail):
 * markers on, a small indent (22px list + 12px item, so the bullet sits just
 * inside the text edge, as in Gmail) and a slight gap above and below a
 * top-level list. Nested lists get no gap. Values the HTML already sets are kept.
 */
export function inlineEmailListStyles(html: string): string {
  if (!/<(ul|ol)\b/i.test(html)) return html;
  let depth = 0;
  return html.replace(LIST_TAG_RE, (tag: string, closing: string, name: string, attrs: string) => {
    const lower = name.toLowerCase();
    if (closing) {
      if (lower !== "li") depth = Math.max(0, depth - 1);
      return tag;
    }
    if (lower === "li") {
      return `<li${addStyleDefaults(attrs, [
        ["margin-left", "12px"],
        ["padding-left", "2px"],
      ])}>`;
    }
    const gap = depth === 0 ? "6px" : "0";
    depth++;
    return `<${lower}${addStyleDefaults(attrs, [
      ["margin-top", gap],
      ["margin-bottom", gap],
      ["padding-left", "22px"],
      ["list-style-type", lower === "ol" ? (depth > 1 ? "lower-alpha" : "decimal") : depth > 1 ? "circle" : "disc"],
    ])}>`;
  });
}

const PARAGRAPH_OR_TABLE_TAG_RE = /<(\/?)(p|table)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

/**
 * Each paragraph in the compose editor is one line (Enter starts a new line,
 * with no gap; an empty paragraph is a blank line), like Gmail's own editor.
 * Gmail writes those lines as <div>s, so the editor's paragraphs are sent the
 * same way. Left as <p>, formatGmailDraftHtml would add a blank line after
 * each one, so every Enter showed up as a double line break.
 * Paragraphs inside table cells are left to formatGmailDraftHtml, which joins
 * them with single line breaks.
 */
export function editorParagraphsToGmailLines(html: string): string {
  if (!/<p\b/i.test(html)) return html;
  let tableDepth = 0;
  return html.replace(PARAGRAPH_OR_TABLE_TAG_RE, (tag: string, closing: string, name: string, attrs: string) => {
    if (name.toLowerCase() === "table") {
      tableDepth = closing ? Math.max(0, tableDepth - 1) : tableDepth + 1;
      return tag;
    }
    if (tableDepth > 0) return tag;
    return closing ? "</div>" : `<div${attrs}>`;
  });
}

/**
 * Tables as the compose editor shows them (its classes never reach Gmail): the
 * look of each table's format (see table-formats.ts), or the grid look for a
 * table with no format, written inline on the table, th and td. Only what the
 * HTML does not already set is filled in, so pasted tables (Sheets, Excel)
 * keep their own formatting.
 */
export function inlineEmailTableStyles(html: string): string {
  if (!/<(table|th|td)\b/i.test(html)) return html;
  // One entry per open table: its format and how many cells the current row has had.
  const tables: Array<{ format: EmailTableFormat | null; cells: number }> = [];
  return html
    .replace(/<colgroup\b[\s\S]*?<\/colgroup\s*>/gi, "")
    .replace(TABLE_TAG_RE, (tag: string, closing: string, name: string, attrs: string) => {
      const lower = name.toLowerCase();
      if (closing) {
        if (lower === "table") tables.pop();
        return tag;
      }
      if (lower === "table") {
        const found = attrs.match(TABLE_FORMAT_ATTR_RE);
        const format = parseEmailTableFormat(found?.[1] ?? found?.[2] ?? found?.[3]);
        tables.push({ format, cells: 0 });
        return `<table${withDefaults("table", attrs, tableStyleDefaults(format))}>`;
      }
      const table = tables[tables.length - 1];
      if (lower === "tr") {
        if (table) table.cells = 0;
        return tag;
      }
      const firstColumn = table ? table.cells === 0 : true;
      if (table) table.cells++;
      const kind: TableCellKind = lower === "th" ? "th" : "td";
      return `<${lower}${withDefaults(lower, attrs, cellStyleDefaults(table?.format ?? null, kind, firstColumn))}>`;
    });
}

/**
 * Removes `white-space: pre`/`pre-wrap`/`pre-line` from email HTML, keeping
 * how the text looks.
 *
 * Why: the compose editor marks every run of text `white-space: pre-wrap`.
 * Mail servers and clients (Outlook especially) may re-wrap a message's long
 * HTML lines with real line breaks when they relay or quote it. In normal
 * HTML a line break is just a space, but inside pre-wrap text it shows as a
 * hard break, so the quoted copy in a reply ends up broken mid-sentence
 * ("To improve" / " conversions"). Gmail's own composer never uses pre-wrap.
 *
 * Inside text that was pre-wrap, what the style used to preserve is written
 * out instead: line breaks become <br>, tabs and runs of spaces become
 * non-breaking spaces. Text inside <pre> and <textarea> is left alone.
 */
const WHITE_SPACE_TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TAGS = new Set(["pre", "textarea", "script", "style"]);

type WhiteSpaceMode = "collapse" | "keep-all" | "keep-newlines";

function whiteSpaceModeOf(attrs: string): WhiteSpaceMode | null {
  const match = attrs.match(STYLE_ATTR_RE);
  if (!match) return null;
  let mode: WhiteSpaceMode | null = null;
  for (const declaration of splitDeclarations(match[2] ?? match[3] ?? "")) {
    if (declarationProperty(declaration) !== "white-space") continue;
    const value = declaration.slice(declaration.indexOf(":") + 1).replace(/!important/i, "").trim().toLowerCase();
    if (value === "pre" || value === "pre-wrap" || value === "break-spaces") mode = "keep-all";
    else if (value === "pre-line") mode = "keep-newlines";
    else if (value === "normal" || value === "nowrap") mode = "collapse";
  }
  return mode;
}

function withoutPreWhiteSpace(attrs: string): string {
  const match = attrs.match(STYLE_ATTR_RE);
  if (!match) return attrs;
  const declarations = splitDeclarations(match[2] ?? match[3] ?? "");
  const kept = declarations.filter((declaration) => {
    if (declarationProperty(declaration) !== "white-space") return true;
    return !/^\s*white-space\s*:\s*(?:pre|pre-wrap|pre-line|break-spaces)\b/i.test(declaration);
  });
  if (kept.length === declarations.length) return attrs;
  const quote = match[2] !== undefined ? '"' : "'";
  return kept.length > 0 ? attrs.replace(STYLE_ATTR_RE, () => `${match[1]}${quote}${kept.join(";")}${quote}`) : attrs.replace(STYLE_ATTR_RE, "");
}

function preservedText(text: string, mode: WhiteSpaceMode): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out = mode === "keep-all"
    ? lines.map((line) =>
        line
          .replace(/\t/g, "\u00a0\u00a0\u00a0\u00a0")
          .replace(/ {2,}/g, (run) => `${"\u00a0".repeat(run.length - 1)} `)
          .replace(/^ /, "\u00a0"),
      )
    : lines;
  return out.join("<br>").replace(/\u00a0/g, "&nbsp;");
}

export function flattenPreWrapWhitespace(html: string): string {
  if (!/white-space\s*:\s*(?:pre|break-spaces)/i.test(html)) return html;
  const stack: Array<{ name: string; mode: WhiteSpaceMode; raw: boolean }> = [];
  const current = () => stack[stack.length - 1] ?? { name: "", mode: "collapse" as WhiteSpaceMode, raw: false };
  return html.replace(WHITE_SPACE_TOKEN_RE, (token: string, closing: string | undefined, rawName: string | undefined, attrs: string | undefined) => {
    if (token.startsWith("<!--") || token === "<") return token;
    if (rawName === undefined) {
      const { mode, raw } = current();
      return raw || mode === "collapse" ? token : preservedText(token, mode);
    }
    const name = rawName.toLowerCase();
    if (closing) {
      const at = stack.map((entry) => entry.name).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      return token;
    }
    const parent = current();
    const raw = parent.raw || RAW_TAGS.has(name);
    const mode = whiteSpaceModeOf(attrs ?? "") ?? parent.mode;
    const selfClosing = /\/\s*$/.test(attrs ?? "");
    if (!VOID_TAGS.has(name) && !selfClosing) stack.push({ name, mode, raw });
    if (raw) return token;
    const nextAttrs = withoutPreWhiteSpace(attrs ?? "");
    return nextAttrs === attrs ? token : `<${rawName}${nextAttrs}>`;
  });
}
