import { expect, test } from "bun:test"
import path from "node:path"
import { defaultDataDir, resolveConfig } from "./config"

test("config resolves the Windows data directory and paths", () => {
  const config = resolveConfig({ ...process.env, AGENT1_DATA_DIR: "D:\\tmp\\agent-1" })
  expect(config.dataDir).toBe(path.resolve("D:\\tmp\\agent-1"))
  expect(config.dbPath).toBe(path.join(config.dataDir, "agent-1.db"))
  expect(config.statePath).toBe(path.join(config.dataDir, "state", "service.json"))
  expect(config.host).toBe("127.0.0.1")
  expect(config.port).toBe(0)
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
