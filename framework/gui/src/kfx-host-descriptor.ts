// SPDX-License-Identifier: Apache-2.0

import type { KfxExperienceFlowDescriptor } from '@kungfu-tech/api/capability';

type KfxPlan = {
  hostContract?: KfxExperienceFlowDescriptor | null;
};

function hostContract(value: unknown): KfxExperienceFlowDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as KfxPlan).hostContract;
  return candidate &&
    typeof candidate === 'object' &&
    candidate.admission?.state === 'admitted'
    ? candidate
    : null;
}

export function resolveKfxHostDescriptor(options: {
  nativePlan: () => unknown;
  cliPlan: () => unknown;
}): KfxExperienceFlowDescriptor | null {
  try {
    const descriptor = hostContract(options.nativePlan());
    if (descriptor) return descriptor;
  } catch {
    // A retained Project can be inspected without a live native master. In
    // that state the Core CLI remains the exact read-only KFX authority.
  }
  try {
    return hostContract(options.cliPlan());
  } catch {
    return null;
  }
}

export function kfxNativePlanArgs(
  env: Record<string, string | undefined>,
  path: Pick<typeof import('node:path'), 'delimiter' | 'dirname' | 'resolve'>,
  exists: (value: string) => boolean = () => true,
): string[] {
  const roots: Array<{ kind: 'product' | 'user'; path: string }> = [];
  const seen = new Set<string>();
  const add = (kind: 'product' | 'user', value: string | undefined) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (seen.has(resolved) || !exists(resolved)) return;
    seen.add(resolved);
    roots.push({ kind, path: resolved });
  };
  const productRoot = env.KF_BUNDLED_EXTENSION_ROOT;
  add('product', productRoot);
  for (const entry of (env.KF_EXTENSION_PATH ?? '').split(path.delimiter)) {
    if (!entry) continue;
    const resolved = path.resolve(entry);
    add(
      productRoot && resolved === path.resolve(productRoot)
        ? 'product'
        : 'user',
      resolved,
    );
  }
  if (env.KF_RUNTIME_DIR) {
    add('user', path.resolve(path.dirname(env.KF_RUNTIME_DIR), 'extensions'));
  }
  return [
    'kfx',
    'native',
    'plan',
    ...roots.flatMap((root) => ['--root', `${root.kind}=${root.path}`]),
  ];
}
