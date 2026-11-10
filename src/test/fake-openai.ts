interface ChatMessage {
  readonly role: string
  readonly content?: unknown
  readonly tool_calls?: Array<{
    readonly id: string
    readonly type?: string
    readonly function?: { name?: string; arguments?: string }
  }>
  readonly tool_call_id?: string
  readonly name?: string
}

interface ChatRequest {
  readonly model?: string
  readonly stream?: boolean
  readonly messages?: ChatMessage[]
  readonly tools?: Array<{ readonly function?: { readonly name?: string } }>
  readonly reasoning_effort?: string
  readonly reasoning?: { readonly effort?: string }
}

export interface FakeOpenAI {
  readonly url: string
  readonly requests: ChatRequest[]
  failNext(status?: number, headers?: Record<string, string>): void
  close(): void
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        return String((part as { text?: unknown }).text ?? "")
      }
      return ""
    })
    .join("")
}

function completionBody(model: string, text: string, finishReason = "stop") {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  }
}

function toolCompletionBody(
  model: string,
  name: string,
  args: Record<string, unknown>,
  id = "call_fake_1",
) {
  return {
    id: "chatcmpl-fake-tool",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  }
}

function sseChunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

export function startFakeOpenAI(): FakeOpenAI {
  const requests: ChatRequest[] = []
  let failure: { status: number; headers: Record<string, string> } | undefined
  let server: ReturnType<typeof Bun.serve>
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return new Response("not found", { status: 404 })
      }
      const body = (await request.json()) as ChatRequest
      requests.push(body)
      if (failure) {
        const current = failure
        failure = undefined
        return Response.json(
          { error: { message: "Fake provider failure" } },
          {
            status: current.status,
            headers: { "content-type": "application/json", ...current.headers },
          },
        )
      }
      const model = body.model ?? "fake-model"
      const messages = body.messages ?? []
      const last = messages[messages.length - 1]
      const userText = messages
        .filter((message) => message.role === "user")
        .map((message) => contentText(message.content))
        .join("\n")
      const systemText = messages
        .filter((message) => message.role === "system")
        .map((message) => contentText(message.content))
        .join("\n")
      const hasToolResult = last?.role === "tool" || last?.role === "tool_result"
      const toolNames = body.tools?.map((entry) => entry.function?.name ?? "") ?? []
      const wantsEcho = /test_echo|echo/i.test(userText) && toolNames.includes("test_echo")
      const wantsConfirm = /confirm/i.test(userText) && toolNames.includes("test_confirm")
      const wantsLoop = /loop/i.test(userText) && toolNames.includes("test_echo")
      const slow = /slow/i.test(userText)
      const isSummarize = /summarize the earlier conversation/i.test(userText) || /summarize/i.test(systemText)
      const applyMatch = /apply moves:\s*(\{[\s\S]*\})/i.exec(userText)
      const stream = body.stream === true

      let text = `Fake response: ${userText.slice(0, 200)}`
      if (isSummarize) text = "Earlier conversation summary: the user discussed setup and preferences."
      else if (hasToolResult) text = "The tool returned a result. Fake final answer."

      let tool: { name: string; args: Record<string, unknown> } | undefined
      if (applyMatch && toolNames.includes("fs_apply_moves") && !hasToolResult) {
        tool = { name: "fs_apply_moves", args: JSON.parse(applyMatch[1]!) as Record<string, unknown> }
      } else if (wantsLoop) tool = { name: "test_echo", args: { message: "loop" } }
      else if (wantsConfirm && !hasToolResult) {
        tool = { name: "test_confirm", args: { note: "confirm from fake" } }
      } else if (wantsEcho && !hasToolResult) {
        tool = { name: "test_echo", args: { message: "hello from fake" } }
      }
      if (isSummarize) tool = undefined

      if (!stream) {
        if (tool) return Response.json(toolCompletionBody(model, tool.name, tool.args))
        return Response.json(completionBody(model, text))
      }

      const encoder = new TextEncoder()
      const streamBody = new ReadableStream<Uint8Array>({
        async start(controller) {
          const delay = slow ? 150 : 0
          const push = (chunk: string) => controller.enqueue(encoder.encode(chunk))
          if (tool) {
            push(
              sseChunk(model, {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fake_1",
                    type: "function",
                    function: { name: tool.name, arguments: "" },
                  },
                ],
              }),
            )
            if (delay) await Bun.sleep(delay)
            push(
              sseChunk(model, {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: JSON.stringify(tool.args) },
                  },
                ],
              }),
            )
            push(sseChunk(model, {}, "tool_calls"))
          } else {
            const words = text.split(/(\s+)/)
            for (const word of words) {
              push(sseChunk(model, { content: word }))
              if (delay) await Bun.sleep(delay)
            }
            push(sseChunk(model, {}, "stop"))
          }
          push("data: [DONE]\n\n")
          controller.close()
        },
      })
      return new Response(streamBody, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    failNext(status = 500, headers = {}) {
      failure = { status, headers }
    },
    close: () => server.stop(true),
  }
}
