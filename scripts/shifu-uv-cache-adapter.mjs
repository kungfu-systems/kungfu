#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check
// Build a disposable uv project overlay whose lock is rebound to the selected
// package index. The canonical checkout and its project environment remain
// untouched; nested uv commands are routed through a child-only PATH wrapper.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANIFEST_SCHEMA = 'shifu.uv-cache-overlay/v1';
const PROJECT_COMMANDS = new Set(['run', 'sync', 'tree', 'export', 'lock']);
const MUTATING_COMMANDS = new Set(['add', 'remove', 'version']);
const TOP_LEVEL_COMMANDS = new Set([
  ...PROJECT_COMMANDS,
  ...MUTATING_COMMANDS,
  'auth',
  'build',
  'cache',
  'generate-shell-completion',
  'help',
  'init',
  'pip',
  'publish',
  'python',
  'self',
  'tool',
  'venv',
  'x',
]);

/** @typedef {{repoRoot: string, projectRoot: string, lock: string}} UvProject */
/** @typedef {{source: string, overlay: string, environment: string}} ManifestProject */
/** @typedef {{schema: string, realUv: string, projects: ManifestProject[]}} UvManifest */

export class UvCacheAdapterError extends Error {}

/** @param {string} message @returns {never} */
function fail(message) {
  throw new UvCacheAdapterError(message);
}

/** @param {string | Buffer} raw */
function digest(raw) {
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {Omit<import('node:child_process').SpawnSyncOptionsWithStringEncoding,
 *   'encoding'>} [options]
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail =
      `${result.stderr || result.stdout || result.error?.message || ''}`
        .trim()
        .split('\n')
        .slice(-8)
        .join('\n');
    fail(
      `${path.basename(command)} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`,
    );
  }
  return result;
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return run('git', args, { cwd }).stdout.trim();
}

/** @param {string} name */
function executableNames(name) {
  if (process.platform !== 'win32') return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
}

/** @param {string} name @param {string} [searchPath] */
export function findExecutable(name, searchPath = process.env.PATH || '') {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const candidateName of executableNames(name)) {
      const candidate = path.join(directory, candidateName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return '';
}

/** @param {string} raw */
function registrySourceUrls(raw) {
  return [...raw.matchAll(/source = \{ registry = "([^"]+)" \}/g)].map(
    (match) => match[1],
  );
}

/** @param {string} raw */
function registryArtifactUrls(raw) {
  return [...raw.matchAll(/(?:sdist = )?\{ url = "([^"]+)", hash = /g)].map(
    (match) => match[1],
  );
}

/** @param {string} raw */
function lockUrls(raw) {
  return [...raw.matchAll(/https?:\/\/[^"\s}]+/g)].map((match) => match[0]);
}

/** @param {string} raw */
export function normalizeUvLock(raw) {
  return raw
    .split(/(?<=\n)/)
    .map((line) => {
      if (/^source = \{ registry = "[^"]+" \}\s*$/.test(line.trimEnd())) {
        return line.replace(/registry = "[^"]+"/, 'registry = "<registry>"');
      }
      const artifact = line.match(
        /^(\s*)(sdist = )?\{ url = "[^"]+", hash = "([^"]+)"[^}]*\}(,?)(\r?\n)?$/,
      );
      if (!artifact) return line;
      return `${artifact[1]}${artifact[2] || ''}{ registry-artifact-hash = "${artifact[3]}" }${artifact[4]}${artifact[5] || ''}`;
    })
    .join('');
}

/** @param {string} raw */
export function uvLockSemanticDigest(raw) {
  return digest(Buffer.from(normalizeUvLock(raw)));
}

/** @param {string} hostname */
function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  )
    return true;
  if (/^10\./.test(host) || /^127\./.test(host) || /^192\.168\./.test(host))
    return true;
  const match = host.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

/** @param {string} raw */
export function publicUvLockViolations(raw) {
  const violations = [];
  for (const value of lockUrls(raw)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      violations.push(`invalid URL: ${value}`);
      continue;
    }
    const officialRegistry =
      url.protocol === 'https:' &&
      url.hostname === 'pypi.org' &&
      url.pathname.replace(/\/+$/, '') === '/simple';
    const officialArtifact =
      url.protocol === 'https:' && url.hostname === 'files.pythonhosted.org';
    if (!officialRegistry && !officialArtifact)
      violations.push(
        `URL is not an official PyPI transport: ${url.origin}${url.pathname}`,
      );
  }
  for (const value of registrySourceUrls(raw)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      violations.push(`invalid registry URL: ${value}`);
      continue;
    }
    if (isPrivateHostname(url.hostname))
      violations.push(`private registry host: ${url.hostname}`);
    const normalizedPath = url.pathname.replace(/\/+$/, '');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'pypi.org' ||
      normalizedPath !== '/simple'
    )
      violations.push(
        `registry is not official PyPI: ${url.origin}${url.pathname}`,
      );
  }
  for (const value of registryArtifactUrls(raw)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      violations.push(`invalid artifact URL: ${value}`);
      continue;
    }
    if (isPrivateHostname(url.hostname))
      violations.push(`private artifact host: ${url.hostname}`);
    if (url.protocol !== 'https:' || url.hostname !== 'files.pythonhosted.org')
      violations.push(
        `artifact is not official PyPI: ${url.origin}${url.pathname}`,
      );
  }
  return [...new Set(violations)];
}

/** @param {string} raw @param {string} endpoint */
function validateEffectiveLock(raw, endpoint) {
  const expected = new URL(endpoint).origin;
  const registries = registrySourceUrls(raw);
  const artifacts = registryArtifactUrls(raw);
  if (registries.length === 0)
    fail('effective uv.lock has no registry sources');
  for (const value of lockUrls(raw)) {
    let actual;
    try {
      actual = new URL(value).origin;
    } catch {
      fail('effective uv.lock contains an invalid registry artifact URL');
    }
    if (actual !== expected)
      fail(
        `effective uv.lock escaped the selected index origin: expected ${expected}, got ${actual}`,
      );
  }
  return { registries: registries.length, artifacts: artifacts.length };
}

/** @param {string} source @param {string} target */
function linkOrCopy(source, target) {
  const stat = fs.lstatSync(source);
  if (process.platform === 'win32') {
    if (stat.isDirectory()) {
      fs.symlinkSync(source, target, 'junction');
      return;
    }
    fs.copyFileSync(source, target);
    return;
  }
  fs.symlinkSync(source, target, stat.isDirectory() ? 'dir' : 'file');
}

/** @param {string} source @param {string} target @param {string} [reserved] */
function mirrorLevel(source, target, reserved = '') {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === reserved) continue;
    linkOrCopy(path.join(source, entry.name), path.join(target, entry.name));
  }
}

/** @param {string} repoRoot @param {string} projectRoot @param {string} overlayRepo */
function mirrorProject(repoRoot, projectRoot, overlayRepo) {
  const relative = path.relative(repoRoot, projectRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    fail('uv project escapes the repository root');
  const parts = relative ? relative.split(path.sep) : [];
  let source = repoRoot;
  let target = overlayRepo;
  for (const part of parts) {
    mirrorLevel(source, target, part);
    source = path.join(source, part);
    target = path.join(target, part);
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (['.git', '.venv', 'pyproject.toml', 'uv.lock'].includes(entry.name))
      continue;
    linkOrCopy(path.join(source, entry.name), path.join(target, entry.name));
  }
  for (const name of ['pyproject.toml', 'uv.lock'])
    fs.copyFileSync(path.join(source, name), path.join(target, name));
  return target;
}

/** @param {string} cwd @returns {UvProject[]} */
function trackedUvProjects(cwd) {
  let repoRoot;
  try {
    repoRoot = git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return [];
  }
  const listed = git(repoRoot, ['ls-files', '-z', '*uv.lock']);
  /** @type {UvProject[]} */
  const projects = [];
  for (const relativeLock of listed.split('\0').filter(Boolean)) {
    const lock = path.join(repoRoot, relativeLock);
    const projectRoot = path.dirname(lock);
    if (fs.existsSync(path.join(projectRoot, 'pyproject.toml')))
      projects.push({ repoRoot, projectRoot, lock });
  }
  return projects;
}

/** @param {string} moduleUrl */
function adapterLauncherSource(moduleUrl) {
  return `#!/usr/bin/env node
import { runUvCacheAdapter } from ${JSON.stringify(moduleUrl)};
try {
  process.exit(runUvCacheAdapter(process.argv.slice(2)));
} catch (error) {
  console.error(\`shifu cache: \${error instanceof Error ? error.message : String(error)}\`);
  process.exit(1);
}
`;
}

/** @param {string} root */
function writeWrapper(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  fs.writeFileSync(
    path.join(bin, 'uv-wrapper.mjs'),
    adapterLauncherSource(moduleUrl),
    {
      mode: 0o700,
    },
  );
  fs.writeFileSync(
    path.join(bin, 'uv'),
    '#!/bin/sh\nexec node "$(dirname "$0")/uv-wrapper.mjs" "$@"\n',
    {
      mode: 0o700,
    },
  );
  fs.writeFileSync(
    path.join(bin, 'uv.cmd'),
    '@node "%~dp0uv-wrapper.mjs" %*\r\n',
    { mode: 0o600 },
  );
  return bin;
}

/** @param {NodeJS.ProcessEnv} env */
function cleanUvEnvironment(env) {
  const result = { ...env };
  for (const key of [
    'UV_PROJECT',
    'UV_PROJECT_ENVIRONMENT',
    'UV_FROZEN',
    'UV_LOCKED',
    'UV_OFFLINE',
    'UV_INDEX',
    'UV_INDEX_URL',
    'UV_EXTRA_INDEX_URL',
    'UV_FIND_LINKS',
    'SHIFU_UV_ADAPTER_MANIFEST',
    'SHIFU_CACHE_MANAGED_UV',
  ])
    delete result[key];
  return result;
}

/**
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, endpoint?: string,
 *   timeoutMs?: number}} [options]
 */
export function prepareUvCacheOverlay({
  cwd = process.cwd(),
  env = process.env,
  endpoint,
  timeoutMs = 120_000,
} = {}) {
  if (!endpoint) fail('uv cache adapter requires a selected index endpoint');
  // A lifecycle can invoke Shifu again while already inside a cache
  // projection. Reusing PATH here would make the inner UV overlay discover
  // the outer wrapper as its "real" UV; carry forward the first unwrapped
  // PATH instead.
  const originalPath = env.SHIFU_UV_ORIGINAL_PATH || env.PATH || '';
  const realUv = findExecutable('uv', originalPath);
  if (!realUv) fail('strict Python cache profile requires uv on PATH');
  const projects = trackedUvProjects(cwd);
  if (projects.length === 0)
    return {
      env: {},
      root: '',
      evidence: {
        adapter: 'uv-effective-lock',
        enforcement: 'not-applicable',
        projectCount: 0,
        locks: [],
      },
      cleanup() {},
    };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-uv-overlay-'));
  fs.chmodSync(root, 0o700);
  const manifestProjects = [];
  const locks = [];
  try {
    for (const project of projects) {
      const canonical = fs.readFileSync(project.lock);
      const key = digest(Buffer.from(project.projectRoot)).slice(7, 23);
      const projectRoot = path.join(root, 'projects', key);
      const overlayRepo = path.join(projectRoot, 'repo');
      const overlayProject = mirrorProject(
        project.repoRoot,
        project.projectRoot,
        overlayRepo,
      );
      const effectiveLock = path.join(overlayProject, 'uv.lock');
      const lockEnv = cleanUvEnvironment(env);
      lockEnv.UV_DEFAULT_INDEX = endpoint;
      run(
        realUv,
        [
          'lock',
          '--refresh',
          '--default-index',
          endpoint,
          '--project',
          overlayProject,
        ],
        {
          cwd: project.projectRoot,
          env: lockEnv,
          timeout: timeoutMs,
        },
      );
      const effective = fs.readFileSync(effectiveLock);
      const canonicalSemantic = uvLockSemanticDigest(
        canonical.toString('utf8'),
      );
      const effectiveSemantic = uvLockSemanticDigest(
        effective.toString('utf8'),
      );
      if (canonicalSemantic !== effectiveSemantic)
        fail(
          `uv effective lock changed dependency semantics: canonical ${canonicalSemantic}, effective ${effectiveSemantic}`,
        );
      const rebound = validateEffectiveLock(
        effective.toString('utf8'),
        endpoint,
      );
      const environment = path.join(projectRoot, 'environment');
      manifestProjects.push({
        source: project.projectRoot,
        overlay: overlayProject,
        environment,
      });
      locks.push({
        canonicalDigest: digest(canonical),
        effectiveDigest: digest(effective),
        semanticDigest: canonicalSemantic,
        registryRebindings: rebound.registries,
        artifactRebindings: rebound.artifacts,
      });
    }
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schema: MANIFEST_SCHEMA,
          realUv,
          projects: manifestProjects,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const bin = writeWrapper(root);
    return {
      root,
      env: {
        PATH: `${bin}${path.delimiter}${originalPath}`,
        SHIFU_UV_ORIGINAL_PATH: originalPath,
        SHIFU_UV_ADAPTER_MANIFEST: manifestPath,
        SHIFU_CACHE_MANAGED_UV: '1',
      },
      evidence: {
        adapter: 'uv-effective-lock',
        enforcement: 'project-overlay',
        projectCount: locks.length,
        locks,
      },
      cleanup() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env */
function projectArgument(args, cwd, env) {
  const index = args.findIndex(
    (value) => value === '--project' || value.startsWith('--project='),
  );
  if (index >= 0) {
    const value = args[index].startsWith('--project=')
      ? args[index].slice('--project='.length)
      : args[index + 1];
    return value ? path.resolve(cwd, value) : '';
  }
  return env.UV_PROJECT ? path.resolve(cwd, env.UV_PROJECT) : '';
}

/** @param {string[]} args */
function withoutProjectArgument(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--project') {
      index += 1;
      continue;
    }
    if (args[index].startsWith('--project=')) continue;
    result.push(args[index]);
  }
  return result;
}

/**
 * @param {UvManifest} manifest @param {string[]} args
 * @param {string} cwd @param {NodeJS.ProcessEnv} env
 * @returns {ManifestProject | undefined}
 */
function selectedProject(manifest, args, cwd, env) {
  const explicit = projectArgument(args, cwd, env);
  if (explicit)
    return manifest.projects.find(
      (project) => path.resolve(project.source) === explicit,
    );
  const nested = manifest.projects
    .filter((project) => {
      const relative = path.relative(project.source, cwd);
      return (
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative))
      );
    })
    .sort((left, right) => right.source.length - left.source.length)[0];
  if (nested) return nested;
  return manifest.projects.length === 1 ? manifest.projects[0] : undefined;
}

/** @param {string[]} args */
function uvCommand(args) {
  return args.find((value) => TOP_LEVEL_COMMANDS.has(value));
}

/**
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string}} [options]
 */
export function runUvCacheAdapter(
  args,
  { env = process.env, cwd = process.cwd() } = {},
) {
  const manifestPath = env.SHIFU_UV_ADAPTER_MANIFEST || '';
  if (!manifestPath) fail('uv cache adapter manifest is missing');
  /** @type {UvManifest} */
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA)
    fail('unsupported uv adapter manifest');
  const command = uvCommand(args);
  if (command && MUTATING_COMMANDS.has(command))
    fail(`uv ${command} is not allowed inside a cache-managed build execution`);
  if (!command || !PROJECT_COMMANDS.has(command)) {
    const result = spawnSync(manifest.realUv, args, {
      cwd,
      env: cleanUvEnvironment(env),
      stdio: 'inherit',
      shell:
        process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(manifest.realUv),
    });
    if (result.error) fail(`cannot run uv: ${result.error.message}`);
    return result.status ?? 1;
  }
  const project = selectedProject(manifest, args, cwd, env);
  if (!project)
    fail(
      'strict cache profile cannot map this uv project to an effective lock',
    );
  const childEnv = cleanUvEnvironment(env);
  childEnv.UV_DEFAULT_INDEX = env.UV_DEFAULT_INDEX || '';
  childEnv.UV_PROJECT_ENVIRONMENT = project.environment;
  if (command !== 'lock') childEnv.UV_FROZEN = '1';
  const childArgs = [
    '--project',
    project.overlay,
    ...withoutProjectArgument(args),
  ];
  const result = spawnSync(manifest.realUv, childArgs, {
    cwd,
    env: childEnv,
    stdio: 'inherit',
    shell:
      process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(manifest.realUv),
  });
  if (result.error) fail(`cannot run uv: ${result.error.message}`);
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exit(runUvCacheAdapter(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `shifu cache: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
