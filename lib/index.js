/**
 * dsh-tab-groups · host half.
 *
 * This package has two faces in one directory: it is a Chromium extension
 * (`manifest.json` + `src/` + `icons/`) and a DSH plugin (`lib/` +
 * `cordis.patch.yml`). The browser ignores the plugin files, DSH ignores the
 * extension files.
 *
 * The host half exists for one concrete reason: **the browser needs a path the
 * user can point "Load unpacked" at, and nobody knows where an npm package
 * unpacks to.** So on activate we mirror the extension face into a fixed,
 * memorable directory:
 *
 *     ~/.dsh/dsh-tab-groups-extension
 *
 * The GUI half (`./client`) then names that exact path in its install guide,
 * which is why installing this plugin is enough to know *what* to load — the
 * one remaining step (picking the folder in `edge://extensions`) is the part
 * Chromium refuses to let anyone automate.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory of the installed package (= this directory's parent). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Resolve the Harness home exactly as `@deepseek-ai/dsh-home-paths` does:
 * `DSH_HOME` (when non-blank) after `~` expansion, else `~/.dsh`.
 *
 * Reimplemented rather than imported so this plugin keeps zero dependencies —
 * it must be loadable in a profile that has nothing else installed. The
 * behaviour mirrors `resolveDshHome` in `@deepseek-ai/dsh-home-paths`.
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  const configured = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : null
  const raw = configured ?? join(homedir(), '.dsh')
  if (raw === '~') return resolve(homedir())
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolve(join(homedir(), raw.slice(2)))
  return resolve(raw)
}

/** The Harness home this host process is running against. */
export const DSH_HOME = resolveDshHome()

/** The fixed directory the browser-side "Load unpacked" step should point at. */
export const DEFAULT_TARGET_DIR = join(DSH_HOME, 'dsh-tab-groups-extension')

/** Files/directories that make up the extension face. */
export const EXTENSION_FACE = ['manifest.json', 'icons', 'src', 'LICENSE']

/** Stamp file recording which plugin version was mirrored. */
export const STAMP_NAME = '.dsh-tab-groups-version'

function readManifestVersion(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0'
  } catch {
    return null
  }
}

/**
 * Remove one face entry inside the target directory.
 *
 * Deliberately narrow: only the known face entries are ever removed, never the
 * target directory itself and never anything else living in it. A user whose
 * `~/.dsh/dsh-tab-groups-extension` holds extra files keeps them.
 */
function removeFaceEntry(target, name) {
  const path = join(target, name)
  if (!existsSync(path)) return
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 2 })
  } catch (error) {
    throw new Error(`cannot replace ${path}: ${error?.message ?? error}`)
  }
}

function copyFaceEntry(source, target, name) {
  const from = join(source, name)
  if (!existsSync(from)) return false
  const to = join(target, name)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
  return true
}

/**
 * Mirror the extension face into `targetDir`.
 *
 * Idempotent and stamp-guarded: a second call at the same version copies
 * nothing. Every failure is returned rather than thrown, because a plugin that
 * cannot write a helper directory must still let DSH boot.
 *
 * @param {object} [options]
 * @param {string} [options.sourceRoot] package root to copy from
 * @param {string} [options.targetDir] directory to mirror into
 * @param {boolean} [options.force] copy even when the version stamp matches
 * @returns {{ok: boolean, targetDir: string, version: string|null, copied: boolean, error?: string}}
 */
export function syncExtension({ sourceRoot = PACKAGE_ROOT, targetDir = DEFAULT_TARGET_DIR, force = false } = {}) {
  const version = readManifestVersion(sourceRoot)
  if (version === null) {
    return { ok: false, targetDir, version: null, copied: false, error: 'manifest.json is missing or unreadable' }
  }

  try {
    if (!force && existsSync(targetDir)) {
      try {
        const stamp = readFileSync(join(targetDir, STAMP_NAME), 'utf8').trim()
        if (stamp === version && existsSync(join(targetDir, 'manifest.json'))) {
          return { ok: true, targetDir, version, copied: false }
        }
      } catch {
        // No/unreadable stamp: fall through and rewrite.
      }
    }

    mkdirSync(targetDir, { recursive: true })
    for (const name of EXTENSION_FACE) {
      removeFaceEntry(targetDir, name)
      copyFaceEntry(sourceRoot, targetDir, name)
    }
    writeFileSync(join(targetDir, STAMP_NAME), `${version}\n`)
    return { ok: true, targetDir, version, copied: true }
  } catch (error) {
    return { ok: false, targetDir, version, copied: false, error: String(error?.message ?? error) }
  }
}

/**
 * Apply the host half.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} [options] - forwarded to {@link syncExtension} (tests only;
 *   cordis calls `apply(ctx)`, so production always uses the defaults).
 */
export function apply(ctx, options = {}) {
  let result
  try {
    result = syncExtension(options)
  } catch (error) {
    result = { ok: false, targetDir: options.targetDir ?? DEFAULT_TARGET_DIR, version: null, error: String(error?.message ?? error) }
  }

  const message = result.ok
    ? `dsh-tab-groups: extension face ${result.copied ? 'mirrored' : 'already current'} at ${result.targetDir}` +
      (result.copied ? ' — point "Load unpacked" at this directory once.' : '')
    : `dsh-tab-groups: could not mirror the extension face to ${result.targetDir}: ${result.error}`

  try {
    if (typeof ctx?.logger?.info === 'function') {
      if (result.ok) ctx.logger.info(message)
      else ctx.logger.warn(message)
      return
    }
  } catch {
    // A logger that throws must not take the host down.
  }
  if (result.ok) console.log(message)
  else console.warn(message)
}
