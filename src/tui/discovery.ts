import path from "node:path"
import { resolveConfig, type AppConfig } from "../core/config"
import { SecretStore } from "../auth/secret-store"
import { startService, serviceStatus } from "../daemon/service"
import { readState } from "../daemon/state"

export interface TuiBootstrap {
  readonly config: AppConfig
  readonly endpoint: string
  readonly password: string
}

export async function discoverTui(): Promise<TuiBootstrap> {
  const config = resolveConfig()
  let status = await serviceStatus(config)
  if (status.status !== "running" || !status.state || !status.healthy) {
    const started = await startService(config)
    status = { status: "running", state: started.state, healthy: true }
  }
  const state = status.state ?? readState(config.statePath)
  if (!state) throw new Error("Agent-1 daemon did not publish service.json")
  const password = await new SecretStore(config.secretsPath).readPassword()
  if (!password) {
    throw new Error(`Agent-1 password is unavailable at ${path.relative(config.dataDir, config.secretsPath)}`)
  }
  return { config, endpoint: state.url, password }
}
