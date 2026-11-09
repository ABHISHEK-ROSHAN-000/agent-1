/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"
import { startFakeOpenAI, type FakeOpenAI } from "../src/test/fake-openai"
import { startTestDaemon, type TestDaemon } from "../src/test/helpers"

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
  await daemon.client.createModelProfile({
    name: "Browser test model",
    kind: "cloud",
    baseUrl: fake.url,
    modelId: "fake-model",
    apiKey: "sk-browser-test",
    contextWindow: 8192,
    maxOutputTokens: 256,
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
    await page.locator(".home-wordmark").waitFor()
    await page.screenshot({ path: "test-results/home-dark.png", fullPage: true })

    await page.locator(".home textarea").fill("hello")
    await page.evaluate(() => (document.querySelector(".send-button") as HTMLElement | null)?.click())
    await page.waitForURL(/\/sessions\//)
    await page.locator(".session-screen textarea").waitFor()
    await visible("Fake response: hello", page, 15_000)
    await page.locator(".send-button.stop").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined)

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
    await visible("hello.txt")
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "hello.txt",
      )
      button?.click()
    })
    await visible("Web file content")
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
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "Undo batch",
      )
      button?.click()
    })
    await waitForPath(path.join(taskDir, "a.txt"))
    await waitForPath(path.join(taskDir, "sorted", "a.txt"), false)

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
  }, 90_000)

  test("accepts a one-time pairing link and signs the device in", async () => {
    const pairing = await daemon.client.pair()
    const paired = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: "dark" })
    const pairedPage = await paired.newPage()
    await pairedPage.goto(`${daemon.state.url}/login`)
    await pairedPage.locator("#pairing-link").fill(pairing.url)
    await pairedPage.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent?.trim() === "Connect",
      )
      button?.click()
    })
    await pairedPage.waitForURL(`${daemon.state.url}/`)
    await pairedPage.locator(".home-wordmark").waitFor()
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
    await mobilePage.locator(".home-wordmark").waitFor()
    const state = await mobilePage.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      rail: getComputedStyle(document.querySelector(".rail") as HTMLElement).display,
    }))
    expect(state.overflow).toBeLessThanOrEqual(1)
    expect(state.rail).toBe("none")
    await mobilePage.screenshot({ path: "test-results/home-mobile-dark.png", fullPage: true })
    await mobile.close()
  }, 20_000)

  test("follows the system light theme on the login screen", async () => {
    const light = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" })
    const lightPage = await light.newPage()
    await lightPage.goto(`${daemon.state.url}/login`)
    await lightPage.locator(".login-title").waitFor()
    expect(await lightPage.evaluate(() => document.documentElement.dataset.theme)).toBe("light")
    await lightPage.screenshot({ path: "test-results/login-light-mobile.png", fullPage: true })
    await lightPage.evaluate(() => localStorage.setItem("agent1-theme", "dark"))
    await lightPage.reload()
    await lightPage.locator(".login-title").waitFor()
    expect(await lightPage.evaluate(() => document.documentElement.dataset.theme)).toBe("dark")
    await light.close()
  }, 20_000)
})



