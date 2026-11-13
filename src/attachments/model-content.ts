import type { FilePart, ModelMessage, TextPart } from "ai"
import type { CatalogModel, HydratedFile } from "../shared/types"
import { isTextMime } from "./mime"

const MODEL_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const MODEL_MEDIA_MIMES = new Set([...MODEL_IMAGE_MIMES, "application/pdf"])
const IMAGE_TRIGGER_BYTES = 25 * 1024 * 1024
const IMAGE_TARGET_BYTES = 15 * 1024 * 1024
const IMAGE_REMOVED =
  "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]"

const XAI_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"])

export function modelSupportsMedia(model: CatalogModel, mime: string): boolean {
  const modality = mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : undefined
  if (!modality) return true
  if (model.providerId === "xai" && modality === "image" && !XAI_IMAGE_MIMES.has(mime.toLowerCase())) return false
  return model.inputModalities.some((value) => value === modality || value === mime)
}

export function unsupportedMediaText(file: HydratedFile): string {
  const modality = file.mime.startsWith("image/") ? "image" : file.mime === "application/pdf" ? "pdf" : file.mime
  return `ERROR: Cannot read ${file.name ? `"${file.name}"` : modality} (this model does not support ${modality} input). Inform the user.`
}

function textPart(file: HydratedFile): TextPart {
  const text = Buffer.from(file.data, "base64").toString("utf8")
  return {
    type: "text",
    text: [
      `Attached file: ${file.name ?? file.uri}`,
      ...(file.description ? [`Description: ${file.description}`] : []),
      "",
      text,
    ].join("\n"),
  }
}

function filePart(file: HydratedFile): FilePart {
  return {
    type: "file",
    data: { type: "data", data: file.data },
    mediaType: file.mime,
    ...(file.name ? { filename: file.name } : {}),
  }
}

export function attachmentPart(file: HydratedFile, model: CatalogModel): TextPart | FilePart | null {
  if (isTextMime(file.mime)) return textPart(file)
  if (!MODEL_MEDIA_MIMES.has(file.mime)) return null
  if (!modelSupportsMedia(model, file.mime)) {
    return { type: "text", text: unsupportedMediaText(file) }
  }
  return filePart(file)
}

/** Builds the user content array: text, then text attachments, then media. */
export function userContent(
  text: string,
  files: readonly HydratedFile[],
  model: CatalogModel,
): Array<TextPart | FilePart> {
  const content: Array<TextPart | FilePart> = []
  if (text.length > 0) content.push({ type: "text", text })
  for (const file of files) {
    const part = attachmentPart(file, model)
    if (part) content.push(part)
  }
  return content
}

interface MediaPartLike {
  type: "file"
  data: { type: "data"; data: string }
  mediaType?: string
  filename?: string
}

interface TextLike {
  type: "text"
  text: string
}

function isFilePart(part: unknown): part is MediaPartLike {
  return Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "file"
}

function isToolResult(part: unknown): part is {
  type: "tool-result"
  output?: { type?: string; value?: unknown }
} {
  return Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "tool-result"
}

function mediaMime(part: MediaPartLike): string | undefined {
  return part.mediaType
}

function replacePart(part: unknown, model: CatalogModel): unknown {
  if (isFilePart(part)) {
    const mime = mediaMime(part)
    if (!mime || !MODEL_MEDIA_MIMES.has(mime) || modelSupportsMedia(model, mime)) return part
    const name = part.filename
    const modality = mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : mime
    return {
      type: "text",
      text: `ERROR: Cannot read ${name ? `"${name}"` : modality} (this model does not support ${modality} input). Inform the user.`,
    } satisfies TextLike
  }
  if (isToolResult(part) && part.output?.type === "content" && Array.isArray(part.output.value)) {
    return {
      ...part,
      output: {
        ...part.output,
        value: part.output.value.map((item) => replacePart(item, model)),
      },
    }
  }
  return part
}

/** Replaces unsupported media in user and tool-result content with the expected error text. */
export function filterUnsupportedMedia(messages: ModelMessage[], model: CatalogModel): ModelMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map((part) => replacePart(part, model)),
    } as ModelMessage
  })
}

/** Keeps the newest images under the 25 MiB / 15 MiB replay budget. */
export function boundImages(messages: ModelMessage[]): ModelMessage[] {
  const images: Array<{ message: number; part: number; size: number }> = []
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return
    message.content.forEach((part, partIndex) => {
      if (isFilePart(part) && part.mediaType?.startsWith("image/")) {
        images.push({ message: messageIndex, part: partIndex, size: part.data.data.length })
      }
    })
  })
  let kept = images.reduce((sum, image) => sum + image.size, 0)
  if (kept <= IMAGE_TRIGGER_BYTES) return messages
  const cut = new Set<string>()
  for (const image of images) {
    if (kept <= IMAGE_TARGET_BYTES) break
    cut.add(`${image.message}:${image.part}`)
    kept -= image.size
  }
  if (cut.size === 0) return messages
  return messages.map((message, messageIndex) => {
    if (!Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map((part, partIndex) =>
        cut.has(`${messageIndex}:${partIndex}`)
          ? { type: "text", text: IMAGE_REMOVED }
          : part,
      ),
    } as ModelMessage
  })
}

export function sanitizeModelMessages(messages: ModelMessage[], model: CatalogModel): ModelMessage[] {
  return boundImages(filterUnsupportedMedia(messages, model))
}
