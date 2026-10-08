/**
 * Does the plugin's own UI really appear where DSH puts plugin settings, and can
 * it write config back?
 *
 * Two seats are checked, because they fail for different reasons:
 *
 *   1. `settings.section` → Settings → 「DSH 标签页」 (the ecosystem's home for a
 *      plugin's own settings);
 *   2. `plugins.bundle.config` → the Plugins section → this bundle's own page,
 *      where the card must land between the description and the component rows
 *      (that component row is a status list and has never been clickable).
 *
 * Run it two ways:
 *   bash tools/with-scratch-profile.sh node tools/verify-section.mjs   (isolated)
 *   GUI_URL=<your GUI URL> MIRROR=~/.dsh/dsh-tab-groups-extension node tools/verify-section.mjs
 *
 * Every interaction is a JS click dispatched inside the page and every wait is
 * retried: locator resolution races the shell's re-renders, and a click can land
 * before the shell has attached its handlers. Both were mistaken for product
 * bugs once — they were this test's bugs.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPlaywright } from './playwright-loader.mjs'

const GUI = process.env.GUI_URL
const MIRROR = process.env.MIRROR
const CHANNEL = process.env.E2E_CHANNEL || 'msedge'

if (!GUI || !MIRROR) {
  console.error('需要 GUI_URL 与 MIRROR 两个环境变量（用 tools/with-scratch-profile.sh 会自动提供）')
  process.exit(2)
}

const results = []
const check = (name, value, detail = '') => {
  results.push({ name, ok: Boolean(value) })
  console.log(`  ${value ? '✔' : '✖'} ${name}${value || !detail ? '' : `\n      ${detail}`}`)
}

const { chromium } = await loadPlaywright()
const dir = mkdtempSync(join(tmpdir(), 'verify-section-'))
const context = await chromium.launchPersistentContext(dir, {
  channel: CHANNEL,
  headless: true,
  args: [`--disable-extensions-except=${MIRROR}`, `--load-extension=${MIRROR}`, '--no-first-run'],
})

try {
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)))
  // The plugin logs its own trouble (a seat that would not register) as a
  // warning rather than throwing, so collect those too: without them a missing
  // section looks like a mystery instead of a named failure.
  const pluginLogs = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') pluginLogs.push(message.text().slice(0, 300))
  })

  await page.goto(GUI, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.getElementById('dsh-tab-groups-bridge') !== null, undefined, {
    timeout: 40000,
  })
  check('插件芯片挂载成功（说明客户端半区激活了，没有把启动搞挂）', true)

  /**
   * Click the element whose own text is exactly `label`.
   *
   * Clickable elements are searched first and clicked directly: `closest()` only
   * walks *up*, so starting from a wrapping div finds no button inside it and the
   * click lands on nothing (which is how this silently stopped opening Settings).
   */
  const clickByText = (label) =>
    page.evaluate((text) => {
      const clickable = [...document.querySelectorAll('button, a, [role="tab"], [role="button"], li')]
      const direct = clickable.find((node) => (node.textContent ?? '').trim() === text && node.offsetParent !== null)
      if (direct !== undefined) {
        direct.click()
        return true
      }
      const leaves = [...document.querySelectorAll('*')].filter((node) => (node.textContent ?? '').trim() === text)
      const leaf = leaves[leaves.length - 1]
      if (leaf === undefined) return false
      ;(leaf.closest('button, a, [role="tab"], [role="button"]') ?? leaf).click()
      return true
    }, label)

  const waitFor = (predicate, timeout = 20000) =>
    page
      .waitForFunction(predicate, undefined, { timeout })
      .then(() => true)
      .catch(() => false)

  /** Click `label` until the page-side `predicate` holds. */
  const clickUntil = async (label, predicate, attempts = 3, perTry = 8000) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await page.waitForTimeout(1000)
      await clickByText(label)
      if (await waitFor(predicate, perTry)) return true
    }
    return false
  }

  /**
   * A throwaway profile is a *first* run, so the shell raises its 「预览版说明」
   * notice over everything, with a single 「继续」 button. It appears on some runs
   * and not others, and this script spent a while reporting "the settings section
   * never registered" while it was in fact being covered up. Clear it, then click.
   */
  const dismissBlockingNotice = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const clicked = await page.evaluate(() => {
        const labels = ['继续', '跳过', '知道了', '完成', '开始使用', '同意']
        const hit = [...document.querySelectorAll('button')].find(
          (node) => labels.includes((node.textContent ?? '').trim()) && node.offsetParent !== null,
        )
        if (hit === undefined) return false
        hit.click()
        return true
      })
      if (!clicked) return
      await page.waitForTimeout(600)
    }
  }

  const settingsDialogOpen = () =>
    [...document.querySelectorAll('*')].some((node) => (node.textContent ?? '').trim() === '通用设置')

  const openSettings = async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await dismissBlockingNotice()
      await clickByText('设置')
      if (await waitFor(settingsDialogOpen, 6000)) return true
      await page.waitForTimeout(700)
    }
    return false
  }

  /* ---------------- seat 1: Settings → 「DSH 标签页」 ---------------- */

  // The boot screen paints a mask over everything; a click through it silently
  // does nothing.
  await waitFor(
    () => {
      if (document.querySelector('[data-dsh-boot]') !== null) return false
      const nav = [...document.querySelectorAll('button, a, [role="button"]')].find(
        (node) => (node.textContent ?? '').trim() === '设置',
      )
      return nav !== undefined && nav.offsetParent !== null
    },
    40000,
  )

  check('侧栏「设置」能打开设置对话框', await openSettings())

  // Poll, do not read once: the dialog paints its chrome first and its section
  // rows a beat later, so an immediate read says "no such section" on a shell
  // that is about to render it.
  const navRowExists = () =>
    [...document.querySelectorAll('*')].some((node) => (node.textContent ?? '').trim() === 'DSH 标签页')
  check('设置里出现了插件自己的一级分区「DSH 标签页」', await waitFor(navRowExists, 20000))

  // A visited settings panel stays mounted but `hidden`, so "the element exists"
  // is not "the section is showing" — the card must be *visible* to count.
  // A browser-side predicate: `waitForFunction` serialises it into the page, so
  // it must not close over anything from here (wrapping `page.evaluate` inside it
  // threw `page is not defined` in the browser and counted as a page error).
  const cardPresent = () =>
    [...document.querySelectorAll('[data-dsh-tab-groups-section]')].some((node) => node.offsetParent !== null)
  const entered = await clickUntil('DSH 标签页', cardPresent, 4, 10000)
  check('点进「DSH 标签页」后卡片可见', entered)
  if (!entered) {
    console.log('      插件自己的日志：', pluginLogs.slice(0, 6).join(' || ') || '（无）')
    console.log('      导航里的项：', JSON.stringify(await page.evaluate(() =>
      [...document.querySelectorAll('nav button, [role="dialog"] button')].map((n) => (n.textContent ?? '').trim()).filter(Boolean).slice(0, 16))))
    console.log('      最上层弹窗文本：', await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], dialog')].filter((n) => n.offsetParent !== null)
      const top = dialogs[dialogs.length - 1]
      return (top?.innerText ?? '（无可见弹窗）').replace(/\n+/g, ' | ').slice(0, 300)
    }))
    throw new Error('设置分区没有挂载，已转储插件日志与导航项')
  }
  const card = page.locator('[data-dsh-tab-groups-section]:visible').first()
  await card.waitFor({ timeout: 15000 })

  const cardText = async () => card.innerText()
  await waitFor(
    () =>
      /插件 v\d/.test(
        [...document.querySelectorAll('[data-dsh-tab-groups-section]')]
          .filter((node) => node.offsetParent !== null)
          .map((node) => node.innerText)
          .join('\n'),
      ),
    20000,
  )
  const text = await cardText()
  check(
    '卡片同时显示插件版本与扩展版本（只写一个版本号会被误读成插件版本）',
    /插件 v\d+\.\d+\.\d+ · 扩展 v\d+\.\d+\.\d+ · 协议 v\d+/.test(text),
    text.split('\n').slice(0, 3).join(' / '),
  )
  check(
    '卡片里有开关（启用自动归组 / 收进专属窗口）',
    (await card.locator('input[type="checkbox"]').count()) >= 2,
    `checkbox 数 ${await card.locator('input[type="checkbox"]').count()}`,
  )
  check(
    '卡片里有组名与颜色控件',
    (await card.locator('select').count()) >= 1 && (await card.locator('input[type="text"]').count()) >= 1,
  )

  const boxes = card.locator('input[type="checkbox"]')
  await boxes.nth(1).click()
  // Classify inside the page, in one call: the card clears its own "已保存" note
  // after a few seconds, so "wait for the note, then read it again" races that
  // timer and fails on a save that actually succeeded.
  const saveOutcome = await page
    .waitForFunction(
      () => {
        const text = [...document.querySelectorAll('[data-dsh-tab-groups-section]')]
          .filter((node) => node.offsetParent !== null)
          .map((node) => node.innerText)
          .join('\n')
        if (/已保存/.test(text)) return 'ok'
        if (/保存失败/.test(text)) return 'bad'
        return false
      },
      undefined,
      { timeout: 20000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => 'timeout')
  check('在设置页勾选「收进专属窗口」被扩展接受', saveOutcome === 'ok', `结果=${saveOutcome}`)

  /* -------- seat 2: Plugins → this bundle's own page -------- */

  // Close the dialog first: the Plugins page is a main-area view, and leaving the
  // modal up reached the page but not its cards.
  await clickByText('关闭')
  await page.waitForTimeout(600)
  check('侧栏「插件」可点', await clickByText('插件'))
  await waitFor(() => document.body.innerText.includes('安装、启用和配置插件'), 20000)
  check('进入了「插件」分区', true)

  // The roster arrives asynchronously: the intro paints first, the cards after it.
  const bundleCardPresent = () =>
    [...document.querySelectorAll('button')].some(
      (node) => (node.textContent ?? '').trim() === 'dsh-tab-groups',
    )
  await waitFor(bundleCardPresent, 20000)
  const openBundlePage = () =>
    page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (node) => (node.textContent ?? '').trim() === 'dsh-tab-groups',
      )
      if (button === undefined) return false
      button.click()
      return true
    })
  let onBundlePage = false
  for (let attempt = 1; attempt <= 3 && !onBundlePage; attempt += 1) {
    if (attempt > 1) await page.waitForTimeout(1000)
    await openBundlePage()
    onBundlePage = await waitFor(() => document.body.innerText.includes('包含的组件'), 8000)
  }
  check('点开了 dsh-tab-groups 自己的插件页', onBundlePage)

  const seatTwo = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-dsh-tab-groups-section]')].filter(
      (node) => node.offsetParent !== null,
    )
    const card = cards[0]
    const first = (card?.innerText ?? '').split('\n')[0]
    const body = document.body.innerText
    return {
      cards: cards.length,
      beforeRows: card !== undefined && first !== '' && body.indexOf(first) < body.indexOf('包含的组件'),
      text: (card?.innerText ?? '').slice(0, 60).replace(/\n/g, ' / '),
    }
  })
  check(
    '卡片出现在该页的描述与组件清单之间（那一行组件本身永远不可点）',
    seatTwo.cards >= 1 && seatTwo.beforeRows,
    JSON.stringify(seatTwo),
  )

  check('页面没有 JS 报错', pageErrors.length === 0, pageErrors.join(' | '))
  check('插件自己没有报出注册失败', !pluginLogs.some((line) => /dsh-tab-groups/.test(line)), pluginLogs.join(' | '))
} finally {
  await context.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const result of failed) console.log(`  ✖ ${result.name}`)
  process.exitCode = 1
}
