import { existsSync } from "node:fs"
import path from "node:path"

export function executableDir(): string {
  return path.dirname(process.execPath)
}

function sibling(name: string): string | undefined {
  const candidate = path.join(executableDir(), name)
  return existsSync(candidate) ? candidate : undefined
}

export function packagedDaemon(): string | undefined {
  return sibling("agent-1-daemon.exe")
}

export function packagedTui(): string | undefined {
  return sibling("agent-1-tui.exe")
}

export function packagedWebRoot(): string | undefined {
  const candidate = path.join(executableDir(), "resources", "web")
  return existsSync(path.join(candidate, "index.html")) ? candidate : undefined
}

export function isPackaged(): boolean {
  return packagedWebRoot() !== undefined || packagedDaemon() !== undefined || packagedTui() !== undefined
}
