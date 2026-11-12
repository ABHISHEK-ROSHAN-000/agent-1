import { randomBytes } from "node:crypto"
import { create, isValidRouteName, type OpenTunnelPromiseClient, type OpenTunnelConnection } from "@opentunnel/client"
import type { Database } from "../db/database"
import type { Logger } from "../core/log"
import { readServiceConfig, updateServiceConfig } from "../core/service-config"
import type { RemoteStatus, RemoteTunnelState } from "../shared/types"
import { startTunnelProxy, type TunnelProxy } from "./tunnel-proxy"

const REMOTE_ENABLED = "remote.enabled"
const REMOTE_ACCEPTED = "remote.accepted"
const REMOTE_ROUTE = "remote.route"

function newRoute(): string {
  let route = randomBytes(8).toString("hex")
  while (!isValidRouteName(route)) route = randomBytes(8).toString("hex")
  return route
}

function publicHost(url: string | undefined): string | undefined {
  if (!url) return
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return
  }
}

export class RemoteService {
  private client: OpenTunnelPromiseClient | undefined
  private connection: OpenTunnelConnection | undefined
  private proxy: TunnelProxy | undefined
  private abort: AbortController | undefined
  private enabled = false
  private accepted = false
  private route = ""
  private url: string | undefined
  private state: RemoteTunnelState = "off"
  private error: string | undefined
  private starting: Promise<void> | undefined

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly target: () => string,
    private readonly serviceConfigPath?: string,
  ) {}

  async initialize(): Promise<void> {
    const persisted = this.serviceConfigPath
      ? readServiceConfig(this.serviceConfigPath)?.remote
      : undefined
    this.enabled = persisted?.enabled ?? (await this.db.getSetting(REMOTE_ENABLED)) === "true"
    this.accepted = persisted?.accepted ?? (await this.db.getSetting(REMOTE_ACCEPTED)) === "true"
    const storedRoute = persisted?.route ?? (await this.db.getSetting(REMOTE_ROUTE)) ?? ""
    this.route = isValidRouteName(storedRoute) ? storedRoute : ""
    if (!this.route) {
      this.route = newRoute()
      await this.db.setSetting(REMOTE_ROUTE, this.route)
    }
    this.persist()
    if (this.enabled) void this.start()
  }

  private persist(): void {
    if (!this.serviceConfigPath) return
    updateServiceConfig(this.serviceConfigPath, {
      remote: {
        route: this.route,
        accepted: this.accepted,
        enabled: this.enabled,
      },
    })
  }

  async status(): Promise<RemoteStatus> {
    return {
      enabled: this.enabled,
      accepted: this.accepted,
      state: this.state,
      route: this.route,
      ...(this.url ? { url: this.url } : {}),
      ...(this.error ? { error: this.error } : {}),
      urls: this.url ? [this.url] : [],
    }
  }

  async accept(): Promise<void> {
    this.accepted = true
    await this.db.setSetting(REMOTE_ACCEPTED, "true")
    this.persist()
  }

  async enable(): Promise<RemoteStatus> {
    this.accepted = true
    this.enabled = true
    await this.db.setSetting(REMOTE_ACCEPTED, "true")
    await this.db.setSetting(REMOTE_ENABLED, "true")
    this.persist()
    void this.start()
    return this.status()
  }

  async disable(): Promise<RemoteStatus> {
    this.enabled = false
    await this.db.setSetting(REMOTE_ENABLED, "false")
    this.persist()
    await this.stop()
    return this.status()
  }

  async start(): Promise<void> {
    if (!this.enabled) return
    if (this.state === "ready" || this.state === "starting") return this.starting
    this.state = "starting"
    this.error = undefined
    this.abort = new AbortController()
    const abort = this.abort
    this.starting = (async () => {
      try {
        const target = this.target()
        const separator = target.lastIndexOf(":")
        const targetHost = separator > 0 ? target.slice(0, separator) : "127.0.0.1"
        const targetPort = Number(target.slice(separator + 1))
        if (!Number.isInteger(targetPort) || targetPort < 1) throw new Error("Local server port is not ready")
        await this.closeProxy()
        await this.closeClient()
        const proxy = await startTunnelProxy({ targetHost, targetPort, logger: this.logger })
        this.proxy = proxy
        if (abort.signal.aborted) {
          await proxy.close()
          this.proxy = undefined
          return
        }
        const client = create()
        this.client = client
        const connection = await client.tunnel.connect({
          routes: {
            [this.route]: {
              target: `127.0.0.1:${proxy.port}`,
              proxyProtocol: "v2",
            },
          },
          signal: abort.signal,
          onRouteConflict: "retry",
          onEvent: (event) => {
            if (event.type === "connection-opened") {
              this.logger.info("remote.connection_opened", { route: event.route })
            }
          },
        })
        if (abort.signal.aborted) {
          await connection.close()
          return
        }
        this.connection = connection
        this.url = connection.urls[this.route]
        this.state = this.url ? "ready" : "error"
        this.error = this.url ? undefined : "Remote tunnel did not expose a public URL"
        this.logger.info("remote.ready", { route: this.route })
        void connection.closed.then(() => {
          if (this.connection !== connection) return
          this.connection = undefined
          this.url = undefined
          if (this.state !== "off") {
            this.state = "error"
            this.error = "Remote tunnel disconnected"
          }
        })
      } catch (error) {
        await this.closeProxy()
        await this.closeClient()
        if (abort.signal.aborted) return
        this.state = "error"
        this.error = error instanceof Error ? error.message : String(error)
        this.logger.error("remote.start_failed", { error: this.error })
      } finally {
        this.starting = undefined
      }
    })()
    return this.starting
  }

  async stop(): Promise<void> {
    this.abort?.abort()
    this.abort = undefined
    const connection = this.connection
    this.connection = undefined
    this.url = undefined
    this.state = "off"
    this.error = undefined
    try {
      await connection?.close()
    } catch {
      // Best effort.
    }
    await this.closeClient()
    await this.closeProxy()
    this.starting = undefined
  }

  private async closeClient(): Promise<void> {
    const client = this.client
    this.client = undefined
    try {
      await client?.dispose()
    } catch {
      // Best effort.
    }
  }

  private async closeProxy(): Promise<void> {
    const proxy = this.proxy
    this.proxy = undefined
    try {
      await proxy?.close()
    } catch {
      // Best effort.
    }
  }

  allowedHosts(): string[] {
    const host = publicHost(this.url)
    return host ? [host] : []
  }

  isRemoteHost(host: string | null): boolean {
    if (!host) return false
    return this.allowedHosts().includes(host.toLowerCase().replace(/\.$/, ""))
  }

  publicUrl(): string | undefined {
    return this.url
  }
}
