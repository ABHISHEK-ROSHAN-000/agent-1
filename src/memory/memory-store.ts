import {
  MemoryError,
  type MemoryOperation,
  type MemoryOperationAction,
  type MemoryStoreName,
  type MemoryStoreResult,
  type MemoryUsage,
} from "./types"

export const ENTRY_DELIMITER = "\n§\n"

const MATCH_FOLD: Readonly<Record<string, string>> = {
  "\"": "'",
  "`": "'",
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u201c": "'",
  "\u201d": "'",
  "\u201e": "'",
  "\u201f": "'",
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
}

export function codePointLength(value: string): number {
  return Array.from(value).length
}

export function normalizeForMatch(value: string): string {
  let folded = value
  for (const [from, to] of Object.entries(MATCH_FOLD)) folded = folded.split(from).join(to)
  return folded.replace(/\\n/g, " ").replace(/\s+/g, " ").trim()
}

function hasAlphanumeric(value: string): boolean {
  return /[a-z0-9]/i.test(value)
}

function normalizeEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const entry of entries) {
    const content = entry.trim()
    if (!content || seen.has(content)) continue
    seen.add(content)
    normalized.push(content)
  }
  return normalized
}

function countOccurrences(text: string, span: string): number {
  if (!span) return 0
  let count = 0
  for (let index = 0; index <= text.length - span.length; index += 1) {
    if (text.startsWith(span, index)) count += 1
  }
  return count
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
}

function closestEntries(entries: readonly string[], oldText: string): string[] {
  const needle = words(oldText)
  if (needle.size === 0) return []
  const scored = entries
    .map((entry, index) => {
      const entryWords = words(entry)
      let shared = 0
      for (const word of needle) if (entryWords.has(word)) shared += 1
      return { entry, index, score: shared / needle.size }
    })
    .filter((item) => item.score >= 0.3)
    .sort((left, right) => right.score - left.score || left.index - right.index)
  return scored.slice(0, 3).map((item) => item.entry)
}

function usageFor(entries: readonly string[], limit: number): MemoryUsage {
  const chars = codePointLength(entries.join(ENTRY_DELIMITER))
  return {
    chars,
    limit,
    percent: limit > 0 ? Math.min(100, Math.floor((chars / limit) * 100)) : 0,
  }
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

export class MemoryStore {
  private readonly values: string[]

  constructor(
    readonly name: MemoryStoreName,
    readonly limit: number,
    entries: readonly string[],
  ) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("Memory limit must be a positive integer")
    this.values = normalizeEntries(entries)
  }

  get entries(): readonly string[] {
    return [...this.values]
  }

  get usage(): MemoryUsage {
    return usageFor(this.values, this.limit)
  }

  resolveEntry(oldText: string): { readonly index: number; readonly entry: string } {
    return this.locate(this.values, oldText)
  }

  apply(operations: readonly MemoryOperation[]): MemoryStoreResult {
    if (operations.length === 0) {
      throw new MemoryError("empty_operations", "At least one memory operation is required.")
    }

    const working = [...this.values]
    let duplicateAdd = false

    for (const operation of operations) {
      switch (operation.action) {
        case "add": {
          const content = (operation.content ?? "").trim()
          if (!content) {
            throw new MemoryError("missing_content", "Content is required for the 'add' action.")
          }
          if (working.includes(content)) {
            duplicateAdd = true
          } else {
            working.push(content)
          }
          break
        }
        case "patch": {
          const oldText = operation.oldText ?? ""
          if (!oldText.trim()) {
            throw new MemoryError(
              "missing_old_text",
              "'patch' needs oldText, a unique substring of the entry to patch.",
              { currentEntries: working, usage: usageFor(working, this.limit) },
            )
          }
          const content = operation.content ?? ""
          if (!content.trim()) {
            throw new MemoryError(
              "missing_content",
              "Content is required for 'patch'; use 'remove' to delete an entry.",
            )
          }
          const located = this.locate(working, oldText)
          const patched = this.patchEntry(located.entry, oldText, content)
          working[located.index] = patched
          break
        }
        case "remove": {
          const oldText = operation.oldText ?? ""
          if (!oldText.trim()) {
            throw new MemoryError(
              "missing_old_text",
              "'remove' needs oldText, a unique substring of the entry to remove.",
              { currentEntries: working, usage: usageFor(working, this.limit) },
            )
          }
          const located = this.locate(working, oldText)
          working.splice(located.index, 1)
          break
        }
      }
    }

    if (this.values.length > 0 && working.length === 0 && !(operations.length === 1 && operations[0]?.action === "remove")) {
      throw new MemoryError(
        "would_empty",
        "Refusing to empty the memory store. Keep at least one entry, or remove one entry deliberately.",
        { currentEntries: working, usage: usageFor(working, this.limit) },
      )
    }

    const usage = usageFor(working, this.limit)
    if (usage.chars > this.limit) {
      throw new MemoryError(
        "over_limit",
        `Memory would be at ${usage.chars}/${this.limit} chars; free at least ${usage.chars - this.limit} chars.`,
        {
          currentEntries: working,
          usage,
          requiredFree: usage.chars - this.limit,
        },
      )
    }

    const changed = !sameEntries(this.values, working)
    const actions = operations.map((operation) => operation.action)
    const message = changed
      ? actions.length > 1
        ? `Applied ${actions.length} operation(s).`
        : operations[0]?.action === "add"
          ? "Entry added."
          : operations[0]?.action === "patch"
            ? "Entry patched."
            : "Entry removed."
      : duplicateAdd
        ? "Entry already exists (no duplicate added)."
        : "No memory change was needed."

    return { store: this.name, actions, changed, message, entries: working, usage }
  }

  applyPinned(
    action: MemoryOperationAction,
    matchedEntry: string,
    content?: string,
    oldText?: string,
  ): MemoryStoreResult {
    if (action === "add") {
      return this.apply([{ action: "add", content }])
    }

    const index = this.values.indexOf(matchedEntry)
    if (index < 0) {
      throw new MemoryError(
        "stale_entry",
        "The reviewed entry is no longer in memory. Nothing was applied; reject the pending change or recreate it.",
      )
    }

    let working: string[]
    if (action === "remove") {
      working = this.values.filter((_, position) => position !== index)
    } else {
      const replacement = (content ?? "").trim()
      if (!replacement) {
        throw new MemoryError("missing_content", "Content is required for 'patch'.")
      }
      const span = oldText ?? ""
      if (!span.trim()) throw new MemoryError("missing_old_text", "oldText is required for 'patch'.")
      const patched = this.patchEntry(matchedEntry, span, replacement)
      working = this.values.map((entry, position) => (position === index ? patched : entry))
    }

    if (working.length === 0 && action !== "remove") {
      throw new MemoryError("would_empty", "Refusing to empty the memory store.")
    }
    const usage = usageFor(working, this.limit)
    if (usage.chars > this.limit) {
      throw new MemoryError(
        "over_limit",
        `Memory would be at ${usage.chars}/${this.limit} chars; free at least ${usage.chars - this.limit} chars.`,
        { currentEntries: working, usage, requiredFree: usage.chars - this.limit },
      )
    }

    return {
      store: this.name,
      actions: [action],
      changed: !sameEntries(this.values, working),
      message: action === "remove" ? "Entry removed." : "Entry patched.",
      entries: working,
      usage,
    }
  }

  renderBlock(): string | null {
    if (this.values.length === 0) return null
    const usage = this.usage
    const title = this.name === "user" ? "USER PROFILE (who the user is)" : "MEMORY (your personal notes)"
    const rule = "═".repeat(46)
    return `${rule}\n${title} [${usage.percent}% — ${usage.chars.toLocaleString("en-US")}/${usage.limit.toLocaleString("en-US")} chars]\n${rule}\n${this.values.join(ENTRY_DELIMITER)}`
  }

  renderMarkdown(): string {
    const title = this.name === "user" ? "USER" : "MEMORY"
    if (this.values.length === 0) return `# ${title}\n`
    return `# ${title}\n\n${this.values.join("\n\n")}\n`
  }

  private locate(entries: readonly string[], oldText: string): { readonly index: number; readonly entry: string } {
    if (!oldText.trim()) {
      throw new MemoryError("missing_old_text", "A short unique substring is required.", {
        currentEntries: entries,
        usage: usageFor(entries, this.limit),
      })
    }

    const exactWhole = entries.findIndex((entry) => entry === oldText)
    if (exactWhole >= 0) return { index: exactWhole, entry: entries[exactWhole]! }

    const exact = entries
      .map((entry, index) => ({ entry, index }))
      .filter((item) => item.entry.includes(oldText))
    if (exact.length > 1) {
      throw new MemoryError(
        "ambiguous",
        `Multiple entries matched '${oldText}'. Be more specific.`,
        { matches: exact.map((item) => this.preview(item.entry)) },
      )
    }
    if (exact.length === 1 && exact[0]) return exact[0]

    const needle = normalizeForMatch(oldText)
    if (hasAlphanumeric(needle)) {
      const folded = entries
        .map((entry, index) => ({ entry, index }))
        .filter((item) => normalizeForMatch(item.entry).includes(needle))
      if (folded.length > 1) {
        throw new MemoryError(
          "ambiguous",
          `Multiple entries matched '${oldText}'. Be more specific.`,
          { matches: folded.map((item) => this.preview(item.entry)) },
        )
      }
      if (folded.length === 1 && folded[0]) return folded[0]
    }

    throw new MemoryError(
      "not_found",
      `No entry matched '${oldText}'. Retry with oldText copied verbatim from the intended entry.`,
      {
        currentEntries: entries,
        usage: usageFor(entries, this.limit),
        closestEntries: closestEntries(entries, oldText),
      },
    )
  }

  private patchEntry(entry: string, oldText: string, content: string): string {
    const count = countOccurrences(entry, oldText)
    if (count > 1) {
      throw new MemoryError(
        "repeated_span",
        `'${oldText}' appears ${count} times in the matched entry; include more surrounding text so it occurs once.`,
      )
    }
    if (count === 0) {
      throw new MemoryError(
        "span_not_found",
        `The matched entry does not contain the exact span '${oldText}'. Use the exact text from the entry.`,
      )
    }
    const patched = entry.replace(oldText, content)
    if (patched === entry) {
      throw new MemoryError("no_op", "The patch leaves the entry unchanged.")
    }
    return patched
  }

  private preview(entry: string): string {
    return entry.length > 80 ? `${entry.slice(0, 80)}...` : entry
  }
}
