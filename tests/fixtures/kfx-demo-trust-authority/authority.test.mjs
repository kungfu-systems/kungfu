// SPDX-License-Identifier: Apache-2.0
// Gate for the source-authority verdict (ADR-0013): a view is granted the
// node-integrated tier only when its key is in the frozen first-party set and,
// when pinned, its bundle content hash matches — never because of which
// extension root it loaded from. Headless — the verdict is pure
// (framework/kfx/src/index.ts) and the manifest generator scans a fixed
// first-party root (framework/gui/src/main/first-party-manifest.ts).
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  authorizeFirstParty,
  resolveRuntimeTier,
} from '../../../framework/kfx/src/index.ts';
import { generateFirstPartyManifest } from '../../../framework/gui/src/main/first-party-manifest.ts';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const fails = [];
const ck = (n, ok) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'}  ${n}`);
  if (!ok) fails.push(n);
};

// A view kfx package on disk: manifest + bundle with the given content.
function writeView(root, key, bundleContent) {
  const dir = join(root, key);
  mkdirSync(join(dir, 'dist', 'view'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@kungfu-tech/kfx-view-${key}`,
      kungfuConfig: { key, config: { view: { title: key, capabilities: [] } } },
    }),
  );
  writeFileSync(join(dir, 'dist', 'view', 'index.js'), bundleContent);
}

// First-party root (shipped) with two views; a *separate* third-party root
// (what a KF_EXTENSION_PATH entry or the install root would be) with a squatter.
const base = mkdtempSync(join(tmpdir(), 'kfx-trust-'));
const firstPartyRoot = join(base, 'first-party');
const thirdPartyRoot = join(base, 'third-party');
writeView(firstPartyRoot, 'work-dashboard', 'FIRST-PARTY-A');
writeView(firstPartyRoot, 'rewind', 'FIRST-PARTY-B');
writeView(thirdPartyRoot, 'evil', 'THIRD-PARTY');

const view = { title: 't', capabilities: [] };
const tier = (manifest, key, hash, v = view) =>
  resolveRuntimeTier(v, authorizeFirstParty(manifest, key, hash));

// 1. The generator scans only the first-party root — a package that lives on a
//    different root is simply not in the set, no matter where it sits.
const pinned = generateFirstPartyManifest(firstPartyRoot, { pin: true });
ck('generator includes first-party keys', 'work-dashboard' in pinned.keys && 'rewind' in pinned.keys);
ck('generator excludes a key from another root', !('evil' in pinned.keys));
ck('generator pins the bundle hash', pinned.keys['work-dashboard'].sha256 === sha256('FIRST-PARTY-A'));

// 2. The crux: a third-party package on the extension path is NOT trusted, even
//    though under the old rule any non-install root conferred node-integrated.
ck('third-party key on another root is sandboxed', tier(pinned, 'evil', sha256('THIRD-PARTY')) === 'sandboxed-ipc');

// 3. A first-party key is node-integrated only with the matching content.
ck('first-party key + matching hash is node-integrated', tier(pinned, 'work-dashboard', sha256('FIRST-PARTY-A')) === 'node-integrated');
ck('first-party key + tampered bundle is sandboxed', tier(pinned, 'work-dashboard', sha256('TAMPERED')) === 'sandboxed-ipc');

// 4. Dev (unpinned) trusts a first-party key by identity alone.
const dev = generateFirstPartyManifest(firstPartyRoot, { pin: false });
ck('dev manifest is unpinned', dev.keys['work-dashboard'].sha256 === null);
ck('dev first-party key is node-integrated regardless of content', tier(dev, 'work-dashboard', sha256('anything')) === 'node-integrated');

// 5. No manifest trusts nothing but the shell's own system views.
ck('null manifest: a view is sandboxed', tier(null, 'work-dashboard', sha256('FIRST-PARTY-A')) === 'sandboxed-ipc');
ck('system view is node-integrated without a manifest', tier(null, 'settings', null, { ...view, system: true }) === 'node-integrated');

if (fails.length) {
  console.log(`trust-authority check failed: ${fails}`);
  process.exit(1);
}
console.log('trust-authority check passed');
