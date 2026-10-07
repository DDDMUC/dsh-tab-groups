/**
 * Pin (or report) the stable Chromium extension ID.
 *
 * An unpacked extension without a manifest `key` is identified by its absolute
 * install path, so its ID changes the moment the folder moves — and the DSH
 * plugin half, which addresses the extension by ID over
 * `externally_connectable`, would lose its address. A manifest `key` pins the
 * ID to a public key instead, which is what makes "one package, two faces"
 * work regardless of where the folder lives.
 *
 *   node tools/make-key.mjs            # report the pinned key + ID (no writes)
 *   node tools/make-key.mjs --new      # print a fresh key pair
 *   node tools/make-key.mjs --new --write   # ... and write the public key into manifest.json
 *
 * Only the PUBLIC key is ever stored (in manifest.json). The private key is
 * printed once so it can be kept for packing a .crx, and is never written to
 * this repository — an extension directory that contains a private key file is
 * exactly what store review rejects.
 */

import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_FILE = join(ROOT, 'manifest.json')
const CLIENT_FILE = join(ROOT, 'lib', 'client.js')
const ID_FILE = join(ROOT, 'src', 'extension-id.js')

/** True when this file is the process entry point, not an import from a test. */
function isMain() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(entry).href === import.meta.url
  } catch {
    return false
  }
}

/** Chromium: id = first 16 bytes of SHA-256(SPKI DER), each nibble mapped onto a..p. */
export function extensionIdFromSpkiDer(der) {
  const digest = createHash('sha256').update(der).digest().subarray(0, 16)
  let id = ''
  for (const byte of digest) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

/** Derive the extension ID from a manifest `key` (base64 SPKI DER). */
export function extensionIdFromManifestKey(key) {
  return extensionIdFromSpkiDer(Buffer.from(key, 'base64'))
}

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
}

function report(manifest) {
  const key = manifest.key
  if (typeof key !== 'string' || key === '') {
    console.error('manifest.json has no "key" — run with --new --write to pin one.')
    process.exitCode = 1
    return
  }
  const id = extensionIdFromManifestKey(key)
  const clientSource = readFileSync(CLIENT_FILE, 'utf8')
  const clientMatch = /const EXTENSION_ID = '([a-p]{32})'/.exec(clientSource)
  const idSource = readFileSync(ID_FILE, 'utf8')
  const idMatch = /export const EXTENSION_ID = '([a-p]{32})'/.exec(idSource)

  console.log(`extension id : ${id}`)
  console.log(`manifest key : ${key.slice(0, 24)}… (${key.length} chars)`)
  console.log(`lib/client.js: ${clientMatch?.[1] ?? '(not found)'}`)
  console.log(`src/extension-id.js: ${idMatch?.[1] ?? '(not found)'}`)

  const literals = [clientMatch?.[1], idMatch?.[1]]
  const stale = literals.filter((value) => value !== undefined && value !== id)
  if (stale.length > 0) {
    console.error(`\nMISMATCH: these literals are stale, update them to ${id}:`)
    for (const value of stale) console.error(`  ${value}`)
    process.exitCode = 1
    return
  }
  console.log('\nall three agree.')
}

if (isMain()) {
  if (process.argv.includes('--new')) {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const spkiDer = createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'der' })
    const key = spkiDer.toString('base64')
    const id = extensionIdFromSpkiDer(spkiDer)
    console.log(`new extension id : ${id}`)
    console.log(`new manifest key : ${key}`)
    console.log('\nprivate key (keep out of this directory, needed only to pack a .crx):')
    console.log(privateKey)

    if (process.argv.includes('--write')) {
      const manifest = readManifest()
      manifest.key = key
      writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`)
      console.log('\nmanifest.json updated. Now update EXTENSION_ID in:')
      console.log(`  ${ID_FILE}`)
      console.log(`  ${CLIENT_FILE}`)
    }
  } else {
    report(readManifest())
  }
}
