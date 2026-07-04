// SPDX-License-Identifier: Apache-2.0
// Bake the frozen first-party manifest (ADR-0013): scan the product's own
// extensions/ tree, pin each built view bundle by content hash, and write
// first-party.json into framework/core/dist/kungfu. That directory is the frozen
// CLI's home (the supervisor reads the manifest next to its executable) and is
// shipped to the app's Resources/kungfu (the packaged GUI reads it there) — so a
// single baked manifest lets both grant trust by verifiable source without the
// source extensions/ tree.
//
// Pinned: run AFTER the extension view bundles are built (`kungfu sdk kfx build`); a key
// whose bundle is not built is omitted (stays untrusted) rather than trusted by
// key alone. Run: node --experimental-transform-types gen-first-party-manifest.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateFirstPartyManifest } from '../src/main/first-party-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const extensionsRoot = join(here, '..', '..', '..', 'extensions');
const outPath = join(
  here,
  '..',
  '..',
  'core',
  'dist',
  'kungfu',
  'first-party.json',
);

const manifest = generateFirstPartyManifest(extensionsRoot, { pin: true });
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(manifest), 'utf8');

const n = Object.keys(manifest.keys).length;
console.log(`[first-party] wrote ${n} pinned key(s) -> ${outPath}`);
if (n === 0) {
  console.warn(
    '[first-party] no pinned keys — build the extension view bundles first ' +
      '(`kungfu sdk kfx build`), or the frozen build will trust only system views',
  );
}
