import { expect, test } from "bun:test"
import { loggedPath } from "./app"

test("redacts pairing codes from request logs", () => {
  expect(loggedPath("/auth/connect/one-time-secret-code")).toBe("/auth/connect/[redacted]")
  expect(loggedPath("/v1/sessions")).toBe("/v1/sessions")
  expect(loggedPath("/pair")).toBe("/pair")
})
