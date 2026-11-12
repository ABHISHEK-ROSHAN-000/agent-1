import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { testRender } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { resolveConfig } from "../core/config"
import { configureTestProvider, startTestDaemon, type TestDaemon } from "../test/helpers"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import type { Approval } from "../shared/types"
import { DialogView, HomeView, SessionView, TuiApp } from "./app"

const disposers: Array<() => Promise<void>> = []
const daemons: TestDaemon[] = []
const fakes: FakeOpenAI[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
  for (const fake of fakes.splice(0)) fake.close()
})

const noop = () => undefined
const noopInput = () => undefined

function approval(): Approval {
  return {
    id: "apr_1",
    turnId: "trn_1",
    sessionId: "ses_1",
    toolCallId: "call_1",
    toolName: "shell_exec",
    action: "shell.exec",
    resource: "rm notes.txt",
    patternKey: "rm notes.txt",
    arguments: { command: "rm notes.txt" },
    argumentsHash: "hash",
    displayCommand: "rm notes.txt",
    status: "pending",
    createdAt: "2026-11-12T00:00:00.000Z",
    expiresAt: "2026-11-12T00:05:00.000Z",
    decidedAt: null,
    decidedBy: null,
    reason: null,
    scope: null,
  }
}

function assertWidth(frame: string, width: number): void {
  for (const line of frame.split(/\r?\n/)) {
    expect(line.length).toBeLessThanOrEqual(width)
  }
}

describe("TUI frames", () => {
  for (const [width, height] of [
    [100, 30],
    [80, 24],
    [60, 12],
    [44, 24],
  ] as const) {
    test(`renders Home at ${width}x${height}`, async () => {
      const setup = await testRender(
        () => (
          <HomeView
            draft=""
            files={[]}
            onDraft={noop}
            onRemoveFile={noop}
            onSubmit={noop}
            onQueue={noop}
            leaderActive={() => false}
            onSessions={noop}
            onPalette={noop}
            width={width}
            inputRef={noopInput}
          />
        ),
        { width, height, kittyKeyboard: true },
      )
      disposers.push(() => setup.dispose())
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("AGENT-1")
      expect(frame).toContain("Ask Agent-1")
      assertWidth(frame, width)
    })
  }

  test("permission takeover replaces the composer", async () => {
    const setup = await testRender(
      () => (
        <SessionView
          title="Recovery session"
          messages={[{ id: "msg_1", sessionId: "ses_1", turnId: "trn_1", role: "user", text: "please confirm", createdAt: "now" }]}
          pending={[]}
          queued={[]}
          files={[]}
          onRemoveFile={noop}
          leaderActive={() => false}
          liveText=""
          activeTurn={{ id: "trn_1", status: "waiting_approval", startedAt: "now", updatedAt: "now" }}
          approval={approval()}
          approvalChoice={0}
          rejecting={false}
          rejectReason=""
          onRejectReason={noop}
          onApprovalChoice={noop}
          onDecide={noop as never}
          onCancelReject={noop}
          draft="keep this draft"
          onDraft={noop}
          onSubmit={noop}
          onQueue={noop}
          onSteerFirst={noop}
          onOpenQueue={noop}
          onOpenCheckpoints={noop}
          onOpenStatus={noop}
          onPalette={noop}
          width={100}
          compact={false}
          veryCompact={false}
          inputRef={noopInput}
          dialogInputRef={noopInput}
          rejectInputRef={noopInput}
        />
      ),
      { width: 100, height: 30, kittyKeyboard: true },
    )
    disposers.push(() => setup.dispose())
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Permission required")
    expect(frame).toContain("Approve once")
    expect(frame).not.toContain("Ask Agent-1...")
    assertWidth(frame, 100)
  })

  test("mounts the live daemon-backed shell", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    const config = resolveConfig({ ...process.env, AGENT1_DATA_DIR: daemon.dir })
    const setup = await testRender(
      () => (
        <TuiApp
          bootstrap={{ config, endpoint: daemon.state.url, password: daemon.password }}
        />
      ),
      { width: 100, height: 30, kittyKeyboard: true },
    )
    disposers.push(() => setup.dispose())
    let frame = ""
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      if (frame.includes("AGENT-1") && frame.includes("connected")) break
      await Bun.sleep(25)
    }
    expect(frame).toContain("AGENT-1")
    expect(frame).toContain("connected")
    assertWidth(frame, 100)
  }, 30_000)

  test("submits from Home, takes over the composer for permission, and approves", async () => {
    const fake = startFakeOpenAI()
    fakes.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    await configureTestProvider(daemon.client, fake.url, { name: "TUI model" })
    const config = resolveConfig({ ...process.env, AGENT1_DATA_DIR: daemon.dir })
    const setup = await testRender(
      () => <TuiApp bootstrap={{ config, endpoint: daemon.state.url, password: daemon.password }} />,
      { width: 100, height: 30, kittyKeyboard: true },
    )
    disposers.push(() => setup.dispose())
    setup.renderer.start()
    await setup.waitForFrame((frame) => frame.includes("AGENT-1"), { maxPasses: 60 })
    setup.mockInput.typeText("please confirm")
    ;(setup.renderer.currentFocusedEditor as TextareaRenderable | null)?.submit()
    const waiting = await setup.waitForFrame((frame) => frame.includes("Permission required"), {
      maxPasses: 240,
    })
    expect(waiting).toContain("Approve once")
    expect(waiting).not.toContain("Ask Agent-1...")
    setup.mockInput.pressEnter()
    const completed = await setup.waitForFrame((frame) => frame.includes("Fake final answer"), {
      maxPasses: 300,
    })
    expect(completed).toContain("Fake final answer")
  }, 30_000)

  test("pastes an image path and sends it to a vision model", async () => {
    const fake = startFakeOpenAI()
    fakes.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    await configureTestProvider(daemon.client, fake.url, {
      name: "TUI vision",
      inputModalities: ["text", "image"],
    })
    const config = resolveConfig({ ...process.env, AGENT1_DATA_DIR: daemon.dir })
    const setup = await testRender(
      () => <TuiApp bootstrap={{ config, endpoint: daemon.state.url, password: daemon.password }} />,
      { width: 100, height: 30, kittyKeyboard: true },
    )
    disposers.push(() => setup.dispose())
    setup.renderer.start()
    await setup.waitForFrame((frame) => frame.includes("connected"), { maxPasses: 120 })
    const imagePath = path.join(import.meta.dir, "..", "..", "web", "public", "icon-192.png")
    await setup.mockInput.pasteBracketedText(imagePath)
    await setup.waitForFrame((frame) => frame.includes("icon-192.png"), { maxPasses: 120 })
    ;(setup.renderer.currentFocusedEditor as TextareaRenderable | null)?.submit()
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await setup.renderOnce()
      if (fake.requests.some((request) => JSON.stringify(request.messages).includes("image_url"))) break
      await Bun.sleep(50)
    }
    expect(fake.requests.some((request) => JSON.stringify(request.messages).includes("image_url"))).toBe(true)
  }, 30_000)

  test("renders the queued-prompt dock and pending steer rows", async () => {
    const queued = {
      id: "msg_q",
      sessionId: "ses_1",
      type: "user" as const,
      delivery: "queue" as const,
      payload: { text: "queued follow-up" },
      createdAt: "now",
    }
    const steer = {
      id: "msg_s",
      sessionId: "ses_1",
      type: "user" as const,
      delivery: "steer" as const,
      payload: { text: "steer this now" },
      createdAt: "now",
    }
    const setup = await testRender(
      () => (
        <SessionView
          title="Queue session"
          messages={[]}
          pending={[queued, steer]}
          queued={[queued]}
          files={[]}
          onRemoveFile={noop}
          leaderActive={() => false}
          liveText=""
          activeTurn={{ id: "trn_1", status: "running", startedAt: "now", updatedAt: "now" }}
          approval={undefined}
          approvalChoice={0}
          rejecting={false}
          rejectReason=""
          onRejectReason={noop}
          onApprovalChoice={noop}
          onDecide={noop as never}
          onCancelReject={noop}
          draft=""
          onDraft={noop}
          onSubmit={noop}
          onQueue={noop}
          onSteerFirst={noop}
          onOpenQueue={noop}
          onOpenCheckpoints={noop}
          onOpenStatus={noop}
          onPalette={noop}
          width={100}
          compact={false}
          veryCompact={false}
          inputRef={noopInput}
          dialogInputRef={noopInput}
          rejectInputRef={noopInput}
        />
      ),
      { width: 100, height: 30, kittyKeyboard: true },
    )
    disposers.push(() => setup.dispose())
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("queued 1")
    expect(frame).toContain("queued follow-up")
    expect(frame).toContain("steering")
    assertWidth(frame, 100)
  })

  test("renders command and session dialogs within the viewport", async () => {
    const setup = await testRender(
      () => (
        <DialogView
          dialog="sessions"
          index={0}
          sessions={[
            { id: "ses_1", title: "First session", createdAt: "now", updatedAt: "now" },
            { id: "ses_2", title: "Second session", createdAt: "now", updatedAt: "now" },
          ]}
          commands={[]}
          models={[]}
          checkpoints={[]}
          checkpointDiff={null}
          queued={[]}
          rules={[]}
          memory={{ user: [], notes: [], pending: 0 }}
          settings={null}
          title="First session"
          width={44}
          onRename={noop}
          onSelectModel={noop as never}
          onRestore={noop}
          onCycleApproval={noop}
          inputRef={noopInput}
        />
      ),
      { width: 44, height: 24, kittyKeyboard: true },
    )
    disposers.push(() => setup.dispose())
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Sessions")
    expect(frame).toContain("First session")
    assertWidth(frame, 44)
  })
})
