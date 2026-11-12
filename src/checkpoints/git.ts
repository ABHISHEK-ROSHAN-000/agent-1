import { spawn } from "node:child_process"
import path from "node:path"

export interface GitResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly result?: GitResult,
  ) {
    super(message)
    this.name = "GitError"
  }
}

export interface GitRunOptions {
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly allowExitCodes?: readonly number[]
  readonly maxOutputBytes?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null"
}

export function isolatedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  env.GIT_TERMINAL_PROMPT = "0"
  env.GCM_INTERACTIVE = "Never"
  env.GIT_CONFIG_GLOBAL = nullDevice()
  env.GIT_CONFIG_SYSTEM = nullDevice()
  env.GIT_CONFIG_NOSYSTEM = "1"
  env.GIT_PAGER = "cat"
  env.PAGER = "cat"
  env.GIT_EDITOR = "true"
  env.GIT_AUTHOR_NAME = "Agent-1"
  env.GIT_AUTHOR_EMAIL = "agent-1@localhost"
  env.GIT_COMMITTER_NAME = "Agent-1"
  env.GIT_COMMITTER_EMAIL = "agent-1@localhost"
  delete env.GIT_NAMESPACE
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  return env
}

export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === "win32") {
    try {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      })
      child.unref()
    } catch {
      // Best effort.
    }
    return
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // Best effort.
  }
}

export class Git {
  constructor(readonly executable = "git") {}

  async available(): Promise<boolean> {
    try {
      await this.run(["--version"], {
        cwd: process.cwd(),
        timeoutMs: 5_000,
        maxOutputBytes: 16_384,
      })
      return true
    } catch {
      return false
    }
  }

  run(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const allowed = new Set(options.allowExitCodes ?? [0])
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(this.executable, [...args], {
          cwd: options.cwd,
          env: options.env ?? isolatedGitEnv(),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }

      let stdout = ""
      let stderr = ""
      let outputBytes = 0
      let settled = false
      let timedOut = false

      const finish = (error?: Error, result?: GitResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else if (result) resolve(result)
      }

      const timer = setTimeout(() => {
        timedOut = true
        if (child.pid) killProcessTree(child.pid)
        finish(new GitError(`Git command timed out after ${timeoutMs}ms`, { stdout, stderr, code: -1 }))
      }, timeoutMs)

      child.stdout?.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > maxOutputBytes) {
          if (child.pid) killProcessTree(child.pid)
          finish(new GitError(`Git output exceeded ${maxOutputBytes} bytes`, { stdout, stderr, code: -1 }))
          return
        }
        stdout += chunk.toString("utf8")
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > maxOutputBytes) {
          if (child.pid) killProcessTree(child.pid)
          finish(new GitError(`Git output exceeded ${maxOutputBytes} bytes`, { stdout, stderr, code: -1 }))
          return
        }
        stderr += chunk.toString("utf8")
      })
      child.on("error", (error) => {
        finish(new GitError(`Could not run Git: ${error.message}`, { stdout, stderr, code: -1 }))
      })
      child.on("close", (code) => {
        if (timedOut || settled) return
        const exitCode = code ?? -1
        const result = { stdout, stderr, code: exitCode }
        if (!allowed.has(exitCode)) {
          finish(new GitError(stderr.trim() || `Git exited with code ${exitCode}`, result))
          return
        }
        finish(undefined, result)
      })
    })
  }

  async initializeBare(storePath: string): Promise<void> {
    await this.run(["init", "--bare", storePath], {
      cwd: path.dirname(storePath),
      env: isolatedGitEnv(),
      timeoutMs: 30_000,
    })
  }
}
