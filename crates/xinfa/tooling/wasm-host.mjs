#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bytesHash, sourceTreeHash } from './engine-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** @type {Promise<WebAssembly.Instance> | undefined} */
let instancePromise;

function loadManifest(root = ROOT) {
  const enginePath = path.join(root, 'engine', 'xinfa.wasm');
  const manifestPath = path.join(root, 'engine', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'xinfa.engine-manifest/v1')
    throw new Error('Xinfa engine manifest schema is invalid');
  const engine = fs.readFileSync(enginePath);
  if (
    bytesHash(engine) !== manifest.wasm_sha256 ||
    engine.length !== manifest.size
  )
    throw new Error(
      'Xinfa WebAssembly engine hash or size does not match its manifest',
    );
  if (sourceTreeHash(root) !== manifest.source_tree_hash)
    throw new Error(
      'Xinfa WebAssembly engine is stale for the current crates/xinfa/src tree',
    );
  return { manifest, engine };
}

export function engineStatus(root = ROOT) {
  try {
    const { manifest } = loadManifest(root);
    return { usable: true, manifest };
  } catch (error) {
    return {
      usable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadInstance() {
  if (!instancePromise) {
    const { engine } = loadManifest();
    instancePromise = WebAssembly.instantiate(engine, {}).then(
      ({ instance }) => instance,
    );
  }
  return instancePromise;
}

/** @param {string} reference */
function exactFile(reference) {
  const absolute = path.resolve(reference);
  if (fs.lstatSync(absolute).isSymbolicLink())
    throw new Error(`Xinfa host refuses symlink input: ${reference}`);
  const stat = fs.statSync(absolute);
  if (!stat.isFile())
    throw new Error(`Xinfa host input is not a file: ${reference}`);
  return fs.readFileSync(absolute);
}

/** @param {string} reference */
function exactInputs(reference) {
  const absolute = path.resolve(reference);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink())
    throw new Error(`Xinfa host refuses symlink input: ${reference}`);
  if (stat.isFile())
    return [{ path: reference, bytes: [...exactFile(reference)] }];
  if (!stat.isDirectory())
    throw new Error(
      `Xinfa host input is not a file or directory: ${reference}`,
    );
  const rows = [];
  function visit(directory, relativeRoot) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) =>
        Buffer.from(left.name).compare(Buffer.from(right.name)),
      )) {
      const relative = relativeRoot
        ? `${relativeRoot}/${entry.name}`
        : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `Xinfa host refuses symlink input: ${reference}/${relative}`,
        );
      if (entry.isDirectory()) visit(child, relative);
      else if (entry.isFile())
        rows.push({
          path: `${reference}/${relative}`,
          bytes: [...fs.readFileSync(child)],
        });
      else
        throw new Error(
          `Xinfa host input has unsupported type: ${reference}/${relative}`,
        );
    }
  }
  visit(absolute, '');
  return rows;
}

/** @param {string} root @param {string} relative */
function exactRepositoryFile(root, relative) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative
      .split(/[\\/]/u)
      .some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Xinfa repository path must remain relative: ${relative}`);
  let current = path.resolve(root);
  const rootStat = fs.lstatSync(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error('Xinfa repository root must be a real directory');
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink())
      throw new Error(`Xinfa host refuses symlink source: ${relative}`);
  }
  if (!fs.statSync(current).isFile())
    throw new Error(`Xinfa repository source is not a file: ${relative}`);
  return fs.readFileSync(current);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function valueRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`${canonicalJson(value)}\n`)
    .digest('hex')}`;
}

function git(root, args, allowFailure = false) {
  const environment = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_WORK_TREE',
  ])
    delete environment[name];
  const result = spawnSync(
    'git',
    [
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-C',
      root,
      ...args,
    ],
    {
      encoding: null,
      env: {
        ...environment,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  );
  if (result.status === 0) return result.stdout || Buffer.alloc(0);
  if (allowFailure) return undefined;
  throw new Error(
    `read-only Git discovery failed: ${String(result.stderr || '').trim()}`,
  );
}

function gitText(root, args) {
  const bytes = git(root, args, true);
  return bytes === undefined ? null : bytes.toString('utf8').trim();
}

function nulStrings(bytes) {
  return bytes.toString('utf8').split('\0').filter(Boolean);
}

function hostMayRead(pathname, mode, stage, size) {
  if (stage !== 0 || !['100644', '100755'].includes(mode)) return false;
  if (size === null || size > 4 * 1024 * 1024) return false;
  const parts = pathname.split('/');
  if (
    parts.some(
      (part) =>
        part === '.git' ||
        part === '.private' ||
        part === '.env' ||
        part.startsWith('.env.') ||
        part.toLowerCase() === 'secrets' ||
        part.toLowerCase() === 'credentials.json' ||
        part.toLowerCase() === 'id_rsa' ||
        part.toLowerCase() === 'id_ed25519',
    )
  )
    return false;
  if (pathname === '.xinfa' || pathname.startsWith('.xinfa/')) return false;
  if (
    parts.some((part) =>
      [
        'node_modules',
        'target',
        'dist',
        'build',
        'vendor',
        '.venv',
        '__pycache__',
      ].includes(part),
    )
  )
    return false;
  return true;
}

function repositorySnapshot(reference) {
  const root = fs.realpathSync(path.resolve(reference));
  const prefix = gitText(root, ['rev-parse', '--show-prefix']);
  if (prefix === null || prefix !== '')
    throw new Error(
      'repository discovery --root must be the exact Git worktree root',
    );
  const tracked = nulStrings(git(root, ['ls-files', '--stage', '-z']));
  const entries = [];
  const indexPreimage = [];
  const repository = [];
  for (const row of tracked) {
    const separator = row.indexOf('\t');
    if (separator < 0) throw new Error('unexpected git ls-files --stage row');
    const [mode, object, stageText] = row.slice(0, separator).split(' ');
    const pathname = row.slice(separator + 1);
    const stage = Number(stageText);
    let size = null;
    try {
      const stat = fs.lstatSync(path.join(root, pathname));
      if (stat.isFile()) size = stat.size;
    } catch {
      size = null;
    }
    const entry = {
      path: pathname,
      state: 'tracked',
      mode,
      object,
      stage,
      size,
    };
    entries.push(entry);
    indexPreimage.push(entry);
    if (hostMayRead(pathname, mode, stage, size))
      repository.push({
        path: pathname,
        bytes: [...exactRepositoryFile(root, pathname)],
      });
  }
  indexPreimage.sort(
    (left, right) =>
      Buffer.from(left.path).compare(Buffer.from(right.path)) ||
      left.stage - right.stage,
  );
  const untracked = git(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  const ignored = git(root, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
  ]);
  entries.push(
    ...nulStrings(untracked).map((pathname) => ({
      path: pathname,
      state: 'untracked',
    })),
    ...nulStrings(ignored).map((pathname) => ({
      path: pathname,
      state: 'ignored',
    })),
  );
  const trackedDirty = git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=no',
  ]);
  return {
    snapshot: {
      schema: 'xinfa.repository-snapshot/v1',
      repository: {
        head: gitText(root, ['rev-parse', '--verify', 'HEAD']),
        tree: gitText(root, ['rev-parse', '--verify', 'HEAD^{tree}']),
        indexRoot: valueRoot(indexPreimage),
        dirty: trackedDirty.length > 0 || untracked.length > 0,
      },
      entries,
    },
    repository,
  };
}

/** @param {string[]} args @param {string} option */
function option(args, option) {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

/** @param {string} projectReference @param {string[]} args @param {Buffer | undefined} projectBytes */
function repositoryFiles(projectReference, args, projectBytes) {
  const project = JSON.parse(
    (projectBytes || exactFile(projectReference)).toString('utf8'),
  );
  const root = path.resolve(
    option(args, '--root') || path.dirname(path.resolve(projectReference)),
  );
  const paths = [
    ...new Set(
      (project.providers || []).flatMap((provider) => provider.paths || []),
    ),
  ];
  if (args[0] === 'episode' && args[1] === 'compile') {
    const submission = option(args, '--submission');
    if (!submission)
      throw new Error('Xinfa Episode host requires --submission');
    paths.push(submission);
    const value = JSON.parse(
      exactRepositoryFile(root, submission).toString('utf8'),
    );
    for (const episode of value.episodes || []) {
      for (const name of ['manifestPath', 'claimsPath', 'qualificationPath']) {
        if (typeof episode[name] === 'string') paths.push(episode[name]);
      }
    }
  }
  const unique = [...new Set(paths)].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  return unique.map((relative) => ({
    path: relative,
    bytes: [...exactRepositoryFile(root, relative)],
  }));
}

/** @param {string[]} args */
function requestFor(args) {
  /** @type {{path: string, bytes: number[]}[]} */
  const inputs = [];
  /** @type {{path: string, bytes: number[]}[]} */
  let repository = [];
  /** @type {Buffer | undefined} */
  let stdin;
  const references = new Set();
  for (const name of [
    '--inventory',
    '--request',
    '--candidate',
    '--selection',
    '--project',
    '--pack',
    '--atlas',
    '--before',
    '--after',
    '--since',
    '--chart',
    '--view',
  ]) {
    const reference = option(args, name);
    if (reference && reference !== '-') references.add(reference);
  }
  if (args[0] === 'route' && args[1] === 'resolve') {
    const task = option(args, '--task');
    if (task && task !== '-') references.add(task);
  }
  for (const reference of references) inputs.push(...exactInputs(reference));
  const stdinOptions = [
    '--inventory',
    '--request',
    '--candidate',
    '--project',
    '--task',
  ];
  if (stdinOptions.some((name) => option(args, name) === '-')) {
    stdin = fs.readFileSync(0);
    inputs.push({ path: '-', bytes: [...stdin] });
  }
  const project = option(args, '--project');
  const needsRepository =
    (args[0] === 'compile' && args.includes('--output')) ||
    args[0] === 'impact' ||
    (args[0] === 'atlas' && ['compile', 'impact'].includes(args[1])) ||
    (args[0] === 'episode' && args[1] === 'compile');
  if (project && needsRepository)
    repository = repositoryFiles(
      project,
      args,
      project === '-' ? stdin : undefined,
    );
  let repositorySnapshotValue;
  if (args[0] === 'project' && ['discover', 'accept'].includes(args[1])) {
    const root = option(args, '--root');
    if (!root) throw new Error(`xinfa project ${args[1]} requires --root`);
    const discovered = repositorySnapshot(root);
    repositorySnapshotValue = discovered.snapshot;
    repository = discovered.repository;
    if (args[1] === 'accept') {
      const existing = path.join(path.resolve(root), '.xinfa', 'project.json');
      if (fs.existsSync(existing))
        inputs.push({
          path: '.xinfa/project.json',
          bytes: [...exactFile(existing)],
        });
    }
  }
  return {
    schema: 'xinfa.engine-request/v1',
    arguments: args,
    inputs,
    repository,
    host: {
      cwd: process.cwd(),
      state_home:
        process.env.XINFA_STATE_HOME || path.join(process.cwd(), '.xinfa'),
      state_source: process.env.XINFA_STATE_HOME ? 'environment' : 'workspace',
      cache_home:
        process.env.XINFA_CACHE_HOME ||
        path.join(
          process.env.XINFA_STATE_HOME || path.join(process.cwd(), '.xinfa'),
          'cache',
        ),
      cache_source: process.env.XINFA_CACHE_HOME ? 'environment' : 'workspace',
      repository_snapshot: repositorySnapshotValue,
    },
  };
}

/** @param {any[]} writes @param {string[]} args */
function publishWrites(writes, args) {
  if (!writes.length) return;
  if (args[0] === 'project' && args[1] === 'accept') {
    if (
      writes.length !== 1 ||
      writes[0]?.path !== '.xinfa/project.json' ||
      !Array.isArray(writes[0]?.bytes)
    )
      throw new Error('Xinfa accept returned an invalid control-plane write');
    const root = path.resolve(option(args, '--root'));
    const directory = path.join(root, '.xinfa');
    let createdDirectory = false;
    if (fs.existsSync(directory)) {
      const metadata = fs.lstatSync(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory())
        throw new Error('.xinfa must be a real directory');
    } else {
      fs.mkdirSync(directory);
      createdDirectory = true;
    }
    const target = path.join(directory, 'project.json');
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
      throw new Error('.xinfa/project.json must not be a symlink');
    const temporary = path.join(
      directory,
      `.project.json.xinfa-${process.pid}`,
    );
    try {
      fs.writeFileSync(temporary, Buffer.from(writes[0].bytes), { flag: 'wx' });
      const descriptor = fs.openSync(temporary, 'r+');
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      if (createdDirectory) fs.rmdirSync(directory);
      throw error;
    }
  }
  const outputReference = option(args, '--output');
  if (!outputReference)
    throw new Error(
      'Xinfa engine returned writes without an --output directory',
    );
  const output = path.resolve(outputReference);
  if (fs.existsSync(outputReference))
    throw new Error(`output path already exists: ${outputReference}`);
  const parent = path.dirname(output);
  const temporary = fs.mkdtempSync(
    path.join(parent, `.${path.basename(output)}.xinfa-wasm-`),
  );
  try {
    for (const item of writes) {
      if (!item || typeof item.path !== 'string' || !Array.isArray(item.bytes))
        throw new Error('Xinfa engine returned an invalid write entry');
      const targetReference = path.resolve(item.path);
      const relative = path.relative(output, targetReference);
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error(`Xinfa engine write escapes --output: ${item.path}`);
      const target = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(item.bytes));
    }
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

/** @param {string[]} args */
export async function run(args) {
  const instance = await loadInstance();
  const exports = /** @type {any} */ (instance.exports);
  const request = Buffer.from(JSON.stringify(requestFor(args)));
  const requestPointer = exports.xinfa_alloc(request.length);
  try {
    new Uint8Array(exports.memory.buffer, requestPointer, request.length).set(
      request,
    );
    const packed = /** @type {bigint} */ (
      exports.xinfa_call(requestPointer, request.length)
    );
    const responsePointer = Number(packed >> 32n);
    const responseLength = Number(packed & 0xffff_ffffn);
    try {
      const response = JSON.parse(
        Buffer.from(
          new Uint8Array(
            exports.memory.buffer,
            responsePointer,
            responseLength,
          ),
        ).toString('utf8'),
      );
      if (response.schema !== 'xinfa.engine-response/v1')
        throw new Error('Xinfa WebAssembly engine response schema is invalid');
      publishWrites(response.writes || [], args);
      return response;
    } finally {
      exports.xinfa_free(responsePointer, responseLength);
    }
  } finally {
    exports.xinfa_free(requestPointer, request.length);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length === 2 &&
      args[0] === '--engine-status' &&
      args[1] === '--json'
    ) {
      const status = engineStatus();
      process.stdout.write(`${JSON.stringify(status)}\n`);
      process.exitCode = status.usable ? 0 : 1;
      process.exit();
    }
    const response = await run(args);
    if (response.stdout) process.stdout.write(response.stdout);
    if (response.stderr) process.stderr.write(response.stderr);
    process.exitCode = response.status;
  } catch (error) {
    process.stderr.write(
      `xinfa-wasm-host: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
