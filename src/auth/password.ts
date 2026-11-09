import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto"

function derive(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

const N = 16_384
const R = 8
const P = 1
const KEY_LENGTH = 32
const SALT_LENGTH = 16

export function generatePassword(): string {
  return randomBytes(32).toString("base64url")
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await derive(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: 64 * 1024 * 1024,
  })
  return `scrypt$v1$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString("base64")}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$")
  if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== "v1") return false
  const n = Number(parts[2])
  const r = Number(parts[3])
  const p = Number(parts[4])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false
  const salt = Buffer.from(parts[5] ?? "", "base64")
  const expected = Buffer.from(parts[6] ?? "", "base64")
  if (salt.length < 8 || expected.length !== KEY_LENGTH) return false
  try {
    const derived = await derive(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * 1024 * 1024,
    })
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}
