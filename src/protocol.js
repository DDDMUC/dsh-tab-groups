/**
 * The message protocol between a DSH GUI page (or any externally connected
 * page) and this extension's service worker.
 *
 * Pure module: no `chrome.*` reference, so `node --test` can verify every
 * decision without a browser. `background.js` only wires it up.
 */

import { DEFAULT_CONFIG, GROUP_COLORS, normalizeConfig, toStringList } from './config.js'
import { PROTOCOL_VERSION } from './extension-id.js'

/** Keys an external page is allowed to write. Anything else is rejected. */
const WRITABLE_KEYS = new Set([
  'enabled',
  'groupTitle',
  'groupColor',
  'collapseGroup',
  'enforceAppearance',
  'matchTitles',
  'matchOrigins',
  'matchAnyLocalhostPort',
  'moveFromOtherGroups',
  'skipPinned',
])

/** Message types the extension answers. */
export const EXTERNAL_TYPES = ['ping', 'status', 'reconcile', 'set-config']

/**
 * The "is the extension installed?" answer.
 *
 * A page learns the extension exists by getting this back at all: Chromium only
 * exposes `chrome.runtime.sendMessage` to a page when some installed extension
 * lists that page's origin in `externally_connectable`. No bridge, no call.
 */
export function pingPayload({ id, version }) {
  return {
    ok: true,
    installed: true,
    protocol: PROTOCOL_VERSION,
    id,
    version,
  }
}

/**
 * Validate and normalize a config patch coming from a page.
 *
 * The page is outside the extension's trust boundary — it may be any local web
 * app on the same loopback host — so unknown keys are refused outright rather
 * than merged, and every accepted value goes through the same normalizer the
 * options page uses. A malformed payload can therefore degrade to defaults, but
 * never write something the UI could not have written.
 *
 * @returns {{ok: true, patch: object, config: object} | {ok: false, error: string}}
 */
export function sanitizeConfigPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'config must be a plain object' }
  }
  const picked = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!WRITABLE_KEYS.has(key)) return { ok: false, error: `unknown config key: ${key}` }
    picked[key] = value
  }
  if (Object.keys(picked).length === 0) return { ok: false, error: 'config patch is empty' }

  // Reject values of the wrong *type* before normalizing: normalizeConfig is
  // deliberately forgiving (it falls back to defaults), and silently rewriting
  // a typo'd value would hide the mistake from whoever wrote the page.
  if (picked.enabled !== undefined && typeof picked.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean' }
  }
  if (picked.groupColor !== undefined && !GROUP_COLORS.includes(picked.groupColor)) {
    return { ok: false, error: `groupColor must be one of: ${GROUP_COLORS.join(', ')}` }
  }
  if (picked.groupTitle !== undefined && typeof picked.groupTitle !== 'string') {
    return { ok: false, error: 'groupTitle must be a string' }
  }
  for (const key of ['collapseGroup', 'enforceAppearance', 'matchTitlePrefix', 'matchAnyLocalhostPort', 'moveFromOtherGroups', 'skipPinned']) {
    if (picked[key] !== undefined && typeof picked[key] !== 'boolean') {
      return { ok: false, error: `${key} must be a boolean` }
    }
  }
  for (const key of ['matchTitles', 'matchOrigins']) {
    const value = picked[key]
    if (value === undefined) continue
    if (typeof value !== 'string' && !Array.isArray(value)) {
      return { ok: false, error: `${key} must be a string or an array of strings` }
    }
    if (Array.isArray(value) && value.some((item) => typeof item !== 'string')) {
      return { ok: false, error: `${key} may only contain strings` }
    }
    picked[key] = toStringList(value)
  }
  if (picked.matchTitles !== undefined && picked.matchTitles.length === 0) {
    return { ok: false, error: 'matchTitles may not be empty' }
  }

  return { ok: true, patch: picked, config: normalizeConfig({ ...DEFAULT_CONFIG, ...picked }) }
}

/**
 * Shape of the payload a page receives from `status`.
 * @param {object} input
 */
export function statusPayload({ id, version, config, summary, lastRun }) {
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    id,
    version,
    enabled: config.enabled !== false,
    groupTitle: config.groupTitle,
    groupColor: config.groupColor,
    collapseGroup: config.collapseGroup === true,
    matchTitles: [...config.matchTitles],
    matchOrigins: [...config.matchOrigins],
    /** DSH tabs found, how many still need moving, and how many windows are involved. */
    matched: summary.matched,
    pending: summary.pending,
    windows: summary.windows,
    lastRun: lastRun
      ? { at: lastRun.at, reason: lastRun.reason, moved: lastRun.moved, errors: [...lastRun.errors] }
      : null,
  }
}

/** The reason text a page can show when a call fails. */
export function errorPayload(error) {
  return { ok: false, error: String(error?.message ?? error ?? 'unknown error') }
}
