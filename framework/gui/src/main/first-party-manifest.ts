// Generate the frozen first-party manifest (ADR-0013): the build-time record of
// which extension identities are trusted. It is produced by scanning a
// *first-party root* — a compile/ship-time-controlled location, never a
// user-writable install root or a KF_EXTENSION_PATH entry — so a package can
// only enter the trusted set by being shipped as first-party, not by where it
// is later dropped on disk.
//
// `pin: true` (packaging) records a sha256 of each view bundle, so a first-party
// key whose bundle was tampered no longer matches. `pin: false` (development,
// whose bundles change on every rebuild) records `sha256: null` — trusted by key
// alone. The hash must be computed exactly as the loader computes it
// (`sha256(readFileSync(bundlePath, 'utf8'))`) or pinned keys will never match.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { FirstPartyManifest, FirstPartyPin } from '@kungfu-tech/kfx';

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

// Two levels deep, mirroring the loader's packageDirs: suite members live under
// a suite directory (extensions/system/<member>).
function packageDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const dir = join(root, entry.name);
    if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
    for (const nested of readdirSync(dir, { withFileTypes: true })) {
      if (!nested.isDirectory() || nested.name === 'node_modules') continue;
      const nestedDir = join(dir, nested.name);
      if (existsSync(join(nestedDir, 'package.json'))) dirs.push(nestedDir);
    }
  }
  return dirs;
}

type ViewManifest = {
  kungfuConfig?: { key?: string; config?: { view?: { entry?: string } } };
};

export function generateFirstPartyManifest(
  firstPartyRoot: string,
  opts: { pin: boolean },
): FirstPartyManifest {
  const keys: Record<string, FirstPartyPin> = {};
  for (const dir of packageDirs(firstPartyRoot)) {
    let manifest: ViewManifest;
    try {
      manifest = JSON.parse(
        readFileSync(join(dir, 'package.json'), 'utf8'),
      ) as ViewManifest;
    } catch {
      continue;
    }
    const config = manifest.kungfuConfig;
    const view = config?.config?.view;
    if (!config?.key || !view) continue; // only view facets carry a runtime tier
    if (config.key in keys) continue; // first occurrence wins, like the loader
    if (opts.pin) {
      // a pinned build records the bundle hash; a key whose bundle is not built
      // cannot be pinned, so it is omitted (stays untrusted) rather than trusted
      // by key alone — an unpinned entry in a shipped manifest would be forgeable.
      const bundlePath = join(dir, view.entry ?? 'dist/view/index.js');
      if (!existsSync(bundlePath)) continue;
      keys[config.key] = { sha256: sha256(readFileSync(bundlePath, 'utf8')) };
    } else {
      // development: bundles are rebuilt constantly, so trust the key unpinned.
      keys[config.key] = { sha256: null };
    }
  }
  return { version: 1, keys };
}

// Convenience for the main process: derive the runtime manifest path next to the
// runtime home, alongside <home>/extensions.
export function firstPartyManifestPath(runtimeDir: string): string {
  return join(dirname(runtimeDir), 'first-party.json');
}
