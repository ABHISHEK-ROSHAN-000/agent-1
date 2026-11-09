import { expect, test } from "bun:test"
import path from "node:path"
import { VERSION } from "../core/version"

const cli = path.join(import.meta.dir, "main.ts")
const bin = path.join(import.meta.dir, "..", "..", "bin", "agent-1.js")

function run(entrypoint: string, args: readonly string[]) {
  return Bun.spawnSync([process.execPath, entrypoint, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
}

test("CLI prints help and version", () => {
  const help = run(cli, ["--help"])
  expect(help.exitCode).toBe(0)
  expect(help.stdout.toString()).toContain("Usage: agent-1")

  const version = run(cli, ["--version"])
  expect(version.exitCode).toBe(0)
  expect(version.stdout.toString()).toBe(`agent-1 ${VERSION}\n`)
})

test("bin launcher forwards to the CLI", () => {
  const result = run(bin, ["--version"])
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toBe(`agent-1 ${VERSION}\n`)
})

test("unknown commands fail with help", () => {
  const result = run(cli, ["not-a-command"])
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain("Unknown command: not-a-command")
  expect(result.stderr.toString()).toContain("Usage: agent-1")
})
