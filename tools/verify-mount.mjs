#!/usr/bin/env node
/**
 * Does the plugin actually mount in a real DSH host?
 *
 * `tools/verify-profile.sh` boots an isolated DSH instance whose profile
 * contains this package and nothing else beyond the core web bundles. This
 * script then opens that instance's Web GUI in a real Edge/Chromium **with the
 * extension loaded from the mirror the host half produced**, and asserts that:
 *
 *   1. the mirror the host wrote is itself a loadable extension, with the pinned id;
 *   2. the GUI renders the plugin's chip with **no injection of any kind** —
 *      the real host served the client bundle because the cordis row resolved;
 *   3. the chip reaches the connected state, i.e. the plugin half found the
 *      extension over `externally_connectable` in a real browser;
 *   4. loading the page raised no JavaScript error.
 *
 *   MIRROR=/path/to/mirror GUI_URL="http://127.0.0.1:PORT/?token=..." \
 *     PLAYWRIGHT_PATH=... node tools/verify-mount.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXTENSION_ID } from '../src/extension-id.js'
import { loadPlaywright } from './playwright-loader.mjs'

const MIRROR = process.env.MIRROR
const GUI_URL = process.env.GUI_URL
const CHANNEL = process.env.E2E_CHANNEL || 'msedge'
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 30000)

if (!MIRROR || !GUI_URL) {
  console.error('usage: MIRROR=<mirror dir> GUI_URL=<url with token> node tools/verify-mount.mjs')
  process.exit(2)
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok })
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
}

const { chromium } = await loadPlaywright()
const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-tab-groups-mount-'))
let context
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: CHANNEL,
    headless: process.env.E2E_HEADED !== '1',
    args: [
      `--disable-extensions-except=${MIRROR}`,
      `--load-extension=${MIRROR}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: TIMEOUT_MS }))
  const loadedId = new URL(worker.url()).host
  check('宿主半区写出的镜像目录可以被浏览器加载为扩展', true)
  check('镜像加载出来的扩展 ID 与插件里的常量一致（钉 key 生效）', loadedId === EXTENSION_ID, `实际 ${loadedId}`)

  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)))
  await page.goto(GUI_URL, { waitUntil: 'domcontentloaded' })

  // No addInitScript, no evaluate, no injection: if the chip is here, the host
  // delivered it.
  await page.waitForFunction(() => document.getElementById('dsh-tab-groups-bridge') !== null, undefined, {
    timeout: TIMEOUT_MS,
  })
  check('真实宿主投递了插件的浏览器半区，芯片出现在 GUI 里（全程零注入）', true)

  await page.waitForFunction(
    () => {
      const shadow = document.getElementById('dsh-tab-groups-bridge')?.shadowRoot
      return shadow?.querySelector('.dot.ready') !== null && shadow?.querySelector('.dot.ready') !== undefined
    },
    undefined,
    { timeout: TIMEOUT_MS },
  )
  const state = await page.evaluate(() => {
    const wrap = document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('.wrap')
    return { ready: !!wrap.querySelector('.dot.ready'), collapsed: wrap.classList.contains('collapsed') }
  })
  check('芯片检测到配套扩展并进入已连接状态（真实 GUI → externally_connectable → 扩展）', state.ready === true)
  check('已连接时芯片默认收起为一颗状态点（不常驻占位）', state.collapsed === true, JSON.stringify(state))

  // Expand like a user, then read the panel — a hidden panel has no innerText.
  await page.evaluate(() =>
    document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('.chip').click(),
  )
  await page.waitForFunction(
    () => document.getElementById('dsh-tab-groups-bridge')?.shadowRoot?.querySelector('.panel')?.hidden === false,
    undefined,
    { timeout: TIMEOUT_MS },
  )
  const expanded = await page.evaluate(
    () => document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('.panel')?.innerText ?? '',
  )
  check(
    '点一下芯片能展开，面板显示扩展版本与实时计数',
    /扩展 v\d/.test(expanded) && /命中的 DSH 标签页/.test(expanded),
    expanded.slice(0, 140),
  )

  // 「隐藏」 removes the chip; a reload must bring it back through the real host.
  await page.evaluate(() =>
    document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('button[data-act="hide"]').click(),
  )
  check(
    '面板里的「隐藏」能把芯片整个收掉',
    (await page.evaluate(() =>
      document
        .getElementById('dsh-tab-groups-bridge')
        .shadowRoot.querySelector('.wrap')
        .classList.contains('hidden'),
    )) === true,
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.getElementById('dsh-tab-groups-bridge') !== null, undefined, {
    timeout: TIMEOUT_MS,
  })
  check(
    '刷新后真实宿主重新投递、芯片自己回来（隐藏不持久化）',
    (await page.evaluate(() =>
      document
        .getElementById('dsh-tab-groups-bridge')
        .shadowRoot.querySelector('.wrap')
        .classList.contains('hidden'),
    )) === false,
  )
  check('加载插件的 GUI 页面没有 JS 报错', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  if (context) await context.close().catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
if (failed.length > 0) process.exitCode = 1
