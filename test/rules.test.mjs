import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  DSH_DEFAULT_TITLE,
  normalizeConfig,
  toStringList,
} from '../src/config.js'
import {
  TAB_ID_NONE,
  desiredAppearance,
  isDshTab,
  matchesOrigin,
  matchesTitle,
  normalizeTitle,
  planAssignments,
  summarize,
} from '../src/rules.js'

const config = () => normalizeConfig(DEFAULT_CONFIG)

function tab(over = {}) {
  return {
    id: 1,
    windowId: 1,
    url: 'http://127.0.0.1:3080/?token=secret',
    title: DSH_DEFAULT_TITLE,
    pinned: false,
    groupId: TAB_ID_NONE,
    ...over,
  }
}

function group(over = {}) {
  return { id: 10, windowId: 1, title: 'DSH', color: 'blue', collapsed: false, ...over }
}

/* ------------------------------------------------------------ config */

test('normalizeConfig falls back field-by-field on garbage input', () => {
  const result = normalizeConfig({
    enabled: 'yes',
    groupTitle: '',
    groupColor: 'chartreuse',
    matchTitles: [],
    matchOrigins: 42,
    collapseGroup: 1,
  })
  assert.equal(result.enabled, DEFAULT_CONFIG.enabled)
  assert.equal(result.groupTitle, DEFAULT_CONFIG.groupTitle)
  assert.equal(result.groupColor, DEFAULT_CONFIG.groupColor)
  assert.deepEqual(result.matchTitles, DEFAULT_CONFIG.matchTitles)
  assert.deepEqual(result.matchOrigins, DEFAULT_CONFIG.matchOrigins)
  assert.equal(result.collapseGroup, false)
})

test('normalizeConfig never produces an empty title list', () => {
  // An empty list would silently disable title matching entirely.
  assert.deepEqual(normalizeConfig({ matchTitles: [] }).matchTitles, [DSH_DEFAULT_TITLE])
})

test('toStringList accepts arrays and delimited strings, strips trailing slashes', () => {
  assert.deepEqual(toStringList(['http://a:1/', ' http://b:2 ']), ['http://a:1', 'http://b:2'])
  assert.deepEqual(toStringList('http://a:1\nhttp://b:2,http://c:3'), [
    'http://a:1',
    'http://b:2',
    'http://c:3',
  ])
  assert.deepEqual(toStringList(['dup', 'dup']), ['dup'])
  assert.deepEqual(toStringList(undefined, ['fallback']), ['fallback'])
})

/* ------------------------------------------------------------ matching */

test('normalizeTitle collapses whitespace and trims', () => {
  assert.equal(normalizeTitle('  DeepSeek\n  Harness  '), 'DeepSeek Harness')
  assert.equal(normalizeTitle(undefined), '')
})

test('matchesTitle: exact, prefix-with-separator, and refuses word continuations', () => {
  const c = config()
  assert.equal(matchesTitle('DeepSeek Harness', c), true)
  assert.equal(matchesTitle('  DeepSeek Harness ', c), true)
  assert.equal(matchesTitle('DeepSeek Harness · 会话标题', c), true)
  assert.equal(matchesTitle('DeepSeek Harness — 登录', c), true)
  // A different site whose title merely starts with the same word must not match.
  assert.equal(matchesTitle('DeepSeek Harness Docs', c), false)
  assert.equal(matchesTitle('DeepSeek', c), false)
  assert.equal(matchesTitle('', c), false)
})

test('matchesTitle honours matchTitlePrefix=false', () => {
  const c = normalizeConfig({ ...DEFAULT_CONFIG, matchTitlePrefix: false })
  assert.equal(matchesTitle('DeepSeek Harness', c), true)
  assert.equal(matchesTitle('DeepSeek Harness · 会话', c), false)
})

test('matchesOrigin: exact, trailing slash, wildcard port, loopback, rejects others', () => {
  const c = config()
  assert.equal(matchesOrigin('http://127.0.0.1:3080/', c), true)
  assert.equal(matchesOrigin('http://127.0.0.1:3080/?token=abc#/session/1', c), true)
  assert.equal(matchesOrigin('http://localhost:3080/', c), true)
  assert.equal(matchesOrigin('http://127.0.0.1:9999/', c), false)
  assert.equal(matchesOrigin('not a url', c), false)
  assert.equal(matchesOrigin('file:///tmp/x.html', c), false)
  assert.equal(matchesOrigin('chrome://extensions', c), false)

  const wildcard = normalizeConfig({ ...DEFAULT_CONFIG, matchOrigins: ['http://127.0.0.1:*'] })
  assert.equal(matchesOrigin('http://127.0.0.1:54321/', wildcard), true)
  assert.equal(matchesOrigin('https://127.0.0.1:54321/', wildcard), false)
  assert.equal(matchesOrigin('http://127.0.0.2:54321/', wildcard), false)

  const anyLocal = normalizeConfig({ ...DEFAULT_CONFIG, matchAnyLocalhostPort: true })
  assert.equal(matchesOrigin('http://localhost:1234/', anyLocal), true)
  assert.equal(matchesOrigin('http://[::1]:1234/', anyLocal), true)
  assert.equal(matchesOrigin('http://example.com/', anyLocal), false)
})

test('isDshTab: title wins anywhere, including a tunnel hostname', () => {
  const c = config()
  assert.equal(isDshTab(tab({ url: 'https://abc.dsh-market.com/' }), c), true)
  assert.equal(isDshTab(tab({ title: 'GitHub', url: 'https://github.com/' }), c), false)
  assert.equal(isDshTab(tab({ title: '' }), c), true) // origin rule still applies
  assert.equal(isDshTab(tab({ title: 'GitHub', url: 'http://127.0.0.1:3080/' }), c), true)
})

test('isDshTab respects the master switch and pendingUrl', () => {
  assert.equal(isDshTab(tab(), normalizeConfig({ ...DEFAULT_CONFIG, enabled: false })), false)
  // While a tab is loading, url is still about:blank — pendingUrl carries truth.
  assert.equal(isDshTab(tab({ url: 'about:blank', pendingUrl: 'http://127.0.0.1:3080/' }), config()), true)
})

/* ------------------------------------------------------- grouping plan */

test('plan creates one group per window for fresh DSH tabs', () => {
  const tabs = [
    tab({ id: 1 }),
    tab({ id: 2, title: '' }),
    tab({ id: 3, title: 'GitHub', url: 'https://github.com/' }),
  ]
  const { actions, forgetGroupIds } = planAssignments({ tabs, groups: [], config: config() })
  assert.deepEqual(forgetGroupIds, [])
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0].tabIds, [1, 2])
  assert.equal(actions[0].groupId, null)
  assert.equal(actions[0].windowId, 1)
  assert.deepEqual(actions[0].appearance, { title: 'DSH', color: 'blue', collapsed: false })
})

test('plan is idempotent once the tabs sit in the owned group', () => {
  const groups = [group()]
  const tabs = [tab({ id: 1, groupId: 10 }), tab({ id: 2, groupId: 10 })]
  const { actions } = planAssignments({
    tabs,
    groups,
    config: config(),
    storedByWindow: { 1: 10 },
  })
  assert.deepEqual(actions, [])
})

test('plan adopts an existing group by title after a browser restart', () => {
  const groups = [group({ id: 77, title: 'DSH' })]
  const already = [tab({ id: 1, groupId: 77 })]
  const idle = planAssignments({ tabs: already, groups, config: config(), storedByWindow: {} })
  assert.deepEqual(idle.actions, [], 'adopted with nothing to move and no restyle needed')

  const tabs = [tab({ id: 1, groupId: TAB_ID_NONE }), tab({ id: 2, groupId: TAB_ID_NONE })]
  const plan = planAssignments({ tabs, groups, config: config(), storedByWindow: {} })
  assert.deepEqual(plan.actions[0].tabIds, [1, 2])
  assert.equal(plan.actions[0].groupId, 77)
})

test('plan forgets remembered groups that vanished', () => {
  const { forgetGroupIds } = planAssignments({
    tabs: [tab()],
    groups: [],
    config: config(),
    storedByWindow: { 1: 10 },
  })
  assert.deepEqual(forgetGroupIds, [10])
})

test('plan forgets a remembered group that moved to another window', () => {
  const { forgetGroupIds } = planAssignments({
    tabs: [tab()],
    groups: [group({ id: 10, windowId: 2 })],
    config: config(),
    storedByWindow: { 1: 10 },
  })
  assert.deepEqual(forgetGroupIds, [10])
})

test('a group in another window is never adopted', () => {
  const groups = [group({ id: 55, windowId: 2, title: 'DSH' })]
  const tabs = [tab({ id: 1, windowId: 1 })]
  const { actions } = planAssignments({ tabs, groups, config: config(), storedByWindow: {} })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].groupId, null, 'must create a new group in window 1')
})

test('plan handles a window where nothing is a DSH tab by doing nothing', () => {
  const tabs = [tab({ id: 1, windowId: 2, title: 'GitHub', url: 'https://github.com/' })]
  const { actions } = planAssignments({ tabs, groups: [], config: config() })
  assert.deepEqual(actions, [])
})

test('plan moves DSH tabs out of a foreign group by default', () => {
  const groups = [group({ id: 42, title: '工作', color: 'red' })]
  const tabs = [tab({ id: 1, groupId: 42 })]
  const { actions } = planAssignments({ tabs, groups, config: config(), storedByWindow: {} })
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0].tabIds, [1])
  assert.equal(actions[0].groupId, null, 'the foreign group is not hijacked')

  const keep = normalizeConfig({ ...DEFAULT_CONFIG, moveFromOtherGroups: false })
  const kept = planAssignments({ tabs, groups, config: keep, storedByWindow: {} })
  assert.deepEqual(kept.actions, [])
})

test('plan skips pinned tabs when asked, and includes them when not', () => {
  const tabs = [tab({ id: 1, pinned: true }), tab({ id: 2 })]
  const skip = planAssignments({ tabs, groups: [], config: config() })
  assert.deepEqual(skip.actions[0].tabIds, [2])

  const include = normalizeConfig({ ...DEFAULT_CONFIG, skipPinned: false })
  const all = planAssignments({ tabs, groups: [], config: include })
  assert.deepEqual(all.actions[0].tabIds, [1, 2])
})

test('plan is per window: two windows yield two independent groups', () => {
  const tabs = [
    tab({ id: 1, windowId: 1 }),
    tab({ id: 2, windowId: 2 }),
    tab({ id: 3, windowId: 2 }),
  ]
  const { actions } = planAssignments({ tabs, groups: [], config: config() })
  assert.equal(actions.length, 2)
  const byWindow = new Map(actions.map((action) => [action.windowId, action]))
  assert.deepEqual(byWindow.get(1).tabIds, [1])
  assert.deepEqual(byWindow.get(2).tabIds, [2, 3])
})

test('plan returns nothing at all while disabled', () => {
  const off = normalizeConfig({ ...DEFAULT_CONFIG, enabled: false })
  const { actions } = planAssignments({
    tabs: [tab({ id: 1, groupId: 42 })],
    groups: [group({ id: 42, title: '工作' })],
    config: off,
  })
  assert.deepEqual(actions, [])
})

test('plan can rename an adopted group back to the configured title', () => {
  const groups = [group({ id: 10, title: '我改过的名字' })]
  const tabs = [tab({ id: 1, groupId: 10 })]
  const { actions } = planAssignments({
    tabs,
    groups,
    config: config(),
    storedByWindow: { 1: 10 },
  })
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0].tabIds, [])
  assert.deepEqual(actions[0].appearance, { title: 'DSH' })
})

test('plan leaves a hand-renamed group alone when enforceAppearance is off', () => {
  const groups = [group({ id: 10, title: '我改过的名字' })]
  const tabs = [tab({ id: 1, groupId: 10 })]
  const c = normalizeConfig({ ...DEFAULT_CONFIG, enforceAppearance: false })
  const { actions } = planAssignments({ tabs, groups, config: c, storedByWindow: { 1: 10 } })
  assert.deepEqual(actions, [])
})

test('plan names an untitled group even with enforceAppearance off', () => {
  const groups = [group({ id: 10, title: '' })]
  const tabs = [tab({ id: 1, groupId: 10 })]
  const c = normalizeConfig({ ...DEFAULT_CONFIG, enforceAppearance: false })
  const { actions } = planAssignments({ tabs, groups, config: c, storedByWindow: { 1: 10 } })
  assert.deepEqual(actions[0].appearance, { title: 'DSH', color: 'blue' })
})

/* -------------------------------------------------------- appearance */

test('desiredAppearance only ever collapses, never expands', () => {
  const collapsed = normalizeConfig({ ...DEFAULT_CONFIG, collapseGroup: true })
  assert.deepEqual(desiredAppearance(group({ collapsed: true }), collapsed), {})
  assert.deepEqual(desiredAppearance(group({ collapsed: false }), collapsed), { collapsed: true })

  // With collapseGroup off, a user-collapsed group stays collapsed.
  assert.deepEqual(desiredAppearance(group({ collapsed: true }), config()), {})
})

test('desiredAppearance describes a brand new group fully', () => {
  assert.deepEqual(desiredAppearance(null, config()), {
    title: 'DSH',
    color: 'blue',
    collapsed: false,
  })
})

/* ------------------------------------------------------------ summary */

test('summarize reports matches, pending moves and window count', () => {
  const tabs = [
    tab({ id: 1 }),
    tab({ id: 2, groupId: 10 }),
    tab({ id: 3, windowId: 2 }),
    tab({ id: 4, title: 'GitHub', url: 'https://github.com/' }),
  ]
  const groups = [group({ id: 10 })]
  const result = summarize(tabs, groups, config(), { 1: 10 })
  assert.equal(result.matched, 3)
  assert.equal(result.pending, 2)
  assert.equal(result.windows, 2)
})

test('summarize ignores pinned tabs exactly like the plan does', () => {
  const tabs = [tab({ id: 1, pinned: true }), tab({ id: 2 })]
  assert.equal(summarize(tabs, [], config(), {}).matched, 1)
  assert.equal(
    summarize(tabs, [], normalizeConfig({ ...DEFAULT_CONFIG, skipPinned: false }), {}).matched,
    2,
  )
})
