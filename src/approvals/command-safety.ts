const HARDLINE_PATTERNS: Array<[RegExp, string]> = [
  [/\bformat(?:\.com)?\b/i, "disk formatting"],
  [/\b(?:rm|del|erase|ri|rmdir)\b[\s\S]*\b[a-z]:\\(?:\s|$)/i, "drive deletion"],
  [/\b(?:remove-item|ri)\b[\s\S]*-recurse\b[\s\S]*-force\b[\s\S]*\b[a-z]:\\(?:\s|$)/i, "drive deletion"],
  [/\bdiskpart\b/i, "disk partitioning"],
  [/\bbcdedit\b/i, "boot configuration"],
  [/\bvssadmin\b.*\bdelete\b/i, "shadow copy deletion"],
  [/\bwbadmin\b.*\bdelete\b/i, "backup deletion"],
  [/\bcipher\b.*\/w\b/i, "disk wiping"],
  [/\brm\s+-(?:[a-z]*[rf][a-z]*)\s+\/(?:\s|$)/i, "root filesystem deletion"],
  [/\bdel\b.*\/[fsq].*[a-z]:\\(?:\s|$)/i, "drive deletion"],
  [/\bRemove-Item\b.*-Recurse\b.*-Force\b.*[a-z]:\\(?:\s|$)/i, "drive deletion"],
  [/\b(?:shutdown|Restart-Computer|Stop-Computer)\b/i, "system shutdown"],
  [/\breg\s+delete\s+HKLM\b/i, "registry deletion"],
  [/\bnet\s+user\b.*\/delete\b/i, "account deletion"],
]

const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\b/i, "recursive deletion"],
  [/\b(?:del|erase)\b/i, "file deletion"],
  [/\b(?:rmdir|rd)\b/i, "directory deletion"],
  [/\b(?:move|mv|ren|rename)\b/i, "file move or rename"],
  [/\b(?:copy|cp|xcopy|robocopy)\b/i, "file copy"],
  [/\bsed\b.*-i\b/i, "in-place file edit"],
  [/\btruncate\b/i, "file truncation"],
  [/\bshred\b/i, "file shredding"],
  [/\btee\b/i, "file write"],
  [/(?:^|[^>])>(?!>)/i, "output redirection"],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*|checkout\s+--(?:\s|$))/i, "destructive git operation"],
  [/\btaskkill\b/i, "process termination"],
  [/\breg\s+(?:add|delete)\b/i, "registry modification"],
  [/\b(?:icacls|takeown)\b/i, "permission modification"],
  [/\bschtasks\b.*\/delete\b/i, "scheduled task deletion"],
  [/\bsc\s+delete\b/i, "service deletion"],
  [/\b(?:curl|wget)\b.*\s-(?:o|O)\b/i, "download to file"],
  [/\bInvoke-WebRequest\b.*-OutFile\b/i, "download to file"],
  [/\bStart-Process\b/i, "process launch"],
]

function normalized(command: string): string {
  // cmd.exe caret escapes and PowerShell backtick escapes must not hide the
  // command name from the policy. Quoting is removed only for matching.
  return command.replace(/[\^`"']/g, "")
}

function match(patterns: Array<[RegExp, string]>, command: string): string | null {
  const value = normalized(command)
  for (const [pattern, reason] of patterns) if (pattern.test(value)) return reason
  return null
}

function hasCommandJoin(command: string): boolean {
  return /(?:&&|\|\||[;&|\n\r]|\$\(|`)/.test(command)
}

export function hardlineCommand(command: string): string | null {
  return match(HARDLINE_PATTERNS, command)
}

export function dangerousCommand(command: string): string | null {
  return match(DANGEROUS_PATTERNS, command)
}

export function commandPatternKey(command: string, cwd?: string | null): string {
  return `${cwd ?? ""}\u0000${command}`
}

export function matchesAllowlist(command: string, patterns: readonly string[]): string | null {
  const joined = hasCommandJoin(command)
  for (const pattern of patterns) {
    const trimmed = pattern.trim()
    if (!trimmed) continue
    if (trimmed === command) return trimmed
    // A wildcard approval for one command must never cover a joined command
    // whose later segment was not reviewed.
    if (joined && trimmed !== "*") continue
    if (trimmed.endsWith("*") && command.startsWith(trimmed.slice(0, -1))) return trimmed
    if (trimmed.startsWith("*") && command.endsWith(trimmed.slice(1))) return trimmed
  }
  return null
}

export function parseStringList(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
}
