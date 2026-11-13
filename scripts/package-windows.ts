import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { BunPlugin } from "bun"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const root = path.resolve(import.meta.dir, "..")
const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version
const out = path.join(root, "dist", "release")
const stage = path.join(out, `agent-1-windows-x64-${version}`)
const zip = path.join(out, `agent-1-windows-x64-${version}.zip`)
const webRoot = path.join(root, "web", "dist")

async function build(entrypoint: string, outfile: string, plugin?: BunPlugin): Promise<void> {
  const result = await Bun.build({
    entrypoints: [path.join(root, entrypoint)],
    target: "bun",
    minify: true,
    sourcemap: "none",
    plugins: plugin ? [plugin] : [],
    compile: {
      target: "bun-windows-x64",
      outfile: path.join(stage, outfile),
    },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`Failed to build ${entrypoint}`)
  }
}

if (!existsSync(path.join(webRoot, "index.html"))) {
  console.log("Building web client...")
  const result = Bun.spawnSync(["bun", "run", "web:build"], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  })
  if (result.exitCode !== 0) throw new Error("web:build failed")
}

rmSync(out, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

console.log(`Packaging Agent-1 ${version}`)
await build("src/cli/main.ts", "agent-1.exe")
await build("src/daemon/main.ts", "agent-1-daemon.exe")
await build("src/tui/main.tsx", "agent-1-tui.exe", createSolidTransformPlugin())

cpSync(webRoot, path.join(stage, "resources", "web"), { recursive: true })
cpSync(
  path.join(root, "node_modules", "@silvia-odwyer", "photon-node"),
  path.join(stage, "resources", "photon"),
  { recursive: true },
)
cpSync(path.join(root, "packaging", "install.ps1"), path.join(stage, "install.ps1"))
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) {
  cpSync(path.join(root, file), path.join(stage, file))
}
writeFileSync(path.join(stage, "version.txt"), `${version}\n`, "utf8")

console.log("Creating archive...")
const archive = Bun.spawnSync([
  "powershell.exe",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  `Compress-Archive -Path '${stage.replaceAll("'", "''")}\\*' -DestinationPath '${zip.replaceAll("'", "''")}' -Force`,
], { cwd: root, stdio: ["inherit", "inherit", "inherit"] })
if (archive.exitCode !== 0) throw new Error("Compress-Archive failed")

const bytes = readFileSync(zip)
const sha256 = createHash("sha256").update(bytes).digest("hex")
writeFileSync(path.join(out, "SHA256SUMS"), `${sha256}  ${path.basename(zip)}\n`, "utf8")
cpSync(path.join(root, "packaging", "install.ps1"), path.join(out, "install.ps1"))
writeFileSync(
  path.join(out, "latest.json"),
  `${JSON.stringify(
    {
      channel: "stable",
      version,
      url: `https://github.com/ABHISHEK-ROSHAN-000/agent-1/releases/download/v${version}/agent-1-windows-x64-${version}.zip`,
      sha256,
      minimumVersion: version,
      releaseNotes: `https://github.com/ABHISHEK-ROSHAN-000/agent-1/releases/tag/v${version}`,
    },
    null,
    2,
  )}\n`,
  "utf8",
)

console.log("")
console.log(`Package:  ${zip}`)
console.log(`Size:     ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB`)
console.log(`SHA-256:  ${sha256}`)
console.log(`Manifest: ${path.join(out, "latest.json")}`)
