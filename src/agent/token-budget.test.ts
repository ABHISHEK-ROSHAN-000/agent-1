import { expect, test } from "bun:test"
import { outputLimit } from "./token-budget"

test("caps a catalog output limit at the supported maximum", () => {
  expect(outputLimit({ contextWindow: 512_000, maxOutputTokens: 460_800 })).toBe(256_000)
  expect(outputLimit({ contextWindow: 512_000, maxOutputTokens: 200_000 })).toBe(200_000)
  expect(outputLimit({ contextWindow: 512_000, maxOutputTokens: 0 })).toBe(32_000)
})

test("fits the output budget into the remaining context", () => {
  expect(
    outputLimit(
      { contextWindow: 512_000, maxOutputTokens: 256_000 },
      { estimated: 100_000 },
      0.01,
    ),
  ).toBe(256_000)
  expect(
    outputLimit(
      { contextWindow: 10_000, maxOutputTokens: 8_000 },
      { measured: 4_000, estimated: 4_000 },
      0.01,
    ),
  ).toBe(1_300)
})
