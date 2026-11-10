import { For, Show, createMemo, createSignal } from "solid-js"
import { A } from "@solidjs/router"
import { Popover } from "@kobalte/core/popover"
import DOMPurify from "dompurify"
import { marked } from "marked"
import { Icon } from "./icons"
import type { Approval, CatalogModel, ToolInfo } from "./api"

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

export function Markdown(props: { content: string; streaming?: boolean }) {
  const html = createMemo(() => {
    try {
      const rendered = marked.parse(props.content, { async: false, gfm: true, breaks: true })
      return DOMPurify.sanitize(typeof rendered === "string" ? rendered : "")
    } catch {
      return DOMPurify.sanitize(props.content)
    }
  })
  return (
    <div
      class="markdown-content"
      data-component="markdown"
      data-streaming={props.streaming ? "" : undefined}
      data-markdown-ready=""
      innerHTML={html()}
    />
  )
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

function ModelPicker(props: {
  models: CatalogModel[]
  value?: string
  onChange?: (value: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal("")
  let searchInput: HTMLInputElement | undefined

  const key = (model: CatalogModel) => `${model.providerId}/${model.modelId}`
  const selected = () => props.models.find((model) => key(model) === props.value)
  const filtered = () => {
    const search = query().trim().toLowerCase()
    return props.models.filter(
      (model) =>
        !search ||
        `${model.name} ${model.modelId} ${model.providerId}`.toLowerCase().includes(search),
    )
  }
  const groups = createMemo(() => {
    const map = new Map<string, CatalogModel[]>()
    for (const model of filtered()) {
      const group = map.get(model.providerId) ?? []
      group.push(model)
      map.set(model.providerId, group)
    }
    return [...map.entries()]
  })
  const activeModel = () => filtered().find((model) => key(model) === active()) ?? selected()

  const reset = () => {
    setQuery("")
    setActive(props.value ?? "")
  }

  const choose = (model: CatalogModel) => {
    props.onChange?.(key(model))
    setOpen(false)
    setQuery("")
  }

  const move = (direction: 1 | -1) => {
    const items = filtered()
    if (items.length === 0) return
    const index = items.findIndex((model) => key(model) === active())
    const next =
      index === -1
        ? direction === 1
          ? 0
          : items.length - 1
        : (index + direction + items.length) % items.length
    const model = items[next]
    if (model) setActive(key(model))
  }

  return (
    <Popover
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) reset()
      }}
      placement="top-start"
      gutter={8}
    >
      <div class="composer-control model-picker">
        <Popover.Trigger
          type="button"
          class="model-picker-trigger"
          disabled={props.disabled || props.models.length === 0}
        >
          {selected()?.name ?? "No model"} <span class="model-picker-caret" aria-hidden="true" />
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Content class="model-picker-popover" aria-label="Select model">
          <div class="model-picker-main">
            <input
              class="form-input model-picker-search"
              value={query()}
              onInput={(event) => {
                setQuery(event.currentTarget.value)
                setActive(filtered()[0] ? key(filtered()[0]!) : "")
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  move(1)
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  move(-1)
                } else if (event.key === "Enter") {
                  const model = filtered().find((item) => key(item) === active())
                  if (model) {
                    event.preventDefault()
                    choose(model)
                  }
                } else if (event.key === "Escape") {
                  event.preventDefault()
                  setOpen(false)
                }
              }}
              placeholder="Search models"
              aria-label="Search models"
              ref={(element) => {
                searchInput = element
                queueMicrotask(() => element.focus())
              }}
            />
            <div class="model-picker-results">
              <Show when={groups().length > 0} fallback={<div class="model-picker-empty">No matching models</div>}>
                <For each={groups()}>
                  {([providerId, models]) => (
                    <div class="model-picker-group">
                      <div class="model-picker-provider">{providerId}</div>
                      <For each={models}>
                        {(model) => (
                          <button
                            type="button"
                            class="model-picker-option"
                            data-active={active() === key(model) ? "" : undefined}
                            data-selected={props.value === key(model) ? "" : undefined}
                            onMouseEnter={() => setActive(key(model))}
                            onClick={() => choose(model)}
                          >
                            <span class="model-picker-check">
                              <Show when={props.value === key(model)}>
                                <Icon name="check" size={13} />
                              </Show>
                            </span>
                            <span class="truncate model-picker-name">{model.name}</span>
                            <span class="model-picker-tags">
                              {model.supportsTools ? <span class="tag green">tools</span> : undefined}
                              {model.costInputPerMillion === 0 && model.costOutputPerMillion === 0 ? (
                                <span class="tag">free</span>
                              ) : undefined}
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </Show>
            </div>
            <A class="model-picker-manage" href="/models" onClick={() => setOpen(false)}>
              <Icon name="settings" size={13} />
              <span>Manage models</span>
            </A>
          </div>
          <Show when={activeModel()} keyed>
            {(model) => (
              <div class="model-picker-detail">
                <div class="model-picker-detail-name">{model.name}</div>
                <dl>
                  <div>
                    <dt>Provider</dt>
                    <dd>{model.providerId}</dd>
                  </div>
                  <div>
                    <dt>Inputs</dt>
                    <dd>{model.inputModalities.join(", ")}</dd>
                  </div>
                  <div>
                    <dt>Reasoning</dt>
                    <dd>{model.reasoning ? "Yes" : "No reasoning"}</dd>
                  </div>
                  <div>
                    <dt>Context</dt>
                    <dd>{model.contextWindow.toLocaleString()}</dd>
                  </div>
                </dl>
              </div>
            )}
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}

function effortLabel(value: string): string {
  if (value === "xhigh") return "Extra high"
  if (value === "minimal") return "Minimal"
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function ReasoningPicker(props: {
  model?: CatalogModel
  value?: string
  onChange?: (value: string | null | undefined) => void
  disabled?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  const efforts = () => {
    const option = props.model?.reasoningOptions.find((item) => item.type === "effort")
    return option?.type === "effort" ? option.values.filter((value) => value !== "none") : []
  }

  return (
    <Show when={efforts().length > 0}>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        placement="top-start"
        gutter={6}
      >
        <div class="composer-control effort-picker">
          <Popover.Trigger
            type="button"
            class="effort-picker-trigger"
            disabled={props.disabled}
            title="Reasoning effort"
          >
            {props.value ? effortLabel(props.value) : "Default"}
            <span class="model-picker-caret" aria-hidden="true" />
          </Popover.Trigger>
        </div>
        <Popover.Portal>
          <Popover.Content class="effort-picker-popover" aria-label="Reasoning effort">
            <button
              type="button"
              class="effort-picker-option"
              data-selected={!props.value ? "" : undefined}
              onClick={() => {
                props.onChange?.(undefined)
                setOpen(false)
              }}
            >
              <span>Default</span>
              <Show when={!props.value}><Icon name="check" size={13} /></Show>
            </button>
            <For each={efforts()}>
              {(effort) => (
                <button
                  type="button"
                  class="effort-picker-option"
                  data-selected={props.value === effort ? "" : undefined}
                  onClick={() => {
                    props.onChange?.(effort)
                    setOpen(false)
                  }}
                >
                  <span>{effortLabel(effort)}</span>
                  <Show when={props.value === effort}><Icon name="check" size={13} /></Show>
                </button>
              )}
            </For>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </Show>
  )
}
export function Composer(props: {
  onSubmit: (text: string) => void | Promise<void>
  onStop?: () => void
  busy?: boolean
  disabled?: boolean
  models: CatalogModel[]
  modelId?: string
  onModel?: (id: string) => void
  reasoningEffort?: string | null
  onReasoningEffort?: (value: string | null | undefined) => void
  placeholder?: string
  compact?: boolean
}) {
  const [value, setValue] = createSignal("")
  const selectedModel = () =>
    props.models.find((model) => `${model.providerId}/${model.modelId}` === props.modelId)
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
      <div class="composer-dock">
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
          <ModelPicker
            models={props.models}
            value={props.modelId}
            onChange={props.onModel}
            disabled={props.disabled}
          />
          <ReasoningPicker
            model={selectedModel()}
            value={props.reasoningEffort ?? undefined}
            onChange={props.onReasoningEffort}
            disabled={props.disabled}
          />
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
              <span class="tiny faint">
                {tool.readOnly ? "read-only" : tool.approvalRequired === false ? "direct" : "approval-gated"}
              </span>
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
