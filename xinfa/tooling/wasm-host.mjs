#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

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
      'Xinfa WebAssembly engine is stale for the current xinfa/src tree',
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
  const stdinOptions = ['--inventory', '--project', '--task'];
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
    },
  };
}

/** @param {any[]} writes @param {string[]} args */
function publishWrites(writes, args) {
  if (!writes.length) return;
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
