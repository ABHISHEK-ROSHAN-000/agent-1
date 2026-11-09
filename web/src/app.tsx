import { Match, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { A, useLocation, useNavigate } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { ApiError, api, subscribeEvents } from "./api"
import { Icon, type IconName } from "./icons"
import { LoginPage } from "./login"
import { Spinner } from "./ui"

const railItems: Array<{ href: string; icon: IconName; label: string }> = [
  { href: "/", icon: "home", label: "Sessions" },
  { href: "/approvals", icon: "approvals", label: "Approvals" },
  { href: "/rules", icon: "rules", label: "Rules" },
  { href: "/workspaces", icon: "folder", label: "Workspaces" },
  { href: "/journal", icon: "journal", label: "Journal" },
  { href: "/models", icon: "model", label: "Models" },
  { href: "/settings", icon: "settings", label: "Settings" },
]

function Splash() {
  return (
    <div class="login-page">
      <div class="login-card" style={{ "align-items": "center" }}>
        <div class="login-wordmark" style={{ "margin-bottom": "25px" }}>
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
  const sessionsQuery = useQuery(() => ({
    queryKey: ["sessions"],
    queryFn: api.sessions,
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
          event.type === "session.created" ||
          event.type.startsWith("journal.")
        ) {
          void queryClient.invalidateQueries()
        }
      },
      setConnection,
      props.eventSeq ?? 0,
    )
    onCleanup(stop)
  })

  const sessions = () => sessionsQuery.data?.sessions ?? []
  const tabs = () => sessions().slice(0, 7)

  return (
    <div class="app-shell">
      <header class="tabs-bar">
        <A href="/" class="app-mark" aria-label="Agent-1 home">
          <Icon name="home" size={17} />
        </A>
        <div class="tabs-scroll">
          {tabs().map((session) => (
            <A
              href={`/sessions/${encodeURIComponent(session.id)}`}
              class={`tab ${activeSessionId() === session.id ? "active" : ""}`}
              title={session.title}
            >
              <span class="tab-dot">A</span>
              <span class="truncate">{session.title}</span>
            </A>
          ))}
          <button class="tab tab-new" type="button" onClick={() => navigate("/")} title="New session">
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div class="composer-spacer" />
        <span class={`tag ${connection() === "live" ? "green" : "amber"}`}>{connection()}</span>
      </header>
      <div class="workspace">
        <aside class="rail">
          {railItems.map((item) => (
            <A
              href={item.href}
              class={`rail-button ${
                location.pathname === item.href ||
                (item.href === "/" && location.pathname.startsWith("/sessions/"))
                  ? "active"
                  : ""
              }`}
              aria-label={item.label}
            >
              <Icon name={item.icon} size={17} />
              <span class="rail-tooltip">{item.label}</span>
            </A>
          ))}
          <div class="rail-spacer" />
          <span class="tag tiny">local</span>
        </aside>
        <main class="main-surface">{props.children as never}</main>
      </div>
    </div>
  )
}

export function Root(props: { children?: unknown }) {
  const location = useLocation()
  const navigate = useNavigate()
  const isLogin = () => location.pathname === "/login"
  const info = useQuery(() => ({
    queryKey: ["info"],
    queryFn: api.info,
    retry: false,
    staleTime: Infinity,
  }))

  createEffect(() => {
    if (isLogin()) return
    const error = info.error
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      navigate("/login", { replace: true })
    }
  })

  return (
    <Switch
      fallback={
        <div class="login-page">
          <div class="login-card">
            <div class="login-wordmark">Agent-1</div>
            <p class="login-error" style={{ "text-align": "center" }}>
              Agent-1 is not reachable.
            </p>
            <button class="button button-secondary" type="button" onClick={() => navigate("/login")}>
              Go to login
            </button>
          </div>
        </div>
      }
    >
      <Match when={isLogin()}>{props.children as never}</Match>
      <Match when={info.isLoading}>
        <Splash />
      </Match>
      <Match when={info.isError}>
        <div class="login-page">
          <div class="login-card">
            <div class="login-wordmark">Agent-1</div>
            <p class="login-error" style={{ "text-align": "center" }}>
              Agent-1 is not reachable.
            </p>
            <button class="button button-secondary" type="button" onClick={() => navigate("/login")}>
              Go to login
            </button>
          </div>
        </div>
      </Match>
      <Match when={info.isSuccess}>
        <Shell eventSeq={info.data?.eventSeq}>{props.children}</Shell>
      </Match>
    </Switch>
  )
}

