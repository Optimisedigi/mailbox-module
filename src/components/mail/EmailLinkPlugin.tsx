'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_DOWN_COMMAND,
  type LexicalNode,
  type RangeSelection,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createLinkNode, $isLinkNode, $toggleLink, formatUrl, type LinkNode } from '@lexical/link'
import styles from './ComposeWindow.module.css'

/**
 * Cmd/Ctrl+K in the email body: a small box asks for a link and the selected
 * text becomes a hyperlink to it (Gmail's shortcut). With the cursor in a link
 * it edits or removes that link; with nothing selected the link is inserted
 * with its address as the text. Only http(s), mailto and tel links are
 * accepted; "example.com" becomes https://example.com and an email address
 * becomes mailto:.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** The link to store for what was typed, or null when it is not a usable email link. */
export function normalizeEmailLinkUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  const url = formatUrl(trimmed)
  try {
    const parsed = new URL(url)
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.hostname.includes('.')) return null
    return url
  } catch {
    return null
  }
}

function $linkOf(node: LexicalNode): LinkNode | null {
  for (let current: LexicalNode | null = node; current; current = current.getParent()) {
    if ($isLinkNode(current)) return current
  }
  return null
}

/** The link the whole selection sits in, if any. */
function $selectedLink(selection: RangeSelection): LinkNode | null {
  const anchor = $linkOf(selection.anchor.getNode())
  const focus = $linkOf(selection.focus.getNode())
  return anchor && focus && anchor.is(focus) ? anchor : null
}

interface Dialog {
  left: number
  top: number
  existingUrl: string | null
}

function selectionRect(root: HTMLElement | null): { left: number; bottom: number } {
  const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null
  const rect = range?.getBoundingClientRect()
  if (rect && (rect.width > 0 || rect.height > 0)) return { left: rect.left, bottom: rect.bottom }
  const box = root?.getBoundingClientRect()
  return { left: box?.left ?? 8, bottom: box?.top ?? 8 }
}

export function EmailLinkPlugin() {
  const [editor] = useLexicalComposerContext()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  const savedSelection = useRef<RangeSelection | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const open = useCallback(() => {
    const existingUrl = editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) return undefined
      savedSelection.current = selection.clone()
      return $selectedLink(selection)?.getURL() ?? null
    })
    if (existingUrl === undefined) return false
    const { left, bottom } = selectionRect(editor.getRootElement())
    const width = 320
    setDialog({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, bottom + 6),
      existingUrl,
    })
    setValue(existingUrl ?? '')
    setInvalid(false)
    return true
  }, [editor])

  const close = useCallback(() => {
    setDialog(null)
    savedSelection.current = null
    editor.focus()
  }, [editor])

  /** Restore the selection from when the box opened, if its text is still there. */
  const $restoreSelection = (): RangeSelection | null => {
    const saved = savedSelection.current
    if (saved && $getNodeByKey(saved.anchor.key) && $getNodeByKey(saved.focus.key)) $setSelection(saved.clone())
    const selection = $getSelection()
    return $isRangeSelection(selection) ? selection : null
  }

  const apply = () => {
    const url = normalizeEmailLinkUrl(value)
    if (!url) {
      setInvalid(true)
      return
    }
    editor.update(() => {
      const selection = $restoreSelection()
      if (!selection) return
      if (selection.isCollapsed() && !$selectedLink(selection)) {
        const link = $createLinkNode(url, { rel: 'noreferrer' })
        link.append($createTextNode(value.trim()))
        selection.insertNodes([link])
        link.selectEnd()
        return
      }
      $toggleLink(url)
    })
    close()
  }

  const remove = () => {
    editor.update(() => {
      const selection = $restoreSelection()
      if (!selection) return
      const link = $selectedLink(selection)
      if (selection.isCollapsed() && link) {
        // Cursor inside a link: unlink the whole link, keeping its text.
        for (const child of link.getChildren()) link.insertBefore(child)
        link.remove()
        return
      }
      $toggleLink(null)
    })
    close()
  }

  useEffect(
    () =>
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => {
          if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false
          if (!open()) return false
          event.preventDefault()
          return true
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, open],
  )

  useEffect(() => {
    if (!dialog) return
    inputRef.current?.focus()
    inputRef.current?.select()
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && boxRef.current?.contains(event.target)) return
      setDialog(null)
      savedSelection.current = null
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [dialog])

  if (!dialog) return null
  return createPortal(
    <div
      ref={boxRef}
      className={styles.linkDialog}
      role="dialog"
      aria-label="Add link"
      style={{ left: dialog.left, top: dialog.top }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          apply()
        }}
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="url"
          className={styles.linkInput}
          aria-label="Link address"
          aria-invalid={invalid}
          placeholder="Paste or type a link"
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setInvalid(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close()
            }
          }}
        />
        <button type="submit" className={styles.linkButton}>
          Apply
        </button>
        {dialog.existingUrl !== null ? (
          <button type="button" className={styles.linkButton} onClick={remove}>
            Remove
          </button>
        ) : null}
      </form>
      {invalid ? (
        <p role="alert" className={styles.linkError}>
          Enter a web address, email address or phone number.
        </p>
      ) : null}
    </div>,
    document.body,
  )
}
