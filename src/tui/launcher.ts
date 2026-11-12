import { spawn } from "node:child_process"
import path from "node:path"
import { resolveConfig } from "../core/config"
import { discoverTui } from "./discovery"

function repoRoot(): string {
  return path.resolve(import.meta.dir, "..", "..")
}

export async function launchTui(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The TUI requires an interactive terminal.")
  }
  const config = resolveConfig()
  await discoverTui()
  const entry = path.join(repoRoot(), "src", "tui", "main.tsx")
  const child = spawn(
    process.execPath,
    ["--preload", "@opentui/solid/preload", entry],
    {
      cwd: repoRoot(),
      stdio: "inherit",
      windowsHide: false,
      env: {
        ...process.env,
        AGENT1_DATA_DIR: config.dataDir,
      },
    },
  )
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
}
