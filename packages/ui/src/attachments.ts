import { AGENT_IMAGE_TYPES, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_IMAGES, MAX_TARGET_DOM_CHARS, type AgentImage } from '@morphkit/runtime'

/** A screenshot waiting in the chat input: what is sent, plus a data URL for the thumbnail. */
export interface PendingImage extends AgentImage {
  id: number
  /** `data:` URL (works under a CSP with `img-src data:`, unlike `blob:` thumbnails). */
  preview: string
  bytes: number
}

/** Longest side sent to the model: larger screenshots are scaled down (vision models downscale anyway). */
export const MAX_IMAGE_SIDE = 1568

let seq = 0

const isImage = (f: File) => (AGENT_IMAGE_TYPES as readonly string[]).includes(f.type)

/** Image files from a paste or a drop. */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = Array.from(data.files ?? []).filter(isImage)
  if (files.length) return files
  return Array.from(data.items ?? [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null && isImage(f))
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('could not read the image'))
    r.readAsDataURL(blob)
  })
}

/** Scale a large screenshot down to MAX_IMAGE_SIDE; PNG stays PNG (sharp text), photos become JPEG. */
async function downscale(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || file.type === 'image/gif') return file
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
    bitmap.close()
    return file
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), type, 0.88))
}

/** Read a pasted or dropped file into a PendingImage. */
export async function prepareImage(file: File): Promise<PendingImage> {
  const blob = await downscale(file).catch(() => file)
  const preview = await readAsDataUrl(blob)
  const comma = preview.indexOf(',')
  const mediaType = (preview.slice(5, preview.indexOf(';')) || file.type) as AgentImage['mediaType']
  const data = preview.slice(comma + 1)
  return { id: ++seq, mediaType, data, preview, bytes: Math.floor((data.length * 3) / 4), ...(file.name ? { name: file.name } : {}) }
}

/** Add images while staying inside the per-request limits; returns what was kept and how many were dropped. */
export function addImages(current: PendingImage[], incoming: PendingImage[]): { images: PendingImage[]; dropped: number } {
  const images = current.slice()
  let total = images.reduce((s, i) => s + i.bytes, 0)
  let dropped = 0
  for (const img of incoming) {
    if (images.length >= MAX_AGENT_IMAGES || total + img.bytes > MAX_AGENT_IMAGE_BYTES) {
      dropped++
      continue
    }
    images.push(img)
    total += img.bytes
  }
  return { images, dropped }
}

const KEEP_ATTRS = /^(class|data-testid|role|aria-[\w-]+|title|alt|type|href|colspan|rowspan|disabled|checked|placeholder)$/
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META'])
const MAX_TEXT = 160

/**
 * Sanitized markup of the panel the user pointed at, as they see it now: structure, classes, test ids and
 * visible text (trimmed), no scripts, styles, event handlers or form values. Sent as data, never instructions.
 */
export function panelDomSnapshot(id: string, root: ParentNode = document, max = MAX_TARGET_DOM_CHARS): string | null {
  const host = root.querySelector(`[data-morphkit-id="${CSS.escape(id)}"]`)
  if (!host) return null
  const out: string[] = []
  let size = 0
  const push = (s: string) => {
    out.push(s)
    size += s.length
  }
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const walk = (node: Node, depth: number) => {
    if (size > max) return
    if (node.nodeType === 3) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) push(esc(text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text))
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    if (DROP_TAGS.has(el.tagName)) return
    const tag = el.tagName.toLowerCase()
    if (tag === 'iframe') {
      push(`<iframe title="${esc(el.getAttribute('title') ?? '')}"></iframe>`)
      return
    }
    if (tag === 'svg') {
      push('<svg/>')
      return
    }
    const attrs = Array.from(el.attributes)
      .filter((a) => KEEP_ATTRS.test(a.name))
      .map((a) => ` ${a.name}="${esc(a.value.slice(0, 200))}"`)
      .join('')
    push(`${depth ? '\n' + '  '.repeat(Math.min(depth, 12)) : ''}<${tag}${attrs}>`)
    for (const child of Array.from(el.childNodes)) walk(child, depth + 1)
    push(`</${tag}>`)
  }
  for (const child of Array.from(host.childNodes)) walk(child, 0)
  const html = out.join('').trim()
  return html.length > max ? html.slice(0, max) + '\n<!-- truncated -->' : html
}
