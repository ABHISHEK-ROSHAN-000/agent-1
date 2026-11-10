import { afterEach, describe, expect, test } from "bun:test"
import { createServer as createHttpServer, type Server } from "node:http"
import { createConnection, type Socket } from "node:net"
import { startTunnelProxy, VisitorLimiter, type TunnelProxy } from "./tunnel-proxy"

const cleanups: Array<() => Promise<void>> = []
const sockets: Socket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") reject(new Error("no port"))
      else resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

function proxyHeader(visitor = "203.0.113.7"): Buffer {
  const signature = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a])
  const header = Buffer.alloc(28)
  signature.copy(header, 0)
  header[12] = 0x21
  header[13] = 0x11
  header.writeUInt16BE(12, 14)
  header.set(visitor.split(".").map(Number), 16)
  header.set([127, 0, 0, 1], 20)
  header.writeUInt16BE(54321, 24)
  header.writeUInt16BE(443, 26)
  return header
}

async function rawRequest(port: number, request: string, header = proxyHeader()): Promise<string> {
  const socket = createConnection(port, "127.0.0.1")
  sockets.push(socket)
  const response = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    socket.on("data", (chunk: Buffer) => chunks.push(chunk))
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    socket.on("error", reject)
  })
  socket.write(Buffer.concat([header, Buffer.from(request, "utf8")]))
  return response
}

describe("remote tunnel bridge", () => {
  test("strips PROXY v2 and forwards the visitor address", async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    const upstream = createHttpServer((request, response) => {
      seen = { ...request.headers }
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("ok")
    })
    const upstreamPort = await listen(upstream)
    cleanups.push(() => close(upstream))

    let proxy: TunnelProxy | undefined
    proxy = await startTunnelProxy({ targetHost: "127.0.0.1", targetPort: upstreamPort })
    cleanups.push(() => proxy!.close())

    const response = await rawRequest(
      proxy.port,
      [
        "GET /v1/health HTTP/1.1",
        "Host: agent1.example.test",
        "X-Agent1-Visitor: 198.51.100.9",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    )

    expect(response).toContain("HTTP/1.1 200 OK")
    expect(response).toContain("ok")
    expect(seen["x-agent1-visitor"]).toBe("203.0.113.7")
    expect(seen["x-forwarded-for"]).toBe("203.0.113.7")
    expect(seen["x-forwarded-proto"]).toBe("https")
    expect(seen.host).toBe("agent1.example.test")
  })

  test("rate-limits login attempts per visitor", () => {
    const limiter = new VisitorLimiter()
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(limiter.check("203.0.113.7", "/v1/auth/login")).toBeUndefined()
    }
    expect(limiter.check("203.0.113.7", "/v1/auth/login")).toBeNumber()
    expect(limiter.check("198.51.100.4", "/v1/auth/login")).toBeUndefined()
  })
})
