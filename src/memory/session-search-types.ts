import type { MessageRole } from "../shared/types"

export interface SessionSearchHit {
  readonly messageId: string
  readonly seq: number
  readonly sessionId: string
  readonly sessionTitle: string
  readonly sessionUpdatedAt: string
  readonly role: MessageRole
  readonly text: string
  readonly snippet: string
  readonly createdAt: string
}

export interface SessionSearchInput {
  readonly query?: string
  readonly sessionId?: string
  readonly aroundMessageId?: string
  readonly window?: number
  readonly limit?: number
  readonly sort?: "relevance" | "newest" | "oldest"
  readonly roleFilter?: string
  readonly currentSessionId?: string
}

export interface SessionSearchMessage {
  readonly id: string
  readonly seq: number
  readonly role: MessageRole
  readonly text: string
  readonly createdAt: string
  readonly sessionId: string
}

export interface SessionSearchDiscoveryMatch {
  readonly messageId: string
  readonly role: MessageRole
  readonly snippet: string
  readonly text: string
  readonly createdAt: string
}

export interface SessionSearchDiscovery {
  readonly sessionId: string
  readonly title: string
  readonly updatedAt: string
  readonly matches: readonly SessionSearchDiscoveryMatch[]
}

export interface SessionSearchBrowseItem {
  readonly id: string
  readonly title: string
  readonly updatedAt: string
}

export interface SessionSearchResult {
  readonly ok: boolean
  readonly mode?: "discover" | "read" | "browse" | "scroll"
  readonly query?: string
  readonly sessionId?: string
  readonly title?: string
  readonly results?: readonly SessionSearchDiscovery[]
  readonly sessions?: readonly SessionSearchBrowseItem[]
  readonly messages?: readonly SessionSearchMessage[]
  readonly count?: number
  readonly total?: number
  readonly truncated?: boolean
  readonly messagesBefore?: number
  readonly messagesAfter?: number
  readonly window?: number
  readonly error?: string
}
