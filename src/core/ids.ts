import { createHash, randomBytes, randomUUID } from "node:crypto"

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function newRequestId(): string {
  return randomUUID()
}
