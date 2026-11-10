import { A, useNavigate } from "@solidjs/router"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { toast } from "solid-sonner"
import { api, type Session, type Workspace } from "./api"
import { Icon } from "./icons"
import { AgentOneWordmark } from "./wordmark"
import { Composer, timeAgo } from "./ui"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function groupSessions(sessions: Session[], search: string): Array<{ label: string; items: Session[] }> {
  const query = search.trim().toLowerCase()
  const filtered = query
    ? sessions.filter((session) => session.title.toLowerCase().includes(query))
    : sessions
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const startOfWeek = startOfToday - 7 * 86_400_000
  const groups: Array<{ label: string; items: Session[] }> = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] },
  ]

  for (const session of [...filtered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    const time = Date.parse(session.updatedAt)
    if (time >= startOfToday) groups[0]!.items.push(session)
    else if (time >= startOfYesterday) groups[1]!.items.push(session)
    else if (time >= startOfWeek) groups[2]!.items.push(session)
    else groups[3]!.items.push(session)
  }

  return groups.filter((group) => group.items.length > 0)
}

function WorkspaceSidebar(props: {
  workspaces: Workspace[]
  selected: string | undefined
  onSelect: (id: string | undefined) => void
}) {
  return (
    <aside class="home-projects">
      <div class="home-projects-header">
        <span>Workspaces</span>
        <A class="icon-button" href="/workspaces" title="Manage workspaces">
          <Icon name="plus" size={13} />
        </A>
      </div>
      <div class="home-project-list">
        <button
          class="home-project-row"
          data-selected={props.selected === undefined ? "" : undefined}
          type="button"
          onClick={() => props.onSelect(undefined)}
        >
          <Icon name="folder" size={14} />
          <span class="label">All sessions</span>
        </button>
        <For each={props.workspaces}>
          {(workspace) => (
            <button
              class="home-project-row"
              data-selected={props.selected === workspace.id ? "" : undefined}
              type="button"
              onClick={() => props.onSelect(workspace.id)}
              title={workspace.path}
            >
              <Icon name="folder" size={14} />
              <span class="label">{workspace.label}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.workspaces.length === 0}>
        <div class="home-project-empty">
          No workspace grants yet.
          <div>
            <A href="/workspaces">Add a folder</A>
          </div>
        </div>
      </Show>
      <div class="home-utility">
        <A href="/approvals">
          <Icon name="approvals" size={13} /> Approvals
        </A>
        <A href="/settings">
          <Icon name="settings" size={13} /> Settings
        </A>
      </div>
    </aside>
  )
}

export function HomePage() {
  const navigate = useNavigate()
  const [search, setSearch] = createSignal("")
  const [selectedWorkspace, setSelectedWorkspace] = createSignal<string>()
  const sessions = useQuery(() => ({ queryKey: ["sessions"], queryFn: api.sessions }))
  const workspaces = useQuery(() => ({ queryKey: ["workspaces"], queryFn: api.workspaces }))
  const groups = createMemo(() => groupSessions(sessions.data?.sessions ?? [], search()))

  const newSession = () => navigate("/new")

  return (
    <div class="home-panel">
      <div class="home-scroll">
        <div class="home-grid">
          <div class="home-mobile-project">
            <select
              class="form-select"
              value={selectedWorkspace() ?? ""}
              onChange={(event) => setSelectedWorkspace(event.currentTarget.value || undefined)}
            >
              <option value="">All workspaces</option>
              <For each={workspaces.data?.workspaces ?? []}>
                {(workspace) => <option value={workspace.id}>{workspace.label}</option>}
              </For>
            </select>
          </div>
          <WorkspaceSidebar
            workspaces={workspaces.data?.workspaces ?? []}
            selected={selectedWorkspace()}
            onSelect={setSelectedWorkspace}
          />
          <section class="home-sessions">
            <div class="home-sessions-head">
              <h1>Sessions</h1>
              <div class="home-search">
                <Icon name="search" size={12} />
                <input
                  class="input"
                  type="search"
                  placeholder="Search sessions"
                  value={search()}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                />
              </div>
              <button class="home-new" type="button" onClick={newSession}>
                <Icon name="plus" size={12} />
                <span class="label">New session</span>
              </button>
            </div>

            <Show
              when={groups().length > 0}
              fallback={
                <div class="home-empty">
                  <strong style={{ "font-weight": "530" }}>No sessions yet</strong>
                  <span>Start a conversation with Agent-1. Reads and searches run freely; side effects ask first.</span>
                  <button class="button button-primary button-small" type="button" onClick={newSession}>
                    New session
                  </button>
                </div>
              }
            >
              <For each={groups()}>
                {(group) => (
                  <div class="home-session-group">
                    <h2>{group.label}</h2>
                    <For each={group.items}>
                      {(session) => (
                        <A class="home-session-row" href={`/sessions/${encodeURIComponent(session.id)}`}>
                          <Icon name="journal" size={14} />
                          <span class="session-name">{session.title}</span>
                          <span class="session-meta">{timeAgo(session.updatedAt)}</span>
                        </A>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </section>
        </div>
      </div>
    </div>
  )
}

export function NewSessionPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [busy, setBusy] = createSignal(false)
  const [selectedModel, setSelectedModel] = createSignal("")
  const [selectedWorkspace, setSelectedWorkspace] = createSignal("")
  const models = useQuery(() => ({ queryKey: ["models"], queryFn: api.models }))
  const workspaces = useQuery(() => ({ queryKey: ["workspaces"], queryFn: api.workspaces }))

  createEffect(() => {
    if (!selectedModel() && models.data?.profiles?.[0]) setSelectedModel(models.data.profiles[0].id)
  })

  const send = async (text: string) => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await api.createSession(text.slice(0, 70))
      await queryClient.invalidateQueries({ queryKey: ["sessions"] })
      try {
        const started = await api.startMessage(result.session.id, text, selectedModel() || undefined)
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
    <div class="new-session-page">
      <div class="new-session-content">
        <AgentOneWordmark class="new-session-wordmark" />
        <div class="new-session-composer">
          <Composer
            onSubmit={send}
            busy={busy()}
            models={models.data?.profiles ?? []}
            modelId={selectedModel()}
            onModel={setSelectedModel}
            placeholder="Ask Agent-1 anything…"
          />
          <div class="new-session-project">
            <Icon name="folder" size={13} />
            <span>Workspace</span>
            <select
              class="composer-control"
              value={selectedWorkspace()}
              onChange={(event) => setSelectedWorkspace(event.currentTarget.value)}
            >
              <option value="">Agent-1 local</option>
              <For each={workspaces.data?.workspaces ?? []}>
                {(workspace) => <option value={workspace.id}>{workspace.label}</option>}
              </For>
            </select>
          </div>
        </div>
        <div class="new-session-hint">
          Reads and searches run freely. Writes, shell commands, and external actions ask first.
        </div>
      </div>
    </div>
  )
}
