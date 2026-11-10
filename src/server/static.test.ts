import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { serveWeb } from "./static"

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-1-web-root-"))
  roots.push(root)
  mkdirSync(path.join(root, "assets"))
  writeFileSync(path.join(root, "index.html"), "<!doctype html><title>Agent-1</title>", "utf8")
  writeFileSync(path.join(root, "assets", "app.js"), "console.log('agent')", "utf8")
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("serves the app shell and immutable hashed assets with security headers", () => {
  const root = makeRoot()
  const shell = serveWeb(root, "/login")
  expect(shell.status).toBe(200)
  expect(shell.headers.get("content-type")).toContain("text/html")
  expect(shell.headers.get("cache-control")).toBe("no-store")
  expect(shell.headers.get("content-security-policy")).toContain("script-src 'self'")
  expect(shell.headers.get("content-security-policy")).toContain("img-src 'self' data: blob:")
  expect(shell.headers.get("content-security-policy")).toContain("worker-src 'self' blob:")

  const asset = serveWeb(root, "/assets/app.js")
  expect(asset.status).toBe(200)
  expect(asset.headers.get("content-type")).toContain("text/javascript")
  expect(asset.headers.get("cache-control")).toContain("immutable")
})

test("rejects traversal, malformed paths, and missing assets instead of falling back silently", () => {
  const root = makeRoot()
  expect(serveWeb(root, "/../secret.txt").status).toBe(404)
  expect(serveWeb(root, "/assets/missing.js").status).toBe(404)
  expect(serveWeb(root, "/%E0%A4%A").status).toBe(400)
})

test("returns a clear placeholder when the web build is absent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-1-web-empty-"))
  roots.push(root)
  const response = serveWeb(root, "/")
  expect(response.status).toBe(503)
  expect(response.headers.get("content-type")).toContain("text/html")
})
