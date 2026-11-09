import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import path from "node:path"

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const REDACTED = "[REDACTED]"
const SECRET_KEY = /password|secret|token|authorization|cookie|api[-_]?key/i
const BEARER = /(Basic|Bearer)\s+[A-Za-z0-9+/=_-]+/g
const API_KEY = /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g

function redact(value: unknown, key = "", depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]"
  if (SECRET_KEY.test(key)) return REDACTED
  if (typeof value === "string") {
    return value.replace(BEARER, "$1 [REDACTED]").replace(API_KEY, "[REDACTED]")
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, key, depth + 1))
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {}
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = redact(entryValue, entryKey, depth + 1)
    }
    return output
  }
  return value
}

export interface LoggerOptions {
  readonly level?: LogLevel
  readonly filePath?: string
  readonly console?: boolean
}

export class Logger {
  readonly level: LogLevel
  private readonly filePath?: string
  private readonly consoleEnabled: boolean

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info"
    this.filePath = options.filePath
    this.consoleEnabled = options.console ?? false
    if (this.filePath) mkdirSync(path.dirname(this.filePath), { recursive: true })
  }

  debug(event: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", event, fields)
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write("info", event, fields)
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", event, fields)
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write("error", event, fields)
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(redact(fields) as Record<string, unknown>),
    })
    if (this.consoleEnabled) {
      const stream = level === "error" || level === "warn" ? process.stderr : process.stdout
      stream.write(`${line}\n`)
    }
    if (this.filePath) {
      try {
        this.rotateIfNeeded()
        appendFileSync(this.filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 })
      } catch {
        // Logging must never take down the daemon.
      }
    }
  }

  private rotateIfNeeded(): void {
    if (!this.filePath || !existsSync(this.filePath)) return
    try {
      if (statSync(this.filePath).size > 5 * 1024 * 1024) {
        renameSync(this.filePath, `${this.filePath}.1`)
      }
    } catch {
      // Ignore rotation failures.
    }
  }
}

export function resolveLogLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "warn" || value === "error" ? value : "info"
}
