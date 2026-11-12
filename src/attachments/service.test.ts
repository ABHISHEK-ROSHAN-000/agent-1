import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PNG } from "pngjs"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import type { CatalogModel } from "../shared/types"
import { sanitizeModelMessages, userContent } from "./model-content"
import { AttachmentService } from "./service"

const dirs: string[] = []
const databases: Database[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-attachments-"))
  dirs.push(dir)
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  databases.push(db)
  const logger = new Logger({ level: "error" })
  return { db, service: new AttachmentService(db, logger) }
}

function model(input: string[] = ["text", "image"]): CatalogModel {
  return {
    providerId: "test",
    modelId: "vision",
    name: "Vision",
    contextWindow: 8_192,
    maxOutputTokens: 1_024,
    inputModalities: input,
    outputModalities: ["text"],
    supportsTools: true,
    supportsTemperature: true,
    reasoning: false,
    reasoningOptions: [],
    costInputPerMillion: 0,
    costOutputPerMillion: 0,
    costCacheReadPerMillion: 0,
    costCacheWritePerMillion: 0,
    enabled: true,
    favorite: false,
  }
}

const png = readFileSync(path.join(import.meta.dir, "..", "..", "web", "public", "icon-192.png")).toString("base64")

describe("attachments", () => {
  test("stores and hydrates image bytes as content-addressed blobs", async () => {
    const { db, service } = await setup()
    const result = await service.materialize([
      {
        uri: `data:image/png;base64,${png}`,
        name: "icon.png",
        source: { type: "inline" },
      },
    ])
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.uri).toMatch(/^media:[0-9a-f]{64}$/)
    expect(result.blobs).toHaveLength(1)
    const hydrated = await service.hydrate(result.files)
    expect(hydrated[0]?.mime).toBe("image/png")
    expect(hydrated[0]?.data).toBe(png)
    const blob = await db.getBlob(result.files[0]!.uri.slice(6))
    expect(blob?.bytes).toBeGreaterThan(0)
  })

  test("converts text and image attachments into model content", async () => {
    const { service } = await setup()
    const result = await service.materialize([
      { uri: `data:image/png;base64,${png}`, name: "icon.png" },
      { uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" },
    ])
    const content = userContent("look", await service.hydrate(result.files), model())
    expect(content[0]).toMatchObject({ type: "text", text: "look" })
    expect(content.some((part) => part.type === "file" && part.mediaType === "image/png")).toBe(true)
    expect(content.some((part) => part.type === "text" && part.text.includes("hello"))).toBe(true)
  })

  test("keeps PDFs as document media when the model supports pdf", async () => {
    const { service } = await setup()
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF").toString("base64")
    const result = await service.materialize([{ uri: `data:application/pdf;base64,${pdf}`, name: "doc.pdf" }])
    const content = userContent("summarize", await service.hydrate(result.files), model(["text", "pdf"]))
    expect(content.some((part) => part.type === "file" && part.mediaType === "application/pdf")).toBe(true)
  })

  test("turns unsupported vision media into an explicit error text", async () => {
    const { service } = await setup()
    const result = await service.materialize([{ uri: `data:image/png;base64,${png}`, name: "icon.png" }])
    const content = userContent("look", await service.hydrate(result.files), model(["text"]))
    expect(content.some((part) => part.type === "text" && part.text.includes("does not support image"))).toBe(true)
    expect(content.some((part) => part.type === "file")).toBe(false)

    const sanitized = sanitizeModelMessages(
      [{ role: "user", content: [{ type: "file", data: { type: "data", data: png }, mediaType: "image/png" }] }],
      model(["text"]),
    )
    expect(JSON.stringify(sanitized)).toContain("does not support image")
  })

  test("hydrates a missing blob as OpenCode's unavailable text", async () => {
    const { service } = await setup()
    const file = {
      uri: `media:${"0".repeat(64)}` as const,
      mime: "image/png",
      name: "missing.png",
      source: { type: "inline" as const },
    }
    const hydrated = await service.hydrate([file])
    expect(hydrated[0]?.mime).toBe("text/plain")
    expect(Buffer.from(hydrated[0]!.data, "base64").toString("utf8")).toContain("media unavailable")
  })

  test("resizes an oversized image into the OpenCode limits", async () => {
    const { service } = await setup()
    const width = 2_500
    const height = 10
    const pngImage = new PNG({ width, height })
    for (let offset = 0; offset < pngImage.data.length; offset += 4) {
      pngImage.data[offset] = 40
      pngImage.data[offset + 1] = 120
      pngImage.data[offset + 2] = 220
      pngImage.data[offset + 3] = 255
    }
    const bytes = PNG.sync.write(pngImage)
    const result = await service.materialize([
      {
        uri: `data:image/png;base64,${bytes.toString("base64")}`,
        name: "wide.png",
      },
    ])
    const file = result.files[0]!
    expect(file.width).toBeLessThanOrEqual(2_000)
    expect(file.height).toBeLessThanOrEqual(2_000)
    expect(file.bytes).toBeLessThanOrEqual(5 * 1024 * 1024)
  }, 15_000)

  test("releases only unreferenced blobs", async () => {
    const { db, service } = await setup()
    const result = await service.materialize([{ uri: `data:image/png;base64,${png}`, name: "icon.png" }])
    const file = result.files[0]!
    const hash = file.uri.slice(6)
    await db.recordBlobRefs("ses_1", "msg_1", 1, [hash])
    expect(await db.getReferencedBlob(hash)).not.toBeNull()
    await db.releaseBlobRefs("ses_1", "msg_1")
    expect(await db.getBlob(hash)).toBeNull()
  })

  test("deleting a session releases its attachment blobs", async () => {
    const { db, service } = await setup()
    const session = await db.createSession("Attachment lifecycle")
    const result = await service.materialize([{ uri: `data:image/png;base64,${png}`, name: "icon.png" }])
    const hash = result.files[0]!.uri.slice(6)
    await db.recordBlobRefs(session.session.id, "msg_1", 1, [hash])
    await db.deleteSession(session.session.id)
    expect(await db.getBlob(hash)).toBeNull()
  })

  test("rejects unsupported binary MIME types and remote file URIs", async () => {
    const { service } = await setup()
    await expect(
      service.materialize([{ uri: "data:application/zip;base64,UEsDBA==", name: "a.zip" }]),
    ).rejects.toThrow("Unsupported attachment type")
    await expect(service.materialize([{ uri: "file:///C:/secret.txt" }])).rejects.toThrow("file://")
  })

  test("rejects malformed attachment data and mismatched base64", async () => {
    const { service } = await setup()
    await expect(service.materialize([{ uri: "data:image/png;base64,%%%%" }])).rejects.toThrow()
    await expect(
      service.materialize([{ uri: "data:image/png;base64,aGVsbG8" }]),
    ).rejects.toThrow("base64")
  })

  test("rejects an attachment over the 20 MB limit before storing it", async () => {
    const { service } = await setup()
    const huge = Buffer.alloc(20 * 1024 * 1024 + 1, 0x41)
    await expect(
      service.materialize([{ uri: `data:text/plain;base64,${huge.toString("base64")}`, name: "huge.txt" }]),
    ).rejects.toThrow("byte limit")
  }, 15_000)

  test("uses the detected media type even when the data URL lies", async () => {
    const { service } = await setup()
    const result = await service.materialize([
      { uri: `data:text/plain;base64,${png}`, name: "fake.txt" },
    ])
    expect(result.files[0]?.mime).toBe("image/png")
  })
})
