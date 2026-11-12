import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SecretStore } from "../auth/secret-store"
import { resolveConfig } from "../core/config"
import { readServiceConfig } from "../core/service-config"
import { readState } from "../daemon/state"

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

function cli(args: string[]) {
  return Bun.spawnSync([process.execPath, "src/cli/main.ts", ...args], {
    cwd: path.resolve(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENT1_LOG_LEVEL: "error" },
  })
}

function json<T>(value: Uint8Array): T {
  return JSON.parse(value.toString()) as T
}

describe("CLI service flow", () => {
  test("starts, shows status, creates a session, shows the password, and stops", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-cli-service-"))
    dirs.push(dir)
    try {
      const start = cli(["service", "start", "--data-dir", dir, "--port", "0", "--json"])
      expect(start.exitCode).toBe(0)
      const started = json<{ status: string; pid: number; url: string }>(start.stdout)
      expect(started.status).toBe("running")
      expect(started.pid).toBeGreaterThan(0)

      const status = cli(["service", "status", "--data-dir", dir, "--json"])
      expect(status.exitCode).toBe(0)
      expect(json<{ status: string }>(status.stdout).status).toBe("running")

      const created = cli(["session", "create", "--title", "CLI session", "--data-dir", dir, "--json"])
      expect(created.exitCode).toBe(0)
      expect(json<{ session: { title: string } }>(created.stdout).session.title).toBe("CLI session")

      const listed = cli(["session", "list", "--data-dir", dir, "--json"])
      expect(listed.exitCode).toBe(0)
      expect(json<{ sessions: unknown[] }>(listed.stdout).sessions).toHaveLength(1)

      const shown = cli(["auth", "show", "--data-dir", dir, "--json"])
      expect(shown.exitCode).toBe(0)
      const shownPassword = json<{ password: string }>(shown.stdout).password
      const stored = await new SecretStore(resolveConfig({ ...process.env, AGENT1_DATA_DIR: dir }).secretsPath).readPassword()
      expect(stored).toBeDefined()
      expect(shownPassword).toBe(stored ?? "")

      const stopped = cli(["service", "stop", "--data-dir", dir, "--json"])
      expect(stopped.exitCode).toBe(0)
      expect(json<{ stopped: boolean }>(stopped.stdout).stopped).toBe(true)
      expect(existsSync(path.join(dir, "state", "service.json"))).toBe(false)

      const setPort = cli(["service", "set", "port", "32123", "--data-dir", dir, "--json"])
      expect(setPort.exitCode).toBe(0)
      expect(json<{ port: number; restartRequired: boolean }>(setPort.stdout)).toEqual({
        port: 32123,
        restartRequired: false,
      })
      const serviceConfig = readServiceConfig(
        resolveConfig({ ...process.env, AGENT1_DATA_DIR: dir }).serviceConfigPath,
      )
      expect(serviceConfig?.port).toBe(32123)
    } finally {
      const config = resolveConfig({ ...process.env, AGENT1_DATA_DIR: dir })
      const state = readState(config.statePath)
      if (state) {
        try {
          process.kill(state.pid)
        } catch {
          // Best effort.
        }
      }
    }
  }, 45_000)
})
