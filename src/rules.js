/**
 * Pure "which tabs are DSH tabs, and what should be grouped" logic.
 *
 * No `chrome.*` reference lives in this file on purpose: `background.js`
 * executes the plan, while `node --test` verifies the decisions without a
 * browser. `TAB_ID_NONE` mirrors `chrome.tabs.TAB_ID_NONE`.
 */

export const TAB_ID_NONE = -1

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Collapse whitespace so a stray newline in a page title cannot break a match. */
export function normalizeTitle(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A configured title identifies a tab when it matches exactly, or — with
 * `matchTitlePrefix` — when what follows is a separator rather than another
 * word. "DeepSeek Harness · 会话" and "DeepSeek Harness — 登录" match, while a
 * hypothetical other site titled "DeepSeek Harness Docs" does not: a bare
 * space is not enough, the continuation has to start with a non-word character.
 */
export function matchesTitle(title, config) {
  const normalized = normalizeTitle(title)
  if (normalized === '') return false
  const patterns = config.matchTitles ?? []
  for (const raw of patterns) {
    const pattern = normalizeTitle(raw)
    if (pattern === '') continue
    if (normalized === pattern) return true
    if (!config.matchTitlePrefix) continue
    if (!normalized.startsWith(pattern)) continue
    const rest = normalized.slice(pattern.length).trim()
    if (rest === '') return true
    if (!/[A-Za-z0-9_]/.test(rest[0])) return true
  }
  return false
}

/**
 * A configured origin identifies a tab. Entries may pin an exact origin
 * (`http://127.0.0.1:3080`) or wildcard the port (`http://127.0.0.1:*`), and
 * `matchAnyLocalhostPort` accepts any loopback origin.
 */
export function matchesOrigin(url, config) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const entries = config.matchOrigins ?? []
  for (const raw of entries) {
    const entry = String(raw ?? '')
      .trim()
      .replace(/\/+$/, '')
    if (entry === '') continue
    if (entry === parsed.origin) return true
    if (!entry.endsWith(':*')) continue
    const base = entry.slice(0, -2)
    try {
      const parsedBase = new URL(base)
      if (
        parsedBase.protocol === parsed.protocol &&
        parsedBase.hostname.toLowerCase() === parsed.hostname.toLowerCase()
      ) {
        return true
      }
    } catch {
      // A malformed wildcard entry is simply not a rule.
    }
  }

  if (config.matchAnyLocalhostPort && LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) return true
  return false
}

/** Is this tab a DSH Web GUI tab? */
export function isDshTab(tab, config) {
  if (!tab || !config || config.enabled === false) return false
  const url = tab.pendingUrl || tab.url || ''
  if (!/^https?:/i.test(url)) return false
  if (matchesTitle(tab.title, config)) return true
  return matchesOrigin(url, config)
}

/**
 * Fields to push onto the owned group. Only differences are returned, so a
 * steady state produces an empty object and no API call.
 */
export function desiredAppearance(group, config) {
  const wanted = {}
  const title = normalizeTitle(config.groupTitle)
  if (!group) {
    wanted.title = title
    wanted.color = config.groupColor
    wanted.collapsed = !!config.collapseGroup
    return wanted
  }
  if (config.enforceAppearance) {
    if (normalizeTitle(group.title) !== title) wanted.title = title
    if (group.color !== config.groupColor) wanted.color = config.groupColor
  } else if (normalizeTitle(group.title) === '') {
    // An untitled group is one nobody has claimed yet — naming it is not a fight.
    wanted.title = title
    wanted.color = config.groupColor
  }
  // Only ever force *collapsing*; never force a group open again, because the
  // user expanding it is an explicit act we should not undo.
  if (config.collapseGroup && group.collapsed !== true) wanted.collapsed = true
  return wanted
}

/**
 * Decide every grouping action for one snapshot of browser state.
 *
 * Tab groups live inside a single window, so the plan is built per window.
 * The group this extension owns is identified by a remembered group id (kept
 * in session storage) and, failing that, by the configured title.
 *
 * @param {object} input
 * @param {Array<object>} input.tabs browser tabs (chrome.tabs.Tab shaped)
 * @param {Array<object>} input.groups existing tab groups (chrome.tabGroups.TabGroup shaped)
 * @param {object} input.config normalized config
 * @param {Record<string|number, number>} [input.storedByWindow] windowId -> owned groupId
 * @returns {{actions: Array<object>, forgetGroupIds: number[]}}
 */
export function planAssignments({ tabs, groups, config, storedByWindow = {} }) {
  const actions = []
  const forgetGroupIds = []

  const groupList = (groups ?? []).filter((group) => group && group.id != null)
  const groupById = new Map(groupList.map((group) => [group.id, group]))

  // Forget remembered groups that no longer exist or moved to another window.
  for (const [windowId, groupId] of Object.entries(storedByWindow ?? {})) {
    const group = groupById.get(groupId)
    if (!group || String(group.windowId) !== String(windowId)) forgetGroupIds.push(groupId)
  }

  if (!config || config.enabled === false) return { actions, forgetGroupIds }

  const candidates = (tabs ?? []).filter(
    (tab) =>
      tab &&
      tab.id != null &&
      isDshTab(tab, config) &&
      !(config.skipPinned && tab.pinned === true),
  )

  const byWindow = new Map()
  for (const tab of candidates) {
    const list = byWindow.get(tab.windowId)
    if (list) list.push(tab)
    else byWindow.set(tab.windowId, [tab])
  }

  for (const [windowId, windowTabs] of byWindow) {
    const storedId = storedByWindow?.[windowId]
    const storedGroup = storedId != null ? groupById.get(storedId) : undefined

    let target = null
    if (storedGroup && String(storedGroup.windowId) === String(windowId)) {
      target = storedGroup
    } else {
      const wantedTitle = normalizeTitle(config.groupTitle)
      target =
        groupList.find(
          (group) =>
            String(group.windowId) === String(windowId) &&
            normalizeTitle(group.title) === wantedTitle,
        ) ?? null
    }

    const moving = windowTabs.filter((tab) => {
      if (target && tab.groupId === target.id) return false
      const inSomeGroup = tab.groupId != null && tab.groupId !== TAB_ID_NONE
      if (!config.moveFromOtherGroups && inSomeGroup) return false
      return true
    })

    // An action must be able to accomplish something: either it moves tabs, or
    // it fixes the appearance of a group we already own.
    const appearance = desiredAppearance(target, config)
    const canRestyle = target != null && Object.keys(appearance).length > 0
    if (moving.length === 0 && !canRestyle) continue

    actions.push({
      windowId,
      groupId: target ? target.id : null,
      tabIds: moving.map((tab) => tab.id),
      appearance,
    })
  }

  return { actions, forgetGroupIds }
}

/**
 * Decide how to consolidate every DSH tab into one dedicated window.
 *
 * The target is a window that contains **nothing but DSH tabs**. A window that
 * also holds ordinary tabs is never adopted — moving the user's own tabs out of
 * it would be far more invasive than what was asked for — so a new window is
 * created instead and the DSH tabs are moved into it.
 *
 * Pinned DSH tabs are left behind even when `skipPinned` is off: a cross-window
 * `tabs.move` silently *unpins* a pinned tab (verified in a real browser), and
 * quietly dropping someone's pin is worse than not moving the tab.
 *
 * @param {object} input
 * @param {Array<object>} input.tabs browser tabs (chrome.tabs.Tab shaped)
 * @param {Array<{id: number, type?: string}>} [input.windows] windows, to tell a
 *   normal window from a popup window; omitted means "all normal"
 * @param {object} input.config normalized config
 * @param {number|null} [input.storedHomeWindow] the remembered DSH window
 * @returns {{needed: boolean, create: boolean, seedTabId: number|null,
 *   moveTabIds: number[], targetWindowId: number|null, homeWindowId: number|null,
 *   clearHome: boolean}}
 */
export function planWindowConsolidation({ tabs, windows, config, storedHomeWindow = null }) {
  const idle = {
    needed: false,
    create: false,
    seedTabId: null,
    moveTabIds: [],
    targetWindowId: null,
    homeWindowId: null,
    clearHome: false,
  }
  if (!config || config.enabled === false || config.dedicatedWindow !== true) return idle

  const list = (tabs ?? []).filter((tab) => tab && tab.id != null)
  const dsh = list.filter((tab) => isDshTab(tab, config))
  // Nothing DSH left: forget the remembered window (the browser closes an
  // emptied window on its own, so the id would be stale next time).
  if (dsh.length === 0) return { ...idle, clearHome: storedHomeWindow != null }

  // A cross-window move drops the pin, so pinned tabs never participate.
  const movable = dsh.filter((tab) => tab.pinned !== true)
  if (movable.length === 0) return idle

  const normalWindows =
    Array.isArray(windows) && windows.length > 0
      ? new Set(windows.filter((win) => (win.type ?? 'normal') === 'normal').map((win) => win.id))
      : null
  const isNormal = (windowId) => normalWindows === null || normalWindows.has(windowId)

  /** Does this window hold nothing but DSH tabs? */
  const holdsOnlyDsh = (windowId) => {
    const inWindow = list.filter((tab) => tab.windowId === windowId)
    return inWindow.length > 0 && inWindow.every((tab) => isDshTab(tab, config))
  }

  // Prefer the remembered window, then the DSH-only window holding the most DSH
  // tabs (fewest moves), and otherwise build one.
  let home = null
  if (storedHomeWindow != null && isNormal(storedHomeWindow) && holdsOnlyDsh(storedHomeWindow)) {
    home = storedHomeWindow
  } else {
    const exclusive = [...new Set(dsh.map((tab) => tab.windowId))]
      .filter((windowId) => isNormal(windowId) && holdsOnlyDsh(windowId))
      .sort(
        (a, b) =>
          dsh.filter((tab) => tab.windowId === b).length - dsh.filter((tab) => tab.windowId === a).length,
      )
    if (exclusive.length > 0) home = exclusive[0]
  }

  if (home === null) {
    // Seed the new window with the first movable tab, so it is never born with
    // a stray about:blank tab of its own.
    return {
      needed: true,
      create: true,
      seedTabId: movable[0].id,
      moveTabIds: movable.slice(1).map((tab) => tab.id),
      targetWindowId: null,
      homeWindowId: null,
      clearHome: false,
    }
  }

  const moveTabIds = movable.filter((tab) => tab.windowId !== home).map((tab) => tab.id)
  return {
    needed: moveTabIds.length > 0,
    create: false,
    seedTabId: null,
    moveTabIds,
    targetWindowId: home,
    homeWindowId: home,
    clearHome: storedHomeWindow != null && storedHomeWindow !== home,
  }
}

/** How many DSH tabs each window holds — diagnostics and tests. */
export function dshTabsByWindow(tabs, config) {
  const counts = new Map()
  for (const tab of (tabs ?? []).filter((candidate) => candidate && isDshTab(candidate, config))) {
    counts.set(tab.windowId, (counts.get(tab.windowId) ?? 0) + 1)
  }
  return counts
}

/**
 * Counts for the popup: how many DSH tabs exist, and how many of them the
 * current plan still has to move into the owned group.
 */
export function summarize(tabs, groups, config, storedByWindow = {}) {
  const { actions } = planAssignments({ tabs, groups, config, storedByWindow })
  const matched = (tabs ?? []).filter(
    (tab) => tab && isDshTab(tab, config) && !(config.skipPinned && tab.pinned === true),
  )
  const pendingIds = new Set()
  for (const action of actions) for (const tabId of action.tabIds) pendingIds.add(tabId)
  return {
    matched: matched.length,
    pending: pendingIds.size,
    windows: new Set(actions.map((action) => action.windowId)).size,
  }
}
