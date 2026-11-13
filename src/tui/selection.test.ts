import { describe, expect, test } from "bun:test"
import type { CliRenderer } from "@opentui/core"
import type { TuiClipboard } from "./clipboard"
import { copySelection } from "./selection"

function renderer(selection: {
  isStart?: boolean
  behavior?: "cell" | "word" | "line"
  text?: string
} | null): { renderer: CliRenderer; cleared: () => boolean } {
  let cleared = false
  const value = {
    getSelection: () =>
      selection
        ? {
            isStart: selection.isStart ?? false,
            behavior: selection.behavior ?? "line",
            selectedRenderables: [],
            getSelectedText: () => selection.text ?? "",
          }
        : null,
    currentFocusedRenderable: null,
    clearSelection: () => {
      cleared = true
    },
  }
  return { renderer: value as unknown as CliRenderer, cleared: () => cleared }
}

function clipboard(write: (text: string) => Promise<void>): TuiClipboard {
  return { write, dispose: async () => undefined }
}

describe("TUI selection copy", () => {
  test("copies highlighted text without clearing the selection", async () => {
    const { renderer: target, cleared } = renderer({ text: "selected text" })
    const writes: string[] = []
    let copied = 0
    const result = copySelection(
      target,
      clipboard(async (text) => {
        writes.push(text)
      }),
      () => {
        copied += 1
      },
      () => undefined,
    )
    await Promise.resolve()
    expect(result).toBe(true)
    expect(writes).toEqual(["selected text"])
    expect(copied).toBe(1)
    expect(cleared()).toBe(false)
  })

  test("returns false for no selection, empty text, or cell-start selection", () => {
    expect(copySelection(renderer(null).renderer, clipboard(async () => undefined), () => undefined, () => undefined)).toBe(false)
    expect(
      copySelection(
        renderer({ text: "" }).renderer,
        clipboard(async () => undefined),
        () => undefined,
        () => undefined,
      ),
    ).toBe(false)
    expect(
      copySelection(
        renderer({ isStart: true, behavior: "cell", text: "cell" }).renderer,
        clipboard(async () => undefined),
        () => undefined,
        () => undefined,
      ),
    ).toBe(false)
  })

  test("reports clipboard write failures without throwing from the key handler", async () => {
    const { renderer: target } = renderer({ text: "selected" })
    let failure: unknown
    const result = copySelection(
      target,
      clipboard(async () => {
        throw new Error("clipboard unavailable")
      }),
      () => undefined,
      (error) => {
        failure = error
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(result).toBe(true)
    expect(failure).toBeInstanceOf(Error)
  })
})
