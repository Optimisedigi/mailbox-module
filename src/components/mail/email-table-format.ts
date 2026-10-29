import {
  $getNodeByKey,
  $getState,
  $setState,
  createState,
  getStaticNodeConfig,
  isHTMLElement,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { $isTableCellNode, $isTableNode, TableNode } from '@lexical/table'
import {
  cellStyleDefaults,
  parseEmailTableFormat,
  TABLE_FORMAT_ATTR,
  type EmailTableFormat,
} from '@/lib/mail/table-formats'

/**
 * A compose-window table's format (see lib/mail/table-formats), kept on the
 * TableNode. null is a table with no format chosen (pasted, or from before
 * formats), which looks and sends as the grid.
 *
 * - In the editor the table carries TABLE_FORMAT_ATTR, which the CSS styles
 *   (registerTableFormatDom).
 * - In the HTML (send, save, copy) the table carries the same attribute and
 *   the cells drop Lexical's black border, so inlineEmailTableStyles writes
 *   the format's look inline.
 * - Reopening that HTML (a saved draft) restores the format, and drops the
 *   colours the format itself added, so they don't stick to the cells when
 *   the format is changed later.
 */
const tableFormatState = createState('emailTableFormat', { parse: parseEmailTableFormat })

export function $getTableFormat(table: TableNode): EmailTableFormat | null {
  return $getState(table, tableFormatState)
}

export function $setTableFormat(table: TableNode, format: EmailTableFormat | null): void {
  $setState(table, tableFormatState, format)
}

function $formatOfCell(cell: LexicalNode): EmailTableFormat | null {
  const table = cell.getParents().find($isTableNode)
  return table ? $getTableFormat(table) : null
}

function tableElementOf(element: unknown): HTMLTableElement | null {
  if (element instanceof HTMLTableElement) return element
  return isHTMLElement(element) ? element.querySelector('table') : null
}

/** Mark formatted tables in the editor DOM, so the CSS can style each format. */
export function registerTableFormatDom(editor: LexicalEditor): () => void {
  return editor.registerMutationListener(
    TableNode,
    (mutations) => {
      editor.getEditorState().read(() => {
        for (const [key, mutation] of mutations) {
          if (mutation === 'destroyed') continue
          const table = tableElementOf(editor.getElementByKey(key))
          const node = $getNodeByKey(key)
          if (!table || !$isTableNode(node)) continue
          const format = $getTableFormat(node)
          if (format) table.setAttribute(TABLE_FORMAT_ATTR, format)
          else table.removeAttribute(TABLE_FORMAT_ATTR)
        }
      })
    },
    { skipInitialization: false },
  )
}

/** HTML export of a table: its format as an attribute. */
export function exportFormattedTable(editor: LexicalEditor, node: LexicalNode): DOMExportOutput {
  const output = node.exportDOM(editor)
  const format = $isTableNode(node) ? $getTableFormat(node) : null
  if (!format) return output
  return {
    ...output,
    after: (generated) => {
      const result = output.after ? output.after(generated) : generated
      tableElementOf(result)?.setAttribute(TABLE_FORMAT_ATTR, format)
      return result
    },
  }
}

/**
 * HTML export of a cell in a formatted table: without Lexical's own black
 * border, start alignment and grey header, so the format's look fills in.
 * A colour the cell was given itself (pasted) is kept.
 */
export function stripLexicalCellLook(node: LexicalNode, element: HTMLElement): void {
  if (!$isTableCellNode(node) || !$formatOfCell(node)) return
  element.style.removeProperty('border')
  element.style.removeProperty('text-align')
  if (node.getBackgroundColor() === null) element.style.removeProperty('background-color')
}

/** Cell styles Lexical's import reads; the format's own values are dropped before it does. */
const IMPORTED_CELL_PROPERTIES = new Set(['background-color', 'color', 'font-weight'])

function dropFormatCellStyles(table: HTMLTableElement, format: EmailTableFormat): void {
  const probe = table.ownerDocument.createElement('td')
  for (const row of Array.from(table.rows)) {
    Array.from(row.cells).forEach((cell, index) => {
      const kind = cell.tagName === 'TH' ? 'th' : 'td'
      for (const [prop, value] of cellStyleDefaults(format, kind, index === 0)) {
        if (!IMPORTED_CELL_PROPERTIES.has(prop)) continue
        // Compared as the browser writes them, so "#f1f5f9" matches "rgb(241, 245, 249)".
        probe.style.setProperty(prop, value)
        if (cell.style.getPropertyValue(prop) === probe.style.getPropertyValue(prop)) cell.style.removeProperty(prop)
      }
    })
  }
}

/** Import of a table with a format attribute: Lexical's own table import, plus the format. */
export const tableFormatImport: DOMConversionMap = {
  table: (element: HTMLElement) => {
    const format = parseEmailTableFormat(element.getAttribute(TABLE_FORMAT_ATTR))
    if (!format || !(element instanceof HTMLTableElement)) return null
    return {
      priority: 2,
      conversion: (table: HTMLElement): DOMConversionOutput | null => {
        if (table instanceof HTMLTableElement) dropFormatCellStyles(table, format)
        const base = getStaticNodeConfig(TableNode).ownNodeConfig?.importDOM?.table?.(table)?.conversion(table) ?? null
        const node = base?.node
        for (const created of Array.isArray(node) ? node : node ? [node] : []) {
          if ($isTableNode(created)) $setTableFormat(created, format)
        }
        return base
      },
    }
  },
}
