/**
 * Browser-side prep for images dropped/pasted into chats and the compose window. There is no
 * user-facing size limit: images that are too big to send are shrunk in the
 * browser (long edge capped, re-encoded as JPEG, stepped down until they fit).
 * Nothing is uploaded or stored — the result travels inline with the message.
 */

export const CHAT_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const
export type ChatImageMediaType = (typeof CHAT_IMAGE_MEDIA_TYPES)[number]

export interface FittedChatImage {
  name: string
  mediaType: ChatImageMediaType
  /** Raw base64, no `data:` prefix. */
  data: string
  size: number
}

export type FitChatImageResult = { ok: true; value: FittedChatImage } | { ok: false; error: string }

export interface FitChatImageOptions {
  /** Encoded size the image must end up at or below. */
  maxBytes: number
  /** Longest edge in pixels; vision models rescale beyond ~1568px anyway. */
  maxEdge: number
  /** Shrink a PNG as a PNG (sharp text) when that fits; JPEG only when it does not. */
  preferPng?: boolean
}

const SUPPORTED = new Set<string>(CHAT_IMAGE_MEDIA_TYPES)
const MAX_ATTEMPTS = 6

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(blob)
  })
}

function renderJpeg(bitmap: ImageBitmap, edge: number, quality: number): Promise<Blob | null> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)
  // JPEG has no alpha; paint white so transparent screenshots stay readable.
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

function renderPng(bitmap: ImageBitmap, edge: number): Promise<Blob | null> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

async function shrink(file: File, options: FitChatImageOptions): Promise<Blob | 'fits' | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return file.size <= options.maxBytes ? 'fits' : null
  }
  const bitmap = await createImageBitmap(file)
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height)
    if (longEdge <= options.maxEdge && file.size <= options.maxBytes) return 'fits'
    let edge = Math.min(longEdge, options.maxEdge)
    if (options.preferPng && file.type === 'image/png') {
      const png = await renderPng(bitmap, edge)
      if (png && png.size <= options.maxBytes) return png
    }
    let quality = 0.85
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const blob = await renderJpeg(bitmap, edge, quality)
      if (!blob) return null
      if (blob.size <= options.maxBytes) return blob
      edge = Math.max(320, Math.round(edge * 0.75))
      quality = Math.max(0.6, quality - 0.08)
    }
    return null
  } finally {
    bitmap.close()
  }
}

export async function fitImageForChat(
  file: File,
  name: string,
  options: FitChatImageOptions,
): Promise<FitChatImageResult> {
  if (!SUPPORTED.has(file.type)) {
    return {
      ok: false,
      error: `${name} is not a supported image type. Use PNG, JPEG, GIF, or WebP.`,
    }
  }
  try {
    const shrunk = await shrink(file, options)
    if (shrunk === null)
      return { ok: false, error: `Could not process ${name}. Try a different image.` }
    const blob = shrunk === 'fits' ? file : shrunk
    const mediaType = (shrunk === 'fits' ? file.type : shrunk.type === 'image/png' ? 'image/png' : 'image/jpeg') as ChatImageMediaType
    return { ok: true, value: { name, mediaType, data: await readBase64(blob), size: blob.size } }
  } catch {
    return { ok: false, error: `Could not read ${name}.` }
  }
}
