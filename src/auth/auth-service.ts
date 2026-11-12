import { newToken, sha256 } from "../core/ids"
import { isExpired, nowPlusSeconds } from "../core/time"
import type { Logger } from "../core/log"
import type { Database } from "../db/database"
import type { SecretStore } from "./secret-store"
import { generatePassword, hashPassword, verifyPassword } from "./password"

export const PASSWORD_HASH_KEY = "auth.password_hash"
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
export const PAIRING_TTL_SECONDS = 5 * 60

export interface SessionToken {
  readonly token: string
  readonly expiresAt: string
}

export interface PairingToken {
  readonly token: string
  readonly expiresAt: string
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, { failures: number; blockedUntil: number }>()

  constructor(
    private readonly maxFailures = 5,
    private readonly blockMs = 5 * 60 * 1000,
  ) {}

  check(key: string): void {
    const entry = this.attempts.get(key)
    if (!entry) return
    if (entry.blockedUntil > Date.now()) {
      const seconds = Math.ceil((entry.blockedUntil - Date.now()) / 1000)
      throw new Error(`Too many login attempts. Try again in ${seconds} seconds.`)
    }
    if (entry.blockedUntil !== 0 && entry.blockedUntil <= Date.now()) {
      this.attempts.delete(key)
    }
  }

  fail(key: string): void {
    const entry = this.attempts.get(key) ?? { failures: 0, blockedUntil: 0 }
    entry.failures += 1
    if (entry.failures >= this.maxFailures) {
      entry.blockedUntil = Date.now() + this.blockMs
      entry.failures = 0
    }
    this.attempts.set(key, entry)
  }

  succeed(key: string): void {
    this.attempts.delete(key)
  }
}

export class AuthService {
  private readonly limiter: LoginRateLimiter
  // Pairing links are intentionally process-local and one-time. A daemon
  // restart invalidates unused links, matching OpenCode's 5-minute cache.
  private readonly pairingTokens = new Map<string, number>()

  constructor(
    private readonly db: Database,
    private readonly secrets: SecretStore,
    private readonly logger: Logger,
    limiter = new LoginRateLimiter(),
  ) {
    this.limiter = limiter
  }

  async initialize(): Promise<void> {
    const existing = await this.db.getSetting(PASSWORD_HASH_KEY)
    if (existing) {
      const stored = await this.secrets.readPassword()
      if (!stored) this.logger.warn("auth.password_secret_missing")
      return
    }

    const password = generatePassword()
    const hash = await hashPassword(password)
    await this.db.setSetting(PASSWORD_HASH_KEY, hash)
    await this.secrets.writePassword(password)
    this.logger.info("auth.password_created")
  }

  async showPassword(): Promise<string | undefined> {
    return this.secrets.readPassword()
  }

  async verifyPassword(password: string): Promise<boolean> {
    const hash = await this.db.getSetting(PASSWORD_HASH_KEY)
    if (!hash) return false
    return verifyPassword(password, hash)
  }

  async login(password: string, rateKey = "local"): Promise<SessionToken | null> {
    this.limiter.check(rateKey)
    if (!(await this.verifyPassword(password))) {
      this.limiter.fail(rateKey)
      return null
    }
    this.limiter.succeed(rateKey)
    return this.createSessionToken()
  }

  async createSessionToken(): Promise<SessionToken> {
    const token = newToken(32)
    const expiresAt = nowPlusSeconds(SESSION_TTL_SECONDS)
    await this.db.createAuthSession(sha256(token), expiresAt)
    return { token, expiresAt }
  }

  async verifySessionToken(token: string): Promise<{ sessionId: string; expiresAt: string } | null> {
    if (!token) return null
    const record = await this.db.findAuthSession(sha256(token))
    if (!record) return null
    return { sessionId: record.id, expiresAt: record.expiresAt }
  }

  async logout(sessionId: string | null): Promise<void> {
    if (sessionId) await this.db.deleteAuthSession(sessionId)
  }

  async createPairingToken(): Promise<PairingToken> {
    this.prunePairingTokens()
    const token = newToken(32)
    const expiresAt = nowPlusSeconds(PAIRING_TTL_SECONDS)
    this.pairingTokens.set(sha256(token), Date.parse(expiresAt))
    return { token, expiresAt }
  }

  async consumePairingToken(token: string): Promise<SessionToken | null> {
    if (!token) return null
    this.prunePairingTokens()
    const tokenHash = sha256(token)
    const expiresAt = this.pairingTokens.get(tokenHash)
    if (expiresAt === undefined) return null
    this.pairingTokens.delete(tokenHash)
    if (expiresAt <= Date.now()) return null
    return this.createSessionToken()
  }

  async rotatePassword(): Promise<string> {
    const password = generatePassword()
    const hash = await hashPassword(password)
    await this.db.setSetting(PASSWORD_HASH_KEY, hash)
    await this.secrets.writePassword(password)
    await this.db.deleteAllAuthSessions()
    await this.db.deleteAllPairingTokens()
    this.pairingTokens.clear()
    this.logger.info("auth.password_rotated")
    return password
  }

  async pruneExpired(): Promise<void> {
    await this.db.pruneExpiredAuthSessions()
    await this.db.pruneExpiredPairingTokens()
    this.prunePairingTokens()
  }

  private prunePairingTokens(): void {
    const now = Date.now()
    for (const [token, expiresAt] of this.pairingTokens) {
      if (expiresAt <= now) this.pairingTokens.delete(token)
    }
  }

  isExpired(value: string): boolean {
    return isExpired(value)
  }
}
