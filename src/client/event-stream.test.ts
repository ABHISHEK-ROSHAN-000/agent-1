import { describe, expect, test } from "bun:test"
import { SseParser } from "./event-stream"

describe("SseParser", () => {
  test("parses replayed frames across arbitrary chunk boundaries", () => {
    const parser = new SseParser()
    expect(parser.feed("id: 1\ndata: {\"seq\":1")).toEqual([])
    const frames = parser.feed(
      ",\"type\":\"session.created\",\"sessionId\":\"s\",\"payload\":{},\"createdAt\":\"now\"}\n\n: heartbeat\n\n",
    )
    expect(frames).toHaveLength(1)
    expect(frames[0]?.id).toBe("1")
    expect(JSON.parse(frames[0]!.data).seq).toBe(1)
  })

  test("preserves multiline data and retry fields", () => {
    const parser = new SseParser()
    const frames = parser.feed("retry: 1000\nevent: update\ndata: one\ndata: two\n\n")
    expect(frames[0]).toMatchObject({ event: "update", data: "one\ntwo", retry: 1000 })
  })

  test("ignores comments and incomplete frames", () => {
    const parser = new SseParser()
    expect(parser.feed(": heartbeat\n\n")).toEqual([])
    expect(parser.feed("data: partial")).toEqual([])
    expect(parser.feed("\n\n")[0]?.data).toBe("partial")
  })
})
