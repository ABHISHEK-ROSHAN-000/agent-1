import { Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { A, useLocation, useNavigate } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { ApiError, api, subscribeEvents } from "./api"
import { Icon, type IconName } from "./icons"
import { Spinner } from "./ui"

const menuItems: Array<{ href: string; icon: IconName; label: string }> = [
  { href: "/approvals", icon: "approvals", label: "Approvals" },
  { href: "/rules", icon: "rules", label: "Rules" },
  { href: "/workspaces", icon: "folder", label: "Workspaces" },
  { href: "/journal", icon: "journal", label: "Journal" },
  { href: "/memory", icon: "memory", label: "Memory" },
  { href: "/providers", icon: "key", label: "Providers" },
  { href: "/models", icon: "model", label: "Models" },
  { href: "/settings", icon: "settings", label: "Settings" },
]

function Splash() {
  return (
    <div class="connect-page">
      <div class="connect-content" style={{ "align-items": "center" }}>
        <div class="connect-hint" style={{ "font-size": "18px", "font-weight": "530" }}>
          Agent-1
        </div>
        <Spinner />
      </div>
    </div>
  )
}

function Shell(props: { children?: unknown; eventSeq?: number }) {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [connection, setConnection] = createSignal("connecting")
  const [online, setOnline] = createSignal(typeof navigator === "undefined" ? true : navigator.onLine)
  const [asleep, setAsleep] = createSignal(false)
  const [updateReady, setUpdateReady] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [variant, setVariant] = createSignal(0)
  const sessionsQuery = useQuery(() => ({
    queryKey: ["sessions"],
    queryFn: api.sessions,
  }))
  const approvalsQuery = useQuery(() => ({
    queryKey: ["approvals"],
    queryFn: () => api.approvals("pending"),
    refetchInterval: 5_000,
  }))

  const activeSessionId = () => {
    const match = /^\/sessions\/([^/]+)$/.exec(location.pathname)
    return match?.[1]
  }

  onMount(() => {
    const stop = subscribeEvents(
      (event) => {
        if (
          event.type.startsWith("turn.") ||
          event.type.startsWith("approval.") ||
          event.type.startsWith("journal.") ||
          event.type === "session.created"
        ) {
          void queryClient.invalidateQueries()
        }
      },
      setConnection,
      props.eventSeq ?? 0,
    )
    const onOnline = () => {
      setOnline(true)
      setAsleep(false)
    }
    const onOffline = () => setOnline(false)
    window.addEventListener("online", onOnline)
    window.addEventListener("offline", onOffline)

    const checkHealth = async () => {
      if (!navigator.onLine) return
      try {
        await api.health()
        setAsleep(false)
      } catch {
        setAsleep(true)
      }
    }
    const healthTimer = setInterval(checkHealth, 20_000)
    void checkHealth()

    let registration: ServiceWorkerRegistration | undefined
    let updateTimer: ReturnType<typeof setInterval> | undefined
    const checkUpdate = async () => {
      try {
        registration = registration ?? (await navigator.serviceWorker?.getRegistration())
        if (!registration) return
        if (registration.waiting) setUpdateReady(true)
        await registration.update()
        if (registration.waiting) setUpdateReady(true)
      } catch {
        // Update checks are best effort.
      }
    }
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.ready.then((ready) => {
        registration = ready
        if (ready.waiting) setUpdateReady(true)
        ready.addEventListener("updatefound", () => {
          const installing = ready.installing
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) setUpdateReady(true)
          })
        })
      })
      void checkUpdate()
      updateTimer = setInterval(checkUpdate, 60_000)
    }

    onCleanup(() => {
      stop()
      window.removeEventListener("online", onOnline)
      window.removeEventListener("offline", onOffline)
      clearInterval(healthTimer)
      if (updateTimer) clearInterval(updateTimer)
    })
  })

  createEffect(() => {
    void location.pathname
    void location.search
    setMenuOpen(false)
    setVariant((value) => value + 1)
  })

  const sessions = () => sessionsQuery.data?.sessions ?? []
  const tabs = () => sessions().slice(0, 8)
  const pending = () => approvalsQuery.data?.approvals.length ?? 0

  return (
    <div class="app-shell">
      <header class="titlebar" data-tauri-drag-region>
        <A href="/" class="titlebar-mark" aria-label="Agent-1 home">
          <span style={{ "font-size": "14px", "font-weight": "640", "letter-spacing": "-0.06em" }}>A1</span>
        </A>
        <div class="titlebar-tabs">
          {tabs().map((session) => (
            <A
              href={`/sessions/${encodeURIComponent(session.id)}`}
              class={`titlebar-tab ${activeSessionId() === session.id ? "active" : ""}`}
              title={session.title}
            >
              <span class="tab-dot">A</span>
              <span class="truncate">{session.title}</span>
              <button
                class="titlebar-tab-close"
                type="button"
                aria-label="Close tab"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  navigate("/")
                }}
              >
                <Icon name="close" size={10} />
              </button>
            </A>
          ))}
          <button class="titlebar-new" type="button" onClick={() => navigate("/new")} title="New session">
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div class="titlebar-actions">
          <span class={`titlebar-status ${connection() === "live" ? "" : "reconnecting"}`}>
            {connection() === "live" ? "live" : connection()}
          </span>
          <button
            class="icon-button"
            type="button"
            title="Approvals"
            onClick={() => navigate("/approvals")}
          >
            <Icon name="approvals" size={15} />
            {pending() > 0 ? (
              <span class="tag amber" style={{ position: "absolute", transform: "translate(13px,-10px)" }}>
                {pending()}
              </span>
            ) : null}
          </button>
          <button class="icon-button" type="button" title="Menu" onClick={() => setMenuOpen((value) => !value)}>
            <Icon name="menu" size={15} />
          </button>
        </div>
        {menuOpen() ? (
          <div class="titlebar-menu">
            {menuItems.map((item) => (
              <A href={item.href} onClick={() => setMenuOpen(false)}>
                <Icon name={item.icon} size={13} />
                {item.label}
              </A>
            ))}
            <div class="sep" />
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                navigate("/new")
              }}
            >
              <Icon name="plus" size={13} />
              New session
            </button>
          </div>
        ) : null}
      </header>
      <Show when={!online() || asleep() || connection() === "reconnecting" || updateReady()}>
        <div class="status-banners">
          <Show when={!online()}>
            <div class="status-banner offline">
              <span class="status-dot" />
              <span>Offline — the cached shell is available. Actions will resume when the connection returns.</span>
            </div>
          </Show>
          <Show when={online() && asleep()}>
            <div class="status-banner asleep">
              <span class="status-dot" />
              <span>Agent-1 is asleep or unreachable. Retrying when the computer wakes.</span>
            </div>
          </Show>
          <Show when={online() && !asleep() && connection() === "reconnecting"}>
            <div class="status-banner reconnecting">
              <span class="status-dot" />
              <span>Reconnecting to Agent-1…</span>
            </div>
          </Show>
          <Show when={updateReady()}>
            <div class="status-banner update">
              <span class="status-dot" />
              <span>A new Agent-1 build is ready.</span>
              <button
                class="button button-secondary button-small"
                type="button"
                onClick={() => {
                  void navigator.serviceWorker?.getRegistration().then((registration) => {
                    registration?.waiting?.postMessage({ type: "SKIP_WAITING" })
                    setTimeout(() => window.location.reload(), 250)
                  })
                }}
              >
                Reload
              </button>
            </div>
          </Show>
        </div>
      </Show>
      <div class="workspace">
        <main class="main-surface" data-variant={variant()}>
          {props.children as never}
        </main>
      </div>
    </div>
  )
}

function Unavailable(props: { offline: boolean; onRetry: () => void }) {
  return (
    <div class="connect-page">
      <div class="connect-content">
        <div class="connect-header">
          <h1>{props.offline ? "Offline" : "Agent-1 is not reachable"}</h1>
          <p>
            {props.offline
              ? "The cached Agent-1 shell is available. The daemon will reconnect when this device is online."
              : "The local daemon did not answer."}
          </p>
        </div>
        <button class="button button-secondary button-large" type="button" onClick={props.onRetry}>
          Retry
        </button>
      </div>
    </div>
  )
}

export function Root(props: { children?: unknown }) {
  const location = useLocation()
  const navigate = useNavigate()
  const isLogin = () => location.pathname === "/login"
  const [online, setOnline] = createSignal(typeof navigator === "undefined" ? true : navigator.onLine)
  const info = useQuery(() => ({
    queryKey: ["info"],
    queryFn: api.info,
    retry: false,
    staleTime: Infinity,
  }))

  onMount(() => {
    const handleOnline = () => {
      setOnline(true)
      void info.refetch()
    }
    const handleOffline = () => setOnline(false)
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    onCleanup(() => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    })
  })

  createEffect(() => {
    if (isLogin()) return
    const error = info.error
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      navigate("/login", { replace: true })
    }
  })

  return (
    <Switch
      fallback={<Unavailable offline={!online()} onRetry={() => void info.refetch()} />}
    >
      <Match when={isLogin()}>{props.children as never}</Match>
      <Match when={info.isLoading}>
        <Splash />
      </Match>
      <Match when={info.isError}>
        <Unavailable offline={!online()} onRetry={() => void info.refetch()} />
      </Match>
      <Match when={info.isSuccess}>
        <Shell eventSeq={info.data?.eventSeq}>{props.children}</Shell>
      </Match>
    </Switch>
  )
}
