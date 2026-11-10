import { expect, test } from "bun:test"
import { parseArgs } from "./args"

test("short help and yes aliases do not become option values", () => {
  const parsed = parseArgs(["pair", "--remote", "-y"])
  expect(parsed.positionals).toEqual(["pair"])
  expect(parsed.flags.get("remote")).toBe(true)
  expect(parsed.flags.get("yes")).toBe(true)
  expect(parseArgs(["-h"]).flags.get("help")).toBe(true)
})
