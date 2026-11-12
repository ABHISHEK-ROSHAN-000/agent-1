import { describe, expect, test } from "bun:test"
import { dangerousCommand, hardlineCommand, matchesAllowlist } from "../approvals/command-safety"

describe("Phase 8F attack corpus", () => {
  const hardline = [
    "format C:",
    "diskpart",
    "bcdedit /set",
    "vssadmin delete shadows /all",
    "cipher /w:C:\\",
    "rm -rf /",
    "r^m -rf /",
    'r"m" -rf /',
    "del /f /s /q C:\\",
    "Remove-Item -Recurse -Force C:\\",
    "shutdown /s",
    "reg delete HKLM\\Software",
    "net user victim /delete",
  ]

  test("hardline commands cannot be hidden by quoting or caret escapes", () => {
    for (const command of hardline) expect(hardlineCommand(command), command).not.toBeNull()
  })

  test("dangerous operations are recognized", () => {
    for (const command of [
      "git reset --hard",
      "git clean -fdx",
      "git checkout -- .",
      "sed -i s/a/b/ file.txt",
      "taskkill /F /IM node.exe",
      "reg add HKCU\\Software /v x",
      "icacls file /grant Everyone:F",
      "schtasks /delete /tn x",
      "sc delete x",
      "Invoke-WebRequest https://x -OutFile x",
      "Start-Process powershell",
    ]) {
      expect(dangerousCommand(command), command).not.toBeNull()
    }
  })

  test("joined commands cannot reuse a prefix approval", () => {
    expect(matchesAllowlist("git status", ["git status*"])).toBe("git status*")
    expect(matchesAllowlist("git status; rm -rf .", ["git status*"])).toBeNull()
    expect(matchesAllowlist("git status && del file", ["git status*"])).toBeNull()
    expect(matchesAllowlist("git status\nrm file", ["git status*"])).toBeNull()
    expect(matchesAllowlist("git $(printf status)", ["git *"])).toBeNull()
    expect(matchesAllowlist("git status; rm file", ["*"])).toBe("*")
    expect(matchesAllowlist("git status; rm file", ["git status; rm file"])).toBe("git status; rm file")
  })
})
