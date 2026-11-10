import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import QrScanner from "qr-scanner"
import { toast } from "solid-sonner"
import { api } from "./api"
import { Icon } from "./icons"
import { AgentOneWordmark } from "./wordmark"

function ScannerModal(props: { onClose: () => void; onResult: (value: string) => void }) {
  let video: HTMLVideoElement | undefined
  let scanner: QrScanner | undefined
  const [error, setError] = createSignal<string>()

  onMount(async () => {
    if (!video) return
    try {
      scanner = new QrScanner(
        video,
        (result) => {
          const value = typeof result === "string" ? result : result.data
          props.onResult(value)
          props.onClose()
        },
        {
          highlightScanRegion: true,
          highlightCodeOutline: true,
          returnDetailedScanResult: true,
        },
      )
      await scanner.start()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Camera access failed. Paste the pairing link instead.")
    }
  })

  onCleanup(() => {
    scanner?.stop()
    scanner?.destroy()
  })

  return (
    <div class="scan-modal" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div class="scan-dialog">
        <div class="row-between" style={{ "margin-bottom": "12px" }}>
          <strong style={{ "font-weight": "530" }}>Scan pairing QR</strong>
          <button class="icon-button" type="button" onClick={props.onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <video ref={video} class="scan-video" muted playsinline />
        <Show when={error()}>
          <div class="banner banner-error" style={{ "margin-top": "12px" }}>
            {error()}
          </div>
        </Show>
        <p class="connect-hint" style={{ "margin": "12px 0 0", "text-align": "center" }}>
          Point the camera at the QR code printed by <span class="mono">agent-1 pair</span>.
        </p>
      </div>
    </div>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const [mode, setMode] = createSignal<"pairing" | "password">("pairing")
  const [link, setLink] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [showScanner, setShowScanner] = createSignal(false)

  onMount(() => {
    void api
      .info()
      .then(() => navigate("/", { replace: true }))
      .catch(() => undefined)
  })

  const connect = (raw?: string) => {
    const value = (raw ?? link()).trim()
    if (!value) {
      setError("Paste a pairing link or scan its QR code.")
      return
    }
    setError(undefined)
    try {
      if (value.startsWith("http://") || value.startsWith("https://")) {
        const url = new URL(value)
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported link")
        window.location.assign(url.toString())
        return
      }
      if (value.startsWith("/pair")) {
        window.location.assign(value)
        return
      }
      const token = value.replace(/^\/?pair\?token=/, "")
      if (!token) throw new Error("Pairing link is invalid")
      window.location.assign(`/pair?token=${encodeURIComponent(token)}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pairing link is invalid")
    }
  }

  const signIn = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!password()) return
    setBusy(true)
    setError(undefined)
    try {
      await api.login(password())
      toast.success("Connected to Agent-1")
      window.location.assign("/")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="connect-page">
      <div class="connect-content">
        <div class="connect-brand">
          <AgentOneWordmark />
        </div>
        <header class="connect-header">
          <h1>Connect to a server</h1>
          <p>Paste the pairing link from the server, or scan its QR code.</p>
        </header>

        <Show
          when={mode() === "pairing"}
          fallback={
            <form class="connect-form" onSubmit={signIn}>
              <input type="text" name="username" autocomplete="username" value="agent-1" hidden readonly />
              <div class="connect-field">
                <label class="field-label" for="server-address">
                  Server address
                </label>
                <input id="server-address" class="input input-large" type="text" value={window.location.origin} readonly />
              </div>
              <div class="connect-field">
                <label class="field-label" for="password">
                  Password
                </label>
                <input
                  id="password"
                  class="input input-large"
                  type="password"
                  autocomplete="current-password"
                  placeholder="Server password"
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                  disabled={busy()}
                />
                <p class="connect-hint">Use the password printed by `agent-1 auth show`.</p>
              </div>
              <button class="button button-contrast button-large button-block" type="submit" disabled={busy() || !password()}>
                {busy() ? "Checking…" : "Connect"}
              </button>
              <div class="connect-links">
                <button class="connect-link-button" type="button" onClick={() => setMode("pairing")}>
                  Back to pairing link
                </button>
              </div>
            </form>
          }
        >
          <div class="connect-form">
            <div class="connect-field">
              <label class="field-label" for="pairing-link">
                Pairing link
              </label>
              <input
                id="pairing-link"
                class="input input-large"
                type="url"
                spellcheck={false}
                placeholder="http://192.168.1.2:4096/pair?token=…"
                value={link()}
                onInput={(event) => setLink(event.currentTarget.value)}
                onKeyDown={(event) => event.key === "Enter" && connect()}
              />
            </div>
            <button
              class="button button-contrast button-large button-block"
              type="button"
              onClick={() => connect()}
              disabled={!link().trim()}
            >
              Connect
            </button>
            <button class="button button-neutral button-large button-block" type="button" onClick={() => setShowScanner(true)}>
              Scan QR code
            </button>
          </div>

          <div class="connect-links">
            <span>No pairing link?</span>
            <button class="connect-link-button" type="button" onClick={() => setMode("password")}>
              Use password
            </button>
          </div>

          <div class="connect-help">
            <div>Run this command on the server's computer to get a pairing link and QR code.</div>
            <div class="connect-command">agent-1 pair</div>
          </div>
        </Show>

        <Show when={error()}>
          <div class="connect-error">{error()}</div>
        </Show>
      </div>

      <Show when={showScanner()}>
        <ScannerModal onClose={() => setShowScanner(false)} onResult={(value) => connect(value)} />
      </Show>
    </div>
  )
}
