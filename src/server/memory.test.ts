import { afterEach, describe, expect, test } from "bun:test"
import { startTestDaemon, type TestDaemon } from "../test/helpers"

const daemons: TestDaemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
})

async function start() {
  const daemon = await startTestDaemon()
  daemons.push(daemon)
  return daemon
}

describe("memory API", () => {
  test("lists, updates, exports, and undoes memory", async () => {
    const daemon = await start()
    const initial = await daemon.client.getMemory()
    expect(initial.user.usage.limit).toBe(1_375)
    expect(initial.memory.usage.limit).toBe(2_200)
    expect(initial.user.entries).toEqual([])

    const added = await daemon.client.updateMemory({
      store: "user",
      operations: [{ action: "add", content: "User prefers concise replies." }],
    })
    expect(added.mutation.changed).toBe(true)
    expect(added.mutation.entries).toContain("User prefers concise replies.")

    const after = await daemon.client.getMemory()
    expect(after.user.entries).toEqual(["User prefers concise replies."])
    expect(after.history.length).toBeGreaterThan(0)

    const undo = await daemon.client.undoMemory(after.history[0]?.id)
    expect(undo.mutation.entries).toEqual([])

    await daemon.client.updateMemory({
      store: "memory",
      operations: [{ action: "add", content: "The project uses Bun." }],
    })
    const markdown = await daemon.client.exportMemory()
    expect(markdown).toContain("# MEMORY")
    expect(markdown).toContain("The project uses Bun.")

    const browse = await daemon.client.searchSessions()
    expect(browse.ok).toBe(true)
    expect(browse.mode).toBe("browse")
  })

  test("returns structured errors for invalid memory operations", async () => {
    const daemon = await start()
    await expect(
      daemon.client.updateMemory({
        store: "user",
        operations: [{ action: "remove", oldText: "does not exist" }],
      }),
    ).rejects.toMatchObject({ code: "not_found" })
  })
})
