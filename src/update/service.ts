import { isPackaged } from "../core/runtime-layout"
import { VERSION } from "../core/version"

export const DEFAULT_UPDATE_URL =
  "https://github.com/ABHISHEK-ROSHAN-000/agent-1/releases/latest/download/latest.json"

export interface UpdateManifest {
  readonly channel: string
  readonly version: string
  readonly url: string
  readonly sha256: string
  readonly signature?: string
  readonly minimumVersion?: string
  readonly releaseNotes?: string
}

export interface UpdateStatus {
  readonly current: string
  readonly latest: string
  readonly available: boolean
  readonly manifest?: UpdateManifest
}

function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function validManifest(value: unknown): UpdateManifest | null {
  if (!value || typeof value !== "object") return null
  const input = value as Record<string, unknown>
  if (
    typeof input.channel !== "string" ||
    typeof input.version !== "string" ||
    typeof input.url !== "string" ||
    typeof input.sha256 !== "string" ||
    !parseVersion(input.version)
  ) {
    return null
  }
  return {
    channel: input.channel,
    version: input.version,
    url: input.url,
    sha256: input.sha256,
    ...(typeof input.signature === "string" ? { signature: input.signature } : {}),
    ...(typeof input.minimumVersion === "string" ? { minimumVersion: input.minimumVersion } : {}),
    ...(typeof input.releaseNotes === "string" ? { releaseNotes: input.releaseNotes } : {}),
  }
}

export async function fetchUpdateManifest(
  url = process.env.AGENT1_UPDATE_URL ?? DEFAULT_UPDATE_URL,
): Promise<UpdateManifest | null> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Update service returned HTTP ${response.status}`)
  return validManifest(await response.json())
}

export async function checkForUpdate(
  current = VERSION,
  url = process.env.AGENT1_UPDATE_URL ?? DEFAULT_UPDATE_URL,
): Promise<UpdateStatus> {
  const manifest = await fetchUpdateManifest(url)
  if (!manifest) return { current, latest: current, available: false }
  return {
    current,
    latest: manifest.version,
    available: compareVersions(manifest.version, current) > 0,
    manifest,
  }
}

export function updateInstallerUrl(manifestUrl = process.env.AGENT1_UPDATE_URL ?? DEFAULT_UPDATE_URL): string {
  return manifestUrl.endsWith("/latest.json")
    ? `${manifestUrl.slice(0, -"/latest.json".length)}/install.ps1`
    : manifestUrl.replace(/[^/]+$/, "install.ps1")
}

export function canApplyUpdates(): boolean {
  return isPackaged()
}
