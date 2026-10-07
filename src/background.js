/**
 * DSH 标签页自动分组 — service worker.
 *
 * Every entry point funnels into `schedule()`, which debounces bursts and
 * serializes reconciliations so two events can never interleave their
 * `chrome.tabs.group` calls. Reconciliation is idempotent: grouping a tab
 * fires more tab events, which produce an empty plan and therefore no call.
 */

import { DEFAULT_CONFIG, normalizeConfig, toStringList } from './config.js'
import { errorPayload, pingPayload, sanitizeConfigPatch, statusPayload } from './protocol.js'
import { planAssignments, planWindowConsolidation, summarize } from './rules.js'

const LOG_PREFIX = '[dsh-tab-groups]'
const CONFIG_KEY = 'config'
const SESSION_KEY = 'groupByWindow'
const HOME_WINDOW_KEY = 'homeWindow'

/** @type {ReturnType<typeof normalizeConfig>} */
let config = normalizeConfig(DEFAULT_CONFIG)
/** windowId -> id of the tab group this extension owns in that window. */
let groupByWindow = {}
/** The window the dedicated-window mode consolidates DSH tabs into. */
let homeWindow = null
let sessionApiAvailable = true
let timer = null
let chain = Promise.resolve()
/** @type {null | {at: number, reason: string, matched: number, moved: number, groups: number, windowsMoved: number, errors: string[]}} */
let lastRun = null

function log(...args) {
  console.debug(LOG_PREFIX, ...args)
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args)
}

/* ---------------------------------------------------------------- storage */

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get(CONFIG_KEY)
    config = normalizeConfig(stored?.[CONFIG_KEY])
  } catch (error) {
    warn('读取配置失败，使用默认配置', error)
    config = normalizeConfig(DEFAULT_CONFIG)
  }
  return config
}

async function saveConfig(patch) {
  config = normalizeConfig({ ...config, ...patch })
  await chrome.storage.local.set({ [CONFIG_KEY]: config })
  return config
}

async function loadSession() {
  if (!sessionApiAvailable) return
  try {
    const stored = await chrome.storage.session.get([SESSION_KEY, HOME_WINDOW_KEY])
    const value = stored?.[SESSION_KEY]
    groupByWindow = value && typeof value === 'object' ? { ...value } : {}
    const home = stored?.[HOME_WINDOW_KEY]
    homeWindow = typeof home === 'number' ? home : null
  } catch {
    // chrome.storage.session is unavailable (older Chromium): fall back to
    // memory. The title-based lookup still recovers the owned group.
    sessionApiAvailable = false
    groupByWindow = {}
    homeWindow = null
  }
}

async function saveSession() {
  if (!sessionApiAvailable) return
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: groupByWindow, [HOME_WINDOW_KEY]: homeWindow })
  } catch (error) {
    sessionApiAvailable = false
    warn('保存会话状态失败，退化为内存状态', error)
  }
}

/* ----------------------------------------------------------- reconciliation */

/**
 * Apply the dedicated-window plan: move every movable DSH tab into the one
 * window that holds nothing but DSH tabs, creating it when none exists.
 *
 * A window is never created with `windows.create()` alone — that leaves a stray
 * about:blank tab behind (verified) — it is seeded with one of the DSH tabs.
 * Pinned tabs stay put: a cross-window move would silently unpin them.
 *
 * @param {Array<object>} tabs the current tab snapshot
 * @returns {Promise<{applied: boolean, moved: number}>}
 */
async function consolidateWindows(tabs) {
  if (config.enabled === false || config.dedicatedWindow !== true) return { applied: false, moved: 0 }

  const windows = await chrome.windows.getAll()
  const plan = planWindowConsolidation({ tabs, windows, config, storedHomeWindow: homeWindow })
  if (plan.clearHome) homeWindow = null
  if (!plan.needed) return { applied: false, moved: 0 }

  let target = plan.targetWindowId ?? homeWindow
  let moved = 0
  if (plan.create) {
    const created = await chrome.windows.create({
      tabId: plan.seedTabId ?? undefined,
      focused: config.focusDedicatedWindow === true,
    })
    target = created?.id ?? null
    moved += 1
  }
  if (target == null) return { applied: moved > 0, moved }
  if (plan.moveTabIds.length > 0) {
    await chrome.tabs.move(plan.moveTabIds, { windowId: target, index: -1 })
    moved += plan.moveTabIds.length
  }
  homeWindow = target
  return { applied: moved > 0, moved }
}

/**
 * Execute one plan. Failures are per action, so one ungroupable window never
 * stops the others.
 */
async function reconcile(reason) {
  let tabs = await chrome.tabs.query({})
  const errors = []
  let moved = 0
  let windowsMoved = 0

  /* ---- pass 1: dedicated window -------------------------------------- *
   * Runs before grouping because a cross-window move drops the tab's group
   * membership — grouping first would only mean grouping twice. */
  try {
    const windowPlan = await consolidateWindows(tabs)
    if (windowPlan.applied) {
      windowsMoved = windowPlan.moved
      // Window ids and group ids both changed, so re-read before grouping.
      tabs = await chrome.tabs.query({})
    }
  } catch (error) {
    errors.push(String(error?.message ?? error))
  }

  /* ---- pass 2: grouping ---------------------------------------------- */
  const groups = await chrome.tabGroups.query({})
  const plan = planAssignments({ tabs, groups, config, storedByWindow: groupByWindow })
  const tabById = new Map(tabs.filter((tab) => tab.id != null).map((tab) => [tab.id, tab]))
  const touchedGroups = new Set()

  /** Group one batch, retrying without pinned tabs when Chromium refuses them. */
  const groupBatch = async (tabIds, groupId, windowId) => {
    if (tabIds.length === 0) return groupId
    if (groupId == null) {
      return chrome.tabs.group({ tabIds, createProperties: { windowId } })
    }
    await chrome.tabs.group({ tabIds, groupId })
    return groupId
  }

  for (const action of plan.actions) {
    let groupId = action.groupId
    try {
      groupId = await groupBatch(action.tabIds, groupId, action.windowId)
      moved += action.tabIds.length
    } catch (error) {
      // Chromium refuses to group pinned tabs: retry the batch without them so
      // one pinned tab cannot block its neighbours.
      const retryIds = action.tabIds.filter((tabId) => tabById.get(tabId)?.pinned !== true)
      if (retryIds.length === 0) {
        // Every tab in the batch is pinned — a known Chromium limitation, not a
        // failure worth reporting on every event.
        continue
      }
      if (retryIds.length === action.tabIds.length) {
        errors.push(String(error?.message ?? error))
        continue
      }
      try {
        groupId = await groupBatch(retryIds, groupId, action.windowId)
        moved += retryIds.length
      } catch (retryError) {
        errors.push(String(retryError?.message ?? retryError))
        continue
      }
    }

    if (groupId == null) continue
    try {
      if (Object.keys(action.appearance).length > 0) {
        await chrome.tabGroups.update(groupId, action.appearance)
      }
      groupByWindow[action.windowId] = groupId
      touchedGroups.add(groupId)
    } catch (error) {
      errors.push(String(error?.message ?? error))
    }
  }

  for (const groupId of plan.forgetGroupIds) forgetGroup(groupId)
  await saveSession()

  lastRun = {
    at: Date.now(),
    reason,
    matched: summarize(tabs, groups, config, groupByWindow).matched,
    moved,
    groups: touchedGroups.size,
    windowsMoved,
    errors,
  }
  if (errors.length > 0) warn('归组过程中出现错误', errors)
  log('reconcile', reason, {
    matched: lastRun.matched,
    moved,
    groups: touchedGroups.size,
    windowsMoved,
    errors: errors.length,
  })
  return lastRun
}

function forgetGroup(groupId) {
  for (const [windowId, value] of Object.entries(groupByWindow)) {
    if (value === groupId) delete groupByWindow[windowId]
  }
}

/** Debounce a burst of tab events into one reconciliation. */
function schedule(reason, delay = 120) {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    chain = chain.then(
      () => reconcile(reason),
      () => reconcile(reason),
    )
    chain.catch((error) => warn('reconcile 失败', reason, error))
  }, delay)
}

/** Run a reconciliation now and hand back its result. */
function reconcileNow(reason) {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  chain = chain.then(
    () => reconcile(reason),
    () => reconcile(reason),
  )
  return chain
}

/* --------------------------------------------------------------- wiring */

async function boot(reason) {
  await loadConfig()
  await loadSession()
  await reconcileNow(reason).catch((error) => warn('启动归组失败', error))
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    // Materialize defaults so the options page opens on real values.
    const stored = await chrome.storage.local.get(CONFIG_KEY)
    if (stored?.[CONFIG_KEY] === undefined) {
      await chrome.storage.local.set({ [CONFIG_KEY]: normalizeConfig(DEFAULT_CONFIG) })
    }
    await boot(`installed:${details?.reason ?? 'unknown'}`)
  })()
})

chrome.runtime.onStartup.addListener(() => {
  void boot('startup')
})

chrome.tabs.onCreated.addListener(() => schedule('tab-created'))
chrome.tabs.onRemoved.addListener(() => schedule('tab-removed'))
chrome.tabs.onAttached.addListener(() => schedule('tab-attached'))
chrome.tabs.onDetached.addListener(() => schedule('tab-detached'))
chrome.tabs.onReplaced.addListener(() => schedule('tab-replaced'))
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (
    changeInfo.title !== undefined ||
    changeInfo.url !== undefined ||
    changeInfo.groupId !== undefined ||
    changeInfo.status === 'complete'
  ) {
    schedule('tab-updated')
  }
})

chrome.tabGroups.onRemoved.addListener((group) => {
  if (group && group.id != null) {
    forgetGroup(group.id)
    void saveSession()
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[CONFIG_KEY]) return
  config = normalizeConfig(changes[CONFIG_KEY].newValue)
  schedule('config-changed', 0)
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type

  if (type === 'reconcile') {
    reconcileNow('manual')
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }))
    return true
  }

  if (type === 'status') {
    void (async () => {
      try {
        const [tabs, groups] = await Promise.all([
          chrome.tabs.query({}),
          chrome.tabGroups.query({}),
        ])
        sendResponse({
          ok: true,
          config,
          summary: summarize(tabs, groups, config, groupByWindow),
          lastRun,
        })
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message ?? error) })
      }
    })()
    return true
  }

  if (type === 'save-config') {
    void (async () => {
      try {
        const patch = { ...(message.config ?? {}) }
        if (patch.matchTitles !== undefined) patch.matchTitles = toStringList(patch.matchTitles)
        if (patch.matchOrigins !== undefined) patch.matchOrigins = toStringList(patch.matchOrigins)
        const saved = await saveConfig(patch)
        await reconcileNow('config-saved')
        sendResponse({ ok: true, config: saved })
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message ?? error) })
      }
    })()
    return true
  }

  if (type === 'reset-config') {
    void (async () => {
      try {
        const saved = await saveConfig(normalizeConfig(DEFAULT_CONFIG))
        await reconcileNow('config-reset')
        sendResponse({ ok: true, config: saved })
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message ?? error) })
      }
    })()
    return true
  }

  return false
})

/* --------------------------------------------------- DSH page bridge */

/** Live status, from the same snapshot the plan is built on. */
async function collectStatus() {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})])
  return { tabs, groups, summary: summarize(tabs, groups, config, groupByWindow) }
}

/**
 * Messages from a DSH GUI page (or any other externally connected page).
 *
 * A page cannot reach this listener at all unless it matches this extension's
 * `externally_connectable`; Chromium only injects `chrome.runtime` into such
 * pages. That is also how the DSH half detects the extension: no bridge, no
 * call, and the page sees `chrome.runtime` as undefined.
 *
 * The caller is outside the trust boundary (any local web page on the same
 * loopback host matches), so config writes are validated key-by-key in
 * `sanitizeConfigPatch` and nothing here exposes tab *contents* — only counts.
 */
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const type = typeof message?.type === 'string' ? message.type : ''
  const manifest = chrome.runtime.getManifest()
  log('external message', type, sender?.origin ?? '(unknown origin)')

  if (type === 'ping') {
    sendResponse(pingPayload({ id: chrome.runtime.id, version: manifest.version }))
    return false
  }

  if (type === 'status') {
    void (async () => {
      try {
        const { summary } = await collectStatus()
        sendResponse(
          statusPayload({
            id: chrome.runtime.id,
            version: manifest.version,
            config,
            summary,
            lastRun,
          }),
        )
      } catch (error) {
        sendResponse(errorPayload(error))
      }
    })()
    return true
  }

  if (type === 'reconcile') {
    void (async () => {
      try {
        const result = await reconcileNow('dsh-page')
        sendResponse({
          ok: true,
          moved: result.moved,
          groups: result.groups,
          matched: result.matched,
          errors: [...result.errors],
        })
      } catch (error) {
        sendResponse(errorPayload(error))
      }
    })()
    return true
  }

  if (type === 'set-config') {
    void (async () => {
      try {
        const checked = sanitizeConfigPatch(message.config)
        if (!checked.ok) {
          sendResponse({ ok: false, error: checked.error })
          return
        }
        const saved = await saveConfig(checked.patch)
        await reconcileNow('dsh-page')
        sendResponse({ ok: true, config: saved })
      } catch (error) {
        sendResponse(errorPayload(error))
      }
    })()
    return true
  }

  sendResponse({ ok: false, error: `unsupported message type: ${type || '(none)'}` })
  return false
})

void boot('worker-boot')
