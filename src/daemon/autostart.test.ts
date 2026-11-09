import { expect, test } from "bun:test"
import { autostartStatus, disableAutostart, enableAutostart } from "./autostart"

test("autostart can be enabled, queried, and removed", () => {
  const entryName = `Agent-1 Phase1 Test ${process.pid}`
  try {
    const enabled = enableAutostart(entryName)
    expect(enabled.enabled).toBe(true)
    expect(autostartStatus(entryName).enabled).toBe(true)
  } finally {
    const disabled = disableAutostart(entryName)
    expect(disabled.enabled).toBe(false)
    expect(autostartStatus(entryName).enabled).toBe(false)
  }
}, 30_000)
