import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveConfig, ensureDataDirs } from "../core/config"
import { SecretStore } from "../auth/secret-store"
import { AgentOneClient } from "../client/client"
import { isProcessAlive } from "./lock"
import { startService, stopService, serviceStatus } from "./service"

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function tempConfig() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-lifecycle-"))
  dirs.push(dir)
  const config = resolveConfig({ ...process.env, AGENT1_DATA_DIR: dir, AGENT1_PORT: "0" })
  ensureDataDirs(config)
  return { dir, config }
}

async function password(config: ReturnType<typeof resolveConfig>): Promise<string> {
  const value = await new SecretStore(config.secretsPath).readPassword()
  if (!value) throw new Error("Test daemon did not create a password")
  return value
}

async function stopIfRunning(config: ReturnType<typeof resolveConfig>): Promise<void> {
  const status = await serviceStatus(config)
  if (status.status === "running") {
    try {
      await stopService(config, await password(config))
    } catch {
      if (status.state) {
        try {
          process.kill(status.state.pid)
        } catch {
          // Best effort.
        }
      }
    }
  }
}

describe("daemon lifecycle", () => {
  test("starts detached, reports status, serves sessions, and stops", async () => {
    const { config } = await tempConfig()
    try {
      const started = await startService(config)
      expect(started.alreadyRunning).toBe(false)
      expect(isProcessAlive(started.state.pid)).toBe(true)

      const status = await serviceStatus(config)
      expect(status.status).toBe("running")
      expect(status.healthy).toBe(true)

      const client = new AgentOneClient({
        baseUrl: started.state.url,
        password: await password(config),
      })
      const session = await client.createSession("Lifecycle")
      expect(session.session.title).toBe("Lifecycle")
      expect((await client.listSessions()).sessions).toHaveLength(1)

      const stopped = await stopService(config, await password(config))
      expect(stopped.stopped).toBe(true)
      expect(isProcessAlive(started.state.pid)).toBe(false)
      expect((await serviceStatus(config)).status).toBe("stopped")
    } finally {
      await stopIfRunning(config)
    }
  }, 30_000)

  test("refuses a second instance", async () => {
    const { config } = await tempConfig()
    try {
      const first = await startService(config)
      const second = await startService(config)
      expect(second.alreadyRunning).toBe(true)
      expect(second.state.pid).toBe(first.state.pid)
    } finally {
      await stopIfRunning(config)
    }
  }, 30_000)

  test("restarts after a forced kill with the database and event sequence intact", async () => {
    const { config } = await tempConfig()
    try {
      const first = await startService(config)
      const client = new AgentOneClient({
        baseUrl: first.state.url,
        password: await password(config),
      })
      await client.createSession("Before crash")
      const before = (await client.info()).eventSeq as number
      const firstPid = first.state.pid
      process.kill(firstPid)

      const deadline = Date.now() + 8_000
      while (Date.now() < deadline && isProcessAlive(firstPid)) await Bun.sleep(50)
      expect(isProcessAlive(firstPid)).toBe(false)

      const second = await startService(config)
      expect(second.state.pid).not.toBe(firstPid)
      expect(second.state.port).not.toBe(first.state.port)
      const restarted = new AgentOneClient({
        baseUrl: second.state.url,
        password: await password(config),
      })
      expect(await restarted.info()).toHaveProperty("eventSeq")
      const sessions = await restarted.listSessions()
      expect(sessions.sessions.some((session) => session.title === "Before crash")).toBe(true)
      expect(((await restarted.info()).eventSeq as number) >= before).toBe(true)
    } finally {
      await stopIfRunning(config)
    }
  }, 30_000)
})
