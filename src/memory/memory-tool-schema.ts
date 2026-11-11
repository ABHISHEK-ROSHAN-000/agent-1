import { z } from "zod"

export const memoryOperationSchema = z.object({
  action: z.enum(["add", "patch", "remove"]),
  content: z.string().min(1).max(20_000).optional(),
  oldText: z.string().min(1).max(20_000).optional(),
})

export const memoryToolInputSchema = z.object({
  target: z.enum(["user", "memory"]),
  operations: z.array(memoryOperationSchema).min(1).max(50),
})

export type MemoryToolInput = z.infer<typeof memoryToolInputSchema>
