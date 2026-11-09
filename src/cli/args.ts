export interface ParsedArgs {
  readonly positionals: readonly string[]
  readonly flags: ReadonlyMap<string, string | true>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=")
      if (equals > 0) {
        flags.set(arg.slice(2, equals), arg.slice(equals + 1))
        continue
      }
      const name = arg.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) {
        flags.set(name, true)
      } else {
        flags.set(name, next)
        index++
      }
      continue
    }
    positionals.push(arg)
  }
  return { positionals, flags }
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === "string" ? value : undefined
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name)
}
