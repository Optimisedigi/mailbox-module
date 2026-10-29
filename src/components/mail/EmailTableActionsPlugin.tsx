'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { $getNearestNodeFromDOMNode, $getNodeByKey, $getSelection, $isRangeSelection, $setSelection, type LexicalEditor } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $computeTableMap,
  $createTableSelectionFrom,
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $getTableCellNodeFromLexicalNode,
  $isTableCellNode,
  $isTableNode,
  $isTableSelection,
  type TableCellNode,
} from '@lexical/table'
import { EMAIL_TABLE_FORMATS, type EmailTableFormat } from '@/lib/mail/table-formats'
import { $getTableFormat, $setTableFormat, registerTableFormatDom } from './email-table-format'
import styles from './ComposeWindow.module.css'

/**
 * Delete rows and columns of a table in the email body.
 *
 * - While the cursor (or a dragged cell selection) is in a table, a "⋯"
 *   handle sits right above that column and a "⋮" handle right of that row.
 *   The column handle's menu opens right above the column and deletes it; the
 *   row handle's menu opens beside the row and deletes it. With cells across
 *   several columns or rows selected, they delete all of them.
 * - Right-clicking a cell (or the context-menu key / Shift+F10 in a table)
 *   opens a menu to add a row above or below, add a column left or right,
 *   delete the row or the column, or change the whole table's format
 *   (Grid, Report, Minimal; see lib/mail/table-formats).
 *
 * The handles are drawn inside the editor's shell, so they scroll with the
 * table, and are re-placed after every edit and size change (column resize,
 * typing, expanding the window), so they never drift away from their column.
 *
 * Deleting the last row or column removes the table. Each add, delete or
 * format change is one editor change, so Cmd/Ctrl+Z undoes it.
 */

/** The table cells an action applies to: the selection's two corner cells. */
interface TableTarget {
  tableKey: string
  anchorKey: string
  focusKey: string
  /** From a dragged cell selection (TableSelection), not just the cursor. */
  cells: boolean
  rows: number
  columns: number
  /** First and last column and row, in table-map coordinates. */
  fromColumn: number
  toColumn: number
  fromRow: number
  toRow: number
  /** The table's format; null when none was chosen (shown and sent as the grid). */
  format: EmailTableFormat | null
}

/** A screen box (viewport px). */
interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

interface MenuState {
  kind: 'column' | 'row' | 'context'
  /** Column menus open right above this box, row menus to its right, context menus at its top-left (the pointer). */
  anchor: Box
  target: TableTarget
}

type HandleKind = 'column' | 'row'

/** Where each handle sits, relative to the editor shell. */
type Handles = Record<HandleKind, { left: number; top: number }>

/** Column handle: a "⋯" right above the column. Row handle: a "⋮" right of the row. */
const HANDLE_SIZE: Record<HandleKind, { width: number; height: number }> = {
  column: { width: 24, height: 14 },
  row: { width: 14, height: 24 },
}
const HANDLE_GAP = 2
const MENU_GAP = 4

/** Every item in a table menu: the delete actions and the format choices. */
const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]'

const countLabel = (n: number, one: string) => (n === 1 ? `Delete ${one}` : `Delete ${n} ${one}s`)

function $cellOf(key: string): TableCellNode | null {
  const node = $getNodeByKey(key)
  return node ? $getTableCellNodeFromLexicalNode(node) : null
}

function $targetFrom(anchor: TableCellNode, focus: TableCellNode, cells: boolean): TableTarget | null {
  const table = anchor.getParents().find($isTableNode)
  if (!table || !focus.getParents().some((node) => node.is(table))) return null
  const [, a, f] = $computeTableMap(table, anchor, focus)
  const fromColumn = Math.min(a.startColumn, f.startColumn)
  const toColumn = Math.max(a.startColumn + a.cell.getColSpan() - 1, f.startColumn + f.cell.getColSpan() - 1)
  const fromRow = Math.min(a.startRow, f.startRow)
  const toRow = Math.max(a.startRow + a.cell.getRowSpan() - 1, f.startRow + f.cell.getRowSpan() - 1)
  return {
    tableKey: table.getKey(),
    anchorKey: anchor.getKey(),
    focusKey: focus.getKey(),
    cells,
    rows: toRow - fromRow + 1,
    columns: toColumn - fromColumn + 1,
    fromColumn,
    toColumn,
    fromRow,
    toRow,
    format: $getTableFormat(table),
  }
}

/** The table cells the selection is in, or null when it isn't in one table. */
function $selectionTarget(): TableTarget | null {
  const selection = $getSelection()
  if ($isTableSelection(selection)) {
    const anchor = $cellOf(selection.anchor.key)
    const focus = $cellOf(selection.focus.key)
    return anchor && focus ? $targetFrom(anchor, focus, true) : null
  }
  if (!$isRangeSelection(selection)) return null
  const anchor = $getTableCellNodeFromLexicalNode(selection.anchor.getNode())
  const focus = $getTableCellNodeFromLexicalNode(selection.focus.getNode())
  return anchor && focus ? $targetFrom(anchor, focus, false) : null
}

/** Put the selection back on the target's cells, so the table helpers delete the right ones. False when they are gone. */
function $selectTarget(target: TableTarget): boolean {
  const table = $getNodeByKey(target.tableKey)
  const anchor = $getNodeByKey(target.anchorKey)
  const focus = $getNodeByKey(target.focusKey)
  if (!$isTableNode(table) || !$isTableCellNode(anchor) || !$isTableCellNode(focus)) return false
  if (target.cells) $setSelection($createTableSelectionFrom(table, anchor, focus))
  else {
    const current = $selectionTarget()
    // Keep the cursor where it is when it's still in these cells; otherwise put it in the anchor cell.
    if (!current || current.anchorKey !== target.anchorKey || current.focusKey !== target.focusKey) anchor.selectStart()
  }
  return true
}

/** Screen boxes of the target's columns (table top to bottom) and rows (table left to right), or null when not rendered. */
function targetBoxes(editor: LexicalEditor, target: TableTarget): { columns: Box; rows: Box } | null {
  const tableElement = editor.getElementByKey(target.tableKey)
  if (!(tableElement instanceof HTMLTableElement)) return null
  const keys = editor.getEditorState().read(() => {
    const table = $getNodeByKey(target.tableKey)
    const cell = $getNodeByKey(target.anchorKey)
    if (!$isTableNode(table) || !$isTableCellNode(cell)) return null
    const [map] = $computeTableMap(table, cell, cell)
    return {
      left: map[0]?.[target.fromColumn]?.cell.getKey(),
      right: map[0]?.[target.toColumn]?.cell.getKey(),
      top: map[target.fromRow]?.[0]?.cell.getKey(),
      bottom: map[target.toRow]?.[0]?.cell.getKey(),
    }
  })
  const rect = (key: string | undefined) => (key ? (editor.getElementByKey(key)?.getBoundingClientRect() ?? null) : null)
  const left = rect(keys?.left)
  const right = rect(keys?.right)
  const top = rect(keys?.top)
  const bottom = rect(keys?.bottom)
  if (!left || !right || !top || !bottom) return null
  const table = tableElement.getBoundingClientRect()
  return {
    columns: { left: left.left, right: right.right, top: table.top, bottom: table.bottom },
    rows: { left: table.left, right: table.right, top: top.top, bottom: bottom.bottom },
  }
}

/** What a table menu item does to the target's rows or columns. */
type TableAction = 'row-above' | 'row-below' | 'column-left' | 'column-right' | 'delete-row' | 'delete-column'

function TableMenu({ menu, onClose, onAction, onFormat, keepOpenFor }: {
  menu: MenuState
  /** Clicks here (the handles) don't count as clicking away: the handle toggles or switches the menu itself. */
  keepOpenFor: React.RefObject<HTMLElement | null>
  onClose: (refocusEditor: boolean) => void
  onAction: (action: TableAction, target: TableTarget) => void
  onFormat: (format: EmailTableFormat, target: TableTarget) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const formatLabelId = useId()
  const { target } = menu
  // null is a separator between groups.
  const items: Array<{ action: TableAction; label: string } | null> = menu.kind === 'column'
    ? [{ action: 'delete-column', label: countLabel(target.columns, 'column') }]
    : menu.kind === 'row'
      ? [{ action: 'delete-row', label: countLabel(target.rows, 'row') }]
      : [
          { action: 'row-above', label: 'Insert row above' },
          { action: 'row-below', label: 'Insert row below' },
          { action: 'column-left', label: 'Insert column left' },
          { action: 'column-right', label: 'Insert column right' },
          null,
          { action: 'delete-row', label: countLabel(target.rows, 'row') },
          { action: 'delete-column', label: countLabel(target.columns, 'column') },
        ]

  // Column menus sit right above the column, row menus right of the row, context menus at the pointer; all kept on screen.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    const width = box?.width ?? 0
    const height = box?.height ?? 0
    const { anchor } = menu
    let left = anchor.left
    let top = anchor.top
    if (menu.kind === 'column') {
      left = (anchor.left + anchor.right) / 2 - width / 2
      top = anchor.top - MENU_GAP - height
      // No room above: open below the handle instead.
      if (top < 8) top = anchor.bottom + MENU_GAP
    } else if (menu.kind === 'row') {
      left = anchor.right + MENU_GAP
      top = (anchor.top + anchor.bottom) / 2 - height / 2
      // No room to the right: open to the left of the handle.
      if (left + width > window.innerWidth - 8) left = anchor.left - MENU_GAP - width
    } else if (top + height > window.innerHeight - 8) {
      top -= height
    }
    setPosition({
      left: Math.round(Math.max(8, Math.min(left, window.innerWidth - width - 8))),
      top: Math.round(Math.max(8, Math.min(top, window.innerHeight - height - 8))),
    })
  }, [menu])

  // Focus the first item once the menu is placed (a hidden element can't take focus).
  const placed = position !== null
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus()
  }, [placed, menu])

  useEffect(() => {
    const away = (event: Event) => {
      const at = event.target as Node
      if (!ref.current?.contains(at) && !keepOpenFor.current?.contains(at)) onClose(false)
    }
    document.addEventListener('mousedown', away)
    window.addEventListener('scroll', away, true)
    window.addEventListener('resize', away)
    return () => {
      document.removeEventListener('mousedown', away)
      window.removeEventListener('scroll', away, true)
      window.removeEventListener('resize', away)
    }
  }, [onClose, keepOpenFor])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLElement)
    const move = (to: number) => {
      event.preventDefault()
      buttons[(to + buttons.length) % buttons.length]?.focus()
    }
    if (event.key === 'ArrowDown') move(index + 1)
    else if (event.key === 'ArrowUp') move(index - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(buttons.length - 1)
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      onClose(true)
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menu.kind === 'column' ? 'Column options' : menu.kind === 'row' ? 'Row options' : 'Table options'}
      className={styles.tableMenu}
      // Measured hidden first, then placed.
      style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) =>
        item ? (
          <button
            key={item.action}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={styles.tableMenuItem}
            onClick={() => onAction(item.action, target)}
          >
            {item.label}
          </button>
        ) : (
          <div key={`separator-${index}`} role="separator" className={styles.tableMenuSeparator} />
        ),
      )}
      {menu.kind === 'context' ? (
        <>
          <div role="separator" className={styles.tableMenuSeparator} />
          <div role="group" aria-labelledby={formatLabelId}>
            <div id={formatLabelId} role="presentation" className={styles.tableMenuLabel}>
              Table format
            </div>
            {EMAIL_TABLE_FORMATS.map((format) => (
              <button
                key={format.id}
                type="button"
                role="menuitemradio"
                aria-checked={target.format === format.id}
                tabIndex={-1}
                className={styles.tableMenuItem}
                onClick={() => onFormat(format.id, target)}
              >
                <svg aria-hidden="true" className={styles.tableMenuCheck} width="12" height="12" viewBox="0 0 12 12" fill="none">
                  {target.format === format.id ? (
                    <path d="M2.5 6.5l2.25 2.25L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  ) : null}
                </svg>
                {format.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

export function EmailTableActionsPlugin() {
  const [editor] = useLexicalComposerContext()
  const [target, setTarget] = useState<TableTarget | null>(null)
  const [focused, setFocused] = useState(false)
  const [shell, setShell] = useState<HTMLElement | null>(null)
  const [handles, setHandles] = useState<Handles | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const handlesRef = useRef<HTMLDivElement>(null)

  // Formatted tables are marked in the editor DOM, for the format's CSS.
  useEffect(() => registerTableFormatDom(editor), [editor])

  // Where the selection is in a table, as it changes.
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const next = editorState.read($selectionTarget, { editor })
        setTarget((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      }),
    [editor],
  )

  // Only while the body (or a handle) has focus, so the handles don't linger over a table you've left.
  useEffect(
    () =>
      editor.registerRootListener((root, previous) => {
        const onFocusIn = () => setFocused(true)
        const onFocusOut = (event: FocusEvent) => {
          const to = event.relatedTarget
          if (to instanceof Node && (root?.contains(to) || handlesRef.current?.contains(to))) return
          setFocused(false)
        }
        previous?.removeEventListener('focusin', onFocusIn)
        previous?.removeEventListener('focusout', onFocusOut)
        // Handles are drawn in the editor's shell (position: relative), so they scroll with the body.
        setShell(root?.parentElement ?? null)
        if (!root) return
        root.addEventListener('focusin', onFocusIn)
        root.addEventListener('focusout', onFocusOut)
        if (root.contains(document.activeElement)) setFocused(true)
        return () => {
          root.removeEventListener('focusin', onFocusIn)
          root.removeEventListener('focusout', onFocusOut)
        }
      }),
    [editor],
  )

  const show = (focused || menu?.kind === 'column' || menu?.kind === 'row') && target !== null && shell !== null && editor.isEditable()
  useLayoutEffect(() => {
    if (!show || !target || !shell) {
      setHandles(null)
      return
    }
    let frame = 0
    const place = () => {
      const boxes = targetBoxes(editor, target)
      if (!boxes) {
        setHandles(null)
        return
      }
      const origin = shell.getBoundingClientRect()
      const next: Handles = {
        column: {
          left: Math.round((boxes.columns.left + boxes.columns.right) / 2 - HANDLE_SIZE.column.width / 2 - origin.left),
          top: Math.round(boxes.columns.top - HANDLE_SIZE.column.height - HANDLE_GAP - origin.top),
        },
        row: {
          // Kept inside the shell, so a table filling the width never gets a sideways scrollbar from it.
          left: Math.round(Math.min(boxes.rows.right + HANDLE_GAP - origin.left, shell.clientWidth - HANDLE_SIZE.row.width - HANDLE_GAP)),
          top: Math.round((boxes.rows.top + boxes.rows.bottom) / 2 - HANDLE_SIZE.row.height / 2 - origin.top),
        },
      }
      setHandles((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    const placeSoon = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(place)
    }
    place()
    // Re-place after every edit (typing, a column resize) and every size change (window expand, reflow).
    const offUpdate = editor.registerUpdateListener(placeSoon)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(placeSoon) : null
    observer?.observe(shell)
    const table = editor.getElementByKey(target.tableKey)
    if (table) observer?.observe(table)
    window.addEventListener('resize', placeSoon)
    return () => {
      cancelAnimationFrame(frame)
      offUpdate()
      observer?.disconnect()
      window.removeEventListener('resize', placeSoon)
    }
  }, [editor, show, target, shell])

  // Right-click (or the context-menu key) in a table: the row / column menu.
  useEffect(
    () =>
      editor.registerRootListener((root, previous) => {
        const onContextMenu = (event: MouseEvent) => {
          if (!editor.isEditable()) return
          const element = event.target instanceof Element ? event.target : null
          const hit = element?.closest('td, th')
          const cellElement = hit && root?.contains(hit) ? hit : null
          // The context-menu key and Shift+F10 fire on the focused body itself; a mouse fires on what's under it.
          const fromKeyboard = element === root
          if (!cellElement && !fromKeyboard) return
          let opened: TableTarget | null = null
          editor.update(
            () => {
              const current = $selectionTarget()
              if (fromKeyboard) {
                opened = current
                return
              }
              const cell = cellElement ? $getNearestNodeFromDOMNode(cellElement) : null
              const tableCell = cell ? $getTableCellNodeFromLexicalNode(cell) : null
              if (!tableCell) return
              // Right-clicking inside the selected cells keeps them, so several rows or columns go at once.
              const selection = $getSelection()
              if (current && $isTableSelection(selection) && selection.getNodes().some((node) => node.is(tableCell))) {
                opened = current
                return
              }
              if (!current || current.anchorKey !== tableCell.getKey() || current.focusKey !== tableCell.getKey()) tableCell.selectEnd()
              opened = $targetFrom(tableCell, tableCell, false)
            },
            { discrete: true },
          )
          const found = opened as TableTarget | null
          if (!found) return
          event.preventDefault()
          let left = event.clientX
          let top = event.clientY
          if (fromKeyboard || (left === 0 && top === 0)) {
            const rect = editor.getElementByKey(found.focusKey)?.getBoundingClientRect()
            left = rect?.left ?? 8
            top = rect?.bottom ?? 8
          }
          setMenu({ kind: 'context', anchor: { left, top, right: left, bottom: top }, target: found })
        }
        previous?.removeEventListener('contextmenu', onContextMenu)
        root?.addEventListener('contextmenu', onContextMenu)
        return () => root?.removeEventListener('contextmenu', onContextMenu)
      }),
    [editor],
  )

  const close = useCallback(
    (refocusEditor: boolean) => {
      setMenu(null)
      if (refocusEditor) editor.focus()
    },
    [editor],
  )

  const act = (action: TableAction, of: TableTarget) => {
    setMenu(null)
    editor.update(() => {
      if (!$selectTarget(of)) return
      // Inserts go beside the whole selection: above its first row, below its last, and so on.
      if (action === 'row-above') $insertTableRowAtSelection(false)
      else if (action === 'row-below') $insertTableRowAtSelection(true)
      else if (action === 'column-left') $insertTableColumnAtSelection(false)
      else if (action === 'column-right') $insertTableColumnAtSelection(true)
      else if (action === 'delete-row') $deleteTableRowAtSelection()
      else $deleteTableColumnAtSelection()
    })
    editor.focus()
  }

  const setFormat = (format: EmailTableFormat, of: TableTarget) => {
    setMenu(null)
    editor.update(() => {
      const table = $getNodeByKey(of.tableKey)
      if ($isTableNode(table) && $getTableFormat(table) !== format) $setTableFormat(table, format)
    })
    editor.focus()
  }

  const open = (kind: HandleKind, button: HTMLButtonElement) => {
    if (!target) return
    if (menu?.kind === kind) {
      close(true)
      return
    }
    const rect = button.getBoundingClientRect()
    setMenu({ kind, anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, target })
  }

  const handle = (kind: HandleKind) => {
    const at = handles?.[kind]
    if (!at || !target) return null
    const count = kind === 'column' ? target.columns : target.rows
    const size = HANDLE_SIZE[kind]
    const name = kind === 'column' ? 'Column' : 'Row'
    return (
      <button
        type="button"
        className={styles.tableHandle}
        style={{ left: at.left, top: at.top, width: size.width, height: size.height }}
        aria-label={count === 1 ? `${name} options` : `Options for ${count} ${kind}s`}
        aria-haspopup="menu"
        aria-expanded={menu?.kind === kind}
        title={`${name} options`}
        // Keep the cursor in the body, so the column or row stays selected.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => open(kind, event.currentTarget)}
      >
        <svg
          aria-hidden="true"
          width={kind === 'column' ? 14 : 4}
          height={kind === 'column' ? 4 : 14}
          viewBox={kind === 'column' ? '0 0 14 4' : '0 0 4 14'}
          fill="currentColor"
        >
          {[2, 7, 12].map((dot) => (kind === 'column' ? <circle key={dot} cx={dot} cy="2" r="1.5" /> : <circle key={dot} cx="2" cy={dot} r="1.5" />))}
        </svg>
      </button>
    )
  }

  return (
    <>
      {handles && shell
        ? createPortal(
            <div ref={handlesRef} className={styles.tableHandles}>
              {handle('column')}
              {handle('row')}
            </div>,
            shell,
          )
        : null}
      {menu ? createPortal(<TableMenu menu={menu} keepOpenFor={handlesRef} onClose={close} onAction={act} onFormat={setFormat} />, document.body) : null}
    </>
  )
}
