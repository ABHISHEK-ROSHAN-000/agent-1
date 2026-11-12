import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultDataDir, resolveConfig } from "./config"
import { defaultServicePort, updateServiceConfig } from "./service-config"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-1-config-"))
  dirs.push(dir)
  return dir
}

test("config resolves the Windows data directory and persisted service paths", () => {
  const dir = tempDir()
  const config = resolveConfig({ ...process.env, AGENT1_DATA_DIR: dir })
  expect(config.dataDir).toBe(path.resolve(dir))
  expect(config.dbPath).toBe(path.join(config.dataDir, "agent-1.db"))
  expect(config.configDir).toBe(path.join(config.dataDir, "config"))
  expect(config.serviceConfigPath).toBe(path.join(config.dataDir, "config", "service.json"))
  expect(config.statePath).toBe(path.join(config.dataDir, "state", "service.json"))
  expect(config.host).toBe("127.0.0.1")
  expect(config.port).toBe(defaultServicePort())
  expect(config.portSource).toBe("default")
})

test("config reads a persisted service port", () => {
  const dir = tempDir()
  const initial = resolveConfig({ ...process.env, AGENT1_DATA_DIR: dir })
  updateServiceConfig(initial.serviceConfigPath, { port: 32123 })
  const config = resolveConfig({ ...process.env, AGENT1_DATA_DIR: dir })
  expect(config.port).toBe(32123)
  expect(config.portSource).toBe("config")
})

test("an explicit AGENT1_PORT overrides the persisted service port", () => {
  const dir = tempDir()
  const initial = resolveConfig({ ...process.env, AGENT1_DATA_DIR: dir })
  updateServiceConfig(initial.serviceConfigPath, { port: 32123 })
  const config = resolveConfig({ ...process.env, AGENT1_DATA_DIR: dir, AGENT1_PORT: "0" })
  expect(config.port).toBe(0)
  expect(config.portSource).toBe("env")
})

test("config accepts allowed hosts and a public URL", () => {
  const config = resolveConfig({
    ...process.env,
    AGENT1_DATA_DIR: "D:\\tmp\\agent-1",
    AGENT1_ALLOWED_HOSTS: "agent-1.tailnet.test, another.test",
    AGENT1_PUBLIC_URL: "https://agent-1.example.test/",
    AGENT1_SECURE_COOKIES: "1",
  })
  expect(config.allowedHosts).toContain("agent-1.tailnet.test")
  expect(config.allowedHosts).toContain("another.test")
  expect(config.allowedHosts).toContain("agent-1.example.test")
  expect(config.publicUrl).toBe("https://agent-1.example.test")
  expect(config.secureCookies).toBe(true)
})

test("config rejects an invalid port", () => {
  expect(() =>
    resolveConfig({ ...process.env, AGENT1_DATA_DIR: "D:\\tmp\\agent-1", AGENT1_PORT: "70000" }),
  ).toThrow("AGENT1_PORT")
})

test("default data dir is under LOCALAPPDATA on Windows", () => {
  expect(defaultDataDir({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" })).toBe(
    path.join("C:\\Users\\test\\AppData\\Local", "Agent-1"),
  )
})
