import { expect, test } from "bun:test"
import { generatePassword, hashPassword, verifyPassword } from "./password"

test("password hashing roundtrips and rejects wrong passwords", async () => {
  const password = generatePassword()
  expect(password.length).toBeGreaterThan(32)
  const hash = await hashPassword(password)
  expect(hash.startsWith("scrypt$v1$")).toBe(true)
  expect(await verifyPassword(password, hash)).toBe(true)
  expect(await verifyPassword("wrong", hash)).toBe(false)
  expect(await verifyPassword(password, "not-a-hash")).toBe(false)
})
