import { A, useNavigate } from "@solidjs/router"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { toast } from "solid-sonner"
import { api, modelKey, parseModelKey, type Session } from "./api"
import { Icon } from "./icons"
import { AgentOneWordmark } from "./wordmark"
import { Composer, timeAgo, type ComposerFile } from "./ui"

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

export function HomePage() {
  const navigate = useNavigate()
  const [search, setSearch] = createSignal("")
  const sessions = useQuery(() => ({ queryKey: ["sessions"], queryFn: api.sessions }))
  const groups = createMemo(() => groupSessions(sessions.data?.sessions ?? [], search()))

  const newSession = () => navigate("/new")

  return (
    <div class="home-panel">
      <div class="home-scroll">
        <div class="home-grid">
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
                  <span>Start a conversation with Agent-1. Reads and searches run freely; file changes are checkpointed and dangerous actions follow the approval policy.</span>
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
  const [selectedEffort, setSelectedEffort] = createSignal<string | null>(null)
  const models = useQuery(() => ({ queryKey: ["models"], queryFn: () => api.models() }))
  const defaultModel = useQuery(() => ({ queryKey: ["default-model"], queryFn: api.defaultModel }))

  createEffect(() => {
    const preferred = defaultModel.data?.model ?? models.data?.models?.[0]
    if (!selectedModel() && preferred) setSelectedModel(modelKey(preferred))
  })

  const changeModel = (value: string) => {
    setSelectedModel(value)
    setSelectedEffort(null)
  }

  const send = async (text: string, files: ComposerFile[]) => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await api.createSession(text.slice(0, 70) || "Attachment")
      await queryClient.invalidateQueries({ queryKey: ["sessions"] })
      try {
        const selection = parseModelKey(selectedModel())
        const started = await api.startMessage(
          result.session.id,
          text,
          selection ? { ...selection, reasoningEffort: selectedEffort() } : undefined,
          files,
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
    <div class="new-session-page">
      <div class="new-session-content">
        <AgentOneWordmark class="new-session-wordmark" />
        <div class="new-session-composer">
          <Composer
            onSubmit={send}
            busy={busy()}
            models={models.data?.models ?? []}
            modelId={selectedModel()}
            onModel={changeModel}
            reasoningEffort={selectedEffort()}
            onReasoningEffort={setSelectedEffort}
            placeholder="Ask Agent-1 anything…"
          />
          <div class="new-session-project">
            <Icon name="folder" size={13} />
            <span>Local files use the Agent-1 path policy. Writes are checkpointed.</span>
          </div>
        </div>
        <div class="new-session-hint">
          Reads and searches run freely. File changes are checkpointed; dangerous actions follow the approval policy.
        </div>
      </div>
    </div>
  )
}
