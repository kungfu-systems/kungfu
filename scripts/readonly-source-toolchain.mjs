// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// A bounded YAML 1.2 reader for committed GitHub workflow contracts. It covers
// mappings, sequences, quoted/plain scalars, flow collections, and literal or
// folded blocks. Anchors, aliases, tags, directives, and duplicate keys fail
// closed. Keeping this reader in source removes a node_modules/network
// prerequisite from build-free source acceptance.

function indentation(line) {
  const match = line.match(/^ */u);
  return match ? match[0].length : 0;
}

function stripComment(value) {
  let single = false;
  let double = false;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single && value[index - 1] !== '\\')
      double = !double;
    else if (!single && !double) {
      if (character === '[') square += 1;
      else if (character === ']') square -= 1;
      else if (character === '{') curly += 1;
      else if (character === '}') curly -= 1;
      else if (
        character === '#' &&
        square === 0 &&
        curly === 0 &&
        (index === 0 || /\s/u.test(value[index - 1]))
      )
        return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function splitTopLevel(value, separator = ',') {
  const values = [];
  let start = 0;
  let single = false;
  let double = false;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single && value[index - 1] !== '\\')
      double = !double;
    else if (!single && !double) {
      if (character === '[') square += 1;
      else if (character === ']') square -= 1;
      else if (character === '{') curly += 1;
      else if (character === '}') curly -= 1;
      else if (character === separator && square === 0 && curly === 0) {
        values.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  values.push(value.slice(start).trim());
  return values;
}

function mappingSeparator(value) {
  let single = false;
  let double = false;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single && value[index - 1] !== '\\')
      double = !double;
    else if (!single && !double) {
      if (character === '[') square += 1;
      else if (character === ']') square -= 1;
      else if (character === '{') curly += 1;
      else if (character === '}') curly -= 1;
      else if (
        character === ':' &&
        square === 0 &&
        curly === 0 &&
        (index + 1 === value.length || /\s/u.test(value[index + 1]))
      )
        return index;
    }
  }
  return -1;
}

function scalar(value) {
  const trimmed = stripComment(value).trim();
  if (!trimmed) return null;
  if (/^[&*!]|^<<:/u.test(trimmed))
    throw new Error(`unsupported YAML authority feature: ${trimmed}`);
  if (trimmed.startsWith('"') && trimmed.endsWith('"'))
    return JSON.parse(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  if (trimmed.startsWith('[') && trimmed.endsWith(']'))
    return splitTopLevel(trimmed.slice(1, -1)).filter(Boolean).map(scalar);
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const result = {};
    for (const item of splitTopLevel(trimmed.slice(1, -1)).filter(Boolean)) {
      const separator = mappingSeparator(item);
      if (separator < 0) throw new Error(`invalid YAML flow mapping: ${item}`);
      const key = String(scalar(item.slice(0, separator)));
      if (Object.hasOwn(result, key))
        throw new Error(`duplicate YAML key: ${key}`);
      result[key] = scalar(item.slice(separator + 1));
    }
    return result;
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function key(value) {
  const parsed = scalar(value);
  if (typeof parsed !== 'string' && typeof parsed !== 'number')
    throw new Error(`invalid YAML mapping key: ${value}`);
  return String(parsed);
}

function normalizedLines(text) {
  if (text.includes('\t')) throw new Error('YAML tabs are not supported');
  return text
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .map((raw, line) => ({
      raw,
      line: line + 1,
      indent: indentation(raw),
      content: stripComment(raw.trimStart()),
    }));
}

function nextContent(lines, startIndex) {
  let index = startIndex;
  while (
    index < lines.length &&
    (!lines[index].content.trim() || lines[index].content.trim() === '---')
  )
    index += 1;
  return index;
}

function parseYaml(text) {
  const lines = normalizedLines(text);

  function block(startIndex, indent) {
    let index = nextContent(lines, startIndex);
    if (index >= lines.length) return { value: null, index };
    if (lines[index].indent < indent) return { value: null, index };
    const sequence = lines[index].content.startsWith('- ');
    const value = sequence ? [] : {};
    while (index < lines.length) {
      index = nextContent(lines, index);
      if (index >= lines.length || lines[index].indent < indent) break;
      const row = lines[index];
      if (row.indent !== indent)
        throw new Error(`unexpected YAML indentation at line ${row.line}`);
      if (sequence !== row.content.startsWith('- '))
        throw new Error(`mixed YAML collection at line ${row.line}`);
      if (sequence) {
        const rest = row.content.slice(2).trim();
        if (!rest) {
          const child = block(index + 1, indent + 2);
          value.push(child.value);
          index = child.index;
          continue;
        }
        const separator = mappingSeparator(rest);
        if (separator < 0) {
          value.push(scalar(rest));
          index += 1;
          continue;
        }
        const item = {};
        const firstKey = key(rest.slice(0, separator));
        const firstRest = rest.slice(separator + 1).trim();
        if (firstRest) item[firstKey] = scalar(firstRest);
        else {
          const child = block(index + 1, indent + 4);
          item[firstKey] = child.value;
          index = child.index;
        }
        if (index === row.line - 1) index += 1;
        const continuation = nextContent(lines, index);
        if (
          continuation < lines.length &&
          lines[continuation].indent === indent + 2 &&
          !lines[continuation].content.startsWith('- ')
        ) {
          const tail = block(continuation, indent + 2);
          Object.assign(item, tail.value);
          index = tail.index;
        } else index = continuation;
        value.push(item);
        continue;
      }
      const separator = mappingSeparator(row.content);
      if (separator < 0)
        throw new Error(`invalid YAML mapping at line ${row.line}`);
      const name = key(row.content.slice(0, separator));
      if (Object.hasOwn(value, name))
        throw new Error(`duplicate YAML key '${name}' at line ${row.line}`);
      const rest = row.content.slice(separator + 1).trim();
      if (/^[>|][-+]?$/u.test(rest)) {
        const blockRows = [];
        let cursor = index + 1;
        while (
          cursor < lines.length &&
          (!lines[cursor].raw.trim() || lines[cursor].indent > indent)
        ) {
          blockRows.push(lines[cursor]);
          cursor += 1;
        }
        const blockIndent = Math.min(
          ...blockRows
            .filter((item) => item.raw.trim())
            .map((item) => item.indent),
        );
        const chunks = blockRows.map((item) =>
          item.raw.trim() ? item.raw.slice(blockIndent) : '',
        );
        const folded = rest.startsWith('>');
        let blockValue = '';
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          blockValue += chunks[chunkIndex];
          if (chunkIndex + 1 >= chunks.length) continue;
          const current = blockRows[chunkIndex];
          const next = blockRows[chunkIndex + 1];
          blockValue +=
            folded &&
            chunks[chunkIndex] &&
            chunks[chunkIndex + 1] &&
            current.indent === blockIndent &&
            next.indent === blockIndent
              ? ' '
              : '\n';
        }
        blockValue = blockValue.replace(/\n+$/u, '');
        if (!rest.endsWith('-')) blockValue += '\n';
        value[name] = blockValue;
        index = cursor;
      } else if (rest) {
        value[name] = scalar(rest);
        index += 1;
      } else {
        const childIndex = nextContent(lines, index + 1);
        if (childIndex >= lines.length || lines[childIndex].indent <= indent) {
          value[name] = null;
          index = childIndex;
        } else if (/^[{[]/u.test(lines[childIndex].content.trim())) {
          value[name] = scalar(lines[childIndex].content);
          index = childIndex + 1;
        } else {
          const child = block(childIndex, lines[childIndex].indent);
          value[name] = child.value;
          index = child.index;
        }
      }
    }
    return { value, index };
  }

  return block(0, 0).value;
}

export function parse(text) {
  return parseYaml(text);
}

export function parseDocument(text) {
  const errors = [];
  let value = null;
  try {
    value = parseYaml(text);
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
  return {
    errors,
    toJS() {
      return value;
    },
  };
}

const require = createRequire(import.meta.url);
let cachedAjv;

export function optionalAjv2020() {
  if (process.env.KUNGFU_READONLY_NO_AJV === '1') return null;
  if (cachedAjv !== undefined) return cachedAjv;
  try {
    const loaded = require('ajv/dist/2020.js');
    cachedAjv = loaded.default || loaded;
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') cachedAjv = null;
    else throw error;
  }
  return cachedAjv;
}

export const SOURCE_ACCEPTANCE_RUNTIME_OWNER = 'source-acceptance-runtime';
export const SOURCE_ACCEPTANCE_RECOVERY =
  'move disposable writes to the declared OS runtime root; run legitimate materialization in an isolated worktree and exclude it from ./shifu check:source';

function digestRows(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) hash.update(row).update('\0');
  return `sha256:${hash.digest('hex')}`;
}

function gitNull(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`,
    );
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function resolveThroughExistingAncestor(target) {
  let cursor = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(fs.realpathSync(cursor), ...suffix);
}

export function assertExternalSourceAcceptanceTarget(
  checkoutRoot,
  target,
  label = 'write target',
) {
  const canonicalCheckout = fs.realpathSync(checkoutRoot);
  const canonicalTarget = resolveThroughExistingAncestor(target);
  if (pathInside(canonicalCheckout, canonicalTarget))
    throw new Error(
      `${label} is inside the protected checkout; owner=${SOURCE_ACCEPTANCE_RUNTIME_OWNER}; recovery=${SOURCE_ACCEPTANCE_RECOVERY}`,
    );
  return canonicalTarget;
}

export function sourceCheckoutSnapshot(root) {
  const rows = (kind, paths) =>
    paths.sort().map((relative) => {
      const absolute = path.join(root, relative);
      if (!fs.existsSync(absolute)) return `${kind}:missing:${relative}`;
      const stat = fs.lstatSync(absolute);
      const bytes = stat.isSymbolicLink()
        ? Buffer.from(fs.readlinkSync(absolute))
        : fs.readFileSync(absolute);
      return `${kind}:${stat.isSymbolicLink() ? 'link' : 'file'}:${relative}:${crypto
        .createHash('sha256')
        .update(bytes)
        .digest('hex')}`;
    });
  const tracked = gitNull(root, ['ls-files', '-z']);
  const untracked = gitNull(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  return {
    trackedTreeRoot: digestRows(rows('tracked', tracked)),
    untrackedInventoryRoot: digestRows(rows('untracked', untracked)),
    trackedCount: tracked.length,
    untrackedCount: untracked.length,
  };
}

export function assertSourceCheckoutUnchanged(before, after) {
  for (const key of ['trackedTreeRoot', 'untrackedInventoryRoot'])
    if (before[key] !== after[key])
      throw new Error(
        `protected checkout ${key} changed during source acceptance; owner=${SOURCE_ACCEPTANCE_RUNTIME_OWNER}; recovery=${SOURCE_ACCEPTANCE_RECOVERY}`,
      );
}

export function prepareSourceAcceptanceRuntime(
  checkoutRoot,
  baseEnv = process.env,
) {
  // tsx opens an IPC socket below TMPDIR. Darwin's Unix-domain socket path is
  // short enough that the normal per-user os.tmpdir() prefix can overflow it,
  // so POSIX source acceptance owns a deliberately short OS runtime root.
  // Windows has no Unix socket path limit and retains its runner/system temp.
  const runtimeParent =
    process.platform === 'win32' ? baseEnv.RUNNER_TEMP || os.tmpdir() : '/tmp';
  const osTemp = assertExternalSourceAcceptanceTarget(
    checkoutRoot,
    runtimeParent,
    'OS temporary root',
  );
  const runtimeRoot = fs.mkdtempSync(path.join(osTemp, 'kf-sa-'));
  const directories = Object.fromEntries(
    [
      'tmp',
      'cache',
      'state',
      'corepack',
      'pnpm-home',
      'npm-cache',
      'uv-cache',
      'ruff-cache',
      'mypy-cache',
      'diagnostics',
    ].map((name) => [name, path.join(runtimeRoot, name)]),
  );
  for (const directory of Object.values(directories))
    fs.mkdirSync(directory, { recursive: true });
  return {
    owner: SOURCE_ACCEPTANCE_RUNTIME_OWNER,
    recovery: SOURCE_ACCEPTANCE_RECOVERY,
    runtimeRoot,
    env: {
      ...baseEnv,
      TMPDIR: directories.tmp,
      TMP: directories.tmp,
      TEMP: directories.tmp,
      XDG_CACHE_HOME: directories.cache,
      XDG_STATE_HOME: directories.state,
      COREPACK_HOME: directories.corepack,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      PNPM_HOME: directories['pnpm-home'],
      npm_config_cache: directories['npm-cache'],
      NPM_CONFIG_CACHE: directories['npm-cache'],
      UV_CACHE_DIR: directories['uv-cache'],
      RUFF_CACHE_DIR: directories['ruff-cache'],
      MYPY_CACHE_DIR: directories['mypy-cache'],
      SHIFU_CACHE_RECEIPT: path.join(
        directories.diagnostics,
        'shifu-cache-resolution.json',
      ),
      KUNGFU_SOURCE_ACCEPTANCE_RUNTIME_ROOT: runtimeRoot,
    },
    cleanup() {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    },
  };
}
