/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"
import { PNG } from "pngjs"
import pixelmatch from "pixelmatch"
import { startTestDaemon, type TestDaemon } from "../src/test/helpers"

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
const BASELINE = "e2e/visual-baseline"
const ACTUAL = "test-results/visual"

let daemon: TestDaemon
let browser: Browser
let workspaceDir: string
const contexts: BrowserContext[] = []

async function executablePath() {
  if (await Bun.file(EDGE).exists()) return EDGE
  if (await Bun.file(CHROME).exists()) return CHROME
  throw new Error("No Edge or Chrome executable found")
}

async function ready(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await page.addStyleTag({
    content: ".titlebar-status, .toast, .side-tabs .tag { visibility: hidden !important; }",
  })
  await page.waitForTimeout(350)
}

async function login(page: Page, password: string) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Use password"),
    )
    button?.click()
  })
  await page.locator('input[type="password"]').fill(password)
  await page.evaluate(() => (document.querySelector("form") as HTMLFormElement).requestSubmit())
  await page.waitForURL(`${daemon.state.url}/`)
  await page.locator(".home-panel").waitFor()
}

async function capture(page: Page, name: string) {
  await ready(page)
  await mkdir(ACTUAL, { recursive: true })
  const actualPath = path.join(ACTUAL, `${name}.png`)
  await page.screenshot({ path: actualPath, animations: "disabled", caret: "hide" })
  const baselinePath = path.join(BASELINE, `${name}.png`)

  if (process.env.UPDATE_VISUAL_BASELINES === "1" || !(await Bun.file(baselinePath).exists())) {
    await mkdir(BASELINE, { recursive: true })
    await Bun.write(baselinePath, await Bun.file(actualPath).arrayBuffer())
    return
  }

  const expected = PNG.sync.read(Buffer.from(await Bun.file(baselinePath).arrayBuffer()))
  const actual = PNG.sync.read(Buffer.from(await Bun.file(actualPath).arrayBuffer()))
  expect(actual.width).toBe(expected.width)
  expect(actual.height).toBe(expected.height)
  const diff = new PNG({ width: actual.width, height: actual.height })
  const changed = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, {
    threshold: 0.15,
    includeAA: true,
  })
  if (changed > 0) {
    await Bun.write(path.join(ACTUAL, `${name}.diff.png`), PNG.sync.write(diff))
  }
  expect(changed / (actual.width * actual.height)).toBeLessThanOrEqual(0.005)
}

beforeAll(async () => {
  daemon = await startTestDaemon()
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-1-visual-workspace-"))
  await daemon.client.addWorkspace({ path: workspaceDir, label: "Visual project", access: "read" })
  browser = await chromium.launch({ executablePath: await executablePath(), headless: true })
}, 45_000)

afterAll(async () => {
  for (const context of contexts) await context.close()
  await browser?.close()
  await daemon?.cleanup()
  if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true })
})

describe("visual regression", () => {
  test("desktop screens match their baselines", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })
    contexts.push(context)
    const page = await context.newPage()

    await page.goto(`${daemon.state.url}/login`)
    await page.locator(".connect-header h1").waitFor()
    await capture(page, "login-dark")

    await login(page, daemon.password)
    await page.locator('.home-project-row:has-text("Visual project")').waitFor()
    await capture(page, "home-dark")

    await page.goto(`${daemon.state.url}/new`)
    await page.locator(".new-session-page").waitFor()
    await capture(page, "new-session-dark")

    const session = await daemon.client.createSession("Visual session")
    await page.goto(`${daemon.state.url}/sessions/${session.session.id}`)
    await page.locator(".session-screen").waitFor()
    await capture(page, "session-dark")

    await page.goto(`${daemon.state.url}/settings`)
    await page.locator(".page-title").waitFor()
    await capture(page, "settings-dark")
  }, 60_000)

  test("light and mobile screens match their baselines", async () => {
    const light = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" })
    contexts.push(light)
    const lightPage = await light.newPage()
    await lightPage.goto(`${daemon.state.url}/login`)
    await lightPage.locator(".connect-header h1").waitFor()
    await capture(lightPage, "login-light-mobile")
    await login(lightPage, daemon.password)
    await lightPage.locator(".home-mobile-project select").waitFor()
    await capture(lightPage, "home-light-mobile")

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" })
    contexts.push(mobile)
    const mobilePage = await mobile.newPage()
    await mobilePage.goto(`${daemon.state.url}/login`)
    await mobilePage.locator(".connect-header h1").waitFor()
    await login(mobilePage, daemon.password)
    await mobilePage.locator(".home-mobile-project select").waitFor()
    await capture(mobilePage, "home-mobile-dark")
  }, 40_000)
})
