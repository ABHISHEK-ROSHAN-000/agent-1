import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "../db/database"
import { Logger } from "../core/log"
import { AuthService, LoginRateLimiter } from "./auth-service"
import { SecretStore } from "./secret-store"

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-auth-"))
  dirs.push(dir)
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  const secrets = new SecretStore(path.join(dir, "secrets", "auth.dpapi.json"))
  const auth = new AuthService(db, secrets, new Logger())
  await auth.initialize()
  return { db, secrets, auth }
}

describe("AuthService", () => {
  test("creates a password and authenticates a session", async () => {
    const { db, auth } = await setup()
    try {
      const password = await auth.showPassword()
      expect(password).toBeDefined()
      expect(await auth.verifyPassword(password!)).toBe(true)
      expect(await auth.verifyPassword("wrong")).toBe(false)

      const login = await auth.login(password!)
      expect(login).not.toBeNull()
      expect(await auth.verifySessionToken(login!.token)).not.toBeNull()
      await auth.logout((await auth.verifySessionToken(login!.token))!.sessionId)
      expect(await auth.verifySessionToken(login!.token)).toBeNull()
    } finally {
      await db.close()
    }
  })

  test("pairing tokens are one-time and rotation signs out old sessions", async () => {
    const { db, auth } = await setup()
    try {
      const password = (await auth.showPassword())!
      const login = await auth.login(password)
      const pairing = await auth.createPairingToken()
      const paired = await auth.consumePairingToken(pairing.token)
      expect(paired).not.toBeNull()
      expect(await auth.consumePairingToken(pairing.token)).toBeNull()

      expect(await auth.verifySessionToken(login!.token)).not.toBeNull()
      const next = await auth.rotatePassword()
      expect(next).not.toBe(password)
      expect(await auth.verifyPassword(next)).toBe(true)
      expect(await auth.verifyPassword(password)).toBe(false)
      expect(await auth.verifySessionToken(login!.token)).toBeNull()
    } finally {
      await db.close()
    }
  })

  test("login rate limiter blocks repeated failures", () => {
    const limiter = new LoginRateLimiter(2, 1000)
    limiter.fail("test")
    limiter.fail("test")
    expect(() => limiter.check("test")).toThrow("Too many login attempts")
    limiter.succeed("test")
    expect(() => limiter.check("test")).not.toThrow()
  })
})
