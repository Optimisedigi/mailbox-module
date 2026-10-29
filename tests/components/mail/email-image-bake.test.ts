import { describe, expect, it, vi } from 'vitest'
import { deflateSync, inflateSync } from 'node:zlib'
import {
  BAKED_IMAGE_MAX_BYTES,
  bakeShadowedImages,
  encodeIndexedPng,
  encodeWithinBudget,
  quantizeToPalette,
  type RenderedFrame,
} from '@/components/mail/email-image-bake'

const deflate = async (bytes: Uint8Array) => new Uint8Array(deflateSync(bytes))

function rgbaOf(colors: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(colors.length * 4)
  colors.forEach((color, i) => out.set([(color >> 16) & 255, (color >> 8) & 255, color & 255, 255], i * 4))
  return out
}

function readChunks(png: Uint8Array): Map<string, Uint8Array> {
  const chunks = new Map<string, Uint8Array>()
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  for (let offset = 8; offset < png.length; ) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    chunks.set(type, png.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  return chunks
}

describe('quantizeToPalette', () => {
  it('keeps every colour exactly when there are 256 or fewer', () => {
    const colors = [0xffffff, 0x000000, 0x2c97c9, 0xffffff, 0x2c97c9]
    const result = quantizeToPalette(rgbaOf(colors))
    expect(result.exact).toBe(true)
    const rebuilt = [...result.indices].map((i) => (result.palette[i * 3]! << 16) | (result.palette[i * 3 + 1]! << 8) | result.palette[i * 3 + 2]!)
    expect(rebuilt).toEqual(colors)
  })

  it('reduces a many-colour image to at most 256 close colours', () => {
    const colors = Array.from({ length: 4096 }, (_, i) => (((i & 15) * 16) << 16) | ((((i >> 4) & 15) * 16) << 8) | (((i >> 8) & 15) * 16))
    const result = quantizeToPalette(rgbaOf(colors))
    expect(result.exact).toBe(false)
    expect(result.palette.length / 3).toBeLessThanOrEqual(256)
    const worst = colors.reduce((max, color, p) => {
      const i = result.indices[p]! * 3
      const diff = Math.abs(((color >> 16) & 255) - result.palette[i]!) + Math.abs(((color >> 8) & 255) - result.palette[i + 1]!) + Math.abs((color & 255) - result.palette[i + 2]!)
      return Math.max(max, diff)
    }, 0)
    expect(worst).toBeLessThan(120)
  })
})

describe('encodeIndexedPng', () => {
  it('writes a valid palette PNG whose pixels decode back to the indices', async () => {
    const indices = new Uint8Array([0, 1, 1, 0, 2, 2])
    const palette = new Uint8Array([255, 255, 255, 0, 0, 0, 44, 151, 201])
    const png = await encodeIndexedPng(3, 2, palette, indices, deflate)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const chunks = readChunks(png)
    expect([...chunks.keys()]).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND'])
    expect([...chunks.get('IHDR')!.subarray(8)]).toEqual([8, 3, 0, 0, 0])
    expect([...chunks.get('PLTE')!]).toEqual([...palette])
    expect([...inflateSync(chunks.get('IDAT')!)]).toEqual([0, 0, 1, 1, 0, 0, 2, 2])
  })
})

describe('encodeWithinBudget', () => {
  // A frame whose full-colour PNG costs `pngBytesPerPixel` per pixel; `colorCount` distinct colours.
  function renderer(colorCount: number, pngBytesPerPixel: number, base = 100) {
    const scales: number[] = []
    const render = vi.fn(async (scale: number): Promise<RenderedFrame> => {
      scales.push(scale)
      const width = Math.round(base * scale)
      const height = Math.round(base * scale)
      const colors = Array.from({ length: width * height }, (_, i) => (i * 7919) % colorCount)
      return { width, height, rgba: rgbaOf(colors), encodePng: async () => new Uint8Array(Math.round(width * height * pngBytesPerPixel)) }
    })
    return { render, scales }
  }

  it('sends a few-colour screenshot as an exact palette PNG at 2x', async () => {
    const { render, scales } = renderer(40, 4)
    const png = await encodeWithinBudget({ maxScale: 2, render, deflate })
    expect(scales).toEqual([2])
    expect(readChunks(png).get('IHDR')![9]).toBe(3)
  })

  it('keeps the full-colour PNG when it is under the limit', async () => {
    const { render } = renderer(5000, 1)
    const png = await encodeWithinBudget({ maxScale: 2, render, deflate })
    expect(png.length).toBe(200 * 200)
  })

  it('falls back to 256 colours, then a smaller size, but never below the shown size', async () => {
    const { render, scales } = renderer(5000, 4, 600)
    const png = await encodeWithinBudget({ maxScale: 2, render, deflate, maxBytes: 1 })
    expect(scales[0]).toBe(2)
    expect(scales.at(-1)).toBe(1)
    expect(scales.every((scale) => scale >= 1)).toBe(true)
    // Over the limit even at 1x: the smallest attempt is still returned, so sending is never blocked.
    expect(png.length).toBeGreaterThan(0)
    expect(BAKED_IMAGE_MAX_BYTES).toBe(200 * 1024)
  })
})

describe('bakeShadowedImages', () => {
  const shadowed = '<img src="data:image/png;base64,AAAA" alt="shot" width="400" style="max-width:100%;height:auto;box-shadow:0 1px 3px rgba(0,0,0,0.12), 0 4px 14px rgba(0,0,0,0.18);">'
  const plain = '<img src="data:image/png;base64,BBBB" alt="logo" width="100" style="max-width:100%;height:auto;">'
  const remote = '<img src="https://example.com/a.png" style="box-shadow:0 1px 3px #000;">'

  it('swaps only shadowed pasted images for their baked copy, wider and without the CSS shadow', async () => {
    const bake = vi.fn(async (_src: string, width: number) => ({ src: 'data:image/png;base64,BAKED', width: width + 28 }))
    const html = await bakeShadowedImages(`<p>See:</p>${shadowed}${plain}${remote}`, bake)
    expect(bake).toHaveBeenCalledTimes(1)
    expect(bake).toHaveBeenCalledWith('data:image/png;base64,AAAA', 400)
    expect(html).toContain('<img src="data:image/png;base64,BAKED" alt="shot" width="428" style="max-width:100%;height:auto;">')
    expect(html).toContain(plain)
    expect(html).toContain(remote)
  })

  it('keeps the CSS shadow when an image cannot be baked', async () => {
    expect(await bakeShadowedImages(shadowed, async () => null)).toBe(shadowed)
    expect(await bakeShadowedImages(shadowed, async () => { throw new Error('no canvas') })).toBe(shadowed)
  })
})
