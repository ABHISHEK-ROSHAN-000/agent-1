import {
  PhotonImage,
  SamplingFilter,
  resize,
} from "@silvia-odwyer/photon-node"
import { isImageMime } from "./mime"

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_WIDTH = 2_000
export const MAX_IMAGE_HEIGHT = 2_000

const JPEG_QUALITIES = [80, 70, 55, 40] as const

export interface NormalizedImage {
  readonly data: string
  readonly mime: string
  readonly width: number
  readonly height: number
}

const base64Bytes = (bytes: Uint8Array): number => Math.ceil(bytes.length / 3) * 4

function hasTransparency(pixels: Uint8Array, width: number, height: number): boolean {
  const columns = Math.min(64, width)
  const rows = Math.min(64, height)
  let transparent = 0
  for (let row = 0; row < rows; row++) {
    const y = Math.floor(((row + 0.5) * height) / rows)
    for (let column = 0; column < columns; column++) {
      const x = Math.floor(((column + 0.5) * width) / columns)
      if ((pixels[(y * width + x) * 4 + 3] ?? 255) < 250) transparent++
    }
  }
  return transparent / (columns * rows) > 0.05
}

/**
 * Resize only when the advertised limits require it. Small PNGs are
 * passed through unchanged so screenshots keep their pixel fidelity.
 */
export function normalizeImage(
  data: string,
  mime: string,
  filename: string,
): NormalizedImage {
  if (!isImageMime(mime)) {
    throw new Error("Image attachment has an unsupported MIME type")
  }
  let decoded: PhotonImage
  try {
    decoded = PhotonImage.new_from_byteslice(Buffer.from(data, "base64"))
  } catch {
    throw new Error(`Image could not be decoded: ${filename}`)
  }
  try {
    const width = decoded.get_width()
    const height = decoded.get_height()
    const bytes = Buffer.byteLength(data, "utf8")
    const fits = width <= MAX_IMAGE_WIDTH && height <= MAX_IMAGE_HEIGHT && bytes <= MAX_IMAGE_BASE64_BYTES
    if (fits) return { data, mime, width, height }

    const scale = Math.min(1, MAX_IMAGE_WIDTH / width, MAX_IMAGE_HEIGHT / height)
    let currentWidth = Math.max(1, Math.round(width * scale))
    let currentHeight = Math.max(1, Math.round(height * scale))
    for (let attempt = 0; attempt < 16; attempt++) {
      const resized =
        currentWidth === width && currentHeight === height
          ? decoded
          : resize(decoded, currentWidth, currentHeight, SamplingFilter.Lanczos3)
      try {
        const transparent =
          mime !== "image/jpeg" && hasTransparency(resized.get_raw_pixels(), currentWidth, currentHeight)
        const encoders: Array<readonly [string, () => Uint8Array]> = transparent
          ? [["image/png", () => resized.get_bytes()], ...JPEG_QUALITIES.map((quality) => ["image/jpeg", () => resized.get_bytes_jpeg(quality)] as const)]
          : [...JPEG_QUALITIES.map((quality) => ["image/jpeg", () => resized.get_bytes_jpeg(quality)] as const), ["image/png", () => resized.get_bytes()]]
        for (const [outputMime, encode] of encoders) {
          const candidate = encode()
          if (base64Bytes(candidate) <= MAX_IMAGE_BASE64_BYTES) {
            return {
              data: Buffer.from(candidate).toString("base64"),
              mime: outputMime,
              width: currentWidth,
              height: currentHeight,
            }
          }
        }
      } finally {
        if (resized !== decoded) resized.free()
      }
      if (currentWidth === 1 && currentHeight === 1) break
      currentWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75))
      currentHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75))
    }
    throw new Error(
      `Image ${filename} is ${width}x${height} and exceeds ${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT}/${MAX_IMAGE_BASE64_BYTES} bytes`,
    )
  } finally {
    decoded.free()
  }
}
