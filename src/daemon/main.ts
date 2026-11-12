import { ensureDataDirs, PHASE, resolveConfig } from "../core/config"
import { Logger, resolveLogLevel } from "../core/log"
import { Database } from "../db/database"
import { MemoryReviewService } from "../memory/memory-review-service"
import { MemoryService } from "../memory/memory-service"
import { SessionSearchService } from "../memory/session-search-service"
import { AuthService } from "../auth/auth-service"
import { SecretStore } from "../auth/secret-store"
import { EventService } from "../events/service"
import { ModelService } from "../models/model-service"
import { ProviderService } from "../models/provider-service"
import { PermissionService } from "../permissions/permission-service"
import { SmartJudge } from "../approvals/smart-judge"
import { SettingsService } from "../settings/settings-service"
import { PathPolicy } from "../tools/path-policy"
import { ToolService } from "../tools/tool-service"
import { CheckpointManager } from "../checkpoints/manager"
import { TurnBus } from "../agent/turn-bus"
import { TurnService } from "../agent/turn-service"
import { RemoteService } from "../remote/remote-service"
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
  let remoteService: RemoteService | undefined
  let approvalExpiryTimer: ReturnType<typeof setInterval> | undefined

  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return
    stopping = true
    if (approvalExpiryTimer) clearInterval(approvalExpiryTimer)
    approvalExpiryTimer = undefined
    logger.info("service.stopping", { reason })
    try {
      await events?.append("service.stopping", null, { reason })
    } catch {
      // The database may already be closing.
    }
    await remoteService?.stop()
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
    const providers = new ProviderService(db, logger, config.modelSecretsPath)
    await providers.initialize()
    const models = new ModelService(providers)
    const permissions = new PermissionService(db, logger, events)
    const smartJudge = new SmartJudge(models, logger, db)
    permissions.setSmartJudge((input) => smartJudge.judge(input))
    await permissions.expireApprovals()
    approvalExpiryTimer = setInterval(() => {
      void permissions.expireApprovals().catch((error) => {
        logger.warn("approval.expiry_sweep_failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, 15_000)
    const pathPolicy = new PathPolicy(db, logger, config.dataDir)
    const checkpoints = new CheckpointManager(db, logger, config.checkpointsDir, events)
    await checkpoints.initialize()
    const settings = new SettingsService(db, permissions, providers, checkpoints)
    const memory = new MemoryService(db)
    const memoryReview = new MemoryReviewService(db, events, models, memory, logger)
    await memoryReview.initialize()
    const sessionSearch = new SessionSearchService(db)
    const tools = new ToolService(pathPolicy, checkpoints, logger, memory, sessionSearch)
    const turnBus = new TurnBus()
    const turns = new TurnService(
      db,
      events,
      models,
      providers,
      permissions,
      tools,
      turnBus,
      logger,
      memory,
      memoryReview,
    )
    void turns.attachments.prune()
    remoteService = new RemoteService(db, logger, () => `127.0.0.1:${server?.port ?? 0}`)

    const app = new App({
      config,
      db,
      auth,
      events,
      models,
      providers,
      turns,
      turnBus,
      permissions,
      checkpoints,
      settings,
      tools,
      memory,
      sessionSearch,
      remote: remoteService,
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
    await remoteService.initialize()
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
