import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { dpapiProtect, dpapiUnprotect } from "./dpapi"

interface SecretFile {
  readonly version: 1
  readonly kind: "auth-password"
  readonly ciphertext: string
  readonly updatedAt: string
}

export class SecretStore {
  constructor(private readonly filePath: string) {}

  async readPassword(): Promise<string | undefined> {
    if (!existsSync(this.filePath)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<SecretFile>
      if (parsed.version !== 1 || parsed.kind !== "auth-password" || !parsed.ciphertext) {
        return undefined
      }
      return dpapiUnprotect(Buffer.from(parsed.ciphertext, "base64"))
    } catch {
      return undefined
    }
  }

  async writePassword(password: string): Promise<void> {
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    const encrypted = dpapiProtect(password)
    const body: SecretFile = {
      version: 1,
      kind: "auth-password",
      ciphertext: Buffer.from(encrypted).toString("base64"),
      updatedAt: new Date().toISOString(),
    }
    const temporary = `${this.filePath}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600 })
    renameSync(temporary, this.filePath)
  }

  async remove(): Promise<void> {
    if (existsSync(this.filePath)) rmSync(this.filePath, { force: true })
  }
}
