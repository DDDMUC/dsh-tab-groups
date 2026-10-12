/**
 * Print the URL of the *running* `dsh web`, with its current launch token.
 *
 * Why this exists: `dsh web` mints a fresh `?token=` on every start (the token
 * is this process's launch token; the signing secret behind the auth cookie is
 * persisted, so a browser that has already visited once does NOT need a new
 * token — see README's verification notes). Scripts that drive the live GUI
 * therefore need the current URL, which is only in the newest restart log.
 *
 *   node tools/live-url.mjs          # just the URL, for $( … )
 *   node tools/live-url.mjs --check  # verify it answers before printing
 *   node tools/live-url.mjs --json   # details (log, port, reachability)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = new Set(process.argv.slice(2))
const LOG_DIR = process.env.DSH_LOG_DIR ?? join(homedir(), '.dsh', 'logs')
const URL_PATTERN = /http:\/\/[^\s"'`]*?\?token=[A-Za-z0-9_-]+/g

function newestRestartLog() {
  let names
  try {
    names = readdirSync(LOG_DIR).filter((name) => /^web-restart-.*\.log$/.test(name))
  } catch {
    return null
  }
  if (names.length === 0) return null
  const withTime = names.map((name) => ({
    name,
    path: join(LOG_DIR, name),
    mtime: statSync(join(LOG_DIR, name)).mtimeMs,
  }))
  withTime.sort((a, b) => b.mtime - a.mtime)
  return withTime[0]
}

async function reachable(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    const body = await response.text().catch(() => '')
    return {
      status: response.status,
      // A 401 with this body means the token is stale (the host restarted since).
      authenticated: !/authentication required/i.test(body),
    }
  } catch (error) {
    return { status: 0, authenticated: false, error: String(error?.message ?? error) }
  }
}

const log = newestRestartLog()
if (log === null) {
  console.error(`没有在 ${LOG_DIR} 找到 web-restart-*.log —— dsh web 起过吗？`)
  process.exit(1)
}

const matches = readFileSync(log.path, 'utf8').match(URL_PATTERN)
if (matches === null || matches.length === 0) {
  console.error(`最新日志 ${log.name} 里没有带 token 的 URL（可能是 --no-open 或还没打印）`)
  process.exit(1)
}
const url = matches[matches.length - 1]
const details = { url, log: log.name, port: new URL(url).port }
if (args.has('--check') || args.has('--json')) Object.assign(details, await reachable(url))

if (args.has('--json')) {
  console.log(JSON.stringify(details, null, 2))
} else if (details.authenticated === false) {
  console.error(
    `${url}\n（${log.name}）这个 token 已经失效——宿主在那之后又重启过。` +
      `\n若你用的是固定浏览器 profile，直接访问 http://127.0.0.1:${details.port}/ 即可（cookie 仍然有效）。`,
  )
  process.exit(1)
} else {
  console.log(url)
}
