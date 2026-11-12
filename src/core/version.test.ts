import { expect, test } from "bun:test"
import { CLI_NAME, PHASE, PRODUCT_NAME, VERSION } from "./version"

test("product metadata is present", () => {
  expect(PRODUCT_NAME).toBe("Agent-1")
  expect(CLI_NAME).toBe("agent-1")
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  expect(PHASE).toContain("Phase 8G")
})
