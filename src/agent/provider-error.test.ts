import { expect, test } from "bun:test"
import {
  isOneShotRetryable,
  isRetryableProviderError,
  providerErrorInfo,
  retryDelayMs,
} from "./provider-error"

function apiError(status: number, body: unknown): Error {
  return Object.assign(new Error("Provider returned error"), {
    statusCode: status,
    responseBody: JSON.stringify(body),
  })
}

test("classifies provider failures and preserves status/provider detail", () => {
  const bad = providerErrorInfo(
    apiError(400, {
      error: {
        message: "Provider returned error",
        metadata: { raw: JSON.stringify({ code: 400, msg: "bad request", provider_name: "AtlasCloud" }) },
      },
    }),
  )
  expect(bad.kind).toBe("invalid-request")
  expect(bad.status).toBe(400)
  expect(bad.message).toContain("HTTP 400")
  expect(bad.message).toContain("bad request")

  expect(providerErrorInfo(apiError(401, { error: "unauthorized" })).kind).toBe("auth")
  expect(providerErrorInfo(apiError(429, { error: "too many requests" })).kind).toBe("rate-limit")
  expect(
    providerErrorInfo(apiError(400, { error: "maximum context length exceeded" })).kind,
  ).toBe("context-overflow")
})

test("retries transient errors but not deterministic 400s", () => {
  const transient = providerErrorInfo(apiError(429, { error: "slow down" }))
  expect(isRetryableProviderError(apiError(429, { error: "slow down" }))).toBe(true)
  expect(isRetryableProviderError(apiError(400, { error: "bad request" }))).toBe(false)
  expect(retryDelayMs(1, transient, 10)).toBeGreaterThanOrEqual(8)
})

test("one-shot calls only retry failures that never reached the provider", () => {
  expect(isOneShotRetryable(apiError(429, { error: "slow down" }))).toBe(true)
  expect(isOneShotRetryable(apiError(503, { error: "unavailable" }))).toBe(true)
  expect(isOneShotRetryable(apiError(500, { error: "boom" }))).toBe(false)
  expect(isOneShotRetryable(apiError(400, { error: "bad request" }))).toBe(false)
  expect(
    isOneShotRetryable(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
  ).toBe(true)
})
