import { afterEach, describe, expect, test } from "bun:test"
import * as pty from "node-pty"
import path from "node:path"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { configureTestProvider, startTestDaemon, waitFor, type TestDaemon } from "../test/helpers"

const daemons: TestDaemon[] = []
const terminals: pty.IPty[] = []
const fakes: FakeOpenAI[] = []

afterEach(async () => {
  for (const terminal of terminals.splice(0)) {
    try {
      terminal.kill()
    } catch {
      // Already exited.
    }
  }
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
  for (const fake of fakes.splice(0)) fake.close()
})

function plain(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B\][^\x07]*\x07/g, "")
}

const describeConPTY = process.platform === "win32" && !process.env.CI ? describe : describe.skip

describeConPTY("TUI ConPTY smoke", () => {
  test("launches in a real Windows pseudo terminal, submits, and renders approval", async () => {
    if (process.platform !== "win32") return
    const fake = startFakeOpenAI()
    fakes.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    await configureTestProvider(daemon.client, fake.url, { name: "ConPTY model" })
    const cwd = path.resolve(import.meta.dir, "..", "..")
    const terminal = pty.spawn(
      process.execPath,
      [path.join("src", "cli", "main.ts"), "tui"],
      {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,
        env: {
          ...process.env,
          AGENT1_DATA_DIR: daemon.dir,
          AGENT1_LOG_LEVEL: "error",
        },
      },
    )
    terminals.push(terminal)
    let output = ""
    terminal.onData((data) => {
      output += data
    })
    await waitFor(() => (plain(output).includes("AGENT-1") ? true : undefined), 20_000)
    expect(plain(output)).toContain("AGENT-1")

    terminal.write("please confirm")
    await Bun.sleep(150)
    terminal.write("\r")
    await waitFor(() => (plain(output).includes("Permission required") ? true : undefined), 20_000)
    expect(plain(output)).toContain("Permission required")

    terminal.resize(80, 24)
    await Bun.sleep(100)
    terminal.resize(44, 24)
    await Bun.sleep(100)
    expect(terminal.cols).toBe(44)
    expect(terminal.rows).toBe(24)
  }, 45_000)

  test("no-argument launch handles bracketed paste, Unicode, resize, and process cleanup", async () => {
    if (process.platform !== "win32") return
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    const terminal = pty.spawn(
      process.execPath,
      [path.join("src", "cli", "main.ts")],
      {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: path.resolve(import.meta.dir, "..", ".."),
        env: {
          ...process.env,
          AGENT1_DATA_DIR: daemon.dir,
          AGENT1_LOG_LEVEL: "error",
        },
      },
    )
    terminals.push(terminal)
    let output = ""
    terminal.onData((data) => {
      output += data
    })
    await waitFor(() => (plain(output).includes("AGENT-1") ? true : undefined), 20_000)
    terminal.write("\x1b[200~café 日本語 한글\x1b[201~")
    await waitFor(
      () => (plain(output).includes("café") && plain(output).includes("日本語") ? true : undefined),
      20_000,
    )
    terminal.resize(80, 24)
    await Bun.sleep(100)
    terminal.resize(44, 24)
    await Bun.sleep(100)
    expect(terminal.cols).toBe(44)
    expect(terminal.rows).toBe(24)
    terminal.kill()
    await Bun.sleep(250)
  }, 30_000)

  test("clears a non-empty prompt on Ctrl+C and exits on the next Ctrl+C", async () => {
    if (process.platform !== "win32") return
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    const terminal = pty.spawn(
      process.execPath,
      [path.join("src", "cli", "main.ts")],
      {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: path.resolve(import.meta.dir, "..", ".."),
        env: {
          ...process.env,
          AGENT1_DATA_DIR: daemon.dir,
          AGENT1_LOG_LEVEL: "error",
        },
      },
    )
    terminals.push(terminal)
    let output = ""
    let exitCode: number | undefined
    terminal.onData((data) => {
      output += data
    })
    terminal.onExit(({ exitCode: code }) => {
      exitCode = code
    })
    await waitFor(() => (plain(output).includes("AGENT-1") ? true : undefined), 20_000)

    terminal.write("draft text")
    await waitFor(() => (plain(output).includes("draft text") ? true : undefined), 10_000)
    terminal.write("\x03")
    await Bun.sleep(400)
    expect(exitCode).toBeUndefined()

    terminal.write("\x03")
    await waitFor(() => (exitCode !== undefined ? true : undefined), 10_000)
    expect(exitCode).toBe(0)
  }, 45_000)

  test("queues a follow-up with the leader binding in a real terminal", async () => {
    if (process.platform !== "win32") return
    const fake = startFakeOpenAI()
    fakes.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    await configureTestProvider(daemon.client, fake.url, { name: "ConPTY queue model" })
    const terminal = pty.spawn(
      process.execPath,
      [path.join("src", "cli", "main.ts"), "tui"],
      {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: path.resolve(import.meta.dir, "..", ".."),
        env: {
          ...process.env,
          AGENT1_DATA_DIR: daemon.dir,
          AGENT1_LOG_LEVEL: "error",
        },
      },
    )
    terminals.push(terminal)
    let output = ""
    terminal.onData((data) => {
      output += data
    })
    await waitFor(() => (plain(output).includes("AGENT-1") ? true : undefined), 20_000)
    terminal.write("please confirm")
    await Bun.sleep(150)
    terminal.write("\r")
    await waitFor(() => (plain(output).includes("Permission required") ? true : undefined), 20_000)

    fake.delayNext(4_000)
    terminal.write("\r")
    await Bun.sleep(800)
    terminal.write("queued from conpty")
    await Bun.sleep(150)
    terminal.write("\x18")
    await Bun.sleep(150)
    terminal.write("\r")
    await waitFor(() => (plain(output).includes("queued 1") ? true : undefined), 20_000)
    expect(plain(output)).toContain("queued 1")
    expect(plain(output)).toContain("queued from conpty")

    terminal.write("\r")
    await waitFor(() => (plain(output).includes("you · steering") ? true : undefined), 20_000)
    expect(plain(output)).toContain("you · steering")
  }, 45_000)
})
