import { existsSync } from 'node:fs';
import path from 'node:path';

export type GuiKungfuCliInvocation = {
  bin: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
  source: 'configured' | 'adjacent-runtime' | 'source-python' | 'unavailable';
};

type ResolveGuiKungfuCliOptions = {
  env: NodeJS.ProcessEnv;
  runtimeDir: string;
  platform: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
};

function configuredBinaryIsAvailable(
  configured: string,
  exists: (candidate: string) => boolean,
): boolean {
  return Boolean(
    configured &&
      (!path.isAbsolute(configured) || exists(path.resolve(configured))),
  );
}

export function resolveGuiKungfuCliInvocation({
  env,
  runtimeDir,
  platform,
  exists = existsSync,
}: ResolveGuiKungfuCliOptions): GuiKungfuCliInvocation {
  const configured = (env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || '').trim();
  if (configuredBinaryIsAvailable(configured, exists)) {
    return {
      bin: configured,
      argsPrefix: [],
      env: {},
      source: 'configured',
    };
  }

  const binName = platform === 'win32' ? 'kungfu.exe' : 'kungfu';
  const adjacent = path.join(runtimeDir, binName);
  if (exists(adjacent)) {
    return {
      bin: adjacent,
      argsPrefix: [],
      env: {},
      source: 'adjacent-runtime',
    };
  }

  const coreDir = path.resolve(runtimeDir, '..', '..');
  const sourceMain = path.join(
    coreDir,
    'src',
    'python',
    'kungfu',
    '__main__.py',
  );
  if (exists(sourceMain)) {
    const pythonPath = [
      path.join(coreDir, 'src', 'python'),
      env.KUNGFU_NATIVE_PATH || path.join(coreDir, 'build', 'Release'),
      env.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(path.delimiter);
    return {
      bin: env.KUNGFU_DEV_UV_BIN || 'uv',
      argsPrefix: [
        'run',
        '--project',
        coreDir,
        '--frozen',
        'python',
        '-m',
        'kungfu',
      ],
      env: { PYTHONPATH: pythonPath },
      source: 'source-python',
    };
  }

  return {
    bin: configured || adjacent,
    argsPrefix: [],
    env: {},
    source: 'unavailable',
  };
}

type ProfileCliResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

type ProfileCliExec = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
  },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export type ProfileCliDeps = {
  bin: string;
  env: NodeJS.ProcessEnv;
  execFile: ProfileCliExec;
  argsPrefix?: string[];
};

export async function executeProfileCli(
  payload: unknown,
  deps: ProfileCliDeps,
): Promise<ProfileCliResult> {
  const args = (payload as { args?: unknown })?.args;
  if (
    !Array.isArray(args) ||
    args.length < 2 ||
    args[0] !== 'profile' ||
    !args.every((value) => typeof value === 'string')
  ) {
    return { ok: false, error: 'invalid Profile CLI request' };
  }
  return await new Promise<ProfileCliResult>((resolve) => {
    deps.execFile(
      deps.bin,
      [...(deps.argsPrefix ?? []), ...args],
      {
        encoding: 'utf8',
        env: deps.env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: stderr.trim() || error.message });
          return;
        }
        resolve({ ok: true, stdout });
      },
    );
  });
}
