import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_SERVICE_PORT,
  DEFAULT_SERVICE_PORT_WINDOWS,
  defaultServicePort,
  ensureServiceConfig,
  readServiceConfig,
  updateServiceConfig,
  writeServiceConfig,
} from "./service-config"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

function configPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-1-service-config-"))
  dirs.push(dir)
  return path.join(dir, "service.json")
}

describe("service config", () => {
  test("uses fixed Agent-1 channel ports distinct from OpenCode", () => {
    expect(DEFAULT_SERVICE_PORT_WINDOWS).toBe(0x70df)
    expect(DEFAULT_SERVICE_PORT).toBe(0xc0df)
    expect(defaultServicePort("win32")).toBe(28895)
    expect(defaultServicePort("linux")).toBe(49375)
  })

  test("persists and updates the service port atomically", () => {
    const file = configPath()
    expect(ensureServiceConfig(file, 28895)).toEqual({ version: 1, port: 28895 })
    expect(readServiceConfig(file)?.port).toBe(28895)
    updateServiceConfig(file, { port: 28896 })
    expect(readServiceConfig(file)).toEqual({ version: 1, port: 28896 })
    expect(readFileSync(file, "utf8")).toContain('"version": 1')
  })

  test("merges remote route state without dropping the port", () => {
    const file = configPath()
    writeServiceConfig(file, { version: 1, port: 28895 })
    updateServiceConfig(file, {
      remote: { route: "stable-route", accepted: true, enabled: false },
    })
    expect(readServiceConfig(file)).toEqual({
      version: 1,
      port: 28895,
      remote: { route: "stable-route", accepted: true, enabled: false },
    })
  })

  test("rejects invalid config", () => {
    const file = configPath()
    writeServiceConfig(file, { version: 1, port: 28895 })
    expect(() => updateServiceConfig(file, { port: 0 })).toThrow("between 1 and 65535")
    expect(() => writeServiceConfig(file, { port: 65536 })).toThrow("between 1 and 65535")
  })
})
