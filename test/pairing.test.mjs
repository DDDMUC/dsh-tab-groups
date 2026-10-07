/**
 * The pair cannot drift apart.
 *
 * Three places name the extension: the manifest `key`, `src/extension-id.js`,
 * and the literal inlined in `lib/client.js` (which cannot import, because the
 * GUI module loader hands it a bare file). Plus the manifest and package.json
 * describe the same artifact. Every one of those couplings is asserted here, so
 * a rename or a re-key fails the test suite instead of silently breaking the
 * DSH half at runtime.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXTENSION_ID, PROTOCOL_VERSION } from '../src/extension-id.js'
import { extensionIdFromManifestKey } from '../tools/make-key.mjs'
import { EXTENSION_FACE, DEFAULT_TARGET_DIR, resolveDshHome } from '../lib/index.js'
import { WRITABLE_KEYS } from '../src/protocol.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

/* ------------------------------------------------------------- identity */

test('the manifest key derives exactly the id the plugin half addresses', () => {
  assert.equal(typeof manifest.key, 'string')
  assert.equal(extensionIdFromManifestKey(manifest.key), EXTENSION_ID)
})

test('lib/client.js inlines the same id it cannot import', () => {
  const match = /const EXTENSION_ID = '([a-p]{32})'/.exec(clientSource)
  assert.notEqual(match, null, 'lib/client.js must declare EXTENSION_ID')
  assert.equal(match[1], EXTENSION_ID)
})

test('lib/client.js inlines the same protocol version', () => {
  const match = /const PROTOCOL_VERSION = (\d+)/.exec(clientSource)
  assert.notEqual(match, null)
  assert.equal(Number(match[1]), PROTOCOL_VERSION)
})

test('the extension halves are version-locked to the package', () => {
  assert.equal(manifest.version, pkg.version)
})

/* ------------------------------------------------------------ manifest */

test('manifest keeps the permission surface minimal', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['storage', 'tabGroups', 'tabs'])
  // No host permissions, no content scripts: matching is done from the service
  // worker against title/origin, so the extension never runs inside a page.
  assert.equal(manifest.host_permissions, undefined)
  assert.equal(manifest.content_scripts, undefined)
  assert.equal(manifest.optional_permissions, undefined)
})

test('manifest exposes exactly the DSH origins to externally_connectable', () => {
  const matches = manifest.externally_connectable?.matches ?? []
  assert.ok(matches.includes('http://127.0.0.1/*'))
  assert.ok(matches.includes('http://localhost/*'))
  for (const pattern of matches) {
    assert.match(pattern, /^(https?):\/\/(\[\:\:1\]|localhost|127\.0\.0\.1|\*\.dsh-market\.com)\/\*$/, pattern)
  }
})

test('every file the manifest points at exists', () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ]
  for (const file of new Set(referenced)) {
    assert.ok(existsSync(join(ROOT, file)), `missing: ${file}`)
  }
})

test('imports inside src/ resolve, so the service worker cannot 404 at boot', () => {
  const seen = new Set(['src/background.js'])
  const queue = ['src/background.js']
  while (queue.length > 0) {
    const file = queue.pop()
    const source = readFileSync(join(ROOT, file), 'utf8')
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const resolved = join(dirname(join(ROOT, file)), match[1])
      assert.ok(existsSync(resolved), `${file} imports missing ${match[1]}`)
      const rel = match[1].replace(/^\.\//, `src/`)
      if (!seen.has(rel)) {
        seen.add(rel)
        queue.push(rel)
      }
    }
  }
  assert.ok(seen.size >= 5, `expected the whole src/ graph, walked ${seen.size}`)
})

/* ------------------------------------------------- the two faces agree */

test('both faces ship: extension entries and plugin entries are all present', () => {
  for (const name of EXTENSION_FACE) {
    assert.ok(existsSync(join(ROOT, name)), `extension face missing: ${name}`)
  }
  for (const name of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
    assert.ok(existsSync(join(ROOT, name)), `plugin face missing: ${name}`)
  }
})

test('every face file is published, or an npm install would ship half a product', () => {
  for (const name of ['manifest.json', 'src', 'icons', 'lib', 'cordis.patch.yml']) {
    assert.ok(pkg.files.includes(name), `package.json "files" omits ${name}`)
  }
  // The private-key directory belongs to neither face and must not ship.
  assert.ok(!pkg.files.includes('keys'))
})

test('package.json declares both faces to their own loader', () => {
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('cordis.patch.yml inserts the bare package name', () => {
  const yaml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  // A subpath here would be cached as "not a client package" and the browser
  // half would silently never load.
  assert.match(yaml, new RegExp(`name:\\s*'${pkg.name}'`))
  assert.match(yaml, new RegExp(`id:\\s*${pkg.name}`))
})

test('every config field the chip can write is on the protocol whitelist', () => {
  // The chip writes these through `set-config`; a field the whitelist forgot
  // would fail silently at runtime.
  const written = [...clientSource.matchAll(/save\(\{\s*(\w+):/g)].map((m) => m[1])
  assert.ok(written.length >= 3, `expected the chip to write config, found ${written.length}`)
  for (const field of written) {
    assert.ok(WRITABLE_KEYS.has(field), `${field} is written by the chip but not whitelisted`)
  }
})

test('the mirror target lives under the resolved DSH home', () => {
  assert.ok(DEFAULT_TARGET_DIR.endsWith('dsh-tab-groups-extension'))
  assert.equal(dirname(DEFAULT_TARGET_DIR), resolveDshHome())
})

test('DSH_HOME is honoured, exactly like @deepseek-ai/dsh-home-paths', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/custom-home' }), '/tmp/custom-home')
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
  assert.equal(resolveDshHome({}), join(homedir(), '.dsh'))
  assert.equal(resolveDshHome({ DSH_HOME: '~/x' }), join(homedir(), 'x'))
})
