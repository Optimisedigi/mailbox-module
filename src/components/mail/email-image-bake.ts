/**
 * Sending a pasted screenshot with its drop shadow drawn into the picture.
 *
 * The editor shows the shadow with CSS box-shadow, which Gmail strips and
 * Outlook for Windows ignores, so recipients never saw it. On Send/Schedule
 * each shadowed image is redrawn in the browser on a slightly larger white
 * canvas with the shadow painted in, and sent as a PNG (no JPEG: it blurs
 * text) aiming for BAKED_IMAGE_MAX_BYTES:
 *   1. at up to 2x its shown width (sharp on Retina screens);
 *   2. as an exact 256-colour PNG when it has that few colours (lossless),
 *      else full-colour PNG when that fits, else a 256-colour PNG;
 *   3. smaller (never below its shown size) only when still too big.
 * Everything runs in the browser: nothing is uploaded, stored or charged.
 */

/** The editor's CSS shadow, mirrored on the canvas (offset y and blur in CSS px). */
const SHADOW_LAYERS = [
  { offsetY: 1, blur: 3, color: 'rgba(0,0,0,0.12)' },
  { offsetY: 4, blur: 14, color: 'rgba(0,0,0,0.18)' },
] as const
/** Room around the image for the shadow, in CSS px. */
export const SHADOW_PAD = { side: 14, top: 10, bottom: 20 } as const
export const BAKED_IMAGE_MAX_BYTES = 200 * 1024
/** Pixels per CSS px: 2 keeps text sharp on Retina screens. */
const MAX_SCALE = 2
const SCALE_STEP = 0.85
/** Shown width when the image has no width attribute (the compose window's display width). */
const DEFAULT_DISPLAY_WIDTH = 600
const MAX_COLORS = 256

export interface RenderedFrame {
  width: number
  height: number
  /** RGBA pixels, row by row. */
  rgba: Uint8ClampedArray
  /** Full-colour PNG of the same pixels. */
  encodePng(): Promise<Uint8Array>
}

export type Deflate = (bytes: Uint8Array) => Promise<Uint8Array>

// ── 256-colour quantising (median cut) ──

export interface Quantized {
  /** RGB triplets, one per palette entry. */
  palette: Uint8Array
  /** One palette index per pixel. */
  indices: Uint8Array
  /** True when the image had no more than 256 colours, so nothing was lost. */
  exact: boolean
}

interface ColorBox {
  colors: number[]
  counts: Map<number, number>
  /** Widest channel range times pixel count: which box to split next (0 = cannot split). */
  score: number
}

function makeBox(colors: number[], counts: Map<number, number>): ColorBox {
  const box = { colors, counts, score: 0 }
  box.score = colors.length < 2 ? 0 : widestChannel(box).range * population(box)
  return box
}

const channel = (color: number, shift: number) => (color >> shift) & 0xff

function widestChannel(box: Pick<ColorBox, 'colors'>): { shift: number; range: number } {
  let best = { shift: 16, range: -1 }
  for (const shift of [16, 8, 0]) {
    let min = 255
    let max = 0
    for (const color of box.colors) {
      const value = channel(color, shift)
      if (value < min) min = value
      if (value > max) max = value
    }
    if (max - min > best.range) best = { shift, range: max - min }
  }
  return best
}

function population(box: Pick<ColorBox, 'colors' | 'counts'>): number {
  let total = 0
  for (const color of box.colors) total += box.counts.get(color) ?? 0
  return total
}

/** Split at the weighted median of the widest channel; null when the box is one colour. */
function splitBox(box: ColorBox): [ColorBox, ColorBox] | null {
  if (box.colors.length < 2) return null
  const { shift } = widestChannel(box)
  const sorted = [...box.colors].sort((a, b) => channel(a, shift) - channel(b, shift) || a - b)
  const half = population(box) / 2
  let running = 0
  let cut = 1
  for (let i = 0; i < sorted.length - 1; i++) {
    running += box.counts.get(sorted[i] ?? 0) ?? 0
    cut = i + 1
    if (running >= half) break
  }
  return [makeBox(sorted.slice(0, cut), box.counts), makeBox(sorted.slice(cut), box.counts)]
}

/** The image's colours as 24-bit numbers (alpha ignored: baked frames are opaque). */
function pixelColors(rgba: Uint8ClampedArray): Uint32Array {
  const out = new Uint32Array(rgba.length / 4)
  for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = ((rgba[i] ?? 0) << 16) | ((rgba[i + 1] ?? 0) << 8) | (rgba[i + 2] ?? 0)
  return out
}

export function quantizeToPalette(rgba: Uint8ClampedArray, maxColors = MAX_COLORS): Quantized {
  const pixels = pixelColors(rgba)
  const counts = new Map<number, number>()
  for (const color of pixels) counts.set(color, (counts.get(color) ?? 0) + 1)
  const colors = [...counts.keys()].sort((a, b) => a - b)
  const indexOf = new Map<number, number>()
  if (colors.length <= maxColors) {
    // Few enough colours to keep every one: nothing is lost.
    const palette = new Uint8Array(colors.length * 3)
    colors.forEach((color, index) => {
      palette.set([channel(color, 16), channel(color, 8), channel(color, 0)], index * 3)
      indexOf.set(color, index)
    })
    return { palette, indices: mapIndices(pixels, indexOf), exact: true }
  }

  let boxes: ColorBox[] = [makeBox(colors, counts)]
  while (boxes.length < maxColors) {
    // Split the box with the most pixels spread over the widest range.
    let pick = -1
    let score = 0
    boxes.forEach((box, index) => {
      if (box.score > score) {
        score = box.score
        pick = index
      }
    })
    const chosen = boxes[pick]
    const halves = chosen ? splitBox(chosen) : null
    if (!halves) break
    boxes = [...boxes.slice(0, pick), ...halves, ...boxes.slice(pick + 1)]
  }

  // Each box becomes its pixel-weighted average colour.
  const palette = new Uint8Array(boxes.length * 3)
  boxes.forEach((box, index) => {
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (const color of box.colors) {
      const weight = counts.get(color) ?? 0
      r += channel(color, 16) * weight
      g += channel(color, 8) * weight
      b += channel(color, 0) * weight
      n += weight
      indexOf.set(color, index)
    }
    palette.set([Math.round(r / n), Math.round(g / n), Math.round(b / n)], index * 3)
  })
  return { palette, indices: mapIndices(pixels, indexOf), exact: false }
}

function mapIndices(pixels: Uint32Array, indexOf: Map<number, number>): Uint8Array {
  const indices = new Uint8Array(pixels.length)
  for (let p = 0; p < pixels.length; p++) indices[p] = indexOf.get(pixels[p] ?? 0) ?? 0
  return indices
}

// ── Indexed (8-bit palette) PNG ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** A PNG with a palette of up to 256 colours; `deflate` must produce zlib data. */
export async function encodeIndexedPng(
  width: number,
  height: number,
  palette: Uint8Array,
  indices: Uint8Array,
  deflate: Deflate,
): Promise<Uint8Array> {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 3, 0, 0, 0], 8) // 8-bit, palette, deflate, adaptive filtering, no interlace
  // Filter type 0 on every row: the usual choice for palette images.
  const raw = new Uint8Array(height * (width + 1))
  for (let y = 0; y < height; y++) raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('PLTE', palette),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// ── Choosing the encoding and size ──

/**
 * The smallest-change PNG under `maxBytes`: tried at `maxScale` first, then
 * stepped down to 1x (the shown size). Never fails: past 1x it returns the
 * smallest attempt, so a send is never blocked by an image.
 */
export async function encodeWithinBudget(args: {
  maxScale: number
  render: (scale: number) => Promise<RenderedFrame>
  deflate: Deflate
  maxBytes?: number
}): Promise<Uint8Array> {
  const maxBytes = args.maxBytes ?? BAKED_IMAGE_MAX_BYTES
  let scale = Math.max(1, args.maxScale)
  let smallest: Uint8Array | null = null
  for (;;) {
    const frame = await args.render(scale)
    const quantized = quantizeToPalette(frame.rgba)
    const indexed = () => encodeIndexedPng(frame.width, frame.height, quantized.palette, quantized.indices, args.deflate)
    let attempt: Uint8Array
    if (quantized.exact) {
      attempt = await indexed()
    } else {
      attempt = await frame.encodePng()
      if (attempt.length > maxBytes) attempt = await indexed()
    }
    if (!smallest || attempt.length < smallest.length) smallest = attempt
    if (attempt.length <= maxBytes || scale <= 1) return attempt.length <= maxBytes ? attempt : smallest
    scale = Math.max(1, scale * SCALE_STEP)
  }
}

// ── Rewriting the email's <img> tags ──

export interface BakedImage {
  /** data:image/png;base64,… */
  src: string
  /** Shown width including the shadow's room, in CSS px. */
  width: number
}

export type BakeImage = (src: string, displayWidth: number) => Promise<BakedImage | null>

const IMG_TAG_RE = /<img\b[^>]*>/gi

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
  return match ? (match[2] ?? match[3] ?? '') : null
}

function setAttribute(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*')`, 'i')
  return re.test(tag) ? tag.replace(re, `$1"${value}"`) : tag.replace(/^<img\b/i, `<img ${name}="${value}"`)
}

/**
 * The email HTML with every pasted (data:) image that has the CSS shadow
 * replaced by its baked copy: new src, wider by the shadow's room, and no
 * box-shadow (so Apple Mail does not show it twice). An image that cannot be
 * baked keeps its CSS shadow.
 */
export async function bakeShadowedImages(html: string, bake: BakeImage): Promise<string> {
  const tags = [...new Set(html.match(IMG_TAG_RE) ?? [])]
  const replaced = new Map<string, string>()
  for (const tag of tags) {
    const src = attribute(tag, 'src') ?? ''
    const style = attribute(tag, 'style') ?? ''
    if (!/^data:image\//i.test(src) || !/box-shadow\s*:/i.test(style)) continue
    const width = Number.parseInt(attribute(tag, 'width') ?? '', 10)
    let baked: BakedImage | null = null
    try {
      baked = await bake(src, Number.isFinite(width) && width > 0 ? width : DEFAULT_DISPLAY_WIDTH)
    } catch {
      baked = null
    }
    if (!baked) continue
    const cleanStyle = style.replace(/box-shadow\s*:[^;]*;?/gi, '').trim()
    let next = setAttribute(tag, 'src', baked.src)
    next = setAttribute(next, 'width', String(baked.width))
    next = setAttribute(next, 'style', cleanStyle)
    replaced.set(tag, next)
  }
  return replaced.size ? html.replace(IMG_TAG_RE, (tag) => replaced.get(tag) ?? tag) : html
}

// ── Browser: canvas drawing ──

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** zlib deflate with the browser's own CompressionStream. */
export async function browserDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Bake one data: image in the browser; null when it cannot be decoded or drawn. */
export const bakeImageInBrowser: BakeImage = async (src, displayWidth) => {
  const match = src.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i)
  if (!match || typeof createImageBitmap !== 'function' || typeof CompressionStream !== 'function') return null
  const bitmap = await createImageBitmap(new Blob([base64ToBytes(match[2] ?? '') as BlobPart], { type: match[1] }))
  try {
    if (!bitmap.width || !bitmap.height) return null
    const shownWidth = Math.max(1, Math.round(displayWidth))
    const shownHeight = Math.max(1, Math.round((shownWidth * bitmap.height) / bitmap.width))
    const outerWidth = shownWidth + SHADOW_PAD.side * 2
    const outerHeight = shownHeight + SHADOW_PAD.top + SHADOW_PAD.bottom
    // No point drawing more pixels than the screenshot has.
    const maxScale = Math.min(MAX_SCALE, Math.max(1, bitmap.width / shownWidth))

    const render = async (scale: number): Promise<RenderedFrame> => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(outerWidth * scale)
      canvas.height = Math.round(outerHeight * scale)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('No canvas')
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      const x = SHADOW_PAD.side * scale
      const y = SHADOW_PAD.top * scale
      const w = shownWidth * scale
      const h = shownHeight * scale
      for (const layer of SHADOW_LAYERS) {
        context.save()
        context.shadowColor = layer.color
        context.shadowBlur = layer.blur * scale
        context.shadowOffsetY = layer.offsetY * scale
        context.fillRect(x, y, w, h)
        context.restore()
      }
      context.imageSmoothingQuality = 'high'
      context.drawImage(bitmap, x, y, w, h)
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      return {
        width: canvas.width,
        height: canvas.height,
        rgba: data,
        encodePng: () =>
          new Promise((resolve, reject) =>
            canvas.toBlob((blob) => (blob ? blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject) : reject(new Error('PNG failed'))), 'image/png'),
          ),
      }
    }

    const png = await encodeWithinBudget({ maxScale, render, deflate: browserDeflate })
    return { src: `data:image/png;base64,${bytesToBase64(png)}`, width: outerWidth }
  } finally {
    bitmap.close()
  }
}
