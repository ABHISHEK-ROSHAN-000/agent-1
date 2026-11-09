import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import QrScanner from "qr-scanner"
import { toast } from "solid-sonner"
import { api } from "./api"
import { Icon } from "./icons"

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
      setError(
        cause instanceof Error
          ? cause.message
          : "Camera access failed. Paste the pairing link instead.",
      )
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
          <strong>Scan pairing QR</strong>
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
        <p class="small muted" style={{ "margin": "12px 0 0", "text-align": "center" }}>
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
    <div class="login-page">
      <div class="login-card">
        <div class="login-wordmark">Agent-1</div>
        <h1 class="login-title">Connect to a server</h1>
        <p class="login-subtitle">Paste the pairing link from the server, or scan its QR code.</p>

        <Show
          when={mode() === "pairing"}
          fallback={
            <form class="login-stack" onSubmit={signIn}>
              <input type="text" name="username" autocomplete="username" value="agent-1" hidden readonly />
              <div>
                <label class="field-label" for="password">
                  Password
                </label>
                <input
                  id="password"
                  class="input"
                  type="password"
                  autocomplete="current-password"
                  placeholder="Server password"
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                  disabled={busy()}
                />
              </div>
              <button class="button button-primary" type="submit" disabled={busy() || !password()}>
                {busy() ? "Connecting…" : "Connect"}
              </button>
              <div class="login-links">
                <button class="link-button" type="button" onClick={() => setMode("pairing")}>
                  Back to pairing link
                </button>
              </div>
            </form>
          }
        >
          <div class="login-stack">
            <div>
              <label class="field-label" for="pairing-link">
                Pairing link
              </label>
              <input
                id="pairing-link"
                class="input"
                type="url"
                spellcheck={false}
                placeholder="http://192.168.1.2:4096/pair?token=…"
                value={link()}
                onInput={(event) => setLink(event.currentTarget.value)}
                onKeyDown={(event) => event.key === "Enter" && connect()}
              />
            </div>
            <button class="button button-primary" type="button" onClick={() => connect()}>
              Connect
            </button>
            <button class="button button-secondary" type="button" onClick={() => setShowScanner(true)}>
              Scan QR code
            </button>
          </div>

          <div class="login-links">
            <span>No pairing link?&nbsp;&nbsp;</span>
            <button class="link-button" type="button" onClick={() => setMode("password")}>
              Use password
            </button>
          </div>

          <div class="login-help">
            <div>Run this command on the server's computer to get a pairing link and QR code.</div>
            <div class="command-chip">agent-1 pair</div>
          </div>
        </Show>

        <Show when={error()}>
          <div class="login-error">{error()}</div>
        </Show>
      </div>

      <Show when={showScanner()}>
        <ScannerModal onClose={() => setShowScanner(false)} onResult={(value) => connect(value)} />
      </Show>
    </div>
  )
}
