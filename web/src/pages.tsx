import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { A, useLocation, useNavigate, useParams } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { toast } from "solid-sonner"
import {
  api,
  streamTurn,
  type Approval,
  type ContextInfo,
  type JournalEntry,
  type Message,
  type ModelProfile,
  type Session,
  type Workspace,
} from "./api"
import { Icon } from "./icons"
import { ApprovalCard, Banner, Composer, Empty, Markdown, PageHeader, formatDate, shortHash, statusColor, timeAgo } from "./ui"
import { applyTheme, getThemePreference, type ThemePreference } from "./theme"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function PageBody(props: { children?: unknown }) {
  return <div class="page-scroll">{props.children as never}</div>
}

/* ------------------------------------------------------------------ home */

export function SessionsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [title, setTitle] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [selectedModel, setSelectedModel] = createSignal("")
  const sessions = useQuery(() => ({ queryKey: ["sessions"], queryFn: api.sessions }))
  const models = useQuery(() => ({ queryKey: ["models"], queryFn: api.models }))

  createEffect(() => {
    if (!selectedModel() && models.data?.profiles?.[0]) setSelectedModel(models.data.profiles[0].id)
  })

  const create = async () => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await api.createSession(title().trim() || undefined)
      setTitle("")
      await queryClient.invalidateQueries({ queryKey: ["sessions"] })
      navigate(`/sessions/${encodeURIComponent(result.session.id)}`)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const send = async (text: string) => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await api.createSession(text.slice(0, 70))
      await queryClient.invalidateQueries({ queryKey: ["sessions"] })
      try {
        const started = await api.startMessage(
          result.session.id,
          text,
          selectedModel() || undefined,
        )
        navigate(`/sessions/${encodeURIComponent(result.session.id)}?turn=${encodeURIComponent(started.turn.id)}`)
      } catch (error) {
        toast.error(errorMessage(error))
        navigate(`/sessions/${encodeURIComponent(result.session.id)}`)
      }
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="home">
      <div class="home-wordmark">Agent-1</div>
      <div class="home-inner">
        <Composer
          onSubmit={send}
          busy={busy()}
          models={models.data?.profiles ?? []}
          modelId={selectedModel()}
          onModel={setSelectedModel}
          placeholder="Ask anything, / for commands, @ for context…"
          compact
        />
        <div class="home-meta">
          <span class="pill">
            <Icon name="model" size={11} /> Agent-1
          </span>
          <span class="pill">{models.data?.profiles?.[0]?.name ?? "No model configured"}</span>
          <span class="pill">
            <Icon name="folder" size={11} /> Local
          </span>
        </div>
        <div class="row" style={{ "margin-top": "12px", "justify-content": "center" }}>
          <button class="button button-ghost button-small" type="button" onClick={() => void create()}>
            <Icon name="plus" size={13} /> New session
          </button>
        </div>
        <Show when={(sessions.data?.sessions.length ?? 0) > 0}>
          <div class="recent-grid">
            <For each={sessions.data?.sessions.slice(0, 6)}>
              {(session) => (
                <A href={`/sessions/${encodeURIComponent(session.id)}`} class="recent-card">
                  <span class="recent-title">{session.title}</span>
                  <span class="recent-meta">
                    {timeAgo(session.updatedAt)} · {session.id.slice(0, 10)}
                  </span>
                </A>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ session */

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
              <span class="stat-value">{context().model?.kind ?? "—"}</span>
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
  const [treePath, setTreePath] = createSignal<string>()
  const [selectedFile, setSelectedFile] = createSignal<string>()

  createEffect(() => {
    const list = workspaces.data?.workspaces ?? []
    if (!workspaceId() && list[0]) setWorkspaceId(list[0].id)
  })

  const tree = useQuery(() => ({
    queryKey: ["tree", workspaceId(), treePath()],
    queryFn: () => api.workspaceTree(workspaceId()!, treePath()),
    enabled: Boolean(workspaceId()),
  }))
  const file = useQuery(() => ({
    queryKey: ["file", workspaceId(), selectedFile()],
    queryFn: () => api.workspaceFile(workspaceId()!, selectedFile()!),
    enabled: Boolean(workspaceId() && selectedFile()),
  }))

  const selectedWorkspace = () => workspaces.data?.workspaces.find((workspace) => workspace.id === workspaceId())
  const parentPath = (value: string) => {
    const root = selectedWorkspace()?.path ?? ""
    const parent = value.replace(/[\\/][^\\/]+$/, "")
    return parent.startsWith(root) ? parent : root
  }

  return (
    <div>
      <Show when={(workspaces.data?.workspaces.length ?? 0) > 0} fallback={<Empty>No workspace grants. Add one in Workspaces.</Empty>}>
        <select
          class="form-select"
          value={workspaceId() ?? ""}
          onChange={(event) => {
            setWorkspaceId(event.currentTarget.value)
            setTreePath(undefined)
            setSelectedFile(undefined)
          }}
        >
          <For each={workspaces.data?.workspaces}>
            {(workspace) => <option value={workspace.id}>{workspace.label} · {workspace.access}</option>}
          </For>
        </select>
        <div class="row" style={{ "margin-top": "10px" }}>
          <button
            class="button button-ghost button-small"
            type="button"
            onClick={() => {
              const path = tree.data?.path
              if (path) setTreePath(parentPath(path))
            }}
          >
            <Icon name="back" size={12} /> Up
          </button>
          <span class="tiny faint truncate mono">{tree.data?.path ?? selectedWorkspace()?.path}</span>
        </div>
        <div class="tree" style={{ "margin-top": "8px" }}>
          <For each={tree.data?.entries ?? []}>
            {(entry) => (
              <button
                class={`tree-entry ${selectedFile() === entry.path ? "active" : ""}`}
                type="button"
                onClick={() => entry.type === "directory" ? (setTreePath(entry.path), setSelectedFile(undefined)) : setSelectedFile(entry.path)}
              >
                <Icon name={entry.type === "directory" ? "folder" : "file"} size={12} />
                <span class="truncate">{entry.name}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={file.data}>
          {(content) => (
            <pre class="file-preview">
              {content().content.slice(0, 40_000)}
            </pre>
          )}
        </Show>
      </Show>
    </div>
  )
}

function JournalList(props: { entries: JournalEntry[]; onUndo: (batchId: string) => void }) {
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

export function SessionPage() {
  const params = useParams<{ id: string }>()
  const location = useLocation()
  const id = () => params.id ?? ""
  const queryClient = useQueryClient()
  const [sideTab, setSideTab] = createSignal<"review" | "context" | "files">("review")
  const [sideOpen, setSideOpen] = createSignal(typeof window === "undefined" ? true : window.innerWidth >= 860)
  const [busy, setBusy] = createSignal(false)
  const [liveText, setLiveText] = createSignal("")
  const [liveTurnId, setLiveTurnId] = createSignal<string>()
  const [turnError, setTurnError] = createSignal<string>()
  const [selectedModel, setSelectedModel] = createSignal<string>()
  let stream: { abort(): void } | undefined
  let messagesEl: HTMLDivElement | undefined

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
  const models = useQuery(() => ({ queryKey: ["models"], queryFn: api.models }))

  const session = () => sessions.data?.sessions.find((item) => item.id === id())
  const sessionApprovals = () => (approvals.data?.approvals ?? []).filter((approval) => approval.sessionId === id())
  const pendingApprovals = () => sessionApprovals().filter((approval) => approval.status === "pending")
  const sessionJournal = () => (journal.data?.entries ?? []).filter((entry) => entry.sessionId === id())

  createEffect(() => {
    const model = session()?.modelProfileId ?? models.data?.profiles?.[0]?.id
    if (model && !selectedModel()) setSelectedModel(model)
  })

  createEffect(() => {
    void messages.data?.messages.length
    void liveText()
    void pendingApprovals().length
    queueMicrotask(() => {
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight
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
    try {
      const started = await api.startMessage(id(), text, selectedModel() || undefined)
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
      <div class="session-top">
        <button class="icon-button drawer-toggle" type="button" onClick={() => setSideOpen((value) => !value)}>
          <Icon name="panel" size={15} />
        </button>
        <Icon name="approvals" size={14} />
        <span class="session-title">{session()?.title ?? "Session"}</span>
        <div class="session-top-spacer" />
        <Show when={busy()}>
          <span class="tag amber">working</span>
        </Show>
        <Show when={pendingApprovals().length > 0}>
          <span class="tag amber">{pendingApprovals().length} approval</span>
        </Show>
        <button class="icon-button" type="button" onClick={() => setSideOpen((value) => !value)} title="Toggle panel">
          <Icon name="panel" size={15} />
        </button>
      </div>
      <div class="session-body">
        <div class="chat-pane">
          <div class="messages" ref={messagesEl}>
            <div class="messages-inner">
              <Show when={(messages.data?.messages.length ?? 0) === 0 && !busy()}>
                <Empty>
                  <div>
                    <div class="bold" style={{ color: "var(--text-soft)", "margin-bottom": "6px" }}>
                      Start a conversation
                    </div>
                    <div>Ask Agent-1 to inspect a folder, research something, or prepare an approval-gated action.</div>
                  </div>
                </Empty>
              </Show>
              <For each={messages.data?.messages ?? []}>{(message) => <MessageView message={message} />}</For>
              <Show when={liveText()}>
                <div class="message message-assistant">
                  <div class="message-meta">assistant</div>
                  <div class="message-live">
                    {liveText()}
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
          <Composer
            onSubmit={send}
            onStop={() => void stop()}
            busy={busy()}
            models={models.data?.profiles ?? []}
            modelId={selectedModel()}
            onModel={setSelectedModel}
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

export function ModelsPage() {
  const queryClient = useQueryClient()
  const models = useQuery(() => ({ queryKey: ["models"], queryFn: api.models }))
  const [name, setName] = createSignal("")
  const [kind, setKind] = createSignal<"cloud" | "local">("local")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [modelId, setModelId] = createSignal("")
  const [apiKey, setApiKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const add = async () => {
    if (!name() || !baseUrl() || !modelId()) return
    setBusy(true)
    try {
      await api.createModel({
        name: name(),
        kind: kind(),
        baseUrl: baseUrl(),
        modelId: modelId(),
        ...(apiKey() ? { apiKey: apiKey() } : {}),
      })
      setName("")
      setBaseUrl("")
      setModelId("")
      setApiKey("")
      await queryClient.invalidateQueries({ queryKey: ["models"] })
      toast.success("Model profile created")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const test = async (profile: ModelProfile) => {
    try {
      const result = await api.testModel(profile.id)
      toast.success(`Model test OK · tools ${result.supportsTools ? "yes" : "no"} · ${result.latencyMs}ms`)
      await queryClient.invalidateQueries({ queryKey: ["models"] })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const makeDefault = async (profile: ModelProfile) => {
    try {
      await api.setDefaultModel(profile.id)
      await queryClient.invalidateQueries({ queryKey: ["models"] })
      toast.success(`${profile.name} is now the default`)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const remove = async (profile: ModelProfile) => {
    try {
      await api.removeModel(profile.id)
      await queryClient.invalidateQueries({ queryKey: ["models"] })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <PageBody>
      <PageHeader title="Models" subtitle="Cloud and local OpenAI-compatible profiles. Keys stay in DPAPI." />
      <div class="form-grid" style={{ "margin-bottom": "24px" }}>
        <div class="form-row">
          <div><label class="form-label">Name</label><input class="form-input" value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder="Local Ollama" /></div>
          <div>
            <label class="form-label">Kind</label>
            <select class="form-select" value={kind()} onChange={(event) => setKind(event.currentTarget.value as "cloud" | "local")}>
              <option value="local">Local</option>
              <option value="cloud">Cloud</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div><label class="form-label">Base URL</label><input class="form-input" value={baseUrl()} onInput={(event) => setBaseUrl(event.currentTarget.value)} placeholder="http://127.0.0.1:11434/v1" /></div>
          <div><label class="form-label">Model ID</label><input class="form-input" value={modelId()} onInput={(event) => setModelId(event.currentTarget.value)} placeholder="llama3.2" /></div>
        </div>
        <div><label class="form-label">API key (optional for local)</label><input class="form-input" type="password" value={apiKey()} onInput={(event) => setApiKey(event.currentTarget.value)} placeholder="sk-…" /></div>
        <button class="button button-primary" type="button" onClick={() => void add()} disabled={busy() || !name() || !baseUrl() || !modelId()}>Add model</button>
      </div>
      <div class="list">
        <For each={models.data?.profiles ?? []}>
          {(profile) => (
            <div class="list-card">
              <div class="row-between">
                <div class="row">
                  <span class="tag">{profile.kind}</span>
                  <strong>{profile.name}</strong>
                  <span class="mono tiny muted">{profile.modelId}</span>
                  <Show when={profile.supportsTools}><span class="tag green">tools</span></Show>
                  <Show when={profile.hasApiKey}><span class="tag"><Icon name="key" size={10} /> key</span></Show>
                </div>
                <div class="row">
                  <button class="button button-secondary button-small" type="button" onClick={() => void test(profile)}>Test</button>
                  <button class="button button-ghost button-small" type="button" onClick={() => void makeDefault(profile)}>Default</button>
                  <button class="icon-button" type="button" onClick={() => void remove(profile)}><Icon name="trash" size={13} /></button>
                </div>
              </div>
              <div class="mono tiny muted" style={{ "margin-top": "5px" }}>{profile.baseUrl}</div>
            </div>
          )}
        </For>
      </div>
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
