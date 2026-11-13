import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { packagedWebRoot } from "./runtime-layout"
import { defaultServicePort, readServiceConfig } from "./service-config"
import { VERSION } from "./version"

export const PRODUCT_NAME = "Agent-1"
export const AUTH_USERNAME = "agent-1"
export const PHASE = "Phase 8G - Stable service identity and browser pairing"

export interface AppConfig {
  readonly dataDir: string
  readonly dbPath: string
  readonly backupDir: string
  readonly secretsDir: string
  readonly secretsPath: string
  readonly modelSecretsPath: string
  readonly configDir: string
  readonly serviceConfigPath: string
  readonly stateDir: string
  readonly statePath: string
  readonly lockPath: string
  readonly logsDir: string
  readonly checkpointsDir: string
  readonly logPath: string
  readonly webRoot: string
  readonly host: string
  readonly port: number
  readonly portSource: "env" | "config" | "default"
  readonly allowedHosts: readonly string[]
  readonly publicUrl?: string
  readonly secureCookies: boolean
  readonly version: string
  readonly authUsername: string
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Agent-1")
  }
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "agent-1")
}

export function ensureDataDirs(config: AppConfig): void {
  for (const dir of [
    config.dataDir,
    config.backupDir,
    config.secretsDir,
    config.configDir,
    config.stateDir,
    config.logsDir,
    config.checkpointsDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.AGENT1_DATA_DIR ?? defaultDataDir(env))
  const configDir = path.join(dataDir, "config")
  const serviceConfigPath = path.join(configDir, "service.json")
  const portRaw = env.AGENT1_PORT
  let port: number
  let portSource: AppConfig["portSource"]
  if (portRaw !== undefined) {
    port = Number(portRaw)
    portSource = "env"
  } else {
    const persisted = readServiceConfig(serviceConfigPath)
    port = persisted?.port ?? defaultServicePort()
    portSource = persisted?.port === undefined ? "default" : "config"
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`AGENT1_PORT must be an integer between 0 and 65535 (got ${portRaw ?? port})`)
  }
  if (portSource !== "env" && port < 1) {
    throw new Error(`Agent-1 service config port must be between 1 and 65535 (got ${port})`)
  }

  const publicUrl = env.AGENT1_PUBLIC_URL?.replace(/\/+$/, "")
  const allowedHosts = (env.AGENT1_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
  if (publicUrl) {
    try {
      const host = new URL(publicUrl).hostname.toLowerCase()
      if (host) allowedHosts.push(host)
    } catch {
      throw new Error(`AGENT1_PUBLIC_URL is not a valid URL: ${publicUrl}`)
    }
  }

  return {
    dataDir,
    dbPath: path.join(dataDir, "agent-1.db"),
    backupDir: path.join(dataDir, "backups"),
    secretsDir: path.join(dataDir, "secrets"),
    secretsPath: path.join(dataDir, "secrets", "auth.dpapi.json"),
    modelSecretsPath: path.join(dataDir, "secrets", "model-keys.dpapi.json"),
    configDir,
    serviceConfigPath,
    stateDir: path.join(dataDir, "state"),
    statePath: path.join(dataDir, "state", "service.json"),
    lockPath: path.join(dataDir, "state", "service.lock"),
    logsDir: path.join(dataDir, "logs"),
    logPath: path.join(dataDir, "logs", "service.log"),
    checkpointsDir: path.join(dataDir, "checkpoints"),
    webRoot: env.AGENT1_WEB_ROOT
      ? path.resolve(env.AGENT1_WEB_ROOT)
      : packagedWebRoot() ?? path.resolve(import.meta.dir, "..", "..", "web", "dist"),
    host: "127.0.0.1",
    port,
    portSource,
    allowedHosts,
    ...(publicUrl ? { publicUrl } : {}),
    secureCookies: env.AGENT1_SECURE_COOKIES === "1",
    version: VERSION,
    authUsername: AUTH_USERNAME,
  }
}
