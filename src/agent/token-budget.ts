const OUTPUT_TOKEN_FALLBACK = 32_000
const OUTPUT_TOKEN_MAX = 256_000
const OUTPUT_TOKEN_MIN = 1_024
const ESTIMATE_ERROR = 0.15

export interface OutputLimit {
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

export interface InputTokenEstimate {
  /** Provider-reported input tokens when available. */
  readonly measured?: number
  /** Local estimate used when the provider has not measured the prompt yet. */
  readonly estimated: number
}

/**
 * OpenCode's default output budget: the catalog limit, capped and fitted into
 * the room the prompt leaves in the context window.
 */
export function outputLimit(
  limit: OutputLimit,
  inputTokens?: InputTokenEstimate,
  headroom = 0,
): number {
  const requested = Math.min(
    limit.maxOutputTokens > 0 ? limit.maxOutputTokens : OUTPUT_TOKEN_FALLBACK,
    OUTPUT_TOKEN_MAX,
  )
  if (!inputTokens || limit.contextWindow <= 0) return requested
  const room =
    Math.floor(limit.contextWindow * (1 - headroom)) -
    (inputTokens.measured ?? 0) -
    Math.ceil(inputTokens.estimated * (1 + ESTIMATE_ERROR))
  return Math.min(requested, Math.max(OUTPUT_TOKEN_MIN, room))
}
