import { For, Show, createMemo, createSignal } from "solid-js"
import DOMPurify from "dompurify"
import { marked } from "marked"
import { Icon } from "./icons"
import type { Approval, ModelProfile, ToolInfo } from "./api"

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value).getTime()
  if (!Number.isFinite(date)) return "—"
  const seconds = Math.max(0, Math.floor((Date.now() - date) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export function shortHash(value: string | null | undefined, length = 12): string {
  return value ? `${value.slice(0, length)}…` : "—"
}

export function statusColor(status: string): string {
  if (status === "completed") return "green"
  if (status === "waiting_approval" || status === "pending") return "amber"
  if (status === "failed" || status === "rejected" || status === "expired") return "red"
  if (status === "running" || status === "queued") return "blue"
  return "muted"
}

export function Markdown(props: { content: string }) {
  const html = createMemo(() => {
    try {
      const rendered = marked.parse(props.content, { async: false, gfm: true, breaks: true })
      return DOMPurify.sanitize(typeof rendered === "string" ? rendered : "")
    } catch {
      return DOMPurify.sanitize(props.content)
    }
  })
  return <div class="markdown" innerHTML={html()} />
}

export function Spinner() {
  return <span class="spinner" aria-label="Loading" />
}

export function PageHeader(props: { title: string; subtitle?: string; children?: unknown }) {
  return (
    <div class="page-header">
      <div>
        <h1 class="page-title">{props.title}</h1>
        <Show when={props.subtitle}>
          <p class="page-subtitle">{props.subtitle}</p>
        </Show>
      </div>
      <div class="row">{props.children as never}</div>
    </div>
  )
}

export function Empty(props: { children: unknown }) {
  return <div class="empty">{props.children as never}</div>
}

export function Banner(props: { kind?: "error" | "warn"; children: unknown }) {
  return (
    <div class={`banner ${props.kind === "error" ? "banner-error" : props.kind === "warn" ? "banner-warn" : ""}`}>
      {props.children as never}
    </div>
  )
}

export function Composer(props: {
  onSubmit: (text: string) => void | Promise<void>
  onStop?: () => void
  busy?: boolean
  disabled?: boolean
  models: ModelProfile[]
  modelId?: string
  onModel?: (id: string) => void
  placeholder?: string
  compact?: boolean
}) {
  const [value, setValue] = createSignal("")
  let textarea: HTMLTextAreaElement | undefined

  const submit = async () => {
    const text = value().trim()
    if (!text || props.busy || props.disabled) return
    setValue("")
    await props.onSubmit(text)
    textarea?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <div class="composer-wrap">
      <div class="composer">
        <textarea
          ref={textarea}
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={props.placeholder ?? "Ask anything, / for commands, @ for context…"}
          disabled={props.disabled}
          rows={props.compact ? 2 : 3}
        />
        <div class="composer-footer">
          <button class="composer-control" type="button" title="Add context" disabled={props.disabled}>
            <Icon name="plus" size={14} />
          </button>
          <span class="composer-control" title="Agent-1 one mode">
            Agent
          </span>
          <select
            class="composer-control"
            value={props.modelId ?? ""}
            onChange={(event) => props.onModel?.(event.currentTarget.value)}
            disabled={props.disabled || props.models.length === 0}
            title="Model"
          >
            <Show when={props.models.length === 0}>
              <option value="">No model</option>
            </Show>
            <For each={props.models}>
              {(model) => <option value={model.id}>{model.name}</option>}
            </For>
          </select>
          <div class="composer-spacer" />
          <Show
            when={props.busy}
            fallback={
              <button
                class={`send-button ${value().trim() ? "ready" : ""}`}
                type="button"
                onClick={() => void submit()}
                disabled={props.disabled || !value().trim()}
                title="Send"
              >
                <Icon name="send" size={15} />
              </button>
            }
          >
            <button class="send-button stop" type="button" onClick={props.onStop} title="Stop">
              <Icon name="stop" size={13} />
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}

export function ApprovalCard(props: {
  approval: Approval
  onDecide: (decision: "approve" | "reject") => void | Promise<void>
  busy?: boolean
  compact?: boolean
}) {
  const [showArgs, setShowArgs] = createSignal(false)
  const args = createMemo(() => JSON.stringify(props.approval.arguments ?? {}, null, 2))
  return (
    <div class="approval-card">
      <div class="approval-head">
        <Icon name="approvals" size={14} />
        <span>Approval required</span>
        <span class="tag">{props.approval.toolName}</span>
        <div class="grow" />
        <span class="tiny faint">{formatDate(props.approval.expiresAt)}</span>
      </div>
      <div class="approval-args">
        {showArgs() ? args() : `${args().slice(0, 220)}${args().length > 220 ? "…" : ""}`}
      </div>
      <div class="row" style={{ "margin-top": "8px" }}>
        <button class="button button-ghost button-small" type="button" onClick={() => setShowArgs((v) => !v)}>
          {showArgs() ? "Hide arguments" : "Show arguments"}
        </button>
        <span class="tiny faint mono">{shortHash(props.approval.argumentsHash)}</span>
        <div class="grow" />
        <button
          class="button button-secondary button-small"
          type="button"
          disabled={props.busy}
          onClick={() => void props.onDecide("reject")}
        >
          Reject
        </button>
        <button
          class="button button-primary button-small"
          type="button"
          disabled={props.busy}
          onClick={() => void props.onDecide("approve")}
        >
          Approve
        </button>
      </div>
    </div>
  )
}

export function ToolMessage(props: { text: string; content?: unknown }) {
  return (
    <div class="message-tool">
      <div class="tool-line">
        <span class="tool-badge">tool</span>
        <span class="mono">{props.text.slice(0, 220)}</span>
      </div>
    </div>
  )
}

export function ToolList(props: { tools: ToolInfo[] }) {
  return (
    <div class="list">
      <For each={props.tools}>
        {(tool) => (
          <div class="list-card">
            <div class="row-between">
              <div class="row">
                <span class="mono small">{tool.name}</span>
                <span class="tag">{tool.risk}</span>
                <span class="tag">{tool.action}</span>
              </div>
              <span class="tiny faint">{tool.readOnly ? "read-only" : "approval-gated"}</span>
            </div>
            <div class="small muted" style={{ "margin-top": "5px" }}>
              {tool.description}
            </div>
          </div>
        )}
      </For>
    </div>
  )
}
