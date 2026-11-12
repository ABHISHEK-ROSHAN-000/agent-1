import type { ApiErrorBody } from "../shared/types"

const MAX_BODY_BYTES = 1024 * 1024

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = "HttpError"
  }
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  })
}

export function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  })
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId?: string,
  headers: Record<string, string> = {},
): Response {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      ...(requestId ? { requestId } : {}),
    },
  }
  return jsonResponse(body, status, headers)
}

export async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "Request body is too large")
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "Request body is too large")
  }
  if (bytes.byteLength === 0) return {}
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON")
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (name) cookies[name] = decodeURIComponent(value)
  }
  return cookies
}

export const LEGACY_SESSION_COOKIE = "agent1_session"

export function sessionCookieName(request: Request): string {
  try {
    const port = new URL(request.url).port
    return port ? `${LEGACY_SESSION_COOKIE}_${port}` : LEGACY_SESSION_COOKIE
  } catch {
    return LEGACY_SESSION_COOKIE
  }
}

export function sessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
  name = LEGACY_SESSION_COOKIE,
): string {
  return [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}

export function clearSessionCookie(secure: boolean, name = LEGACY_SESSION_COOKIE): string {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}

export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true
  if (!host) return false
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase()
  } catch {
    return false
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

export function normalizeHost(host: string): string | null {
  try {
    const parsed = new URL(`http://${host}`)
    let hostname = parsed.hostname.toLowerCase().replace(/\.$/, "")
    if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1)
    return hostname || null
  } catch {
    return null
  }
}

export function isHostAllowed(hostHeader: string | null, allowedHosts: readonly string[]): boolean {
  if (!hostHeader) return false
  const hostname = normalizeHost(hostHeader)
  if (!hostname) return false
  return LOOPBACK_HOSTS.has(hostname) || allowedHosts.includes(hostname)
}

export function isOriginAllowed(origin: string | null, allowedHosts: readonly string[]): boolean {
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "")
    return LOOPBACK_HOSTS.has(hostname) || allowedHosts.includes(hostname)
  } catch {
    return false
  }
}
