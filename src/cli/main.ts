import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { EOL, tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import {
  cancel,
  intro,
  isCancel,
  outro,
  password as passwordPrompt,
  select,
  spinner,
} from "@clack/prompts"
import { parseArgs, flagString, hasFlag, type ParsedArgs } from "./args"
import { renderUnicodeCompact } from "./qr"
import { CLI_NAME, PRODUCT_NAME, VERSION } from "../core/version"
import { ensureDataDirs, resolveConfig, type AppConfig } from "../core/config"
import { readServiceConfig, updateServiceConfig } from "../core/service-config"
import { SecretStore } from "../auth/secret-store"
import { AgentOneClient } from "../client/client"
import { autostartStatus, disableAutostart, enableAutostart } from "../daemon/autostart"
import { startService, stopService, serviceStatus, type StatusResult } from "../daemon/service"
import { launchTui } from "../tui/launcher"
import { canApplyUpdates, checkForUpdate, DEFAULT_UPDATE_URL, updateInstallerUrl } from "../update/service"

const HELP = `${PRODUCT_NAME} ${VERSION}

Usage: ${CLI_NAME} <command> [options]
       ${CLI_NAME}                   Open the terminal client

Commands:
  service start|stop|status|restart
  service set port [port]
  service autostart on|off|status
  onboard                        Start the service and show first-run details
  update [--check]               Check for or install an update
  tui                            Open the terminal client
  status
  auth login [provider]          Connect a provider with an API key
  auth list [--format default|json]
  auth logout <provider> [credential]
  auth switch <provider> [credential]
  auth show|rotate                Server password
  pair [--remote] [--url <url>] [--yes]
  remote on [--yes]|off|status
  session create [--title <title>]
  session list
  session rename <id> <title>
  session delete <id>
  sessions search <query> [--limit <n>] [--sort relevance|newest|oldest]
  sessions show <id>
  memory list
  memory pending
  memory approve <id>
  memory reject <id> [--reason <text>]
  memory undo [history-id]
  memory export
  models                         List provider/model pairs
  run [message...] [--session <id>] [--model provider/model#variant]
  chat [message...] [--session <id>] [--model provider/model#variant]
  rules list
  rules add --action <action> --resource <resource> --effect allow|ask|deny [--note <note>]
  rules update <id> [--effect ...] [--position ...] [--action ...] [--resource ...]
  rules remove <id>
  approvals list [--status pending|approved|rejected|expired|invalidated]
  approvals show <id>
  approvals approve <id> [--scope once|session|always]
  approvals reject <id> [--reason <text>]
  approvals config [--mode smart|manual|off] [--timeout <seconds>] [--safe-root <path>] [--smart-model provider/model]
  approvals grants
  approvals revoke-grant <id>
  audit [--limit <n>]
  checkpoints list [--limit <n>]
  checkpoints show <id>
  checkpoints diff <id>
  checkpoints restore <id> [--file <path>] [--unsafe]
  tools list

Options:
  --data-dir <path>   Override the Agent-1 data directory
  --port <port>       Override the local API port (0 = random)
  --json              Print machine-readable JSON
  --help              Show this help
  --version           Show the version
`

function printHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(HELP)
}

function output(json: boolean, value: unknown, text: string): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`)
  else process.stdout.write(`${text}\n`)
}

function configFor(parsed: ParsedArgs): AppConfig {
  const env = { ...process.env }
  const dataDir = flagString(parsed, "data-dir")
  if (dataDir) env.AGENT1_DATA_DIR = dataDir
  const port = flagString(parsed, "port")
  if (port) env.AGENT1_PORT = port
  return resolveConfig(env)
}

async function passwordFor(config: AppConfig): Promise<string> {
  const fromEnv = process.env.AGENT1_PASSWORD
  if (fromEnv) return fromEnv
  const password = await new SecretStore(config.secretsPath).readPassword()
  if (!password) {
    throw new Error("No password is available. Start the service first or set AGENT1_PASSWORD.")
  }
  return password
}

async function serviceCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1]
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)

  if (sub === "set") {
    if (parsed.positionals[2] !== "port") {
      throw new Error("Usage: agent-1 service set port [port]")
    }
    const value = parsed.positionals[3]
    if (value === undefined) {
      const current = readServiceConfig(config.serviceConfigPath)
      const port = current?.port ?? config.port
      output(json, { port }, `Agent-1 service port: ${port}`)
      return
    }
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Port must be an integer between 1 and 65535")
    }
    updateServiceConfig(config.serviceConfigPath, { port })
    const running = (await serviceStatus(config)).status === "running"
    output(
      json,
      { port, restartRequired: running },
      running
        ? `Agent-1 service port set to ${port}. Restart the service to apply it.`
        : `Agent-1 service port set to ${port}.`,
    )
    return
  }

  if (!sub || sub === "status") {
    const status = await serviceStatus(config)
    if (json) {
      output(true, status, "")
      return
    }
    if (status.status === "stopped") {
      process.stdout.write("Agent-1 is stopped.\n")
      return
    }
    if (status.status === "stale") {
      process.stdout.write(`Agent-1 is not running (stale state for pid ${status.state?.pid}).\n`)
      return
    }
    process.stdout.write(
      `Agent-1 is running.\n  PID:     ${status.state?.pid}\n  URL:     ${status.state?.url}\n  Version: ${status.state?.version}\n  Health:  ${status.healthy ? "ok" : "unreachable"}\n`,
    )
    return
  }

  if (sub === "start") {
    ensureDataDirs(config)
    const result = await startService(config)
    if (json) {
      output(true, { status: "running", alreadyRunning: result.alreadyRunning, ...result.state }, "")
      return
    }
    process.stdout.write(
      `Agent-1 is ${result.alreadyRunning ? "already running" : "running"}.\n  PID: ${result.state.pid}\n  URL: ${result.state.url}\n`,
    )
    process.stdout.write("Show the password with: agent-1 auth show\n")
    return
  }

  if (sub === "stop") {
    const status = await serviceStatus(config)
    if (status.status !== "running") {
      const result = { stopped: false, forced: false }
      output(json, result, "Agent-1 was not running.")
      return
    }
    const password = await passwordFor(config)
    const result = await stopService(config, password)
    if (json) {
      output(true, result, "")
      return
    }
    process.stdout.write(result.stopped ? "Agent-1 stopped.\n" : "Agent-1 was not running.\n")
    if (result.forced) process.stdout.write("The process did not stop gracefully and was forced.\n")
    return
  }

  if (sub === "restart") {
    const current = await serviceStatus(config)
    if (current.status === "running") {
      const password = await passwordFor(config)
      await stopService(config, password)
    }
    const result = await startService(config)
    if (json) {
      output(true, { status: "running", alreadyRunning: result.alreadyRunning, ...result.state }, "")
      return
    }
    process.stdout.write(`Agent-1 restarted.\n  PID: ${result.state.pid}\n  URL: ${result.state.url}\n`)
    return
  }

  if (sub === "autostart") {
    const action = parsed.positionals[2]
    if (action === "on") {
      const status = enableAutostart()
      output(json, status, `Autostart enabled (${status.entryName}).`)
      return
    }
    if (action === "off") {
      const status = disableAutostart()
      output(json, status, `Autostart disabled (${status.entryName}).`)
      return
    }
    if (!action || action === "status") {
      const status = autostartStatus()
      output(json, status, `Autostart is ${status.enabled ? "enabled" : "disabled"} (${status.entryName}).`)
      return
    }
    throw new Error("Usage: agent-1 service autostart on|off|status")
  }

  throw new Error("Usage: agent-1 service start|stop|status|restart|set port|autostart")
}

async function onboardCommand(parsed: ParsedArgs): Promise<void> {
  const config = configFor(parsed)
  ensureDataDirs(config)
  const started = await startService(config)
  const json = hasFlag(parsed, "json")
  const result = {
    status: "ready",
    url: started.state.url,
    dataDir: config.dataDir,
    autostart: autostartStatus().enabled,
    next: [
      "agent-1 auth show",
      "agent-1 auth login openrouter",
      "agent-1 pair",
      "agent-1 service autostart on",
      "agent-1",
    ],
  }
  output(
    json,
    result,
    [
      "Agent-1 is ready.",
      `  URL:       ${result.url}`,
      `  Data:      ${result.dataDir}`,
      `  Autostart: ${result.autostart ? "enabled" : "disabled"}`,
      "",
      "Next:",
      "  agent-1 auth show              Show the local password",
      "  agent-1 auth login openrouter  Connect a model provider",
      "  agent-1 pair                   Create a one-time pairing link",
      "  agent-1 service autostart on   Start the daemon at sign-in",
      "  agent-1                        Open the terminal UI",
    ].join("\n"),
  )
}

async function updateCommand(parsed: ParsedArgs): Promise<void> {
  const json = hasFlag(parsed, "json")
  const checkOnly = hasFlag(parsed, "check")
  const status = await checkForUpdate(VERSION)
  if (!status.available) {
    output(
      json,
      { status: "up-to-date", current: status.current },
      `Agent-1 ${status.current} is up to date.`,
    )
    return
  }

  if (checkOnly || json) {
    output(
      json,
      {
        status: "available",
        current: status.current,
        latest: status.latest,
        releaseNotes: status.manifest?.releaseNotes,
      },
      `Agent-1 ${status.latest} is available (current ${status.current}).\nRun: agent-1 update`,
    )
    return
  }

  if (!canApplyUpdates()) {
    throw new Error(
      `Agent-1 ${status.latest} is available, but updates apply only to installed builds. Download the release or run from a packaged install.`,
    )
  }

  const temporary = await mkdtemp(path.join(tmpdir(), "agent-1-update-"))
  const installer = path.join(temporary, "install.ps1")
  try {
    const response = await fetch(updateInstallerUrl(), {
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "text/plain" },
    })
    if (!response.ok) throw new Error(`Could not download the installer (HTTP ${response.status})`)
    await writeFile(installer, await response.text(), "utf8")
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          installer,
          "-Version",
          status.latest,
          "-ManifestUrl",
          process.env.AGENT1_UPDATE_URL ?? DEFAULT_UPDATE_URL,
          "-InstallDir",
          path.dirname(path.dirname(path.dirname(process.execPath))),
          "-NoAutostart",
        ],
        { stdio: "inherit", windowsHide: false },
      )
      child.once("error", reject)
      child.once("exit", (exitCode) => resolve(exitCode ?? 1))
    })
    if (code !== 0) throw new Error(`Installer exited with code ${code}`)
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 })
  }
}

class CliCancelled extends Error {
  constructor() {
    super("Cancelled")
    this.name = "CliCancelled"
  }
}

async function providerClient(parsed: ParsedArgs): Promise<{
  client: AgentOneClient
  config: AppConfig
}> {
  const config = configFor(parsed)
  const status = await ensureRunning(config)
  const password = await passwordFor(config)
  return { client: new AgentOneClient({ baseUrl: status.state.url, password }), config }
}

const PROVIDER_PRIORITY = ["openrouter", "openai", "lmstudio", "ollama"]

function orderedProviders<T extends { id: string; name: string }>(providers: readonly T[]): T[] {
  return [...providers].sort((left, right) => {
    const leftIndex = PROVIDER_PRIORITY.indexOf(left.id)
    const rightIndex = PROVIDER_PRIORITY.indexOf(right.id)
    if (leftIndex >= 0 || rightIndex >= 0) {
      if (leftIndex < 0) return 1
      if (rightIndex < 0) return -1
      return leftIndex - rightIndex
    }
    return left.name.localeCompare(right.name)
  })
}

function cancelled(): never {
  cancel("Cancelled")
  throw new CliCancelled()
}

async function chooseProvider(
  client: AgentOneClient,
  target: string | undefined,
): Promise<{
  id: string
  name: string
  kind: "cloud" | "local"
  environment: readonly string[]
  credentials: readonly { id: string; label: string; active: boolean }[]
}> {
  const providers = (await client.listProviders()).providers
  if (target) {
    const normalized = target.toLowerCase()
    const match = providers.find(
      (provider) =>
        provider.id === target ||
        provider.name.toLowerCase() === normalized ||
        provider.id === normalized,
    )
    if (!match) throw new Error(`Provider not found: ${target}`)
    return match
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Pass a provider ID or name when running without an interactive terminal")
  }
  const answer = await select({
    message: "Select provider",
    initialValue: orderedProviders(providers)[0]?.id,
    options: orderedProviders(providers).map((provider) => ({
      value: provider.id,
      label: provider.name,
      hint: provider.connected
        ? `connected · ${provider.source}`
        : `${provider.modelCount} models`,
    })),
    maxItems: 10,
  })
  if (isCancel(answer)) cancelled()
  return providers.find((provider) => provider.id === answer)!
}

async function chooseCredential(
  provider: {
    name: string
    credentials: readonly { id: string; label: string; active: boolean }[]
  },
  requested: string | undefined,
  action: string,
): Promise<{ id: string; label: string; active: boolean }> {
  const match = requested
    ? provider.credentials.find((credential) => credential.id === requested || credential.label === requested)
    : provider.credentials.length === 1
      ? provider.credentials[0]
      : undefined
  if (match) return match
  if (requested) throw new Error("Credential not found")
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Pass a credential ID or label when running without an interactive terminal")
  }
  if (provider.credentials.length === 0) throw new Error(`No stored credentials for ${provider.name}`)
  const answer = await select({
    message: `Select credential to ${action}`,
    options: provider.credentials.map((credential) => ({
      value: credential.id,
      label: credential.label,
      hint: credential.active ? "active" : undefined,
    })),
  })
  if (isCancel(answer)) cancelled()
  return provider.credentials.find((credential) => credential.id === answer)!
}

async function authCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1]
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  ensureDataDirs(config)

  if (sub === "show") {
    const password = await new SecretStore(config.secretsPath).readPassword()
    if (!password) throw new Error("No password is available. Start the service first.")
    output(json, { password }, password)
    return
  }

  if (sub === "rotate") {
    const password = await passwordFor(config)
    const status = await serviceStatus(config)
    if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
    const client = new AgentOneClient({ baseUrl: status.state.url, password })
    const result = await client.rotatePassword()
    output(json, result, `New password: ${result.password}`)
    return
  }

  if (sub === "list") {
    const { client } = await providerClient(parsed)
    const result = await client.listProviders()
    if (json || parsed.flags.get("format") === "json") {
      output(true, result, "")
      return
    }
    const rows = result.providers.flatMap((provider) => {
      const connections = provider.credentials.map((credential) => ({
        provider: provider.name,
        source: credential.label,
        type: credential.active ? "stored (active)" : "stored",
      }))
      if (provider.environment.length > 0) {
        connections.push({
          provider: provider.name,
          source: provider.environment.join(", "),
          type: "environment",
        })
      }
      return connections
    })
    if (rows.length === 0) {
      process.stdout.write("No authenticated integrations\n")
      return
    }
    const width = Math.max(...rows.map((row) => row.provider.length)) + 2
    const sourceWidth = Math.max(...rows.map((row) => row.source.length)) + 2
    process.stdout.write(rows.map((row) => row.provider.padEnd(width) + row.source.padEnd(sourceWidth) + row.type).join(EOL) + EOL)
    return
  }

  if (sub === "login") {
    const { client } = await providerClient(parsed)
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
    if (interactive) intro("Connect a provider")
    const provider = await chooseProvider(client, parsed.positionals[2])
    let key = ""
    if (interactive && (provider.kind === "cloud" || provider.environment.length > 0)) {
      const hint =
        provider.environment.length > 0
          ? ` (leave blank to use ${provider.environment.join(", ")})`
          : ""
      const answer = await passwordPrompt({
        message: `Enter your ${provider.name} API key${hint}`,
        mask: "*",
        validate: (value) =>
          !value && provider.kind === "cloud" && provider.environment.length === 0
            ? "API key is required"
            : undefined,
      })
      if (isCancel(answer)) cancelled()
      key = answer
    }
    const progress = interactive ? spinner() : undefined
    progress?.start("Saving credential...")
    try {
      const result = await client.connectProvider(provider.id, key || undefined)
      progress?.stop(`Connected to ${result.provider.name}`)
      if (interactive) outro("Done")
      output(json, result, `Connected to ${result.provider.name}.`)
    } catch (error) {
      progress?.stop("Authentication failed", 1)
      throw error
    }
    return
  }

  if (sub === "logout") {
    const { client } = await providerClient(parsed)
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
    if (interactive) intro("Log out of a provider")
    const provider = await chooseProvider(client, parsed.positionals[2])
    const credential = await chooseCredential(provider, parsed.positionals[3], "remove")
    const result = await client.removeProviderCredential(provider.id, credential.id)
    if (interactive) outro("Done")
    output(json, result, `Removed ${credential.label} from ${result.provider.name}.`)
    return
  }

  if (sub === "switch") {
    const { client } = await providerClient(parsed)
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
    if (interactive) intro("Switch provider credential")
    const provider = await chooseProvider(client, parsed.positionals[2])
    const credential = await chooseCredential(provider, parsed.positionals[3], "activate")
    const result = await client.activateProviderCredential(provider.id, credential.id)
    if (interactive) outro("Done")
    output(json, result, `Active credential for ${result.provider.name}: ${credential.label}.`)
    return
  }

  throw new Error("Usage: agent-1 auth login|list|logout|switch|show|rotate")
}

const PAIR_HELP = `Usage: ${CLI_NAME} pair [--remote] [--url <url>] [--yes]

Print one-time links to connect a browser or app.

Options:
  --remote          Pair through the OpenTunnel remote address, enabling remote
                    access if needed (exposes the server to the internet)
  --url <url>       Use an external HTTP(S) server URL in pairing links
  --yes, -y         Accept exposing the server to the internet when --remote
                    enables remote access for the first time
  --json            Print machine-readable JSON
`

const remoteWarning = [
  "This will expose your Agent-1 server to the internet.",
  "Traffic is end-to-end encrypted, and access requires your server password.",
  "To pair locally instead, run `agent-1 pair` without the --remote flag.",
].join(EOL)

function pairingAddress(value: string): string {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid pairing URL")
  }
  return url.href.replace(/\/+$/, "")
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("127.") || hostname === "[::1]"
}

async function ensureRunning(config: AppConfig): Promise<StatusResult & { state: NonNullable<StatusResult["state"]> }> {
  let status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) {
    ensureDataDirs(config)
    const started = await startService(config)
    status = { status: "running", state: started.state, healthy: true }
  }
  return status as StatusResult & { state: NonNullable<StatusResult["state"]> }
}

async function waitForRemote(client: AgentOneClient): Promise<{ url: string; urls: string[] }> {
  const deadline = Date.now() + 3 * 60_000
  let lastError: string | undefined
  while (Date.now() < deadline) {
    try {
      const status = await client.remote()
      if (status.url) return { url: status.url, urls: [...status.urls] }
      lastError = status.error
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(1_000)
  }
  throw new Error(
    [
      "Timed out waiting for the remote tunnel; run `agent-1 pair --remote` again to retry.",
      lastError ? `Last error: ${lastError}` : "",
    ]
      .filter(Boolean)
      .join(EOL),
  )
}

async function confirmRemote(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await terminal.question("Expose your server to the internet? [Y/n] ")
    return answer.trim().toLowerCase() !== "n" && answer.trim().toLowerCase() !== "no"
  } finally {
    terminal.close()
  }
}

async function pairCommand(parsed: ParsedArgs): Promise<void> {
  const config = configFor(parsed)
  const remoteFlag = hasFlag(parsed, "remote")
  const yes = hasFlag(parsed, "yes") || hasFlag(parsed, "y") || parsed.positionals.includes("-y")
  const rawUrl = flagString(parsed, "url")
  const hasUrl = hasFlag(parsed, "url")
  if (remoteFlag && hasUrl) throw new Error("--remote cannot be combined with --url")
  if (hasUrl && !rawUrl) throw new Error("--url requires an HTTP(S) URL")
  const url = rawUrl ? pairingAddress(rawUrl) : undefined
  const status = await ensureRunning(config)
  const password = await passwordFor(config)
  const client = new AgentOneClient({ baseUrl: status.state.url, password })
  let remote = await client.remote()

  if (remoteFlag) {
    if (!remote.accepted && !remote.enabled) {
      process.stderr.write(remoteWarning + EOL)
      if (!yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          process.stderr.write("Run interactively or pass --yes to continue." + EOL)
          process.exitCode = 1
          return
        }
        if (!(await confirmRemote())) {
          process.stderr.write("Remote access was not enabled. To pair locally, run `agent-1 pair`." + EOL)
          return
        }
      }
      await client.acceptRemote()
    }
    if (!remote.enabled || remote.state === "error" || remote.state === "off") await client.enableRemote()
    remote = await client.remote()
    if (!remote.url) {
      process.stderr.write("Setting up remote access; this can take a minute..." + EOL)
      remote = await waitForRemote(client).then((value) => ({ ...remote, url: value.url, urls: value.urls }))
    }
  }

  const pairing = await client.pair()
  const urls = remoteFlag
    ? pairing.urls.filter((value) => !isLoopback(new URL(value).hostname))
    : url
      ? [url]
      : pairing.urls
  if (remoteFlag && urls.length === 0) throw new Error("Remote tunnel did not expose a public URL")
  const links = urls.map((base) => new URL(`/auth/connect/${encodeURIComponent(pairing.code)}`, base).href)
  const remoteUrls = urls.filter((value) => !isLoopback(new URL(value).hostname))
  const minutes = Math.max(1, Math.round(pairing.expiresIn / 60))

  if (hasFlag(parsed, "json")) {
    output(true, { ...pairing, links, remoteUrls }, "")
    return
  }

  const lines = [
    "",
    `  Open a link to connect. Links work once and expire in ${minutes} minutes.`,
    "",
    ...(links.length ? links.map((link) => `  ${link}`) : ["  (no server URLs)"]),
  ]
  if (remoteUrls.length) {
    lines.push(
      "",
      ...renderUnicodeCompact(JSON.stringify({ code: pairing.code, urls: remoteUrls }), { border: 2 })
        .split("\n")
        .map((line) => "  " + line),
    )
  }
  lines.push("")
  process.stdout.write(lines.join(EOL) + EOL)

  if (!remoteFlag && !hasUrl) {
    const endpoint = new URL(status.state.url)
    if (isLoopback(endpoint.hostname)) {
      process.stderr.write(
        [
          "  Over SSH? Forward the port, then open the link on your machine:",
          `  ssh -L ${endpoint.port}:${endpoint.hostname}:${endpoint.port} <host>`,
          `  If port ${endpoint.port} is busy locally, forward another port and use it in the link.`,
          "",
          "  To connect from other devices, run `agent-1 pair --remote`.",
          "",
        ].join(EOL),
      )
    }
  }
}

async function remoteCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1] ?? "status"
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  if (sub === "on") {
    const status = await ensureRunning(config)
    const password = await passwordFor(config)
    const client = new AgentOneClient({ baseUrl: status.state.url, password })
    let remote = await client.remote()
    const yes = hasFlag(parsed, "yes") || hasFlag(parsed, "y") || parsed.positionals.includes("-y")
    if (!remote.accepted && !remote.enabled) {
      process.stderr.write(remoteWarning + EOL)
      if (!yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          process.stderr.write("Run interactively or pass --yes to continue." + EOL)
          process.exitCode = 1
          return
        }
        if (!(await confirmRemote())) {
          process.stderr.write("Remote access was not enabled." + EOL)
          return
        }
      }
      await client.acceptRemote()
    }
    if (!remote.enabled || remote.state === "error" || remote.state === "off") await client.enableRemote()
    remote = await client.remote()
    if (!remote.url) {
      process.stderr.write("Setting up remote access; this can take a minute..." + EOL)
      remote = await waitForRemote(client).then((value) => ({ ...remote, url: value.url, urls: value.urls }))
    }
    output(json, remote, [`Remote access: ${remote.state}`, `URL: ${remote.url ?? "—"}`, ""].join(EOL))
    return
  }
  if (sub === "status") {
    const status = await serviceStatus(config)
    if (status.status !== "running" || !status.state) {
      const stopped = { enabled: false, accepted: false, state: "off" as const, route: "", urls: [] }
      output(json, stopped, "Remote access: stopped")
      return
    }
    const password = await passwordFor(config)
    const remote = await new AgentOneClient({ baseUrl: status.state.url, password }).remote()
    if (json) {
      output(true, remote, "")
      return
    }
    process.stdout.write(
      [
        `Remote access: ${remote.enabled ? remote.state : "disabled"}`,
        `Accepted: ${remote.accepted ? "yes" : "no"}`,
        `Route: ${remote.route || "—"}`,
        `URL: ${remote.url ?? "—"}`,
        ...(remote.error ? [`Error: ${remote.error}`] : []),
        "",
      ].join(EOL),
    )
    return
  }
  if (sub === "off") {
    const status = await ensureRunning(config)
    const password = await passwordFor(config)
    const remote = await new AgentOneClient({ baseUrl: status.state.url, password }).disableRemote()
    output(json, remote, "Remote access disabled.")
    return
  }
  throw new Error("Usage: agent-1 remote on|off|status")
}

async function sessionCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1]
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password })

  if (sub === "create") {
    const title = flagString(parsed, "title")
    const result = await client.createSession(title)
    output(json, result, `Created session ${String(result.session.id)} ("${String(result.session.title)}")`)
    return
  }

  if (sub === "list" || !sub) {
    const result = await client.listSessions()
    if (json) {
      output(true, result, "")
      return
    }
    if (result.sessions.length === 0) {
      process.stdout.write("No sessions.\n")
      return
    }
    for (const session of result.sessions) {
      process.stdout.write(`${String(session.id)}  ${String(session.title)}\n`)
    }
    return
  }

  if (sub === "rename") {
    const id = parsed.positionals[2]
    const title = parsed.positionals.slice(3).join(" ").trim() || flagString(parsed, "title")
    if (!id || !title) throw new Error("Usage: agent-1 session rename <id> <title>")
    const result = await client.renameSession(id, title)
    output(json, result, `Renamed session ${id} to "${String(result.session.title)}".`)
    return
  }

  if (sub === "delete") {
    const id = parsed.positionals[2]
    if (!id) throw new Error("Usage: agent-1 session delete <id>")
    output(json, await client.deleteSession(id), `Deleted session ${id}.`)
    return
  }

  throw new Error("Usage: agent-1 session create|list|rename|delete")
}

function parseModelRef(
  value: string | undefined,
): { providerId: string; modelId: string; reasoningEffort?: string } | undefined {
  if (!value) return undefined
  const variantAt = value.indexOf("#")
  const withoutVariant = variantAt === -1 ? value : value.slice(0, variantAt)
  const reasoningEffort = variantAt === -1 ? undefined : value.slice(variantAt + 1)
  const separator = withoutVariant.indexOf("/")
  if (separator <= 0 || separator === withoutVariant.length - 1) {
    throw new Error("Model must be in provider/model format")
  }
  return {
    providerId: withoutVariant.slice(0, separator),
    modelId: withoutVariant.slice(separator + 1),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

async function modelsCommand(parsed: ParsedArgs): Promise<void> {
  const { client } = await providerClient(parsed)
  const result = await client.listModels()
  if (hasFlag(parsed, "json")) {
    output(true, result, "")
    return
  }
  for (const model of [...result.models].sort((left, right) =>
    `${left.providerId}/${left.modelId}`.localeCompare(`${right.providerId}/${right.modelId}`),
  )) {
    process.stdout.write(`${model.providerId}/${model.modelId}\n`)
  }
}

async function chatCommand(parsed: ParsedArgs): Promise<void> {
  const config = configFor(parsed)
  const status = await ensureRunning(config)
  const password = await passwordFor(config)
  const client = new AgentOneClient({ baseUrl: status.state.url, password, timeoutMs: 120_000 })

  let sessionId = flagString(parsed, "session")
  if (!sessionId) {
    const created = await client.createSession(parsed.positionals[0] === "run" ? "CLI run" : "CLI chat")
    sessionId = String(created.session.id)
    process.stdout.write(`Session: ${sessionId}\n`)
  }
  const message = flagString(parsed, "message") ?? parsed.positionals.slice(1).join(" ")
  if (!message.trim()) {
    throw new Error("Usage: agent-1 run [message...] [--session <id>] [--model provider/model#variant]")
  }
  const selection = parseModelRef(flagString(parsed, "model"))
  const started = await client.startMessage(sessionId, message, selection)
  const stream = await client.turnStreamResponse(started.turn.id)
  if (!stream.ok || !stream.body) throw new Error(`Turn stream failed (${stream.status})`)
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let printedText = false
  let finished = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf("\n\n")
      while (index >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue
          const data = line.slice(5).trim()
          if (!data) continue
          const event = JSON.parse(data) as {
            type?: string
            text?: string
            toolName?: string
            phase?: string
            status?: string
            message?: string
            attempt?: number
            delayMs?: number
          }
          if (event.type === "delta" && event.text) {
            printedText = true
            process.stdout.write(event.text)
          } else if (event.type === "tool") {
            process.stdout.write(
              `\n[tool ${event.phase ?? ""} ${event.toolName ?? ""}]\n`,
            )
          } else if (event.type === "retry") {
            process.stderr.write(
              `\n[retry ${event.attempt ?? "?"} in ${Math.ceil((event.delayMs ?? 0) / 1_000)}s: ${event.message ?? "provider error"}]\n`,
            )
          } else if (event.type === "error") {
            process.stderr.write(`\n[turn error: ${event.message ?? "unknown"}]\n`)
          } else if (event.type === "done") {
            finished = true
            if (!printedText && event.status === "completed") {
              const current = await client.getTurn(started.turn.id)
              const last = [...current.messages]
                .reverse()
                .find((entry) => (entry as { role?: string }).role === "assistant")
              if (last && typeof (last as { text?: unknown }).text === "string") {
                process.stdout.write((last as { text: string }).text)
              }
            }
            process.stdout.write(`\n[turn ${event.status ?? "done"}]\n`)
            return
          }
        }
        index = buffer.indexOf("\n\n")
      }
    }
    if (!finished) {
      const current = await client.getTurn(started.turn.id)
      if (!printedText) {
        const last = [...current.messages]
          .reverse()
          .find((entry) => (entry as { role?: string }).role === "assistant")
        if (last && typeof (last as { text?: unknown }).text === "string") {
          process.stdout.write((last as { text: string }).text)
        }
      }
      process.stdout.write(`\n[turn ${current.turn.status}]\n`)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function rulesCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1]
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password })

  if (sub === "list" || !sub) {
    const result = await client.listRules()
    if (json) {
      output(true, result, "")
      return
    }
    for (const rule of result.rules) {
      process.stdout.write(
        `${rule.id}  ${rule.position.toString().padStart(3, " ")}  ${rule.effect.padEnd(5)}  ${rule.action}  ${rule.resource}${rule.note ? `  # ${rule.note}` : ""}\n`,
      )
    }
    return
  }

  if (sub === "add") {
    const effect = flagString(parsed, "effect")
    if (effect !== "allow" && effect !== "ask" && effect !== "deny") {
      throw new Error("Usage: agent-1 rules add --action <action> --resource <resource> --effect allow|ask|deny")
    }
    const action = flagString(parsed, "action")
    const resource = flagString(parsed, "resource") ?? "*"
    if (!action) throw new Error("Action is required")
    const position = flagString(parsed, "position")
    const note = flagString(parsed, "note") ?? null
    const result = await client.createRule({
      action,
      resource,
      effect,
      ...(position ? { position: Number(position) } : {}),
      note,
    })
    output(json, result, `Created rule ${result.rule.id}.`)
    return
  }

  const id = parsed.positionals[2]
  if (!id) throw new Error("Rule id is required")

  if (sub === "update") {
    const effect = flagString(parsed, "effect")
    if (effect !== undefined && effect !== "allow" && effect !== "ask" && effect !== "deny") {
      throw new Error("Effect must be allow, ask, or deny")
    }
    const position = flagString(parsed, "position")
    const result = await client.updateRule(id, {
      ...(effect ? { effect } : {}),
      ...(position ? { position: Number(position) } : {}),
      ...(flagString(parsed, "action") ? { action: flagString(parsed, "action")! } : {}),
      ...(flagString(parsed, "resource") ? { resource: flagString(parsed, "resource")! } : {}),
      ...(flagString(parsed, "note") !== undefined ? { note: flagString(parsed, "note") ?? null } : {}),
    })
    output(json, result, `Updated rule ${result.rule.id}.`)
    return
  }

  if (sub === "remove") {
    const result = await client.removeRule(id)
    output(json, result, `Removed rule ${id}.`)
    return
  }

  throw new Error("Usage: agent-1 rules list|add|update|remove")
}

async function approvalsCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1]
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password })

  if (sub === "list" || !sub) {
    const statusFilter = flagString(parsed, "status")
    const result = await client.listApprovals(statusFilter as never)
    if (json) {
      output(true, result, "")
      return
    }
    if (result.approvals.length === 0) {
      process.stdout.write("No approvals.\n")
      return
    }
    for (const approval of result.approvals) {
      process.stdout.write(
        `${approval.id}  ${approval.status.padEnd(9)}  ${approval.toolName}  ${approval.argumentsHash.slice(0, 12)}\n`,
      )
    }
    return
  }

  if (sub === "config") {
    const mode = flagString(parsed, "mode")
    if (mode !== undefined && mode !== "smart" && mode !== "manual" && mode !== "off") {
      throw new Error("Mode must be smart, manual, or off")
    }
    const timeoutRaw = flagString(parsed, "timeout")
    const timeoutSeconds = timeoutRaw === undefined ? undefined : Number(timeoutRaw)
    if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
      throw new Error("Timeout must be a positive number of seconds")
    }
    const safeRoot = flagString(parsed, "safe-root")
    const smartModel = flagString(parsed, "smart-model")
    if (
      mode === undefined &&
      timeoutSeconds === undefined &&
      safeRoot === undefined &&
      smartModel === undefined
    ) {
      const result = await client.approvalConfig()
      output(json, result, JSON.stringify(result.config, null, 2))
      return
    }
    const result = await client.setApprovalConfig({
      ...(mode ? { mode } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(safeRoot !== undefined ? { writeSafeRoot: safeRoot || null } : {}),
      ...(smartModel !== undefined ? { smartModel: smartModel || null } : {}),
    })
    output(json, result, JSON.stringify(result.config, null, 2))
    return
  }

  if (sub === "grants") {
    const result = await client.listApprovalGrants()
    if (json) {
      output(true, result, "")
      return
    }
    for (const grant of result.grants) {
      process.stdout.write(`${grant.id}  ${grant.scope.padEnd(7)}  ${grant.patternKey}\n`)
    }
    return
  }

  if (sub === "revoke-grant") {
    const grantId = parsed.positionals[2]
    if (!grantId) throw new Error("Usage: agent-1 approvals revoke-grant <id>")
    output(json, await client.deleteApprovalGrant(grantId), `Removed approval grant ${grantId}.`)
    return
  }

  const id = parsed.positionals[2]
  if (!id) throw new Error("Approval id is required")

  if (sub === "show") {
    const result = await client.getApproval(id)
    if (json) {
      output(true, result, "")
      return
    }
    process.stdout.write(JSON.stringify(result.approval, null, 2) + "\n")
    return
  }

  if (sub === "approve" || sub === "reject") {
    const scope = flagString(parsed, "scope")
    if (scope !== undefined && scope !== "once" && scope !== "session" && scope !== "always") {
      throw new Error("Scope must be once, session, or always")
    }
    const result = await client.decideApproval(id, sub === "approve" ? "approve" : "reject", {
      ...(scope ? { scope } : {}),
      ...(flagString(parsed, "reason") ? { reason: flagString(parsed, "reason")! } : {}),
    })
    output(json, result, `Approval ${id}: ${result.approval.status}.`)
    return
  }

  throw new Error("Usage: agent-1 approvals list|show|approve|reject")
}

async function auditCommand(parsed: ParsedArgs): Promise<void> {
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password })
  const limit = Number(flagString(parsed, "limit") ?? "100")
  const result = await client.listAudit(Number.isFinite(limit) ? limit : 100)
  if (json) {
    output(true, result, "")
    return
  }
  for (const entry of result.entries) {
    process.stdout.write(
      `${entry.at}  ${entry.actor}  ${entry.action}  ${entry.decision}  ${entry.resource}\n`,
    )
  }
}

async function checkpointCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1]
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password })

  if (sub === "list" || !sub) {
    const limit = Number(flagString(parsed, "limit") ?? "100")
    const result = await client.listCheckpoints(Number.isFinite(limit) ? limit : 100)
    if (json) {
      output(true, result, "")
      return
    }
    for (const checkpoint of result.checkpoints) {
      process.stdout.write(
        `${checkpoint.id}  ${checkpoint.commit.slice(0, 8)}  ${checkpoint.rootPath}  ${checkpoint.reason}\n`,
      )
    }
    return
  }
  if (sub === "show") {
    const id = parsed.positionals[2]
    if (!id) throw new Error("Usage: agent-1 checkpoints show <id>")
    const result = await client.getCheckpoint(id)
    output(json, result, JSON.stringify(result.checkpoint, null, 2))
    return
  }
  if (sub === "diff") {
    const id = parsed.positionals[2]
    if (!id) throw new Error("Usage: agent-1 checkpoints diff <id>")
    const result = await client.diffCheckpoint(id)
    output(json, result, `${result.diff.stat}\n${result.diff.diff}`.trim())
    return
  }
  if (sub === "restore") {
    const id = parsed.positionals[2]
    if (!id) throw new Error("Usage: agent-1 checkpoints restore <id> [--file <path>] [--unsafe]")
    const filePath = flagString(parsed, "file")
    const result = await client.restoreCheckpoint(id, {
      ...(filePath ? { filePath } : {}),
      ...(hasFlag(parsed, "unsafe") ? { safe: false } : {}),
    })
    output(
      json,
      result,
      `Restored ${result.result.restoredTo}: ${result.result.restoredFiles.length} files, ${result.result.deletedFiles.length} deleted, ${result.result.skippedUserEdits.length} skipped user edits.`,
    )
    return
  }
  throw new Error("Usage: agent-1 checkpoints list|show|diff|restore")
}

async function memoryCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1]
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password })

  if (sub === "list" || !sub) {
    const result = await client.getMemory()
    if (json) {
      output(true, result, "")
      return
    }
    for (const store of [result.user, result.memory]) {
      process.stdout.write(`${store.store.toUpperCase()}  ${store.usage.chars}/${store.usage.limit} chars (${store.usage.percent}%)\n`)
      if (store.entries.length === 0) process.stdout.write("  (empty)\n")
      for (const entry of store.entries) process.stdout.write(`  - ${entry}\n`)
    }
    process.stdout.write(`Pending: ${result.pending.length}  History: ${result.history.length}\n`)
    return
  }

  if (sub === "pending") {
    const result = await client.listMemoryPending()
    if (json) {
      output(true, result, "")
      return
    }
    if (result.pending.length === 0) {
      process.stdout.write("No pending memory changes.\n")
      return
    }
    for (const pending of result.pending) {
      process.stdout.write(`${pending.id}  ${pending.action.padEnd(6)} ${pending.store}  ${pending.summary}\n`)
    }
    return
  }

  if (sub === "approve" || sub === "reject") {
    const id = parsed.positionals[2]
    if (!id) throw new Error(`Usage: agent-1 memory ${sub} <id>`)
    const reason = flagString(parsed, "reason")
    const result = await client.decideMemoryPending(id, sub === "approve" ? "approve" : "reject", reason)
    output(json, result, sub === "approve" ? `Approved pending memory change ${id}.` : `Rejected pending memory change ${id}.`)
    return
  }

  if (sub === "undo") {
    const result = await client.undoMemory(parsed.positionals[2])
    output(json, result, result.mutation.message)
    return
  }

  if (sub === "export") {
    const text = await client.exportMemory()
    if (json) {
      output(true, { markdown: text }, "")
    } else {
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
    }
    return
  }

  throw new Error("Usage: agent-1 memory list|pending|approve|reject|undo|export")
}

async function sessionsCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1]
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password })

  if (sub === "search") {
    const query = parsed.positionals.slice(2).join(" ").trim()
    if (!query) throw new Error("Usage: agent-1 sessions search <query>")
    const limitRaw = flagString(parsed, "limit")
    const sort = flagString(parsed, "sort")
    const result = await client.searchSessions({
      query,
      ...(limitRaw ? { limit: Number(limitRaw) } : {}),
      ...(sort === "newest" || sort === "oldest" || sort === "relevance" ? { sort } : {}),
    })
    if (json) {
      output(true, result, "")
      return
    }
    if (!result.ok) {
      process.stderr.write(`${result.error ?? "Search failed"}\n`)
      return
    }
    for (const group of result.results ?? []) {
      process.stdout.write(`${group.sessionId}  ${group.title}\n`)
      for (const match of group.matches) {
        process.stdout.write(`  ${match.role}: ${match.snippet}\n`)
      }
    }
    return
  }

  if (sub === "show") {
    const id = parsed.positionals[2]
    if (!id) throw new Error("Usage: agent-1 sessions show <id>")
    const result = await client.searchSessions({ sessionId: id })
    if (json) {
      output(true, result, "")
      return
    }
    if (!result.ok) {
      process.stderr.write(`${result.error ?? "Session not found"}\n`)
      return
    }
    process.stdout.write(`${result.title ?? id}\n`)
    for (const message of result.messages ?? []) {
      process.stdout.write(`[${message.role}] ${message.text}\n`)
    }
    return
  }

  throw new Error("Usage: agent-1 sessions search <query>|show <id>")
}

async function toolsCommand(parsed: ParsedArgs): Promise<void> {
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password })
  const result = await client.listTools()
  if (json) {
    output(true, result, "")
    return
  }
  for (const tool of result.tools) {
    process.stdout.write(
      `${tool.name.padEnd(20)} ${tool.risk.padEnd(8)} ${tool.action}${tool.approvalRequired === false ? "" : tool.readOnly ? "" : "  (approval)"}\n`,
    )
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv)
  const command = parsed.positionals[0]

  if (command === "version" || hasFlag(parsed, "version") || command === "-v") {
    process.stdout.write(`${CLI_NAME} ${VERSION}\n`)
    return 0
  }
  if (command === "pair" && (hasFlag(parsed, "help") || parsed.positionals.includes("-h"))) {
    process.stdout.write(PAIR_HELP)
    return 0
  }
  if (command === "help" || hasFlag(parsed, "help") || command === "-h") {
    printHelp()
    return 0
  }
  if (!command && !(process.stdin.isTTY && process.stdout.isTTY)) {
    printHelp()
    return 0
  }

  try {
    if (!command) return await launchTui()
    if (command === "onboard") {
      await onboardCommand(parsed)
      return 0
    }
    if (command === "update" || command === "upgrade") {
      await updateCommand(parsed)
      return 0
    }
    if (command === "status") {
      await serviceCommand({ ...parsed, positionals: ["service", "status", ...parsed.positionals.slice(1)] })
      return 0
    }
    if (command === "service") {
      await serviceCommand(parsed)
      return 0
    }
    if (command === "auth") {
      await authCommand(parsed)
      return 0
    }
    if (command === "pair") {
      await pairCommand(parsed)
      return 0
    }
    if (command === "remote") {
      await remoteCommand(parsed)
      return 0
    }
    if (command === "session") {
      await sessionCommand(parsed)
      return 0
    }
    if (command === "models") {
      await modelsCommand(parsed)
      return 0
    }
    if (command === "tui") {
      return await launchTui()
    }
    if (command === "run" || command === "chat") {
      await chatCommand(parsed)
      return 0
    }
    if (command === "rules") {
      await rulesCommand(parsed)
      return 0
    }
    if (command === "approvals") {
      await approvalsCommand(parsed)
      return 0
    }
    if (command === "audit") {
      await auditCommand(parsed)
      return 0
    }
    if (command === "checkpoints") {
      await checkpointCommand(parsed)
      return 0
    }
    if (command === "tools") {
      await toolsCommand(parsed)
      return 0
    }
    if (command === "memory") {
      await memoryCommand(parsed)
      return 0
    }
    if (command === "sessions") {
      await sessionsCommand(parsed)
      return 0
    }
    process.stderr.write(`Unknown command: ${command}\n\n`)
    printHelp(process.stderr)
    return 1
  } catch (error) {
    if (error instanceof CliCancelled) return 130
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const exitCode = await main(process.argv.slice(2))
if (process.exitCode === undefined) process.exitCode = exitCode
