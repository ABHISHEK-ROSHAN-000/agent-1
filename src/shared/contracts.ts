import { z } from "zod"
import type { EventRecord } from "./types"

export const activeTurnStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "resuming",
])

export const activeSessionEntrySchema = z.object({
  status: activeTurnStatusSchema,
  turnId: z.string().min(1),
})

export type ActiveSessionEntry = z.infer<typeof activeSessionEntrySchema>

export const activeSessionsResponseSchema = z.object({
  active: z.record(z.string(), activeSessionEntrySchema),
})

export type ActiveSessionsResponse = z.infer<typeof activeSessionsResponseSchema>

export const activeTurnSchema = z.object({
  id: z.string().min(1),
  status: activeTurnStatusSchema,
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export type ActiveTurn = z.infer<typeof activeTurnSchema>

export const inboxDeliverySchema = z.enum(["steer", "queue"])

export const promptMentionSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
})

export const promptFileSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline") }),
  z.object({ type: z.literal("uri"), uri: z.string().min(1) }),
])

export const storedFileSchema = z.object({
  uri: z.string().regex(/^media:[0-9a-f]{64}$/),
  mime: z.string().min(1),
  source: promptFileSourceSchema,
  name: z.string().optional(),
  description: z.string().optional(),
  mention: promptMentionSchema.optional(),
  bytes: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
})

export const promptFileInputSchema = z.object({
  uri: z.string().min(1).max(30 * 1024 * 1024),
  source: promptFileSourceSchema.optional(),
  name: z.string().max(500).optional(),
  description: z.string().max(2_000).optional(),
  mention: promptMentionSchema.optional(),
})

export const inboxUserPayloadSchema = z.object({
  text: z.string(),
  files: z.array(storedFileSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const inboxUserItemSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  type: z.literal("user"),
  delivery: inboxDeliverySchema,
  payload: inboxUserPayloadSchema,
  createdAt: z.string().min(1),
})

export const inboxItemSchema = inboxUserItemSchema
export const inboxListResponseSchema = z.object({ inbox: z.array(inboxItemSchema) })
export const inboxAdmissionResponseSchema = z
  .object({
    inbox: inboxItemSchema,
    turn: z
      .object({
        id: z.string().min(1),
        status: z.string().min(1),
        startedAt: z.string().min(1),
        updatedAt: z.string().min(1),
      })
      .passthrough()
      .nullable()
      .optional(),
    streamUrl: z.string().nullable().optional(),
    activeTurn: activeTurnSchema.nullable().optional(),
  })
  .passthrough()

export type InboxItemContract = z.infer<typeof inboxItemSchema>

export const sessionContextContractSchema = z
  .object({
    session: z
      .object({
        id: z.string().min(1),
        title: z.string(),
        createdAt: z.string().min(1),
        updatedAt: z.string().min(1),
      })
      .passthrough(),
    activeTurn: activeTurnSchema.nullable(),
    inbox: z.array(inboxItemSchema).optional(),
  })
  .passthrough()

export const sessionRenameRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
  })
  .strict()

export const sessionRenameResponseSchema = z.object({
  session: z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .passthrough(),
})

export const sessionDeletedResponseSchema = z.object({
  ok: z.literal(true),
})

export const approvalConfigContractSchema = z.object({
  mode: z.enum(["smart", "manual", "off"]),
  timeoutSeconds: z.number().int().positive(),
  deny: z.array(z.string()),
  allowlist: z.array(z.string()),
  writeSafeRoot: z.string().nullable(),
  smartModel: z.string().nullable(),
})

export const checkpointPolicySchema = z.object({
  maxPerRoot: z.number().int().positive(),
  maxStoreBytes: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
  retentionPolicy: z.literal("keep-until-pruned"),
})

export type CheckpointPolicy = z.infer<typeof checkpointPolicySchema>

export const modelDefaultSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    reasoningEffort: z.string().nullable(),
  })
  .nullable()

export const tuiPreferencesSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  keymap: z.string().min(1).max(100),
  showToolDetails: z.boolean(),
})

export type TuiPreferences = z.infer<typeof tuiPreferencesSchema>

export const settingsContractSchema = z.object({
  approval: approvalConfigContractSchema,
  checkpoints: checkpointPolicySchema,
  models: z.object({
    default: modelDefaultSchema,
  }),
  tui: tuiPreferencesSchema,
})

export type SettingsContract = z.infer<typeof settingsContractSchema>

export const settingsPatchSchema = z
  .object({
    approval: approvalConfigContractSchema.partial().optional(),
    checkpoints: checkpointPolicySchema.partial().optional(),
    models: z.object({ default: modelDefaultSchema }).partial().optional(),
    tui: tuiPreferencesSchema.partial().optional(),
  })
  .strict()

export type SettingsPatch = z.infer<typeof settingsPatchSchema>

export const settingsResponseSchema = z.object({
  settings: settingsContractSchema,
})

const eventEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
})

const approvalDecidedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("approval.decided"),
  payload: z.object({
    approvalId: z.string().min(1),
    turnId: z.string().min(1),
    sessionId: z.string().min(1),
    toolCallId: z.string().min(1),
    decision: z.enum(["approved", "rejected"]),
    scope: z.enum(["once", "session", "always"]).nullable(),
    decidedBy: z.string().min(1),
  }),
})

const approvalExpiredEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("approval.expired"),
  payload: z.object({
    approvalId: z.string().min(1),
    turnId: z.string().min(1),
    sessionId: z.string().min(1),
    toolCallId: z.string().min(1),
    expiredAt: z.string().min(1),
  }),
})

const sessionRenamedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("session.renamed"),
  payload: z.object({
    sessionId: z.string().min(1),
    title: z.string().min(1),
  }),
})

const sessionDeletedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("session.deleted"),
  payload: z.object({
    sessionId: z.string().min(1),
  }),
})

const inboxEnqueuedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("session.inbox.enqueued"),
  payload: z.object({
    inboxId: z.string().min(1),
    sessionId: z.string().min(1),
    item: inboxItemSchema,
  }),
})

const inboxDeliveredEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("session.inbox.delivered"),
  payload: z.object({
    inboxId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
})

const inboxCancelledEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("session.inbox.cancelled"),
  payload: z.object({
    inboxId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
})

const inboxDeliveryChangedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("session.inbox.delivery.changed"),
  payload: z.object({
    inboxId: z.string().min(1),
    sessionId: z.string().min(1),
    delivery: inboxDeliverySchema,
  }),
})

export const knownDurableEventSchema = z.discriminatedUnion("type", [
  approvalDecidedEventSchema,
  approvalExpiredEventSchema,
  sessionRenamedEventSchema,
  sessionDeletedEventSchema,
  inboxEnqueuedEventSchema,
  inboxDeliveredEventSchema,
  inboxCancelledEventSchema,
  inboxDeliveryChangedEventSchema,
])

export type KnownDurableEvent = z.infer<typeof knownDurableEventSchema>
export type ApprovalDecidedEvent = z.infer<typeof approvalDecidedEventSchema>
export type ApprovalExpiredEvent = z.infer<typeof approvalExpiredEventSchema>
export type SessionRenamedEvent = z.infer<typeof sessionRenamedEventSchema>
export type SessionDeletedEvent = z.infer<typeof sessionDeletedEventSchema>

export function parseKnownDurableEvent(value: unknown): KnownDurableEvent | null {
  const parsed = knownDurableEventSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function isDurableEventRecord(value: unknown): value is EventRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isInteger((value as { seq?: unknown }).seq) &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { createdAt?: unknown }).createdAt === "string"
  )
}
