export const INTERRUPT_WINDOW_MS = 5_000

export const APPROVAL_OPTIONS = [
  "Approve once",
  "Approve for session",
  "Always allow",
  "Reject",
] as const

export const APPROVAL_SCOPES = ["once", "session", "always", null] as const

export function canInterrupt(armedAt: number, now: number): boolean {
  return armedAt > 0 && now - armedAt <= INTERRUPT_WINDOW_MS
}

export function ctrlCAction(input: {
  readonly overlayOpen: boolean
  readonly promptFocused: boolean
  readonly hasText: boolean
}): "clear" | "exit" {
  return !input.overlayOpen && input.promptFocused && input.hasText ? "clear" : "exit"
}

export function ctrlDAction(input: {
  readonly dialogOpen: boolean
  readonly promptFocused: boolean
  readonly hasText: boolean
}): "input" | "exit" | "ignore" {
  if (input.dialogOpen) return "ignore"
  if (input.promptFocused && input.hasText) return "input"
  return "exit"
}

export type LayoutTier = "wide" | "standard" | "compact" | "narrow"

export function layoutTier(width: number): LayoutTier {
  if (width >= 96) return "wide"
  if (width >= 72) return "standard"
  if (width >= 52) return "compact"
  return "narrow"
}

export function approvalScope(index: number) {
  return APPROVAL_SCOPES[index] ?? null
}
