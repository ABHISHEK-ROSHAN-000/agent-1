import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentOneClient } from "../client/client"
import { SecretStore } from "../auth/secret-store"
import { readState } from "../daemon/state"
import type { ServiceState } from "../shared/types"

export async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(intervalMs)
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  )
}

export async function removeTree(dir: string | undefined): Promise<void> {
  if (!dir) return
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // A test cleanup failure should not hide the actual test result.
  }
}

export interface TestDaemon {
  readonly dir: string
  readonly state: ServiceState
  readonly password: string
  readonly client: AgentOneClient
  readonly child: ChildProcess
  stop(): Promise<void>
  cleanup(): Promise<void>
  logTail(lines?: number): Promise<string>
}

export interface StartTestDaemonOptions {
  readonly env?: Record<string, string>
  readonly dataDir?: string
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.off("exit", onExit)
    }
    const onExit = () => {
      cleanup()
      resolve()
    }
    child.once("exit", onExit)
  })
}

export async function startTestDaemon(options: StartTestDaemonOptions = {}): Promise<TestDaemon> {
  const dir = options.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), "agent-1-test-")))
  const daemonPath = path.join(import.meta.dir, "..", "daemon", "main.ts")
  const child = spawn(process.execPath, [daemonPath], {
    cwd: path.join(import.meta.dir, "..", ".."),
    env: {
      ...process.env,
      AGENT1_DATA_DIR: dir,
      AGENT1_PORT: "0",
      AGENT1_LOG_LEVEL: "error",
      ...options.env,
    },
    stdio: "ignore",
    windowsHide: true,
  })

  try {
    const state = await waitFor(() => {
      const current = readState(path.join(dir, "state", "service.json"))
      return current && current.pid > 0 ? current : undefined
    })
    const password = await waitFor(() =>
      new SecretStore(path.join(dir, "secrets", "auth.dpapi.json")).readPassword(),
    )
    const client = new AgentOneClient({ baseUrl: state.url, password, timeoutMs: 10_000 })
    await waitFor(async () => {
      try {
        await client.health()
        return true
      } catch {
        return false
      }
    })

    const stop = async () => {
      try {
        await client.stop()
      } catch {
        // The daemon may already be gone.
      }
      await waitForExit(child, 3_000)
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill()
        } catch {
          // Best effort.
        }
        await waitForExit(child, 2_000)
      }
    }

    const cleanup = async () => {
      await stop()
      await removeTree(dir)
    }

    return {
      dir,
      state,
      password,
      client,
      child,
      stop,
      cleanup,
      async logTail(lines = 40) {
        try {
          return (await readFile(path.join(dir, "logs", "service.log"), "utf8"))
            .split(/\r?\n/)
            .slice(-lines)
            .join("\n")
        } catch {
          return ""
        }
      },
    }
  } catch (error) {
    if (isAlive(child.pid)) child.kill()
    await waitForExit(child, 3_000)
    let details = ""
    try {
      details = (await readFile(path.join(dir, "logs", "service.log"), "utf8"))
        .split(/\r?\n/)
        .slice(-30)
        .join("\n")
    } catch {
      // Ignore.
    }
    await removeTree(dir)
    throw new Error(
      `Test daemon failed to start: ${error instanceof Error ? error.message : String(error)}${details ? `\n${details}` : ""}`,
    )
  }
}
