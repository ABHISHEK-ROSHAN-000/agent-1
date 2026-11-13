import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Logger } from "../core/log"
import type { BlobInput, Database, StoredBlob } from "../db/database"
import type {
  HydratedFile,
  PromptFileInput,
  StoredFile,
} from "../shared/types"
import { MAX_ATTACHMENT_BYTES, normalizeImage } from "./image"
import { detectMime, isImageMime, isMediaMime, isTextMime } from "./mime"

export interface MaterializedAttachments {
  readonly files: StoredFile[]
  readonly blobs: BlobInput[]
}

function decodeDataUrl(uri: string): { bytes: Uint8Array; mime?: string } {
  const comma = uri.indexOf(",")
  if (!uri.startsWith("data:") || comma === -1) throw new Error("Invalid attachment data URL")
  const metadata = uri.slice(5, comma)
  const payload = uri.slice(comma + 1)
  const mime = metadata.split(";")[0] || undefined
  if (metadata.split(";").some((part) => part.toLowerCase() === "base64")) {
    const bytes = Buffer.from(payload, "base64")
    if (bytes.toString("base64") !== payload.replace(/\s+/g, "")) {
      throw new Error("Invalid attachment base64 data")
    }
    return { bytes, ...(mime ? { mime } : {}) }
  }
  return { bytes: Buffer.from(decodeURIComponent(payload)), ...(mime ? { mime } : {}) }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export class AttachmentService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  async materialize(
    inputs: readonly PromptFileInput[] | undefined,
    options: { readonly allowFileUri?: boolean } = {},
  ): Promise<MaterializedAttachments> {
    if (!inputs || inputs.length === 0) return { files: [], blobs: [] }
    const files: StoredFile[] = []
    const blobs: BlobInput[] = []

    for (const input of inputs) {
      const existing = /^media:([0-9a-f]{64})$/.exec(input.uri)
      if (existing) {
        const blob = await this.db.getBlob(existing[1]!)
        if (!blob) throw new Error(`Attachment is no longer stored: ${input.uri}`)
        files.push(this.storedFile(input, blob.mime, blob.bytes, blob.width ?? null, blob.height ?? null, existing[1]!))
        continue
      }

      let bytes: Uint8Array
      let declaredMime: string | undefined
      if (input.uri.startsWith("data:")) {
        const decoded = decodeDataUrl(input.uri)
        bytes = decoded.bytes
        declaredMime = decoded.mime
      } else if (input.uri.startsWith("file:")) {
        if (!options.allowFileUri) throw new Error("file:// attachments are not accepted from this client")
        bytes = readFileSync(fileURLToPath(input.uri))
      } else {
        throw new Error(`Unsupported attachment URI: ${input.uri}`)
      }

      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${input.name ?? "attachment"}`)
      }

      const detected = detectMime(bytes, input.name)
      let mime =
        detected && detected !== "text/plain"
          ? detected
          : declaredMime && declaredMime !== "text/plain"
            ? declaredMime
            : detected ?? declaredMime ?? "application/octet-stream"
      if (!isMediaMime(mime) && !isTextMime(mime)) {
        // Unsupported MIME types are accepted locally but are not sent to the model.
        // Keeping them out of the attachment list avoids storing data we can never use.
        throw new Error(`Unsupported attachment type: ${mime}`)
      }

      let data = Buffer.from(bytes).toString("base64")
      let width: number | undefined
      let height: number | undefined
      if (isImageMime(mime)) {
        try {
          const normalized = normalizeImage(data, mime, input.name ?? "image")
          data = normalized.data
          mime = normalized.mime
          width = normalized.width
          height = normalized.height
          bytes = Buffer.from(data, "base64")
        } catch (error) {
          this.logger.warn("attachments.image_normalize_failed", {
            name: input.name,
            error: error instanceof Error ? error.message : String(error),
          })
          if (Buffer.byteLength(data, "utf8") > 5 * 1024 * 1024) {
            throw new Error(`Image could not be normalized: ${input.name ?? "image"}`)
          }
          // Match the resizer-unavailable fallback: send the original if it fits.
        }
      }

      const digest = hash(bytes)
      const blob: BlobInput = {
        hash: digest,
        mime,
        bytes: bytes.byteLength,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        data: bytes,
      }
      blobs.push(blob)
      files.push(this.storedFile(input, mime, bytes.byteLength, width ?? null, height ?? null, digest))
    }

    await this.db.saveBlobs(blobs)
    return { files, blobs }
  }

  async hydrate(files: readonly StoredFile[] | undefined): Promise<HydratedFile[]> {
    if (!files || files.length === 0) return []
    const hashes = files.map((file) => file.uri.slice("media:".length))
    const blobs = await this.db.getBlobs(hashes)
    return files.map((file) => {
      const blob = blobs.get(file.uri.slice("media:".length))
      if (!blob) {
        const unavailable = `[media unavailable: ${file.name ? `${file.name} (${file.mime})` : file.mime}]`
        return {
          ...file,
          mime: "text/plain",
          data: Buffer.from(unavailable, "utf8").toString("base64"),
        }
      }
      return {
        ...file,
        data: Buffer.from(blob.data).toString("base64"),
        ...(blob.width !== null ? { width: blob.width } : {}),
        ...(blob.height !== null ? { height: blob.height } : {}),
      }
    })
  }

  async hydrateOne(file: StoredFile): Promise<HydratedFile | null> {
    const [hydrated] = await this.hydrate([file])
    return hydrated ?? null
  }

  async readBlob(ref: string): Promise<StoredBlob | null> {
    const match = /^media:([0-9a-f]{64})$/.exec(ref)
    if (!match) return null
    return this.db.getBlob(match[1]!)
  }

  async prune(): Promise<void> {
    try {
      const removed = await this.db.pruneUnreferencedBlobs()
      if (removed > 0) this.logger.info("attachments.blobs_pruned", { removed })
    } catch (error) {
      this.logger.warn("attachments.prune_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private storedFile(
    input: PromptFileInput,
    mime: string,
    bytes: number,
    width: number | null,
    height: number | null,
    digest: string,
  ): StoredFile {
    return {
      uri: `media:${digest}`,
      mime,
      source: input.source ?? { type: "inline" },
      ...(input.name ? { name: input.name } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.mention ? { mention: input.mention } : {}),
      bytes,
      ...(width !== null ? { width } : {}),
      ...(height !== null ? { height } : {}),
    }
  }
}
