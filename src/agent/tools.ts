import { tool, type Tool } from "ai"
import { z } from "zod"
import { nowIso } from "../core/time"

export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType<unknown>
  readonly readOnly: boolean
  execute(input: unknown): Promise<unknown>
}

const registry: Record<string, AgentTool> = {
  test_echo: {
    name: "test_echo",
    description: "Echo a message. A read-only Phase 2 test tool.",
    inputSchema: z.object({ message: z.string().min(1).max(2_000) }),
    readOnly: true,
    async execute(input) {
      const { message } = z.object({ message: z.string().min(1).max(2_000) }).parse(input)
      return { echoed: message }
    },
  },
  test_time: {
    name: "test_time",
    description: "Return the current UTC time. A read-only Phase 2 test tool.",
    inputSchema: z.object({}),
    readOnly: true,
    async execute() {
      return { now: nowIso() }
    },
  },
}

export function toolSet(): Record<string, Tool> {
  return Object.fromEntries(
    Object.values(registry).map((entry) => [
      entry.name,
      tool({
        description: entry.description,
        inputSchema: entry.inputSchema,
      }),
    ]),
  )
}

export async function executeTool(name: string, input: unknown): Promise<unknown> {
  const entry = registry[name]
  if (!entry) throw new Error(`Unknown tool: ${name}`)
  if (!entry.readOnly) throw new Error(`Tool is not read-only: ${name}`)
  const parsed = entry.inputSchema.parse(input)
  return entry.execute(parsed)
}

export function toolNames(): string[] {
  return Object.keys(registry).sort()
}
