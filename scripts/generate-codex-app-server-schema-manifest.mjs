#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST_SCHEMA = 'kungfu.codex-app-server.schema-manifest/v1';
const BUNDLE_ALGORITHM =
  'sha256-path-nul-canonical-json-size-nul-canonical-json-sha256-lf/v1';
const PROTOCOL_UNIONS = {
  clientRequests: 'ClientRequest.json',
  clientNotifications: 'ClientNotification.json',
  serverRequests: 'ServerRequest.json',
  serverNotifications: 'ServerNotification.json',
};

function usage() {
  return [
    'Usage:',
    '  generate-codex-app-server-schema-manifest.mjs',
    '    --schema-dir <generated stable schema directory>',
    '    --cli-version <exact Codex CLI version>',
    '    [--out <manifest path>]',
  ].join('\n');
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(usage());
    }
    values.set(flag, value);
  }
  const schemaDir = values.get('--schema-dir');
  const cliVersion = values.get('--cli-version');
  if (!schemaDir || !cliVersion) throw new Error(usage());
  return { schemaDir, cliVersion, out: values.get('--out') ?? null };
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort(compareUtf8)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

function collectJsonFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(root, absolute));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  return files.sort(compareUtf8);
}

function methodInventory(root, relativePath) {
  const value = JSON.parse(
    fs.readFileSync(path.join(root, relativePath), 'utf8'),
  );
  if (!Array.isArray(value.oneOf)) {
    throw new Error(`${relativePath} does not expose a oneOf protocol union`);
  }
  const methods = value.oneOf.map((entry) => {
    const method = entry?.properties?.method?.enum?.[0];
    if (typeof method !== 'string' || method.length === 0) {
      throw new Error(
        `${relativePath} contains a protocol entry without one exact method`,
      );
    }
    return method;
  });
  if (new Set(methods).size !== methods.length) {
    throw new Error(`${relativePath} contains duplicate protocol methods`);
  }
  return methods.sort(compareUtf8);
}

export function buildCodexAppServerSchemaManifest({ schemaDir, cliVersion }) {
  const root = path.resolve(schemaDir);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`schema directory is not a directory: ${root}`);
  }
  const files = collectJsonFiles(root).map((relativePath) => {
    const value = JSON.parse(
      fs.readFileSync(path.join(root, relativePath), 'utf8'),
    );
    const canonicalBytes = Buffer.from(canonicalJson(value), 'utf8');
    return {
      path: relativePath,
      canonicalBytes: canonicalBytes.length,
      sha256: sha256(canonicalBytes),
    };
  });
  const bundlePreimage = files
    .map((file) => `${file.path}\0${file.canonicalBytes}\0${file.sha256}\n`)
    .join('');
  return {
    schema: MANIFEST_SCHEMA,
    provider: 'codex',
    surface: 'app-server-stdio-jsonl',
    stability: 'stable-schema-only',
    cliVersion,
    generator: {
      command: 'codex app-server generate-json-schema --out <DIR>',
      experimental: false,
      credentialRequired: false,
    },
    bundle: {
      algorithm: BUNDLE_ALGORITHM,
      ordering: 'ascending-utf8-path-bytes',
      canonicalization:
        'recursive-object-keys-in-ascending-utf8-order; arrays-preserved; json-primitives',
      preimage:
        '<path>\\0<decimal-canonical-json-bytes>\\0<lowercase-canonical-json-sha256>\\n',
      fileCount: files.length,
      sha256: sha256(Buffer.from(bundlePreimage, 'utf8')),
      files,
    },
    protocolInventory: Object.fromEntries(
      Object.entries(PROTOCOL_UNIONS).map(([name, relativePath]) => {
        const methods = methodInventory(root, relativePath);
        return [
          name,
          { schemaFile: relativePath, count: methods.length, methods },
        ];
      }),
    ),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = buildCodexAppServerSchemaManifest(options);
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.out) {
    fs.writeFileSync(path.resolve(options.out), output, { encoding: 'utf8' });
    process.stdout.write(
      `[codex-app-server-schema] files=${manifest.bundle.fileCount} sha256=${manifest.bundle.sha256} out=${options.out}\n`,
    );
  } else {
    process.stdout.write(output);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
