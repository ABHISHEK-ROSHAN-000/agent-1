import { describe, expect, test } from "bun:test"
import { approvalScope, canInterrupt, INTERRUPT_WINDOW_MS, layoutTier } from "./behavior"

describe("TUI behavior", () => {
  test("matches the five-second interrupt window", () => {
    expect(canInterrupt(1000, 6000)).toBe(true)
    expect(canInterrupt(1000, 6001)).toBe(false)
    expect(INTERRUPT_WINDOW_MS).toBe(5000)
  })

  test("maps approval options to Agent-1 scopes", () => {
    expect(approvalScope(0)).toBe("once")
    expect(approvalScope(1)).toBe("session")
    expect(approvalScope(2)).toBe("always")
    expect(approvalScope(3)).toBeNull()
  })

  test("selects layout tiers at the tested widths", () => {
    expect(layoutTier(100)).toBe("wide")
    expect(layoutTier(80)).toBe("standard")
    expect(layoutTier(60)).toBe("compact")
    expect(layoutTier(44)).toBe("narrow")
  })
})
