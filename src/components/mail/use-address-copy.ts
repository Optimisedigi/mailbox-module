'use client'

import { useEffect, useRef, useState } from 'react'

const COPIED_PILL_MS = 1000

/** Where the pill sits along the double-clicked row, kept inside the row. */
export function pillLeft(box: DOMRect, clientX: number): number {
  const raw = clientX - box.left
  return box.width > 0 ? Math.min(Math.max(raw, 28), Math.max(28, box.width - 28)) : raw
}

/**
 * Copy an address and show one "Copied" pill. A later copy that fails still
 * lets the pill that is on screen fade out; only that pill's own id clears it.
 */
export function useAddressCopy() {
  const [copied, setCopied] = useState<{ id: number; left: number } | null>(null)
  const copySeq = useRef(0)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    }
  }, [])

  const copyAddress = (email: string, left: number) => {
    const write = navigator.clipboard?.writeText.bind(navigator.clipboard)
    if (!write) return
    const seq = ++copySeq.current
    void write(email).then(
      () => {
        if (!alive.current || seq !== copySeq.current) return
        setCopied({ id: seq, left })
        if (copiedTimer.current) clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => {
          setCopied((current) => (current?.id === seq ? null : current))
        }, COPIED_PILL_MS)
      },
      () => {},
    )
  }

  return { copied, copyAddress }
}
