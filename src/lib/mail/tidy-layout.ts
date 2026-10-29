/**
 * Rules for "tidy the layout": what the compose window's Revise button does
 * when the AI instruction is empty (no AI involved).
 *
 * - Tables: each column is as wide as its longest text, the same width all
 *   the way down, and the first column never wraps. Widths are written into
 *   the table itself (cell widths), so they survive saved drafts and reach
 *   Gmail; Lexical otherwise exports every cell at a fixed 75px, which wraps
 *   words such as "Impressions".
 * - Spacing: an empty line after the greeting, before the TL;DR, before a
 *   bold line that labels a section, and after each table.
 */

/** A bold line longer than this is a sentence that happens to be bold, not a section label. */
export const MAX_SECTION_LABEL_CHARS = 120;
/** A greeting line longer than this is a sentence that starts with "Hi". */
const MAX_GREETING_CHARS = 60;

const GREETING_RE = /^(?:hi|hello|hey|dear|g'?day|good (?:morning|afternoon|evening))\b/i;
const TLDR_RE = /^\W*tl\s*;?\s*dr\b/i;

export function isGreetingLine(text: string): boolean {
  const line = text.trim();
  return line.length > 0 && line.length <= MAX_GREETING_CHARS && !line.includes("\n") && GREETING_RE.test(line);
}

export function isTldrLine(text: string): boolean {
  return TLDR_RE.test(text.trim());
}

/** One table cell for sizing: its lines of text and whether it shows bold. */
export interface MeasuredCell {
  lines: string[];
  bold: boolean;
}

/** Width in px of one line of text in the email font. */
export type MeasureText = (text: string, bold: boolean) => number;

/** Rough width when the browser cannot measure (Verdana at Normal size averages about 8px a character). */
export function estimateTextWidth(text: string, bold: boolean): number {
  return text.length * (bold ? 9 : 8);
}

const MIN_COLUMN_PX = 40;
/** Other columns wrap past this, so one long cell cannot push the table far off screen. */
const MAX_COLUMN_PX = 320;
/** The first column only wraps past this. */
const MAX_FIRST_COLUMN_PX = 480;

/**
 * Width for each column (index = column): its widest line plus a margin, as
 * other mail apps can draw the font a little wider. Columns are lists of the
 * cells in that column, top to bottom.
 */
export function columnWidths(columns: MeasuredCell[][], measure: MeasureText): number[] {
  return columns.map((cells, index) => {
    const widest = Math.max(0, ...cells.flatMap((cell) => cell.lines.map((line) => measure(line.trim(), cell.bold))));
    const width = Math.ceil(widest * 1.1) + 4;
    return Math.min(Math.max(width, MIN_COLUMN_PX), index === 0 ? MAX_FIRST_COLUMN_PX : MAX_COLUMN_PX);
  });
}
