export function nowIso(): string {
  return new Date().toISOString()
}

export function nowPlusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

export function isExpired(value: string, now = Date.now()): boolean {
  const timestamp = Date.parse(value)
  return !Number.isFinite(timestamp) || timestamp <= now
}
