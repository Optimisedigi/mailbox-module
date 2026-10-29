'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { EmailListType, EmailSelectionFormat } from './RichEmailEditor'
import styles from './ComposeWindow.module.css'

/**
 * Gmail-style formatting buttons, in the compose tool row next to Insert
 * table: text colour (a palette popover with Gmail's colours), numbered list
 * and bulleted list. There is no font or size control on purpose: the body is
 * always Verdana, Normal.
 *
 * Buttons keep the editor's selection by not taking focus on mousedown. The
 * palette is portalled to <body> above the button, because the tool row
 * scrolls sideways on phones and would clip it.
 */

/** Gmail's text colour palette, row by row (greys first). */
export const GMAIL_TEXT_COLORS: readonly string[] = [
  '#000000',
  '#444444',
  '#666666',
  '#999999',
  '#cccccc',
  '#eeeeee',
  '#f3f3f3',
  '#ffffff',
  '#ff0000',
  '#ff9900',
  '#ffff00',
  '#00ff00',
  '#00ffff',
  '#0000ff',
  '#9900ff',
  '#ff00ff',
  '#f4cccc',
  '#fce5cd',
  '#fff2cc',
  '#d9ead3',
  '#d0e0e3',
  '#cfe2f3',
  '#d9d2e9',
  '#ead1dc',
  '#ea9999',
  '#f9cb9c',
  '#ffe599',
  '#b6d7a8',
  '#a2c4c9',
  '#9fc5e8',
  '#b4a7d6',
  '#d5a6bd',
  '#e06666',
  '#f6b26b',
  '#ffd966',
  '#93c47d',
  '#76a5af',
  '#6fa8dc',
  '#8e7cc3',
  '#c27ba0',
  '#cc0000',
  '#e69138',
  '#f1c232',
  '#6aa84f',
  '#45818e',
  '#3d85c6',
  '#674ea7',
  '#a64d79',
  '#990000',
  '#b45f06',
  '#bf9000',
  '#38761d',
  '#134f5c',
  '#0b5394',
  '#351c75',
  '#741b47',
  '#660000',
  '#783f04',
  '#7f6000',
  '#274e13',
  '#0c343d',
  '#073763',
  '#20124d',
  '#4c1130',
]

const BULLET_ICON =
  'M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z'
const NUMBER_ICON =
  'M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14V5H7zm0 14h14v-2H7v2zm0-6h14v-2H7v2z'

const keepEditorFocus = (event: React.MouseEvent) => event.preventDefault()

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d={path} fill="currentColor" />
    </svg>
  )
}

interface Props {
  format: EmailSelectionFormat
  disabled: boolean
  onColor: (color: string | null) => void
  onList: (type: EmailListType) => void
}

export default function FormatBar({ format, disabled, onColor, onList }: Props) {
  const [colorOpen, setColorOpen] = useState(false)
  const colorRef = useRef<HTMLDivElement>(null)
  const paletteRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)

  const toggleColor = () => {
    const rect = colorRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ left: Math.max(8, rect.left), bottom: window.innerHeight - rect.top + 4 })
    setColorOpen((open) => !open)
  }

  useEffect(() => {
    if (!colorOpen) return
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (!colorRef.current?.contains(target) && !paletteRef.current?.contains(target))
        setColorOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setColorOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [colorOpen])

  const choose = (color: string | null) => {
    onColor(color)
    setColorOpen(false)
  }

  return (
    <div className={styles.formatBar} role="toolbar" aria-label="Formatting">
      <div className={styles.colorPicker} ref={colorRef}>
        <button
          type="button"
          className={styles.formatButton}
          onMouseDown={keepEditorFocus}
          onClick={toggleColor}
          aria-haspopup="dialog"
          aria-expanded={colorOpen}
          aria-label="Text colour"
          title="Text colour"
          disabled={disabled}
        >
          <span className={styles.colorGlyph}>
            A
            <span
              className={styles.colorSwatchBar}
              style={{ background: format.color ?? '#222222' }}
            />
          </span>
          <span aria-hidden="true" className={styles.caret}>
            ▾
          </span>
        </button>
        {colorOpen && anchor
          ? createPortal(
              <div
                ref={paletteRef}
                className={styles.colorPalette}
                role="dialog"
                aria-label="Text colour"
                style={{ left: anchor.left, bottom: anchor.bottom }}
              >
                <button
                  type="button"
                  className={styles.colorDefault}
                  onMouseDown={keepEditorFocus}
                  onClick={() => choose(null)}
                >
                  Default colour
                </button>
                <div className={styles.colorGrid}>
                  {GMAIL_TEXT_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={styles.colorCell}
                      style={{ background: color }}
                      onMouseDown={keepEditorFocus}
                      onClick={() => choose(color)}
                      aria-label={`Colour ${color}`}
                      aria-pressed={format.color?.toLowerCase() === color}
                      title={color}
                    />
                  ))}
                </div>
              </div>,
              document.body,
            )
          : null}
      </div>
      <button
        type="button"
        className={styles.formatButton}
        onMouseDown={keepEditorFocus}
        onClick={() => onList('number')}
        aria-pressed={format.list === 'number'}
        aria-label="Numbered list"
        title="Numbered list"
        disabled={disabled}
      >
        <Icon path={NUMBER_ICON} />
      </button>
      <button
        type="button"
        className={styles.formatButton}
        onMouseDown={keepEditorFocus}
        onClick={() => onList('bullet')}
        aria-pressed={format.list === 'bullet'}
        aria-label="Bulleted list"
        title="Bulleted list"
        disabled={disabled}
      >
        <Icon path={BULLET_ICON} />
      </button>
    </div>
  )
}
