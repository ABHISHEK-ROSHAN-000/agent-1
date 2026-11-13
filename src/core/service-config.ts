import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

// Agent-1 uses fixed channel ports so local apps can run side by side
// without contending for the same listener.
export const DEFAULT_SERVICE_PORT_WINDOWS = 0x70df
export const DEFAULT_SERVICE_PORT = 0xc0df

export interface PersistedRemoteConfig {
  readonly route?: string
  readonly accepted?: boolean
  readonly enabled?: boolean
}

export interface PersistedServiceConfig {
  readonly version?: 1
  readonly port?: number
  readonly remote?: PersistedRemoteConfig
}

export function defaultServicePort(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? DEFAULT_SERVICE_PORT_WINDOWS : DEFAULT_SERVICE_PORT
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535
}

function parseConfig(value: unknown, filePath: string): PersistedServiceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent-1 service config must be a JSON object: ${filePath}`)
  }
  const input = value as Record<string, unknown>
  const port = input.port
  if (port !== undefined && !validPort(port)) {
    throw new Error(`Agent-1 service config port must be between 1 and 65535: ${filePath}`)
  }

  let remote: PersistedRemoteConfig | undefined
  if (input.remote !== undefined) {
    if (!input.remote || typeof input.remote !== "object" || Array.isArray(input.remote)) {
      throw new Error(`Agent-1 service config remote must be an object: ${filePath}`)
    }
    const rawRemote = input.remote as Record<string, unknown>
    if (rawRemote.route !== undefined && typeof rawRemote.route !== "string") {
      throw new Error(`Agent-1 service config remote.route must be a string: ${filePath}`)
    }
    if (rawRemote.accepted !== undefined && typeof rawRemote.accepted !== "boolean") {
      throw new Error(`Agent-1 service config remote.accepted must be a boolean: ${filePath}`)
    }
    if (rawRemote.enabled !== undefined && typeof rawRemote.enabled !== "boolean") {
      throw new Error(`Agent-1 service config remote.enabled must be a boolean: ${filePath}`)
    }
    remote = {
      ...(typeof rawRemote.route === "string" ? { route: rawRemote.route } : {}),
      ...(typeof rawRemote.accepted === "boolean" ? { accepted: rawRemote.accepted } : {}),
      ...(typeof rawRemote.enabled === "boolean" ? { enabled: rawRemote.enabled } : {}),
    }
  }

  return {
    ...(input.version === 1 ? { version: 1 as const } : {}),
    ...(validPort(port) ? { port } : {}),
    ...(remote ? { remote } : {}),
  }
}

export function readServiceConfig(filePath: string): PersistedServiceConfig | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    return parseConfig(JSON.parse(readFileSync(filePath, "utf8")) as unknown, filePath)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Agent-1 service config")) throw error
    throw new Error(`Agent-1 service config is not valid JSON: ${filePath}`)
  }
}

export function writeServiceConfig(filePath: string, config: PersistedServiceConfig): void {
  const parsed = parseConfig(config, filePath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, ...parsed }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  renameSync(temporary, filePath)
}

export function updateServiceConfig(
  filePath: string,
  update: {
    readonly port?: number
    readonly remote?: PersistedRemoteConfig
  },
): PersistedServiceConfig {
  const current = readServiceConfig(filePath) ?? {}
  const next: PersistedServiceConfig = {
    version: 1,
    ...(update.port !== undefined ? { port: update.port } : current.port !== undefined ? { port: current.port } : {}),
    ...(update.remote !== undefined
      ? { remote: { ...current.remote, ...update.remote } }
      : current.remote
        ? { remote: current.remote }
        : {}),
  }
  writeServiceConfig(filePath, next)
  return next
}

export function ensureServiceConfig(filePath: string, port: number): PersistedServiceConfig {
  const existing = readServiceConfig(filePath)
  if (existing) return existing
  const config: PersistedServiceConfig = { version: 1, port }
  writeServiceConfig(filePath, config)
  return config
}
