#!/usr/bin/env node
/**
 * Produce the README screenshots from a real browser — no mockups.
 *
 * Everything here is the shipped code running for real: the DSH Web GUI with
 * the plugin's browser half mounted into it, and the extension's own popup and
 * options pages loaded from the extension directory. The popup/options shots
 * are taken while several DSH-titled tabs are open, so the numbers they show
 * are numbers the extension actually produced.
 *
 *   bash tools/with-scratch-profile.sh node tools/make-screenshots.mjs
 *
 * (Or point GUI_URL / DSH_E2E_URL at your own running GUI.)
 *
 * Two visuals are deliberately absent rather than faked: the browser tab strip
 * is browser chrome that no page-level API can capture, and a lone collapsed
 * status dot makes a screenshot with no information in it.
 */

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { clientHalfBootstrap } from './client-half-bootstrap.mjs'
import { loadPlaywright } from './playwright-loader.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'screenshots')
const GUI_URL = process.env.GUI_URL || process.env.DSH_E2E_URL || ''
const CHANNEL = process.env.E2E_CHANNEL || 'msedge'
const VIEWPORT = { width: 1280, height: 820 }
const TIMEOUT_MS = 30000
/** Extra DSH-titled tabs, so the popup's numbers are not all zero. */
const EXTRA_TABS = 2

if (!GUI_URL) {
  console.error('需要 GUI_URL 或 DSH_E2E_URL（带 token 的 GUI 地址）才能生成截图。')
  process.exit(2)
}

/** A page the extension recognises as DSH, used only to give the shots content. */
function startDshLookalikeServer() {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>DeepSeek Harness</title></head><body><h1>DeepSeek Harness</h1>
<script>window.__DSH_BOOT__={entries:[]}</script></body></html>`
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}/` }),
    )
  })
}

const { chromium } = await loadPlaywright()
mkdirSync(OUT_DIR, { recursive: true })
const { server, base } = await startDshLookalikeServer()

const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-tab-groups-shots-'))
let context
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: CHANNEL,
    headless: true,
    viewport: VIEWPORT,
    deviceScaleFactor: 2, // retina-quality PNGs for the README
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: TIMEOUT_MS }))
  const extensionId = new URL(worker.url()).host
  console.log(`扩展 ID ${extensionId}`)

  /* --------------------- chip: the expanded panel, on the real GUI ---- */

  const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  await context.addInitScript({ content: clientHalfBootstrap(clientSource) })

  const gui = await context.newPage()
  await gui.goto(GUI_URL, { waitUntil: 'domcontentloaded' })
  await gui.waitForFunction(
    () =>
      ['ready', 'mounted', 'load-failed', 'no-loader', 'spec-missing'].includes(
        globalThis.__dshTabGroupsTest?.status,
      ),
    undefined,
    { timeout: TIMEOUT_MS },
  )
  await gui.evaluate(() => {
    globalThis.__dshTabGroupsTest.mount({
      effect: (fn) => {
        fn()
        return () => {}
      },
    })
  })
  await gui.waitForFunction(
    () => {
      const shadow = document.getElementById('dsh-tab-groups-bridge')?.shadowRoot
      return shadow?.querySelector('.dot.ready') !== null && shadow?.querySelector('.dot.ready') !== undefined
    },
    undefined,
    { timeout: TIMEOUT_MS },
  )
  await gui.evaluate(() =>
    document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('.chip').click(),
  )
  await gui.waitForFunction(
    () => document.getElementById('dsh-tab-groups-bridge')?.shadowRoot?.querySelector('.panel')?.hidden === false,
    undefined,
    { timeout: TIMEOUT_MS },
  )
  await gui.waitForTimeout(500)

  const clip = await gui.evaluate((padding) => {
    const wrap = document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('.wrap')
    const rect = wrap.getBoundingClientRect()
    return {
      x: Math.max(0, Math.round(rect.x) - padding),
      y: Math.max(0, Math.round(rect.y) - padding),
      width: Math.min(window.innerWidth, Math.round(rect.width) + padding * 2),
      height: Math.min(window.innerHeight, Math.round(rect.height) + padding * 2),
    }
  }, 22)
  await gui.screenshot({ path: join(OUT_DIR, '01-chip-panel.png'), clip })
  console.log('  01-chip-panel.png')

  /* --------------------------- popup and options, with tabs to count ---- */

  const extras = []
  for (let i = 0; i < EXTRA_TABS; i += 1) {
    const page = await context.newPage()
    await page.goto(`${base}?tab=${i}`, { waitUntil: 'domcontentloaded' })
    extras.push(page)
  }
  // Let the extension notice them, so the popup prints real numbers.
  await gui.waitForFunction(
    () =>
      /命中/.test(
        document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('.panel')?.innerText ?? '',
      ),
    undefined,
    { timeout: TIMEOUT_MS },
  )
  await gui.waitForTimeout(1500)

  const popup = await context.newPage()
  await popup.setViewportSize({ width: 340, height: 300 })
  await popup.goto(`chrome-extension://${extensionId}/src/popup.html`)
  await popup.waitForFunction(() => document.getElementById('stat-dsh')?.textContent !== '–', undefined, {
    timeout: TIMEOUT_MS,
  })
  await popup.waitForTimeout(500)
  await popup.screenshot({ path: join(OUT_DIR, '02-popup.png') })
  const counted = Number((await popup.textContent('#stat-dsh'))?.trim())
  console.log(`  02-popup.png（统计到 ${counted} 个 DSH 标签页）`)
  await popup.close()

  const options = await context.newPage()
  await options.setViewportSize({ width: 900, height: 900 })
  await options.goto(`chrome-extension://${extensionId}/src/options.html`)
  // A full-page screenshot renders `position: sticky` where it happens to be
  // stuck (mid-document), which would cover the text it floats over. Pin the
  // action bar back into the flow for the shot only.
  await options.addStyleTag({ content: '.actions { position: static !important; }' })
  await options.waitForFunction(
    () => /命中 \d+ 个/.test(document.getElementById('preview')?.textContent ?? ''),
    undefined,
    { timeout: TIMEOUT_MS },
  )
  await options.waitForTimeout(500)
  await options.screenshot({ path: join(OUT_DIR, '03-options.png'), fullPage: true })
  console.log('  03-options.png')
  await options.close()

  /* ------------------------- the settings section itself ---------------- */

  // The other seat: 设置 → 「DSH 标签页」. Synthetic clicks, because the shell can
  // keep a mask mounted over the nav (a real pointer click is then refused).
  const clickEl = (locator) => locator.evaluate((node) => node.click())
  await gui.evaluate(() => window.scrollTo(0, 0))
  await gui.waitForFunction(() => document.querySelector('[data-dsh-boot]') === null, undefined, {
    timeout: TIMEOUT_MS,
  })
  await clickEl(gui.getByText('设置', { exact: true }).first())
  const navRow = gui.getByText('DSH 标签页', { exact: true }).first()
  await navRow.waitFor({ timeout: TIMEOUT_MS })
  await clickEl(navRow)
  const sectionCard = gui.locator('[data-dsh-tab-groups-section]')
  if ((await sectionCard.count()) === 0) {
    await navRow.evaluate((node) => (node.closest('button, [role="tab"], a, li') ?? node).click())
  }
  await sectionCard.waitFor({ timeout: TIMEOUT_MS })
  await gui.waitForFunction(
    () => /扩展 v\d/.test(document.querySelector('[data-dsh-tab-groups-section]')?.innerText ?? ''),
    undefined,
    { timeout: TIMEOUT_MS },
  )
  await gui.waitForTimeout(500)
  const sectionClip = await sectionCard.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const left = Math.max(0, Math.round(rect.x) - 420, 0)
    return {
      x: left,
      y: 0,
      width: Math.min(window.innerWidth - left, Math.round(rect.width) + 460),
      height: window.innerHeight,
    }
  })
  await gui.screenshot({ path: join(OUT_DIR, '04-settings-section.png'), clip: sectionClip })
  console.log('  04-settings-section.png（设置 → DSH 标签页）')

  for (const page of extras) await page.close()
  await gui.close()

  if (counted < EXTRA_TABS + 1) {
    console.log(`  ! 预期至少 ${EXTRA_TABS + 1} 个 DSH 标签页，实际 ${counted}`)
    process.exitCode = 1
  }
} finally {
  if (context) await context.close().catch(() => {})
  server.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
