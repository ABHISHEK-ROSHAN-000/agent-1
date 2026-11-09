#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtime = process.versions.bun ? process.execPath : "bun"
const cli = path.join(root, "src", "cli", "main.ts")

const result = spawnSync(runtime, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
