'use client'

import type { JSX } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $applyNodeReplacement,
  $getNodeByKey,
  DecoratorNode,
  type DOMConversionMap,
  type DOMExportOutput,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import EmailBody from './EmailBody'
import { buildEmailDocument, sanitizeEmailHtml } from '@/lib/mail/email-html'
import { PRESERVED_HTML_ATTR } from '@/lib/mail/preserved-html'
import styles from './ComposeWindow.module.css'

/**
 * A report block in the Mail editor (see src/lib/mail/preserved-html.ts):
 * shown as it will be sent, and sent exactly as loaded. It can be removed but
 * not edited here, because the editor can't hold its layout.
 */

type SerializedEmailHtmlBlockNode = Spread<{ html: string }, SerializedLexicalNode>

function EmailHtmlBlockView({ nodeKey, html }: { nodeKey: NodeKey; html: string }) {
  const [editor] = useLexicalComposerContext()
  return (
    <div className={styles.preservedBlock} contentEditable={false}>
      <div className={styles.preservedBlockBar}>
        <span>Report section, sent exactly as shown (edit the text around it)</span>
        <button
          type="button"
          onClick={() =>
            editor.update(() => {
              const node = $getNodeByKey(nodeKey)
              if ($isEmailHtmlBlockNode(node)) node.remove()
            })
          }
          aria-label="Remove this report section"
          title="Remove this report section from the email"
        >
          Remove
        </button>
      </div>
      {/* Laid out as Gmail shows it: words in table headers never break mid-word. */}
      <EmailBody html={buildEmailDocument(html, { breakAnywhere: false })} title="Report section" />
    </div>
  )
}

export class EmailHtmlBlockNode extends DecoratorNode<JSX.Element> {
  __html: string

  static getType(): string {
    return 'email-html-block'
  }

  static clone(node: EmailHtmlBlockNode): EmailHtmlBlockNode {
    return new EmailHtmlBlockNode(node.__html, node.__key)
  }

  constructor(html: string, key?: NodeKey) {
    super(key)
    // Untrusted email HTML: active content is removed before it is kept or shown.
    this.__html = sanitizeEmailHtml(html)
  }

  static importJSON(serialized: SerializedEmailHtmlBlockNode): EmailHtmlBlockNode {
    return $createEmailHtmlBlockNode(serialized.html)
  }

  exportJSON(): SerializedEmailHtmlBlockNode {
    return { ...super.exportJSON(), type: 'email-html-block', version: 1, html: this.__html }
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (element: HTMLElement) =>
        element.hasAttribute(PRESERVED_HTML_ATTR)
          ? {
              priority: 4,
              conversion: (div: HTMLElement) => ({ node: $createEmailHtmlBlockNode(div.innerHTML), after: () => [] }),
            }
          : null,
    }
  }

  exportDOM(): DOMExportOutput {
    const wrapper = document.createElement('div')
    wrapper.setAttribute(PRESERVED_HTML_ATTR, '1')
    wrapper.innerHTML = this.__html
    return { element: wrapper }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    // Payload's admin CSS sizes every Lexical decorator to fit-content, which
    // leaves the preview iframe (width:100%) at its 300px default and squeezes
    // the report. The block takes the editor's full width, as the email does.
    div.style.width = '100%'
    return div
  }

  updateDOM(): false {
    return false
  }

  isInline(): false {
    return false
  }

  getTextContent(): string {
    // Lets the compose window see the body is not empty; never edited as text.
    return new DOMParser().parseFromString(this.__html, 'text/html').body.textContent ?? ''
  }

  decorate(): JSX.Element {
    return <EmailHtmlBlockView nodeKey={this.getKey()} html={this.__html} />
  }
}

export function $createEmailHtmlBlockNode(html: string): EmailHtmlBlockNode {
  return $applyNodeReplacement(new EmailHtmlBlockNode(html))
}

export function $isEmailHtmlBlockNode(node: LexicalNode | null | undefined): node is EmailHtmlBlockNode {
  return node instanceof EmailHtmlBlockNode
}
