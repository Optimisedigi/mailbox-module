/**
 * The table formats the Mail compose window offers (right-click a table to
 * change it). The editor marks a formatted table with TABLE_FORMAT_ATTR, and
 * inlineEmailTableStyles (gmail-html.ts) writes the format's look inline when
 * the email is sent or saved, as Gmail ignores classes.
 *
 * - report: a metrics report table:
 *   shaded slate header, light row rules, first column left and the rest
 *   right-aligned. No row highlight and no coloured values.
 * - grid: every cell ruled, header shaded the report's light blue. Tables with
 *   no format (pasted, or from before formats) are ruled the same way with a
 *   grey header. New tables use it.
 * - minimal: no shading or cell lines, one rule under the header.
 *
 * Pure TS: used by the editor and by the server-side send path.
 */

export type EmailTableFormat = "report" | "grid" | "minimal";

export const EMAIL_TABLE_FORMATS: ReadonlyArray<{ id: EmailTableFormat; label: string }> = [
  { id: "grid", label: "Grid" },
  { id: "report", label: "Report" },
  { id: "minimal", label: "Minimal" },
];

/** Format of tables made with Insert table (and tables the AI adds). */
export const DEFAULT_EMAIL_TABLE_FORMAT: EmailTableFormat = "grid";

export const TABLE_FORMAT_ATTR = "data-table-format";

export function parseEmailTableFormat(value: unknown): EmailTableFormat | null {
  return value === "report" || value === "grid" || value === "minimal" ? value : null;
}

/** CSS declarations as [property, value] pairs, in the order they are written. */
export type StyleDefaults = ReadonlyArray<readonly [string, string]>;

export type TableCellKind = "th" | "td";

/** Gmail's default body font: Verdana at "Normal", which Gmail writes as the keyword `small`. */
export const EMAIL_FONT_FAMILY = "Verdana,sans-serif";
export const EMAIL_FONT_SIZE = "small";

const LEGACY_BORDER = "1px solid #9aa0a6";
const LEGACY_HEADER_BACKGROUND = "#f1f3f4";
/** The report header's light blue, also used for the grid header. */
const REPORT_HEADER_BACKGROUND = "#f1f5f9";

/** Table-level look for a format; null is a table with no format (pasted, or from before formats). */
export function tableStyleDefaults(format: EmailTableFormat | null): StyleDefaults {
  if (format === "report") {
    return [
      ["border-collapse", "collapse"],
      ["width", "auto"],
      ["font-family", EMAIL_FONT_FAMILY],
      ["font-size", "13px"],
      ["color", "#222"],
    ];
  }
  // Font on the table too: some mail clients do not inherit body fonts into tables.
  return [
    ["border-collapse", "collapse"],
    ["font-family", EMAIL_FONT_FAMILY],
    ["font-size", EMAIL_FONT_SIZE],
  ];
}

/** Cell look for a format. `firstColumn` is the row's first cell (left-aligned in every format). */
export function cellStyleDefaults(format: EmailTableFormat | null, kind: TableCellKind, firstColumn: boolean): StyleDefaults {
  if (format === "report") {
    const align: readonly [string, string] = ["text-align", firstColumn ? "left" : "right"];
    if (kind === "th") {
      return [
        ["padding", "8px 12px"],
        ["background-color", REPORT_HEADER_BACKGROUND],
        ["border-bottom", "2px solid #e5e7eb"],
        ["font-size", "12px"],
        ["font-family", "Arial,sans-serif"],
        ["color", "#64748b"],
        ["font-weight", "600"],
        ["white-space", "nowrap"],
        align,
      ];
    }
    return [
      ["padding", "6px 10px"],
      ["border-bottom", "1px solid #e5e7eb"],
      ["font-size", "13px"],
      ["font-family", EMAIL_FONT_FAMILY],
      ["color", "#222"],
      align,
    ];
  }
  if (format === "minimal") {
    const cell: Array<readonly [string, string]> = [
      ["padding", "6px 16px 6px 0"],
      ["vertical-align", "top"],
      ["color", "#222"],
    ];
    return kind === "th"
      ? [...cell, ["border-bottom", "1px solid #222"], ["font-weight", "700"], ["text-align", "left"]]
      : cell;
  }
  // grid, and tables with no format.
  const cell: Array<readonly [string, string]> = [
    ["border", LEGACY_BORDER],
    ["padding", "4px 8px"],
    ["vertical-align", "top"],
  ];
  const headerBackground = format === "grid" ? REPORT_HEADER_BACKGROUND : LEGACY_HEADER_BACKGROUND;
  return kind === "th"
    ? [...cell, ["background-color", headerBackground], ["font-weight", "700"], ["text-align", "left"]]
    : cell;
}
