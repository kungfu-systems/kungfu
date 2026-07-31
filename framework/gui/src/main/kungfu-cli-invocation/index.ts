import { existsSync } from 'node:fs';
import path from 'node:path';

export type GuiKungfuCliInvocation = {
  bin: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
  source: 'configured' | 'adjacent-runtime' | 'source-python' | 'unavailable';
};

type ResolveOptions = {
  env: NodeJS.ProcessEnv;
  runtimeDir: string;
  platform: NodeJS.Platform;
  isPackaged?: boolean;
  resourcesPath?: string;
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
  isPackaged = false,
  resourcesPath = '',
  exists = existsSync,
}: ResolveOptions): GuiKungfuCliInvocation {
  const binName = platform === 'win32' ? 'kungfu.exe' : 'kungfu';
  const adjacent = path.join(runtimeDir, binName);
  const packagedManifest = path.join(
    resourcesPath,
    'upgrade',
    'kungfu-release-manifest.json',
  );
  const packagedRuntimeEnvironment =
    isPackaged && resourcesPath && exists(packagedManifest)
      ? {
          KUNGFU_DIR: runtimeDir,
          KUNGFU_INSTALL_SOURCE: 'desktop-companion',
          KUNGFU_UPGRADE_MANIFEST: packagedManifest,
        }
      : {};
  const configured = (env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || '').trim();
  if (configuredBinaryIsAvailable(configured, exists)) {
    return {
      bin: configured,
      argsPrefix: [],
      env:
        path.isAbsolute(configured) &&
        path.resolve(configured) === path.resolve(adjacent)
          ? packagedRuntimeEnvironment
          : {},
      source: 'configured',
    };
  }

  if (exists(adjacent)) {
    return {
      bin: adjacent,
      argsPrefix: [],
      env: packagedRuntimeEnvironment,
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
