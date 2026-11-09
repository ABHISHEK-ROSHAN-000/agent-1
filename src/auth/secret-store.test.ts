import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SecretStore } from "./secret-store"

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test("secret store encrypts the password at rest", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-secret-"))
  dirs.push(dir)
  const file = path.join(dir, "secrets", "auth.dpapi.json")
  const store = new SecretStore(file)
  const password = "a-very-long-generated-password-32-bytes"

  await store.writePassword(password)
  const raw = await readFile(file, "utf8")
  expect(raw).not.toContain(password)
  expect(await store.readPassword()).toBe(password)

  await store.remove()
  expect(await store.readPassword()).toBeUndefined()
})
