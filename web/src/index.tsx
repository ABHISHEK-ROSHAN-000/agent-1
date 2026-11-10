import { render } from "solid-js/web"
import { Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Toaster } from "solid-sonner"
import { Root } from "./app"
import { LoginPage } from "./login"
import { HomePage, NewSessionPage } from "./home"
import {
  ApprovalsPage,
  JournalPage,
  ModelsPage,
  ProvidersPage,
  RulesPage,
  SessionPage,
  SettingsPage,
  WorkspacesPage,
} from "./pages"
import { applyTheme, getThemePreference, watchSystemTheme } from "./theme"
import "./styles.css"

applyTheme(getThemePreference())
watchSystemTheme(() => {
  if (getThemePreference() === "system") applyTheme("system")
})

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener(
    "load",
    () => {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined)
    },
    { once: true },
  )
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  },
})

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <Router root={Root}>
        <Route path="/login" component={LoginPage} />
        <Route path="/" component={HomePage} />
        <Route path="/new" component={NewSessionPage} />
        <Route path="/sessions/:id" component={SessionPage} />
        <Route path="/approvals" component={ApprovalsPage} />
        <Route path="/rules" component={RulesPage} />
        <Route path="/workspaces" component={WorkspacesPage} />
        <Route path="/journal" component={JournalPage} />
        <Route path="/providers" component={ProvidersPage} />
        <Route path="/models" component={ModelsPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="*" component={HomePage} />
      </Router>
      <Toaster
        theme="system"
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--surface)",
            color: "var(--text)",
            border: "1px solid var(--border)",
          },
        }}
      />
    </QueryClientProvider>
  ),
  root,
)
