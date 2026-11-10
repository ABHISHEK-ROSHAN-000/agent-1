import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(self), microphone=(), geolocation=()",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
}

function placeholder(): Response {
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;background:#0b0b0c;color:#eee;padding:3rem">
      <h1>Agent-1 web UI is not built</h1>
      <p>Run <code>bun run web:build</code> from the project root, then restart the daemon.</p>
    </body></html>`,
    {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  )
}

function fileResponse(filePath: string, cacheControl: string): Response {
  const bytes = readFileSync(filePath)
  const headers: Record<string, string> = {
    "content-type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "cache-control": cacheControl,
    ...SECURITY_HEADERS,
  }
  return new Response(bytes, { status: 200, headers })
}

export function serveWeb(webRoot: string, pathname: string): Response {
  const indexPath = path.join(webRoot, "index.html")
  if (!existsSync(indexPath)) return placeholder()

  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return new Response("Bad request", { status: 400 })
  }

  const requested = decoded === "/" ? "/index.html" : decoded
  const candidate = path.resolve(webRoot, `.${requested}`)
  const root = path.resolve(webRoot)
  const inRoot =
    candidate === root ||
    candidate.startsWith(`${root}${path.sep}`) ||
    (process.platform === "win32" && candidate.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`))
  if (!inRoot) return new Response("Not found", { status: 404 })

  if (existsSync(candidate) && statSync(candidate).isFile()) {
    const extension = path.extname(candidate).toLowerCase()
    const cache =
      candidate === indexPath
        ? "no-store"
        : extension === ".html" || candidate.endsWith("sw.js") || candidate.endsWith("manifest.webmanifest")
          ? "no-cache"
          : "public, max-age=31536000, immutable"
    return fileResponse(candidate, cache)
  }

  const hasExtension = path.extname(decoded) !== ""
  if (hasExtension) return new Response("Not found", { status: 404 })

  // SPA routes such as /login and /sessions/:id fall back to the app shell.
  return fileResponse(indexPath, "no-store")
}
