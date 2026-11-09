import type { TurnStatus } from "../shared/types"

export type TurnStreamEvent =
  | { readonly type: "status"; readonly status: TurnStatus }
  | { readonly type: "delta"; readonly text: string }
  | {
      readonly type: "tool"
      readonly phase: "start" | "done"
      readonly toolName: string
      readonly toolCallId: string
    }
  | { readonly type: "done"; readonly status: TurnStatus }
  | { readonly type: "error"; readonly message: string }

type Listener = (event: TurnStreamEvent) => void

export class TurnBus {
  private readonly listeners = new Map<string, Set<Listener>>()

  subscribe(turnId: string, listener: Listener): () => void {
    let set = this.listeners.get(turnId)
    if (!set) {
      set = new Set()
      this.listeners.set(turnId, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(turnId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(turnId)
    }
  }

  publish(turnId: string, event: TurnStreamEvent): void {
    const set = this.listeners.get(turnId)
    if (!set) return
    for (const listener of set) {
      try {
        listener(event)
      } catch {
        // A stream listener must not affect the turn.
      }
    }
  }
}
