import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import type { Database } from "../db/database"
import type { Logger } from "../core/log"
import type { EventService } from "../events/service"
import type {
  Checkpoint,
  CheckpointDiff,
  CheckpointRestoreResult,
} from "../shared/types"
import { Git, isolatedGitEnv } from "./git"

export class CheckpointError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message)
    this.name = "CheckpointError"
  }
}

export class CheckpointGuardError extends CheckpointError {
  constructor(message: string) {
    super(message)
    this.name = "CheckpointGuardError"
  }
}

const MAX_FILES = 50_000
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_CHECKPOINTS = 20
const MAX_STORE_BYTES = 500 * 1024 * 1024
const GIT_TIMEOUT_MS = 120_000

function checkpointFault(point: string): void {
  if (process.env.AGENT1_CHECKPOINT_FAULT === point) {
    throw new CheckpointError(`Injected checkpoint fault: ${point}`)
  }
}

const DEFAULT_EXCLUDES = [
  "node_modules/",
  "dist/",
  "build/",
  "target/",
  "out/",
  ".next/",
  ".nuxt/",
  "__pycache__/",
  "*.pyc",
  "*.pyo",
  ".cache/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  "coverage/",
  ".coverage",
  ".venv/",
  "venv/",
  "env/",
  ".git/",
  ".hg/",
  ".svn/",
  ".worktrees/",
  "*.so",
  "*.dylib",
  "*.dll",
  "*.o",
  "*.a",
  "*.jar",
  "*.class",
  "*.exe",
  "*.obj",
  "*.mp4",
  "*.mov",
  "*.mkv",
  "*.webm",
  "*.zip",
  "*.tar",
  "*.tar.gz",
  "*.tgz",
  "*.7z",
  "*.rar",
  "*.iso",
  ".env",
  ".env.*",
  ".env.local",
  ".env.*.local",
  ".DS_Store",
  "Thumbs.db",
  "*.log",
] as const

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".nuxt",
  "__pycache__",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "coverage",
  ".venv",
  "venv",
  "env",
  ".git",
  ".hg",
  ".svn",
  ".worktrees",
])

export interface EnsureCheckpointInput {
  readonly rootPath: string
  readonly turnId?: string | null
  readonly sessionId?: string | null
  readonly toolCallId?: string | null
  readonly reason: string
}

interface SnapshotInput {
  readonly rootPath: string
  readonly turnId?: string | null
  readonly sessionId?: string | null
  readonly reason: string
  readonly prune?: boolean
}

interface DiffFile {
  readonly path: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
}

function normalizePath(value: string): string {
  return path.resolve(value)
}

function pathKey(value: string): string {
  return process.platform === "win32" ? normalizePath(value).toLowerCase() : normalizePath(value)
}

function rootHashFor(rootPath: string): string {
  return createHash("sha256").update(pathKey(rootPath)).digest("hex").slice(0, 16)
}

function sha256File(filePath: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex")
  } catch {
    return null
  }
}

function within(root: string, candidate: string): boolean {
  const left = normalizePath(root)
  const right = normalizePath(candidate)
  if (process.platform === "win32") {
    const a = left.toLowerCase()
    const b = right.toLowerCase()
    return b === a || b.startsWith(`${a}${path.sep}`)
  }
  return right === left || right.startsWith(`${left}${path.sep}`)
}

function tooBroad(workspacePath: string): boolean {
  const home = process.env.USERPROFILE ? normalizePath(process.env.USERPROFILE) : ""
  const root = path.parse(workspacePath).root
  const values = new Set<string>([pathKey(root)])
  let current = home
  while (current) {
    values.add(pathKey(current))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return values.has(pathKey(workspacePath))
}

function countFiles(root: string, limit: number): number {
  let count = 0
  const walk = (directory: string, depth: number) => {
    if (count > limit || depth > 64) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count > limit) return
      if (EXCLUDED_DIRS.has(entry.name)) continue
      if (entry.isSymbolicLink()) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && !entry.name.endsWith(".log")) count++
    }
  }
  walk(root, 0)
  return count
}

function findLinkedPaths(root: string, limit = 2_000): string[] {
  const found: string[] = []
  const walk = (directory: string, depth: number) => {
    if (found.length >= limit || depth > 64) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      if (EXCLUDED_DIRS.has(entry.name)) continue
      const full = path.join(directory, entry.name)
      let linked = entry.isSymbolicLink()
      if (!linked) {
        try {
          linked = lstatSync(full).isSymbolicLink()
        } catch {
          linked = false
        }
      }
      const relative = path.relative(root, full).replaceAll("\\", "/")
      if (linked) {
        found.push(relative)
        continue
      }
      if (entry.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

function parseNumstat(text: string): DiffFile[] {
  const files: DiffFile[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const match = /^([0-9-]+)\t([0-9-]+)\t(.*)$/.exec(line)
    if (!match) continue
    files.push({
      path: match[3] ?? "",
      status: "modified",
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    })
  }
  return files
}

function parseNameStatus(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const [status, ...rest] = line.split("\t")
    if (!status || rest.length === 0) continue
    map.set(rest[rest.length - 1] ?? "", status)
  }
  return map
}

export class CheckpointManager {
  private readonly git: Git
  private initialized = false
  private gitAvailable = false
  private readonly turnCheckpoints = new Map<string, Checkpoint>()

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly checkpointsDir: string,
    private readonly events?: EventService,
    private readonly maxCheckpoints = MAX_CHECKPOINTS,
    private readonly maxStoreBytes = MAX_STORE_BYTES,
    private readonly maxFiles = MAX_FILES,
    private readonly maxFileBytes = MAX_FILE_BYTES,
    gitExecutable = "git",
  ) {
    this.git = new Git(gitExecutable)
  }

  get storePath(): string {
    return path.join(this.checkpointsDir, "store")
  }

  get available(): boolean {
    return this.gitAvailable
  }

  async policy(): Promise<{
    maxPerRoot: number
    maxStoreBytes: number
    maxFileBytes: number
    maxFiles: number
    retentionPolicy: "keep-until-pruned"
  }> {
    const read = async (key: string, fallback: number): Promise<number> => {
      const raw = Number(await this.db.getSetting(key))
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
    }
    return {
      maxPerRoot: await read("checkpoints.max_per_root", this.maxCheckpoints),
      maxStoreBytes: await read("checkpoints.max_store_bytes", this.maxStoreBytes),
      maxFileBytes: await read("checkpoints.max_file_bytes", this.maxFileBytes),
      maxFiles: await read("checkpoints.max_files", this.maxFiles),
      retentionPolicy: "keep-until-pruned",
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    mkdirSync(this.checkpointsDir, { recursive: true })
    this.gitAvailable = await this.git.available()
    if (!this.gitAvailable) {
      this.logger.warn("checkpoints.git_unavailable", {
        message: "Git for Windows is required for filesystem checkpoints",
      })
      return
    }
    if (!existsSync(path.join(this.storePath, "HEAD"))) {
      await this.git.initializeBare(this.storePath)
    }
    mkdirSync(path.join(this.storePath, "info"), { recursive: true })
    writeFileSync(path.join(this.storePath, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`, "utf8")
    await this.git.run(["config", "core.longpaths", "true"], {
      cwd: this.storePath,
      env: this.gitEnv(undefined),
      timeoutMs: 10_000,
    })
    await this.git.run(["config", "core.quotepath", "false"], {
      cwd: this.storePath,
      env: this.gitEnv(undefined),
      timeoutMs: 10_000,
    })
    this.logger.info("checkpoints.ready", { store: this.storePath })
  }

  async ensureAvailable(): Promise<void> {
    await this.initialize()
    if (!this.gitAvailable) {
      throw new CheckpointError(
        "Filesystem checkpoints require Git for Windows. Install Git or configure its path, then restart Agent-1.",
      )
    }
  }

  async ensureCheckpointForPath(input: EnsureCheckpointInput): Promise<Checkpoint | null> {
    await this.ensureAvailable()
    const key = `${input.turnId ?? input.sessionId ?? input.toolCallId ?? "manual"}:${rootHashFor(input.rootPath)}`
    const existing = this.turnCheckpoints.get(key)
    if (existing) return existing
    const checkpoint = await this.takeSnapshot({
      rootPath: input.rootPath,
      turnId: input.turnId,
      sessionId: input.sessionId,
      reason: input.reason,
    })
    if (checkpoint) this.turnCheckpoints.set(key, checkpoint)
    return checkpoint
  }

  async list(limit = 100, sessionId?: string): Promise<Checkpoint[]> {
    return this.db.listCheckpoints(limit, sessionId)
  }

  async get(id: string): Promise<Checkpoint | null> {
    return this.db.getCheckpoint(id)
  }

  async diff(id: string): Promise<CheckpointDiff> {
    const checkpoint = await this.requireCheckpoint(id)
    const workspace = checkpoint.rootPath
    const index = await this.prepareIndex(checkpoint)
    try {
      const stat = await this.git.run(["diff", "--cached", "--no-renames", checkpoint.commit, "--stat"], {
        cwd: workspace,
        env: this.gitEnv(workspace, index),
        timeoutMs: GIT_TIMEOUT_MS,
      })
      const diff = await this.git.run(["diff", "--cached", "--no-renames", checkpoint.commit], {
        cwd: workspace,
        env: this.gitEnv(workspace, index),
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      const numstat = await this.git.run(["diff", "--cached", "--no-renames", "--numstat", checkpoint.commit], {
        cwd: workspace,
        env: this.gitEnv(workspace, index),
        timeoutMs: GIT_TIMEOUT_MS,
      })
      const names = await this.git.run(["diff", "--cached", "--no-renames", "--name-status", checkpoint.commit], {
        cwd: workspace,
        env: this.gitEnv(workspace, index),
        timeoutMs: GIT_TIMEOUT_MS,
      })
      const statuses = parseNameStatus(names.stdout)
      const files = parseNumstat(numstat.stdout).map((file) => ({
        ...file,
        status: statuses.get(file.path) ?? file.status,
      }))
      return {
        checkpointId: checkpoint.id,
        stat: stat.stdout.slice(0, 2 * 1024 * 1024),
        diff: diff.stdout.slice(0, 4 * 1024 * 1024),
        files,
      }
    } finally {
      await this.resetIndex(checkpoint, index).catch(() => {})
    }
  }

  async restore(
    id: string,
    options: { readonly filePath?: string; readonly safe?: boolean } = {},
  ): Promise<CheckpointRestoreResult> {
    await this.ensureAvailable()
    const checkpoint = await this.requireCheckpoint(id)
    const workspace = checkpoint.rootPath
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      throw new CheckpointError(`Checkpoint root no longer exists: ${workspace}`)
    }
    const filePath = options.filePath
      ? normalizePath(path.resolve(workspace, options.filePath))
      : undefined
    if (filePath && !within(workspace, filePath)) {
      throw new CheckpointError("Restore path escapes the checkpoint root")
    }

    checkpointFault("before-restore")
    const index = await this.prepareIndex(checkpoint)
    try {
      const changed = await this.changedPaths(checkpoint, index)
      const selected = filePath ? changed.filter((item) => pathKey(path.resolve(workspace, item)) === pathKey(filePath)) : changed
      const restorePaths: string[] = []
      const skippedUserEdits: string[] = []
      const skippedOversize: string[] = []
      const safe = options.safe !== false
      const policy = await this.policy()

      let ledgerCount = 0
      for (const relative of selected) {
        const absolute = path.resolve(workspace, relative)
        const write = await this.db.getAgentWrite(checkpoint.rootHash, pathKey(absolute))
        if (write) ledgerCount++
      }
      const fullRestore = !safe || ledgerCount === 0

      for (const relative of selected) {
        const absolute = path.resolve(workspace, relative)
        if (!within(workspace, absolute)) continue
        if (!fullRestore) {
          const write = await this.db.getAgentWrite(checkpoint.rootHash, pathKey(absolute))
          if (!write) {
            skippedUserEdits.push(relative)
            continue
          }
          const current = sha256File(absolute)
          if (current !== null && current !== write.sha256) {
            skippedUserEdits.push(relative)
            continue
          }
          if (current === null && existsSync(absolute)) {
            skippedUserEdits.push(relative)
            continue
          }
        }
        restorePaths.push(relative)
      }

      const treePaths = await this.treePaths(checkpoint.commit, workspace, index)
      const nested = [...treePaths.entries()]
        .filter(([, mode]) => mode === "160000")
        .map(([nestedPath]) => nestedPath)
      const selectedRelative = filePath ? path.relative(workspace, filePath).replaceAll("\\", "/") : undefined
      const blockedNested = selectedRelative
        ? nested.filter((nestedPath) => selectedRelative === nestedPath || selectedRelative.startsWith(`${nestedPath}/`))
        : nested
      if (blockedNested.length > 0) {
        throw new CheckpointError(
          `Checkpoint contains nested Git repositories that were not captured (${blockedNested.join(", ")}); rollback was not performed`,
        )
      }

      // A pre-rollback snapshot is taken so the rollback itself can be undone.
      await this.takeSnapshot({
        rootPath: workspace,
        turnId: checkpoint.turnId,
        sessionId: checkpoint.sessionId,
        reason: `pre-rollback snapshot (restoring to ${checkpoint.commit.slice(0, 8)})`,
        prune: false,
      })
      checkpointFault("after-pre-rollback")

      const restoredFiles: string[] = []
      const deletedFiles: string[] = []
      const failedDeletes: string[] = []
      const failedRestores: string[] = []
      const checkoutTargets: string[] = []
      for (const relative of restorePaths) {
        const absolute = path.resolve(workspace, relative)
        if (!within(workspace, absolute)) continue
        if (treePaths.has(relative)) {
          checkoutTargets.push(relative)
          continue
        }
        if (safe && existsSync(absolute)) {
          try {
            if (statSync(absolute).size > policy.maxFileBytes) {
              skippedOversize.push(relative)
              continue
            }
          } catch {
            // Treat an unreadable file as a failed delete below.
          }
        }
        try {
          if (existsSync(absolute)) unlinkSync(absolute)
          deletedFiles.push(relative)
        } catch {
          failedDeletes.push(relative)
        }
      }

      // Batch checkout avoids one Git process per file on large restores.
      for (let offset = 0; offset < checkoutTargets.length; offset += 100) {
        const batch = checkoutTargets.slice(offset, offset + 100)
        try {
          await this.git.run(["checkout", checkpoint.commit, "--", ...batch], {
            cwd: workspace,
            env: this.gitEnv(workspace, index),
            timeoutMs: GIT_TIMEOUT_MS,
          })
          restoredFiles.push(...batch)
          checkpointFault("after-restore-batch")
        } catch (error) {
          this.logger.warn("checkpoints.restore_batch_failed", {
            checkpointId: id,
            files: batch.length,
            error: error instanceof Error ? error.message : String(error),
          })
          for (const relative of batch) {
            try {
              await this.git.run(["checkout", checkpoint.commit, "--", relative], {
                cwd: workspace,
                env: this.gitEnv(workspace, index),
                timeoutMs: GIT_TIMEOUT_MS,
              })
              restoredFiles.push(relative)
            } catch {
              failedRestores.push(relative)
            }
          }
        }
      }

      checkpointFault("after-restore")
      const result: CheckpointRestoreResult = {
        checkpointId: checkpoint.id,
        restoredTo: checkpoint.commit.slice(0, 8),
        restoredFiles,
        deletedFiles,
        skippedUserEdits,
        skippedOversize,
        failedDeletes,
        failedRestores,
      }
      await this.events?.append("checkpoint.restored", checkpoint.sessionId, {
        checkpointId: checkpoint.id,
        restoredTo: result.restoredTo,
        restored: result.restoredFiles.length,
        deleted: result.deletedFiles.length,
        skippedUserEdits: result.skippedUserEdits.length,
        failedDeletes: result.failedDeletes.length,
        failedRestores: result.failedRestores.length,
      })
      return result
    } finally {
      await this.resetIndex(checkpoint, index).catch(() => {})
    }
  }

  async recordAgentWrite(rootPath: string, filePath: string): Promise<void> {
    const absolute = normalizePath(filePath)
    const digest = sha256File(absolute)
    if (!digest) return
    await this.recordAgentWriteHash(rootPath, absolute, digest)
  }

  async recordAgentWriteHash(rootPath: string, filePath: string, digest: string): Promise<void> {
    await this.db.recordAgentWrite(rootHashFor(rootPath), pathKey(filePath), digest)
  }

  private async requireCheckpoint(id: string): Promise<Checkpoint> {
    const checkpoint = await this.db.getCheckpoint(id)
    if (!checkpoint) throw new CheckpointError("Checkpoint not found")
    return checkpoint
  }

  private async takeSnapshot(input: SnapshotInput): Promise<Checkpoint | null> {
    await this.ensureAvailable()
    const workspace = normalizePath(input.rootPath)
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      throw new CheckpointError(`Checkpoint root is not a directory: ${workspace}`)
    }
    if (tooBroad(workspace)) {
      throw new CheckpointGuardError(`Checkpoint root is too broad to snapshot safely: ${workspace}`)
    }
    const policy = await this.policy()
    const files = countFiles(workspace, policy.maxFiles)
    if (files > policy.maxFiles) {
      throw new CheckpointGuardError(
        `Checkpoint root exceeds the ${policy.maxFiles}-file guard: ${workspace}`,
      )
    }

    const hash = rootHashFor(workspace)
    const indexDir = path.join(this.checkpointsDir, "indexes")
    mkdirSync(indexDir, { recursive: true })
    const index = path.join(indexDir, hash)
    this.clearStaleIndexLock(index)
    const ref = `refs/agent1/${hash}`
    const env = this.gitEnv(workspace, index)
    const linkedPaths = findLinkedPaths(workspace)

    checkpointFault("before-stage")
    await this.stage(workspace, env, linkedPaths)
    checkpointFault("after-stage")
    const staged = await this.git.run(["diff", "--cached", "--name-only", "-z"], {
      cwd: workspace,
      env,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    const stagedPaths = staged.stdout.split("\0").filter(Boolean)
    for (const relative of stagedPaths) {
      const absolute = path.resolve(workspace, relative)
      try {
        if (statSync(absolute).size > policy.maxFileBytes) {
          await this.git.run(["rm", "--cached", "--ignore-unmatch", "--", relative], {
            cwd: workspace,
            env,
            timeoutMs: 30_000,
          })
        }
      } catch {
        // Deleted or inaccessible paths are handled by Git.
      }
    }

    const parent = await this.git.run(["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: workspace,
      env,
      timeoutMs: 10_000,
      allowExitCodes: [0, 128],
    })
    const parentCommit = parent.code === 0 ? parent.stdout.trim() : ""
    if (parentCommit) {
      const quiet = await this.git.run(["diff-index", "--cached", "--quiet", parentCommit], {
        cwd: workspace,
        env,
        timeoutMs: GIT_TIMEOUT_MS,
        allowExitCodes: [0, 1],
      })
      if (quiet.code === 0) return null
    }

    const tree = await this.git.run(["write-tree"], {
      cwd: workspace,
      env,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    const treeSha = tree.stdout.trim()
    if (!treeSha) throw new CheckpointError("Git did not return a tree")
    checkpointFault("after-tree")

    // Checkpoints are independent snapshots. Keeping the previous commit as a
    // parent would retain every pruned tree forever; the ref and database row
    // are the only lifecycle owners.
    const commitArgs = ["commit-tree", treeSha, "-m", input.reason]
    const commit = await this.git.run(commitArgs, {
      cwd: workspace,
      env,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    const commitSha = commit.stdout.trim()
    if (!commitSha) throw new CheckpointError("Git did not return a commit")
    checkpointFault("after-commit")

    await this.git.run(["update-ref", ref, commitSha], {
      cwd: workspace,
      env,
      timeoutMs: 10_000,
    })
    checkpointFault("after-ref")

    const stats = parentCommit
      ? await this.git.run(["diff", "--shortstat", parentCommit, commitSha], {
          cwd: workspace,
          env,
          timeoutMs: GIT_TIMEOUT_MS,
        })
      : { stdout: "" }
    const parsed = this.parseShortStat(stats.stdout)
    const checkpoint = await this.db.createCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      rootPath: workspace,
      rootHash: hash,
      commit: commitSha,
      reason: input.reason,
      filesChanged: parsed.files,
      insertions: parsed.insertions,
      deletions: parsed.deletions,
    })
    checkpointFault("after-db")
    await this.events?.append("checkpoint.created", checkpoint.sessionId, {
      checkpointId: checkpoint.id,
      turnId: checkpoint.turnId,
      rootPath: checkpoint.rootPath,
      commit: checkpoint.commit,
      reason: checkpoint.reason,
    })
    checkpointFault("after-event")

    if (input.prune !== false) {
      checkpointFault("before-prune")
      await this.prune(hash)
    }
    return checkpoint
  }

  private async stage(workspace: string, env: NodeJS.ProcessEnv, linkedPaths: readonly string[] = []): Promise<void> {
    const specs = ["."]
    const relativeStore = path.relative(workspace, this.storePath)
    if (relativeStore && !relativeStore.startsWith("..") && !path.isAbsolute(relativeStore)) {
      specs.push(`:(exclude,literal)${relativeStore.replaceAll("\\", "/")}`)
    }
    for (const relative of linkedPaths) {
      specs.push(`:(exclude,literal)${relative}`)
    }
    const specFile = path.join(
      this.checkpointsDir,
      `pathspec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    writeFileSync(specFile, `${specs.join("\0")}\0`, "utf8")
    try {
      await this.git.run(
        ["add", "-A", `--pathspec-from-file=${specFile}`, "--pathspec-file-nul"],
        {
          cwd: workspace,
          env,
          timeoutMs: GIT_TIMEOUT_MS,
        },
      )
    } finally {
      try {
        unlinkSync(specFile)
      } catch {
        // Best effort.
      }
    }
  }

  private async prepareIndex(checkpoint: Checkpoint): Promise<string> {
    const indexDir = path.join(this.checkpointsDir, "indexes")
    mkdirSync(indexDir, { recursive: true })
    const index = path.join(indexDir, checkpoint.rootHash)
    this.clearStaleIndexLock(index)
    const env = this.gitEnv(checkpoint.rootPath, index)
    await this.stage(checkpoint.rootPath, env, findLinkedPaths(checkpoint.rootPath))
    return index
  }

  private async resetIndex(checkpoint: Checkpoint, index: string): Promise<void> {
    await this.git.run(["read-tree", `refs/agent1/${checkpoint.rootHash}`], {
      cwd: checkpoint.rootPath,
      env: this.gitEnv(checkpoint.rootPath, index),
      timeoutMs: 30_000,
      allowExitCodes: [0, 128],
    })
  }

  private async changedPaths(checkpoint: Checkpoint, index: string): Promise<string[]> {
    const result = await this.git.run(["diff", "--cached", "--no-renames", "--name-only", "-z", checkpoint.commit], {
      cwd: checkpoint.rootPath,
      env: this.gitEnv(checkpoint.rootPath, index),
      timeoutMs: GIT_TIMEOUT_MS,
    })
    return result.stdout.split("\0").filter(Boolean)
  }

  private async treePaths(commit: string, workspace: string, index: string): Promise<Map<string, string>> {
    const result = await this.git.run(["ls-tree", "-r", "-z", commit], {
      cwd: workspace,
      env: this.gitEnv(workspace, index),
      timeoutMs: GIT_TIMEOUT_MS,
    })
    const paths = new Map<string, string>()
    for (const record of result.stdout.split("\0")) {
      if (!record) continue
      const separator = record.indexOf("\t")
      if (separator < 0) continue
      const header = record.slice(0, separator).split(" ")
      paths.set(record.slice(separator + 1), header[0] ?? "")
    }
    return paths
  }

  /** Test/repair entry point: prune one root and reclaim Git objects. */
  async pruneNow(hash: string): Promise<void> {
    await this.prune(hash)
  }

  private async prune(hash: string): Promise<void> {
    try {
      const policy = await this.policy()
      const checkpoints = await this.db.listCheckpointsForRoot(hash, policy.maxPerRoot + 10_000)
      let keep = checkpoints.slice(0, policy.maxPerRoot)
      if ((await this.storeBytes()) > policy.maxStoreBytes && keep.length > 1) {
        const removeCount = Math.max(1, Math.ceil(keep.length / 4))
        keep = keep.slice(0, Math.max(1, keep.length - removeCount))
      }
      const keepIds = new Set(keep.map((checkpoint) => checkpoint.id))
      const stale = checkpoints.filter((checkpoint) => !keepIds.has(checkpoint.id))
      if (stale.length > 0) await this.db.deleteCheckpoints(stale.map((item) => item.id))

      const ref = `refs/agent1/${hash}`
      const current = keep[0]
      if (current) {
        await this.git.run(["update-ref", ref, current.commit], {
          cwd: this.storePath,
          env: this.gitEnv(undefined),
          timeoutMs: 10_000,
        })
      } else {
        await this.git.run(["update-ref", "-d", ref], {
          cwd: this.storePath,
          env: this.gitEnv(undefined),
          timeoutMs: 10_000,
          allowExitCodes: [0, 1, 128],
        })
      }
      if (stale.length > 0 || (await this.storeBytes()) > policy.maxStoreBytes) {
        await this.git.run(["reflog", "expire", "--expire=now", "--all"], {
          cwd: this.storePath,
          env: this.gitEnv(undefined),
          timeoutMs: GIT_TIMEOUT_MS,
          allowExitCodes: [0, 128],
        })
        await this.git.run(["gc", "--prune=now", "--quiet"], {
          cwd: this.storePath,
          env: this.gitEnv(undefined),
          timeoutMs: GIT_TIMEOUT_MS,
        })
      }
    } catch (error) {
      this.logger.warn("checkpoints.prune_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async storeBytes(): Promise<number> {
    try {
      const result = await this.git.run(["count-objects", "-v"], {
        cwd: this.storePath,
        env: this.gitEnv(undefined),
        timeoutMs: 10_000,
      })
      let kib = 0
      for (const line of result.stdout.split("\n")) {
        const match = /^(size|size-pack):\s+(\d+)/.exec(line.trim())
        if (match) kib += Number(match[2])
      }
      return kib * 1024
    } catch {
      return 0
    }
  }

  private parseShortStat(text: string): { files: number; insertions: number; deletions: number } {
    const files = /(\d+)\s+files? changed/.exec(text)
    const insertions = /(\d+)\s+insertions?\(\+\)/.exec(text)
    const deletions = /(\d+)\s+deletions?\(-\)/.exec(text)
    return {
      files: files ? Number(files[1]) : 0,
      insertions: insertions ? Number(insertions[1]) : 0,
      deletions: deletions ? Number(deletions[1]) : 0,
    }
  }

  private clearStaleIndexLock(index: string): void {
    const lock = `${index}.lock`
    try {
      if (!existsSync(lock)) return
      const ageMs = Date.now() - statSync(lock).mtimeMs
      if (ageMs < 10 * 60 * 1000) return
      unlinkSync(lock)
      this.logger.warn("checkpoints.stale_index_lock_removed", { lock, ageMs })
    } catch {
      // A live Git process or a permission error keeps the lock.
    }
  }

  private gitEnv(workspace: string | undefined, index?: string): NodeJS.ProcessEnv {
    const env = isolatedGitEnv()
    env.GIT_DIR = this.storePath
    if (workspace) env.GIT_WORK_TREE = workspace
    if (index) env.GIT_INDEX_FILE = index
    return env
  }
}
