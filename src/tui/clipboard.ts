import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type RendererClipboardBoundary,
} from "@opentui/core"

export interface TuiClipboard {
  write(text: string): Promise<void>
  dispose(): Promise<void>
}

// Adapted from the reference TUI clipboard adapter. The host clipboard is
// preferred, with OSC 52 fallback for terminals that support it.
export function createTuiClipboard(renderer: RendererClipboardBoundary): TuiClipboard {
  const clipboard = createClipboard({
    host: createHostClipboard(),
    terminal: createRendererClipboardAdapter(renderer),
  })

  return {
    async write(text: string): Promise<void> {
      const result = await clipboard.writeText(text.replaceAll("\0", ""), {
        destination: "all-available",
        selection: "clipboard",
      })
      if (result.host.status === "written" || result.terminal.status === "attempted") return
      if (result.host.status === "failed") throw result.host.error
      throw new Error(`Clipboard write failed (host: ${result.host.status}, terminal: ${result.terminal.status})`)
    },
    dispose() {
      return clipboard.dispose()
    },
  }
}
