/**
 * Does the plugin's settings section actually appear and work?
 * Run inside tools/with-scratch-profile.sh, which provides GUI_URL + MIRROR.
 */
import { chromium } from '/Users/337mu/Documents/Default Project/dsh-web/node_modules/playwright/index.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GUI = process.env.GUI_URL
const MIRROR = process.env.MIRROR
const dir = mkdtempSync(join(tmpdir(), 'verify-section-'))
const ctx = await chromium.launchPersistentContext(dir, {
  channel: process.env.E2E_CHANNEL || 'msedge',
  headless: true,
  args: [`--disable-extensions-except=${MIRROR}`, `--load-extension=${MIRROR}`, '--no-first-run'],
})
const ok = []
const check = (n, v, d = '') => {
  ok.push(!!v)
  console.log(`  ${v ? '✔' : '✖'} ${n}${v || !d ? '' : `\n      ${d}`}`)
}
try {
  const page = await ctx.newPage()
  const errors = []
  const logs = []
  page.on('pageerror', (e) => errors.push(String(e.message ?? e)))
  page.on('console', (m) => { if (['error','warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text()) })
  await page.goto(GUI, { waitUntil: 'domcontentloaded' })
  try {
    await page.waitForFunction(() => document.getElementById('dsh-tab-groups-bridge') !== null, undefined, { timeout: 30000 })
  } catch (e) {
    console.log('  ✖ 芯片没出现，诊断信息：')
    console.log('    pageerror:', errors.slice(0, 5).join(' | ') || '（无）')
    console.log('    console  :', logs.slice(0, 8).join('\n               ') || '（无）')
    throw e
  }

  // Everything below happens *inside* the page: locator resolution races with
  // the shell's re-renders (a locator that just resolved can be detached before
  // the next call), so clicks and lookups are done atomically in the DOM.
  const clickByText = (label) =>
    page.evaluate((text) => {
      const nodes = [...document.querySelectorAll('button, a, [role="tab"], li, [role="button"]')]
      const hit = nodes.find((node) => (node.textContent ?? '').trim() === text && node.offsetParent !== null)
      if (hit === undefined) return false
      hit.click()
      return true
    }, label)

  const hasText = (label) =>
    page.evaluate((text) => {
      const nodes = [...document.querySelectorAll('button, a, [role="tab"], li, [role="button"], h1, h2, h3')]
      return nodes.some((node) => (node.textContent ?? '').trim() === text)
    }, label)

  // Wait until the shell is interactive: the boot screen paints a mask over
  // everything, and clicking through it silently does nothing (which is how this
  // test used to "fail" on a busy instance carrying ~25 client plugins).
  await page.waitForFunction(
    () => {
      if (document.querySelector('[data-dsh-boot]') !== null) return false
      const nav = [...document.querySelectorAll('button, a, [role="button"]')].find(
        (node) => (node.textContent ?? '').trim() === '设置',
      )
      return nav !== undefined && nav.offsetParent !== null
    },
    undefined,
    { timeout: 30000 },
  )

  // Retry: on a fast boot the first click can land before the shell has attached
  // its handlers, and a click that does nothing is indistinguishable from one
  // that was ignored. A later click also undoes a mis-toggle, so 3 tries is safe.
  const dialogOpen = () =>
    page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('button, a, [role="tab"], li')].some(
            (node) => (node.textContent ?? '').trim() === '通用设置',
          ),
        undefined,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false)
  let opened = false
  for (let attempt = 1; attempt <= 3 && !opened; attempt += 1) {
    if (attempt > 1) await page.waitForTimeout(1200)
    await clickByText('设置')
    opened = await dialogOpen()
  }
  check('侧栏「设置」能打开设置对话框', opened, '点了 3 次都没打开')
  if (!opened) throw new Error('设置对话框打不开，后面的断言没有意义')
  check('设置里出现了插件自己的一级分区「DSH 标签页」', await hasText('DSH 标签页'))
  check('点进了「DSH 标签页」分区', await clickByText('DSH 标签页'))
  await page.waitForFunction(() => document.querySelector('[data-dsh-tab-groups-section]') !== null, undefined, {
    timeout: 20000,
  })
  check('分区里渲染出了插件的设置卡片', true)
  const card = page.locator('[data-dsh-tab-groups-section]')
  await card.waitFor({ timeout: 15000 })

  await page
    .waitForFunction(
      () => /扩展 v\d/.test(document.querySelector('[data-dsh-tab-groups-section]')?.innerText ?? ''),
      undefined,
      { timeout: 20000 },
    )
    .catch(() => {})
  const text = await card.innerText()
  check('卡片显示扩展版本与协议', /扩展 v\d+\.\d+\.\d+ · 协议 v\d+/.test(text), text.split('\n').slice(0, 3).join(' / '))
  const hasWindowToggle = await card.locator('input[type="checkbox"]').count()
  check('卡片里有开关（启用自动归组 / 收进专属窗口）', hasWindowToggle >= 2, `checkbox 数 ${hasWindowToggle}`)
  check('卡片里有组名与颜色控件', (await card.locator('select').count()) >= 1 && (await card.locator('input[type="text"]').count()) >= 1)

  // Drive it: toggle the second checkbox (收进专属窗口) and expect a save
  const boxes = card.locator('input[type="checkbox"]')
  await boxes.nth(1).click()
  await page.waitForFunction(
    () => /已保存|失败/.test(document.querySelector('[data-dsh-tab-groups-section]')?.innerText ?? ''),
    undefined,
    { timeout: 15000 },
  )
  const after = await card.innerText()
  check('在设置页勾选「收进专属窗口」被扩展接受', /已保存/.test(after), after.split('\n').filter((l) => /保存|失败/.test(l)).join(' / '))
  check('页面没有 JS 报错', errors.length === 0, errors.join(' | '))
} finally {
  await ctx.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
}
const bad = ok.filter((v) => !v).length
console.log(`\n${ok.length - bad}/${ok.length} 项通过`)
if (bad) process.exitCode = 1
