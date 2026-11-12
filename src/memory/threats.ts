import { MemoryError } from "./types"

export type ThreatScope = "all" | "context" | "strict"

interface ThreatRule {
  readonly id: string
  readonly scope: ThreatScope
  readonly matches: (text: string) => boolean
}

export const MAX_SCAN_CHARS = 65_536

/**
 * Memory is injected into the system prompt, so these checks are deliberately
 * aggressive for memory writes. They are heuristic guardrails, not a sandbox.
 */
const RULES: readonly ThreatRule[] = [
  {
    id: "instruction_override",
    scope: "all",
    matches: (text) =>
      ordered(text, ["ignore", "instructions"]) &&
      (text.includes("previous") || text.includes("prior") || text.includes("above") || text.includes("all")),
  },
  {
    id: "prompt_override",
    scope: "all",
    matches: (text) =>
      text.includes("system prompt") &&
      (text.includes("override") || text.includes("reveal") || text.includes("print") || text.includes("output")),
  },
  {
    id: "rule_bypass",
    scope: "all",
    matches: (text) =>
      (text.includes("disregard") &&
        (text.includes("rule") || text.includes("instruction") || text.includes("guideline"))) ||
      text.includes("without restrictions") ||
      text.includes("without limitations") ||
      text.includes("no restrictions"),
  },
  {
    id: "role_change",
    scope: "context",
    matches: (text) => /\byou\s+are\s+now\s+(?:a|an|the)\b/.test(text) || /\bpretend\s+(?:you\s+are|to\s+be)\b/.test(text),
  },
  {
    id: "prompt_leak",
    scope: "context",
    matches: (text) =>
      (text.includes("system prompt") || text.includes("initial prompt")) &&
      (text.includes("print") || text.includes("show") || text.includes("reveal") || text.includes("output")),
  },
  {
    id: "deception",
    scope: "all",
    matches: (text) => ordered(text, ["do", "not", "tell", "user"], 80),
  },
  {
    id: "hidden_html",
    scope: "all",
    matches: (text) =>
      /<!--[^>]{0,500}(?:ignore|override|system|secret|hidden)[^>]{0,500}-->/i.test(text) ||
      /<\s*div\b[^>]{0,1600}display\s*:\s*none/i.test(text),
  },
  {
    id: "translate_execute",
    scope: "context",
    matches: (text) => text.includes("translate") && text.includes("and") && /\b(?:execute|run|eval)\b/.test(text),
  },
  {
    id: "network_exfiltration",
    scope: "all",
    matches: (text) =>
      /\b(?:curl|wget)\b[^\n]{0,350}(?:\$\{?\w*(?:key|token|secret|password|credential)|(?:api[_-]?key|token|secret|password|credential)s?)\b/i.test(
        text,
      ),
  },
  {
    id: "secret_file_access",
    scope: "all",
    matches: (text) =>
      /\b(?:cat|type|read|copy|cp|move|mv)\b[^\n]{0,220}(?:\.env|\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials)\b/i.test(
        text,
      ),
  },
  {
    id: "outbound_data",
    scope: "strict",
    matches: (text) => /\b(?:send|post|upload|transmit)\b[^\n]{0,220}\b(?:to|at)\s+https?:\/\//i.test(text),
  },
  {
    id: "conversation_exfiltration",
    scope: "strict",
    matches: (text) =>
      /\b(?:include|output|print|share)\b[^\n]{0,120}(?:conversation|chat history|previous messages|full context|entire context)/i.test(
        text,
      ),
  },
  {
    id: "ssh_persistence",
    scope: "strict",
    matches: (text) =>
      /authorized_keys/i.test(text) ||
      (/(?:>>?|\b(?:echo|cat|cp|mv|tee|write|append|chmod|chown|rm|touch)\b)[^\n]{0,180}(?:\$HOME\/\.ssh|~\/\.ssh)/i.test(
        text,
      )),
  },
  {
    id: "agent_config_tamper",
    scope: "strict",
    matches: (text) =>
      /\b(?:write|edit|modify|change|append|update|add)\b[^\n]{0,220}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)/i.test(
        text,
      ),
  },
  {
    id: "runtime_config_tamper",
    scope: "strict",
    matches: (text) =>
      /\b(?:write|edit|modify|change|append|update|add)\b[^\n]{0,220}(?:\.agent1\/(?:config\.yaml|SOUL\.md)|\.agent1\/\.env)/i.test(
        text,
      ),
  },
  {
    id: "hardcoded_secret",
    scope: "strict",
    matches: (text) =>
      /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}["']/i.test(text),
  },
  {
    id: "c2_control",
    scope: "context",
    matches: (text) =>
      /\b(?:command and control|c2 (?:server|channel|beacon|infrastructure)|cobalt strike|metasploit|brainworm)\b/i.test(
        text,
      ) ||
      /\b(?:heartbeat|beacon|check[ -]?in)\s+(?:to|with)\b/i.test(text) ||
      /\bregister\s+(?:as\s+)?a?\s*node\b/i.test(text),
  },
  {
    id: "forced_network_action",
    scope: "context",
    matches: (text) => /\byou must\b[^\n]{0,80}\b(?:register|connect|report|beacon)\b/i.test(text),
  },
  {
    id: "runtime_tamper",
    scope: "context",
    matches: (text) => /\bunset\b[^\n]{0,80}(?:CLAUDE|CODEX|AGENT1|AGENT|OPENAI|ANTHROPIC)/i.test(text),
  },
  {
    id: "forensic_evasion",
    scope: "context",
    matches: (text) =>
      /\bonly use one[- ]?liners?\b/i.test(text) ||
      /\bnever\b[^\n]{0,80}\b(?:create|write)\b[^\n]{0,80}\b(?:script|file)\b[^\n]{0,80}\bdisk\b/i.test(text),
  },
]

const SCOPE_INCLUDES: Readonly<Record<ThreatScope, readonly ThreatScope[]>> = {
  all: ["all"],
  context: ["all", "context"],
  strict: ["all", "context", "strict"],
}

export const INVISIBLE_CHARS = new Set([
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\u2062",
  "\u2063",
  "\u2064",
  "\ufeff",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
])

function compact(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
}

function ordered(text: string, parts: readonly string[], maxGap = 120): boolean {
  let cursor = 0
  for (const part of parts) {
    const found = text.indexOf(part, cursor)
    if (found < 0 || found - cursor > maxGap) return false
    cursor = found + part.length
  }
  return true
}

export function scanForThreats(content: string, scope: ThreatScope = "strict"): string[] {
  if (!content) return []
  const scanned = content.slice(0, MAX_SCAN_CHARS)
  const included = new Set(SCOPE_INCLUDES[scope])
  const findings: string[] = []

  for (const character of new Set(scanned)) {
    if (INVISIBLE_CHARS.has(character)) {
      findings.push(`invisible_unicode_U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`)
    }
  }

  const normalized = compact(scanned)
  for (const rule of RULES) {
    if (included.has(rule.scope) && rule.matches(normalized)) findings.push(rule.id)
  }
  return [...new Set(findings)]
}

export function firstThreatMessage(content: string, scope: ThreatScope = "strict"): string | null {
  const finding = scanForThreats(content, scope)[0]
  if (!finding) return null
  if (finding.startsWith("invisible_unicode_")) {
    return `Blocked: content contains invisible unicode character ${finding.replace("invisible_unicode_", "")} (possible injection).`
  }
  return (
    `Blocked: content matches threat pattern '${finding}'. ` +
    "Content is injected into the system prompt and must not contain injection or exfiltration payloads."
  )
}

export function assertSafeMemoryContent(content: string): void {
  const findings = scanForThreats(content, "strict")
  if (findings.length === 0) return
  throw new MemoryError("scan_blocked", firstThreatMessage(content, "strict") ?? "Blocked memory content.", {
    threats: findings,
  })
}
