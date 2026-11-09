import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ServiceState } from "../shared/types"

export function readState(statePath: string): ServiceState | undefined {
  if (!existsSync(statePath)) return undefined
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ServiceState>
    if (
      typeof value.pid !== "number" ||
      typeof value.port !== "number" ||
      typeof value.url !== "string" ||
      typeof value.version !== "string" ||
      typeof value.phase !== "string" ||
      typeof value.startedAt !== "string"
    ) {
      return undefined
    }
    return {
      pid: value.pid,
      port: value.port,
      url: value.url,
      version: value.version,
      phase: value.phase,
      startedAt: value.startedAt,
    }
  } catch {
    return undefined
  }
}

export function writeState(statePath: string, state: ServiceState): void {
  mkdirSync(path.dirname(statePath), { recursive: true })
  const temporary = `${statePath}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  renameSync(temporary, statePath)
}

export function removeState(statePath: string): void {
  if (existsSync(statePath)) rmSync(statePath, { force: true })
}
