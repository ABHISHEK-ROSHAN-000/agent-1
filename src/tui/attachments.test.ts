import { describe, expect, test } from "bun:test"
import path from "node:path"
import { attachmentLabel, resolvePastedAttachments } from "./attachments"

describe("TUI attachment paste", () => {
  test("turns a pasted image path into an inline attachment", () => {
    const file = path.join(import.meta.dir, "..", "..", "web", "public", "icon-192.png")
    const files = resolvePastedAttachments(`"${file}"`)
    expect(files).toHaveLength(1)
    expect(files?.[0]?.name).toBe("icon-192.png")
    expect(files?.[0]?.uri.startsWith("data:image/png;base64,")).toBe(true)
    expect(files?.[0]?.source).toEqual({ type: "inline" })
  })

  test("ignores ordinary pasted text", () => {
    expect(resolvePastedAttachments("please review this function")).toBeUndefined()
  })

  test("labels attachments for the terminal", () => {
    expect(attachmentLabel({ name: "shot.png", uri: "data:image/png;base64,AA==" })).toContain("shot.png")
  })
})
