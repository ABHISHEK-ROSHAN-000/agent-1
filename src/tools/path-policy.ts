import { existsSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { Database } from "../db/database"
import type { Logger } from "../core/log"

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathPolicyError"
  }
}

const PROJECT_MARKERS = [
  ".git",
  "pyproject.toml",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "Makefile",
  "pom.xml",
  ".hg",
  "Gemfile",
] as const

const PROTECTED_INSTRUCTION_FILES = new Set([
  "agents.md",
  "claude.md",
  "skill.md",
  ".cursorrules",
])

const ENV_READ_FILES = new Set([".env", ".envrc"])

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalizedCandidate = path.resolve(candidate)
  if (process.platform === "win32") {
    const rootLower = normalizedRoot.toLowerCase()
    const candidateLower = normalizedCandidate.toLowerCase()
    return candidateLower === rootLower || candidateLower.startsWith(`${rootLower}${path.sep}`)
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
}

function unsafeWindowsName(pathValue: string): boolean {
  if (process.platform !== "win32") return false
  const absolute = path.resolve(pathValue)
  const withoutDrive = /^[A-Za-z]:/.test(absolute) ? absolute.slice(2) : absolute
  if (withoutDrive.includes(":")) return true
  return /[. ]$/.test(path.basename(absolute))
}

function realPathFor(pathValue: string): string {
  const absolute = path.resolve(pathValue)
  let current = absolute
  const suffix: string[] = []
  while (!existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    suffix.unshift(path.basename(current))
    current = parent
  }
  try {
    const resolved = existsSync(current) ? realpathSync.native(current) : current
    return path.resolve(resolved, ...suffix)
  } catch {
    return absolute
  }
}

export class PathPolicy {
  private readonly protectedRoots: string[]

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    dataDir: string,
  ) {
    const roots = [dataDir]
    for (const envName of ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]) {
      const value = process.env[envName]
      if (value) roots.push(value)
    }
    const home = process.env.USERPROFILE
    if (home) roots.push(path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".config"))
    this.protectedRoots = roots.map((root) => path.resolve(root))
  }

  resolve(input: string): string {
    return realPathFor(input)
  }

  isProtected(input: string): boolean {
    const resolved = this.resolve(input)
    return this.protectedRoots.some((root) => isWithin(root, resolved))
  }

  isReadDenied(input: string): boolean {
    const resolved = this.resolve(input)
    if (unsafeWindowsName(resolved)) return true
    if (this.isProtected(resolved)) return true
    const base = path.basename(resolved).toLowerCase()
    return ENV_READ_FILES.has(base) || base.startsWith(".env.")
  }

  isProtectedInstruction(input: string): boolean {
    const resolved = this.resolve(input)
    const base = path.basename(resolved).toLowerCase()
    if (PROTECTED_INSTRUCTION_FILES.has(base)) return true
    const normalized = resolved.replaceAll("\\", "/").toLowerCase()
    return normalized.endsWith("/.github/copilot-instructions.md")
  }

  async writeSafeRoot(): Promise<string | null> {
    const configured =
      (await this.db.getSetting("approval.write_safe_root")) ??
      process.env.AGENT1_WRITE_SAFE_ROOT ??
      ""
    const value = configured.trim()
    return value ? this.resolve(value) : null
  }

  async requireWritable(input: string): Promise<string> {
    const resolved = this.resolve(input)
    if (unsafeWindowsName(resolved)) throw new PathPolicyError("Unsafe Windows path or alternate data stream")
    if (this.isProtected(resolved)) throw new PathPolicyError("Path is protected")
    const safeRoot = await this.writeSafeRoot()
    if (safeRoot && !isWithin(safeRoot, resolved)) {
      throw new PathPolicyError(`Path is outside the write-safe root: ${safeRoot}`)
    }
    return resolved
  }

  async isWritable(input: string): Promise<boolean> {
    try {
      await this.requireWritable(input)
      return true
    } catch {
      return false
    }
  }

  rootForPath(input: string): string {
    const resolved = this.resolve(input)
    let candidate = resolved
    try {
      if (!statSync(resolved).isDirectory()) candidate = path.dirname(resolved)
    } catch {
      candidate = path.dirname(resolved)
    }
    const home = process.env.USERPROFILE ? this.resolve(process.env.USERPROFILE) : ""
    const broad = new Set<string>()
    if (home) {
      let current = home
      while (current) {
        broad.add(process.platform === "win32" ? current.toLowerCase() : current)
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
    }
    let current = candidate
    while (current !== path.dirname(current)) {
      const key = process.platform === "win32" ? current.toLowerCase() : current
      if (broad.has(key)) break
      if (PROJECT_MARKERS.some((marker) => existsSync(path.join(current, marker)))) return current
      current = path.dirname(current)
    }
    return candidate
  }
}
