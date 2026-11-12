import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { PermissionService } from "./permission-service"
import { argumentsHash } from "./permission-service"
import { commandPatternKey } from "../approvals/command-safety"
import { redactCommand } from "../approvals/redaction"
import { EventService } from "../events/service"

const dirs: string[] = []
const dbs: Database[] = []

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-perm-"))
  dirs.push(dir)
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  dbs.push(db)
  const logger = new Logger({ level: "error" })
  const events = new EventService(db, logger)
  return { db, logger, events, service: new PermissionService(db, logger, events) }
}

describe("PermissionService", () => {
  test("seeds allow rules, allows file reads, and denies unknown tools", async () => {
    const { service } = await setup()
    const rules = await service.listRules()
    expect(rules.length).toBeGreaterThan(4)
    expect((await service.evaluate("test_echo", {})).effect).toBe("allow")
    expect((await service.evaluate("test_time", {})).effect).toBe("allow")
    expect((await service.evaluate("test_confirm", { note: "x" })).effect).toBe("ask")
    expect((await service.evaluate("not_a_tool", {})).effect).toBe("deny")
  })

  test("applies filesystem risk defaults and protected paths", async () => {
    const { service } = await setup()
    expect(
      (await service.evaluate("fs_read", {}, {
        action: "fs.read",
        risk: "read",
        resource: "C:\\work\\a.txt",
      })).effect,
    ).toBe("allow")
    expect(
      (await service.evaluate("fs_read", {}, {
        action: "fs.read",
        risk: "read",
        resource: "C:\\other\\a.txt",
      })).effect,
    ).toBe("allow")
    expect(
      (await service.evaluate("fs_read", {}, {
        action: "fs.read",
        risk: "read",
        resource: "C:\\Windows\\System32\\x",
        sensitive: true,
      })).effect,
    ).toBe("deny")
    expect(
      (await service.evaluate("fs_write", {}, {
        action: "fs.write",
        risk: "write",
        resource: "C:\\work\\a.txt",
      })).effect,
    ).toBe("allow")
    expect(
      (await service.evaluate("fs_delete", {}, {
        action: "fs.delete",
        risk: "write",
        resource: "C:\\work\\a.txt",
      })).effect,
    ).toBe("deny")
  })

  test("deny wins over allow, and explicit allow wins over ask", async () => {
    const { service } = await setup()
    const deny = await service.createRule({
      action: "tool.test_echo",
      resource: "*",
      effect: "deny",
      position: 1,
      note: "test deny",
    })
    expect((await service.evaluate("test_echo", {})).effect).toBe("deny")
    await service.deleteRule(deny.id)
    expect((await service.evaluate("test_echo", {})).effect).toBe("allow")

    const allow = await service.createRule({
      action: "tool.test_confirm",
      resource: "*",
      effect: "allow",
      position: 2,
    })
    expect((await service.evaluate("test_confirm", { note: "x" })).effect).toBe("allow")
    await service.deleteRule(allow.id)
    expect((await service.evaluate("test_confirm", { note: "x" })).effect).toBe("ask")
  })

  test("creates, decides, and audits an approval", async () => {
    const { service } = await setup()
    const args = { note: "hello" }
    const approval = await service.requestApproval({
      turnId: "turn_test",
      sessionId: "ses_test",
      toolCallId: "call_test",
      toolName: "test_confirm",
      action: "tool.test_confirm",
      resource: "*",
      patternKey: "*",
      arguments: args,
    })
    expect(approval.status).toBe("pending")
    expect(approval.argumentsHash).toBe(argumentsHash(args))
    expect(await service.listApprovals("pending")).toHaveLength(1)

    await expect(
      service.decideApproval(approval.id, "approve", { arguments: { note: "changed" } }),
    ).rejects.toThrow("arguments do not match")
    expect((await service.getApproval(approval.id))?.status).toBe("pending")

    const approved = await service.decideApproval(approval.id, "approve")
    expect(approved.status).toBe("approved")
    expect((await service.listAudit()).some((entry) => entry.action === "approval.approved")).toBe(true)
  })

  test("applies smart, manual, and off shell modes with hardline and deny precedence", async () => {
    const { service } = await setup()
    const shell = (command: string) =>
      service.evaluate("shell_exec", { command }, { action: "shell.exec", risk: "shell", sessionId: "ses_shell" })

    expect((await shell("rm notes.txt")).effect).toBe("ask")
    await service.setConfig({ mode: "off" })
    expect((await shell("rm notes.txt")).effect).toBe("allow")
    expect((await shell("format C:")).effect).toBe("deny")
    expect((await shell("diskpart")).effect).toBe("deny")
    await service.setConfig({ mode: "manual", deny: ["rm *"], allowlist: [] })
    expect((await shell("rm notes.txt")).effect).toBe("deny")
    expect((await shell("echo hello")).effect).toBe("allow")
    await service.setConfig({ mode: "manual", deny: [], allowlist: ["rm *"] })
    expect((await shell("rm notes.txt")).effect).toBe("allow")
  })

  test("smart mode uses the judge and escalates uncertainty", async () => {
    const { service } = await setup()
    let verdict: "approve" | "deny" | "escalate" = "approve"
    service.setSmartJudge(async () => verdict)
    await service.setConfig({ mode: "smart" })
    const shell = (command: string) =>
      service.evaluate("shell_exec", { command }, { action: "shell.exec", risk: "shell", sessionId: "ses_smart" })
    expect((await shell("rm notes.txt")).effect).toBe("allow")
    verdict = "deny"
    expect((await shell("rm notes.txt")).effect).toBe("deny")
    verdict = "escalate"
    expect((await shell("rm notes.txt")).effect).toBe("ask")
  })

  test("session and always grants match exact commands", async () => {
    const { service } = await setup()
    await service.setConfig({ mode: "manual" })
    const command = "rm notes.txt"
    const patternKey = commandPatternKey(command, "C:\\work")
    const approval = await service.requestApproval({
      turnId: "turn_grant",
      sessionId: "ses_grant",
      toolCallId: "call_grant",
      toolName: "shell_exec",
      action: "shell.exec",
      resource: command,
      patternKey,
      displayCommand: command,
      arguments: { command, cwd: "C:\\work" },
    })
    await service.decideApproval(approval.id, "approve", { scope: "session" })
    expect(
      (await service.evaluate("shell_exec", approval.arguments, { action: "shell.exec", risk: "shell", sessionId: "ses_grant" })).effect,
    ).toBe("allow")
    expect(
      (await service.evaluate("shell_exec", approval.arguments, { action: "shell.exec", risk: "shell", sessionId: "ses_other" })).effect,
    ).toBe("ask")
    expect((await service.listApprovalGrants()).length).toBe(1)

    const permanent = await service.requestApproval({
      turnId: "turn_always",
      sessionId: "ses_always",
      toolCallId: "call_always",
      toolName: "shell_exec",
      action: "shell.exec",
      resource: "rm other.txt",
      patternKey: commandPatternKey("rm other.txt", "C:\\work"),
      arguments: { command: "rm other.txt", cwd: "C:\\work" },
    })
    await service.decideApproval(permanent.id, "approve", { scope: "always" })
    expect(
      (await service.evaluate("shell_exec", permanent.arguments, { action: "shell.exec", risk: "shell", sessionId: "ses_any" })).effect,
    ).toBe("allow")
    const grants = await service.listApprovalGrants()
    expect(grants.some((grant) => grant.scope === "always")).toBe(true)
    expect(await service.deleteApprovalGrant(grants.find((grant) => grant.scope === "always")!.id)).toBe(true)
  })

  test("publishes durable approval decided and expired events", async () => {
    const { db, service, events } = await setup()
    const seen: string[] = []
    const stop = events.subscribe((event) => seen.push(event.type))
    const approval = await service.requestApproval({
      turnId: "turn_event",
      sessionId: "ses_event",
      toolCallId: "call_event",
      toolName: "test_confirm",
      action: "tool.test_confirm",
      resource: "*",
      patternKey: "*",
      arguments: { note: "event" },
    })
    await service.decideApproval(approval.id, "approve")
    expect(seen).toContain("approval.decided")
    const durable = await db.eventsAfter(0)
    expect(durable.some((event) => event.type === "approval.decided")).toBe(true)

    await service.setConfig({ timeoutSeconds: 1 })
    await db.createApproval({
      turnId: "turn_event",
      sessionId: "ses_event",
      toolCallId: "call_expire_event",
      toolName: "test_confirm",
      action: "tool.test_confirm",
      resource: "*",
      patternKey: "*",
      arguments: { note: "expire" },
      argumentsHash: argumentsHash({ note: "expire" }),
      expiresAt: new Date(Date.now() - 1).toISOString(),
    })
    await service.expireApprovals()
    expect(seen).toContain("approval.expired")
    stop()
  })

  test("two clients deciding one approval yield one winner and one conflict", async () => {
    const { service } = await setup()
    const approval = await service.requestApproval({
      turnId: "turn_race",
      sessionId: "ses_race",
      toolCallId: "call_race",
      toolName: "test_confirm",
      action: "tool.test_confirm",
      resource: "*",
      patternKey: "*",
      arguments: { note: "race" },
    })
    const results = await Promise.allSettled([
      service.decideApproval(approval.id, "approve"),
      service.decideApproval(approval.id, "reject"),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected && rejected.status === "rejected" ? String(rejected.reason) : "").toContain(
      "already",
    )
  })

  test("a timed-out approval is denied and cannot be retried", async () => {
    const { service } = await setup()
    await service.setConfig({ timeoutSeconds: 1 })
    const approval = await service.requestApproval({
      turnId: "turn_expire",
      sessionId: "ses_expire",
      toolCallId: "call_expire",
      toolName: "test_confirm",
      action: "tool.test_confirm",
      resource: "*",
      patternKey: "*",
      arguments: { note: "late" },
    })
    await Bun.sleep(1_100)
    await expect(service.decideApproval(approval.id, "approve")).rejects.toThrow("expired")
    expect((await service.getApproval(approval.id))?.status).toBe("expired")
    await expect(service.decideApproval(approval.id, "approve")).rejects.toThrow()
  })

  test("redacts approval display while retaining raw argument binding", async () => {
    const { service } = await setup()
    expect(redactCommand("curl -H 'Authorization: Bearer abcdef' --password hunter2")).toContain("[REDACTED]")
    const raw = { command: "tool --token supersecret", password: "hunter2", note: "ok" }
    const approval = await service.requestApproval({
      turnId: "turn_redact",
      sessionId: "ses_redact",
      toolCallId: "call_redact",
      toolName: "shell_exec",
      action: "shell.exec",
      resource: raw.command,
      patternKey: commandPatternKey(raw.command),
      displayCommand: raw.command,
      arguments: raw,
    })
    expect(approval.argumentsHash).toBe(argumentsHash(raw))
    const shown = JSON.stringify(approval.arguments)
    expect(shown).not.toContain("supersecret")
    expect(shown).not.toContain("hunter2")
    expect(approval.displayCommand).not.toContain("supersecret")
    expect(shown).toContain("ok")
  })

  test("approval timeout follows the policy and protected instructions still ask", async () => {
    const { service } = await setup()
    await service.setConfig({ timeoutSeconds: 120 })
    const approval = await service.requestApproval({
      turnId: "turn_timeout",
      sessionId: "ses_timeout",
      toolCallId: "call_timeout",
      toolName: "test_confirm",
      action: "tool.test_confirm",
      resource: "*",
      patternKey: "*",
      arguments: { note: "x" },
    })
    const ttl = Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)
    expect(ttl).toBeGreaterThan(110_000)
    expect(ttl).toBeLessThan(130_000)
    expect(
      (await service.evaluate("fs_write", { path: "AGENTS.md" }, {
        action: "fs.write",
        risk: "write",
        resource: "AGENTS.md",
        protectedInstruction: true,
      })).effect,
    ).toBe("ask")
  })
})
