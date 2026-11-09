import { CLI_NAME, PHASE, PRODUCT_NAME, VERSION } from "../core/version"

const HELP = `${PRODUCT_NAME} ${VERSION}
${PHASE}

Usage: ${CLI_NAME} <command> [options]

Commands planned for later phases:
  service      start | stop | status | restart
  pair         create a one-time pairing link
  auth         show | rotate
  session      create | list
  chat         start or resume a chat session
  approvals    list | decide
  rules        list | create | update | delete
  memory       show | pending | approve | reject | undo
  skills       list | show | pending | approve | reject
  connectors   list | connect | revoke
  mcp          list | install | remove
  schedules    list | create | pause | resume | delete
  tui          open the terminal client
  remote       on --yes | off | status
  diagnose     build a redacted diagnostic bundle

Current commands:
  ${CLI_NAME} --help
  ${CLI_NAME} --version
  ${CLI_NAME} status
`

function printHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(HELP)
}

function main(argv: readonly string[]): number {
  const command = argv[0]

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return 0
  }

  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${CLI_NAME} ${VERSION}\n`)
    return 0
  }

  if (command === "status") {
    process.stdout.write(`${PRODUCT_NAME} ${VERSION} — ${PHASE}\n`)
    process.stdout.write("Daemon lifecycle is not implemented yet (Phase 1).\n")
    return 0
  }

  process.stderr.write(`Unknown command: ${command}\n\n`)
  printHelp(process.stderr)
  return 1
}

process.exitCode = main(process.argv.slice(2))
