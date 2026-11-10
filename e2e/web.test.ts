/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"
import QRCode from "qrcode"
import { startFakeOpenAI, type FakeOpenAI } from "../src/test/fake-openai"
import { configureTestProvider, startTestDaemon, type TestDaemon } from "../src/test/helpers"

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"

let daemon: TestDaemon
let fake: FakeOpenAI
let browser: Browser
let context: BrowserContext
let page: Page
let workspaceDir: string
let taskDir: string

beforeAll(async () => {
  fake = startFakeOpenAI()
  daemon = await startTestDaemon()
  await configureTestProvider(daemon.client, fake.url, {
    name: "Browser test model",
    apiKey: "sk-browser-test",
    contextWindow: 8192,
    maxOutputTokens: 256,
    reasoningOptions: [{ type: "effort", values: ["none", "low", "high", "max"] }],
  })
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-1-web-workspace-"))
  await writeFile(path.join(workspaceDir, "hello.txt"), "Web file content", "utf8")
  await daemon.client.addWorkspace({ path: workspaceDir, label: "Web fixture", access: "read" })
  taskDir = await mkdtemp(path.join(os.tmpdir(), "agent-1-web-task-"))
  await writeFile(path.join(taskDir, "a.txt"), "A\n", "utf8")
  await daemon.client.addWorkspace({ path: taskDir, label: "Task fixture", access: "write" })
  const executablePath = await Bun.file(EDGE).exists()
    ? EDGE
    : (await Bun.file(CHROME).exists())
      ? CHROME
      : undefined
  if (!executablePath) throw new Error("No Edge or Chrome executable found")
  browser = await chromium.launch({ executablePath, headless: true })
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  })
  page = await context.newPage()
}, 45_000)

afterAll(async () => {
  await browser?.close()
  await daemon?.cleanup()
  fake?.close()
  if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true })
  if (taskDir) await rm(taskDir, { recursive: true, force: true })
})

async function visible(text: string, target = page, timeout = 10_000) {
  await target.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout })
}

async function waitForPath(filePath: string, exists = true, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await Bun.file(filePath).exists()) === exists) return
    await Bun.sleep(100)
  }
  throw new Error(`${filePath} did not reach exists=${exists}`)
}

describe("Agent-1 web UI", () => {
  test("pairs/logs in, creates a session, streams chat, and resolves an approval", async () => {
    await page.goto(`${daemon.state.url}/login`)
    await visible("Connect to a server")
    await page.screenshot({ path: "test-results/login-dark.png", fullPage: true })
    await page.getByRole("button", { name: "Scan QR code" }).waitFor()
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes("Use password"),
      )
      button?.click()
    })
    await page.waitForTimeout(500)
    await page.locator('input[type="password"]').fill(daemon.password)
    await page.evaluate(() => (document.querySelector("form") as HTMLFormElement).requestSubmit())
    await page.waitForURL(`${daemon.state.url}/`)
    await page.locator(".home-panel").waitFor()
    await page.screenshot({ path: "test-results/home-dark.png", fullPage: true })

    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.includes("New session"),
      )
      button?.click()
    })
    await page.waitForURL(`${daemon.state.url}/new`)
    await page.locator(".new-session-page").waitFor()
    const centered = await page.evaluate(() => {
      const row = document.querySelector(".new-session-project")?.getBoundingClientRect()
      const composer = document.querySelector(".new-session-page .composer")?.getBoundingClientRect()
      if (!row || !composer) return false
      return Math.abs(row.left + row.width / 2 - (composer.left + composer.width / 2)) <= 1
    })
    expect(centered).toBe(true)
    expect(await page.locator(".composer-footer").getByText("Agent", { exact: true }).count()).toBe(0)
    await page.screenshot({ path: "test-results/new-session-dark.png", fullPage: true })
    await page.locator(".model-picker-trigger").click()
    const popover = page.locator(".model-picker-popover")
    await popover.waitFor({ timeout: 5_000 })
    const popoverBox = await popover.boundingBox()
    const triggerBox = await page.locator(".model-picker-trigger").boundingBox()
    const viewport = page.viewportSize()
    expect(popoverBox).not.toBeNull()
    expect(triggerBox).not.toBeNull()
    expect(popoverBox!.y).toBeGreaterThanOrEqual(0)
    expect(popoverBox!.x).toBeGreaterThanOrEqual(0)
    expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewport!.height)
    expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(viewport!.width)
    expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(triggerBox!.y + 1)
    await page.locator(".model-picker-detail").waitFor()
    await page.screenshot({ path: "test-results/model-picker-popover.png", fullPage: true })
    await page.locator(".model-picker-option").first().click()
    await popover.waitFor({ state: "hidden", timeout: 5_000 })
    await page.locator(".effort-picker-trigger").click()
    const effortPopover = page.locator(".effort-picker-popover")
    await effortPopover.waitFor({ timeout: 5_000 })
    await page.screenshot({ path: "test-results/effort-picker-popover.png", fullPage: true })
    await effortPopover.getByRole("button", { name: "Max", exact: true }).click()
    await effortPopover.waitFor({ state: "hidden", timeout: 5_000 })
    expect(await page.locator(".effort-picker-trigger").innerText()).toContain("Max")
    await page.locator(".new-session-page textarea").fill("slow **bold** hello")
    await page.evaluate(() => (document.querySelector(".send-button") as HTMLElement | null)?.click())
    await page.waitForURL(/\/sessions\//)
    await page.locator(".session-screen textarea").waitFor()
    await page.locator(".message-live [data-component=\"markdown\"]").waitFor({ timeout: 10_000 })
    await page.waitForSelector(".message-live [data-component=\"markdown\"] strong", { timeout: 10_000 })
    expect(await page.locator(".message-live [data-component=\"markdown\"] strong").count()).toBeGreaterThan(0)
    await page.locator(".effort-picker-trigger").waitFor({ timeout: 10_000 })
    await page.waitForFunction(
      () => document.querySelector(".effort-picker-trigger")?.textContent?.includes("Max") === true,
      undefined,
      { timeout: 10_000 },
    )
    expect(await page.locator(".effort-picker-trigger").innerText()).toContain("Max")
    expect(fake.requests.some((request) => request.reasoning_effort === "max")).toBe(true)
    await visible("Fake response:", page, 15_000)
    await page.locator(".send-button.stop").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined)
    expect(await page.locator(".side-panel").count()).toBe(0)
    await page.locator(".session-header .icon-button").last().click()
    await page.locator(".side-panel").waitFor({ timeout: 5_000 })
    const sideBox = await page.locator(".side-panel").boundingBox()
    expect(sideBox).not.toBeNull()
    expect(sideBox!.width).toBeGreaterThan(700)
    await page.locator(".context-usage-trigger").waitFor({ timeout: 10_000 })
    const headerBorder = await page
      .locator(".session-header")
      .evaluate((element) => getComputedStyle(element).borderBottomWidth)
    expect(headerBorder).toBe("0px")
    await page.screenshot({ path: "test-results/side-panel-wide-context.png", fullPage: true })

    await page.locator(".session-screen textarea").fill("please confirm")
    await page.evaluate(() => (document.querySelector(".send-button") as HTMLElement | null)?.click())
    await visible("Approval required", page, 15_000)
    await page.screenshot({ path: "test-results/approval-dark.png", fullPage: true })
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((entry) =>
        entry.textContent?.trim() === "Approve",
      )
      button?.click()
    })
    await visible("Fake final answer", page, 15_000)
    await page.waitForTimeout(600)
    await page.screenshot({ path: "test-results/session-dark.png", fullPage: true })

    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "Files",
      )
      button?.click()
    })
    await page.locator(".side-content select").selectOption({ label: "Web fixture · read" })
    await page.locator(".pierre-tree-host file-tree-container").waitFor()
    const treeBox = await page.locator(".pierre-tree-host").boundingBox()
    expect(treeBox).not.toBeNull()
    const fileResponse = page.waitForResponse(
      (response) => response.url().includes("/file?") && response.status() === 200,
      { timeout: 15_000 },
    )
    await page.mouse.click(treeBox!.x + 100, treeBox!.y + 44)
    await fileResponse
    await page.locator(".files-preview").waitFor()
    await page.screenshot({ path: "test-results/files-dark.png", fullPage: true })

    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "Context",
      )
      button?.click()
    })
    await visible("Context limit")
    await page.screenshot({ path: "test-results/context-dark.png", fullPage: true })

    const move = { root: taskDir, moves: [{ from: "a.txt", to: "sorted/a.txt" }] }
    await page.locator(".session-screen textarea").fill(`apply moves: ${JSON.stringify(move)}`)
    await page.evaluate(() => (document.querySelector(".send-button") as HTMLElement | null)?.click())
    await visible("Approval required", page, 15_000)
    await page.screenshot({ path: "test-results/approval-task-dark.png", fullPage: true })
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((entry) =>
        entry.textContent?.trim() === "Approve",
      )
      button?.click()
    })
    await waitForPath(path.join(taskDir, "sorted", "a.txt"))

    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "Review",
      )
      button?.click()
    })
    await visible("Undo batch", page, 15_000)
    await page.evaluate(() => {
      const summary = document.querySelector(".journal-details summary") as HTMLElement | null
      summary?.click()
    })
    await page.locator(".journal-file .pierre-file-host").waitFor({ timeout: 15_000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: "test-results/review-diff-dark.png", fullPage: true })
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "Undo batch",
      )
      button?.click()
    })
    await waitForPath(path.join(taskDir, "a.txt"))
    await waitForPath(path.join(taskDir, "sorted", "a.txt"), false)

    await page.goto(`${daemon.state.url}/`)
    await page.locator(".home-session-row").first().waitFor()
    await page.screenshot({ path: "test-results/home-sessions-dark.png", fullPage: true })
    await page.goto(`${daemon.state.url}/settings`)
    await page.locator(".page-title").waitFor()
    await page.screenshot({ path: "test-results/settings-dark.png", fullPage: true })

    await page.evaluate(() => window.dispatchEvent(new Event("offline")))
    await visible("Offline")
    await page.screenshot({ path: "test-results/offline-banner-dark.png", fullPage: true })
    await page.evaluate(() => window.dispatchEvent(new Event("online")))
    await page.locator(".status-banner.offline").waitFor({ state: "hidden" })

    const manifest = await page.request.get(`${daemon.state.url}/manifest.webmanifest`)
    expect(manifest.status()).toBe(200)
    const sw = await page.request.get(`${daemon.state.url}/sw.js`)
    expect(sw.status()).toBe(200)
    const serviceWorkerReady = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ])
      return Boolean(registration)
    })
    expect(serviceWorkerReady).toBe(true)

    for (const screenshot of [
      "login-dark.png",
      "home-dark.png",
      "new-session-dark.png",
      "model-picker-popover.png",
      "effort-picker-popover.png",
      "session-dark.png",
      "approval-dark.png",
      "files-dark.png",
      "context-dark.png",
      "approval-task-dark.png",
      "review-diff-dark.png",
      "home-sessions-dark.png",
      "settings-dark.png",
      "offline-banner-dark.png",
    ]) {
      const file = Bun.file(`test-results/${screenshot}`)
      expect(await file.exists()).toBe(true)
      expect(file.size).toBeGreaterThan(5_000)
    }
  }, 90_000)

  test("accepts a one-time pairing link and signs the device in", async () => {
    const pairing = await daemon.client.pair()
    const paired = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: "dark" })
    const pairedPage = await paired.newPage()
    await pairedPage.goto(`${daemon.state.url}/login`)
    await pairedPage.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "Scan QR code",
      )
      button?.click()
    })
    await pairedPage.locator(".scan-dialog").waitFor()
    await pairedPage.screenshot({ path: "test-results/qr-upload-dark.png", fullPage: true })
    expect(await Bun.file("test-results/qr-upload-dark.png").exists()).toBe(true)
    const qr = await QRCode.toBuffer(
      JSON.stringify({ code: pairing.code, urls: [daemon.state.url] }),
      { type: "png", width: 420, margin: 2 },
    )
    await pairedPage.setInputFiles('input[type="file"]', {
      name: "pairing.png",
      mimeType: "image/png",
      buffer: qr,
    })
    await pairedPage.waitForURL(`${daemon.state.url}/`, { timeout: 15_000 })
    await pairedPage.locator(".home-panel").waitFor()
    await paired.close()
  }, 20_000)

  test("keeps the mobile shell within the viewport", async () => {
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: "dark",
    })
    const mobilePage = await mobile.newPage()
    await mobilePage.goto(`${daemon.state.url}/login`)
    await mobilePage.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes("Use password"),
      )
      button?.click()
    })
    await mobilePage.locator('input[type="password"]').fill(daemon.password)
    await mobilePage.evaluate(() => (document.querySelector("form") as HTMLFormElement).requestSubmit())
    await mobilePage.waitForURL(`${daemon.state.url}/`)
    await mobilePage.locator(".home-panel").waitFor()
    const state = await mobilePage.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      titlebar: getComputedStyle(document.querySelector(".titlebar") as HTMLElement).display,
    }))
    expect(state.overflow).toBeLessThanOrEqual(1)
    expect(state.titlebar).toBe("flex")
    await mobilePage.screenshot({ path: "test-results/home-mobile-dark.png", fullPage: true })
    expect(await Bun.file("test-results/home-mobile-dark.png").exists()).toBe(true)
    await mobilePage.evaluate(() => {
      const row = document.querySelector(".home-session-row") as HTMLElement | null
      row?.click()
    })
    await mobilePage.waitForURL(/\/sessions\//)
    await mobilePage.locator(".session-screen").waitFor()
    await mobilePage.evaluate(() => {
      const button = document.querySelector('.session-header button[title="Toggle review panel"]') as HTMLElement | null
      button?.click()
    })
    await mobilePage.locator(".side-panel").waitFor()
    await mobilePage.screenshot({ path: "test-results/session-mobile-dark.png", fullPage: true })
    expect(await Bun.file("test-results/session-mobile-dark.png").exists()).toBe(true)
    await mobile.close()
  }, 20_000)

  test("follows the system light theme on the login screen", async () => {
    const light = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" })
    const lightPage = await light.newPage()
    await lightPage.goto(`${daemon.state.url}/login`)
    await lightPage.locator(".connect-header h1").waitFor()
    expect(await lightPage.evaluate(() => document.documentElement.dataset.theme)).toBe("light")
    await lightPage.screenshot({ path: "test-results/login-light-mobile.png", fullPage: true })
    await lightPage.evaluate(() => localStorage.setItem("agent1-theme", "dark"))
    await lightPage.reload()
    await lightPage.locator(".connect-header h1").waitFor()
    expect(await lightPage.evaluate(() => document.documentElement.dataset.theme)).toBe("dark")
    await lightPage.evaluate(() => localStorage.setItem("agent1-theme", "light"))
    await lightPage.reload()
    await lightPage.locator(".connect-header h1").waitFor()
    expect(await lightPage.evaluate(() => document.documentElement.dataset.theme)).toBe("light")
    await lightPage.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes("Use password"),
      )
      button?.click()
    })
    await lightPage.locator('input[type="password"]').fill(daemon.password)
    await lightPage.evaluate(() => (document.querySelector("form") as HTMLFormElement).requestSubmit())
    await lightPage.waitForURL(`${daemon.state.url}/`)
    await lightPage.locator(".home-panel").waitFor()
    await lightPage.screenshot({ path: "test-results/home-light-mobile.png", fullPage: true })
    expect(await Bun.file("test-results/home-light-mobile.png").exists()).toBe(true)
    await light.close()
  }, 30_000)
})



