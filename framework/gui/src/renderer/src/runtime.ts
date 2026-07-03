// Runtime access for the reference app: load the native kungfu binding
// in-process (nodeIntegration renderer), inject it into the capability SDK
// (ADR-0011), and hand capability handles to the shell and its kfx. This is
// the moat: the renderer reaches the runtime directly, no IPC copy.
import {
  type DomainState,
  type KfNativeBinding,
  type Ledger,
  type Rewind,
  type Work,
  openDomainState,
  openLedger,
  openRewind,
  openWork,
} from '@kungfu-tech/api/capability';

declare global {
  interface Window {
    require: NodeRequire;
    process: NodeJS.Process;
  }
}

export const APP_NAME = 'reference_app';

export type Runtime = {
  ok: boolean;
  message: string;
  runtimeDir: string;
  kungfuVersion: string;
  buildInfo: Record<string, unknown> | null;
  exports: string[];
  longfistTypes: { name: string; fields: string[] }[];
  binding: KfNativeBinding | null;
  ledger: Ledger | null;
  domain: DomainState | null;
  rewind: Rewind | null;
  work: Work | null;
};

function readLongfistTypes(
  binding: KfNativeBinding,
): { name: string; fields: string[] }[] {
  if (!binding.Longfist) return [];
  const lf = new binding.Longfist();
  return Object.keys(lf.types).map((name) => {
    let fields: string[] = [];
    try {
      fields = Object.keys(lf.types[name]());
    } catch {
      fields = [];
    }
    return { name, fields };
  });
}

export function bootRuntime(): Runtime {
  const env = window.process.env;
  const runtimeDir = env.KF_RUNTIME_DIR || '';
  const base: Omit<Runtime, 'ok' | 'message'> = {
    runtimeDir,
    kungfuVersion: env.KUNGFU_VERSION || '',
    buildInfo: null,
    exports: [],
    longfistTypes: [],
    binding: null,
    ledger: null,
    domain: null,
    rewind: null,
    work: null,
  };
  try {
    const bindingPath = env.KFE_PATH;
    if (!bindingPath) {
      return { ...base, ok: false, message: 'KFE_PATH not set' };
    }
    const binding = window.require(bindingPath) as KfNativeBinding;
    let buildInfo: Record<string, unknown> | null = null;
    try {
      const fs = window.require('node:fs');
      const path = window.require('node:path');
      buildInfo = JSON.parse(
        fs.readFileSync(
          path.join(path.dirname(bindingPath), 'kungfubuildinfo.json'),
          'utf8',
        ),
      );
    } catch {
      buildInfo = null;
    }
    // Joining initializes a fresh runtime home's layout and connects to a
    // live master when one is running; the domain handle needs the layout.
    const ledger = openLedger({
      binding,
      locator: { runtimeDir },
      join: { name: APP_NAME },
    });
    const domain = openDomainState({ binding, locator: { runtimeDir } });
    const rewind = openRewind({ binding, locator: { runtimeDir } });
    const work = openWork({ binding, locator: { runtimeDir } });
    return {
      ...base,
      ok: true,
      message: `in-process binding loaded · ${Object.keys(binding).length} exports`,
      buildInfo,
      exports: Object.keys(binding),
      longfistTypes: readLongfistTypes(binding),
      binding,
      ledger,
      domain,
      rewind,
      work,
    };
  } catch (e) {
    return { ...base, ok: false, message: (e as Error).message };
  }
}
