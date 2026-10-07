/**
 * Shared Playwright resolver for the two browser lanes.
 *
 * Playwright is not a dependency of this package (the extension itself has
 * none), so the tests resolve it from wherever it happens to live:
 *
 *   PLAYWRIGHT_PATH="/path/to/node_modules/playwright"   # package dir or entry file
 *   PLAYWRIGHT_PATH="/path/to/node_modules"              # or a node_modules dir
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadPlaywright() {
  const candidates = ['playwright']
  const raw = process.env.PLAYWRIGHT_PATH
  if (raw) {
    const trimmed = raw.replace(/\/+$/, '')
    const entry =
      trimmed.endsWith('.mjs') || trimmed.endsWith('.js')
        ? trimmed
        : join(trimmed, trimmed.endsWith('node_modules') ? 'playwright/index.mjs' : 'index.mjs')
    candidates.unshift(pathToFileURL(entry).href)
  }
  const failures = []
  for (const specifier of candidates) {
    try {
      return await import(specifier)
    } catch (error) {
      failures.push(`  ${specifier} → ${error.message}`)
    }
  }
  throw new Error(
    `无法加载 Playwright。请设置 PLAYWRIGHT_PATH 指向 playwright 包目录：\n${failures.join('\n')}`,
  )
}
