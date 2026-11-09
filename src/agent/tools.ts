import { tool, type Tool } from "ai"
import { z } from "zod"
import { nowIso } from "../core/time"
import type { ToolRisk } from "../shared/types"

export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType<unknown>
  readonly readOnly: boolean
  readonly risk: ToolRisk
  execute(input: unknown): Promise<unknown>
}

const registry: Record<string, AgentTool> = {
  test_echo: {
    name: "test_echo",
    description: "Echo a message. A read-only Phase 2 test tool.",
    inputSchema: z.object({ message: z.string().min(1).max(2_000) }),
    readOnly: true,
    risk: "read",
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
    risk: "read",
    async execute() {
      return { now: nowIso() }
    },
  },
  test_confirm: {
    name: "test_confirm",
    description: "An approval-gated Phase 3 test action. It has no side effects.",
    inputSchema: z.object({ note: z.string().min(1).max(500) }),
    readOnly: false,
    risk: "write",
    async execute(input) {
      const { note } = z.object({ note: z.string().min(1).max(500) }).parse(input)
      return { confirmed: true, note }
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
  const parsed = entry.inputSchema.parse(input)
  return entry.execute(parsed)
}

export function toolNames(): string[] {
  return Object.keys(registry).sort()
}

export function toolRisk(name: string): ToolRisk {
  return registry[name]?.risk ?? "unknown"
}
