import { expect, test } from "bun:test"
import { dpapiProtect, dpapiUnprotect } from "./dpapi"

test("DPAPI roundtrips a secret", () => {
  const secret = "agent-1-test-secret-32-bytes-long"
  const encrypted = dpapiProtect(secret)
  expect(encrypted.byteLength).toBeGreaterThan(secret.length)
  expect(new TextDecoder().decode(encrypted)).not.toContain(secret)
  expect(dpapiUnprotect(encrypted)).toBe(secret)
})

test("DPAPI rejects an invalid blob", () => {
  expect(() => dpapiUnprotect(new Uint8Array([1, 2, 3, 4]))).toThrow()
})
