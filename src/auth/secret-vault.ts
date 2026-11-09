import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { dpapiProtect, dpapiUnprotect } from "./dpapi"

interface VaultFile {
  readonly version: 1
  readonly keys: Record<string, string>
}

export class SecretVault {
  constructor(private readonly filePath: string) {}

  private read(): VaultFile {
    if (!existsSync(this.filePath)) return { version: 1, keys: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<VaultFile>
      if (parsed.version !== 1 || !parsed.keys || typeof parsed.keys !== "object") {
        return { version: 1, keys: {} }
      }
      return { version: 1, keys: { ...parsed.keys } }
    } catch {
      return { version: 1, keys: {} }
    }
  }

  private write(file: VaultFile): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(file)}\n`, { encoding: "utf8", mode: 0o600 })
    renameSync(temporary, this.filePath)
  }

  async get(key: string): Promise<string | undefined> {
    const encrypted = this.read().keys[key]
    if (!encrypted) return undefined
    try {
      return dpapiUnprotect(Buffer.from(encrypted, "base64"))
    } catch {
      return undefined
    }
  }

  async has(key: string): Promise<boolean> {
    return this.read().keys[key] !== undefined
  }

  async set(key: string, value: string): Promise<void> {
    const file = this.read()
    file.keys[key] = Buffer.from(dpapiProtect(value)).toString("base64")
    this.write(file)
  }

  async delete(key: string): Promise<void> {
    const file = this.read()
    if (!(key in file.keys)) return
    delete file.keys[key]
    this.write(file)
  }
}
