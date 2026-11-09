import { parseArgs, flagString, hasFlag, type ParsedArgs } from "./args"
import { CLI_NAME, PRODUCT_NAME, VERSION } from "../core/version"
import { ensureDataDirs, resolveConfig, type AppConfig } from "../core/config"
import { SecretStore } from "../auth/secret-store"
import { AgentOneClient } from "../client/client"
import { autostartStatus, disableAutostart, enableAutostart } from "../daemon/autostart"
import { startService, stopService, serviceStatus } from "../daemon/service"

const HELP = `${PRODUCT_NAME} ${VERSION}

Usage: ${CLI_NAME} <command> [options]

Commands:
  service start|stop|status|restart
  service autostart on|off|status
  status
  auth show|rotate
  pair
  session create [--title <title>]
  session list
  model list
  model add --name <name> --kind cloud|local --base-url <url> --model <id> [--api-key <key>]
  model test <id>
  model default <id>
  model remove <id>
  chat --session <id> --message <text> [--model <profile-id>]
  rules list
  rules add --action <action> --resource <resource> --effect allow|ask|deny [--note <note>]
  rules update <id> [--effect ...] [--position ...] [--action ...] [--resource ...]
  rules remove <id>
  approvals list [--status pending|approved|rejected|expired|invalidated]
  approvals show <id>
  approvals approve <id>
  approvals reject <id> [--reason <text>]
  audit [--limit <n>]

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

  throw new Error("Usage: agent-1 service start|stop|status|restart|autostart")
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

  throw new Error("Usage: agent-1 auth show|rotate")
}

async function pairCommand(parsed: ParsedArgs): Promise<void> {
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password })
  const pairing = await client.pair()
  if (hasFlag(parsed, "json")) output(true, pairing, "")
  else process.stdout.write(`Pairing link: ${pairing.url}\nExpires: ${pairing.expiresAt}\n`)
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

  throw new Error("Usage: agent-1 session create|list")
}

async function modelCommand(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positionals[1]
  const json = hasFlag(parsed, "json")
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password })

  if (sub === "list" || !sub) {
    const result = await client.listModelProfiles()
    if (json) {
      output(true, result, "")
      return
    }
    if (result.profiles.length === 0) {
      process.stdout.write("No model profiles. Add one with `agent-1 model add`.\n")
      return
    }
    for (const profile of result.profiles) {
      process.stdout.write(
        `${profile.id}  ${profile.name}  ${profile.kind}  ${profile.modelId}  key=${profile.hasApiKey ? "yes" : "no"}  tools=${profile.supportsTools ? "yes" : "no"}\n`,
      )
    }
    return
  }

  if (sub === "add") {
    const name = flagString(parsed, "name")
    const kind = flagString(parsed, "kind")
    const baseUrl = flagString(parsed, "base-url")
    const modelId = flagString(parsed, "model")
    if (!name || (kind !== "cloud" && kind !== "local") || !baseUrl || !modelId) {
      throw new Error(
        "Usage: agent-1 model add --name <name> --kind cloud|local --base-url <url> --model <id> [--api-key <key>]",
      )
    }
    const contextWindow = flagString(parsed, "context-window")
    const maxOutputTokens = flagString(parsed, "max-output-tokens")
    const apiKey = flagString(parsed, "api-key") ?? process.env.AGENT1_MODEL_API_KEY
    const result = await client.createModelProfile({
      name,
      kind,
      baseUrl,
      modelId,
      ...(contextWindow ? { contextWindow: Number(contextWindow) } : {}),
      ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
      ...(apiKey ? { apiKey } : {}),
    })
    output(json, result, `Created model profile ${result.profile.id} (${result.profile.name}).`)
    return
  }

  const id = parsed.positionals[2]
  if (!id) throw new Error(`Usage: agent-1 model ${sub} <id>`)

  if (sub === "test") {
    const result = await client.testModelProfile(id)
    output(
      json,
      result,
      `Model test: ${result.ok ? "ok" : "failed"}, tools=${result.supportsTools ? "yes" : "no"}, ${result.latencyMs}ms${result.text ? `, reply=${result.text}` : ""}`,
    )
    return
  }
  if (sub === "default") {
    const result = await client.setDefaultModelProfile(id)
    output(json, result, `Default model: ${result.profile.name} (${result.profile.id}).`)
    return
  }
  if (sub === "remove") {
    const result = await client.removeModelProfile(id)
    output(json, result, `Removed model profile ${id}.`)
    return
  }
  throw new Error("Usage: agent-1 model list|add|test|default|remove")
}

async function chatCommand(parsed: ParsedArgs): Promise<void> {
  const config = configFor(parsed)
  const password = await passwordFor(config)
  const status = await serviceStatus(config)
  if (status.status !== "running" || !status.state) throw new Error("Agent-1 is not running.")
  const client = new AgentOneClient({ baseUrl: status.state.url, password, timeoutMs: 120_000 })

  let sessionId = flagString(parsed, "session")
  if (!sessionId) {
    const created = await client.createSession("CLI chat")
    sessionId = String(created.session.id)
    process.stdout.write(`Session: ${sessionId}\n`)
  }
  const message = flagString(parsed, "message") ?? parsed.positionals.slice(1).join(" ")
  if (!message.trim()) {
    throw new Error("Usage: agent-1 chat --session <id> --message <text> [--model <profile-id>]")
  }
  const modelProfileId = flagString(parsed, "model")
  const started = await client.startMessage(sessionId, message, modelProfileId)
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
          }
          if (event.type === "delta" && event.text) {
            printedText = true
            process.stdout.write(event.text)
          } else if (event.type === "tool") {
            process.stdout.write(
              `\n[tool ${event.phase ?? ""} ${event.toolName ?? ""}]\n`,
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
    const result = await client.decideApproval(id, sub === "approve" ? "approve" : "reject", {
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

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv)
  const command = parsed.positionals[0]

  if (command === "version" || hasFlag(parsed, "version") || command === "-v") {
    process.stdout.write(`${CLI_NAME} ${VERSION}\n`)
    return 0
  }
  if (!command || command === "help" || hasFlag(parsed, "help") || command === "-h") {
    printHelp()
    return 0
  }

  try {
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
    if (command === "session") {
      await sessionCommand(parsed)
      return 0
    }
    if (command === "model") {
      await modelCommand(parsed)
      return 0
    }
    if (command === "chat") {
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
    process.stderr.write(`Unknown command: ${command}\n\n`)
    printHelp(process.stderr)
    return 1
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
