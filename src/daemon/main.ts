import { ensureDataDirs, PHASE, resolveConfig } from "../core/config"
import { Logger, resolveLogLevel } from "../core/log"
import { Database } from "../db/database"
import { AuthService } from "../auth/auth-service"
import { SecretStore } from "../auth/secret-store"
import { EventService } from "../events/service"
import { ModelService } from "../models/model-service"
import { PermissionService } from "../permissions/permission-service"
import { WorkspaceService } from "../tools/workspace-service"
import { JournalService } from "../tools/journal-service"
import { ToolService } from "../tools/tool-service"
import { TurnBus } from "../agent/turn-bus"
import { TurnService } from "../agent/turn-service"
import { App } from "../server/app"
import { acquireLock } from "./lock"
import { removeState, writeState } from "./state"
import type { ServiceState } from "../shared/types"

async function main(): Promise<void> {
  const config = resolveConfig()
  ensureDataDirs(config)
  const logger = new Logger({
    level: resolveLogLevel(process.env.AGENT1_LOG_LEVEL),
    filePath: config.logPath,
    console: false,
  })

  let releaseLock: (() => void) | undefined
  let db: Database | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  let events: EventService | undefined
  let stopping = false

  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return
    stopping = true
    logger.info("service.stopping", { reason })
    try {
      await events?.append("service.stopping", null, { reason })
    } catch {
      // The database may already be closing.
    }
    try {
      server?.stop(true)
    } catch {
      // Best effort.
    }
    try {
      await db?.close()
    } catch {
      // Best effort.
    }
    removeState(config.statePath)
    releaseLock?.()
    logger.info("service.stopped", { reason })
    process.exit(0)
  }

  try {
    releaseLock = acquireLock(config.lockPath)
    db = await Database.open({ dbPath: config.dbPath, backupDir: config.backupDir })
    const secrets = new SecretStore(config.secretsPath)
    const auth = new AuthService(db, secrets, logger)
    await auth.initialize()
    await auth.pruneExpired()
    events = new EventService(db, logger)
    const models = new ModelService(db, logger, config.modelSecretsPath)
    const permissions = new PermissionService(db, logger)
    await permissions.expireApprovals()
    const workspace = new WorkspaceService(db, logger, config.dataDir)
    const journal = new JournalService(db, logger)
    await journal.reconcile()
    const tools = new ToolService(workspace, journal, logger)
    const turnBus = new TurnBus()
    const turns = new TurnService(db, events, models, permissions, tools, turnBus, logger)

    const app = new App({
      config,
      db,
      auth,
      events,
      models,
      turns,
      turnBus,
      permissions,
      workspace,
      journal,
      tools,
      logger,
      startedAt: Date.now(),
      shutdown: (reason) => void shutdown(reason),
    })

    server = Bun.serve({
      hostname: config.host,
      port: config.port,
      idleTimeout: 120,
      fetch: app.fetch,
    })

    const port = server.port
    if (port === undefined) throw new Error("Bun server did not expose a port")
    const state: ServiceState = {
      pid: process.pid,
      port,
      url: `http://${config.host}:${port}`,
      version: config.version,
      phase: PHASE,
      startedAt: new Date().toISOString(),
    }
    writeState(config.statePath, state)
    await events.append("service.started", null, {
      version: config.version,
      phase: PHASE,
      port,
      pid: process.pid,
    })
    logger.info("service.started", {
      url: state.url,
      pid: process.pid,
      version: config.version,
    })
    void turns.recoverAll().catch((error) => {
      logger.error("turn.recovery_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  } catch (error) {
    logger.error("service.start_failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      server?.stop(true)
    } catch {
      // Best effort.
    }
    try {
      await db?.close()
    } catch {
      // Best effort.
    }
    removeState(config.statePath)
    releaseLock?.()
    process.exit(1)
  }

  process.on("SIGINT", () => void shutdown("sigint"))
  process.on("SIGTERM", () => void shutdown("sigterm"))
  process.on("exit", () => {
    removeState(config.statePath)
    releaseLock?.()
  })
  process.on("uncaughtException", (error) => {
    logger.error("service.uncaught_exception", { error: error.message })
    void shutdown("uncaught_exception")
  })
  process.on("unhandledRejection", (reason) => {
    logger.error("service.unhandled_rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    })
  })
}

void main()
