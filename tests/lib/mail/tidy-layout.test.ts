import { describe, expect, it } from 'vitest'
import { columnWidths, estimateTextWidth, isGreetingLine, isTldrLine } from '@/lib/mail/tidy-layout'

describe('tidy layout rules', () => {
  it('recognises greetings and TL;DR lines, not sentences that start the same way', () => {
    for (const line of ['Hi Melissa,', 'Hi, Melissa.', 'Hello team', "G'day Sam,", 'Good morning Jo,', 'Dear Ms Lee,']) {
      expect(isGreetingLine(line)).toBe(true)
    }
    expect(isGreetingLine('Highlights from this month are below and they are worth reading carefully today.')).toBe(false)
    expect(isGreetingLine('History')).toBe(false)
    for (const line of ['TLDR;', 'TL;DR', 'tl;dr: we are on track', '**TLDR**']) expect(isTldrLine(line)).toBe(true)
    expect(isTldrLine('TLDRs are useful')).toBe(false)
  })

  it('makes each column as wide as its widest line, bold measured bold, within limits', () => {
    const widths = columnWidths(
      [
        [{ lines: ['Metric'], bold: true }, { lines: ['Average cost per click'], bold: false }],
        [{ lines: ['Total'], bold: true }, { lines: ['$4'], bold: false }],
        [{ lines: ['x'.repeat(200)], bold: false }],
        [{ lines: ['July', '(from 10th)'], bold: false }],
      ],
      estimateTextWidth,
    )
    // 22 chars × 8px = 176 → +10% +4
    expect(widths[0]).toBe(198)
    // "Total" in bold: 45 → 54; never below the minimum.
    expect(widths[1]).toBe(54)
    // A long cell wraps instead of stretching the table.
    expect(widths[2]).toBe(320)
    // Lines are measured separately.
    expect(widths[3]).toBe(Math.ceil(88 * 1.1) + 4)
  })
})
