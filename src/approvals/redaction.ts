const SECRET_KEY = /(?:pass(?:word|wd)?|token|secret|api[_-]?key|access[_-]?key|cookie|authorization|credential)/i

const COMMAND_PATTERNS: Array<[RegExp, string]> = [
  [/((?:--?|\/)(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|cookie)\s*[= ]\s*)\S+/gi, "$1[REDACTED]"],
  [/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[REDACTED]"],
  [/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*=\s*)\S+/gi, "$1[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
]

export function redactCommand(command: string): string {
  let value = command
  for (const [pattern, replacement] of COMMAND_PATTERNS) value = value.replace(pattern, replacement)
  return value
}

export function redactForDisplay(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]"
  if (typeof value === "string") return redactCommand(value)
  if (Array.isArray(value)) return value.map((entry) => redactForDisplay(entry, depth + 1))
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactForDisplay(entry, depth + 1)
    }
    return result
  }
  return value
}
