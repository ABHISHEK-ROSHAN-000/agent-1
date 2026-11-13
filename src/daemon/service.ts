import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { AppConfig } from "../core/config"
import { packagedDaemon } from "../core/runtime-layout"
import { ensureServiceConfig } from "../core/service-config"
import { AgentOneClient } from "../client/client"
import { isProcessAlive } from "./lock"
import { readState, removeState } from "./state"
import type { ServiceState } from "../shared/types"

function repoRoot(): string {
  return path.resolve(import.meta.dir, "../..")
}

function tailLog(logPath: string, lines = 30): string {
  if (!existsSync(logPath)) return ""
  try {
    return readFileSync(logPath, "utf8").split(/\r?\n/).slice(-lines).join("\n")
  } catch {
    return ""
  }
}

function lockPid(lockPath: string): number {
  try {
    return Number(readFileSync(lockPath, "utf8").trim())
  } catch {
    return 0
  }
}

async function health(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1_500)
  try {
    const response = await fetch(`${url}/v1/health`, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export interface StartResult {
  readonly state: ServiceState
  readonly alreadyRunning: boolean
}

export async function startService(config: AppConfig): Promise<StartResult> {
  const active = readState(config.statePath)
  if (active && isProcessAlive(active.pid)) {
    if (await health(active.url)) return { state: active, alreadyRunning: true }
    throw new Error(`Agent-1 state exists for pid ${active.pid}, but it is not healthy`)
  }
  if (active) removeState(config.statePath)

  const heldPid = lockPid(config.lockPath)
  if (heldPid > 0 && isProcessAlive(heldPid)) {
    throw new Error(`Agent-1 is already running (pid ${heldPid})`)
  }

  if (config.portSource !== "env" && config.port > 0) {
    ensureServiceConfig(config.serviceConfigPath, config.port)
  }

  const packaged = packagedDaemon()
  const daemon = packaged ?? path.join(repoRoot(), "src", "daemon", "main.ts")
  const child = spawn(packaged ?? process.execPath, packaged ? [] : [daemon], {
    cwd: packaged ? path.dirname(packaged) : repoRoot(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AGENT1_DATA_DIR: config.dataDir,
      AGENT1_PORT: String(config.port),
    },
  })
  child.unref()

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const state = readState(config.statePath)
    if (state && isProcessAlive(state.pid) && (await health(state.url))) {
      return { state, alreadyRunning: false }
    }
    if (child.exitCode !== null) break
    await Bun.sleep(150)
  }

  const log = tailLog(config.logPath)
  if (/EADDRINUSE|address already in use|port .* in use/i.test(log)) {
    throw new Error(
      `Agent-1 could not bind to port ${config.port} because it is already in use. Set another port with "agent-1 service set port <port>" and restart.`,
    )
  }
  const reason = child.exitCode !== null ? `Agent-1 exited during startup (code ${child.exitCode}).` : "Agent-1 did not start within 20 seconds."
  throw new Error(`${reason}${log ? `\n\n${log}` : ""}`)
}

export interface StopResult {
  readonly stopped: boolean
  readonly forced: boolean
  readonly pid?: number
}

export async function stopService(config: AppConfig, password: string): Promise<StopResult> {
  const state = readState(config.statePath)
  if (!state) return { stopped: false, forced: false }
  if (!isProcessAlive(state.pid)) {
    removeState(config.statePath)
    return { stopped: false, forced: false, pid: state.pid }
  }

  const client = new AgentOneClient({ baseUrl: state.url, password, timeoutMs: 5_000 })
  try {
    await client.stop()
  } catch (error) {
    if (!isProcessAlive(state.pid)) {
      removeState(config.statePath)
      return { stopped: true, forced: false, pid: state.pid }
    }
    throw error
  }

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid) && !existsSync(config.statePath)) {
      removeState(config.statePath)
      return { stopped: true, forced: false, pid: state.pid }
    }
    await Bun.sleep(100)
  }

  try {
    process.kill(state.pid)
  } catch {
    // Process may have exited between checks.
  }
  await Bun.sleep(500)
  removeState(config.statePath)
  return { stopped: true, forced: true, pid: state.pid }
}

export interface StatusResult {
  readonly status: "running" | "stopped" | "stale"
  readonly state?: ServiceState
  readonly healthy?: boolean
}

export async function serviceStatus(config: AppConfig): Promise<StatusResult> {
  const state = readState(config.statePath)
  if (!state) return { status: "stopped" }
  if (!isProcessAlive(state.pid)) return { status: "stale", state }
  return { status: "running", state, healthy: await health(state.url) }
}
