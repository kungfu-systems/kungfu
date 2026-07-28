// Kfx loading in the GUI renderer: discover + decide via the host-agnostic
// `planKfx` (`@kungfu-tech/kfx`), then LAND each planned kfx in this renderer.
// Landing evaluates an explicitly integrated view's bundle — and injects its
// sibling CSS — into this document, or stands in a placeholder for an isolated view the shell
// embeds as an isolated renderer. Bundles are built by `kungfu sdk kfx build`
// with the modules declared by `framework/kfx/shared-modules.json` left
// external; the shell injects its own instances through a require shim, so
// every kfx shares one React and one public API surface.
//
// Discovery lives in `planKfx`; authority does not. Only an exact Core host
// descriptor can authorize renderer landing.
import {
  type KfxExperienceFlowDescriptor,
  authorizeKfxHostLaunch,
} from '@kungfu-tech/api/capability';
import {
  type KfxPlanDeps,
  type KfxSuiteDecl,
  type KfxViewComponent,
  type ProfileManifest,
  planKfx,
} from '@kungfu-tech/kfx';
import type { KfxEntry } from '@kungfu-tech/kfx';

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
  profiles: ProfileManifest[];
  failures: KfxLoadFailure[];
};

// This renderer's fs/path/crypto handles, wired into planKfx's injected deps.
// The CLI host passes `node:` modules instead; the plan rule is identical.
const deps: KfxPlanDeps = {
  fs: window.require('node:fs') as KfxPlanDeps['fs'],
  path: window.require('node:path') as KfxPlanDeps['path'],
  crypto: window.require('node:crypto') as KfxPlanDeps['crypto'],
};

function loadBundle(
  bundlePath: string,
  shared: SharedModules,
): KfxViewComponent {
  const code = deps.fs.readFileSync(bundlePath, 'utf8');
  // `kungfu sdk kfx build` emits the view's styles as a sibling index.css. The bundle
  // eval below only runs JS, so without this the view's CSS (e.g. xterm.css,
  // which positions rows, maps mouse coordinates, and hides the helper textarea)
  // never applies. Inject it into this renderer's document once per bundle.
  const cssPath = bundlePath.replace(/\.js$/, '.css');
  if (cssPath !== bundlePath) {
    try {
      const css = deps.fs.readFileSync(cssPath, 'utf8');
      const style = document.createElement('style');
      style.dataset.kfxView = bundlePath;
      style.textContent = css;
      document.head.appendChild(style);
    } catch {
      // no sibling stylesheet — the view ships no CSS
    }
  }
  const requireShim = (id: string) => {
    if (id in shared) return shared[id];
    throw new Error(
      `kfx bundle requires "${id}" which the shell does not provide — it must be bundled by \`kungfu sdk kfx build\` or added to the externals contract`,
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

// Discover + decide with the shared rule, then land each planned kfx in this
// renderer. Landing mirrors the old loadKfx's per-package try boundary: a
// bundle that fails to evaluate drops out of `entries` and into `failures`
// under its own package `dir`, exactly as before — only the decision half moved
// to planKfx. (failures now list plan/discovery errors first, then landing
// errors, rather than strictly interleaved by discovery order; the set is the
// same and the UI keys each by dir.)
export function loadKfx(
  env: Record<string, string | undefined>,
  shared: SharedModules,
  descriptor: KfxExperienceFlowDescriptor | null = null,
): KfxLoadResult {
  const plan = planKfx(env, deps);
  const entries: KfxEntry[] = [];
  const failures: KfxLoadFailure[] = [...plan.failures];
  for (const entry of plan.entries) {
    try {
      const candidate = descriptor?.runtimeAuthorizations.find(
        (authorization) =>
          authorization.packageKey === entry.id && authorization.host === 'gui',
      );
      if (!descriptor || !candidate) {
        failures.push({
          dir: entry.dir,
          error:
            'KF_KFX_HOST_NOT_AUTHORIZED: exact Core host authorization required',
        });
        continue;
      }
      const authorization = authorizeKfxHostLaunch(
        descriptor,
        entry.id,
        'gui',
        candidate.authorizationRoot,
      );
      const declaredCapabilities = new Set<string>(entry.capabilities);
      if (
        authorization.requiredCapabilities.some(
          (capability) => !declaredCapabilities.has(capability),
        )
      ) {
        throw new Error(
          'KF_KFX_HOST_NOT_AUTHORIZED: manifest and Core capability roots differ',
        );
      }
      const tier =
        authorization.runtimeTier === 'integrated-explicit'
          ? 'node-integrated'
          : 'sandboxed-ipc';
      const View =
        tier === 'sandboxed-ipc'
          ? sandboxedPlaceholder
          : loadBundle(entry.bundlePath, shared);
      entries.push({
        ...entry,
        tier,
        executionAllowed: true,
        authorizationRoot: authorization.authorizationRoot,
        View,
      });
    } catch (e) {
      failures.push({ dir: entry.dir, error: (e as Error).message });
    }
  }
  return {
    entries,
    suites: plan.suites,
    profiles: plan.profiles,
    failures,
  };
}
