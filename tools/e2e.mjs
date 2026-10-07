#!/usr/bin/env node
/**
 * End-to-end verification: load this extension into a real Chromium and check
 * that tab groups actually appear in the browser's own tab-group state.
 *
 * The assertions read `chrome.tabGroups` / `chrome.tabs` from inside the
 * extension's own service worker, i.e. they observe the same state the user
 * sees in the tab strip — not a mock of it.
 *
 *   PLAYWRIGHT_PATH="/path/to/node_modules/playwright" node tools/e2e.mjs
 *
 * Optional real-GUI lane (opens the live DeepSeek Harness Web GUI):
 *   DSH_E2E_URL="http://127.0.0.1:3080/?token=..." node tools/e2e.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXTENSION_ID, PROTOCOL_VERSION } from '../src/extension-id.js'
import { clientHalfBootstrap } from './client-half-bootstrap.mjs'
import { loadPlaywright } from './playwright-loader.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = join(HERE, '..')

const HEADED = process.env.E2E_HEADED === '1'
const REAL_URL = process.env.DSH_E2E_URL || ''
/** 'chromium' (Playwright's own build) or 'msedge' / 'chrome' for a real install. */
const CHANNEL = process.env.E2E_CHANNEL || 'chromium'
const POLL_INTERVAL_MS = 150
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 15000)

/* ------------------------------------------------------------- harness */

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, probe, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = await probe()
    if (last) return last
    if (Date.now() > deadline) {
      throw new Error(`超时等待：${label}\n最后一次观测：${JSON.stringify(last)}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

/* --------------------------------------------------------- mock server */

const page = (title, extra = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${extra}</body></html>`

const ROUTES = {
  // A faithful stand-in for the DSH Web GUI: same <title>, same boot global.
  '/dsh': page('DeepSeek Harness', '<script>window.__DSH_BOOT__={entries:[]}</script>'),
  // A different site whose title merely starts with the same words.
  '/docs': page('DeepSeek Harness Docs'),
  '/other': page('Example Domain'),
}

function startServer() {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const body = ROUTES[path]
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

/* ---------------------------------------------------------------- main */

async function main() {
  const { chromium } = await loadPlaywright()
  const { server, base } = await startServer()
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-tab-groups-e2e-'))

  console.log(`扩展目录  ${EXTENSION_PATH}`)
  console.log(`模拟站点  ${base}`)
  console.log(`浏览器    ${HEADED ? 'headed' : 'headless'} ${CHANNEL}\n`)

  /** @type {import('playwright').BrowserContext | undefined} */
  let context
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: CHANNEL,
      headless: !HEADED,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    })

    /* --- the extension's own service worker is our window into the browser --- */

    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: TIMEOUT_MS }))
    const extensionId = new URL(worker.url()).host
    console.log(`  扩展已加载：${extensionId}\n`)
    check(
      '固定 key 生效：真实加载出来的扩展 ID 与插件半区里的常量一致',
      extensionId === EXTENSION_ID,
      `浏览器给出 ${extensionId}，插件寻址 ${EXTENSION_ID}`,
    )

    const readBrowser = () =>
      worker.evaluate(async () => {
        const [tabs, groups] = await Promise.all([
          chrome.tabs.query({}),
          chrome.tabGroups.query({}),
        ])
        return {
          tabs: tabs.map((tab) => ({
            id: tab.id,
            url: tab.pendingUrl || tab.url,
            title: tab.title,
            groupId: tab.groupId,
            pinned: tab.pinned,
          })),
          groups: groups.map((group) => ({
            id: group.id,
            title: group.title,
            color: group.color,
            collapsed: group.collapsed,
            windowId: group.windowId,
          })),
        }
      })

    const groupByTitle = async (title) => {
      const state = await readBrowser()
      return state.groups.find((group) => group.title === title) ?? null
    }
    const dshGroup = () => groupByTitle('DSH')
    const tabsInGroup = async (groupId) => {
      const state = await readBrowser()
      return state.tabs.filter((tab) => tab.groupId === groupId)
    }

    /* ---------------------------------------------- 1. first DSH tab groups */

    const first = await context.newPage()
    await first.goto(`${base}/dsh`)

    const group = await waitFor('标签组「DSH」出现', dshGroup)
    check('打开第一个 DSH 标签页后，自动创建了名为 DSH 的标签组', group !== null)
    check('组颜色为配置的 blue', group?.color === 'blue', `实际 ${group?.color}`)
    check('组未折叠（默认配置）', group?.collapsed === false)

    const initial = await tabsInGroup(group.id)
    check('组内恰好只有那 1 个 DSH 标签页', initial.length === 1, `实际 ${initial.length}`)

    /* ------------------------------------- 2. non-DSH neighbours stay outside */

    const other = await context.newPage()
    await other.goto(`${base}/other`)
    const docs = await context.newPage()
    await docs.goto(`${base}/docs`)

    // Give the extension time to (wrongly) react, then assert it did not.
    await sleep(1200)
    const afterNeighbours = await readBrowser()
    const dshTabsNow = afterNeighbours.tabs.filter((tab) => tab.groupId === group.id)
    check(
      '标题形如「DeepSeek Harness Docs」的其他站点没有被拉进组（前缀匹配不误伤）',
      dshTabsNow.length === 1,
      `组内 ${dshTabsNow.length} 个：${JSON.stringify(dshTabsNow.map((tab) => tab.title))}`,
    )
    check(
      '普通网页未被归组',
      afterNeighbours.tabs.filter((tab) => tab.groupId !== -1).length === 1,
      `被归组的标签页数 ${afterNeighbours.tabs.filter((tab) => tab.groupId !== -1).length}`,
    )

    /* ------------------------------- 3. later DSH tabs join automatically */

    const second = await context.newPage()
    await second.goto(`${base}/dsh?n=2`)
    const third = await context.newPage()
    await third.goto(`${base}/dsh?n=3`)

    await waitFor('后开的 DSH 标签页自动入组', async () => {
      const tabs = await tabsInGroup(group.id)
      return tabs.length === 3 ? tabs : null
    })
    const grown = await tabsInGroup(group.id)
    check('后新开的 2 个 DSH 标签页自动加入了同一个组', grown.length === 3, `实际 ${grown.length}`)
    check(
      '全部 3 个都落在同一个组里（没有各自建组）',
      new Set(grown.map((tab) => tab.groupId)).size === 1,
    )

    /* ------------------------ 3b. pinned tabs are left alone (Chromium forbids it) */

    const pinnedPage = await context.newPage()
    await pinnedPage.goto(`${base}/dsh?pin=1`)
    await waitFor('带 pin=1 的标签页先被归组', async () => {
      const state = await readBrowser()
      const target = state.tabs.find((tab) => (tab.url ?? '').includes('pin=1'))
      return target && target.groupId !== -1 ? target : null
    })
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({})
      const target = tabs.find((tab) => (tab.pendingUrl || tab.url || '').includes('pin=1'))
      if (target) await chrome.tabs.update(target.id, { pinned: true })
    })
    await sleep(1200) // give the extension several chances to (wrongly) re-group it
    const pinnedState = (await readBrowser()).tabs.find((tab) => (tab.url ?? '').includes('pin=1'))
    check(
      '固定（pinned）标签页不会被塞进标签组',
      pinnedState?.pinned === true && pinnedState?.groupId === -1,
      JSON.stringify({ pinned: pinnedState?.pinned, groupId: pinnedState?.groupId }),
    )
    check('固定标签页不影响其它 DSH 标签页留在组内', (await tabsInGroup(group.id)).length === 3)
    await pinnedPage.close()
    await waitFor('关掉固定标签页后组内回到 3 个', async () => {
      const state = await readBrowser()
      return state.tabs.filter((tab) => tab.groupId === group.id).length === 3
    })

    /* ------- 3c. a DSH page drives the extension over externally_connectable */

    /** Send one protocol message from a page and resolve its response. */
    const pageCall = (page, payload) =>
      page.evaluate(
        ({ expectedId, message }) =>
          new Promise((resolve) => {
            const runtime = globalThis.chrome?.runtime
            if (typeof runtime?.sendMessage !== 'function') {
              resolve({ ok: false, error: 'no-bridge' })
              return
            }
            runtime.sendMessage(expectedId, message, (response) => {
              const failure = runtime.lastError
              resolve(failure ? { ok: false, error: String(failure.message ?? failure) } : response)
            })
          }),
        { expectedId: EXTENSION_ID, message: payload },
      )

    const driver = await context.newPage()
    await driver.goto(`${base}/dsh?driver=1`)
    const hasBridge = await driver.evaluate(
      () => typeof globalThis.chrome?.runtime?.sendMessage === 'function',
    )
    check(
      'DSH 页面拿到了 chrome.runtime（externally_connectable 桥已建立）',
      hasBridge === true,
      '页面没有 chrome.runtime，说明 externally_connectable 没匹配上',
    )

    const ping = await pageCall(driver, { type: 'ping' })
    check(
      '页面 ping 到扩展，并读到一致的协议版本',
      ping?.installed === true && ping?.protocol === PROTOCOL_VERSION,
      JSON.stringify(ping),
    )

    const pageStatus = await pageCall(driver, { type: 'status' })
    check(
      '页面能读到实时状态（命中数 / 待归组数 / 窗口数）',
      pageStatus?.ok === true &&
        typeof pageStatus.matched === 'number' &&
        typeof pageStatus.pending === 'number',
      JSON.stringify(pageStatus),
    )
    {
      // matchOrigins legitimately carries loopback origins, so the leak test is
      // specific: none of the *test pages'* addresses, and no url/title field.
      const serialized = JSON.stringify(pageStatus)
      check(
        '页面读到的状态不含任何标签页内容（只有计数，没有地址与标题）',
        pageStatus?.ok === true && !serialized.includes(base) && !/"(url|title|tabs|tabIds)":/.test(serialized),
        serialized.slice(0, 200),
      )
    }

    const rejected = await pageCall(driver, { type: 'set-config', config: { nope: 1 } })
    check(
      '页面写入非法配置被明确拒绝，而不是静默吞掉',
      rejected?.ok === false && /unknown config key/.test(rejected.error ?? ''),
      JSON.stringify(rejected),
    )

    const applied = await pageCall(driver, { type: 'set-config', config: { groupTitle: 'DSH · 来自页面' } })
    check(
      '页面改的组名真的落到了扩展配置里',
      applied?.ok === true && applied.config?.groupTitle === 'DSH · 来自页面',
      JSON.stringify(applied),
    )
    const fromPage = await waitFor('页面改名的组出现在浏览器标签栏里', () => groupByTitle('DSH · 来自页面'))
    check(
      '页面驱动的改名在浏览器标签栏里真的生效了',
      (await tabsInGroup(fromPage.id)).some((tab) => (tab.url ?? '').includes('driver=1')),
      JSON.stringify((await tabsInGroup(fromPage.id)).map((tab) => tab.url)),
    )

    const reconciled = await pageCall(driver, { type: 'reconcile' })
    check('页面能直接触发归组并拿到结果', reconciled?.ok === true, JSON.stringify(reconciled))

    const restoreCall = await pageCall(driver, { type: 'set-config', config: { groupTitle: 'DSH' } })
    await waitFor('恢复默认组名', async () => (restoreCall?.ok ? groupByTitle('DSH') : null))
    check('页面能把组名改回去', (await groupByTitle('DSH')) !== null)

    await driver.close()
    await waitFor('页面驱动测试结束后组内回到 3 个', async () => {
      const state = await readBrowser()
      return state.tabs.filter((tab) => tab.groupId === group.id).length === 3
    })

    /* ------------------- 4. the popup UI drives a manual reconcile (idempotence) */

    // A service worker cannot receive its own runtime message, so the manual
    // path is exercised the way a user does: through the popup page.
    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${extensionId}/src/popup.html`)
    await popup.waitForFunction(
      () => document.getElementById('stat-dsh')?.textContent !== '–',
      undefined,
      { timeout: TIMEOUT_MS },
    )
    const shownCount = (await popup.textContent('#stat-dsh'))?.trim()
    check('弹出面板统计到 3 个 DSH 标签页', shownCount === '3', `实际「${shownCount}」`)

    const beforeRepeat = await readBrowser()
    await popup.click('#reconcile')
    await popup.waitForFunction(
      () => /已归组|待归组|失败/.test(document.getElementById('hint')?.textContent ?? ''),
      undefined,
      { timeout: TIMEOUT_MS },
    )
    const hint = ((await popup.textContent('#hint')) ?? '').trim()
    check('弹出面板「立即归组」可用并回报结果', /已归组/.test(hint), hint)

    await sleep(600)
    const afterRepeat = await readBrowser()
    check(
      '重复触发归组不会新增标签组（幂等）',
      afterRepeat.groups.length === beforeRepeat.groups.length,
      `${beforeRepeat.groups.length} → ${afterRepeat.groups.length}`,
    )
    check(
      '重复触发归组不会挪动标签页',
      JSON.stringify(afterRepeat.tabs.map((tab) => tab.groupId).sort((a, b) => a - b)) ===
        JSON.stringify(beforeRepeat.tabs.map((tab) => tab.groupId).sort((a, b) => a - b)),
      JSON.stringify(afterRepeat.tabs.map((tab) => [tab.title, tab.groupId])),
    )
    await popup.close()

    /* ------------- 4b. the options page actually drives the browser's group */

    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/src/options.html`)
    await options.waitForSelector('#groupTitle')
    await options.fill('#groupTitle', 'DSH 会话')
    await options.selectOption('#groupColor', 'purple')
    await options.click('button[type="submit"]')
    await options.waitForFunction(
      () => (document.getElementById('status')?.textContent ?? '').includes('已保存'),
      undefined,
      { timeout: TIMEOUT_MS },
    )
    const renamed = await waitFor('分组改名生效', () => groupByTitle('DSH 会话'))
    check('设置页改组名后，浏览器里的真实标签组跟着改名', renamed !== null)
    check('设置页改颜色后，浏览器里的真实标签组跟着变色', renamed?.color === 'purple', `实际 ${renamed?.color}`)
    check('改名后标签页仍在组内（没有掉出来）', (await tabsInGroup(renamed.id)).length === 3)

    const preview = (await options.textContent('#preview')) ?? ''
    check(
      '设置页的实时预览列出了命中的 DSH 标签页',
      /命中 3 个/.test(preview),
      preview.split('\n')[0],
    )

    await options.click('#reset')
    await waitFor('恢复默认后组名回到 DSH', dshGroup)
    const restored = await groupByTitle('DSH')
    check('恢复默认后组名与颜色都回到默认值', restored?.color === 'blue', `实际 ${restored?.color}`)
    await options.close()

    /* --------------------------------------------- 5. closing tabs unwinds */

    await third.close()
    await waitFor('关闭一个后组内剩 2 个', async () => (await tabsInGroup(group.id)).length === 2)
    check('关掉一个 DSH 标签页后，组内剩 2 个', (await tabsInGroup(group.id)).length === 2)

    await second.close()
    await first.close()
    await waitFor('全部关闭后标签组自动消失', async () => (await dshGroup()) === null)
    check('DSH 标签页全部关闭后，空标签组被浏览器自动清除', true)

    /* -------------------------- 5b. a fresh DSH tab rebuilds the group again */

    const revived = await context.newPage()
    await revived.goto(`${base}/dsh?again=1`)
    const regrouped = await waitFor('关闭后再开能重新建组', dshGroup)
    const revivedTabs = await tabsInGroup(regrouped.id)
    check(
      '组被自动清除后，再开 DSH 标签页会重新建组（过期的组 ID 被丢弃）',
      revivedTabs.length === 1,
      `组内 ${revivedTabs.length} 个`,
    )
    await revived.close()

    /* ------------------------------------- 6. optional: the real DSH GUI */

    if (REAL_URL) {
      console.log('\n真实 DSH Web GUI 通道')
      const real = await context.newPage()
      await real.goto(REAL_URL, { waitUntil: 'domcontentloaded' })
      const realTitle = await real.title()
      check(
        `真实 DSH 页面标题就是识别锚点「DeepSeek Harness」（实际「${realTitle}」）`,
        realTitle === 'DeepSeek Harness',
      )
      const realGroup = await waitFor('真实 DSH 标签页被归组', dshGroup)
      const realTabs = await tabsInGroup(realGroup.id)
      check(
        '真实 DSH GUI 标签页被自动收进组',
        realTabs.some((tab) => tab.url.startsWith(REAL_URL.split('?')[0])),
        JSON.stringify(realTabs.map((tab) => tab.url)),
      )
      await real.close()

      /* ---- the plugin's GUI half, mounted into the real DSH shell ---- */

      const clientSource = readFileSync(join(EXTENSION_PATH, 'lib', 'client.js'), 'utf8')
      await context.addInitScript({ content: clientHalfBootstrap(clientSource) })
      const gui = await context.newPage()
      await gui.goto(REAL_URL, { waitUntil: 'domcontentloaded' })
      await gui.waitForFunction(
        () => ['ready', 'mounted', 'load-failed', 'no-loader', 'spec-missing'].includes(globalThis.__dshTabGroupsTest?.status),
        undefined,
        { timeout: TIMEOUT_MS },
      )
      const loadState = await gui.evaluate(() => ({
        status: globalThis.__dshTabGroupsTest.status,
        error: globalThis.__dshTabGroupsTest.error,
      }))
      check(
        '插件浏览器半区能在真实 DSH 壳里加载（__ModuleLoader__ 存在，源码可执行）',
        loadState.status === 'ready',
        `status=${loadState.status} error=${loadState.error ?? '—'}`,
      )

      const mounted = await gui.evaluate(() =>
        globalThis.__dshTabGroupsTest.mount({
          effect: (fn) => {
            fn()
            return () => {}
          },
        }),
      )
      check('apply(ctx) 在真实 GUI 里挂载成功', mounted === 'mounted' || mounted === 'already', String(mounted))
      const mountedState = await gui.evaluate(() => globalThis.__dshTabGroupsTest.status)
      check('挂载后状态机进入 mounted', mountedState === 'mounted', String(mountedState))

      await gui.waitForFunction(
        () => {
          const host = document.getElementById('dsh-tab-groups-bridge')
          return host?.shadowRoot?.querySelector('.dot.ready') !== null && host?.shadowRoot?.querySelector('.dot.ready') !== undefined
        },
        undefined,
        { timeout: TIMEOUT_MS },
      )
      const chipState = await gui.evaluate(() => {
        const host = document.getElementById('dsh-tab-groups-bridge')
        const shadow = host?.shadowRoot
        const wrap = shadow?.querySelector('.wrap')
        return {
          exists: host !== null && host !== undefined,
          shadow: shadow !== null && shadow !== undefined,
          ready: shadow?.querySelector('.dot.ready') !== null,
          collapsed: wrap?.classList.contains('collapsed') === true,
          hidden: wrap?.classList.contains('hidden') === true,
          panelText: shadow?.querySelector('.panel')?.innerText ?? '',
        }
      })
      check('GUI 里出现了插件芯片（shadow DOM 自包含）', chipState.exists && chipState.shadow)
      check(
        '芯片检测到扩展并进入已连接状态（真实 DSH 页面 → externally_connectable → 扩展）',
        chipState.ready === true,
        JSON.stringify(chipState),
      )
      check(
        '已连接时芯片默认收起为一颗状态点，不常驻占位面板',
        chipState.collapsed === true && chipState.hidden === false,
        JSON.stringify({ collapsed: chipState.collapsed, hidden: chipState.hidden }),
      )

      // The panel content only renders when expanded — click the chip like a user.
      await gui.evaluate(() => {
        document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('.chip').click()
      })
      await gui.waitForFunction(
        () =>
          document.getElementById('dsh-tab-groups-bridge')?.shadowRoot?.querySelector('.panel')?.hidden === false,
        undefined,
        { timeout: TIMEOUT_MS },
      )
      const expandedText = await gui.evaluate(
        () => document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('.panel')?.innerText ?? '',
      )
      check(
        '点一下芯片能展开，面板显示扩展版本与实时计数',
        /扩展 v\d/.test(expandedText) && /命中的 DSH 标签页/.test(expandedText),
        expandedText.slice(0, 120),
      )

      // 「隐藏」 must remove the chip entirely, and must NOT be sticky.
      await gui.evaluate(() => {
        const shadow = document.getElementById('dsh-tab-groups-bridge').shadowRoot
        shadow.querySelector('button[data-act="hide"]').click()
      })
      check(
        '面板里的「隐藏」能把芯片整个收掉',
        (await gui.evaluate(
          () =>
            document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('.wrap').classList.contains('hidden'),
        )) === true,
      )
      await gui.reload({ waitUntil: 'domcontentloaded' })
      await gui.waitForFunction(
        () => ['ready', 'mounted', 'load-failed', 'no-loader', 'spec-missing'].includes(globalThis.__dshTabGroupsTest?.status),
        undefined,
        { timeout: TIMEOUT_MS },
      )
      await gui.evaluate(() =>
        globalThis.__dshTabGroupsTest.mount({
          effect: (fn) => {
            fn()
            return () => {}
          },
        }),
      )
      await gui.waitForFunction(() => document.getElementById('dsh-tab-groups-bridge') !== null, undefined, {
        timeout: TIMEOUT_MS,
      })
      check(
        '刷新后芯片自己回来（「隐藏」只在本次页面加载内有效，不会把人锁在外面）',
        (await gui.evaluate(
          () =>
            document.getElementById('dsh-tab-groups-bridge').shadowRoot.querySelector('.wrap').classList.contains('hidden'),
        )) === false,
      )

      // Pull the real GUI tab out of its group, then let the *chip* put it back:
      // this is the whole point of the pairing, so it is asserted against the
      // browser's own group state.
      const guiUrlPrefix = REAL_URL.split('?')[0]
      await worker.evaluate(async (prefix) => {
        const tabs = await chrome.tabs.query({})
        const target = tabs.find((tab) => (tab.url || '').startsWith(prefix))
        if (target) await chrome.tabs.ungroup(target.id)
      }, guiUrlPrefix)
      await waitFor('真实 GUI 标签页已被移出分组（测试前置）', async () => {
        const state = await readBrowser()
        const target = state.tabs.find((tab) => (tab.url ?? '').startsWith(guiUrlPrefix))
        return target !== undefined && target.groupId === -1
      })

      await gui.evaluate(() => {
        const host = document.getElementById('dsh-tab-groups-bridge')
        const button = [...host.shadowRoot.querySelectorAll('button[data-act="reconcile"]')][0]
        button?.click()
      })
      await waitFor('芯片的「立即归组」把真实标签页收回了分组', async () => {
        const state = await readBrowser()
        const target = state.tabs.find((tab) => (tab.url ?? '').startsWith(guiUrlPrefix))
        return target !== undefined && target.groupId !== -1 ? target : null
      })
      // The chip reports only after its own refresh round-trip completes, so the
      // note is polled rather than sampled once.
      await gui.waitForFunction(
        () =>
          /已归组|失败/.test(
            document.getElementById('dsh-tab-groups-bridge')?.shadowRoot?.querySelector('[data-role="note"]')
              ?.textContent ?? '',
          ),
        undefined,
        { timeout: TIMEOUT_MS },
      )
      const afterChipClick = (await readBrowser()).tabs.find((tab) => (tab.url ?? '').startsWith(guiUrlPrefix))
      check(
        '在真实 GUI 里点插件的「立即归组」，浏览器标签组真的恢复了',
        afterChipClick !== undefined && afterChipClick.groupId !== -1,
        JSON.stringify(afterChipClick),
      )
      const regroupedByChip = await gui.evaluate(
        () =>
          document.getElementById('dsh-tab-groups-bridge')?.shadowRoot?.querySelector('[data-role="note"]')
            ?.textContent ?? '',
      )
      check('芯片回报了本次归组结果', /已归组/.test(regroupedByChip), regroupedByChip)
      await gui.close()
    } else {
      console.log('\n（跳过真实 DSH GUI 通道：未设置 DSH_E2E_URL）')
    }

    /* --------------------------------------------------------- summary */

    const failed = checks.filter((item) => !item.ok)
    console.log(`\n${checks.length - failed.length}/${checks.length} 项断言通过`)
    if (failed.length > 0) {
      console.log('\n失败项：')
      for (const item of failed) console.log(`  ✖ ${item.name}${item.detail ? `\n    ${item.detail}` : ''}`)
      process.exitCode = 1
    }
  } finally {
    if (context) await context.close().catch(() => {})
    server.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`\nE2E 失败：${error?.stack ?? error}`)
  process.exitCode = 1
})
