// SPDX-License-Identifier: Apache-2.0

// Typed Node/GUI projection of the installed Core `kungfu exit` operation.
// Root, closure, dependency, import, and receipt semantics remain in Core.

export type ExitValue = Record<string, unknown>;

export type ExitBundleRequest = ExitValue & {
  schema: 'kungfu.exit-bundle-request/v1';
  mode: 'full' | 'thin';
  scope: {
    id: string;
    authority: string;
    schema: string;
    protocol: string;
    cutRoot?: string | null;
  };
  members: Array<{
    memberId: string;
    kind: string;
    requiredForScope?: boolean;
    options?: ExitValue;
  }>;
};

export type ExitPackage = ExitValue & {
  schema: 'kungfu.exit-package/v1';
  manifest: ExitValue;
  materials: Record<string, unknown>;
  execution: Record<string, unknown>;
  packageRoot: string;
};

export type ExitInspection = ExitValue & {
  schema: 'kungfu.exit-package-inspection/v1';
  ok: boolean;
  status: 'verified' | 'degraded';
  mode: 'full' | 'thin';
  bundleRoot: string;
  packageRoot: string;
};

export type ExitImportReceipt = ExitValue & {
  schema: 'kungfu.exit-import-receipt/v1';
  ok: boolean;
  status: 'validated' | 'imported' | 'already_present' | 'partial' | 'rejected';
  receiptRoot: string;
};

export type ExitExecFileSync = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: Record<string, string | undefined>;
    maxBuffer?: number;
  },
) => string;

export type ExitExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: Record<string, string | undefined>;
    maxBuffer?: number;
  },
) => Promise<string>;

export type OpenExitOptions = {
  runtimeDir: string;
  execFileSync: ExitExecFileSync;
  execFile?: ExitExecFile;
  env?: Record<string, string | undefined>;
  bin?: string;
};

export type Exit = {
  build: (request: ExitBundleRequest) => ExitPackage;
  buildAsync: (request: ExitBundleRequest) => Promise<ExitPackage>;
  inspect: (value: ExitPackage) => ExitInspection;
  inspectAsync: (value: ExitPackage) => Promise<ExitInspection>;
  importPackage: (
    value: ExitPackage,
    options?: { execute?: boolean; authorizedBy?: string },
  ) => ExitImportReceipt;
  importPackageAsync: (
    value: ExitPackage,
    options?: { execute?: boolean; authorizedBy?: string },
  ) => Promise<ExitImportReceipt>;
};

export function openExit(options: OpenExitOptions): Exit {
  const env: Record<string, string | undefined> = {
    ...(options.env ?? {}),
    KF_RUNTIME_DIR: options.runtimeDir,
  };
  const bin = options.bin || env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || 'kungfu';
  const run = <T>(args: string[]): T =>
    JSON.parse(
      options.execFileSync(bin, ['exit', ...args, '--json'], {
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024 * 1024,
      }),
    ) as T;
  const runAsync = async <T>(args: string[]): Promise<T> => {
    if (!options.execFile) return run<T>(args);
    const text = await options.execFile(bin, ['exit', ...args, '--json'], {
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(text) as T;
  };
  const encoded = (value: unknown) =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  const importArgs = (
    value: ExitPackage,
    action: { execute?: boolean; authorizedBy?: string } = {},
  ) => [
    'import',
    '--input-base64',
    encoded(value),
    ...(action.execute ? ['--execute'] : []),
    ...(action.authorizedBy ? ['--authorized-by', action.authorizedBy] : []),
  ];
  return {
    build: (request) =>
      run<ExitPackage>(['build', '--input-base64', encoded(request)]),
    buildAsync: (request) =>
      runAsync<ExitPackage>(['build', '--input-base64', encoded(request)]),
    inspect: (value) =>
      run<ExitInspection>(['inspect', '--input-base64', encoded(value)]),
    inspectAsync: (value) =>
      runAsync<ExitInspection>(['inspect', '--input-base64', encoded(value)]),
    importPackage: (value, action = {}) =>
      run<ExitImportReceipt>(importArgs(value, action)),
    importPackageAsync: (value, action = {}) =>
      runAsync<ExitImportReceipt>(importArgs(value, action)),
  };
}
