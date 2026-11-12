import { describe, expect, test } from "bun:test"
import {
  activeSessionsResponseSchema,
  knownDurableEventSchema,
  parseKnownDurableEvent,
  sessionRenameRequestSchema,
  settingsContractSchema,
  settingsPatchSchema,
} from "./contracts"

const approvalDecided = {
  seq: 12,
  type: "approval.decided",
  sessionId: "ses_1",
  payload: {
    approvalId: "apr_1",
    turnId: "turn_1",
    sessionId: "ses_1",
    toolCallId: "call_1",
    decision: "approved",
    scope: "once",
    decidedBy: "user",
  },
  createdAt: "2026-11-12T00:00:00.000Z",
} as const

describe("shared contracts", () => {
  test("parses active-session hydration and rejects shape drift", () => {
    const value = activeSessionsResponseSchema.parse({
      active: { ses_1: { status: "running", turnId: "turn_1" } },
    })
    expect(value.active.ses_1?.turnId).toBe("turn_1")
    expect(() =>
      activeSessionsResponseSchema.parse({
        active: { ses_1: { status: "running" } },
      }),
    ).toThrow()
  })

  test("parses durable approval and session events", () => {
    expect(parseKnownDurableEvent(approvalDecided)?.type).toBe("approval.decided")
    expect(
      knownDurableEventSchema.parse({
        seq: 13,
        type: "session.renamed",
        sessionId: "ses_1",
        payload: { sessionId: "ses_1", title: "New title" },
        createdAt: "2026-11-12T00:00:00.000Z",
      }).type,
    ).toBe("session.renamed")
    expect(
      parseKnownDurableEvent({
        ...approvalDecided,
        payload: { ...approvalDecided.payload, decision: "maybe" },
      }),
    ).toBeNull()
  })

  test("parses every inbox event with the OpenCode payload", () => {
    const item = {
      id: "msg_1",
      sessionId: "ses_1",
      type: "user",
      delivery: "queue",
      payload: { text: "queued" },
      createdAt: "2026-11-12T00:00:00.000Z",
    } as const
    const enqueued = knownDurableEventSchema.parse({
      seq: 21,
      type: "session.inbox.enqueued",
      sessionId: "ses_1",
      payload: { sessionId: "ses_1", inboxId: "msg_1", item },
      createdAt: "2026-11-12T00:00:00.000Z",
    })
    expect(enqueued.type).toBe("session.inbox.enqueued")
    expect(
      knownDurableEventSchema.parse({
        seq: 22,
        type: "session.inbox.delivery.changed",
        sessionId: "ses_1",
        payload: { sessionId: "ses_1", inboxId: "msg_1", delivery: "steer" },
        createdAt: "2026-11-12T00:00:00.000Z",
      }).type,
    ).toBe("session.inbox.delivery.changed")
    expect(
      knownDurableEventSchema.parse({
        seq: 23,
        type: "session.inbox.delivered",
        sessionId: "ses_1",
        payload: { sessionId: "ses_1", inboxId: "msg_1" },
        createdAt: "2026-11-12T00:00:00.000Z",
      }).type,
    ).toBe("session.inbox.delivered")
    expect(
      knownDurableEventSchema.parse({
        seq: 24,
        type: "session.inbox.cancelled",
        sessionId: "ses_1",
        payload: { sessionId: "ses_1", inboxId: "msg_1" },
        createdAt: "2026-11-12T00:00:00.000Z",
      }).type,
    ).toBe("session.inbox.cancelled")
  })

  test("validates rename and settings contracts", () => {
    expect(sessionRenameRequestSchema.parse({ title: " Renamed " }).title).toBe("Renamed")
    expect(() => sessionRenameRequestSchema.parse({ title: " " })).toThrow()
    const settings = settingsContractSchema.parse({
      approval: {
        mode: "smart",
        timeoutSeconds: 300,
        deny: [],
        allowlist: [],
        writeSafeRoot: null,
        smartModel: null,
      },
      checkpoints: {
        maxPerRoot: 20,
        maxStoreBytes: 524288000,
        maxFileBytes: 10485760,
        maxFiles: 50000,
        retentionPolicy: "keep-until-pruned",
      },
      models: { default: null },
      tui: { theme: "system", keymap: "default", showToolDetails: true },
    })
    expect(settings.approval.mode).toBe("smart")
    expect(settingsPatchSchema.parse({ approval: { mode: "manual" } }).approval?.mode).toBe("manual")
    expect(() => settingsPatchSchema.parse({ unknown: true })).toThrow()
  })
})
