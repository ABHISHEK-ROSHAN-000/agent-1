import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import net from "node:net"
import path from "node:path"
import { tool, type Tool } from "ai"
import { z } from "zod"
import type { Logger } from "../core/log"
import { sha256 } from "../core/ids"
import type { MemoryService } from "../memory/memory-service"
import { memoryToolInputSchema } from "../memory/memory-tool-schema"
import { MemoryError } from "../memory/types"
import type { ToolRisk } from "../shared/types"
import type { JournalService } from "./journal-service"
import { JournalError, sha256File } from "./journal-service"
import type { WorkspaceService } from "./workspace-service"
import { WorkspaceError } from "./workspace-service"

export interface ToolContext {
  readonly turnId?: string
  readonly sessionId?: string
  readonly toolCallId?: string
}

export interface ToolInfo {
  readonly name: string
  readonly action: string
  readonly description: string
  readonly risk: ToolRisk
  readonly readOnly: boolean
  readonly approvalRequired?: boolean
}

interface ToolEntry extends ToolInfo {
  readonly inputSchema: z.ZodType<unknown>
  execute(input: unknown, context: ToolContext): Promise<unknown>
}

const moveInput = z.object({
  from: z.string().min(1).max(4_000),
  to: z.string().min(1).max(4_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
})



const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split(".").map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase()
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    )
  }
  return true
}

async function assertPublicUrl(input: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error("URL is invalid")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed")
  }
  if (url.username || url.password) throw new Error("URL credentials are not allowed")
  const host = url.hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
    throw new Error("Private or metadata host is blocked")
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error("Private IP is blocked")
  const addresses = await lookup(host, { all: true, verbatim: true })
  if (addresses.length === 0) throw new Error("Host did not resolve")
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Private address is blocked")
  }
  return url
}

export class ToolService {
  private readonly entries: Map<string, ToolEntry>

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly journal: JournalService,
    private readonly logger: Logger,
    private readonly memory?: MemoryService,
  ) {
    this.entries = new Map()
    this.register({
      name: "test_echo",
      action: "tool.test_echo",
      description: "Echo a message. Read-only test tool.",
      risk: "read",
      readOnly: true,
      inputSchema: z.object({ message: z.string().min(1).max(2_000) }),
      execute: async (input) => {
        const parsed = z.object({ message: z.string().min(1).max(2_000) }).parse(input)
        return { echoed: parsed.message }
      },
    })
    this.register({
      name: "test_time",
      action: "tool.test_time",
      description: "Return the current UTC time. Read-only test tool.",
      risk: "read",
      readOnly: true,
      inputSchema: z.object({}),
      execute: async () => ({ now: new Date().toISOString() }),
    })
    this.register({
      name: "test_confirm",
      action: "tool.test_confirm",
      description: "Approval-gated Phase 3 test action with no side effects.",
      risk: "write",
      readOnly: false,
      inputSchema: z.object({ note: z.string().min(1).max(500) }),
      execute: async (input) => {
        const parsed = z.object({ note: z.string().min(1).max(500) }).parse(input)
        return { confirmed: true, note: parsed.note }
      },
    })
    this.register({
      name: "fs_list",
      action: "fs.list",
      description: "List a directory inside a workspace. Read-only.",
      risk: "read",
      readOnly: true,
      inputSchema: z.object({ path: z.string().min(1), limit: z.number().int().min(1).max(1_000).optional() }),
      execute: async (input) => this.fsList(input),
    })
    this.register({
      name: "fs_stat",
      action: "fs.stat",
      description: "Stat a file or directory. Read-only.",
      risk: "read",
      readOnly: true,
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async (input) => this.fsStat(input),
    })
    this.register({
      name: "fs_read",
      action: "fs.read",
      description: "Read a UTF-8 text file. Read-only and size-limited.",
      risk: "read",
      readOnly: true,
      inputSchema: z.object({ path: z.string().min(1), maxBytes: z.number().int().min(1).max(1_000_000).optional() }),
      execute: async (input) => this.fsRead(input),
    })
    this.register({
      name: "fs_search",
      action: "fs.search",
      description: "Search file names under a directory. Read-only.",
      risk: "read",
      readOnly: true,
      inputSchema: z.object({
        root: z.string().min(1),
        pattern: z.string().min(1).max(200),
        maxResults: z.number().int().min(1).max(500).optional(),
      }),
      execute: async (input) => this.fsSearch(input),
    })
    this.register({
      name: "fs_prepare_moves",
      action: "fs.prepare_moves",
      description: "Hash and validate a batch of file moves without changing anything.",
      risk: "read",
      readOnly: true,
      inputSchema: z.object({ root: z.string().min(1), moves: z.array(moveInput).min(1).max(5_000) }),
      execute: async (input) => this.fsPrepareMoves(input),
    })
    this.register({
      name: "fs_write",
      action: "fs.write",
      description: "Write a UTF-8 file inside a write-granted workspace.",
      risk: "write",
      readOnly: false,
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string().max(1_000_000),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      }),
      execute: async (input, context) => this.fsWrite(input, context),
    })
    this.register({
      name: "fs_mkdir",
      action: "fs.mkdir",
      description: "Create a directory inside a write-granted workspace.",
      risk: "write",
      readOnly: false,
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async (input, context) => this.fsMkdir(input, context),
    })
    this.register({
      name: "fs_apply_moves",
      action: "fs.apply_moves",
      description: "Apply an approved batch of file moves with a journal and crash resume.",
      risk: "write",
      readOnly: false,
      inputSchema: z.object({ root: z.string().min(1), moves: z.array(moveInput).min(1).max(5_000) }),
      execute: async (input, context) => this.fsApplyMoves(input, context),
    })
    this.register({
      name: "fs_undo",
      action: "fs.undo",
      description: "Undo a journaled file batch.",
      risk: "write",
      readOnly: false,
      inputSchema: z.object({ batchId: z.string().min(1).optional() }),
      execute: async (input) => this.fsUndo(input),
    })
    this.register({
      name: "fs_delete",
      action: "fs.delete",
      description: "Hard delete is disabled.",
      risk: "write",
      readOnly: false,
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async () => {
        throw new Error("Hard delete is disabled")
      },
    })
    this.register({
      name: "shell_exec",
      action: "shell.exec",
      description: "Run a shell command after exact-command approval.",
      risk: "shell",
      readOnly: false,
      inputSchema: z.object({
        command: z.string().min(1).max(8_000),
        cwd: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      }),
      execute: async (input) => this.shellExec(input),
    })
    this.register({
      name: "web_fetch",
      action: "web.fetch",
      description: "Fetch a public web page with SSRF protection.",
      risk: "external",
      readOnly: true,
      inputSchema: z.object({ url: z.string().min(1).max(4_000), maxChars: z.number().int().min(1_000).max(100_000).optional() }),
      execute: async (input) => this.webFetch(input),
    })
    this.register({
      name: "web_search",
      action: "web.search",
      description: "Search using the configured search provider.",
      risk: "external",
      readOnly: true,
      inputSchema: z.object({ query: z.string().min(1).max(500) }),
      execute: async (input) => this.webSearch(input),
    })
    if (this.memory) {
      this.register({
        name: "memory",
        action: "memory.write",
        description:
          "Maintain durable memory across sessions. Use target 'user' for identity and preferences, or 'memory' for environment facts and conventions. Send all changes for one target in one atomic operations array. Actions are add, patch, and remove; there is no read action because memory is injected into the prompt at session start.",
        risk: "write",
        readOnly: false,
        approvalRequired: false,
        inputSchema: memoryToolInputSchema,
        execute: async (input, context) => this.executeMemory(input, context),
      })
    }
  }

  private async executeMemory(input: unknown, context: ToolContext): Promise<unknown> {
    const memory = this.memory
    if (!memory) throw new Error("Memory is not available.")
    const parsed = memoryToolInputSchema.parse(input)
    try {
      const result = await memory.mutate({
        store: parsed.target,
        operations: parsed.operations,
        actor: "agent",
        sessionId: context.sessionId,
        turnId: context.turnId,
      })
      return {
        success: true,
        target: parsed.target,
        changed: result.changed,
        actions: result.actions,
        usage: result.usage,
        message: result.message,
      }
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error
      const details: Record<string, unknown> = {
        success: false,
        error: error.message,
        code: error.code,
      }
      if (error.details.currentEntries) details.current_entries = error.details.currentEntries
      if (error.details.usage) details.usage = error.details.usage
      if (error.details.requiredFree !== undefined) details.required_free = error.details.requiredFree
      if (error.details.closestEntries) details.closest_entries = error.details.closestEntries
      if (error.details.matches) details.matches = error.details.matches
      if (error.details.threats) details.threats = error.details.threats
      return details
    }
  }

  private register(entry: ToolEntry): void {
    this.entries.set(entry.name, entry)
  }

  definitions(): Record<string, Tool> {
    return Object.fromEntries(
      Array.from(this.entries.values()).map((entry) => [
        entry.name,
        tool({ description: entry.description, inputSchema: entry.inputSchema }),
      ]),
    )
  }

  names(): string[] {
    return Array.from(this.entries.keys()).sort()
  }

  list(): ToolInfo[] {
    return Array.from(this.entries.values())
      .map(({ name, action, description, risk, readOnly, approvalRequired }) => ({
        name,
        action,
        description,
        risk,
        readOnly,
        approvalRequired: approvalRequired ?? !readOnly,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  action(name: string): string {
    return this.entries.get(name)?.action ?? `tool.${name}`
  }

  risk(name: string): ToolRisk {
    return this.entries.get(name)?.risk ?? "unknown"
  }

  async permissionContext(
    name: string,
    input: unknown,
  ): Promise<{ resource: string; inGrant: boolean; sensitive: boolean }> {
    const entry = this.entries.get(name)
    if (!entry) return { resource: "*", inGrant: false, sensitive: true }
    const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const pathInput =
      typeof record.path === "string"
        ? record.path
        : typeof record.root === "string"
          ? record.root
          : undefined
    if (pathInput) {
      const mode = entry.risk === "read" ? "read" : "write"
      const info = await this.workspace.pathInfo(pathInput, mode)
      return {
        resource: info.resolved,
        inGrant: Boolean(info.grant),
        sensitive: info.sensitive,
      }
    }
    if (typeof record.url === "string") {
      return { resource: record.url, inGrant: false, sensitive: false }
    }
    if (typeof record.command === "string") {
      return { resource: record.command, inGrant: false, sensitive: false }
    }
    return { resource: "*", inGrant: false, sensitive: false }
  }

  async execute(name: string, input: unknown, context: ToolContext): Promise<unknown> {
    const entry = this.entries.get(name)
    if (!entry) throw new Error(`Unknown tool: ${name}`)
    const parsed = entry.inputSchema.parse(input)
    const result = await entry.execute(parsed, context)
    return jsonValue(result)
  }

  private async fsList(input: unknown) {
    const parsed = z.object({ path: z.string(), limit: z.number().int().optional() }).parse(input)
    const resolved = this.workspace.resolve(parsed.path)
    if (this.workspace.isSensitive(resolved)) throw new WorkspaceError("Path is protected")
    if (!existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`)
    if (!statSync(resolved).isDirectory()) throw new Error("Path is not a directory")
    const entries = readdirSync(resolved, { withFileTypes: true })
      .slice(0, parsed.limit ?? 500)
      .map((entry) => {
        const full = path.join(resolved, entry.name)
        let size = 0
        try {
          size = lstatSync(full).size
        } catch {
          size = 0
        }
        return {
          name: entry.name,
          path: full,
          type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
          size,
        }
      })
    return { path: resolved, entries }
  }

  private async fsStat(input: unknown) {
    const parsed = z.object({ path: z.string() }).parse(input)
    const resolved = this.workspace.resolve(parsed.path)
    if (this.workspace.isSensitive(resolved)) throw new WorkspaceError("Path is protected")
    if (!existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`)
    const stat = lstatSync(resolved)
    return {
      path: resolved,
      type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      ...(stat.isFile() ? { sha256: sha256File(resolved) } : {}),
    }
  }

  private async fsRead(input: unknown) {
    const parsed = z
      .object({ path: z.string(), maxBytes: z.number().int().optional() })
      .parse(input)
    const resolved = this.workspace.resolve(parsed.path)
    if (this.workspace.isSensitive(resolved)) throw new WorkspaceError("Path is protected")
    if (!existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`)
    const stat = statSync(resolved)
    if (!stat.isFile()) throw new Error("Path is not a file")
    if (stat.size > (parsed.maxBytes ?? 1_000_000)) throw new Error("File is too large")
    const bytes = readFileSync(resolved)
    if (bytes.includes(0)) throw new Error("Binary files are not readable by fs_read")
    return {
      path: resolved,
      size: stat.size,
      sha256: sha256File(resolved),
      content: bytes.toString("utf8").slice(0, parsed.maxBytes ?? 100_000),
    }
  }

  private async fsSearch(input: unknown) {
    const parsed = z
      .object({ root: z.string(), pattern: z.string(), maxResults: z.number().int().optional() })
      .parse(input)
    const root = this.workspace.resolve(parsed.root)
    if (this.workspace.isSensitive(root)) throw new WorkspaceError("Path is protected")
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("Search root is not a directory")
    const matcher = new RegExp(parsed.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    const results: string[] = []
    const max = parsed.maxResults ?? 200
    const walk = (dir: string, depth: number) => {
      if (results.length >= max || depth > 12) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const full = path.join(dir, entry.name)
        if (matcher.test(entry.name)) results.push(full)
        if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          walk(full, depth + 1)
        }
        if (results.length >= max) return
      }
    }
    walk(root, 0)
    return { root, matches: results.slice(0, max) }
  }

  private async fsPrepareMoves(input: unknown) {
    const parsed = z
      .object({ root: z.string(), moves: z.array(moveInput).min(1).max(5_000) })
      .parse(input)
    const root = this.workspace.resolve(parsed.root)
    if (this.workspace.isSensitive(root)) throw new WorkspaceError("Path is protected")
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("Root is not a directory")
    const moves = parsed.moves.map((move) => {
      const source = this.workspace.resolve(path.resolve(root, move.from))
      const target = this.workspace.resolve(path.resolve(root, move.to))
      if (!this.isInside(root, source) || !this.isInside(root, target)) {
        throw new WorkspaceError("Move escapes the approved root")
      }
      if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Source missing: ${move.from}`)
      const sourceHash = sha256File(source)
      if (move.sha256 && sourceHash !== move.sha256) throw new Error(`Source hash mismatch: ${move.from}`)
      return { from: source, to: target, sha256: sourceHash, size: statSync(source).size }
    })
    return {
      root,
      moves,
      planHash: sha256(JSON.stringify({ root, moves: moves.map((m) => [m.from, m.to, m.sha256]) })),
    }
  }

  private async fsWrite(input: unknown, context: ToolContext) {
    const parsed = z
      .object({ path: z.string(), content: z.string(), expectedSha256: z.string().optional() })
      .parse(input)
    const target = this.workspace.resolve(parsed.path)
    await this.workspace.requireWriteGrant(target)
    if (this.workspace.isSensitive(target)) throw new WorkspaceError("Path is protected")
    const previous = existsSync(target) ? readFileSync(target, "utf8") : null
    const previousHash = previous === null ? null : sha256(previous)
    if (parsed.expectedSha256 && previousHash !== parsed.expectedSha256) {
      throw new Error("Target changed since the plan")
    }
    const journal = await this.journal.begin({
      batchId: context.toolCallId ?? `write-${Date.now()}`,
      turnId: context.turnId,
      sessionId: context.sessionId,
      toolName: "fs_write",
      operation: "write",
      target,
      sourceHash: previousHash,
      undo: { previous },
    })
    await this.journal.mark(journal.id, "applying")
    const temporary = `${target}.agent1-${process.pid}`
    writeFileSync(temporary, parsed.content, { encoding: "utf8" })
    renameSync(temporary, target)
    const targetHash = sha256File(target)
    await this.journal.mark(journal.id, "done", { targetHash })
    return { path: target, sha256: targetHash, journalId: journal.id }
  }

  private async fsMkdir(input: unknown, context: ToolContext) {
    const parsed = z.object({ path: z.string() }).parse(input)
    const target = this.workspace.resolve(parsed.path)
    await this.workspace.requireWriteGrant(target)
    if (this.workspace.isSensitive(target)) throw new WorkspaceError("Path is protected")
    const journal = await this.journal.begin({
      batchId: context.toolCallId ?? `mkdir-${Date.now()}`,
      turnId: context.turnId,
      sessionId: context.sessionId,
      toolName: "fs_mkdir",
      operation: "mkdir",
      target,
      undo: {},
    })
    mkdirSync(target, { recursive: false })
    await this.journal.mark(journal.id, "done")
    return { path: target, journalId: journal.id }
  }

  private async fsApplyMoves(input: unknown, context: ToolContext) {
    const parsed = z
      .object({ root: z.string(), moves: z.array(moveInput).min(1).max(5_000) })
      .parse(input)
    const root = this.workspace.resolve(parsed.root)
    await this.workspace.requireWriteGrant(root)
    if (this.workspace.isSensitive(root)) throw new WorkspaceError("Path is protected")
    const batchId = context.toolCallId ?? `moves-${Date.now()}`
    const existing = await this.journal.listBatch(batchId)
    const bySource = new Map(existing.map((entry) => [entry.source, entry]))
    let applied = 0
    let skipped = 0
    const crashAfter = Number(process.env.AGENT1_CRASH_AFTER_MOVE ?? "0")

    for (const move of parsed.moves) {
      const source = this.workspace.resolve(path.resolve(root, move.from))
      const target = this.workspace.resolve(path.resolve(root, move.to))
      if (!this.isInside(root, source) || !this.isInside(root, target)) {
        throw new WorkspaceError("Move escapes the approved root")
      }
      const existingEntry = bySource.get(source)
      if (existingEntry?.state === "done") {
        if (existsSync(target) && !existsSync(source)) {
          skipped++
          continue
        }
        throw new Error(`Journal says move is done but the filesystem disagrees: ${source}`)
      }
      if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Source missing: ${source}`)
      if (existsSync(target)) throw new Error(`Target already exists: ${target}`)
      await this.ensureParentDirectories(root, target, batchId, context)
      const sourceHash = sha256File(source)
      if (move.sha256 && sourceHash !== move.sha256) throw new Error(`Source hash mismatch: ${source}`)
      const journal =
        existingEntry ??
        (await this.journal.begin({
          batchId,
          turnId: context.turnId,
          sessionId: context.sessionId,
          toolName: "fs_apply_moves",
          operation: "move",
          source,
          target,
          sourceHash,
          undo: {},
        }))
      await this.journal.mark(journal.id, "applying")
      renameSync(source, target)
      const targetHash = sha256File(target)
      await this.journal.mark(journal.id, "done", { targetHash })
      applied++
      if (crashAfter > 0 && applied >= crashAfter) {
        this.logger.error("journal.crash_injected", { after: applied })
        if (process.env.AGENT1_CRASH_MODE === "throw") {
          throw new Error(`Injected journal crash after ${applied} moves`)
        }
        process.exit(9)
      }
    }

    return { batchId, applied, skipped, total: parsed.moves.length }
  }

  private async ensureParentDirectories(
    root: string,
    target: string,
    batchId: string,
    context: ToolContext,
  ): Promise<void> {
    const parent = path.dirname(target)
    if (!this.isInside(root, parent)) throw new WorkspaceError("Target parent escapes root")
    const relative = path.relative(root, parent)
    if (relative === "") return
    let current = root
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment)
      if (existsSync(current)) continue
      mkdirSync(current)
      const dirEntry = await this.journal.begin({
        batchId,
        turnId: context.turnId,
        sessionId: context.sessionId,
        toolName: "fs_apply_moves",
        operation: "mkdir",
        target: current,
        undo: {},
      })
      await this.journal.mark(dirEntry.id, "done")
    }
  }

  private async fsUndo(input: unknown) {
    const parsed = z.object({ batchId: z.string().optional() }).parse(input)
    const batchId = parsed.batchId ?? (await this.journal.latestBatchId())
    if (!batchId) throw new Error("No journal batch to undo")
    return this.journal.undoBatch(batchId)
  }

  private async shellExec(input: unknown) {
    const parsed = z
      .object({
        command: z.string().min(1).max(8_000),
        cwd: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      })
      .parse(input)
    const cwd = parsed.cwd ? this.workspace.resolve(parsed.cwd) : process.cwd()
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error("Working directory does not exist")
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/PASSWORD|TOKEN|SECRET|API_KEY|AUTH|COOKIE/i.test(key)) delete env[key]
    }
    const timeoutMs = parsed.timeoutMs ?? 30_000
    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh"
    const args = process.platform === "win32" ? ["/d", "/s", "/c", parsed.command] : ["-c", parsed.command]

    return new Promise<unknown>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      let settled = false
      const maxOutput = 200_000
      const append = (current: string, chunk: Buffer): string =>
        (current + chunk.toString("utf8")).slice(0, maxOutput)
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk)
      })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true })
        } else {
          child.kill("SIGKILL")
        }
        reject(new Error(`Shell command timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      child.on("error", (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      child.on("close", (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          cwd,
          exitCode: code ?? -1,
          stdout,
          stderr,
          truncated: stdout.length >= maxOutput || stderr.length >= maxOutput,
        })
      })
    })
  }

  private async webFetch(input: unknown) {
    const parsed = z
      .object({ url: z.string(), maxChars: z.number().int().optional() })
      .parse(input)
    let current = await assertPublicUrl(parsed.url)
    const maxChars = parsed.maxChars ?? 50_000
    for (let redirect = 0; redirect < 5; redirect++) {
      const response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: { accept: "text/html,text/plain,application/json" },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location) throw new Error("Redirect without Location")
        current = await assertPublicUrl(new URL(location, current).toString())
        continue
      }
      const contentType = response.headers.get("content-type") ?? ""
      if (!/text\/|application\/json/i.test(contentType)) throw new Error("Unsupported content type")
      const text = await response.text()
      const content = /html/i.test(contentType) ? stripHtml(text) : text
      return {
        url: current.toString(),
        status: response.status,
        contentType,
        text: content.slice(0, maxChars),
        truncated: content.length > maxChars,
      }
    }
    throw new Error("Too many redirects")
  }

  private async webSearch(input: unknown) {
    const parsed = z.object({ query: z.string().min(1).max(500) }).parse(input)
    const endpoint = process.env.AGENT1_SEARCH_URL
    if (!endpoint) throw new Error("Web search is not configured. Set AGENT1_SEARCH_URL.")
    const url = new URL(endpoint)
    url.searchParams.set("q", parsed.query)
    const headers: Record<string, string> = { accept: "application/json" }
    const key = process.env.AGENT1_SEARCH_KEY
    if (key) headers.authorization = `Bearer ${key}`
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`Search failed (${response.status})`)
    const body = (await response.json()) as unknown
    if (Array.isArray(body)) return { results: body.slice(0, 10) }
    if (body && typeof body === "object" && Array.isArray((body as { results?: unknown[] }).results)) {
      return { results: (body as { results: unknown[] }).results.slice(0, 10) }
    }
    return { results: [] }
  }

  private isInside(root: string, candidate: string): boolean {
    const normalizedRoot = path.resolve(root)
    const normalizedCandidate = path.resolve(candidate)
    if (process.platform === "win32") {
      const r = normalizedRoot.toLowerCase()
      const c = normalizedCandidate.toLowerCase()
      return c === r || c.startsWith(`${r}${path.sep}`)
    }
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  }
}
