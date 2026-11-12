import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "../db/database"
import { Logger } from "../core/log"
import { readServiceConfig, writeServiceConfig } from "../core/service-config"
import { RemoteService } from "./remote-service"

test("persists the remote route in service config across restarts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-remote-config-"))
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  const configPath = path.join(dir, "config", "service.json")
  writeServiceConfig(configPath, { version: 1, port: 28895 })

  try {
    const first = new RemoteService(db, new Logger(), () => "127.0.0.1:28895", configPath)
    await first.initialize()
    const initial = await first.status()
    expect(initial.route).toMatch(/^[a-f0-9]{16}$/)

    const persisted = readServiceConfig(configPath)
    expect(persisted?.port).toBe(28895)
    expect(persisted?.remote?.route).toBe(initial.route)
    expect(persisted?.remote?.enabled).toBe(false)

    await first.accept()
    expect(readServiceConfig(configPath)?.remote?.accepted).toBe(true)

    const restarted = new RemoteService(db, new Logger(), () => "127.0.0.1:28895", configPath)
    await restarted.initialize()
    expect((await restarted.status()).route).toBe(initial.route)
  } finally {
    await db.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
