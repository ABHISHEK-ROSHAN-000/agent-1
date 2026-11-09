import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import path from "node:path"

export class AlreadyRunningError extends Error {
  constructor(pid: number) {
    super(`Agent-1 is already running (pid ${pid})`)
    this.name = "AlreadyRunningError"
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "EPERM"
  }
}

export function acquireLock(lockPath: string): () => void {
  mkdirSync(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600)
      try {
        writeSync(fd, `${process.pid}\n`)
      } finally {
        closeSync(fd)
      }
      return () => {
        try {
          rmSync(lockPath, { force: true })
        } catch {
          // Best effort.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let pid = 0
      try {
        pid = Number(readFileSync(lockPath, "utf8").trim())
      } catch {
        pid = 0
      }
      if (pid > 0 && isProcessAlive(pid)) throw new AlreadyRunningError(pid)
      try {
        rmSync(lockPath, { force: true })
      } catch {
        // Retry once.
      }
    }
  }
  throw new Error("Could not acquire the Agent-1 service lock")
}
