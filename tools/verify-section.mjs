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

  // The boot screen paints a mask over everything; wait it out before clicking.
  await page
    .waitForFunction(() => document.querySelector('[data-dsh-boot]') === null, undefined, { timeout: 20000 })
    .catch(() => {})

  // Synthetic clicks: the shell can keep a mask mounted over the nav, and a real
  // pointer click is then correctly refused. Clicking the resolved element
  // directly drives its React handler either way.
  const clickEl = (locator) => locator.evaluate((node) => node.click())
  const settingsNav = page.getByText('设置', { exact: true }).first()
  await settingsNav.waitFor({ timeout: 20000 })
  await clickEl(settingsNav)
  check('点到了侧栏的「设置」', true)

  // The registrant's nav label must show up in the settings nav, and clicking it
  // must mount the section.
  const navRow = page.getByText('DSH 标签页', { exact: true }).first()
  await navRow.waitFor({ timeout: 20000 })
  check('设置里出现了插件自己的一级分区「DSH 标签页」', true)

  const sectionCard = page.locator('[data-dsh-tab-groups-section]')
  for (const attempt of ['nav-row', 'closest-button', 'tab-role']) {
    if ((await sectionCard.count()) > 0) break
    if (attempt === 'nav-row') await clickEl(navRow)
    else if (attempt === 'closest-button') {
      await navRow.evaluate((node) => (node.closest('button, [role="tab"], a, li') ?? node).click())
    } else {
      await page
        .locator('[role="tab"], [role="button"], button, a')
        .filter({ hasText: 'DSH 标签页' })
        .first()
        .evaluate((node) => node.click())
        .catch(() => {})
    }
    await page.waitForTimeout(1200)
  }

  if ((await sectionCard.count()) === 0) {
    const panelText = await page.evaluate(() => {
      const panel = document.querySelector('[class*="panel"], main, [role="tabpanel"]')
      return (panel?.innerText ?? document.body.innerText).slice(0, 400).replace(/\n+/g, ' | ')
    })
    check('点击分区后挂载了设置卡片', false, `面板内容：${panelText}`)
    throw new Error('设置分区没有挂载，已转储面板内容')
  }

  const card = page.locator('[data-dsh-tab-groups-section]')
  await card.waitFor({ timeout: 15000 })
  check('分区里渲染出了插件的设置卡片', true)

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
