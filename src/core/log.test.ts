import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "./log"

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test("logger writes JSON lines and redacts secrets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-log-"))
  dirs.push(dir)
  const file = path.join(dir, "service.log")
  const logger = new Logger({ filePath: file, level: "debug" })
  logger.info("test.event", {
    password: "super-secret-password",
    authorization: "Basic abc123",
    cookie: "agent1_session=token",
    safe: "visible",
    nested: { token: "nested-secret" },
    error: "provider rejected sk-live-secret-key-123456789",
  })
  const text = await readFile(file, "utf8")
  expect(text).toContain("test.event")
  expect(text).toContain("visible")
  expect(text).not.toContain("super-secret-password")
  expect(text).not.toContain("abc123")
  expect(text).not.toContain("agent1_session=token")
  expect(text).not.toContain("nested-secret")
  expect(text).not.toContain("sk-live-secret-key-123456789")
  expect(text).toContain("[REDACTED]")
})
