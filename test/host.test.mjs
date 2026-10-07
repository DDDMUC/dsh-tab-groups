/**
 * The host half's one real job: put the extension face where the browser can be
 * pointed at it, without ever touching anything else in that directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PACKAGE_ROOT, STAMP_NAME, apply, syncExtension } from '../lib/index.js'

const ROOT = PACKAGE_ROOT
const EXPECTED_VERSION = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tab-groups-host-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('syncExtension mirrors the extension face into an empty directory', () => {
  const { dir, cleanup } = scratch()
  try {
    const target = join(dir, 'mirror')
    const result = syncExtension({ sourceRoot: ROOT, targetDir: target })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.copied, true)
    assert.equal(result.version, EXPECTED_VERSION)

    for (const name of ['manifest.json', 'icons', 'src', 'LICENSE']) {
      assert.ok(existsSync(join(target, name)), `missing ${name}`)
    }
    // The mirror must be loadable as an extension on its own.
    const mirrored = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'))
    assert.equal(mirrored.version, EXPECTED_VERSION)
    assert.equal(mirrored.key, JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).key)
    assert.ok(existsSync(join(target, mirrored.background.service_worker)))
    assert.ok(readdirSync(join(target, 'icons')).length >= 4)
  } finally {
    cleanup()
  }
})

test('a second run at the same version copies nothing', () => {
  const { dir, cleanup } = scratch()
  try {
    const target = join(dir, 'mirror')
    syncExtension({ sourceRoot: ROOT, targetDir: target })
    const again = syncExtension({ sourceRoot: ROOT, targetDir: target })
    assert.equal(again.ok, true)
    assert.equal(again.copied, false)
  } finally {
    cleanup()
  }
})

test('force rewrites the mirror', () => {
  const { dir, cleanup } = scratch()
  try {
    const target = join(dir, 'mirror')
    syncExtension({ sourceRoot: ROOT, targetDir: target })
    assert.equal(syncExtension({ sourceRoot: ROOT, targetDir: target, force: true }).copied, true)
  } finally {
    cleanup()
  }
})

test('a mirror left by an older plugin version is refreshed, not merged', () => {
  const { dir, cleanup } = scratch()
  try {
    const target = join(dir, 'mirror')
    syncExtension({ sourceRoot: ROOT, targetDir: target })
    // Simulate a mirror written by a previous release: old stamp, and content
    // the current version no longer ships.
    writeFileSync(join(target, STAMP_NAME), '0.0.1\n')
    writeFileSync(join(target, 'src', 'removed-old-file.js'), '// gone\n')
    writeFileSync(join(target, 'manifest.json'), '{"version":"0.0.1"}')

    const result = syncExtension({ sourceRoot: ROOT, targetDir: target })
    assert.equal(result.copied, true, 'an older stamp must trigger a re-copy')

    const now = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'))
    assert.equal(now.version, EXPECTED_VERSION)
    assert.ok(!existsSync(join(target, 'src', 'removed-old-file.js')), 'stale file survived the refresh')
  } finally {
    cleanup()
  }
})

test('a missing stamp falls through to a re-copy', () => {
  const { dir, cleanup } = scratch()
  try {
    const target = join(dir, 'mirror')
    syncExtension({ sourceRoot: ROOT, targetDir: target })
    rmSync(join(target, STAMP_NAME))
    assert.equal(syncExtension({ sourceRoot: ROOT, targetDir: target }).copied, true)
  } finally {
    cleanup()
  }
})

test('unrelated files in the mirror directory are left alone', () => {
  const { dir, cleanup } = scratch()
  try {
    const target = join(dir, 'mirror')
    mkdirSync(join(target, 'notes'), { recursive: true })
    writeFileSync(join(target, 'notes', 'mine.txt'), 'keep me')
    writeFileSync(join(target, 'unrelated.txt'), 'keep me too')
    syncExtension({ sourceRoot: ROOT, targetDir: target, force: true })

    // Removal is deliberately narrow: only the known face entries are replaced,
    // never the directory itself and never another file living in it.
    assert.equal(readFileSync(join(target, 'notes', 'mine.txt'), 'utf8'), 'keep me')
    assert.equal(readFileSync(join(target, 'unrelated.txt'), 'utf8'), 'keep me too')
    assert.ok(existsSync(join(target, 'manifest.json')))
  } finally {
    cleanup()
  }
})

test('a source that is not an extension fails without throwing', () => {
  const { dir, cleanup } = scratch()
  try {
    const result = syncExtension({ sourceRoot: join(dir, 'nope'), targetDir: join(dir, 'mirror') })
    assert.equal(result.ok, false)
    assert.match(result.error, /manifest\.json/)
  } finally {
    cleanup()
  }
})

test('apply() reports through the plugin logger and never throws', () => {
  const { dir, cleanup } = scratch()
  try {
    const target = join(dir, 'mirror')
    const lines = []
    const ctx = { logger: { info: (message) => lines.push(['info', message]), warn: (m) => lines.push(['warn', m]) } }
    apply(ctx, { sourceRoot: ROOT, targetDir: target })
    assert.equal(lines.length, 1)
    assert.equal(lines[0][0], 'info')
    assert.match(lines[0][1], /mirrored/)
    assert.ok(lines[0][1].includes(target))

    apply(ctx, { sourceRoot: ROOT, targetDir: target })
    assert.match(lines[1][1], /already current/)

    // A logger that throws must not take the host down.
    apply({ logger: { info: () => { throw new Error('logger exploded') } } }, { sourceRoot: ROOT, targetDir: target })

    // No logger at all is fine too (apply falls back to console).
    const quiet = console.log
    console.log = () => {}
    try {
      apply(undefined, { sourceRoot: ROOT, targetDir: target })
    } finally {
      console.log = quiet
    }
  } finally {
    cleanup()
  }
})

test('apply() survives an unwritable target', () => {
  const { dir, cleanup } = scratch()
  try {
    // A *file* where the mirror directory should be.
    const target = join(dir, 'blocked')
    writeFileSync(target, 'not a directory')
    const lines = []
    const ctx = { logger: { info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) } }
    apply(ctx, { sourceRoot: ROOT, targetDir: target })
    assert.equal(lines.length, 1)
    assert.equal(lines[0][0], 'warn')
    assert.match(lines[0][1], /could not mirror/)
  } finally {
    cleanup()
  }
})
