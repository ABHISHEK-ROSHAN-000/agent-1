import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SecretVault } from "./secret-vault"

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test("model key vault encrypts each key at rest", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-vault-"))
  dirs.push(dir)
  const file = path.join(dir, "secrets", "model-keys.dpapi.json")
  const vault = new SecretVault(file)
  await vault.set("profile-a", "sk-test-secret")
  await vault.set("profile-b", "local-secret")
  const raw = await readFile(file, "utf8")
  expect(raw).not.toContain("sk-test-secret")
  expect(raw).not.toContain("local-secret")
  expect(await vault.get("profile-a")).toBe("sk-test-secret")
  expect(await vault.has("profile-b")).toBe(true)
  await vault.delete("profile-a")
  expect(await vault.get("profile-a")).toBeUndefined()
})
