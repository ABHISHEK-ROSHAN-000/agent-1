import path from "node:path"

const MEDIA_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "application/pdf",
])

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
])

const EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  pdf: "application/pdf",
  svg: "text/xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/plain",
  jsx: "text/plain",
  css: "text/plain",
  html: "text/plain",
  xml: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

/** Magic-byte detection followed by an extension fallback, for media handling. */
export function detectMime(bytes: Uint8Array, filename?: string): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp"
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip"

  const extension = filename ? EXTENSIONS[path.extname(filename).slice(1).toLowerCase()] : undefined
  if (extension) return extension

  if (bytes.length > 0 && !bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      return "text/plain"
    } catch {
      return undefined
    }
  }
  return undefined
}

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime)
}

export function isMediaMime(mime: string): boolean {
  return MEDIA_MIMES.has(mime)
}

export function isPdfMime(mime: string): boolean {
  return mime === "application/pdf"
}

export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/x-yaml" ||
    mime === "application/javascript"
  )
}

export function mimeFromExtension(filename: string): string | undefined {
  return EXTENSIONS[path.extname(filename).slice(1).toLowerCase()]
}
