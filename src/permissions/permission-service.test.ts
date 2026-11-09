import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { PermissionService } from "./permission-service"
import { argumentsHash } from "./permission-service"

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
  return { db, service: new PermissionService(db, new Logger({ level: "error" })) }
}

describe("PermissionService", () => {
  test("seeds allow rules, asks for writes, and denies unknown tools", async () => {
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
        inGrant: true,
      })).effect,
    ).toBe("allow")
    expect(
      (await service.evaluate("fs_read", {}, {
        action: "fs.read",
        risk: "read",
        resource: "C:\\other\\a.txt",
        inGrant: false,
      })).effect,
    ).toBe("ask")
    expect(
      (await service.evaluate("fs_read", {}, {
        action: "fs.read",
        risk: "read",
        resource: "C:\\Windows\\System32\\x",
        inGrant: true,
        sensitive: true,
      })).effect,
    ).toBe("deny")
    expect(
      (await service.evaluate("fs_write", {}, {
        action: "fs.write",
        risk: "write",
        resource: "C:\\work\\a.txt",
        inGrant: true,
      })).effect,
    ).toBe("ask")
    expect(
      (await service.evaluate("fs_delete", {}, {
        action: "fs.delete",
        risk: "write",
        resource: "C:\\work\\a.txt",
        inGrant: true,
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
})
