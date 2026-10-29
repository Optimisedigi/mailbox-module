const escapeHtml = (s: string): string => s
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const formatInline = (s: string): string => escapeHtml(s)
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/`([^`]+)`/g, '<code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;font-family:ui-monospace,Menlo,Consolas,monospace;">$1</code>');

/** Split only unescaped delimiters. A literal pipe in a cell is written as \\|. */
function cells(line: string): string[] {
  const value = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return value.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function renderTableAt(lines: string[], start: number): { html: string; end: number } | null {
  const line = (lines[start] ?? "").replace(/\r$/, "");
  if (!line.includes("|") || start + 1 >= lines.length) return null;
  const header = cells(line);
  const separator = cells(lines[start + 1] ?? "");
  if (header.length < 2 || separator.length !== header.length || !separator.every((part) => /^:?-{3,}:?$/.test(part))) return null;

  const rows: string[] = [];
  let end = start + 2;
  while (end < lines.length) {
    const next = (lines[end] ?? "").replace(/\r$/, "");
    if (!next.trim() || !next.includes("|")) break;
    const row = cells(next);
    if (row.length !== header.length) break;
    rows.push(`<tr>${row.map((cell) => `<td style="border:1px solid #000;padding:6px 10px;color:#000;">${formatInline(cell)}</td>`).join("")}</tr>`);
    end++;
  }
  return {
    html: '<table style="border-collapse:collapse;border:1px solid #000;font-family:Arial,Helvetica,sans-serif;font-size:14px;">'
      + `<thead><tr>${header.map((cell) => `<th scope="col" style="border:1px solid #000;background-color:#dbeafe;color:#000;font-weight:700;padding:6px 10px;text-align:left;">${formatInline(cell)}</th>`).join("")}</tr></thead>`
      + `<tbody>${rows.join("")}</tbody></table>`,
    end,
  };
}

/**
 * A small, escaped markdown subset (paragraphs, lists, tables, **bold**,
 * `code`) as top-level blocks (p, ul, ol, table) with no wrapper.
 *
 * blankLines (Mail compose editor): a blank line between paragraphs becomes an
 * empty paragraph, because each editor paragraph is one line with no gap (as in
 * Gmail), so "Hi Sam,\n\nThanks" needs the empty line to keep its gap. Without
 * it, blank lines only separate blocks.
 */
export function markdownLiteToBlocksHtml(input: string, options: { blankLines?: boolean } = {}): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  const closeList = (): void => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    const table = renderTableAt(lines, i);
    if (table) {
      closeList();
      out.push(table.html);
      i = table.end - 1;
      continue;
    }
    const bulletMatch = line.match(/^[-*]\s+(.+)/);
    const numberedMatch = line.match(/^\d+\.\s+(.+)/);
    if (bulletMatch) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${formatInline(bulletMatch[1] ?? "")}</li>`);
    } else if (numberedMatch) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${formatInline(numberedMatch[1] ?? "")}</li>`);
    } else if (line.trim() === "") {
      closeList();
      // One empty paragraph per gap, never at the start.
      if (options.blankLines && out.length > 0 && out[out.length - 1] !== BLANK_LINE) out.push(BLANK_LINE);
    } else {
      closeList();
      out.push(`<p>${formatInline(line)}</p>`);
    }
  }
  closeList();
  // Never end on an empty line.
  while (out[out.length - 1] === BLANK_LINE) out.pop();
  return out.join("");
}

const BLANK_LINE = "<p><br></p>";
