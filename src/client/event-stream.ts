export interface SseFrame {
  readonly id: string | null
  readonly event: string | null
  readonly data: string
  readonly retry: number | null
}

/**
 * Small incremental SSE parser. It accepts chunks at arbitrary boundaries,
 * ignores comments, and preserves multi-line data fields.
 */
export class SseParser {
  private buffer = ""
  private data: string[] = []
  private id: string | null = null
  private event: string | null = null
  private retry: number | null = null

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk
    const frames: SseFrame[] = []
    let boundary = this.buffer.search(/\r?\n\r?\n/)
    while (boundary >= 0) {
      const frameText = this.buffer.slice(0, boundary)
      const separator = this.buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n"
      this.buffer = this.buffer.slice(boundary + separator.length)
      const frame = this.consume(frameText)
      if (frame) frames.push(frame)
      boundary = this.buffer.search(/\r?\n\r?\n/)
    }
    return frames
  }

  private consume(frameText: string): SseFrame | null {
    this.data = []
    this.id = null
    this.event = null
    this.retry = null
    let sawField = false

    for (const line of frameText.split(/\r?\n/)) {
      if (line.startsWith(":")) continue
      const separator = line.indexOf(":")
      const field = separator < 0 ? line : line.slice(0, separator)
      const raw = separator < 0 ? "" : line.slice(separator + 1)
      const value = raw.startsWith(" ") ? raw.slice(1) : raw
      if (field === "data") {
        this.data.push(value)
        sawField = true
      } else if (field === "id") {
        this.id = value
        sawField = true
      } else if (field === "event") {
        this.event = value
        sawField = true
      } else if (field === "retry") {
        const parsed = Number(value)
        if (Number.isInteger(parsed) && parsed >= 0) this.retry = parsed
        sawField = true
      }
    }

    if (!sawField) return null
    return {
      id: this.id,
      event: this.event,
      data: this.data.join("\n"),
      retry: this.retry,
    }
  }
}
