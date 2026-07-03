// Kfx loading: scan extension roots for packages whose manifest declares a
// view (`kungfuConfig.config.view`) or a suite (`kungfuConfig.suite`), and
// mount view bundles inside this renderer. Bundles are built by `kfs kfx
// build` with react/react-dom/jsx-runtime and the capability SDK left
// external; the shell injects its own instances through a require shim, so
// every kfx shares one React and one capability surface.
//
// Roots, in priority order (first occurrence of a key wins):
//   1. KF_EXTENSION_PATH entries (path-separator list; dev override)
//   2. <home>/extensions next to the runtime dir (the install root that
//      `kungfu kfx install` populates)
// Scanning goes two levels deep so suite members nested under a suite
// directory (extensions/system/<member>) are found in the workspace layout.
import { resolveRuntimeTier } from '@kungfu-tech/kfx';
import type {
  KfxCapabilityKey,
  KfxEntry,
  KfxRuntimeTier,
  KfxSettingDecl,
  KfxSuiteDecl,
  KfxViewComponent,
} from '@kungfu-tech/kfx';

export type SharedModules = Record<string, unknown>;

// A sandboxed view is never mounted in the shared renderer — the shell embeds
// it as an isolated renderer from its bundlePath. This placeholder stands in
// for its KfxEntry.View so the type stays uniform; mounting it is a shell bug.
const sandboxedPlaceholder: KfxViewComponent = () => null;

export type KfxLoadFailure = {
  dir: string;
  error: string;
};

export type KfxLoadResult = {
  entries: KfxEntry[];
  suites: Record<string, KfxSuiteDecl>;
  failures: KfxLoadFailure[];
};

type NodeFs = {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: string) => string;
  readdirSync: (
    p: string,
    opts: { withFileTypes: true },
  ) => { name: string; isDirectory: () => boolean }[];
};
type NodePath = {
  join: (...parts: string[]) => string;
  dirname: (p: string) => string;
  delimiter: string;
};

const fs = window.require('node:fs') as NodeFs;
const path = window.require('node:path') as NodePath;

export function extensionRoots(
  env: Record<string, string | undefined>,
): string[] {
  const roots: string[] = [];
  for (const entry of (env.KF_EXTENSION_PATH ?? '').split(path.delimiter)) {
    if (entry) roots.push(entry);
  }
  if (env.KF_RUNTIME_DIR) {
    roots.push(path.join(path.dirname(env.KF_RUNTIME_DIR), 'extensions'));
  }
  return roots;
}

function packageDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const dirs: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const dir = path.join(root, entry.name);
    dirs.push(dir);
    // one more level: suite members live under the suite directory
    for (const nested of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!nested.isDirectory() || nested.name === 'node_modules') continue;
      const nestedDir = path.join(dir, nested.name);
      if (fs.existsSync(path.join(nestedDir, 'package.json'))) {
        dirs.push(nestedDir);
      }
    }
  }
  return dirs.filter((dir) => fs.existsSync(path.join(dir, 'package.json')));
}

function loadBundle(
  bundlePath: string,
  shared: SharedModules,
): KfxViewComponent {
  const code = fs.readFileSync(bundlePath, 'utf8');
  const requireShim = (id: string) => {
    if (id in shared) return shared[id];
    throw new Error(
      `kfx bundle requires "${id}" which the shell does not provide — it must be bundled by \`kfs kfx build\` or added to the externals contract`,
    );
  };
  const module = { exports: {} as { View?: KfxViewComponent } };
  // CommonJS-wrap the bundle with the shim; the bundle never touches node
  // resolution — everything external comes from the shell.
  new Function('require', 'module', 'exports', code)(
    requireShim,
    module,
    module.exports,
  );
  const view = module.exports.View;
  if (typeof view !== 'function') {
    throw new Error('bundle does not export a View component');
  }
  return view;
}

export function loadKfx(
  env: Record<string, string | undefined>,
  shared: SharedModules,
): KfxLoadResult {
  const entries: KfxEntry[] = [];
  const suites: Record<string, KfxSuiteDecl> = {};
  const failures: KfxLoadFailure[] = [];
  const seen = new Set<string>();

  // the install root (<home>/extensions) is where `kungfu kfx install` puts
  // third-party packages; a view loaded from there is installed (untrusted).
  const installRoot = env.KF_RUNTIME_DIR
    ? path.resolve(path.join(path.dirname(env.KF_RUNTIME_DIR), 'extensions'))
    : null;

  for (const root of extensionRoots(env)) {
    const installed =
      installRoot !== null && path.resolve(root) === installRoot;
    for (const dir of packageDirs(root)) {
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
        ) as {
          name?: string;
          version?: string;
          kungfuConfig?: {
            key?: string;
            suite?: KfxSuiteDecl;
            config?: {
              view?: {
                title?: string;
                capabilities?: KfxCapabilityKey[];
                runtime?: KfxRuntimeTier;
                system?: boolean;
                settings?: KfxSettingDecl[];
                entry?: string;
              };
            };
          };
        };
        const config = manifest.kungfuConfig;
        if (!config?.key) continue; // not a kfx package (or not one of ours)
        if (config.suite && !suites[config.key]) {
          suites[config.key] = config.suite;
        }
        const view = config.config?.view;
        if (!view) continue;
        if (seen.has(config.key)) continue; // earlier root wins
        seen.add(config.key);
        const bundlePath = path.join(dir, view.entry ?? 'dist/view/index.js');
        const tier = resolveRuntimeTier(
          view,
          installed ? 'installed' : 'built-in',
        );
        entries.push({
          id: config.key,
          title: view.title ?? config.key,
          capabilities: view.capabilities ?? [],
          system: Boolean(view.system),
          settings: view.settings ?? [],
          packageName: manifest.name,
          version: manifest.version,
          source: root,
          tier,
          bundlePath,
          // a sandboxed view is loaded in an isolated renderer, never here
          View:
            tier === 'sandboxed-ipc'
              ? sandboxedPlaceholder
              : loadBundle(bundlePath, shared),
        });
      } catch (e) {
        failures.push({ dir, error: (e as Error).message });
      }
    }
  }

  // join suite membership onto entries
  for (const [key, suite] of Object.entries(suites)) {
    for (const entry of entries) {
      if (suite.members.includes(entry.id)) entry.suite = key;
    }
  }

  return { entries, suites, failures };
}
