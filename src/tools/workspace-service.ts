import { existsSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { Database } from "../db/database"
import type { Logger } from "../core/log"
import type { Workspace, WorkspaceAccess } from "../shared/types"

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceError"
  }
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalizedCandidate = path.resolve(candidate)
  if (process.platform === "win32") {
    const rootLower = normalizedRoot.toLowerCase()
    const candidateLower = normalizedCandidate.toLowerCase()
    return candidateLower === rootLower || candidateLower.startsWith(`${rootLower}${path.sep}`)
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
}

function realPathFor(pathValue: string): string {
  const absolute = path.resolve(pathValue)
  let current = absolute
  const suffix: string[] = []
  while (!existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    suffix.unshift(path.basename(current))
    current = parent
  }
  try {
    const resolved = existsSync(current) ? realpathSync.native(current) : current
    return path.resolve(resolved, ...suffix)
  } catch {
    return absolute
  }
}

export class WorkspaceService {
  private readonly sensitiveRoots: string[]

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    dataDir: string,
  ) {
    const roots = [dataDir]
    for (const envName of ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]) {
      const value = process.env[envName]
      if (value) roots.push(value)
    }
    const home = process.env.USERPROFILE
    if (home) {
      roots.push(path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".config"))
    }
    this.sensitiveRoots = roots.map((root) => path.resolve(root))
  }

  async list(): Promise<Workspace[]> {
    return this.db.listWorkspaces()
  }

  async add(input: { path: string; label?: string; access?: WorkspaceAccess }): Promise<Workspace> {
    const resolved = realPathFor(input.path)
    if (!existsSync(resolved)) throw new WorkspaceError(`Path does not exist: ${resolved}`)
    if (!statSync(resolved).isDirectory()) throw new WorkspaceError("Workspace path must be a directory")
    if (this.isSensitive(resolved)) throw new WorkspaceError("This path is protected")
    const existing = await this.list()
    if (existing.some((workspace) => this.equalPaths(workspace.path, resolved))) {
      throw new WorkspaceError("This folder is already granted")
    }
    const workspace = await this.db.createWorkspace({
      label: input.label?.trim() || path.basename(resolved),
      path: resolved,
      access: input.access ?? "read",
    })
    this.logger.info("workspace.created", { id: workspace.id, access: workspace.access })
    return workspace
  }

  async remove(id: string): Promise<boolean> {
    const workspace = await this.db.getWorkspace(id)
    if (!workspace) return false
    await this.db.deleteWorkspace(id)
    this.logger.info("workspace.removed", { id })
    return true
  }

  resolve(input: string): string {
    return realPathFor(input)
  }

  isSensitive(input: string): boolean {
    const resolved = this.resolve(input)
    return this.sensitiveRoots.some((root) => isWithin(root, resolved))
  }

  async findGrant(input: string, mode: "read" | "write"): Promise<Workspace | undefined> {
    const resolved = this.resolve(input)
    const workspaces = await this.list()
    return workspaces.find((workspace) => {
      if (!isWithin(workspace.path, resolved)) return false
      return mode === "read" || workspace.access === "write"
    })
  }

  async pathInfo(
    input: string,
    mode: "read" | "write",
  ): Promise<{ resolved: string; sensitive: boolean; grant: Workspace | undefined }> {
    const resolved = this.resolve(input)
    return {
      resolved,
      sensitive: this.isSensitive(resolved),
      grant: await this.findGrant(resolved, mode),
    }
  }

  async requireWriteGrant(input: string): Promise<Workspace> {
    const grant = await this.findGrant(input, "write")
    if (!grant) throw new WorkspaceError(`Path is not in a write-granted workspace: ${this.resolve(input)}`)
    return grant
  }

  async requireInsideGrant(input: string, root: string): Promise<string> {
    const resolved = this.resolve(input)
    if (!isWithin(this.resolve(root), resolved)) {
      throw new WorkspaceError(`Path escapes the approved workspace: ${resolved}`)
    }
    if (this.isSensitive(resolved)) throw new WorkspaceError("This path is protected")
    return resolved
  }

  private equalPaths(left: string, right: string): boolean {
    return process.platform === "win32"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right
  }
}
