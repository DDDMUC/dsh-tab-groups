import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js'
import { errorPayload, pingPayload, sanitizeConfigPatch, statusPayload } from '../src/protocol.js'
import { PROTOCOL_VERSION } from '../src/extension-id.js'

/* --------------------------------------------------------------- ping */

test('pingPayload identifies the extension and the protocol', () => {
  const payload = pingPayload({ id: 'abc', version: '0.2.0' })
  assert.deepEqual(payload, {
    ok: true,
    installed: true,
    protocol: PROTOCOL_VERSION,
    id: 'abc',
    version: '0.2.0',
  })
})

/* ------------------------------------------------------- config writes */

test('sanitizeConfigPatch accepts the keys the DSH chip offers', () => {
  const result = sanitizeConfigPatch({ enabled: false, groupTitle: '工作', groupColor: 'purple' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.patch, { enabled: false, groupTitle: '工作', groupColor: 'purple' })
  assert.equal(result.config.groupTitle, '工作')
  assert.equal(result.config.groupColor, 'purple')
  assert.equal(result.config.enabled, false)
})

test('sanitizeConfigPatch refuses unknown keys instead of dropping them quietly', () => {
  const result = sanitizeConfigPatch({ enabled: true, somethingElse: 1 })
  assert.equal(result.ok, false)
  assert.match(result.error, /unknown config key/)
})

test('sanitizeConfigPatch refuses an empty patch and non-objects', () => {
  for (const bad of [{}, null, undefined, 42, 'nope', ['enabled'], []]) {
    const result = sanitizeConfigPatch(bad)
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(bad)}`)
  }
})

test('sanitizeConfigPatch rejects wrong value types rather than silently normalizing', () => {
  // normalizeConfig is forgiving by design (it is the last line of defence for
  // a hand-edited store). An external page must hear about its mistake instead.
  assert.equal(sanitizeConfigPatch({ enabled: 'yes' }).ok, false)
  assert.equal(sanitizeConfigPatch({ groupColor: 'chartreuse' }).ok, false)
  assert.equal(sanitizeConfigPatch({ groupTitle: 7 }).ok, false)
  assert.equal(sanitizeConfigPatch({ collapseGroup: 1 }).ok, false)
  assert.equal(sanitizeConfigPatch({ matchTitles: [1, 2] }).ok, false)
  assert.equal(sanitizeConfigPatch({ matchOrigins: 42 }).ok, false)
  assert.match(sanitizeConfigPatch({ groupColor: 'chartreuse' }).error, /groupColor/)
})

test('sanitizeConfigPatch normalizes list fields from textarea-style strings', () => {
  const result = sanitizeConfigPatch({ matchOrigins: 'http://127.0.0.1:3080\nhttp://localhost:3080/' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.patch.matchOrigins, ['http://127.0.0.1:3080', 'http://localhost:3080'])
})

test('sanitizeConfigPatch refuses to empty the title list', () => {
  // An empty list would silently disable title matching and break grouping on
  // every origin that is not in matchOrigins.
  const result = sanitizeConfigPatch({ matchTitles: [] })
  assert.equal(result.ok, false)
  assert.match(result.error, /matchTitles/)
})

/* -------------------------------------------------------------- status */

test('statusPayload exposes counts and settings but no tab contents', () => {
  const payload = statusPayload({
    id: 'abc',
    version: '0.2.0',
    config: normalizeConfig(DEFAULT_CONFIG),
    summary: { matched: 3, pending: 1, windows: 2 },
    lastRun: { at: 1234, reason: 'manual', moved: 2, windowsMoved: 5, errors: ['boom'] },
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.protocol, PROTOCOL_VERSION)
  assert.equal(payload.groupTitle, 'DSH')
  assert.equal(payload.enabled, true)
  assert.equal(payload.matched, 3)
  assert.equal(payload.pending, 1)
  assert.equal(payload.windows, 2)
  assert.deepEqual(payload.lastRun, {
    at: 1234,
    reason: 'manual',
    moved: 2,
    windowsMoved: 5,
    errors: ['boom'],
  })
  // The protocol deliberately carries no urls, titles or tab ids: a page on the
  // loopback host learns how many DSH tabs exist, never what they are.
  const serialized = JSON.stringify(payload)
  assert.doesNotMatch(serialized, /"urls?"|"titles?"|"tabs?"|"tabIds?"/)
})

test('statusPayload exposes both window modes', () => {
  const off = statusPayload({
    id: 'a',
    version: '1',
    config: normalizeConfig(DEFAULT_CONFIG),
    summary: { matched: 1, pending: 1, windows: 1 },
    lastRun: null,
  })
  assert.equal(off.dedicatedWindow, false)
  assert.equal(off.focusDedicatedWindow, false)

  const on = statusPayload({
    id: 'a',
    version: '1',
    config: normalizeConfig({ ...DEFAULT_CONFIG, dedicatedWindow: true, focusDedicatedWindow: true }),
    summary: { matched: 1, pending: 1, windows: 1 },
    lastRun: null,
  })
  assert.equal(on.dedicatedWindow, true)
  assert.equal(on.focusDedicatedWindow, true)
})

test('a page may switch the dedicated window on, and nothing else', () => {
  const accepted = sanitizeConfigPatch({ dedicatedWindow: true, focusDedicatedWindow: true })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.config.dedicatedWindow, true)
  assert.equal(sanitizeConfigPatch({ dedicatedWindow: 'yes' }).ok, false)
})

test('statusPayload renders a missing lastRun as null', () => {
  const payload = statusPayload({
    id: 'abc',
    version: '1',
    config: normalizeConfig(DEFAULT_CONFIG),
    summary: { matched: 0, pending: 0, windows: 0 },
    lastRun: null,
  })
  assert.equal(payload.lastRun, null)
})

test('errorPayload stringifies anything', () => {
  assert.deepEqual(errorPayload(new Error('nope')), { ok: false, error: 'nope' })
  assert.deepEqual(errorPayload('plain'), { ok: false, error: 'plain' })
  assert.deepEqual(errorPayload(undefined), { ok: false, error: 'unknown error' })
})
