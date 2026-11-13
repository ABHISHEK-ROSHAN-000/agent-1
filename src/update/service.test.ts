import { afterEach, describe, expect, test } from "bun:test"
import { checkForUpdate, compareVersions, fetchUpdateManifest, updateInstallerUrl } from "./service"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

function serve(body: unknown, status = 200): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(body, { status }),
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}/latest.json`
}

describe("update service", () => {
  test("compares release versions", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0)
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0)
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0)
    expect(compareVersions("not-a-version", "0.1.0")).toBe(0)
  })

  test("reads a manifest and reports an available update", async () => {
    const url = serve({
      channel: "stable",
      version: "0.2.0",
      url: "https://example.test/agent-1.zip",
      sha256: "abc",
      releaseNotes: "https://example.test/notes",
    })
    expect((await fetchUpdateManifest(url))?.version).toBe("0.2.0")
    const status = await checkForUpdate("0.1.0", url)
    expect(status.available).toBe(true)
    expect(status.latest).toBe("0.2.0")
  })

  test("treats a missing manifest as no update", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("not found", { status: 404 }),
    })
    servers.push(server)
    const url = `http://127.0.0.1:${server.port}/latest.json`
    expect(await fetchUpdateManifest(url)).toBeNull()
    expect((await checkForUpdate("0.1.0", url)).available).toBe(false)
  })

  test("derives the installer URL from the manifest URL", () => {
    expect(updateInstallerUrl("https://example.test/releases/latest/download/latest.json")).toBe(
      "https://example.test/releases/latest/download/install.ps1",
    )
  })
})
