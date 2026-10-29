'use client'

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection'
import {
  $applyNodeReplacement,
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  mergeRegister,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import styles from './ComposeWindow.module.css'

/**
 * An image inside the Mail editor's body. Pasted/inserted images are held as
 * data: URLs (turned into cid: inline parts when the email is sent, see
 * src/lib/mail/compose-html.ts); images pasted from web pages keep their
 * https URL. Any other src (javascript:, http:, other data: types) is dropped.
 *
 * Click an image to select it; drag any of its four corner handles to
 * resize it (the width is kept, height follows the aspect ratio) and
 * Delete/Backspace removes it.
 *
 * Images the user pastes or inserts into the email get a soft drop shadow
 * (`shadow`), an inline style in the editor and drafts; on Send and Schedule
 * it is drawn into the image itself (email-image-bake.ts), because Gmail strips
 * box-shadow and Outlook ignores it. These images are
 * the ones the compose window's "- image" / "+ image" buttons resize. Images
 * that arrive in loaded HTML (a quoted email, a forwarded message) keep their
 * own look unless they already carry the shadow style (a saved draft).
 */

const SAFE_SRC_RE = /^(https:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/i
const MAX_WIDTH = 2000
/** Smallest width the resize handle allows. */
export const MIN_IMAGE_WIDTH = 40

/** The pasted-image shadow in the editor and drafts; email-image-bake.ts draws the same shadow into sent images. */
export const IMAGE_SHADOW = '0 1px 3px rgba(0,0,0,0.12), 0 4px 14px rgba(0,0,0,0.18)'
/** How much one "- image" / "+ image" press changes each pasted image. */
export const IMAGE_SCALE_STEP = 0.1

/** Width while dragging the handle: never narrower than the minimum or wider than the body. */
export function clampImageWidth(width: number, maxWidth: number): number {
  const max = Math.max(MIN_IMAGE_WIDTH, Math.min(maxWidth, MAX_WIDTH))
  return Math.round(Math.min(Math.max(width, MIN_IMAGE_WIDTH), max))
}

export type ImageCorner = 'nw' | 'ne' | 'sw' | 'se'
export const IMAGE_CORNERS: readonly ImageCorner[] = ['nw', 'ne', 'sw', 'se']

/**
 * New width after dragging a corner `dx` pixels. Right corners grow the image
 * when dragged right, left corners when dragged left; height follows the
 * aspect ratio.
 */
export function resizedImageWidth(startWidth: number, dx: number, corner: ImageCorner, maxWidth: number): number {
  const grow = corner === 'ne' || corner === 'se' ? dx : -dx
  return clampImageWidth(startWidth + grow, maxWidth)
}

/** Width after one "- image" (-1) or "+ image" (+1) press: 10% of its shown width, within the body. */
export function steppedImageWidth(shownWidth: number, direction: 1 | -1, maxWidth: number): number {
  return clampImageWidth(shownWidth * (1 + direction * IMAGE_SCALE_STEP), maxWidth)
}

/**
 * An image's width in CSS pixels, the unit its width attribute uses. The admin
 * renders at `zoom: 0.9` (custom.scss), and getBoundingClientRect reports the
 * zoomed size (a 300px image measures 270), so it must not be used for widths.
 */
export function imageCssWidth(img: HTMLImageElement): number {
  return img.offsetWidth || img.getBoundingClientRect().width
}

/** Page zoom applied to an element (1 without CSS zoom); turns pointer movement into CSS pixels. */
function cssZoom(element: Element): number {
  const zoom = (element as Element & { currentCSSZoom?: number }).currentCSSZoom
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

/** The body's content width (padding excluded), so an image can't be dragged wider than the email. */
export function bodyContentWidth(root: HTMLElement | null): number {
  if (!root || root.clientWidth <= 0) return MAX_WIDTH
  const style = window.getComputedStyle(root)
  const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
  return root.clientWidth - (Number.isFinite(padding) ? padding : 0)
}

function EmailImageView({
  nodeKey,
  src,
  alt,
  width,
  shadow,
}: {
  nodeKey: NodeKey
  src: string
  alt: string
  width: number | null
  shadow: boolean
}) {
  const [editor] = useLexicalComposerContext()
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey)
  const imgRef = useRef<HTMLImageElement>(null)
  // Width while the handle is dragged; written to the node on release (one undo step).
  const [dragWidth, setDragWidth] = useState<number | null>(null)

  const removeIfSelected = useCallback(
    (event: KeyboardEvent | null) => {
      const selection = $getSelection()
      if (!isSelected || !$isNodeSelection(selection)) return false
      event?.preventDefault()
      const node = $getNodeByKey(nodeKey)
      if ($isEmailImageNode(node)) node.remove()
      return true
    },
    [isSelected, nodeKey],
  )

  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          CLICK_COMMAND,
          (event) => {
            if (event.target !== imgRef.current) return false
            if (!event.shiftKey) clearSelection()
            setSelected(true)
            return true
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(KEY_DELETE_COMMAND, removeIfSelected, COMMAND_PRIORITY_LOW),
        editor.registerCommand(KEY_BACKSPACE_COMMAND, removeIfSelected, COMMAND_PRIORITY_LOW),
      ),
    [editor, clearSelection, setSelected, removeIfSelected],
  )

  // Native listeners on the handles: Lexical's own listeners on the editable root see
  // events before React's, and would turn a drag on a handle into a text selection.
  const frameRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !isSelected) return
    const handles = Array.from(frame.querySelectorAll<HTMLElement>('[data-corner]'))
    const swallow = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }
    const start = (event: PointerEvent) => {
      const img = imgRef.current
      const handle = event.currentTarget as HTMLElement
      if (!img) return
      swallow(event)
      handle.setPointerCapture?.(event.pointerId)
      const corner = handle.dataset.corner as ImageCorner
      const startX = event.clientX
      const startWidth = imageCssWidth(img)
      // Pointer positions are zoomed screen pixels; widths are CSS pixels.
      const zoom = cssZoom(img)
      const maxWidth = bodyContentWidth(editor.getRootElement())
      let latest = startWidth
      const move = (e: PointerEvent) => {
        latest = resizedImageWidth(startWidth, (e.clientX - startX) / zoom, corner, maxWidth)
        setDragWidth(latest)
      }
      const up = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
        setDragWidth(null)
        editor.update(() => {
          const node = $getNodeByKey(nodeKey)
          if ($isEmailImageNode(node)) node.setWidth(latest)
        })
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    }
    for (const handle of handles) {
      handle.addEventListener('pointerdown', start)
      handle.addEventListener('mousedown', swallow)
      handle.addEventListener('click', swallow)
    }
    return () => {
      for (const handle of handles) {
        handle.removeEventListener('pointerdown', start)
        handle.removeEventListener('mousedown', swallow)
        handle.removeEventListener('click', swallow)
      }
    }
  }, [editor, isSelected, nodeKey])

  const shownWidth = dragWidth ?? width
  const editable = editor.isEditable()
  return (
    <span ref={frameRef} className={`${styles.imageFrame} ${isSelected ? styles.imageSelected : ''}`}>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        width={shownWidth ?? undefined}
        draggable={false}
        title={editable && !isSelected ? 'Click to resize' : undefined}
        style={{ maxWidth: '100%', height: 'auto', display: 'block', ...(shadow ? { boxShadow: IMAGE_SHADOW } : {}) }}
      />
      {isSelected && editable
        ? IMAGE_CORNERS.map((corner) => (
            <span
              key={corner}
              data-corner={corner}
              className={`${styles.imageHandle} ${styles[`imageHandle_${corner}`] ?? ''}`}
              role="presentation"
              title="Drag to resize"
            />
          ))
        : null}
      {dragWidth !== null ? <span className={styles.imageSize}>{dragWidth}px</span> : null}
    </span>
  )
}

export type SerializedEmailImageNode = Spread<
  { src: string; alt: string; width: number | null; shadow?: boolean },
  SerializedLexicalNode
>

export function isSafeEmailImageSrc(src: string): boolean {
  return SAFE_SRC_RE.test(src.trim())
}

function parseWidth(value: string | null): number | null {
  const width = Number.parseInt(value ?? '', 10)
  return Number.isFinite(width) && width > 0 ? Math.min(width, MAX_WIDTH) : null
}

function convertImageElement(domNode: HTMLElement): DOMConversionOutput {
  const src = domNode.getAttribute('src') ?? ''
  if (!isSafeEmailImageSrc(src)) return { node: null }
  return {
    node: $createEmailImageNode(src.trim(), domNode.getAttribute('alt') ?? '', parseWidth(domNode.getAttribute('width')), {
      // A saved draft's pasted image comes back with its shadow (and stays resizable as one).
      shadow: /box-shadow\s*:/i.test(domNode.getAttribute('style') ?? ''),
    }),
  }
}

export class EmailImageNode extends DecoratorNode<JSX.Element> {
  __src: string
  __alt: string
  __width: number | null
  __shadow: boolean

  static getType(): string {
    return 'email-image'
  }

  static clone(node: EmailImageNode): EmailImageNode {
    return new EmailImageNode(node.__src, node.__alt, node.__width, node.__shadow, node.__key)
  }

  constructor(src: string, alt: string, width: number | null, shadow = false, key?: NodeKey) {
    super(key)
    this.__src = src
    this.__alt = alt
    this.__width = width
    this.__shadow = shadow
  }

  static importJSON(serialized: SerializedEmailImageNode): EmailImageNode {
    return $createEmailImageNode(serialized.src, serialized.alt, serialized.width, { shadow: serialized.shadow === true })
  }

  exportJSON(): SerializedEmailImageNode {
    return { ...super.exportJSON(), type: 'email-image', version: 1, src: this.__src, alt: this.__alt, width: this.__width, shadow: this.__shadow }
  }

  static importDOM(): DOMConversionMap | null {
    return { img: () => ({ conversion: convertImageElement, priority: 0 }) }
  }

  exportDOM(): DOMExportOutput {
    const img = document.createElement('img')
    // src first: compose-html.ts matches `src="data:..."` in this output.
    img.setAttribute('src', this.__src)
    img.setAttribute('alt', this.__alt)
    if (this.__width) img.setAttribute('width', String(this.__width))
    img.setAttribute('style', `max-width:100%;height:auto;${this.__shadow ? `box-shadow:${IMAGE_SHADOW};` : ''}`)
    return { element: img }
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.style.display = 'inline-block'
    span.style.maxWidth = '100%'
    return span
  }

  updateDOM(): false {
    return false
  }

  isInline(): boolean {
    return true
  }

  getSrc(): string {
    return this.getLatest().__src
  }

  /** Pasted or inserted by the user (shown with a shadow, resized by "- image" / "+ image"). */
  hasShadow(): boolean {
    return this.getLatest().__shadow
  }

  getWidth(): number | null {
    return this.getLatest().__width
  }

  setWidth(width: number | null): this {
    const writable = this.getWritable()
    writable.__width = width === null ? null : Math.min(Math.max(Math.round(width), 1), MAX_WIDTH)
    return writable
  }

  decorate(): JSX.Element {
    return <EmailImageView nodeKey={this.getKey()} src={this.__src} alt={this.__alt} width={this.__width} shadow={this.__shadow} />
  }
}

export function $createEmailImageNode(
  src: string,
  alt: string,
  width: number | null,
  options: { shadow?: boolean } = {},
): EmailImageNode {
  return $applyNodeReplacement(new EmailImageNode(src, alt, width, options.shadow === true))
}

export function $isEmailImageNode(node: LexicalNode | null | undefined): node is EmailImageNode {
  return node instanceof EmailImageNode
}
