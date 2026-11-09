import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireLock, AlreadyRunningError, isProcessAlive } from "./lock"

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test("single-instance lock rejects a second holder and releases", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-lock-"))
  dirs.push(dir)
  const lockPath = path.join(dir, "service.lock")
  const release = acquireLock(lockPath)
  try {
    expect(() => acquireLock(lockPath)).toThrow(AlreadyRunningError)
  } finally {
    release()
  }
  const second = acquireLock(lockPath)
  second()
})

test("process liveness detects a dead pid", () => {
  expect(isProcessAlive(process.pid)).toBe(true)
  expect(isProcessAlive(999_999_999)).toBe(false)
})
