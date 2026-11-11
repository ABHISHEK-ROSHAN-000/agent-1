import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { A, useLocation, useNavigate, useParams } from "@solidjs/router"
import { Popover } from "@kobalte/core/popover"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { toast } from "solid-sonner"
import {
  api,
  streamTurn,
  type Approval,
  type CatalogModel,
  type ContextInfo,
  type JournalEntry,
  type MemoryHistoryRecord,
  type MemoryPendingRecord,
  type MemoryStoreView,
  type Message,
  type ProviderInfo,
  type Session,
  type SessionSearchResult,
  type Workspace,
  modelKey,
  parseModelKey,
} from "./api"
import { Icon } from "./icons"
import { PierreDiffView, PierreFileView, PierreTree } from "./pierre"
import { ApprovalCard, Banner, Composer, Empty, Markdown, PageHeader, formatDate, shortHash, statusColor } from "./ui"
import { applyTheme, getThemePreference, type ThemePreference } from "./theme"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const settingsNav = [
  { href: "/settings", label: "General", icon: "settings" as const },
  { href: "/providers", label: "Providers", icon: "key" as const },
  { href: "/models", label: "Models", icon: "model" as const },
  { href: "/approvals", label: "Approvals", icon: "approvals" as const },
  { href: "/rules", label: "Rules", icon: "rules" as const },
  { href: "/workspaces", label: "Workspaces", icon: "folder" as const },
  { href: "/journal", label: "Journal", icon: "journal" as const },
  { href: "/memory", label: "Memory", icon: "memory" as const },
]

function PageBody(props: { children?: unknown }) {
  const location = useLocation()
  return (
    <div class="settings-layout">
      <aside class="settings-nav">
        <div class="settings-nav-title">Settings</div>
        <For each={settingsNav}>
          {(item) => (
            <A
              href={item.href}
              class="settings-nav-row"
              data-selected={location.pathname === item.href ? "" : undefined}
            >
              <Icon name={item.icon} size={14} />
              <span>{item.label}</span>
            </A>
          )}
        </For>
      </aside>
      <div class="page-scroll">{props.children as never}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ home */

/* ------------------------------------------------------------------ session */

type ToolEntry = {
  id: string
  toolName: string
  input?: Record<string, unknown>
  output?: unknown
  text: string
  failed?: boolean
}

type ChatRow =
  | { kind: "message"; message: Message }
  | { kind: "tools"; key: string; turnId: string | null; items: ToolEntry[] }

function contentParts(message: Message): Array<Record<string, unknown>> {
  const content = message.content as { content?: unknown } | undefined
  const value = content && typeof content === "object" && "content" in content ? content.content : content
  return Array.isArray(value)
    ? value.filter((part): part is Record<string, unknown> =>
        Boolean(part) && typeof part === "object" && !Array.isArray(part),
      )
    : []
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    shell: "Shell",
    fs_read: "Read",
    fs_list: "Read",
    fs_search: "Read",
    fs_write: "Edit",
    fs_move: "Edit",
    fs_apply_moves: "Edit",
    web_fetch: "Web",
    web_search: "Web",
    test_echo: "Echo",
    test_confirm: "Confirm",
  }
  return labels[name] ?? name.replace(/^.*_/, "").replace(/\b\w/g, (char) => char.toUpperCase())
}

function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output
  if (!output || typeof output !== "object") return ""
  const value = output as { value?: unknown; reason?: unknown; error?: unknown }
  const inner = value.value ?? value.reason ?? value.error
  if (typeof inner === "string") return inner
  if (inner && typeof inner === "object") return JSON.stringify(inner)
  return ""
}

function toolSubtitle(entry: ToolEntry): string {
  const input = entry.input ?? {}
  const value = entry.output as { value?: unknown; reason?: unknown; error?: unknown } | undefined
  const output = value?.error ?? value?.reason ?? value?.value
  if (typeof input.command === "string") return input.command
  if (typeof input.path === "string") return input.path
  if (typeof input.url === "string") return input.url
  if (typeof input.query === "string") return input.query
  const firstString = Object.values(input).find((value): value is string => typeof value === "string")
  if (firstString) return firstString
  if (typeof output === "string") return output
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>
    if (typeof record.error === "string") return record.error
    if (typeof record.message === "string") return record.message
    if (typeof record.path === "string") return record.path
  }
  return entry.text
}

function buildChatRows(messages: readonly Message[]): ChatRow[] {
  const calls = new Map<string, { toolName: string; input?: Record<string, unknown> }>()
  const rows: ChatRow[] = []
  for (const message of messages) {
    if (message.role === "assistant") {
      const parts = contentParts(message)
      for (const part of parts) {
        if (part.type !== "tool-call" || typeof part.toolCallId !== "string") continue
        calls.set(part.toolCallId, {
          toolName: typeof part.toolName === "string" ? part.toolName : "tool",
          ...(part.input && typeof part.input === "object" && !Array.isArray(part.input)
            ? { input: part.input as Record<string, unknown> }
            : {}),
        })
      }
      const hasText =
        message.text.trim().length > 0 ||
        parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim())
      if (hasText) rows.push({ kind: "message", message })
      continue
    }
    if (message.role !== "tool") {
      rows.push({ kind: "message", message })
      continue
    }
    const result = contentParts(message).find((part) => part.type === "tool-result")
    const call =
      result && typeof result.toolCallId === "string" ? calls.get(result.toolCallId) : undefined
    const toolName =
      (result && typeof result.toolName === "string" ? result.toolName : undefined) ??
      call?.toolName ??
      "tool"
    const output = result?.output
    const failed =
      Boolean(output && typeof output === "object" && "type" in output && output.type === "execution-denied") ||
      Boolean(toolOutputText(output).toLowerCase().includes("error"))
    const entry: ToolEntry = {
      id: message.id,
      toolName,
      ...(call?.input ? { input: call.input } : {}),
      ...(output === undefined ? {} : { output }),
      text: message.text,
      ...(failed ? { failed: true } : {}),
    }
    const last = rows.at(-1)
    if (last?.kind === "tools" && last.turnId === (message.turnId ?? null)) {
      last.items.push(entry)
    } else {
      rows.push({
        kind: "tools",
        key: `${message.turnId ?? "turn"}:${message.id}`,
        turnId: message.turnId ?? null,
        items: [entry],
      })
    }
  }
  return rows
}

function ToolGroup(props: {
  group: Extract<ChatRow, { kind: "tools" }>
  open: boolean
  onToggle: () => void
}) {
  const names = () => [...new Set(props.group.items.map((item) => toolLabel(item.toolName)))]
  return (
    <div class="message-tool-group">
      <button
        type="button"
        class="tool-group-trigger"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <span class="tool-group-summary">
          <span class="muted">Used</span>
          <span class="tool-group-count">{props.group.items.length}</span>
          <span>{names().join(", ")}</span>
        </span>
        <span class="tool-group-chevron">
          <Icon name="chevron" size={12} />
        </span>
      </button>
      <Show when={props.open}>
        <div class="tool-group-items">
          <For each={props.group.items}>
            {(item) => (
              <div class="tool-group-item">
                <Icon name={item.failed ? "close" : "check"} size={12} />
                <span class="tool-group-item-name">{toolLabel(item.toolName)}</span>
                <span class="tool-group-item-subtitle truncate">{toolSubtitle(item)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
function MessageView(props: { message: Message }) {
  return (
    <div class={`message message-${props.message.role}`}>
      <div class="message-meta">
        <span>{props.message.role}</span>
        <Show when={props.message.createdAt}>
          <span>·</span>
          <span>{formatDate(props.message.createdAt)}</span>
        </Show>
      </div>
      <Show
        when={props.message.role === "assistant"}
        fallback={
          <Show
            when={props.message.role === "tool"}
            fallback={<div class="message-body">{props.message.text}</div>}
          >
            <div class="message-tool">
              <div class="tool-line">
                <span class="tool-badge">tool</span>
                <span class="mono truncate">{props.message.text.slice(0, 220)}</span>
              </div>
            </div>
          </Show>
        }
      >
        <div class="message-body">
          <Markdown content={props.message.text} />
        </div>
      </Show>
    </div>
  )
}

function ContextPanel(props: { context: ContextInfo | undefined }) {
  return (
    <Show when={props.context} fallback={<Empty>Loading context…</Empty>}>
      {(context) => (
        <div>
          <div class="stat-grid">
            <div>
              <span class="stat-label">Session</span>
              <span class="stat-value">{context().session.title}</span>
            </div>
            <div>
              <span class="stat-label">Messages</span>
              <span class="stat-value">{context().messages}</span>
            </div>
            <div>
              <span class="stat-label">Provider</span>
              <span class="stat-value">{context().model?.providerName ?? "—"}</span>
            </div>
            <div>
              <span class="stat-label">Model</span>
              <span class="stat-value">{context().model?.name ?? "Not configured"}</span>
            </div>
            <div>
              <span class="stat-label">Context limit</span>
              <span class="stat-value">{context().contextWindow?.toLocaleString() ?? "—"}</span>
            </div>
            <div>
              <span class="stat-label">Usage</span>
              <span class="stat-value">
                {context().contextWindow
                  ? `${Math.round((context().contextTokens / context().contextWindow!) * 100)}%`
                  : "—"}
              </span>
            </div>
            <div>
              <span class="stat-label">Total tokens</span>
              <span class="stat-value">{(context().inputTokens + context().outputTokens).toLocaleString()}</span>
            </div>
            <div>
              <span class="stat-label">Input tokens</span>
              <span class="stat-value">{context().inputTokens.toLocaleString()}</span>
            </div>
            <div>
              <span class="stat-label">Output tokens</span>
              <span class="stat-value">{context().outputTokens.toLocaleString()}</span>
            </div>
            <div>
              <span class="stat-label">Turns</span>
              <span class="stat-value">{context().turns}</span>
            </div>
            <div>
              <span class="stat-label">Total cost</span>
              <span class="stat-value">${context().costUsd.toFixed(4)}</span>
            </div>
            <div>
              <span class="stat-label">Created</span>
              <span class="stat-value">{formatDate(context().session.createdAt)}</span>
            </div>
            <div>
              <span class="stat-label">Last activity</span>
              <span class="stat-value">{formatDate(context().lastActivity)}</span>
            </div>
          </div>
          <Show when={context().session.summary}>
            <div class="stat-label" style={{ "margin-top": "24px" }}>
              Compacted summary
            </div>
            <div class="system-prompt">{context().session.summary}</div>
          </Show>
          <div class="stat-label" style={{ "margin-top": "24px" }}>
            Runtime
          </div>
          <div class="system-prompt">
            One mode: reads and searches are free; writes, shell commands, connector calls, and MCP
            tools require approval. Every filesystem change is journaled and undoable.
          </div>
        </div>
      )}
    </Show>
  )
}

function FilesPanel() {
  const workspaces = useQuery(() => ({ queryKey: ["workspaces"], queryFn: api.workspaces }))
  const [workspaceId, setWorkspaceId] = createSignal<string>()
  const [selectedFile, setSelectedFile] = createSignal<string>()

  createEffect(() => {
    const list = workspaces.data?.workspaces ?? []
    if (!workspaceId() && list[0]) setWorkspaceId(list[0].id)
  })

  const tree = useQuery(() => ({
    queryKey: ["workspace-paths", workspaceId()],
    queryFn: () => api.workspacePaths(workspaceId()!),
    enabled: Boolean(workspaceId()),
  }))
  const selectedWorkspace = () => workspaces.data?.workspaces.find((workspace) => workspace.id === workspaceId())
  const absolutePath = (relative: string) => {
    const root = selectedWorkspace()?.path?.replace(/[\\/]+$/, "")
    return root ? `${root}/${relative}` : relative
  }
  const file = useQuery(() => ({
    queryKey: ["file", workspaceId(), selectedFile()],
    queryFn: () => api.workspaceFile(workspaceId()!, absolutePath(selectedFile()!)),
    enabled: Boolean(workspaceId() && selectedFile()),
  }))

  return (
    <div class="files-panel">
      <Show when={(workspaces.data?.workspaces.length ?? 0) > 0} fallback={<Empty>No workspace grants. Add one in Workspaces.</Empty>}>
        <select
          class="form-select"
          value={workspaceId() ?? ""}
          onChange={(event) => {
            setWorkspaceId(event.currentTarget.value)
            setSelectedFile(undefined)
          }}
        >
          <For each={workspaces.data?.workspaces}>
            {(workspace) => <option value={workspace.id}>{workspace.label} · {workspace.access}</option>}
          </For>
        </select>
        <div class="files-root">{selectedWorkspace()?.path}</div>
        <div class="files-tree-wrap">
          <Show
            when={tree.data}
            fallback={<div class="empty">Loading files…</div>}
          >
            <PierreTree paths={tree.data?.paths ?? []} onSelect={setSelectedFile} />
          </Show>
        </div>
        <Show when={file.data}>
          {(content) => (
            <div class="files-preview">
              <div class="files-preview-name">
                <Icon name="file" size={12} />
                <span class="truncate">{selectedFile()}</span>
                <span class="tiny faint">{content().size.toLocaleString()} bytes</span>
              </div>
              <PierreFileView name={selectedFile() ?? "file"} contents={content().content.slice(0, 100_000)} />
            </div>
          )}
        </Show>
        <Show when={file.error}>
          <Banner kind="error">{errorMessage(file.error)}</Banner>
        </Show>
      </Show>
    </div>
  )
}

function matchingWorkspace(path: string | null, workspaces: Workspace[]): Workspace | undefined {
  if (!path) return
  const normalized = path.toLowerCase().replace(/\\/g, "/")
  return workspaces.find((workspace) => {
    const root = workspace.path.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "")
    return normalized === root || normalized.startsWith(`${root}/`)
  })
}

function JournalChange(props: { entry: JournalEntry; workspaces: Workspace[] }) {
  const workspace = matchingWorkspace(props.entry.target ?? props.entry.source, props.workspaces)
  const target = props.entry.target ?? props.entry.source
  const file = useQuery(() => ({
    queryKey: ["journal-file", props.entry.id, target],
    queryFn: () => api.workspaceFile(workspace!.id, target!),
    enabled: Boolean(workspace && target && props.entry.state === "done"),
  }))
  const previous = () => {
    const undo = props.entry.undo as { previous?: string | null } | undefined
    return typeof undo?.previous === "string" ? undo.previous : ""
  }
  const relative = () => {
    if (!workspace || !target) return target ?? ""
    return target.replace(workspace.path, "").replace(/^[\\/]/, "").replace(/\\/g, "/")
  }

  return (
    <div class="journal-file">
      <div class="journal-file-head">
        <Icon name={props.entry.operation === "move" ? "back" : "file"} size={11} />
        <span class="truncate">{relative()}</span>
        <span class="tag">{props.entry.operation}</span>
      </div>
      <Show when={props.entry.operation === "move" && props.entry.source && props.entry.target}>
        <div class="journal-move">
          <span>{props.entry.source}</span>
          <span class="new">→ {props.entry.target}</span>
        </div>
      </Show>
      <Show when={file.data}>
        {(content) => (
          <Show
            when={props.entry.operation === "write"}
            fallback={<PierreFileView name={relative()} contents={content().content.slice(0, 100_000)} />}
          >
            <PierreDiffView
              name={relative()}
              before={previous()}
              after={content().content}
            />
          </Show>
        )}
      </Show>
    </div>
  )
}

function JournalList(props: { entries: JournalEntry[]; onUndo: (batchId: string) => void }) {
  const workspaces = useQuery(() => ({ queryKey: ["workspaces"], queryFn: api.workspaces }))
  const batches = createMemo(() => {
    const map = new Map<string, JournalEntry[]>()
    for (const entry of props.entries) {
      const list = map.get(entry.batchId) ?? []
      list.push(entry)
      map.set(entry.batchId, list)
    }
    return Array.from(map.entries())
  })
  return (
    <div class="list">
      <Show when={batches().length > 0} fallback={<Empty>No journal entries for this session.</Empty>}>
        <For each={batches()}>
          {([batchId, entries]) => (
            <div class="list-card">
              <div class="row-between">
                <span class="mono small">{batchId.slice(0, 20)}</span>
                <span class="tag">{entries.length} ops</span>
              </div>
              <div class="small muted" style={{ "margin-top": "5px" }}>
                {entries.filter((entry) => entry.state === "done").length} done ·{" "}
                {entries[0]?.operation ?? "operation"}
              </div>
              <Show when={entries.length <= 8}>
                <details class="journal-details">
                  <summary>Review changes</summary>
                  <For each={entries.filter((entry) => entry.target || entry.source)}>
                    {(entry) => <JournalChange entry={entry} workspaces={workspaces.data?.workspaces ?? []} />}
                  </For>
                </details>
              </Show>
              <button class="button button-ghost button-small" type="button" onClick={() => props.onUndo(batchId)}>
                <Icon name="refresh" size={12} /> Undo batch
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function SessionPanel(props: {
  session: Session | undefined
  context: ContextInfo | undefined
  approvals: Approval[]
  journal: JournalEntry[]
  onDecide: (approval: Approval, decision: "approve" | "reject") => void
  tab: "review" | "context" | "files"
  onTab: (tab: "review" | "context" | "files") => void
  onClose?: () => void
}) {
  const queryClient = useQueryClient()
  return (
    <aside class="side-panel">
      <div class="side-tabs">
        <button class={`side-tab ${props.tab === "review" ? "active" : ""}`} type="button" onClick={() => props.onTab("review")}>
          Review
        </button>
        <button class={`side-tab ${props.tab === "context" ? "active" : ""}`} type="button" onClick={() => props.onTab("context")}>
          Context
        </button>
        <button class={`side-tab ${props.tab === "files" ? "active" : ""}`} type="button" onClick={() => props.onTab("files")}>
          Files
        </button>
        <div class="composer-spacer" />
        <span class="tag">{props.session?.id.slice(0, 10)}</span>
        <Show when={props.onClose}>
          <button class="icon-button" type="button" onClick={props.onClose} title="Close panel">
            <Icon name="close" size={12} />
          </button>
        </Show>
      </div>
      <div class="side-content">
        <Show when={props.tab === "review"}>
          <div class="small bold muted" style={{ "margin-bottom": "9px" }}>
            Pending approvals
          </div>
          <Show when={props.approvals.length > 0} fallback={<Empty>No pending approvals.</Empty>}>
            <div class="list">
              <For each={props.approvals}>
                {(approval) => (
                  <ApprovalCard
                    approval={approval}
                    onDecide={(decision) => props.onDecide(approval, decision)}
                  />
                )}
              </For>
            </div>
          </Show>
          <div class="divider" />
          <div class="small bold muted" style={{ "margin-bottom": "9px" }}>
            Journal
          </div>
          <JournalList
            entries={props.journal}
            onUndo={async (batchId) => {
              try {
                const result = await api.undoJournal(batchId)
                toast.success(`Undo: ${result.undone} completed`)
                await queryClient.invalidateQueries()
              } catch (error) {
                toast.error(errorMessage(error))
              }
            }}
          />
        </Show>
        <Show when={props.tab === "context"}>
          <ContextPanel context={props.context} />
        </Show>
        <Show when={props.tab === "files"}>
          <FilesPanel />
        </Show>
      </div>
    </aside>
  )
}

function ContextRing(props: { percentage: number; size?: number }) {
  const size = props.size ?? 16
  const stroke = 2
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.max(0, Math.min(100, props.percentage)) / 100)
  return (
    <svg
      class="context-ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      aria-hidden="true"
    >
      <circle cx={size / 2} cy={size / 2} r={radius} stroke-width={stroke} class="context-ring-track" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke-width={stroke}
        stroke-dasharray={String(circumference)}
        stroke-dashoffset={String(offset)}
        class="context-ring-progress"
      />
    </svg>
  )
}

function ContextUsage(props: { context: ContextInfo | undefined; onOpen: () => void }) {
  const [open, setOpen] = createSignal(false)
  const tokens = () => props.context?.contextTokens ?? 0
  const usage = () =>
    props.context?.contextWindow ? Math.round((tokens() / props.context.contextWindow) * 100) : 0
  const compactTokens = () =>
    new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 0 })
      .format(tokens())
      .toLowerCase()
  const cost = () => props.context?.costUsd ?? 0

  return (
    <Show when={props.context}>
      <Popover open={open()} onOpenChange={setOpen} placement="bottom-end" gutter={6}>
        <Popover.Trigger class="context-usage-trigger" type="button" aria-label="Context usage">
          <ContextRing percentage={usage()} />
          <span>{compactTokens()}</span>
          <Show when={cost() > 0}>
            <span aria-hidden="true">·</span>
            <span>${cost().toFixed(2)}</span>
          </Show>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content class="context-usage-popover" aria-label="Context usage">
            <div class="context-usage-row">
              <span>Tokens</span>
              <strong>{tokens().toLocaleString()}</strong>
            </div>
            <div class="context-usage-row">
              <span>Cost</span>
              <strong>${cost().toFixed(2)}</strong>
            </div>
            <div class="context-usage-row">
              <span>Usage</span>
              <strong>{usage()}%</strong>
            </div>
            <button
              type="button"
              class="context-usage-view"
              onClick={() => {
                setOpen(false)
                props.onOpen()
              }}
            >
              View context
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </Show>
  )
}
export function SessionPage() {
  const params = useParams<{ id: string }>()
  const location = useLocation()
  const id = () => params.id ?? ""
  const queryClient = useQueryClient()
  const [sideTab, setSideTab] = createSignal<"review" | "context" | "files">("context")
  const [sideOpen, setSideOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [liveText, setLiveText] = createSignal("")
  const [liveTurnId, setLiveTurnId] = createSignal<string>()
  const [turnError, setTurnError] = createSignal<string>()
  const [selectedModel, setSelectedModel] = createSignal<string>()
  const [selectedEffort, setSelectedEffort] = createSignal<string | null>(null)
  let stream: { abort(): void } | undefined
  let chatPane: HTMLDivElement | undefined
  let messagesEl: HTMLDivElement | undefined
  let messagesInner: HTMLDivElement | undefined
  const [following, setFollowing] = createSignal(true)
  const [scrollOverflow, setScrollOverflow] = createSignal(false)

  const sessions = useQuery(() => ({ queryKey: ["sessions"], queryFn: api.sessions }))
  const messages = useQuery(() => ({
    queryKey: ["messages", id()],
    queryFn: () => api.messages(id()),
    enabled: Boolean(id()),
    refetchInterval: (query) => {
      const approvals = queryClient.getQueryData<{ approvals: Approval[] }>(["approvals"])
      return approvals?.approvals.some((approval) => approval.sessionId === id() && approval.status === "pending")
        ? 2000
        : false
    },
  }))
  const context = useQuery(() => ({
    queryKey: ["context", id()],
    queryFn: () => api.context(id()),
    enabled: Boolean(id()),
    refetchInterval: 5_000,
  }))
  const approvals = useQuery(() => ({
    queryKey: ["approvals"],
    queryFn: () => api.approvals(),
    refetchInterval: 2_000,
  }))
  const journal = useQuery(() => ({
    queryKey: ["journal", id()],
    queryFn: () => api.journal(200),
    enabled: Boolean(id()),
  }))
  const models = useQuery(() => ({ queryKey: ["models"], queryFn: () => api.models() }))
  const defaultModel = useQuery(() => ({ queryKey: ["default-model"], queryFn: api.defaultModel }))

  const session = () => sessions.data?.sessions.find((item) => item.id === id())
  const sessionApprovals = () => (approvals.data?.approvals ?? []).filter((approval) => approval.sessionId === id())
  const pendingApprovals = () => sessionApprovals().filter((approval) => approval.status === "pending")
  const sessionJournal = () => (journal.data?.entries ?? []).filter((entry) => entry.sessionId === id())
  const chatRows = createMemo(() => buildChatRows(messages.data?.messages ?? []))
  const [openToolGroups, setOpenToolGroups] = createSignal<Set<string>>(new Set())

  const toggleToolGroup = (key: string) => {
    setOpenToolGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  let appliedContextModel = false
  createEffect(
    on(
      () => id(),
      () => {
        appliedContextModel = false
        setSelectedModel("")
        setSelectedEffort(null)
        setFollowing(true)
        setScrollOverflow(false)
      },
    ),
  )
  createEffect(() => {
    const contextModel = context.data?.model
      ? `${context.data.model.providerId}/${context.data.model.modelId}`
      : undefined
    if (contextModel && !appliedContextModel) {
      appliedContextModel = true
      setSelectedModel(contextModel)
      setSelectedEffort(context.data?.session.reasoningEffort ?? null)
      return
    }
    const fallback = defaultModel.data?.model
      ? modelKey(defaultModel.data.model)
      : models.data?.models?.[0]
        ? modelKey(models.data.models[0])
        : undefined
    if (!selectedModel() && fallback) setSelectedModel(fallback)
  })

  let autoScrolling = false
  let lastScrollTop = 0
  const scrollToEnd = (behavior: ScrollBehavior = "auto") => {
    const element = messagesEl
    if (!element) return
    autoScrolling = true
    element.scrollTo({ top: element.scrollHeight, behavior })
    requestAnimationFrame(() => {
      autoScrolling = false
    })
  }

  const updateScrollState = () => {
    const element = messagesEl
    if (!element) return
    const overflow = element.scrollHeight - element.clientHeight > 1
    setScrollOverflow(overflow)
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= 4
    if (atEnd) setFollowing(true)
    else if (!autoScrolling && element.scrollTop < lastScrollTop - 1) setFollowing(false)
    lastScrollTop = element.scrollTop
    return { atEnd, overflow }
  }

  createEffect(() => {
    void messages.data?.messages.length
    void liveText()
    void pendingApprovals().length
    if (!following()) return
    queueMicrotask(() => {
      if (!following()) return
      scrollToEnd()
      updateScrollState()
    })
  })

  onMount(() => {
    const element = messagesEl
    const inner = messagesInner
    if (!element) return
    const composer = chatPane?.querySelector<HTMLElement>(".composer-wrap")
    const composerObserver = composer
      ? new ResizeObserver(() => {
          chatPane?.style.setProperty("--composer-height", `${composer.offsetHeight}px`)
        })
      : undefined
    if (composer && composerObserver) {
      composerObserver.observe(composer)
      chatPane?.style.setProperty("--composer-height", `${composer.offsetHeight}px`)
    }
    const onScroll = () => updateScrollState()
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && element.scrollHeight - element.clientHeight > 1) setFollowing(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (["PageUp", "Home", "ArrowUp"].includes(event.key) && element.scrollHeight - element.clientHeight > 1) {
        setFollowing(false)
      }
    }
    const onPointerDown = () => updateScrollState()
    const observer = inner
      ? new ResizeObserver(() => {
          updateScrollState()
          if (following()) queueMicrotask(() => following() && scrollToEnd())
        })
      : undefined
    if (inner) observer?.observe(inner)
    element.addEventListener("scroll", onScroll, { passive: true })
    element.addEventListener("wheel", onWheel, { passive: true })
    element.addEventListener("keydown", onKeyDown)
    element.addEventListener("pointerdown", onPointerDown)
    updateScrollState()
    onCleanup(() => {
      observer?.disconnect()
      composerObserver?.disconnect()
      element.removeEventListener("scroll", onScroll)
      element.removeEventListener("wheel", onWheel)
      element.removeEventListener("keydown", onKeyDown)
      element.removeEventListener("pointerdown", onPointerDown)
    })
  })

  onCleanup(() => stream?.abort())

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["messages", id()] }),
      queryClient.invalidateQueries({ queryKey: ["approvals"] }),
      queryClient.invalidateQueries({ queryKey: ["context", id()] }),
      queryClient.invalidateQueries({ queryKey: ["journal", id()] }),
    ])
  }

  const attachStream = async (turnId: string) => {
    setBusy(true)
    setTurnError(undefined)
    setLiveText("")
    setLiveTurnId(turnId)
    try {
      const handle = streamTurn(turnId, (event) => {
        if (event.type === "delta") setLiveText((current) => current + event.text)
        else if (event.type === "retry") toast.info(`Retrying (${event.attempt}): ${event.message}`)
        else if (event.type === "error") setTurnError(event.message)
        else if (event.type === "done") {
          if (event.status === "completed") toast.success("Turn completed")
          if (event.status === "waiting_approval") toast.info("Approval required")
          if (event.status === "failed") toast.error("Turn failed")
        }
      })
      stream = handle
      await handle.done
      await refresh()
    } catch (error) {
      setTurnError(errorMessage(error))
    } finally {
      stream = undefined
      setBusy(false)
      setLiveText("")
      setLiveTurnId(undefined)
    }
  }

  const send = async (text: string) => {
    if (busy()) return
    setBusy(true)
    setTurnError(undefined)
    setFollowing(true)
    try {
      const selection = parseModelKey(selectedModel())
      const started = await api.startMessage(
        id(),
        text,
        selection ? { ...selection, reasoningEffort: selectedEffort() } : undefined,
      )
      await attachStream(started.turn.id)
    } catch (error) {
      setTurnError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  let handledTurn: string | undefined
  createEffect(() => {
    const turnId = new URLSearchParams(location.search).get("turn")
    if (!turnId || handledTurn === turnId) return
    handledTurn = turnId
    void attachStream(turnId)
  })

  const stop = async () => {
    const turnId = liveTurnId()
    stream?.abort()
    if (turnId) {
      try {
        await api.cancelTurn(turnId)
      } catch {
        // Best effort.
      }
    }
    setBusy(false)
    await refresh()
  }

  const decide = async (approval: Approval, decision: "approve" | "reject") => {
    try {
      await api.decideApproval(approval.id, decision)
      toast.success(decision === "approve" ? "Approved" : "Rejected")
      await refresh()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <div class="session-screen">
      <div class="session-body">
        <div class="chat-pane" ref={chatPane}>
          <div class="session-header">
            <div class="session-header-title">
              <strong>{session()?.title ?? "Session"}</strong>
              <span class="session-header-path">Agent-1 local</span>
            </div>
            <div class="session-header-actions">
              <Show when={busy()}>
                <span class="tag amber">working</span>
              </Show>
              <Show when={pendingApprovals().length > 0}>
                <span class="tag amber">{pendingApprovals().length} approval</span>
              </Show>
              <ContextUsage
                context={context.data}
                onOpen={() => {
                  setSideOpen(true)
                  setSideTab("context")
                }}
              />
              <button
                class="icon-button"
                type="button"
                onClick={() => {
                  if (sideOpen()) {
                    setSideOpen(false)
                  } else {
                    setSideTab("context")
                    setSideOpen(true)
                  }
                }}
                title="Toggle context panel"
              >
                <Icon name="panel" size={15} />
              </button>
            </div>
          </div>
          <div class="messages" ref={messagesEl}>
            <div class="messages-inner" ref={messagesInner}>
              <Show when={(messages.data?.messages.length ?? 0) === 0 && !busy()}>
                <Empty>
                  <div>
                    <div class="bold" style={{ color: "var(--v2-text-text-base)", "margin-bottom": "6px" }}>
                      Start a conversation
                    </div>
                    <div>Ask Agent-1 to inspect a folder, research something, or prepare an approval-gated action.</div>
                  </div>
                </Empty>
              </Show>
              <For each={chatRows()}>
                {(row) =>
                  row.kind === "tools" ? (
                    <ToolGroup
                      group={row}
                      open={openToolGroups().has(row.key)}
                      onToggle={() => toggleToolGroup(row.key)}
                    />
                  ) : (
                    <MessageView message={row.message} />
                  )
                }
              </For>
              <Show when={liveText()}>
                <div class="message message-assistant">
                  <div class="message-meta">assistant</div>
                  <div class="message-live">
                    <Markdown content={liveText()} streaming />
                    <span class="typing-cursor" />
                  </div>
                </div>
              </Show>
              <Show when={pendingApprovals().length > 0 && (!sideOpen() || sideTab() !== "review")}>
                <div class="list">
                  <For each={pendingApprovals()}>
                    {(approval) => <ApprovalCard approval={approval} onDecide={(decision) => void decide(approval, decision)} />}
                  </For>
                </div>
              </Show>
              <Show when={turnError()}>
                <Banner kind="error">{turnError()}</Banner>
              </Show>
            </div>
          </div>
          <Show when={!following() && scrollOverflow()}>
            <button
              class="jump-to-latest"
              type="button"
              title="Jump to latest"
              aria-label="Jump to latest"
              onClick={() => {
                setFollowing(true)
                scrollToEnd("smooth")
              }}
            >
              <Icon name="chevron" size={14} />
            </button>
          </Show>
          <Composer
            onSubmit={send}
            onStop={() => void stop()}
            busy={busy()}
            models={models.data?.models ?? []}
            modelId={selectedModel()}
            reasoningEffort={selectedEffort()}
            onModel={(value) => {
              setSelectedModel(value)
              setSelectedEffort(null)
              const selection = parseModelKey(value)
              if (!selection) return
              void api
                .setSessionModel(id(), selection)
                .then(() => queryClient.invalidateQueries({ queryKey: ["context", id()] }))
                .catch((error) => toast.error(errorMessage(error)))
            }}
            onReasoningEffort={(value) => {
              setSelectedEffort(value ?? null)
              const selection = parseModelKey(selectedModel())
              if (!selection) return
              void api
                .setSessionModel(id(), { ...selection, reasoningEffort: value ?? null })
                .then(() => queryClient.invalidateQueries({ queryKey: ["context", id()] }))
                .catch((error) => toast.error(errorMessage(error)))
            }}
          />
        </div>
        <Show when={sideOpen()}>
          <SessionPanel
            session={session()}
            context={context.data}
            approvals={pendingApprovals()}
            journal={sessionJournal()}
            onDecide={(approval, decision) => void decide(approval, decision)}
            tab={sideTab()}
            onTab={setSideTab}
            onClose={() => setSideOpen(false)}
          />
        </Show>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ pages */

export function ApprovalsPage() {
  const queryClient = useQueryClient()
  const approvals = useQuery(() => ({ queryKey: ["approvals"], queryFn: () => api.approvals() }))
  const [filter, setFilter] = createSignal("pending")
  const filtered = () => (approvals.data?.approvals ?? []).filter((approval) => filter() === "all" || approval.status === filter())

  const decide = async (approval: Approval, decision: "approve" | "reject") => {
    try {
      await api.decideApproval(approval.id, decision)
      toast.success(decision === "approve" ? "Approved" : "Rejected")
      await queryClient.invalidateQueries({ queryKey: ["approvals"] })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <PageBody>
      <PageHeader title="Approvals" subtitle="Exact-argument decisions for side effects and external actions.">
        <select class="form-select" value={filter()} onChange={(event) => setFilter(event.currentTarget.value)}>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="expired">Expired</option>
          <option value="all">All</option>
        </select>
      </PageHeader>
      <Show when={filtered().length > 0} fallback={<Empty>No {filter()} approvals.</Empty>}>
        <div class="list">
          <For each={filtered()}>
            {(approval) => (
              <div class="list-card">
                <div class="row-between">
                  <div class="row">
                    <span class="tag">{approval.toolName}</span>
                    <span class={`tag ${statusColor(approval.status)}`}>{approval.status}</span>
                    <span class="tiny faint mono">{shortHash(approval.argumentsHash)}</span>
                  </div>
                  <span class="tiny faint">{formatDate(approval.createdAt)}</span>
                </div>
                <div class="row" style={{ "margin-top": "9px", "align-items": "flex-start", "gap": "10px" }}>
                  <div class="grow">
                    <ApprovalCard
                      approval={approval}
                      onDecide={(decision) => void decide(approval, decision)}
                    />
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </PageBody>
  )
}

export function RulesPage() {
  const queryClient = useQueryClient()
  const rules = useQuery(() => ({ queryKey: ["rules"], queryFn: api.rules }))
  const [action, setAction] = createSignal("")
  const [resource, setResource] = createSignal("*")
  const [effect, setEffect] = createSignal<"allow" | "ask" | "deny">("ask")
  const [note, setNote] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const create = async () => {
    if (!action().trim()) return
    setBusy(true)
    try {
      await api.createRule({ action: action(), resource: resource(), effect: effect(), note: note() })
      setAction("")
      setNote("")
      await queryClient.invalidateQueries({ queryKey: ["rules"] })
      toast.success("Rule created")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    try {
      await api.deleteRule(id)
      await queryClient.invalidateQueries({ queryKey: ["rules"] })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <PageBody>
      <PageHeader title="Rules" subtitle="Deny beats allow. Allow beats ask. Everything else falls back to risk class." />
      <div class="form-grid" style={{ "margin-bottom": "24px" }}>
        <div class="form-row">
          <div>
            <label class="form-label">Action</label>
            <input class="form-input" value={action()} onInput={(event) => setAction(event.currentTarget.value)} placeholder="fs.write" />
          </div>
          <div>
            <label class="form-label">Resource</label>
            <input class="form-input" value={resource()} onInput={(event) => setResource(event.currentTarget.value)} placeholder="*" />
          </div>
        </div>
        <div class="form-row">
          <div>
            <label class="form-label">Effect</label>
            <select class="form-select" value={effect()} onChange={(event) => setEffect(event.currentTarget.value as "allow" | "ask" | "deny")}>
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </select>
          </div>
          <div>
            <label class="form-label">Note</label>
            <input class="form-input" value={note()} onInput={(event) => setNote(event.currentTarget.value)} placeholder="Why this rule exists" />
          </div>
        </div>
        <button class="button button-primary" type="button" onClick={() => void create()} disabled={busy() || !action().trim()}>
          Add rule
        </button>
      </div>
      <div class="list">
        <For each={rules.data?.rules ?? []}>
          {(rule) => (
            <div class="list-card">
              <div class="row-between">
                <div class="row">
                  <span class={`tag ${rule.effect === "deny" ? "red" : rule.effect === "allow" ? "green" : "amber"}`}>{rule.effect}</span>
                  <span class="mono small">{rule.action}</span>
                  <span class="tiny faint">{rule.resource}</span>
                </div>
                <button class="icon-button" type="button" onClick={() => void remove(rule.id)} title="Delete rule">
                  <Icon name="trash" size={13} />
                </button>
              </div>
              <Show when={rule.note}>
                <div class="small muted" style={{ "margin-top": "5px" }}>{rule.note}</div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </PageBody>
  )
}

export function WorkspacesPage() {
  const queryClient = useQueryClient()
  const workspaces = useQuery(() => ({ queryKey: ["workspaces"], queryFn: api.workspaces }))
  const [pathValue, setPathValue] = createSignal("")
  const [label, setLabel] = createSignal("")
  const [access, setAccess] = createSignal<"read" | "write">("read")
  const [busy, setBusy] = createSignal(false)

  const add = async () => {
    if (!pathValue().trim()) return
    setBusy(true)
    try {
      await api.addWorkspace({ path: pathValue(), label: label() || undefined, access: access() })
      setPathValue("")
      setLabel("")
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] })
      toast.success("Workspace granted")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (workspace: Workspace) => {
    try {
      await api.removeWorkspace(workspace.id)
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <PageBody>
      <PageHeader title="Workspaces" subtitle="Folders the agent may inspect or change. Writes still require approval." />
      <div class="form-grid" style={{ "margin-bottom": "24px" }}>
        <div class="form-row">
          <div>
            <label class="form-label">Folder path</label>
            <input class="form-input" value={pathValue()} onInput={(event) => setPathValue(event.currentTarget.value)} placeholder="C:\\Users\\me\\Documents" />
          </div>
          <div>
            <label class="form-label">Label</label>
            <input class="form-input" value={label()} onInput={(event) => setLabel(event.currentTarget.value)} placeholder="Documents" />
          </div>
        </div>
        <div class="row">
          <select class="form-select" value={access()} onChange={(event) => setAccess(event.currentTarget.value as "read" | "write")}>
            <option value="read">Read</option>
            <option value="write">Read + write</option>
          </select>
          <button class="button button-primary" type="button" onClick={() => void add()} disabled={busy() || !pathValue().trim()}>
            Grant folder
          </button>
        </div>
      </div>
      <div class="list">
        <For each={workspaces.data?.workspaces ?? []}>
          {(workspace) => (
            <div class="list-card">
              <div class="row-between">
                <div>
                  <div class="row">
                    <strong>{workspace.label}</strong>
                    <span class="tag">{workspace.access}</span>
                  </div>
                  <div class="mono tiny muted" style={{ "margin-top": "4px" }}>{workspace.path}</div>
                </div>
                <button class="icon-button" type="button" onClick={() => void remove(workspace)} title="Remove workspace">
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </PageBody>
  )
}

export function JournalPage() {
  const queryClient = useQueryClient()
  const journal = useQuery(() => ({ queryKey: ["journal-all"], queryFn: () => api.journal(200) }))
  const undo = async (batchId: string) => {
    try {
      const result = await api.undoJournal(batchId)
      toast.success(`Undo: ${result.undone} completed, ${result.skipped} skipped`)
      await queryClient.invalidateQueries({ queryKey: ["journal-all"] })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <PageBody>
      <PageHeader title="Journal" subtitle="Every filesystem action is recorded with hashes and undo data." />
      <JournalList entries={journal.data?.entries ?? []} onUndo={(batchId) => void undo(batchId)} />
    </PageBody>
  )
}

function MemoryUsageBar(props: { store: MemoryStoreView }) {
  return (
    <div class="memory-usage">
      <div class="memory-usage-bar">
        <span style={{ width: `${props.store.usage.percent}%` }} />
      </div>
      <span class="tiny faint">
        {props.store.usage.chars.toLocaleString()} / {props.store.usage.limit.toLocaleString()} chars
        {" · "}
        {props.store.usage.percent}%
      </span>
    </div>
  )
}

export function MemoryPage() {
  const queryClient = useQueryClient()
  const memory = useQuery(() => ({ queryKey: ["memory"], queryFn: api.memory }))
  const [addStore, setAddStore] = createSignal<"user" | "memory">("user")
  const [addText, setAddText] = createSignal("")
  const [editing, setEditing] = createSignal<{ store: "user" | "memory"; oldText: string; value: string }>()
  const [searchText, setSearchText] = createSignal("")
  const [searchResult, setSearchResult] = createSignal<SessionSearchResult>()
  const [busy, setBusy] = createSignal(false)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["memory"] })
  }

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
      toast.success(success)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const add = () => {
    const content = addText().trim()
    if (!content) return
    void run(
      () => api.updateMemory({ store: addStore(), operations: [{ action: "add", content }] }),
      "Memory entry added.",
    )
    setAddText("")
  }

  const saveEdit = () => {
    const current = editing()
    if (!current) return
    if (current.value.trim() === current.oldText.trim()) {
      setEditing(undefined)
      return
    }
    void run(
      () =>
        api.updateMemory({
          store: current.store,
          operations: [{ action: "patch", oldText: current.oldText, content: current.value }],
        }),
      "Memory entry updated.",
    )
    setEditing(undefined)
  }

  const remove = (store: "user" | "memory", entry: string) => {
    if (!window.confirm("Remove this memory entry?")) return
    void run(
      () => api.updateMemory({ store, operations: [{ action: "remove", oldText: entry }] }),
      "Memory entry removed.",
    )
  }

  const decide = (pending: MemoryPendingRecord, decision: "approve" | "reject") => {
    void run(
      () => api.decideMemoryPending(pending.id, decision),
      decision === "approve" ? "Memory change approved." : "Memory change rejected.",
    )
  }

  const undo = (history: MemoryHistoryRecord) => {
    void run(() => api.undoMemory(history.id), "Memory change undone.")
  }

  const search = async () => {
    const query = searchText().trim()
    if (!query) {
      setSearchResult(undefined)
      return
    }
    setBusy(true)
    try {
      setSearchResult(await api.searchSessions({ query, limit: 5 }))
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageBody>
      <PageHeader
        title="What Agent-1 knows"
        subtitle="Durable user and environment memory, pending review changes, history, and past-session recall."
      />
      <Show when={memory.data} fallback={<Empty>Loading memory…</Empty>}>
        {(data) => (
          <>
            <div class="memory-grid">
              <For each={[data().user, data().memory]}>
                {(store) => (
                  <section class="list-card memory-panel">
                    <div class="row-between">
                      <div>
                        <div class="list-card-title">{store.store === "user" ? "User profile" : "Agent memory"}</div>
                        <div class="small muted">
                          {store.store === "user" ? "Identity, preferences, and communication style." : "Environment facts, conventions, and lessons."}
                        </div>
                      </div>
                      <span class="tag">{store.entries.length} entries</span>
                    </div>
                    <MemoryUsageBar store={store} />
                    <div class="memory-entries">
                      <Show when={store.entries.length > 0} fallback={<div class="small faint">No entries yet.</div>}>
                        <For each={store.entries}>
                          {(entry) => (
                            <div class="memory-entry">
                              <Show
                                when={
                                  editing()?.store === store.store && editing()?.oldText === entry
                                }
                                fallback={
                                  <>
                                    <div class="memory-entry-text">{entry}</div>
                                    <div class="row memory-entry-actions">
                                      <button
                                        class="button button-ghost button-small"
                                        type="button"
                                        onClick={() => setEditing({ store: store.store, oldText: entry, value: entry })}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        class="button button-ghost button-small"
                                        type="button"
                                        onClick={() => remove(store.store, entry)}
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </>
                                }
                              >
                                <textarea
                                  class="form-input memory-edit"
                                  value={editing()?.value ?? ""}
                                  onInput={(event) =>
                                    setEditing((current) =>
                                      current ? { ...current, value: event.currentTarget.value } : current,
                                    )
                                  }
                                />
                                <div class="row memory-entry-actions">
                                  <button class="button button-primary button-small" type="button" onClick={saveEdit}>
                                    Save
                                  </button>
                                  <button
                                    class="button button-ghost button-small"
                                    type="button"
                                    onClick={() => setEditing(undefined)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </Show>
                    </div>
                  </section>
                )}
              </For>
            </div>

            <section class="list-card memory-add">
              <div class="list-card-title">Add memory</div>
              <div class="form-row">
                <select
                  class="form-select"
                  value={addStore()}
                  onChange={(event) => setAddStore(event.currentTarget.value as "user" | "memory")}
                >
                  <option value="user">User profile</option>
                  <option value="memory">Agent memory</option>
                </select>
                <input
                  class="form-input"
                  value={addText()}
                  placeholder="A compact, durable fact"
                  onInput={(event) => setAddText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") add()
                  }}
                />
                <button class="button button-primary" type="button" disabled={busy()} onClick={add}>
                  Add
                </button>
              </div>
            </section>

            <section class="memory-section">
              <div class="row-between">
                <div>
                  <div class="list-card-title">Pending background changes</div>
                  <div class="small muted">Destructive edits from the background review wait for your decision.</div>
                </div>
                <span class="tag">{data().pending.length} pending</span>
              </div>
              <Show when={data().pending.length > 0} fallback={<Empty>No pending memory changes.</Empty>}>
                <div class="list">
                  <For each={data().pending}>
                    {(pending) => (
                      <div class="list-card">
                        <div class="row-between">
                          <div>
                            <span class="tag">{pending.action}</span>{" "}
                            <span class="tag">{pending.store}</span>
                            <span class="small muted" style={{ "margin-left": "8px" }}>{pending.origin}</span>
                          </div>
                          <span class="tiny faint">{formatDate(pending.createdAt)}</span>
                        </div>
                        <div class="small" style={{ "margin-top": "8px" }}>{pending.summary}</div>
                        <Show when={pending.matchedEntry}>
                          <div class="small muted" style={{ "margin-top": "5px" }}>
                            Target: {pending.matchedEntry}
                          </div>
                        </Show>
                        <div class="row" style={{ "margin-top": "10px" }}>
                          <button
                            class="button button-primary button-small"
                            type="button"
                            disabled={busy()}
                            onClick={() => decide(pending, "approve")}
                          >
                            Approve
                          </button>
                          <button
                            class="button button-ghost button-small"
                            type="button"
                            disabled={busy()}
                            onClick={() => decide(pending, "reject")}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </section>

            <section class="memory-section">
              <div class="row-between">
                <div>
                  <div class="list-card-title">History and undo</div>
                  <div class="small muted">Every applied memory change is journaled.</div>
                </div>
                <a class="button button-secondary button-small" href="/v1/memory/export">
                  Export Markdown
                </a>
              </div>
              <Show when={data().history.length > 0} fallback={<Empty>No memory history yet.</Empty>}>
                <div class="list">
                  <For each={data().history.slice(0, 20)}>
                    {(history) => (
                      <div class="list-card memory-history-row">
                        <div class="row-between">
                          <div>
                            <strong>{history.action}</strong>{" "}
                            <span class="tag">{history.store}</span>{" "}
                            <span class="tiny faint">{history.actor}</span>
                          </div>
                          <span class="tiny faint">{formatDate(history.createdAt)}</span>
                        </div>
                        <div class="row-between" style={{ "margin-top": "8px" }}>
                          <div class="small muted">
                            {history.before.length} → {history.after.length} entries
                            {history.pendingId ? " · from background review" : ""}
                          </div>
                          <Show
                            when={!history.undoneAt}
                            fallback={<span class="tiny faint">Undone</span>}
                          >
                            <button
                              class="button button-ghost button-small"
                              type="button"
                              disabled={busy()}
                              onClick={() => undo(history)}
                            >
                              Undo
                            </button>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </section>

            <section class="memory-section">
              <div class="list-card-title">Search past sessions</div>
              <div class="form-row" style={{ "margin-top": "10px" }}>
                <input
                  class="form-input"
                  value={searchText()}
                  placeholder="Search actual past messages"
                  onInput={(event) => setSearchText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void search()
                  }}
                />
                <button class="button button-secondary" type="button" disabled={busy()} onClick={() => void search()}>
                  Search
                </button>
              </div>
              <Show when={searchResult()}>
                {(result) => (
                  <div class="memory-search-results">
                    <Show when={result().ok} fallback={<div class="small red">{result().error}</div>}>
                      <Show when={result().results?.length} fallback={null}>
                        <For each={result().results}>
                          {(group) => (
                            <div class="list-card">
                              <A class="bold" href={`/sessions/${encodeURIComponent(group.sessionId)}`}>
                                {group.title}
                              </A>
                              <For each={group.matches}>
                                {(match) => (
                                  <div class="memory-search-match">
                                    <span class="tag">{match.role}</span>{" "}
                                    <span class="small muted">{match.snippet}</span>
                                  </div>
                                )}
                              </For>
                            </div>
                          )}
                        </For>
                      </Show>
                      <Show when={result().messages?.length}>
                        <div class="list-card">
                          <div class="bold">{result().title ?? "Session"}</div>
                          <For each={result().messages}>
                            {(message) => (
                              <div class="memory-search-match">
                                <span class="tag">{message.role}</span>{" "}
                                <span class="small muted">{message.text}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                      <Show when={result().sessions?.length}>
                        <div class="list-card">
                          <For each={result().sessions}>
                            {(session) => (
                              <div class="memory-search-match">
                                <A href={`/sessions/${encodeURIComponent(session.id)}`}>{session.title}</A>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </Show>
                  </div>
                )}
              </Show>
            </section>
          </>
        )}
      </Show>
    </PageBody>
  )
}

export function ModelsPage() {
  const queryClient = useQueryClient()
  const providers = useQuery(() => ({ queryKey: ["providers"], queryFn: api.providers }))
  const models = useQuery(() => ({ queryKey: ["models-all"], queryFn: () => api.models(undefined, true) }))
  const defaultModel = useQuery(() => ({ queryKey: ["default-model"], queryFn: api.defaultModel }))
  const [search, setSearch] = createSignal("")

  const providerName = (providerId: string) =>
    providers.data?.providers.find((provider) => provider.id === providerId)?.name ?? providerId
  const filtered = () =>
    (models.data?.models ?? []).filter((model) => {
      const query = search().trim().toLowerCase()
      return !query || `${model.name} ${model.modelId} ${providerName(model.providerId)}`.toLowerCase().includes(query)
    })
  const grouped = () => {
    const map = new Map<string, CatalogModel[]>()
    for (const model of filtered()) {
      const group = map.get(model.providerId) ?? []
      group.push(model)
      map.set(model.providerId, group)
    }
    return [...map.entries()]
  }

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["providers"] }),
      queryClient.invalidateQueries({ queryKey: ["models"] }),
      queryClient.invalidateQueries({ queryKey: ["models-all"] }),
      queryClient.invalidateQueries({ queryKey: ["default-model"] }),
    ])
  }

  const toggle = async (model: CatalogModel, enabled: boolean) => {
    try {
      await api.updateModel(model.providerId, model.modelId, { enabled })
      await refresh()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const favorite = async (model: CatalogModel) => {
    try {
      await api.updateModel(model.providerId, model.modelId, { favorite: !model.favorite })
      await refresh()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const makeDefault = async (model: CatalogModel) => {
    try {
      await api.setDefaultModel({ providerId: model.providerId, modelId: model.modelId })
      await refresh()
      toast.success(`${model.name} is now the default`)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <PageBody>
      <PageHeader title="Models" subtitle="Enabled models from connected providers. Connect a provider first." />
      <div class="form-row" style={{ "margin-bottom": "18px" }}>
        <input
          class="form-input"
          value={search()}
          onInput={(event) => setSearch(event.currentTarget.value)}
          placeholder="Search models or providers"
        />
      </div>
      <Show
        when={grouped().length > 0}
        fallback={
          <Empty>
            No connected models. Open <A href="/providers">Providers</A> and connect OpenRouter or a local provider.
          </Empty>
        }
      >
        <div class="list">
          <For each={grouped()}>
            {([providerId, items]) => (
              <section>
                <div class="row-between" style={{ "margin": "14px 0 8px" }}>
                  <strong>{providerName(providerId)}</strong>
                  <span class="tag">{items.filter((model) => model.enabled).length} enabled</span>
                </div>
                <For each={items}>
                  {(model) => (
                    <div class="list-card">
                      <div class="row-between">
                        <div class="row">
                          <input
                            type="checkbox"
                            checked={model.enabled}
                            title="Show in model picker"
                            onChange={(event) => void toggle(model, event.currentTarget.checked)}
                          />
                          <strong>{model.name}</strong>
                          <span class="mono tiny muted">{model.modelId}</span>
                          <Show when={model.supportsTools}><span class="tag green">tools</span></Show>
                          <Show when={model.reasoning}><span class="tag">reasoning</span></Show>
                          <Show when={model.costInputPerMillion === 0 && model.costOutputPerMillion === 0}>
                            <span class="tag green">free</span>
                          </Show>
                          <Show when={defaultModel.data?.model?.providerId === model.providerId && defaultModel.data?.model?.modelId === model.modelId}>
                            <span class="tag amber">default</span>
                          </Show>
                        </div>
                        <div class="row">
                          <button class="button button-ghost button-small" type="button" onClick={() => void favorite(model)}>
                            {model.favorite ? "Favorited" : "Favorite"}
                          </button>
                          <button class="button button-ghost button-small" type="button" onClick={() => void makeDefault(model)}>Default</button>
                        </div>
                      </div>
                      <div class="mono tiny muted" style={{ "margin-top": "5px" }}>
                        {model.contextWindow.toLocaleString()} context � {model.maxOutputTokens.toLocaleString()} output
                      </div>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
      </Show>
    </PageBody>
  )
}

function ProviderCard(props: { provider: ProviderInfo }) {
  const queryClient = useQueryClient()
  const [apiKey, setApiKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["providers"] }),
      queryClient.invalidateQueries({ queryKey: ["models"] }),
      queryClient.invalidateQueries({ queryKey: ["models-all"] }),
      queryClient.invalidateQueries({ queryKey: ["default-model"] }),
    ])
  }

  const connect = async () => {
    setBusy(true)
    try {
      await api.connectProvider(props.provider.id, apiKey() || undefined)
      setApiKey("")
      await refresh()
      toast.success(`${props.provider.name} connected`)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const refreshCatalog = async () => {
    setBusy(true)
    try {
      await api.refreshProvider(props.provider.id)
      await refresh()
      toast.success(`${props.provider.name} catalog refreshed`)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (credentialId: string) => {
    try {
      await api.removeProviderCredential(props.provider.id, credentialId)
      await refresh()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <div class="list-card">
      <div class="row-between">
        <div class="row">
          <strong>{props.provider.name}</strong>
          <span class={`tag ${props.provider.connected ? "green" : ""}`}>
            {props.provider.connected ? `connected � ${props.provider.source}` : "not connected"}
          </span>
          <span class="tag">{props.provider.modelCount} models</span>
          <span class="mono tiny muted">{props.provider.baseUrl}</span>
        </div>
        <button class="button button-ghost button-small" type="button" onClick={() => void refreshCatalog()} disabled={busy()}>
          Refresh catalog
        </button>
      </div>
      <Show when={props.provider.environment.length > 0}>
        <div class="tiny muted" style={{ "margin-top": "6px" }}>
          Environment: {props.provider.environment.join(", ")}
        </div>
      </Show>
      <Show when={props.provider.credentials.length > 0}>
        <div class="list" style={{ "margin-top": "8px" }}>
          <For each={props.provider.credentials}>
            {(credential) => (
              <div class="row-between">
                <span class="mono tiny">{credential.label}{credential.active ? " � active" : ""}</span>
                <button class="icon-button" type="button" onClick={() => void remove(credential.id)} title="Remove credential">
                  <Icon name="trash" size={12} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="form-row" style={{ "margin-top": "10px" }}>
        <input
          class="form-input"
          type="password"
          value={apiKey()}
          onInput={(event) => setApiKey(event.currentTarget.value)}
          placeholder={props.provider.environment.length > 0 ? `API key (blank uses ${props.provider.environment[0]})` : "API key"}
        />
        <button class="button button-primary button-small" type="button" onClick={() => void connect()} disabled={busy()}>
          {props.provider.connected ? "Add credential" : "Connect"}
        </button>
      </div>
    </div>
  )
}

export function ProvidersPage() {
  const providers = useQuery(() => ({ queryKey: ["providers"], queryFn: api.providers }))
  return (
    <PageBody>
      <PageHeader title="Providers" subtitle="Connect a provider once, then choose any of its models per session." />
      <Show when={providers.data} fallback={<Empty>Loading providers�</Empty>}>
        <div class="list">
          <For each={providers.data?.providers ?? []}>
            {(provider) => <ProviderCard provider={provider} />}
          </For>
        </div>
      </Show>
    </PageBody>
  )
}
export function SettingsPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const info = useQuery(() => ({ queryKey: ["info"], queryFn: api.info }))
  const [theme, setTheme] = createSignal<ThemePreference>(getThemePreference())
  const [rotated, setRotated] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [installPrompt, setInstallPrompt] = createSignal<Event & { prompt?: () => Promise<void> }>()

  onMount(() => {
    const listener = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as Event & { prompt: () => Promise<void> })
    }
    window.addEventListener("beforeinstallprompt", listener)
    onCleanup(() => window.removeEventListener("beforeinstallprompt", listener))
  })

  const changeTheme = (value: ThemePreference) => {
    setTheme(value)
    applyTheme(value)
  }

  const rotate = async () => {
    setBusy(true)
    try {
      const result = await api.rotate()
      setRotated(result.password)
      toast.success("Password rotated. Save it now, then sign out.")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    try {
      await api.logout()
    } finally {
      await queryClient.clear()
      navigate("/login", { replace: true })
    }
  }

  return (
    <PageBody>
      <PageHeader title="Settings" subtitle="Service, appearance, security, and install state." />
      <div class="form-grid">
        <div class="list-card">
          <div class="list-card-title bold">Service</div>
          <div class="stat-grid" style={{ "margin-top": "12px" }}>
            <div><span class="stat-label">Version</span><span class="stat-value">{info.data?.version ?? "—"}</span></div>
            <div><span class="stat-label">Phase</span><span class="stat-value">{info.data?.phase ?? "—"}</span></div>
            <div><span class="stat-label">Status</span><span class="stat-value green">{info.data?.status ?? "—"}</span></div>
            <div><span class="stat-label">Capabilities</span><span class="stat-value">{info.data?.capabilities?.length ?? 0}</span></div>
          </div>
        </div>
        <div class="list-card">
          <div class="bold">Appearance</div>
          <div class="small muted" style={{ "margin-top": "4px" }}>System follows the operating system.</div>
          <select class="form-select" value={theme()} onChange={(event) => changeTheme(event.currentTarget.value as ThemePreference)} style={{ "margin-top": "10px" }}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <div class="list-card">
          <div class="bold">Security</div>
          <div class="small muted" style={{ "margin-top": "4px" }}>Rotation signs out every session, including remote devices.</div>
          <div class="row" style={{ "margin-top": "10px" }}>
            <button class="button button-secondary button-small" type="button" onClick={() => void rotate()} disabled={busy()}>
              Rotate password
            </button>
            <button class="button button-ghost button-small" type="button" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
          <Show when={rotated()}>
            <div class="banner banner-warn" style={{ "margin-top": "10px" }}>
              New password: <span class="mono">{rotated()}</span> — save it now.
            </div>
          </Show>
        </div>
        <div class="list-card">
          <div class="bold">Install</div>
          <div class="small muted" style={{ "margin-top": "4px" }}>Install the PWA for a standalone window.</div>
          <Show when={installPrompt()} fallback={<div class="tiny faint" style={{ "margin-top": "8px" }}>Use the browser install menu if available.</div>}>
            <button class="button button-secondary button-small" type="button" style={{ "margin-top": "10px" }} onClick={() => void installPrompt()?.prompt?.()}>
              Install Agent-1
            </button>
          </Show>
        </div>
      </div>
    </PageBody>
  )
}
