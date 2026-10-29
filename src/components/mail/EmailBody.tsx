'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Renders one email's HTML the way Gmail does, inside a locked-down iframe.
 *
 * Security: `sandbox` deliberately omits `allow-scripts`, so nothing in the
 * email can run, and the document carries its own CSP (see
 * src/lib/mail/email-html.ts). `allow-same-origin` is only there so this
 * component can measure the height and fix up links; without `allow-scripts`
 * the email itself still cannot execute anything. Links open in a new tab with
 * no opener or referrer.
 */
export default function EmailBody({ html, title }: { html: string; title: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [height, setHeight] = useState(200)

  /**
   * Size the frame to the email's own content. The frame is collapsed while
   * measuring: the document's scrollHeight is never less than the frame, and
   * emails sized to it (height:100%, 100vh) would otherwise grow the frame on
   * every refit, leaving a long empty area to scroll through below the email.
   * The wrapper keeps its height meanwhile, so the reading pane's scroll
   * position never moves.
   */
  const fit = useCallback(() => {
    const frame = frameRef.current
    const doc = frame?.contentDocument
    const wrap = wrapRef.current
    if (!frame || !doc?.documentElement || !wrap) return
    const root = doc.documentElement
    const shown = frame.style.height
    wrap.style.minHeight = `${frame.offsetHeight}px`
    frame.style.height = '0px'
    root.style.transform = ''
    root.style.overflow = ''
    // Emails built for a fixed desktop width (often 600px) would scroll sideways
    // inside a small box on a phone; shrink them to fit, as Gmail's app does.
    const available = root.clientWidth
    const scale = available > 0 && root.scrollWidth > available + 1 ? available / root.scrollWidth : 1
    const next = Math.max(60, Math.ceil(root.scrollHeight * scale) + 4)
    if (scale < 1) {
      root.style.transformOrigin = '0 0'
      root.style.transform = `scale(${scale})`
      // The unscaled layout box is still full size; it is not content.
      root.style.overflow = 'hidden'
    }
    frame.style.height = shown
    wrap.style.minHeight = ''
    setHeight(next)
  }, [])

  const onLoad = useCallback(() => {
    const doc = frameRef.current?.contentDocument
    if (!doc) return
    // Full-height templates (html,body{height:100%}) would size the email to the
    // frame instead of to its content; in the reading pane it flows like a page.
    const fitStyle = doc.createElement('style')
    fitStyle.textContent = 'html,body{height:auto !important;min-height:0 !important;}'
    doc.head?.append(fitStyle)
    doc.querySelectorAll('a[href]').forEach((anchor) => {
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noopener noreferrer')
    })
    fit()
    // Images and fonts load after the document; refit whenever the body resizes.
    observerRef.current?.disconnect()
    if (doc.body && typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver(fit)
      observerRef.current.observe(doc.body)
    }
  }, [fit])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  return (
    <div ref={wrapRef}>
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={html}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      style={{ width: '100%', height, border: 0, display: 'block', background: '#fff', borderRadius: 4 }}
    />
    </div>
  )
}
