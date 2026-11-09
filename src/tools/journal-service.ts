import { createHash } from "node:crypto"
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import type { Logger } from "../core/log"
import type { Database, NewJournalEntry } from "../db/database"
import type { JournalEntry, JournalState } from "../shared/types"

export class JournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JournalError"
  }
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

export class JournalService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  async begin(input: NewJournalEntry): Promise<JournalEntry> {
    return this.db.createJournalEntry(input)
  }

  async mark(
    id: string,
    state: JournalState,
    options: { targetHash?: string | null; error?: string | null } = {},
  ): Promise<JournalEntry | null> {
    return this.db.updateJournalEntry(id, state, options)
  }

  async list(limit = 100): Promise<JournalEntry[]> {
    return this.db.listJournal(limit)
  }

  async get(id: string): Promise<JournalEntry | null> {
    return this.db.getJournalEntry(id)
  }

  async listBatch(batchId: string): Promise<JournalEntry[]> {
    return this.db.listJournalBatch(batchId)
  }

  async reconcile(): Promise<void> {
    const entries = await this.db.listUnsettledJournal()
    for (const entry of entries) {
      if (entry.state === "planned") continue
      if (entry.operation === "move" && entry.source && entry.target) {
        const source = existsSync(entry.source)
        const target = existsSync(entry.target)
        if (!source && target) {
          await this.mark(entry.id, "done", {
            targetHash: sha256File(entry.target),
          })
        } else if (source && !target) {
          await this.mark(entry.id, "planned")
        } else {
          await this.mark(entry.id, "unknown", {
            error: source ? "Both source and target exist" : "Neither source nor target exists",
          })
        }
      } else if (entry.operation === "mkdir" && entry.target) {
        await this.mark(entry.id, existsSync(entry.target) ? "done" : "planned")
      } else {
        await this.mark(entry.id, "unknown", { error: "Interrupted operation requires review" })
      }
    }
    if (entries.length > 0) this.logger.info("journal.reconciled", { entries: entries.length })
  }

  async undoBatch(batchId: string): Promise<{
    batchId: string
    undone: number
    skipped: number
    errors: string[]
  }> {
    const entries = (await this.listBatch(batchId)).filter((entry) => entry.state === "done")
    let undone = 0
    let skipped = 0
    const errors: string[] = []

    for (const entry of entries.reverse()) {
      try {
        if (entry.operation === "move") {
          if (!entry.source || !entry.target || !existsSync(entry.target)) {
            skipped++
            continue
          }
          if (existsSync(entry.source)) {
            throw new JournalError(`Source already exists: ${entry.source}`)
          }
          if (entry.targetHash && sha256File(entry.target) !== entry.targetHash) {
            throw new JournalError(`Target changed since the move: ${entry.target}`)
          }
          renameSync(entry.target, entry.source)
          if (entry.sourceHash && sha256File(entry.source) !== entry.sourceHash) {
            throw new JournalError(`Restored file hash mismatch: ${entry.source}`)
          }
          await this.mark(entry.id, "undone")
          undone++
          continue
        }

        if (entry.operation === "mkdir" && entry.target) {
          if (!existsSync(entry.target)) {
            skipped++
            continue
          }
          if (readdirSync(entry.target).length > 0) {
            throw new JournalError(`Directory is no longer empty: ${entry.target}`)
          }
          rmdirSync(entry.target)
          await this.mark(entry.id, "undone")
          undone++
          continue
        }

        if (entry.operation === "write" && entry.target) {
          const undo = entry.undo as { previous?: string | null } | undefined
          if (undo?.previous === null || undo?.previous === undefined) {
            if (existsSync(entry.target)) rmSync(entry.target, { force: false })
          } else {
            const temporary = `${entry.target}.agent1-undo-${process.pid}`
            writeFileSync(temporary, undo.previous, { encoding: "utf8" })
            renameSync(temporary, entry.target)
          }
          await this.mark(entry.id, "undone")
          undone++
          continue
        }

        skipped++
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        await this.mark(entry.id, "unknown", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { batchId, undone, skipped, errors }
  }

  async latestBatchId(): Promise<string | null> {
    const entries = await this.list(1)
    return entries[0]?.batchId ?? null
  }

  fileHash(filePath: string): string {
    return sha256File(filePath)
  }

  ensureDirectory(dir: string): void {
    if (!existsSync(dir)) throw new JournalError(`Directory does not exist: ${dir}`)
    if (!statSync(dir).isDirectory()) throw new JournalError(`Not a directory: ${dir}`)
  }

  normalizeTarget(dir: string, target: string): string {
    return path.resolve(dir, target)
  }
}
