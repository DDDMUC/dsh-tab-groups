/**
 * Configuration defaults and normalization.
 *
 * Pure module: no `chrome.*` reference, so it can be imported both by the
 * extension service worker and by `node --test`.
 */

/** Tab group colors accepted by chrome.tabGroups.update. */
export const GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]

/**
 * The identifier a DSH Web GUI page presents to the browser.
 *
 * `@deepseek-ai/dsh-web-frontend` ships a static index.html whose `<title>` is
 * exactly `DeepSeek Harness`; the host only injects a `window.__DSH_BOOT__`
 * script into that body and never rewrites the title. Title is therefore the
 * one anchor that holds across a random `dsh web --port`, `localhost` vs
 * `127.0.0.1`, LAN binds and the cloudflared tunnel hostname alike.
 */
export const DSH_DEFAULT_TITLE = 'DeepSeek Harness'

/** Origins people reach the GUI on with the default `dsh web` port. */
export const DSH_DEFAULT_ORIGINS = [
  'http://127.0.0.1:3080',
  'http://localhost:3080',
]

export const DEFAULT_CONFIG = {
  /** Master switch. When off, nothing is ever grouped or moved. */
  enabled: true,
  /** Title of the group this extension owns. */
  groupTitle: 'DSH',
  /** Color of that group. */
  groupColor: 'blue',
  /** Keep title/color pinned to the config even if renamed by hand. */
  enforceAppearance: true,
  /** Collapse the group automatically after grouping. */
  collapseGroup: false,
  /** Titles (or title prefixes) that identify a DSH tab. */
  matchTitles: [DSH_DEFAULT_TITLE],
  /** Accept `title === pattern + separator` (e.g. "DeepSeek Harness · session"). */
  matchTitlePrefix: true,
  /** Origins that identify a DSH tab even before the title arrives. */
  matchOrigins: [...DSH_DEFAULT_ORIGINS],
  /** Also treat any localhost / 127.0.0.1 / [::1] origin as DSH. */
  matchAnyLocalhostPort: false,
  /** Pull DSH tabs out of other groups into ours. */
  moveFromOtherGroups: true,
  /** Pinned tabs cannot join a group; leave them where they are. */
  skipPinned: true,
  /**
   * Consolidate every DSH tab into one dedicated window that holds nothing but
   * DSH tabs. Off by default: turning it on means even the first DSH tab you
   * open can spawn a window.
   */
  dedicatedWindow: false,
  /** Focus that window when it is created (off: never steal focus). */
  focusDedicatedWindow: false,
}

const GROUP_COLOR_SET = new Set(GROUP_COLORS)

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** Accept an array of strings, or a newline/comma separated string. */
export function toStringList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : null
  if (source === null) return [...fallback]
  const seen = new Set()
  const out = []
  for (const raw of source) {
    if (typeof raw !== 'string') continue
    const item = raw.trim().replace(/\/+$/, '')
    if (item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * Coerce an arbitrary stored object into a complete, safe config.
 * Never throws: a hand-edited or corrupted store degrades to defaults.
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const title = asString(input.groupTitle, DEFAULT_CONFIG.groupTitle)
  const color = GROUP_COLORS.includes(input.groupColor)
    ? input.groupColor
    : DEFAULT_CONFIG.groupColor
  const matchTitles = toStringList(input.matchTitles, DEFAULT_CONFIG.matchTitles)
  return {
    enabled: asBoolean(input.enabled, DEFAULT_CONFIG.enabled),
    groupTitle: title,
    groupColor: color,
    enforceAppearance: asBoolean(input.enforceAppearance, DEFAULT_CONFIG.enforceAppearance),
    collapseGroup: asBoolean(input.collapseGroup, DEFAULT_CONFIG.collapseGroup),
    matchTitles: matchTitles.length > 0 ? matchTitles : [...DEFAULT_CONFIG.matchTitles],
    matchTitlePrefix: asBoolean(input.matchTitlePrefix, DEFAULT_CONFIG.matchTitlePrefix),
    matchOrigins: toStringList(input.matchOrigins, DEFAULT_CONFIG.matchOrigins),
    matchAnyLocalhostPort: asBoolean(
      input.matchAnyLocalhostPort,
      DEFAULT_CONFIG.matchAnyLocalhostPort,
    ),
    moveFromOtherGroups: asBoolean(input.moveFromOtherGroups, DEFAULT_CONFIG.moveFromOtherGroups),
    skipPinned: asBoolean(input.skipPinned, DEFAULT_CONFIG.skipPinned),
    dedicatedWindow: asBoolean(input.dedicatedWindow, DEFAULT_CONFIG.dedicatedWindow),
    focusDedicatedWindow: asBoolean(input.focusDedicatedWindow, DEFAULT_CONFIG.focusDedicatedWindow),
  }
}

export { GROUP_COLOR_SET }
