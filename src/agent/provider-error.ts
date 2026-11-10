export type ProviderErrorKind =
  | "rate-limit"
  | "quota"
  | "auth"
  | "content-policy"
  | "context-overflow"
  | "provider-internal"
  | "transport"
  | "invalid-request"
  | "unknown"

export interface ProviderErrorInfo {
  readonly kind: ProviderErrorKind
  readonly message: string
  readonly status?: number
  readonly providerMessage?: string
  readonly retryAfterMs?: number
}

export class ProviderTurnError extends Error {
  constructor(
    readonly info: ProviderErrorInfo,
    override readonly cause?: unknown,
  ) {
    super(info.message)
    this.name = "ProviderTurnError"
  }
}

const CONTEXT_OVERFLOW =
  /context (?:window|length)|too many tokens|prompt is too long|input is too long|request too large|maximum context/i
const CONTENT_POLICY = /content policy|content filter|moderation|safety system|usage policy/i
const AUTH_TEXT = /invalid api key|incorrect api key|authentication|unauthorized|forbidden/i
const TRANSPORT_TEXT = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|Cannot connect|fetch failed|network/i

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function parseBody(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

function providerMessage(body: string | undefined, data: unknown): string | undefined {
  const decoded = parseBody(body) ?? record(data)
  const error = record(decoded?.error)
  const metadata = record(error?.metadata)
  const raw = string(metadata?.raw) ?? string(error?.message) ?? string(decoded?.message)
  if (!raw) return string(body)?.slice(0, 2_000)
  let nested: Record<string, unknown> | undefined
  try {
    nested = record(JSON.parse(raw))
  } catch {
    nested = undefined
  }
  const message = string(nested?.msg) ?? string(nested?.message) ?? raw
  return message.slice(0, 2_000)
}

function providerName(body: string | undefined, data: unknown): string | undefined {
  const error = record(record(parseBody(body) ?? record(data))?.error)
  const metadata = record(error?.metadata)
  const raw = string(metadata?.raw)
  let decoded: Record<string, unknown> | undefined
  if (raw) {
    try {
      decoded = record(JSON.parse(raw))
    } catch {
      decoded = undefined
    }
  }
  return string(metadata?.provider_name) ?? string(decoded?.provider_name)
}

function retryAfter(error: unknown): number | undefined {
  const value = record(error)
  const direct = numeric(value?.retryAfterMs)
  if (direct !== undefined) return direct
  const headers = record(value?.responseHeaders) ?? record(value?.headers)
  const header =
    string(headers?.["retry-after"]) ??
    string(headers?.["Retry-After"]) ??
    string(record(value?.data)?.retryAfter as string | undefined)
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function statusOf(error: unknown): number | undefined {
  const value = record(error)
  return (
    numeric(value?.statusCode) ??
    numeric(value?.status) ??
    numeric(record(value?.data)?.status) ??
    numeric(record(value?.data)?.statusCode)
  )
}

function kindFor(status: number | undefined, text: string): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth"
  if (status === 402) return "quota"
  if (status === 429) return "rate-limit"
  if (status === 400) {
    if (CONTEXT_OVERFLOW.test(text)) return "context-overflow"
    if (CONTENT_POLICY.test(text)) return "content-policy"
    if (AUTH_TEXT.test(text)) return "auth"
    return "invalid-request"
  }
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) return "provider-internal"
  if (CONTENT_POLICY.test(text)) return "content-policy"
  if (AUTH_TEXT.test(text)) return "auth"
  if (status !== undefined && status >= 400 && status < 500) return "invalid-request"
  if (TRANSPORT_TEXT.test(text)) return "transport"
  if (CONTEXT_OVERFLOW.test(text)) return "context-overflow"
  return "unknown"
}

export function providerErrorInfo(error: unknown): ProviderErrorInfo {
  if (error instanceof ProviderTurnError) return error.info
  const value = record(error)
  const body = string(value?.responseBody) ?? string(record(value?.response)?.body)
  const data = value?.data
  const provider = providerMessage(body, data)
  const status = statusOf(error)
  const base = error instanceof Error ? error.message : String(error)
  const text = [base, body ?? "", provider ?? ""].join("\n")
  const kind = kindFor(status, text)
  const providerNameValue = providerName(body, data)
  const suffix = [
    status === undefined ? undefined : `HTTP ${status}`,
    providerNameValue,
  ].filter(Boolean)
  const message =
    provider && provider !== base
      ? `${base}${suffix.length ? ` (${suffix.join(", ")})` : ""}: ${provider}`
      : `${base}${suffix.length ? ` (${suffix.join(", ")})` : ""}`
  const after = retryAfter(error)
  return {
    kind,
    message,
    ...(status === undefined ? {} : { status }),
    ...(provider ? { providerMessage: provider } : {}),
    ...(after === undefined ? {} : { retryAfterMs: after }),
  }
}

export function isRetryableProviderError(error: unknown): boolean {
  if (record(error)?.isRetryable === false) return false
  const info = providerErrorInfo(error)
  if (info.kind === "auth" || info.kind === "quota" || info.kind === "content-policy" || info.kind === "invalid-request") {
    return false
  }
  if (info.kind === "context-overflow") return false
  return true
}

const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])

function transportCode(error: unknown): string | undefined {
  const value = record(error)
  const direct = string(value?.code)
  const cause = record(value?.cause)
  const causeCode = string(cause?.code)
  const causeCause = record(cause?.cause)
  const text = [error instanceof Error ? error.message : String(error), string(cause?.message) ?? ""].join("\n")
  return (
    direct ??
    causeCode ??
    string(causeCause?.code) ??
    [...NOT_SENT_CODES].find((code) => text.includes(code))
  )
}

/**
 * OpenCode's one-shot policy: only retry when the provider clearly did not run
 * the request. One-shot calls can be billed per attempt, so this budget is much
 * smaller than the streaming-turn budget.
 */
export function isOneShotRetryable(error: unknown): boolean {
  if (record(error)?.isRetryable === false) return false
  const info = providerErrorInfo(error)
  if (info.kind === "rate-limit") return true
  if (info.kind === "provider-internal") return info.status === 503 || info.status === 529
  if (info.kind !== "transport") return false
  const code = transportCode(error)
  return code !== undefined && NOT_SENT_CODES.has(code)
}

export function retryDelayMs(attempt: number, info: ProviderErrorInfo, baseMs = 2_000): number {
  const exponential = Math.min(10_000, baseMs * 2 ** Math.max(0, attempt - 1))
  const jitter = 0.8 + Math.random() * 0.4
  const jittered = Math.ceil(exponential * jitter)
  return Math.min(15 * 60_000, Math.max(jittered, info.retryAfterMs ?? 0))
}
