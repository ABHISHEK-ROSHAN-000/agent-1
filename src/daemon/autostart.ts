import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { packagedDaemon } from "../core/runtime-layout"

export const DEFAULT_ENTRY_NAME = "Agent-1"

export interface AutostartStatus {
  readonly enabled: boolean
  readonly entryName: string
  readonly path: string
}

function repoRoot(): string {
  return path.resolve(import.meta.dir, "../..")
}

export function autostartCommand(): { executable: string; script?: string } {
  const packaged = packagedDaemon()
  if (packaged) return { executable: packaged }
  return {
    executable: process.execPath,
    script: path.join(repoRoot(), "src", "daemon", "main.ts"),
  }
}

function startupDir(): string {
  return path.join(
    process.env.APPDATA ??
      path.join(process.env.USERPROFILE ?? process.cwd(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  )
}

function entryPath(entryName: string): string {
  return path.join(startupDir(), `${entryName}.vbs`)
}

function escapeVbs(value: string): string {
  return value.replace(/"/g, '""')
}

export function autostartStatus(entryName = DEFAULT_ENTRY_NAME): AutostartStatus {
  const file = entryPath(entryName)
  return { enabled: existsSync(file), entryName, path: file }
}

export function enableAutostart(entryName = DEFAULT_ENTRY_NAME): AutostartStatus {
  if (process.platform !== "win32") throw new Error("Autostart is only supported on Windows")
  const directory = startupDir()
  mkdirSync(directory, { recursive: true })
  const command = autostartCommand()
  const file = entryPath(entryName)
  const run = command.script
    ? `shell.Run """${escapeVbs(command.executable)}"" ""${escapeVbs(command.script)}""", 0, False`
    : `shell.Run """${escapeVbs(command.executable)}""", 0, False`
  const script = [
    'Set shell = CreateObject("WScript.Shell")',
    run,
    "",
  ].join("\r\n")
  writeFileSync(file, script, { encoding: "utf8", mode: 0o600 })
  return autostartStatus(entryName)
}

export function disableAutostart(entryName = DEFAULT_ENTRY_NAME): AutostartStatus {
  if (process.platform !== "win32") return { enabled: false, entryName, path: entryPath(entryName) }
  const file = entryPath(entryName)
  if (existsSync(file)) rmSync(file, { force: true })
  return autostartStatus(entryName)
}
