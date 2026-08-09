import { readFileSync } from 'node:fs';
import path from 'node:path';

const DEVELOPMENT_RUNTIME_BUILD_ID = 'development';

type ProductCacheEnvironmentOptions = {
  isPackaged: boolean;
  resourcesPath: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  cwd?: string;
  readFile?: (file: string) => string;
};

function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function platformPath(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function absoluteEnvironmentPath(
  value: string,
  homeDir: string,
  cwd: string,
  platform: NodeJS.Platform,
): string {
  const paths = platformPath(platform);
  const expanded =
    value === '~'
      ? homeDir
      : value.startsWith('~/') || value.startsWith('~\\')
        ? paths.join(homeDir, value.slice(2))
        : value;
  return paths.resolve(cwd, expanded);
}

export function resolveProductCacheHome(
  env: NodeJS.ProcessEnv,
  options: Omit<ProductCacheEnvironmentOptions, 'isPackaged' | 'resourcesPath'>,
): string {
  const platform = options.platform ?? process.platform;
  const paths = platformPath(platform);
  const homeDir = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? '';
  const cwd = options.cwd ?? process.cwd();
  const explicit = nonEmpty(env.KF_CACHE_HOME);
  if (explicit) {
    return absoluteEnvironmentPath(explicit, homeDir, cwd, platform);
  }
  const instanceHome = nonEmpty(env.KF_INSTANCE_HOME);
  if (instanceHome) {
    return paths.join(
      absoluteEnvironmentPath(instanceHome, homeDir, cwd, platform),
      'cache',
    );
  }

  if (platform === 'darwin') {
    if (!homeDir)
      throw new Error('cannot resolve KF_CACHE_HOME: HOME is unset');
    return paths.join(homeDir, 'Library', 'Caches', 'kungfu');
  }
  if (platform === 'win32') {
    const localAppData = nonEmpty(env.LOCALAPPDATA);
    if (localAppData) return paths.join(localAppData, 'Kungfu', 'Cache');
    if (!homeDir) {
      throw new Error(
        'cannot resolve KF_CACHE_HOME: LOCALAPPDATA and USERPROFILE are unset',
      );
    }
    return paths.join(homeDir, 'AppData', 'Local', 'Kungfu', 'Cache');
  }
  const cacheBase = nonEmpty(env.XDG_CACHE_HOME);
  if (cacheBase) return paths.join(cacheBase, 'kungfu');
  if (!homeDir) {
    throw new Error(
      'cannot resolve KF_CACHE_HOME: XDG_CACHE_HOME and HOME are unset',
    );
  }
  return paths.join(homeDir, '.cache', 'kungfu');
}

export function runtimeBuildIdFromManifest(contents: string): string {
  const value = (JSON.parse(contents) as { runtimeBuildId?: unknown })
    .runtimeBuildId;
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new Error(
      'upgrade manifest runtimeBuildId is not a safe cache namespace',
    );
  }
  return value;
}

export function configureProductCacheEnvironment(
  env: NodeJS.ProcessEnv,
  options: ProductCacheEnvironmentOptions,
) {
  const platform = options.platform ?? process.platform;
  const paths = platformPath(platform);
  const cacheHome = resolveProductCacheHome(env, options);
  let manifestPath = nonEmpty(env.KUNGFU_UPGRADE_MANIFEST);
  if (!manifestPath && options.isPackaged) {
    manifestPath = paths.join(
      options.resourcesPath,
      'upgrade',
      'kungfu-release-manifest.json',
    );
    env.KUNGFU_UPGRADE_MANIFEST = manifestPath;
  }
  const readFile = options.readFile ?? ((file) => readFileSync(file, 'utf8'));
  const runtimeBuildId = manifestPath
    ? runtimeBuildIdFromManifest(readFile(manifestPath))
    : DEVELOPMENT_RUNTIME_BUILD_ID;

  env.KF_CACHE_HOME = cacheHome;
  env.PYTHONPYCACHEPREFIX = paths.join(cacheHome, 'python', runtimeBuildId);
  return { cacheHome, runtimeBuildId, pycachePrefix: env.PYTHONPYCACHEPREFIX };
}
