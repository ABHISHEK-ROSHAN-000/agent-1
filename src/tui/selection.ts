import type { CliRenderer, Renderable } from "@opentui/core"
import type { TuiClipboard } from "./clipboard"

type ClipboardTextRenderable = Renderable & {
  getClipboardText?: (text: string) => string
}

// Adapted from OpenCode's TUI selection copy behavior. A successful copy
// leaves the selection intact; empty or unsupported selections are handled by
// the caller so Ctrl+C can continue to prompt-clear/exit handling.
export function copySelection(
  renderer: CliRenderer,
  clipboard: TuiClipboard,
  onCopied: () => void,
  onError: (error: unknown) => void,
): boolean {
  const selection = renderer.getSelection()
  if (!selection) return false
  if (selection.isStart && selection.behavior === "cell") return false

  const text = selection.getSelectedText()
  if (!text) return false

  const focus = renderer.currentFocusedRenderable as ClipboardTextRenderable | null
  const clipboardText =
    focus?.getClipboardText && selection.selectedRenderables.includes(focus)
      ? focus.getClipboardText(text)
      : text

  void clipboard.write(clipboardText).then(onCopied).catch(onError)
  return true
}
