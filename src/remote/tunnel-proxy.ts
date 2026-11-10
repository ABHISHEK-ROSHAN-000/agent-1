import { Buffer } from "node:buffer"
import {
  createServer as createHttpServer,
  request as requestUpstream,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net"
import type { Logger } from "../core/log"

const PROXY_V2_SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a])
const PROXY_V2_FIXED_HEADER = 16
const MAX_PROXY_HEADER = 65_535
const RATE_WINDOW_MS = 60_000
const MAX_REQUESTS_PER_WINDOW = 900
const MAX_LOGIN_REQUESTS_PER_WINDOW = 10

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export interface TunnelProxy {
  readonly port: number
  close(): Promise<void>
}

interface TunnelProxyOptions {
  readonly targetHost: string
  readonly targetPort: number
  readonly logger?: Logger
}

interface VisitorWindow {
  windowStart: number
  requests: number
  logins: number
}

export class VisitorLimiter {
  private readonly windows = new Map<string, VisitorWindow>()

  check(visitor: string, path: string): number | undefined {
    const now = Date.now()
    let window = this.windows.get(visitor)
    if (!window || now - window.windowStart >= RATE_WINDOW_MS) {
      window = { windowStart: now, requests: 0, logins: 0 }
      this.windows.set(visitor, window)
      if (this.windows.size > 4_096) this.prune(now)
    }
    window.requests += 1
    if (path === "/v1/auth/login") window.logins += 1
    if (window.requests > MAX_REQUESTS_PER_WINDOW || window.logins > MAX_LOGIN_REQUESTS_PER_WINDOW) {
      return Math.max(1, Math.ceil((window.windowStart + RATE_WINDOW_MS - now) / 1000))
    }
    return undefined
  }

  private prune(now: number): void {
    for (const [visitor, window] of this.windows) {
      if (now - window.windowStart >= RATE_WINDOW_MS) this.windows.delete(visitor)
    }
  }
}

function parseProxyVisitor(buffer: Buffer, remoteAddress: string | undefined): string | undefined {
  if (buffer.length < PROXY_V2_FIXED_HEADER) return undefined
  if (!buffer.subarray(0, PROXY_V2_SIGNATURE.length).equals(PROXY_V2_SIGNATURE)) return undefined
  const versionCommand = buffer[12]!
  if ((versionCommand >> 4) !== 2) return undefined
  const command = versionCommand & 0x0f
  if (command === 0) return remoteAddress ?? "unknown"
  if (command !== 1) return undefined
  const familyProtocol = buffer[13]!
  const family = familyProtocol >> 4
  if ((familyProtocol & 0x0f) !== 1) return undefined
  if (family === 1) {
    if (buffer.length < PROXY_V2_FIXED_HEADER + 12) return undefined
    return `${buffer[16]!}.${buffer[17]!}.${buffer[18]!}.${buffer[19]!}`
  }
  if (family === 2) {
    if (buffer.length < PROXY_V2_FIXED_HEADER + 36) return undefined
    const groups = Array.from({ length: 8 }, (_, index) =>
      buffer.readUInt16BE(PROXY_V2_FIXED_HEADER + index * 2).toString(16),
    )
    return groups.join(":")
  }
  return remoteAddress ?? "unknown"
}

function visitorFor(socket: Socket, visitors: WeakMap<Socket, string>, remoteAddress: string | undefined): string {
  return visitors.get(socket) ?? remoteAddress ?? "unknown"
}

function rateLimitedResponse(retryAfter: number): string {
  return JSON.stringify({
    error: {
      code: "rate_limited",
      message: `Too many requests. Try again in ${retryAfter} seconds.`,
    },
  })
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: TunnelProxyOptions,
  visitors: WeakMap<Socket, string>,
  limiter: VisitorLimiter,
): void {
  const visitor = visitorFor(request.socket, visitors, request.socket.remoteAddress)
  const path = (request.url ?? "/").split("?")[0] ?? "/"
  const retryAfter = limiter.check(visitor, path)
  if (retryAfter !== undefined) {
    response.writeHead(429, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "retry-after": String(retryAfter),
    })
    response.end(rateLimitedResponse(retryAfter))
    return
  }

  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue
    if (name === "x-agent1-visitor" || name === "x-forwarded-for" || name === "x-forwarded-proto") continue
    headers[name] = value
  }
  headers["x-agent1-visitor"] = visitor
  headers["x-forwarded-for"] = visitor
  headers["x-forwarded-proto"] = "https"

  const upstream = requestUpstream(
    {
      host: options.targetHost,
      port: options.targetPort,
      method: request.method,
      path: request.url ?? "/",
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    },
  )
  upstream.on("error", (error) => {
    options.logger?.warn("remote.proxy_upstream_failed", { error: error.message })
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" })
      response.end(JSON.stringify({ error: { code: "bad_gateway", message: "Remote bridge failed" } }))
    } else {
      response.destroy()
    }
  })
  request.on("aborted", () => upstream.destroy())
  response.on("close", () => upstream.destroy())
  request.pipe(upstream)
}

function acceptProxyConnection(socket: Socket, httpServer: Server, visitors: WeakMap<Socket, string>): void {
  let received = Buffer.alloc(0)
  let settled = false

  const fail = (): void => {
    if (settled) return
    settled = true
    socket.destroy()
  }
  const cleanup = (): void => {
    socket.removeListener("data", onData)
    socket.removeListener("error", fail)
    socket.setTimeout(0)
  }
  const onData = (chunk: Buffer): void => {
    if (settled) return
    received = Buffer.concat([received, chunk])
    if (received.length < PROXY_V2_FIXED_HEADER) return
    if (!received.subarray(0, PROXY_V2_SIGNATURE.length).equals(PROXY_V2_SIGNATURE)) {
      fail()
      return
    }
    const addressLength = received.readUInt16BE(14)
    const headerLength = PROXY_V2_FIXED_HEADER + addressLength
    if (headerLength > MAX_PROXY_HEADER) {
      fail()
      return
    }
    if (received.length < headerLength) return
    const visitor = parseProxyVisitor(received, socket.remoteAddress)
    if (!visitor) {
      fail()
      return
    }
    settled = true
    cleanup()
    visitors.set(socket, visitor)
    const remaining = received.subarray(headerLength)
    socket.pause()
    if (remaining.length > 0) socket.unshift(remaining)
    httpServer.emit("connection", socket)
    socket.resume()
  }

  socket.setTimeout(10_000, fail)
  socket.on("data", onData)
  socket.on("error", fail)
}

export async function startTunnelProxy(options: TunnelProxyOptions): Promise<TunnelProxy> {
  const visitors = new WeakMap<Socket, string>()
  const limiter = new VisitorLimiter()
  const sockets = new Set<Socket>()
  const httpServer = createHttpServer((request, response) => {
    handleRequest(request, response, options, visitors, limiter)
  })
  httpServer.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  })
  httpServer.on("upgrade", (_request, socket) => socket.destroy())
  httpServer.on("error", (error) => {
    options.logger?.error("remote.proxy_failed", { error: error.message })
  })
  httpServer.requestTimeout = 120_000
  httpServer.headersTimeout = 30_000
  httpServer.keepAliveTimeout = 10_000

  const netServer: NetServer = createNetServer((socket) => {
    sockets.add(socket)
    socket.setNoDelay(true)
    socket.on("close", () => sockets.delete(socket))
    acceptProxyConnection(socket, httpServer, visitors)
  })

  await new Promise<void>((resolve, reject) => {
    netServer.once("error", reject)
    netServer.listen(0, "127.0.0.1", () => resolve())
  })
  const address = netServer.address()
  if (!address || typeof address === "string") {
    await closeServers(netServer, httpServer, sockets)
    throw new Error("Remote bridge did not bind a loopback port")
  }

  return {
    port: address.port,
    async close() {
      await closeServers(netServer, httpServer, sockets)
    },
  }
}

async function closeServers(netServer: NetServer, httpServer: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all([closeServer(netServer), closeServer(httpServer)])
}

function closeServer(server: NetServer | Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}
