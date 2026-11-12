import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid"
import {
  decodePasteBytes,
  defaultTextareaKeyBindings,
  type KeyBinding,
  type PasteEvent,
  type TextareaRenderable,
} from "@opentui/core"
import { AgentOneClient, ClientError } from "../client/client"
import { SseParser } from "../client/event-stream"
import { readState } from "../daemon/state"
import type {
  Approval,
  Checkpoint,
  CheckpointDiff,
  InboxDelivery,
  InboxUserItem,
  PermissionRule,
  PromptFileInput,
  Session,
  Turn,
} from "../shared/types"
import type { ActiveTurn } from "../shared/contracts"
import type { TuiBootstrap } from "./discovery"
import { ConnectionManager, type ConnectionState } from "./recovery"
import { APPROVAL_OPTIONS, APPROVAL_SCOPES, canInterrupt } from "./behavior"
import { attachmentLabel, resolvePastedAttachments } from "./attachments"

type Route = { type: "home" } | { type: "session"; id: string }
type Dialog =
  | null
  | "palette"
  | "sessions"
  | "checkpoints"
  | "diff"
  | "settings"
  | "rules"
  | "memory"
  | "status"
  | "help"
  | "models"
  | "queued"
  | "rename"

interface SessionInfo {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly providerId?: string | null
  readonly modelId?: string | null
}

interface MessageInfo {
  readonly id: string
  readonly sessionId: string
  readonly turnId: string | null
  readonly role: "user" | "assistant" | "tool" | "system"
  readonly text: string
  readonly files?: ReadonlyArray<{ name?: string; mime: string }>
  readonly createdAt: string
}

interface ModelInfo {
  readonly providerId: string
  readonly modelId: string
  readonly name: string
  readonly costInputPerMillion: number
}

interface ToastInfo {
  readonly message: string
  readonly kind: "info" | "success" | "warn" | "error"
}

interface CommandInfo {
  readonly id: string
  readonly title: string
  readonly group: string
  readonly run: () => void
}

const PROMPT_KEY_BINDINGS: KeyBinding[] = [
  ...defaultTextareaKeyBindings.filter(
    (binding) => binding.name !== "return" && binding.name !== "kpenter",
  ),
  { name: "return", action: "submit" },
  { name: "enter", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
]

const COLORS = {
  bg: "#0b0e14",
  panel: "#141924",
  raised: "#1b2230",
  border: "#2b3446",
  text: "#d8dee9",
  muted: "#7b879c",
  faint: "#566176",
  accent: "#7aa2f7",
  accentSoft: "#283457",
  warn: "#e0af68",
  error: "#f7768e",
  success: "#9ece6a",
} as const



function asSessions(value: Array<Record<string, unknown>>): SessionInfo[] {
  return value.map((entry) => ({
    id: String(entry.id),
    title: String(entry.title ?? "Untitled session"),
    createdAt: String(entry.createdAt ?? ""),
    updatedAt: String(entry.updatedAt ?? ""),
    providerId: typeof entry.providerId === "string" ? entry.providerId : null,
    modelId: typeof entry.modelId === "string" ? entry.modelId : null,
  }))
}

function asMessages(value: Array<Record<string, unknown>>): MessageInfo[] {
  return value.map((entry) => ({
    id: String(entry.id),
    sessionId: String(entry.sessionId),
    turnId: typeof entry.turnId === "string" ? entry.turnId : null,
    role: entry.role === "assistant" || entry.role === "tool" || entry.role === "system" ? entry.role : "user",
    text: String(entry.text ?? ""),
    ...(Array.isArray(entry.files)
      ? {
          files: (entry.files as Array<Record<string, unknown>>).flatMap((file) =>
            typeof file.mime === "string"
              ? [{ ...(typeof file.name === "string" ? { name: file.name } : {}), mime: file.mime }]
              : [],
          ),
        }
      : {}),
    createdAt: String(entry.createdAt ?? ""),
  }))
}

function isEnter(key: { name: string }): boolean {
  return key.name === "return" || key.name === "enter"
}

function isEscape(key: { name: string }): boolean {
  return key.name === "escape"
}

function trim(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
}

function lineCount(text: string): number {
  return text.split(/\r?\n/).length
}

function scopedApprovals(approvals: Approval[], sessionId: string | undefined): Approval[] {
  if (!sessionId) return []
  return approvals.filter((approval) => approval.sessionId === sessionId && approval.status === "pending")
}

function sessionStatus(active: Record<string, { status: string; turnId: string }>, id: string): string | undefined {
  return active[id]?.status
}

export function TuiApp(props: { bootstrap: TuiBootstrap }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  let runtimeClient = new AgentOneClient({
    baseUrl: props.bootstrap.endpoint,
    password: props.bootstrap.password,
    timeoutMs: 15_000,
  })
  const client = () => runtimeClient

  const [route, setRoute] = createSignal<Route>({ type: "home" })
  const [dialog, setDialog] = createSignal<Dialog>(null)
  const [dialogIndex, setDialogIndex] = createSignal(0)
  const [sessions, setSessions] = createSignal<SessionInfo[]>([])
  const [active, setActive] = createSignal<Record<string, { status: string; turnId: string }>>({})
  const [messages, setMessages] = createSignal<MessageInfo[]>([])
  const [inbox, setInbox] = createSignal<InboxUserItem[]>([])
  const [approvals, setApprovals] = createSignal<Approval[]>([])
  const [checkpoints, setCheckpoints] = createSignal<Checkpoint[]>([])
  const [rules, setRules] = createSignal<PermissionRule[]>([])
  const [memory, setMemory] = createSignal<{ user: string[]; notes: string[]; pending: number }>({
    user: [],
    notes: [],
    pending: 0,
  })
  const [settings, setSettings] = createSignal<Record<string, unknown> | null>(null)
  const [activeTurn, setActiveTurn] = createSignal<ActiveTurn | null>(null)
  const [liveText, setLiveText] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [draftFiles, setDraftFiles] = createSignal<PromptFileInput[]>([])
  const [homeDraft, setHomeDraft] = createSignal("")
  const [homeFiles, setHomeFiles] = createSignal<PromptFileInput[]>([])
  const [connection, setConnection] = createSignal<ConnectionState>("connecting")
  const [showReconnect, setShowReconnect] = createSignal(false)
  const [toast, setToast] = createSignal<ToastInfo | null>(null)
  const [tabs, setTabs] = createSignal<Array<{ id: string; title: string }>>([])
  const [closedTabs, setClosedTabs] = createSignal<Array<{ id: string; title: string }>>([])
  const [approvalChoice, setApprovalChoice] = createSignal(0)
  const [selectedCheckpoint, setSelectedCheckpoint] = createSignal<Checkpoint | null>(null)
  const [checkpointDiff, setCheckpointDiff] = createSignal<CheckpointDiff | null>(null)
  const [rejectReason, setRejectReason] = createSignal("")
  const [rejecting, setRejecting] = createSignal(false)
  const [leaderActive, setLeaderActive] = createSignal(false)
  let promptInput: TextareaRenderable | undefined
  let dialogInput: TextareaRenderable | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let interruptAt = 0
  let streamAbort: AbortController | undefined
  let streamToken = 0
  let deltaBuffer = ""
  let deltaTimer: ReturnType<typeof setTimeout> | undefined
  let leaderTimer: ReturnType<typeof setTimeout> | undefined
  let steerFirstPending = false
  let lastMessageCount = 0

  const session = createMemo(() => {
    const current = route()
    if (current.type !== "session") return undefined
    return sessions().find((entry) => entry.id === current.id)
  })
  const currentId = createMemo(() => {
    const current = route()
    return current.type === "session" ? current.id : undefined
  })
  const sessionApprovals = createMemo(() => scopedApprovals(approvals(), currentId()))
  const pendingApproval = createMemo(() => sessionApprovals()[0])
  const sessionInbox = createMemo(() =>
    currentId() ? inbox().filter((item) => item.sessionId === currentId()) : [],
  )
  const queuedPrompts = createMemo(() =>
    sessionInbox().filter((item) => item.delivery === "queue"),
  )
  const pendingSteers = createMemo(() =>
    sessionInbox().filter((item) => item.delivery === "steer"),
  )
  const visibleMessages = createMemo(() => {
    const pendingIds = new Set(sessionInbox().map((item) => item.id))
    return messages().filter((message) => !pendingIds.has(message.id))
  })
  const promptFocused = () => Boolean(promptInput?.focused)
  const compact = createMemo(() => dimensions().width < 72)
  const veryCompact = createMemo(() => dimensions().width < 50)

  function showToast(message: string, kind: ToastInfo["kind"] = "info"): void {
    if (toastTimer) clearTimeout(toastTimer)
    setToast({ message, kind })
    toastTimer = setTimeout(() => setToast(null), 3_500)
  }

  function replaceClient(endpoint: string): void {
    if (runtimeClient.baseUrl === endpoint.replace(/\/+$/, "")) return
    runtimeClient = new AgentOneClient({
      baseUrl: endpoint,
      password: props.bootstrap.password,
      timeoutMs: 15_000,
    })
  }

  async function refreshSessions(): Promise<void> {
    try {
      setSessions(asSessions((await client().listSessions()).sessions))
    } catch (error) {
      if (error instanceof ClientError) showToast(error.message, "error")
    }
  }

  async function refreshActive(): Promise<void> {
    try {
      setActive((await client().activeSessions()).active)
    } catch {
      // Connection status carries the actionable error.
    }
  }

  async function refreshApprovals(): Promise<void> {
    try {
      setApprovals((await client().listApprovals("pending")).approvals)
    } catch {
      // Keep the last known set; the reconnect overlay explains transport loss.
    }
  }

  async function refreshInbox(): Promise<void> {
    const id = currentId()
    if (!id) {
      setInbox([])
      return
    }
    try {
      setInbox((await client().listInbox(id)).inbox)
    } catch {
      // Keep the last known queue; the reconnect overlay explains transport loss.
    }
  }

  async function refreshCheckpoints(): Promise<void> {
    if (!currentId()) return
    try {
      setCheckpoints((await client().listCheckpoints(100, currentId())).checkpoints)
    } catch {
      // Keep the previous list.
    }
  }

  async function refreshRules(): Promise<void> {
    try {
      setRules((await client().listRules()).rules)
    } catch {
      // Keep previous.
    }
  }

  async function refreshMemory(): Promise<void> {
    try {
      const value = await client().getMemory()
      setMemory({
        user: [...value.user.entries],
        notes: [...value.memory.entries],
        pending: value.pending.length,
      })
    } catch {
      // Keep previous.
    }
  }

  async function refreshSettings(): Promise<void> {
    try {
      setSettings((await client().settings()).settings as unknown as Record<string, unknown>)
    } catch {
      // Keep previous.
    }
  }

  async function refreshMessages(): Promise<void> {
    const id = currentId()
    if (!id) return
    try {
      const value = await client().listMessages(id, 500)
      const next = asMessages(value.messages)
      lastMessageCount = next.length
      setMessages(next)
    } catch {
      // Keep previous.
    }
  }

  async function openSession(id: string): Promise<void> {
    streamAbort?.abort()
    setRoute({ type: "session", id })
    setDialog(null)
    setDraft("")
    setDraftFiles([])
    setLiveText("")
    setMessages([])
    setInbox([])
    setApprovals([])
    setActiveTurn(null)
    setBusy(true)
    const existing = sessions().find((entry) => entry.id === id)
    if (existing) {
      setTabs((current) =>
        current.some((tab) => tab.id === id)
          ? current
          : [...current, { id, title: existing.title }],
      )
    }
    try {
      const [messageResult, context, approvalResult, checkpointResult, inboxResult] = await Promise.all([
        client().listMessages(id, 500),
        client().sessionContext(id),
        client().listApprovals("pending"),
        client().listCheckpoints(100, id),
        client().listInbox(id),
      ])
      setMessages(asMessages(messageResult.messages))
      setInbox(inboxResult.inbox)
      setApprovals(approvalResult.approvals)
      setCheckpoints(checkpointResult.checkpoints)
      const turn = context.activeTurn
      setActiveTurn(turn)
      if (turn) {
        void attachTurn(turn.id)
      } else {
        setBusy(false)
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
      setBusy(false)
    }
  }

  async function newSession(): Promise<void> {
    streamAbort?.abort()
    setRoute({ type: "home" })
    setDialog(null)
    setDraft("")
    setDraftFiles([])
    setLiveText("")
    setMessages([])
    setInbox([])
    setApprovals([])
    setActiveTurn(null)
    setBusy(false)
    queueMicrotask(() => promptInput?.focus())
  }

  async function startSession(
    text: string,
    delivery: InboxDelivery = "steer",
    files: readonly PromptFileInput[] = homeFiles(),
  ): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed && files.length === 0) return
    setHomeDraft("")
    setHomeFiles([])
    promptInput?.setText("")
    try {
      const created = await client().createSession(trimmed.slice(0, 70) || "Attachment")
      const id = String(created.session.id)
      setTabs((current) => [...current, { id, title: String(created.session.title) }])
      setRoute({ type: "session", id })
      await refreshSessions()
      await sendPrompt(id, trimmed, delivery, files)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function sendPrompt(
    id: string,
    text: string,
    delivery: InboxDelivery = "steer",
    files: readonly PromptFileInput[] = draftFiles(),
  ): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed && files.length === 0) return
    const previousDraft = draft()
    const previousFiles = [...draftFiles()]
    setDraft("")
    setDraftFiles([])
    promptInput?.setText("")
    setLiveText("")
    try {
      const admitted = await client().admitMessage(id, trimmed, { delivery, files })
      if (currentId() === id) {
        setInbox((current) => {
          const next = current.filter((item) => item.id !== admitted.inbox.id)
          return [...next, admitted.inbox]
        })
      }
      if (admitted.turn) {
        const status =
          admitted.turn.status === "running" ||
          admitted.turn.status === "resuming" ||
          admitted.turn.status === "waiting_approval"
            ? admitted.turn.status
            : "queued"
        const previousTurnId = activeTurn()?.id
        setActiveTurn({
          id: admitted.turn.id,
          status,
          startedAt: admitted.turn.startedAt,
          updatedAt: admitted.turn.updatedAt,
        })
        setBusy(true)
        if (previousTurnId !== admitted.turn.id || !streamAbort) {
          void attachTurn(admitted.turn.id)
        }
      } else {
        setBusy(false)
      }
      await refreshMessages()
      await refreshInbox()
      await refreshActive()
      if (delivery === "queue") showToast("Prompt queued", "success")
    } catch (error) {
      setDraft(previousDraft)
      setDraftFiles(previousFiles)
      promptInput?.setText(previousDraft)
      if (!(error instanceof ClientError && error.code === "session_busy")) {
        showToast(error instanceof Error ? error.message : String(error), "error")
      }
    }
  }

  function flushDelta(): void {
    if (!deltaBuffer) return
    setLiveText((current) => current + deltaBuffer)
    deltaBuffer = ""
  }

  async function attachTurn(turnId: string): Promise<void> {
    streamAbort?.abort()
    const token = ++streamToken
    const controller = new AbortController()
    streamAbort = controller
    setBusy(true)
    try {
      const response = await client().turnStreamResponse(turnId, controller.signal)
      if (!response.ok || !response.body) throw new Error(`Turn stream failed (${response.status})`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseParser()
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
          if (!frame.data) continue
          let event: Record<string, unknown>
          try {
            event = JSON.parse(frame.data) as Record<string, unknown>
          } catch {
            continue
          }
          if (event.type === "delta" && typeof event.text === "string") {
            deltaBuffer += event.text
            if (!deltaTimer) {
              deltaTimer = setTimeout(() => {
                deltaTimer = undefined
                flushDelta()
              }, 16)
            }
          } else if (event.type === "status" && typeof event.status === "string") {
            setActiveTurn((current) =>
              current
                ? { ...current, status: event.status as ActiveTurn["status"] }
                : {
                    id: turnId,
                    status: event.status as ActiveTurn["status"],
                    startedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
            )
          } else if (event.type === "done") {
            flushDelta()
            setBusy(false)
            setLiveText("")
            setActiveTurn(null)
            void refreshMessages()
            void refreshActive()
            void refreshApprovals()
            void refreshCheckpoints()
          } else if (event.type === "error" && typeof event.message === "string") {
            showToast(event.message, "error")
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && token === streamToken) {
        showToast(error instanceof Error ? error.message : String(error), "error")
      }
    } finally {
      if (token === streamToken) {
        if (deltaTimer) {
          clearTimeout(deltaTimer)
          deltaTimer = undefined
        }
        flushDelta()
        setBusy(false)
      }
    }
  }

  async function cancelCurrentTurn(): Promise<void> {
    const turn = activeTurn()
    const id = currentId()
    if (!turn || !id) return
    try {
      const result = await client().interruptSession(id, { resume: true })
      streamAbort?.abort()
      setBusy(Boolean(result.turn))
      setActiveTurn(
        result.turn
          ? {
              id: result.turn.id,
              status:
                result.turn.status === "running" ||
                result.turn.status === "resuming" ||
                result.turn.status === "waiting_approval"
                  ? result.turn.status
                  : "queued",
              startedAt: result.turn.startedAt,
              updatedAt: result.turn.updatedAt,
            }
          : null,
      )
      if (result.turn) void attachTurn(result.turn.id)
      showToast("Turn interrupted", "info")
      await refreshMessages()
      await refreshInbox()
      await refreshActive()
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  function addTab(id: string, title: string): void {
    setTabs((current) =>
      current.some((tab) => tab.id === id) ? current : [...current, { id, title }],
    )
  }

  async function closeTab(id = currentId()): Promise<void> {
    if (!id) return
    const index = tabs().findIndex((tab) => tab.id === id)
    const tab = tabs()[index]
    if (tab) setClosedTabs((current) => [{ ...tab }, ...current].slice(0, 10))
    const next = tabs().filter((entry) => entry.id !== id)
    setTabs(next)
    if (currentId() === id) {
      const target = next[Math.max(0, index - 1)]
      if (target) await openSession(target.id)
      else await newSession()
    }
  }

  async function cycleTab(direction: 1 | -1): Promise<void> {
    const list = tabs()
    if (list.length < 2) return
    const index = Math.max(0, list.findIndex((tab) => tab.id === currentId()))
    const target = list[(index + direction + list.length) % list.length]
    if (target) await openSession(target.id)
  }

  async function decideApproval(decision: "approve" | "reject", scopeIndex: number): Promise<void> {
    const approval = pendingApproval()
    if (!approval) return
    try {
      const scope = APPROVAL_SCOPES[scopeIndex] ?? null
      await client().decideApproval(approval.id, decision, {
        ...(scope ? { scope } : {}),
        ...(rejecting() && rejectReason().trim() ? { reason: rejectReason().trim() } : {}),
      })
      setRejecting(false)
      setRejectReason("")
      setApprovalChoice(0)
      await refreshApprovals()
      showToast(decision === "approve" ? "Approved" : "Rejected", decision === "approve" ? "success" : "info")
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function steerQueued(inboxId: string): Promise<boolean> {
    const id = currentId()
    if (!id) return false
    try {
      const result = await client().setInboxDelivery(id, inboxId, "steer")
      await refreshInbox()
      await refreshActive()
      if (result.turn) {
        setBusy(true)
        setActiveTurn({
          id: result.turn.id,
          status:
            result.turn.status === "running" ||
            result.turn.status === "resuming" ||
            result.turn.status === "waiting_approval"
              ? result.turn.status
              : "queued",
          startedAt: result.turn.startedAt,
          updatedAt: result.turn.updatedAt,
        })
        void attachTurn(result.turn.id)
      }
      showToast("Prompt steered", "success")
      return true
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
      return false
    }
  }

  async function steerFirstQueued(): Promise<boolean> {
    if (steerFirstPending) return false
    const first = queuedPrompts()[0]
    if (!first) return false
    steerFirstPending = true
    try {
      return await steerQueued(first.id)
    } finally {
      steerFirstPending = false
    }
  }

  async function cancelQueued(inboxId: string, restore: boolean): Promise<boolean> {
    const id = currentId()
    if (!id) return false
    const target = sessionInbox().find((item) => item.id === inboxId)
    try {
      await client().cancelInbox(id, inboxId)
      if (target) setInbox((current) => current.filter((item) => item.id !== target.id))
      if (restore && target) {
        setDraftFiles([...(target.payload.files ?? [])])
        setDraft((current) => {
          const next = current.trim().length > 0 ? `${current}\n\n${target.payload.text}` : target.payload.text
          queueMicrotask(() => promptInput?.setText(next))
          return next
        })
      }
      await refreshInbox()
      if (queuedPrompts().length === 0) setDialog(null)
      showToast(restore ? "Queued prompt restored" : "Queued prompt deleted", "info")
      return true
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
      return false
    }
  }

  async function renameCurrent(): Promise<void> {
    const value = session()
    if (!value) return
    setDialog("rename")
    queueMicrotask(() => {
      dialogInput?.setText(value.title)
      dialogInput?.focus()
    })
  }

  async function applyRename(title: string): Promise<void> {
    const id = currentId()
    if (!id || !title.trim()) {
      setDialog(null)
      return
    }
    try {
      await client().renameSession(id, title.trim())
      setTabs((current) =>
        current.map((tab) => (tab.id === id ? { ...tab, title: title.trim() } : tab)),
      )
      await refreshSessions()
      setDialog(null)
      showToast("Session renamed", "success")
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function deleteCurrent(): Promise<void> {
    const id = currentId()
    if (!id) return
    try {
      await client().deleteSession(id)
      setTabs((current) => current.filter((tab) => tab.id !== id))
      showToast("Session deleted", "info")
      await refreshSessions()
      await newSession()
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function openDialog(name: Exclude<Dialog, null>): Promise<void> {
    setDialog(name)
    setDialogIndex(0)
    if (name === "sessions") await refreshSessions()
    if (name === "queued") await refreshInbox()
    if (name === "checkpoints") await refreshCheckpoints()
    if (name === "rules") await refreshRules()
    if (name === "memory") await refreshMemory()
    if (name === "settings") await refreshSettings()
    if (name === "models") await refreshModels()
    if (name === "rename") await renameCurrent()
  }

  async function refreshModels(): Promise<void> {
    try {
      setModels((await client().listModels()).models as unknown as ModelInfo[])
    } catch {
      // Keep previous.
    }
  }
  const [models, setModels] = createSignal<ModelInfo[]>([])

  async function selectModel(model: ModelInfo): Promise<void> {
    const id = currentId()
    if (!id) return
    try {
      await client().setSessionModel(id, { providerId: model.providerId, modelId: model.modelId })
      await refreshSessions()
      setDialog(null)
      showToast(`${model.name} selected`, "success")
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function cycleApprovalMode(): Promise<void> {
    const current = settings()?.approval as { mode?: string } | undefined
    const mode = current?.mode === "smart" ? "manual" : current?.mode === "manual" ? "off" : "smart"
    try {
      await client().updateSettings({ approval: { mode: mode as "smart" | "manual" | "off" } })
      await refreshSettings()
      showToast(`Approval mode: ${mode}`, "success")
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  async function restoreSelectedCheckpoint(filePath?: string): Promise<void> {
    const checkpoint = selectedCheckpoint() ?? checkpoints()[dialogIndex()]
    if (!checkpoint) return
    try {
      const result = await client().restoreCheckpoint(checkpoint.id, { safe: true, ...(filePath ? { filePath } : {}) })
      showToast(
        `Restored ${result.result.restoredTo}: ${result.result.restoredFiles.length} files`,
        "success",
      )
      await refreshMessages()
      await refreshCheckpoints()
      setDialog("checkpoints")
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  const commands = createMemo<CommandInfo[]>(() => [
    { id: "session.new", title: "New session", group: "Session", run: () => void newSession() },
    { id: "session.list", title: "Switch session", group: "Session", run: () => void openDialog("sessions") },
    { id: "session.rename", title: "Rename session", group: "Session", run: () => void openDialog("rename") },
    { id: "session.delete", title: "Delete session", group: "Session", run: () => void deleteCurrent() },
    { id: "session.queued_prompts", title: "View queued prompts", group: "Prompt", run: () => void openDialog("queued") },
    {
      id: "prompt.clear_attachments",
      title: "Clear attachments",
      group: "Prompt",
      run: () => {
        if (home()) setHomeFiles([])
        else setDraftFiles([])
      },
    },
    { id: "model.list", title: "Switch model", group: "Agent", run: () => void openDialog("models") },
    { id: "checkpoint.list", title: "Checkpoints", group: "Review", run: () => void openDialog("checkpoints") },
    { id: "rules.list", title: "Rules", group: "Settings", run: () => void openDialog("rules") },
    { id: "memory.list", title: "Memory", group: "Settings", run: () => void openDialog("memory") },
    { id: "settings.open", title: "Settings", group: "System", run: () => void openDialog("settings") },
    { id: "status.open", title: "Status", group: "System", run: () => void openDialog("status") },
    { id: "help.open", title: "Help", group: "System", run: () => void openDialog("help") },
    { id: "app.quit", title: "Quit", group: "System", run: () => renderer.destroy() },
  ])

  function dialogCommands(): CommandInfo[] {
    return commands().filter((command) => command.id !== "app.quit")
  }

  async function runCommand(id: string): Promise<void> {
    const command = commands().find((entry) => entry.id === id)
    setDialog(null)
    command?.run()
  }

  function moveDialog(delta: number): void {
    const current = dialog()
    if (current === "palette") setDialogIndex((index) => Math.max(0, Math.min(dialogCommands().length - 1, index + delta)))
    else if (current === "sessions") setDialogIndex((index) => Math.max(0, Math.min(sessions().length - 1, index + delta)))
    else if (current === "models") setDialogIndex((index) => Math.max(0, Math.min(models().length - 1, index + delta)))
    else if (current === "queued") setDialogIndex((index) => Math.max(0, Math.min(queuedPrompts().length - 1, index + delta)))
    else if (current === "checkpoints") {
      setDialogIndex((index) => Math.max(0, Math.min(checkpoints().length - 1, index + delta)))
      setSelectedCheckpoint(checkpoints()[dialogIndex()] ?? null)
    }
  }

  function handleDialog(key: Parameters<Parameters<typeof useKeyboard>[0]>[0]): boolean {
    const current = dialog()
    if (!current) return false
    if (isEscape(key)) {
      key.preventDefault()
      if (current === "diff") setDialog("checkpoints")
      else if (current === "rename") {
        setDialog(null)
        promptInput?.focus()
      } else setDialog(null)
      return true
    }
    if (current === "rename") return false
    if (current === "queued") {
      const selected = queuedPrompts()[dialogIndex()]
      if (key.ctrl && key.name === "d") {
        key.preventDefault()
        if (selected) void cancelQueued(selected.id, false)
        return true
      }
      if (key.ctrl && key.name === "u") {
        key.preventDefault()
        if (selected) {
          void cancelQueued(selected.id, true).then((cancelled) => {
            if (!cancelled) return
            setDialog(null)
            queueMicrotask(() => {
              promptInput?.setText(draft())
              promptInput?.focus()
            })
          })
        }
        return true
      }
      if (isEnter(key)) {
        key.preventDefault()
        if (selected) {
          void steerQueued(selected.id).then((steered) => {
            if (steered) setDialog(null)
          })
        }
        return true
      }
    }
    if (key.name === "up" || key.name === "k") {
      key.preventDefault()
      moveDialog(-1)
      return true
    }
    if (key.name === "down" || key.name === "j") {
      key.preventDefault()
      moveDialog(1)
      return true
    }
    if (isEnter(key)) {
      key.preventDefault()
      if (current === "palette") {
        const command = dialogCommands()[dialogIndex()]
        if (command) void runCommand(command.id)
      } else if (current === "sessions") {
        const target = sessions()[dialogIndex()]
        if (target) void openSession(target.id)
      } else if (current === "models") {
        const target = models()[dialogIndex()]
        if (target) void selectModel(target)
      } else if (current === "checkpoints") {
        const target = checkpoints()[dialogIndex()]
        if (target) {
          setSelectedCheckpoint(target)
          setCheckpointDiff(null)
          setDialog("diff")
          void client()
            .diffCheckpoint(target.id)
            .then((value) => setCheckpointDiff(value.diff))
            .catch((error: unknown) =>
              showToast(error instanceof Error ? error.message : String(error), "error"),
            )
        }
      } else if (current === "diff") {
        void restoreSelectedCheckpoint()
      } else if (current === "settings") {
        void cycleApprovalMode()
      }
      return true
    }
    if (current === "diff" && key.name === "r") {
      key.preventDefault()
      void restoreSelectedCheckpoint()
      return true
    }
    if (current === "diff" && key.name === "f") {
      key.preventDefault()
      const first = checkpointDiff()?.files[0]?.path
      if (first) void restoreSelectedCheckpoint(first)
      else showToast("No changed file available", "warn")
      return true
    }
    if (current === "settings" && key.name === "m") {
      key.preventDefault()
      void cycleApprovalMode()
      return true
    }
    return false
  }

  function handleApproval(key: Parameters<Parameters<typeof useKeyboard>[0]>[0]): boolean {
    if (!pendingApproval()) return false
    if (rejecting()) {
      if (isEscape(key)) {
        key.preventDefault()
        setRejecting(false)
        setRejectReason("")
        return true
      }
      return false
    }
    if (key.name === "left" || key.name === "h") {
      key.preventDefault()
      setApprovalChoice((value) => (value + APPROVAL_OPTIONS.length - 1) % APPROVAL_OPTIONS.length)
      return true
    }
    if (key.name === "right" || key.name === "l") {
      key.preventDefault()
      setApprovalChoice((value) => (value + 1) % APPROVAL_OPTIONS.length)
      return true
    }
    if (isEnter(key)) {
      key.preventDefault()
      if (approvalChoice() === APPROVAL_OPTIONS.length - 1) {
        setRejecting(true)
        queueMicrotask(() => dialogInput?.focus())
      } else {
        void decideApproval("approve", approvalChoice())
      }
      return true
    }
    if (isEscape(key)) {
      key.preventDefault()
      void decideApproval("reject", APPROVAL_OPTIONS.length - 1)
      return true
    }
    return false
  }

  function armLeader(): void {
    setLeaderActive(true)
    if (leaderTimer) clearTimeout(leaderTimer)
    leaderTimer = setTimeout(() => {
      setLeaderActive(false)
      leaderTimer = undefined
    }, 2_000)
  }

  function leaderMatch(name: string): string | null {
    if (!leaderActive()) return null
    setLeaderActive(false)
    if (leaderTimer) clearTimeout(leaderTimer)
    leaderTimer = undefined
    if (name === "n") return "session.new"
    if (name === "l") return "session.list"
    if (name === "s") return "status.open"
    if (name === "r") return "rules.list"
    if (name === "c") return "checkpoint.list"
    if (name === "m") return "model.list"
    if (name === "q") return "session.queued_prompts"
    if (name === "d") return "prompt.clear_attachments"
    if (name === "return" || name === "enter" || name === "linefeed") return "prompt.queue"
    return null
  }

  function submitCurrent(delivery: InboxDelivery): void {
    if (home()) {
      void startSession(homeDraft(), delivery, homeFiles())
      return
    }
    const id = currentId()
    if (id) void sendPrompt(id, draft(), delivery, draftFiles())
  }

  function handleGlobal(key: Parameters<Parameters<typeof useKeyboard>[0]>[0]): boolean {
    if (isEnter(key) && promptFocused() && !key.ctrl && !key.meta && !key.shift) {
      key.preventDefault()
      if (leaderActive()) {
        setLeaderActive(false)
        submitCurrent("queue")
      } else if (home() && !homeDraft().trim()) {
        return true
      } else if (!home() && !draft().trim()) {
        void steerFirstQueued()
      } else {
        submitCurrent("steer")
      }
      return true
    }
    if (key.ctrl && key.name === "q") {
      key.preventDefault()
      renderer.destroy()
      return true
    }
    if (key.ctrl && key.name === "p") {
      key.preventDefault()
      void openDialog("palette")
      return true
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault()
      void openDialog("sessions")
      return true
    }
    if (key.ctrl && key.name === "x") {
      key.preventDefault()
      armLeader()
      return true
    }
    const leaderCommand = leaderMatch(key.name)
    if (leaderCommand) {
      key.preventDefault()
      if (leaderCommand === "prompt.queue") submitCurrent("queue")
      else void runCommand(leaderCommand)
      return true
    }
    if (key.ctrl && key.name === "g") {
      key.preventDefault()
      void openDialog("checkpoints")
      return true
    }
    if (key.ctrl && key.name === "r" && session()) {
      key.preventDefault()
      void openDialog("rename")
      return true
    }
    if (key.ctrl && key.name === "tab") {
      key.preventDefault()
      void cycleTab(key.shift ? -1 : 1)
      return true
    }
    if (key.ctrl && key.name === "w" && currentId()) {
      key.preventDefault()
      void closeTab()
      return true
    }
    if (key.ctrl && key.shift && key.name === "t" && closedTabs().length > 0) {
      key.preventDefault()
      const [tab, ...rest] = closedTabs()
      setClosedTabs(rest)
      if (tab) {
        addTab(tab.id, tab.title)
        void openSession(tab.id)
      }
      return true
    }
    if (key.name === "f2") {
      key.preventDefault()
      void openDialog("models")
      return true
    }
    if (key.name === "escape" && currentId() && busy()) {
      if (isEscape(key) && promptFocused()) {
        const now = Date.now()
        if (canInterrupt(interruptAt, now)) {
          key.preventDefault()
          interruptAt = 0
          void cancelCurrentTurn()
          return true
        }
        interruptAt = now
        key.preventDefault()
        showToast("Press Escape again to interrupt", "warn")
        return true
      }
    }
    return false
  }

  const onKey = (key: Parameters<Parameters<typeof useKeyboard>[0]>[0]) => {
    if (dialog()) {
      if (handleDialog(key)) return
    }
    if (pendingApproval()) {
      if (handleApproval(key)) return
    }
    handleGlobal(key)
  }

  usePaste((event: PasteEvent) => {
    if (dialog() || pendingApproval() || !promptFocused()) return
    const text = decodePasteBytes(event.bytes)
    const files = resolvePastedAttachments(text)
    if (!files || files.length === 0) return
    event.preventDefault()
    if (home()) setHomeFiles((current) => [...current, ...files].slice(0, 32))
    else setDraftFiles((current) => [...current, ...files].slice(0, 32))
    showToast(`${files.length} attachment${files.length === 1 ? "" : "s"} added`, "success")
  })

  onMount(() => {
    renderer.keyInput.on("keypress", onKey)
    onCleanup(() => renderer.keyInput.off("keypress", onKey))
    const manager = new ConnectionManager({
      endpoint: () => client().baseUrl,
      refreshEndpoint: async () => {
        const state = readState(props.bootstrap.config.statePath)
        if (!state) return undefined
        replaceClient(state.url)
        return state.url
      },
      open: (_url, after, signal) => client().eventsResponse(after, signal),
      onEvent: (event) => {
        if (event.type.startsWith("approval.")) void refreshApprovals()
        if (event.type.startsWith("turn.")) {
          if (currentId()) {
            void refreshMessages()
            void refreshActive()
          }
        }
        if (event.type.startsWith("session.")) {
          void refreshSessions()
          if (event.type === "session.deleted" && event.sessionId === currentId()) void newSession()
        }
        if (event.type.startsWith("session.inbox.")) {
          void refreshInbox()
          if (event.type === "session.inbox.delivered") void refreshMessages()
        }
        if (event.type.startsWith("checkpoint.")) void refreshCheckpoints()
      },
      onState: (state) => setConnection(state),
      onSyntheticConnected: () => {
        setConnection("connected")
        void refreshSessions()
        void refreshActive()
        if (currentId()) {
          const id = currentId()
          if (id) void openSession(id)
        }
      },
    })
    manager.start()
    void refreshSessions()
    void refreshActive()
    void refreshApprovals()
    onCleanup(() => manager.stop())
  })

  createEffect(() => {
    const state = connection()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    if (state === "connected") {
      setShowReconnect(false)
      return
    }
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = undefined
        setShowReconnect(true)
      },
      state === "reconnecting" ? 1_000 : 5_000,
    )
  })
  onCleanup(() => {
    streamAbort?.abort()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (toastTimer) clearTimeout(toastTimer)
    if (deltaTimer) clearTimeout(deltaTimer)
    if (leaderTimer) clearTimeout(leaderTimer)
  })

  const width = () => dimensions().width
  const home = () => route().type === "home"

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg} onKeyDown={onKey}>
      <box height={1} flexDirection="row" backgroundColor={COLORS.panel} paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.accent}>Agent-1</text>
        <text fg={COLORS.muted}> · terminal</text>
        <box flexGrow={1} />
        <text fg={connection() === "connected" ? COLORS.success : COLORS.warn}>{connection()}</text>
      </box>

      <Show when={!home()}>
        <box height={1} flexDirection="row" backgroundColor={COLORS.raised} paddingLeft={1} paddingRight={1}>
          <For each={tabs()}>
            {(tab) => (
              <box paddingLeft={1} paddingRight={1} backgroundColor={tab.id === currentId() ? COLORS.accentSoft : undefined}>
                <text fg={tab.id === currentId() ? COLORS.text : COLORS.muted}>{trim(tab.title, compact() ? 12 : 24)}</text>
              </box>
            )}
          </For>
          <box flexGrow={1} />
          <Show when={activeTurn()}>
            <text fg={COLORS.warn}>{activeTurn()?.status}</text>
          </Show>
        </box>
      </Show>

      <Show when={home()}>
        <HomeView
          draft={homeDraft()}
          files={homeFiles()}
          onDraft={setHomeDraft}
          onRemoveFile={(index) => setHomeFiles((current) => current.filter((_, i) => i !== index))}
          onSubmit={(text, files) => void startSession(text, "steer", files)}
          onQueue={(text, files) => void startSession(text, "queue", files)}
          leaderActive={leaderActive}
          onSessions={() => void openDialog("sessions")}
          onPalette={() => void openDialog("palette")}
          width={width()}
          inputRef={(value) => (promptInput = value)}
        />
      </Show>

      <Show when={!home()}>
        <SessionView
          title={session()?.title ?? "Session"}
          messages={visibleMessages()}
          pending={sessionInbox()}
          queued={queuedPrompts()}
          files={draftFiles()}
          onRemoveFile={(index) => setDraftFiles((current) => current.filter((_, i) => i !== index))}
          leaderActive={leaderActive}
          liveText={liveText()}
          activeTurn={activeTurn()}
          approval={pendingApproval()}
          approvalChoice={approvalChoice()}
          rejecting={rejecting()}
          rejectReason={rejectReason()}
          onRejectReason={setRejectReason}
          onApprovalChoice={setApprovalChoice}
          onDecide={(decision, choice) => void decideApproval(decision, choice)}
          onCancelReject={() => {
            setRejecting(false)
            setRejectReason("")
          }}
          draft={draft()}
          onDraft={setDraft}
          onSubmit={(text, files) => {
            const id = currentId()
            if (id) void sendPrompt(id, text, "steer", files)
          }}
          onQueue={(text, files) => {
            const id = currentId()
            if (id) void sendPrompt(id, text, "queue", files)
          }}
          onSteerFirst={() => void steerFirstQueued()}
          onOpenQueue={() => void openDialog("queued")}
          onOpenCheckpoints={() => void openDialog("checkpoints")}
          onOpenStatus={() => void openDialog("status")}
          onPalette={() => void openDialog("palette")}
          width={width()}
          compact={compact()}
          veryCompact={veryCompact()}
          inputRef={(value) => (promptInput = value)}
          dialogInputRef={(value) => (dialogInput = value)}
          rejectInputRef={(value) => (dialogInput = value)}
        />
      </Show>

      <box height={1} flexDirection="row" backgroundColor={COLORS.panel} paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.muted}>
          {home()
            ? "enter send · ctrl+o sessions · ctrl+p commands"
            : compact()
              ? "enter steer · leader+enter queue"
              : "enter steer · leader+enter queue · esc esc interrupt · ctrl+p commands"}
        </text>
        <box flexGrow={1} />
        <text fg={COLORS.faint}>{width()}×{dimensions().height}</text>
      </box>

      <Show when={toast()}>
        {(value) => (
          <box position="absolute" bottom={2} left={1} right={1} zIndex={50} alignItems="center">
            <box backgroundColor={COLORS.raised} border borderColor={value().kind === "error" ? COLORS.error : COLORS.border} paddingLeft={2} paddingRight={2}>
              <text fg={value().kind === "error" ? COLORS.error : value().kind === "warn" ? COLORS.warn : COLORS.text}>
                {value().message}
              </text>
            </box>
          </box>
        )}
      </Show>

      <Show when={showReconnect()}>
        <ReconnectOverlay managed={false} />
      </Show>

      <Show when={dialog()}>
        <DialogView
          dialog={dialog()}
          index={dialogIndex()}
          sessions={sessions()}
          commands={dialogCommands()}
          models={models()}
          checkpoints={checkpoints()}
          checkpointDiff={checkpointDiff()}
          queued={queuedPrompts()}
          rules={rules()}
          memory={memory()}
          settings={settings()}
          title={session()?.title}
          width={width()}
          onRename={(title) => void applyRename(title)}
          onSelectModel={(model) => void selectModel(model)}
          onRestore={() => void restoreSelectedCheckpoint()}
          onCycleApproval={() => void cycleApprovalMode()}
          inputRef={(value) => (dialogInput = value)}
        />
      </Show>
    </box>
  )
}

export function HomeView(props: {
  draft: string
  files: PromptFileInput[]
  onDraft: (value: string) => void
  onRemoveFile: (index: number) => void
  onSubmit: (text: string, files: PromptFileInput[]) => void
  onQueue: (text: string, files: PromptFileInput[]) => void
  leaderActive: () => boolean
  onSessions: () => void
  onPalette: () => void
  width: number
  inputRef: (value: TextareaRenderable | undefined) => void
}) {
  let input: TextareaRenderable | undefined
  onMount(() => {
    queueMicrotask(() => input?.focus())
  })
  const panelWidth = () => Math.min(76, Math.max(30, props.width - 8))
  return (
    <box flexGrow={1} alignItems="center" justifyContent="center" paddingLeft={1} paddingRight={1}>
      <box width="100%" alignItems="center" gap={1}>
        <text fg={COLORS.accent}>AGENT-1</text>
        <text fg={COLORS.muted}>local personal assistant</text>
        <box width={panelWidth()} height={5} border borderColor={COLORS.border} backgroundColor={COLORS.panel} paddingLeft={1} paddingRight={1}>
          <textarea
            ref={(value) => {
              input = value
              if (value) {
                value.keyBindings = PROMPT_KEY_BINDINGS
                value.onKeyDown = (key) => {
                  if (isEnter(key) && !key.ctrl && !key.meta && !key.shift) {
                    key.preventDefault()
                    const text = value.plainText
                    if (!text.trim() && props.files.length === 0) return
                    value.setText("")
                    if (props.leaderActive()) props.onQueue(text, [...props.files])
                    else props.onSubmit(text, [...props.files])
                  }
                }
              }
              props.inputRef(value)
            }}
            focused={true}
            keyBindings={PROMPT_KEY_BINDINGS}
            height={3}
            placeholder="Ask Agent-1..."
            initialValue={props.draft}
            textColor={COLORS.text}
            focusedTextColor={COLORS.text}
            backgroundColor={COLORS.panel}
            onContentChange={() => props.onDraft(input?.plainText ?? "")}
            onKeyDown={(key) => {
              if (isEnter(key) && !key.ctrl && !key.meta && !key.shift) {
                key.preventDefault()
                const text = input?.plainText ?? ""
                if (!text.trim() && props.files.length === 0) return
                input?.setText("")
                if (props.leaderActive()) props.onQueue(text, [...props.files])
                else props.onSubmit(text, [...props.files])
              }
            }}
            onSubmit={() => {
              const text = input?.plainText ?? ""
              if (!text.trim() && props.files.length === 0) return
              input?.setText("")
              if (props.leaderActive()) props.onQueue(text, [...props.files])
              else props.onSubmit(text, [...props.files])
            }}
          />
        </box>
        <Show when={props.files.length > 0}>
          <box width={panelWidth()} border borderColor={COLORS.border} paddingLeft={1} paddingRight={1}>
            <For each={props.files}>
              {(file, index) => (
                <box flexDirection="row">
                  <text fg={COLORS.accent}>{attachmentLabel(file)}</text>
                  <box flexGrow={1} />
                  <text fg={COLORS.muted} onMouseUp={() => props.onRemoveFile(index())}>remove</text>
                </box>
              )}
            </For>
          </box>
        </Show>
        <box flexDirection="row" gap={2} marginTop={1}>
          <text fg={COLORS.muted}>ctrl+o sessions</text>
          <text fg={COLORS.muted}>ctrl+p commands</text>
          <text fg={COLORS.muted}>enter send</text>
        </box>
      </box>
    </box>
  )
}

export function SessionView(props: {
  title: string
  messages: MessageInfo[]
  pending: InboxUserItem[]
  queued: InboxUserItem[]
  files: PromptFileInput[]
  onRemoveFile: (index: number) => void
  leaderActive: () => boolean
  liveText: string
  activeTurn: ActiveTurn | null
  approval: Approval | undefined
  approvalChoice: number
  rejecting: boolean
  rejectReason: string
  onRejectReason: (value: string) => void
  onApprovalChoice: (value: number) => void
  onDecide: (decision: "approve" | "reject", choice: number) => void
  onCancelReject: () => void
  draft: string
  onDraft: (value: string) => void
  onSubmit: (text: string, files: PromptFileInput[]) => void
  onQueue: (text: string, files: PromptFileInput[]) => void
  onSteerFirst: () => void
  onOpenQueue: () => void
  onOpenCheckpoints: () => void
  onOpenStatus: () => void
  onPalette: () => void
  width: number
  compact: boolean
  veryCompact: boolean
  inputRef: (value: TextareaRenderable | undefined) => void
  dialogInputRef: (value: TextareaRenderable | undefined) => void
  rejectInputRef: (value: TextareaRenderable | undefined) => void
}) {
  let input: TextareaRenderable | undefined
  let rejectInput: TextareaRenderable | undefined
  createEffect(() => {
    if (!props.approval) queueMicrotask(() => input?.focus())
  })
  const permissions = () => props.approval
  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={props.veryCompact ? 0 : 1} paddingRight={props.veryCompact ? 0 : 1}>
      <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.text}>{trim(props.title, props.compact ? 32 : 70)}</text>
        <box flexGrow={1} />
        <text fg={COLORS.muted}>{props.activeTurn ? props.activeTurn.status : "idle"}</text>
      </box>
      <scrollbox height="100%" flexGrow={1} paddingLeft={1} paddingRight={1} stickyScroll={true} stickyStart="bottom" scrollY={!props.veryCompact}>
        <For each={props.messages}>
          {(message) => (
            <box marginTop={message.role === "user" ? 1 : 0} marginBottom={1}>
              <text fg={message.role === "user" ? COLORS.accent : message.role === "tool" ? COLORS.warn : COLORS.text}>
                {message.role === "user" ? "you" : message.role === "tool" ? "tool" : "agent"}
              </text>
              <text fg={COLORS.text} wrapMode="word">
                {message.text}
              </text>
              <For each={message.files ?? []}>
                {(file) => <text fg={COLORS.faint}>{attachmentLabel(file)}</text>}
              </For>
            </box>
          )}
        </For>
        <Show when={props.liveText}>
          <box marginBottom={1}>
            <text fg={COLORS.muted}>agent</text>
            <text fg={COLORS.text} wrapMode="word">{props.liveText}</text>
          </box>
        </Show>
        <For each={props.pending}>
          {(item) => (
            <box marginTop={1} marginBottom={1}>
              <text fg={COLORS.accent}>
                you · {item.delivery === "queue" ? "queued" : "steering"}
              </text>
              <text fg={COLORS.muted} wrapMode="word">{item.payload.text}</text>
              <For each={item.payload.files ?? []}>
                {(file) => <text fg={COLORS.faint}>{attachmentLabel(file)}</text>}
              </For>
            </box>
          )}
        </For>
        <Show when={props.messages.length === 0 && props.pending.length === 0 && !props.liveText}>
          <text fg={COLORS.muted}>Start a conversation with Agent-1.</text>
        </Show>
      </scrollbox>

      <Show when={props.queued.length > 0}>
        <QueueDock prompts={props.queued} onOpen={props.onOpenQueue} />
      </Show>

      <Show
        when={permissions()}
        fallback={
          <box height={5 + Math.min(props.files.length, 3)} border borderColor={COLORS.border} backgroundColor={COLORS.panel} paddingLeft={1} paddingRight={1}>
            <For each={props.files.slice(0, 3)}>
              {(file, index) => (
                <box flexDirection="row">
                  <text fg={COLORS.accent}>{attachmentLabel(file)}</text>
                  <box flexGrow={1} />
                  <text fg={COLORS.muted} onMouseUp={() => props.onRemoveFile(index())}>remove</text>
                </box>
              )}
            </For>
            <textarea
              ref={(value) => {
                input = value
                if (value) {
                  value.keyBindings = PROMPT_KEY_BINDINGS
                  value.onKeyDown = (key) => {
                    if (isEnter(key) && !key.ctrl && !key.meta && !key.shift) {
                      key.preventDefault()
                      const text = value.plainText
                      value.setText("")
                      if (props.leaderActive()) props.onQueue(text, [...props.files])
                      else if (!text.trim() && props.files.length === 0 && props.queued.length > 0) props.onSteerFirst()
                      else props.onSubmit(text, [...props.files])
                    }
                  }
                }
                props.inputRef(value)
              }}
              focused={!props.approval}
              keyBindings={PROMPT_KEY_BINDINGS}
              height={3}
              placeholder="Ask Agent-1..."
              initialValue={props.draft}
              textColor={COLORS.text}
              focusedTextColor={COLORS.text}
              backgroundColor={COLORS.panel}
              onContentChange={() => props.onDraft(input?.plainText ?? "")}
              onKeyDown={(key) => {
                if (isEnter(key) && !key.ctrl && !key.meta && !key.shift) {
                  key.preventDefault()
                  const text = input?.plainText ?? ""
                  input?.setText("")
                  if (props.leaderActive()) props.onQueue(text, [...props.files])
                  else if (!text.trim() && props.files.length === 0 && props.queued.length > 0) props.onSteerFirst()
                  else props.onSubmit(text, [...props.files])
                }
              }}
              onSubmit={() => {
                const text = input?.plainText ?? ""
                input?.setText("")
                if (props.leaderActive()) props.onQueue(text, [...props.files])
                else if (!text.trim() && props.files.length === 0 && props.queued.length > 0) props.onSteerFirst()
                else props.onSubmit(text, [...props.files])
              }}
            />
          </box>
        }
      >
        {(approval) => (
          <PermissionPanel
            approval={approval()}
            choice={props.approvalChoice}
            rejecting={props.rejecting}
            rejectReason={props.rejectReason}
            onRejectReason={props.onRejectReason}
            onChoice={props.onApprovalChoice}
            onDecide={props.onDecide}
            onCancelReject={props.onCancelReject}
            onSubmitReject={() => props.onDecide("reject", APPROVAL_OPTIONS.length - 1)}
            rejectInputRef={(value) => {
              rejectInput = value
              props.rejectInputRef(value)
            }}
            compact={props.compact}
          />
        )}
      </Show>
    </box>
  )
}

function QueueDock(props: {
  prompts: InboxUserItem[]
  onOpen: () => void
}) {
  return (
    <box
      height={4}
      border
      borderColor={COLORS.border}
      backgroundColor={COLORS.raised}
      paddingLeft={1}
      paddingRight={1}
      onMouseUp={props.onOpen}
    >
      <box flexDirection="row">
        <text fg={COLORS.warn}>queued </text>
        <text fg={COLORS.text}>{props.prompts.length}</text>
        <box flexGrow={1} />
        <text fg={COLORS.muted}>leader q</text>
      </box>
      <text fg={COLORS.muted} wrapMode="none" truncate>
        {props.prompts
          .slice(0, 3)
          .map((prompt) => prompt.payload.text.replace(/\s+/g, " "))
          .join("  ·  ")}
        {props.prompts.length > 3 ? `  +${props.prompts.length - 3}` : ""}
      </text>
    </box>
  )
}

export function PermissionPanel(props: {
  approval: Approval
  choice: number
  rejecting: boolean
  rejectReason: string
  onRejectReason: (value: string) => void
  onChoice: (value: number) => void
  onDecide: (decision: "approve" | "reject", choice: number) => void
  onCancelReject: () => void
  onSubmitReject: () => void
  rejectInputRef: (value: TextareaRenderable | undefined) => void
  compact: boolean
}) {
  let reasonInput: TextareaRenderable | undefined
  createEffect(() => {
    if (props.rejecting) queueMicrotask(() => reasonInput?.focus())
  })
  return (
    <box height={props.rejecting ? 10 : 9} border borderColor={COLORS.warn} backgroundColor={COLORS.raised} paddingLeft={1} paddingRight={1}>
      <text fg={COLORS.warn}>△ Permission required</text>
      <text fg={COLORS.text}>{trim(props.approval.displayCommand ?? props.approval.toolName, props.compact ? 46 : 90)}</text>
      <text fg={COLORS.muted}>{trim(props.approval.resource, props.compact ? 46 : 90)}</text>
      <Show
        when={props.rejecting}
        fallback={
          <box flexDirection="row" gap={1} marginTop={1}>
            <For each={APPROVAL_OPTIONS}>
              {(option, index) => (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={index() === props.choice ? COLORS.accentSoft : undefined}
                >
                  <text fg={index() === props.choice ? COLORS.text : COLORS.muted}>{option}</text>
                </box>
              )}
            </For>
          </box>
        }
      >
        <box marginTop={1}>
          <text fg={COLORS.muted}>Reason for rejection</text>
          <textarea
            ref={(value) => {
              reasonInput = value
              props.rejectInputRef(value)
            }}
            focused={true}
            keyBindings={PROMPT_KEY_BINDINGS}
            height={2}
            initialValue={props.rejectReason}
            textColor={COLORS.text}
            focusedTextColor={COLORS.text}
            backgroundColor={COLORS.panel}
            onContentChange={() => props.onRejectReason(reasonInput?.plainText ?? "")}
            onKeyDown={(key) => {
              if (isEnter(key) && !key.ctrl && !key.meta && !key.shift) {
                key.preventDefault()
                props.onSubmitReject()
              }
            }}
            onSubmit={() => props.onSubmitReject()}
          />
          <text fg={COLORS.muted}>enter confirm · esc cancel</text>
        </box>
      </Show>
      <text fg={COLORS.muted}>←/→ select · enter confirm · esc reject · ctrl+f fullscreen</text>
    </box>
  )
}

function ReconnectOverlay(props: { managed: boolean }) {
  return (
    <box position="absolute" top={0} left={0} right={0} bottom={0} alignItems="center" justifyContent="center" zIndex={100}>
      <box width={48} border borderColor={COLORS.warn} backgroundColor={COLORS.raised} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <text fg={COLORS.warn}>{props.managed ? "Restarting service…" : "Connection lost…"}</text>
        <text fg={COLORS.muted}>{props.managed ? "Your session will resume automatically." : "Reconnecting to the server automatically."}</text>
      </box>
    </box>
  )
}

export function DialogView(props: {
  dialog: Dialog
  index: number
  sessions: SessionInfo[]
  commands: CommandInfo[]
  models: ModelInfo[]
  checkpoints: Checkpoint[]
  checkpointDiff: CheckpointDiff | null
  queued: InboxUserItem[]
  rules: PermissionRule[]
  memory: { user: string[]; notes: string[]; pending: number }
  settings: Record<string, unknown> | null
  title: string | undefined
  width: number
  onRename: (title: string) => void
  onSelectModel: (model: ModelInfo) => void
  onRestore: () => void
  onCycleApproval: () => void
  inputRef: (value: TextareaRenderable | undefined) => void
}) {
  const dialogWidth = () => Math.min(88, Math.max(30, props.width - 4))
  return (
    <box position="absolute" top={0} left={0} right={0} bottom={0} alignItems="center" paddingTop={2} zIndex={60} backgroundColor={COLORS.bg}>
      <box width={dialogWidth()} maxHeight="90%" border borderColor={COLORS.accent} backgroundColor={COLORS.panel} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
        <box height={1} flexDirection="row">
          <text fg={COLORS.text}>{dialogTitle(props.dialog)}</text>
          <box flexGrow={1} />
          <text fg={COLORS.muted}>esc</text>
        </box>
        <Show when={props.dialog === "palette"}>
          <DialogList items={props.commands.map((command) => `${command.group}  ${command.title}`)} index={props.index} />
        </Show>
        <Show when={props.dialog === "sessions"}>
          <Show when={props.sessions.length > 0} fallback={<text fg={COLORS.muted}>No sessions yet.</text>}>
            <DialogList items={props.sessions.map((session) => session.title)} index={props.index} />
          </Show>
        </Show>
        <Show when={props.dialog === "queued"}>
          <Show
            when={props.queued.length > 0}
            fallback={<text fg={COLORS.muted}>No queued prompts.</text>}
          >
            <DialogList
              items={props.queued.map((item, index) => `${index + 1}. ${item.payload.text.replace(/\s+/g, " ")}`)}
              index={props.index}
            />
            <text fg={COLORS.muted}>enter steer · ctrl+u undo · ctrl+d delete · esc close</text>
          </Show>
        </Show>
        <Show when={props.dialog === "models"}>
          <DialogList items={props.models.map((model) => `${model.name}  ${model.providerId}/${model.modelId}`)} index={props.index} />
        </Show>
        <Show when={props.dialog === "checkpoints"}>
          <Show when={props.checkpoints.length > 0} fallback={<text fg={COLORS.muted}>No checkpoints.</text>}>
            <DialogList
              items={props.checkpoints.map((checkpoint) => `${checkpoint.commit.slice(0, 8)}  ${checkpoint.reason}`)}
              index={props.index}
            />
          </Show>
        </Show>
        <Show when={props.dialog === "diff"}>
          <scrollbox height={18}>
            <text fg={COLORS.text} wrapMode="word">{props.checkpointDiff?.diff || props.checkpointDiff?.stat || "Loading diff…"}</text>
          </scrollbox>
          <text fg={COLORS.muted}>enter restore · esc back</text>
        </Show>
        <Show when={props.dialog === "rules"}>
          <scrollbox height={18}>
            <For each={props.rules}>
              {(rule) => (
                <text fg={COLORS.text}>
                  {rule.effect.padEnd(5)} {rule.action} {rule.resource}
                </text>
              )}
            </For>
          </scrollbox>
        </Show>
        <Show when={props.dialog === "memory"}>
          <scrollbox height={18}>
            <text fg={COLORS.muted}>USER</text>
            <For each={props.memory.user}>{(entry) => <text fg={COLORS.text}>{entry}</text>}</For>
            <text fg={COLORS.muted}>NOTES</text>
            <For each={props.memory.notes}>{(entry) => <text fg={COLORS.text}>{entry}</text>}</For>
            <text fg={COLORS.muted}>Pending: {props.memory.pending}</text>
          </scrollbox>
        </Show>
        <Show when={props.dialog === "settings"}>
          <scrollbox height={18}>
            <text fg={COLORS.text}>{JSON.stringify(props.settings, null, 2)}</text>
            <text fg={COLORS.muted}>m cycle approval mode · enter cycle too</text>
          </scrollbox>
        </Show>
        <Show when={props.dialog === "status"}>
          <scrollbox height={18}>
            <text fg={COLORS.text}>Agent-1 status</text>
            <text fg={COLORS.muted}>Health, reconnect, and active-turn state are reflected in the footer.</text>
          </scrollbox>
        </Show>
        <Show when={props.dialog === "help"}>
          <scrollbox height={18}>
            <text fg={COLORS.text}>ctrl+p command palette</text>
            <text fg={COLORS.text}>ctrl+o sessions</text>
            <text fg={COLORS.text}>ctrl+g checkpoints</text>
            <text fg={COLORS.text}>ctrl+r rename</text>
            <text fg={COLORS.text}>ctrl+tab next tab</text>
            <text fg={COLORS.text}>esc esc interrupt active turn</text>
            <text fg={COLORS.text}>leader ctrl+x</text>
          </scrollbox>
        </Show>
        <Show when={props.dialog === "rename"}>
          <RenameForm
            title={props.title ?? ""}
            onSubmit={props.onRename}
            inputRef={props.inputRef}
          />
        </Show>
      </box>
    </box>
  )
}

function RenameForm(props: {
  title: string
  onSubmit: (title: string) => void
  inputRef: (value: TextareaRenderable | undefined) => void
}) {
  let input: TextareaRenderable | undefined
  onMount(() => {
    queueMicrotask(() => {
      input?.setText(props.title)
      input?.focus()
    })
  })
  return (
    <box gap={1}>
      <text fg={COLORS.muted}>Session title</text>
      <textarea
        ref={(value) => {
          input = value
          props.inputRef(value)
        }}
        focused={true}
        keyBindings={PROMPT_KEY_BINDINGS}
        height={3}
        textColor={COLORS.text}
        focusedTextColor={COLORS.text}
        backgroundColor={COLORS.panel}
        onKeyDown={(key) => {
          if (isEnter(key) && !key.ctrl && !key.meta && !key.shift) {
            key.preventDefault()
            props.onSubmit(input?.plainText ?? "")
          }
        }}
        onSubmit={() => props.onSubmit(input?.plainText ?? "")}
      />
      <text fg={COLORS.muted}>enter save · esc cancel</text>
    </box>
  )
}

function DialogList(props: { items: string[]; index: number }) {
  return (
    <scrollbox height={18}>
      <For each={props.items}>
        {(item, index) => (
          <box paddingLeft={1} paddingRight={1} backgroundColor={index() === props.index ? COLORS.accentSoft : undefined}>
            <text fg={index() === props.index ? COLORS.text : COLORS.muted} wrapMode="none" truncate>
              {item}
            </text>
          </box>
        )}
      </For>
    </scrollbox>
  )
}

function dialogTitle(dialog: Dialog): string {
  switch (dialog) {
    case "palette":
      return "Commands"
    case "sessions":
      return "Sessions"
    case "models":
      return "Models"
    case "queued":
      return "Queued prompts"
    case "checkpoints":
      return "Checkpoints"
    case "diff":
      return "Checkpoint diff"
    case "rules":
      return "Rules"
    case "memory":
      return "Memory"
    case "settings":
      return "Settings"
    case "status":
      return "Status"
    case "help":
      return "Help"
    case "rename":
      return "Rename session"
    default:
      return "Agent-1"
  }
}
