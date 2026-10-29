'use client'

import { useEffect, useState, type RefObject } from 'react'

export const MOBILE_MAX_WIDTH = 900

export type SwipePoint = { x: number; y: number; t: number }

export type SwipeOptions = {
  /** Only start a swipe within this many px of the left edge (0 = anywhere). */
  edgeZone?: number
  minDistance?: number
  maxDuration?: number
  /**
   * Ignore swipes that start inside something that scrolls sideways (a
   * toolbar row, a wide table), so scrolling it never counts as going back.
   */
  ignoreHorizontalScrollers?: boolean
}

/** True if `target`, or an ancestor up to `root`, can scroll sideways. */
export function inHorizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
  let node = target instanceof Element ? target : null
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 1) {
      const overflowX = window.getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') return true
    }
    node = node.parentElement
  }
  return false
}

/**
 * Decide whether a touch from `start` to `end` is a deliberate swipe-right
 * (go back). It must be mostly horizontal, long enough and quick enough, so
 * vertical scrolling and slow drags never trigger it.
 */
export function isSwipeBack(start: SwipePoint, end: SwipePoint, opts: SwipeOptions = {}): boolean {
  const { edgeZone = 0, minDistance = 70, maxDuration = 800 } = opts
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (edgeZone > 0 && start.x > edgeZone) return false
  if (dx < minDistance) return false
  if (Math.abs(dx) < Math.abs(dy) * 1.5) return false
  if (end.t - start.t > maxDuration) return false
  return true
}

/** True while the viewport is at or below the mobile breakpoint. */
export function useIsMobileViewport(maxWidth = MOBILE_MAX_WIDTH): boolean {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`)
    const update = () => setMobile(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [maxWidth])
  return mobile
}

/** Calls `onBack` when the user swipes right on the referenced element. */
export function useSwipeBack(
  ref: RefObject<HTMLElement | null>,
  onBack: () => void,
  enabled: boolean,
  opts: SwipeOptions = {},
) {
  const { edgeZone, minDistance, maxDuration, ignoreHorizontalScrollers = false } = opts
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    let start: SwipePoint | null = null
    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0]
      start =
        touch && e.touches.length === 1 && !(ignoreHorizontalScrollers && inHorizontalScroller(e.target, el))
          ? { x: touch.clientX, y: touch.clientY, t: Date.now() }
          : null
    }
    const onEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0]
      if (!start || !touch) return
      const end = { x: touch.clientX, y: touch.clientY, t: Date.now() }
      const s = start
      start = null
      if (isSwipeBack(s, end, { edgeZone, minDistance, maxDuration })) onBack()
    }
    const onCancel = () => {
      start = null
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onCancel)
    }
  }, [ref, onBack, enabled, edgeZone, minDistance, maxDuration, ignoreHorizontalScrollers])
}
