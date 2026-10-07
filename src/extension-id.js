/**
 * The identity the DSH plugin half uses to address the extension half.
 *
 * The extension's ID is pinned by the `key` field in manifest.json, so it does
 * NOT depend on where this folder lives (an unpacked extension without a pinned
 * key is identified by its absolute path — which would break the moment the
 * folder moved, and with it the plugin's address). Regenerate/move the pair
 * together:
 *
 *   node tools/make-key.mjs --write
 *
 * `test/pairing.test.mjs` asserts that this constant, the manifest key and the
 * literal inlined in `lib/client.js` all agree, so they cannot drift apart.
 */

export const EXTENSION_ID = 'pnncehmieeobfabnbdepbldiknndjbhl'

/** Version of the DSH-page ↔ extension message protocol. */
export const PROTOCOL_VERSION = 1
