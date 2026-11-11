import type { Database } from "../db/database"
import type { Message, MessageRole } from "../shared/types"
import type {
  SessionSearchDiscoveryMatch,
  SessionSearchInput,
  SessionSearchMessage,
  SessionSearchResult,
} from "./session-search-types"

const DEFAULT_ROLES: readonly MessageRole[] = ["user", "assistant"]
const ALL_ROLES: readonly MessageRole[] = ["user", "assistant", "tool", "system"]
const READ_HEAD = 20
const READ_TAIL = 10
const MAX_MESSAGE_CHARS = 2_000

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value as number))
}

function parseRoles(value: string | undefined): Set<MessageRole> {
  const requested = (value ?? "")
    .split(",")
    .map((role) => role.trim().toLowerCase())
    .filter((role): role is MessageRole => ALL_ROLES.includes(role as MessageRole))
  return new Set(requested.length > 0 ? requested : DEFAULT_ROLES)
}

function shapeMessage(message: Message): SessionSearchMessage {
  const text = message.text.length > MAX_MESSAGE_CHARS ? `${message.text.slice(0, MAX_MESSAGE_CHARS)}…` : message.text
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    text,
    createdAt: message.createdAt,
    sessionId: message.sessionId,
  }
}

export class SessionSearchService {
  constructor(private readonly db: Database) {}

  async search(input: SessionSearchInput): Promise<SessionSearchResult> {
    try {
      if (input.sessionId) {
        const sessionId = input.sessionId.trim()
        if (input.aroundMessageId) {
          return await this.scroll(sessionId, input.aroundMessageId, input.window)
        }
        return await this.read(sessionId)
      }

      const query = shortText(input.query, 500)
      if (!query) return await this.browse(input.limit)
      return await this.discover(query, input)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async discover(query: string, input: SessionSearchInput): Promise<SessionSearchResult> {
    const roles = parseRoles(input.roleFilter)
    const limit = clamp(input.limit, 5, 1, 10)
    const rows = await this.db.searchMessages(
      query,
      400,
      input.currentSessionId ?? null,
      input.sort ?? "relevance",
    )
    const groups = new Map<
      string,
      { sessionId: string; title: string; updatedAt: string; matches: SessionSearchDiscoveryMatch[] }
    >()

    for (const row of rows) {
      if (!roles.has(row.role)) continue
      let group = groups.get(row.sessionId)
      if (!group) {
        group = {
          sessionId: row.sessionId,
          title: row.sessionTitle,
          updatedAt: row.sessionUpdatedAt,
          matches: [],
        }
        groups.set(row.sessionId, group)
        if (groups.size > limit) {
          groups.delete(row.sessionId)
          break
        }
      }
      if (group.matches.length >= 3) continue
      group.matches.push({
        messageId: row.messageId,
        role: row.role,
        snippet: row.snippet,
        text: row.text.length > 1_200 ? `${row.text.slice(0, 1_200)}…` : row.text,
        createdAt: row.createdAt,
      })
    }

    return {
      ok: true,
      mode: "discover",
      query,
      results: [...groups.values()],
      count: groups.size,
    }
  }

  private async read(sessionId: string): Promise<SessionSearchResult> {
    const session = await this.db.getSession(sessionId)
    if (!session) return { ok: false, error: `Session not found: ${sessionId}` }
    const rows = await this.db.getSessionMessages(sessionId, 500)
    const truncated = rows.length > READ_HEAD + READ_TAIL
    const selected = truncated ? [...rows.slice(0, READ_HEAD), ...rows.slice(-READ_TAIL)] : rows
    return {
      ok: true,
      mode: "read",
      sessionId,
      title: session.title,
      messages: selected.map(shapeMessage),
      count: selected.length,
      total: rows.length,
      truncated,
    }
  }

  private async scroll(
    sessionId: string,
    aroundMessageId: string,
    requestedWindow: number | undefined,
  ): Promise<SessionSearchResult> {
    const session = await this.db.getSession(sessionId)
    if (!session) return { ok: false, error: `Session not found: ${sessionId}` }
    const rows = await this.db.getSessionMessages(sessionId, 500)
    const index = rows.findIndex((message) => message.id === aroundMessageId)
    if (index < 0) {
      return { ok: false, error: `Message not found in session: ${aroundMessageId}` }
    }
    const window = clamp(requestedWindow, 5, 1, 20)
    const start = Math.max(0, index - window)
    const end = Math.min(rows.length, index + window + 1)
    return {
      ok: true,
      mode: "scroll",
      sessionId,
      title: session.title,
      messages: rows.slice(start, end).map(shapeMessage),
      count: end - start,
      total: rows.length,
      messagesBefore: start,
      messagesAfter: rows.length - end,
      window,
    }
  }

  private async browse(requestedLimit: number | undefined): Promise<SessionSearchResult> {
    const limit = clamp(requestedLimit, 10, 1, 10)
    const sessions = await this.db.listSessions()
    return {
      ok: true,
      mode: "browse",
      sessions: sessions.slice(0, limit).map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
      })),
      count: Math.min(limit, sessions.length),
    }
  }
}

function shortText(value: string | undefined, max: number): string {
  const text = value?.trim() ?? ""
  return text.length > max ? text.slice(0, max) : text
}
