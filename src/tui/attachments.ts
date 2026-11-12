import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { PromptFileInput } from "../shared/types"
import { MAX_ATTACHMENT_BYTES } from "../attachments/image"
import { detectMime } from "../attachments/mime"

const MAX_PASTED_FILES = 32

function stripQuotes(value: string): string {
  return value.replace(/^['"]+|['"]+$/g, "").trim()
}

function localPath(value: string): string | undefined {
  const cleaned = stripQuotes(value)
  if (cleaned.startsWith("file://")) {
    try {
      const url = new URL(cleaned)
      const pathname = decodeURIComponent(url.pathname)
      const local = pathname.replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\")
      return url.hostname && url.hostname !== "localhost" ? `\\\\${url.hostname}${local}` : local
    } catch {
      return undefined
    }
  }
  if (/^https?:\/\//i.test(cleaned)) return undefined
  return cleaned
}

function candidates(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) {
    return trimmed
      .split(/\r?\n/)
      .map(stripQuotes)
      .filter(Boolean)
  }
  return [trimmed]
}

/**
 * Resolves pasted local file paths the same way OpenCode's TUI does, but sends
 * bytes inline so a remote daemon never reads the client's filesystem.
 */
export function resolvePastedAttachments(value: string): PromptFileInput[] | undefined {
  const paths = candidates(value).flatMap((candidate) => {
    const resolved = localPath(candidate)
    return resolved ? [resolved] : []
  })
  if (paths.length === 0) return undefined
  const files: PromptFileInput[] = []
  for (const candidate of paths.slice(0, MAX_PASTED_FILES)) {
    try {
      const stat = readFileSync(candidate)
      if (stat.byteLength > MAX_ATTACHMENT_BYTES) continue
      const filename = path.basename(candidate)
      const mime = detectMime(stat, filename)
      if (!mime || mime === "application/octet-stream") continue
      files.push({
        uri: `data:${mime};base64,${stat.toString("base64")}`,
        source: { type: "inline" },
        name: filename,
      })
    } catch {
      // Not a readable local path.
    }
  }
  return files.length > 0 ? files : undefined
}

export function attachmentLabel(file: { name?: string; mime?: string; uri?: string }): string {
  const mime = file.mime ?? (file.uri?.startsWith("data:") ? file.uri.slice(5, file.uri.indexOf(";")) : "attachment")
  return `${file.name ?? "attachment"} · ${mime}`
}

export function isAttachmentPath(value: string): boolean {
  return resolvePastedAttachments(value) !== undefined
}
