#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELECTOR = '.xinfa/product-documentation-pack.json';
const OUTPUT = '.xinfa/product-atlas-bundle.json';
const CLASSIFICATION_BUNDLE = '.xinfa/portable-atlas-classification.json.gz';
const WITNESS = '.buildchain/kfd/kfd-1/documentation-pack.witness.json';
const CONTENT_ADDRESSED_EVIDENCE_COLLECTIONS = [
  {
    prefix: 'framework/site/src/kfx-site-impact-proofs/',
    path: 'framework/site/src/kfx-site-impact-proofs/',
  },
];
const PORTABLE_GZIP_OPTIONS = {
  level: 9,
  strategy: zlib.constants.Z_HUFFMAN_ONLY,
};
const NATIVE_EMBEDDED = [
  'crates/shifu/agent/brief.md',
  'crates/shifu/agent/capabilities.json',
  'crates/shifu/agent/intent-map.json',
  'crates/shifu/agent/kfd3_api.registry.json',
  'docs/shifu/source-contract.json',
  'docs/shifu/schema/source-plan-v1.schema.json',
  'docs/shifu/schema/source-receipt-v1.schema.json',
  'docs/shifu/schema/portable-atlas-bundle-v1.schema.json',
  '.xinfa/product-atlas-bundle.json',
  '.xinfa/portable-atlas-classification.json.gz',
];
const LIMITS = {
  compressedBytes: 4 * 1024 * 1024,
  uncompressedBytes: 12 * 1024 * 1024,
  installerRatio: 0.08,
  maximumFileBytes: 6 * 1024 * 1024,
  duplicateBytes: 768 * 1024,
  routeBytes: 6 * 1024 * 1024,
  priorReleaseDeltaBytes: 2 * 1024 * 1024,
};

/** @param {unknown} value */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

/** @param {unknown} value */
function bytes(value) {
  return Buffer.from(`${JSON.stringify(stable(value))}\n`);
}

/** @param {Buffer|string} value */
function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

/** @param {string} relative */
function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

/** @param {string} relative */
function gzJson(relative) {
  return JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(ROOT, `${relative}.gz`))),
  );
}

function trackedFiles() {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
}

/** @param {string[]} files */
export function portableClassificationPaths(files) {
  const paths = files.filter(
    (relative) =>
      !CONTENT_ADDRESSED_EVIDENCE_COLLECTIONS.some(({ prefix }) =>
        relative.startsWith(prefix),
      ),
  );
  paths.push(
    ...CONTENT_ADDRESSED_EVIDENCE_COLLECTIONS.map(
      ({ path: relative }) => relative,
    ),
  );
  return [...new Set(paths)].sort();
}

/** @param {string[]} files @param {string[]} classifiedPaths */
function classificationCovers(files, classifiedPaths) {
  const filesSet = new Set(files);
  const classifiedSet = new Set(classifiedPaths);
  return (
    files.every(
      (relative) =>
        classifiedSet.has(relative) ||
        CONTENT_ADDRESSED_EVIDENCE_COLLECTIONS.some(({ prefix }) =>
          relative.startsWith(prefix),
        ),
    ) &&
    classifiedPaths.every(
      (relative) =>
        filesSet.has(relative) ||
        CONTENT_ADDRESSED_EVIDENCE_COLLECTIONS.some(
          ({ path: collectionPath }) => relative === collectionPath,
        ),
    )
  );
}

/** @param {string} relative @param {Set<string>} embedded */
function classify(relative, embedded) {
  if (
    CONTENT_ADDRESSED_EVIDENCE_COLLECTIONS.some(
      ({ path: collectionPath }) => relative === collectionPath,
    )
  )
    return {
      class: 'excluded',
      owner: 'product-security-and-release',
      reason:
        'content-addressed control evidence represented as a stable collection',
    };
  if (embedded.has(relative) || NATIVE_EMBEDDED.includes(relative))
    return {
      class: 'embedded',
      owner: 'documentation-control',
      reason: 'closed by the public Xinfa Documentation Atlas',
    };
  if (
    relative.startsWith('.buildchain/') ||
    relative.startsWith('.github/') ||
    relative.startsWith('.xinfa/baselines/') ||
    relative.startsWith('.xinfa/material-bundles/') ||
    relative.includes('/fixtures/') ||
    relative.startsWith('tests/') ||
    /(^|\/)(?:pnpm-lock\.yaml|Cargo\.lock|uv\.lock)$/.test(relative) ||
    /\.(?:png|jpe?g|gif|ico|icns|pdf|gz|zip|tar|wasm|bfbs|bin)$/i.test(relative)
  )
    return {
      class: 'excluded',
      owner: 'product-security-and-release',
      reason:
        'evidence, fixture, generated, duplicate, binary, or build-only material',
    };
  if (
    relative.startsWith('developer/') ||
    relative.startsWith('framework/spec/') ||
    relative.startsWith('crates/kungfu-sdk/')
  )
    return {
      class: 'developer-pack',
      owner: 'sdk-and-kfx',
      reason:
        'deep development surface available through an explicit Developer Pack',
    };
  return {
    class: 'checkout-required',
    owner: 'source-owner',
    reason:
      'implementation or repository control surface; acquire an exact source cut',
  };
}

/** @param {string} bundleRoot */
function previousMetrics(bundleRoot) {
  const roots = fs
    .readdirSync(path.join(ROOT, '.xinfa', 'material-bundles', 'sha256'))
    .filter((value) => `sha256:${value}` !== bundleRoot)
    .sort();
  const previous = roots.at(-1);
  if (!previous) return null;
  const base = path.join(
    ROOT,
    '.xinfa',
    'material-bundles',
    'sha256',
    previous,
  );
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  for (const relative of walk(base)) {
    const value = fs.readFileSync(path.join(base, relative));
    compressedBytes += value.length;
    uncompressedBytes += zlib.gunzipSync(value).length;
  }
  return {
    bundleRoot: `sha256:${previous}`,
    compressedBytes,
    uncompressedBytes,
  };
}

/** @param {string} directory */
function walk(directory) {
  /** @type {string[]} */
  const values = [];
  /** @param {string} current */
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else
        values.push(path.relative(directory, full).split(path.sep).join('/'));
    }
  }
  visit(directory);
  return values.sort();
}

/** @param {{installerBytes?:number, releasePassportRoot?:string}} [options] */
export function compilePortableBundle(options = {}) {
  const selector = readJson(SELECTOR);
  const sourceCommit = String(selector.materialSource?.originCommit || '');
  const sourceTree = String(selector.materialSource?.originTree || '');
  if (
    !/^[0-9a-f]{40}$/.test(sourceCommit) ||
    !/^[0-9a-f]{40}$/.test(sourceTree)
  ) {
    throw new Error(
      'portable Documentation Atlas selector requires exact origin commit and tree',
    );
  }
  const atlasDigest = selector.atlasRoot.slice('sha256:'.length);
  const materialBase = `.xinfa/material-bundles/sha256/${atlasDigest}`;
  const atlas = gzJson(`${materialBase}/atlas.json`);
  const pack = gzJson(
    `${materialBase}/compatibility/context-pack-v1/pack.json`,
  );
  const sourceManifest = readJson(
    `.xinfa/baselines/sha256/${atlasDigest}/manifest.json`,
  );
  const inventory = new Map(pack.inventory.map((row) => [row.path, row]));
  const embedded = new Set(inventory.keys());
  const files = trackedFiles();
  const classificationPaths = portableClassificationPaths(files);
  const classifications = classificationPaths.map((relative) => ({
    path: relative,
    ...classify(relative, embedded),
  }));
  const counts = Object.fromEntries(
    ['embedded', 'developer-pack', 'checkout-required', 'excluded'].map(
      (kind) => [
        kind,
        classifications.filter((row) => row.class === kind).length,
      ],
    ),
  );
  const nodes = new Map(atlas.semantic.nodes.map((node) => [node.id, node]));
  const routeEntries = atlas.routes.map((route) => {
    const surfaces = route.nodes
      .map((id) => nodes.get(id)?.source?.path)
      .filter(Boolean);
    const missing = surfaces.filter((relative) => !inventory.has(relative));
    const closureBytes = surfaces.reduce(
      (total, relative) => total + (inventory.get(relative)?.size || 0),
      0,
    );
    return {
      id: route.id,
      audience: route.audience,
      routeRoot: route.routeRoot,
      authorityRoot: route.authorityRoot,
      state: missing.length ? 'checkout-required' : 'embedded',
      surfaces,
      missing,
      closureBytes,
      readCommand: 'kungfu agent docs --read <path> --json',
      expansionCommand: missing.length
        ? 'shifu source plan --repository <url> --commit <sha> --tree <tree> --destination <path> --json'
        : null,
    };
  });
  routeEntries.push(
    {
      id: 'kungfu-portable-atlas-bundle-agent',
      audience: 'agent',
      routeRoot: selector.atlasRoot,
      authorityRoot: selector.contextPackRoot,
      state: 'embedded',
      surfaces: [
        '.xinfa/product-atlas-bundle.json',
        '.xinfa/portable-atlas-classification.json.gz',
      ],
      missing: [],
      closureBytes: 0,
      readCommand: 'kungfu agent docs --bundle --json',
      expansionCommand: null,
    },
    {
      id: 'kungfu-source-acquisition-agent',
      audience: 'agent',
      routeRoot: digest(
        fs.readFileSync(path.join(ROOT, 'docs/shifu/source-contract.json')),
      ),
      authorityRoot: 'shifu-native-launcher',
      state: 'embedded',
      surfaces: [
        'docs/shifu/source-contract.json',
        'docs/shifu/schema/source-plan-v1.schema.json',
        'docs/shifu/schema/source-receipt-v1.schema.json',
        'docs/shifu/schema/portable-atlas-bundle-v1.schema.json',
      ],
      missing: [],
      closureBytes: NATIVE_EMBEDDED.filter((relative) =>
        relative.startsWith('docs/shifu/'),
      ).reduce(
        (total, relative) =>
          total + fs.statSync(path.join(ROOT, relative)).size,
        0,
      ),
      readCommand: 'shifu source contract',
      expansionCommand: null,
    },
  );
  const materialDirectory = path.join(ROOT, materialBase);
  const compressedBytes = walk(materialDirectory).reduce(
    (total, relative) =>
      total + fs.statSync(path.join(materialDirectory, relative)).size,
    0,
  );
  const uncompressedBytes = sourceManifest.artifacts.reduce(
    (total, artifact) => total + artifact.size,
    0,
  );
  const maximumFileBytes = Math.max(
    ...sourceManifest.artifacts.map((artifact) => artifact.size),
  );
  const seen = new Set();
  const duplicateBytes = pack.inventory.reduce((total, row) => {
    if (seen.has(row.contentRoot)) return total + row.size;
    seen.add(row.contentRoot);
    return total;
  }, 0);
  const classificationCore = {
    schema: 'kungfu.portable-atlas-classification/v1',
    counts,
    entries: classifications,
    total: classifications.length,
    unknown: 0,
    silentOmissions: 0,
  };
  const classificationBytes = bytes(classificationCore);
  const classificationCompressed = zlib.gzipSync(
    classificationBytes,
    PORTABLE_GZIP_OPTIONS,
  );
  const nativeEmbeddedBytes = NATIVE_EMBEDDED.filter(
    (relative) => !relative.startsWith('.xinfa/'),
  ).reduce(
    (total, relative) => total + fs.statSync(path.join(ROOT, relative)).size,
    0,
  );
  const nativeEmbeddedCompressedBytes = zlib.gzipSync(
    Buffer.concat(
      NATIVE_EMBEDDED.filter((relative) => !relative.startsWith('.xinfa/')).map(
        (relative) => fs.readFileSync(path.join(ROOT, relative)),
      ),
    ),
    PORTABLE_GZIP_OPTIONS,
  ).length;
  const totalCompressedBytes =
    compressedBytes +
    classificationCompressed.length +
    nativeEmbeddedCompressedBytes;
  const totalUncompressedBytes =
    uncompressedBytes + classificationBytes.length + nativeEmbeddedBytes;
  const totalMaximumFileBytes = Math.max(
    maximumFileBytes,
    classificationBytes.length,
    ...NATIVE_EMBEDDED.filter(
      (relative) => !relative.startsWith('.xinfa/'),
    ).map((relative) => fs.statSync(path.join(ROOT, relative)).size),
  );
  const previous = previousMetrics(selector.atlasRoot);
  const priorReleaseDeltaBytes = previous
    ? Math.max(0, totalCompressedBytes - previous.compressedBytes)
    : 0;
  const installerRatio = options.installerBytes
    ? totalCompressedBytes / options.installerBytes
    : null;
  const gates = {
    compressedBytes: totalCompressedBytes <= LIMITS.compressedBytes,
    uncompressedBytes: totalUncompressedBytes <= LIMITS.uncompressedBytes,
    installerRatio:
      installerRatio === null || installerRatio <= LIMITS.installerRatio,
    maximumFileBytes: totalMaximumFileBytes <= LIMITS.maximumFileBytes,
    duplicateBytes: duplicateBytes <= LIMITS.duplicateBytes,
    routeBytes: routeEntries.every(
      (route) => route.closureBytes <= LIMITS.routeBytes,
    ),
    priorReleaseDeltaBytes:
      priorReleaseDeltaBytes <= LIMITS.priorReleaseDeltaBytes,
    routeClosure: routeEntries.every((route) => route.missing.length === 0),
    classification: classificationCovers(files, classificationPaths),
  };
  const witnessBytes = fs.readFileSync(path.join(ROOT, WITNESS));
  const classification = {
    schema: classificationCore.schema,
    counts,
    total: classifications.length,
    unknown: 0,
    silentOmissions: 0,
    classificationRoot: digest(classificationBytes),
    material: {
      kind: 'tracked-gzip',
      path: CLASSIFICATION_BUNDLE,
      compressedBytes: classificationCompressed.length,
      uncompressedBytes: classificationBytes.length,
    },
  };
  const routeCore = {
    schema: 'kungfu.portable-atlas-route-catalog/v1',
    entries: routeEntries,
    routeCount: routeEntries.length,
    incompleteRoutes: routeEntries.filter((route) => route.missing.length)
      .length,
  };
  const routes = { ...routeCore, routeCatalogRoot: digest(bytes(routeCore)) };
  const core = {
    schema: 'kungfu.portable-atlas-bundle/v1',
    version: 1,
    authority: {
      compiler: 'xinfa',
      runtime: 'kungfu.agent.documentation',
      selector: SELECTOR,
    },
    roots: {
      atlas: selector.atlasRoot,
      contextPack: selector.contextPackRoot,
      documentationManifest: sourceManifest.manifest_root,
    },
    sourceCut: {
      repository: 'https://github.com/kungfu-systems/kungfu.git',
      commit: sourceCommit,
      tree: sourceTree,
    },
    releasePassportBinding: {
      mode: 'buildchain-release-passport-artifact',
      requiredAtQualification: true,
      witnessPath: WITNESS,
      witnessContentRoot: digest(witnessBytes),
      releasePassportRoot: options.releasePassportRoot || null,
    },
    classification,
    routes,
    expansion: {
      states: ['embedded', 'developer-pack', 'checkout-required', 'excluded'],
      sourcePlanCommand:
        'shifu source plan --repository <url> --commit <sha> --tree <tree> --destination <path> --json',
      arbitraryCodeExecution: false,
    },
    budgets: {
      limits: LIMITS,
      metrics: {
        compressedBytes: totalCompressedBytes,
        uncompressedBytes: totalUncompressedBytes,
        installerBytes: options.installerBytes || null,
        installerRatio,
        maximumFileBytes: totalMaximumFileBytes,
        duplicateBytes,
        maximumRouteBytes: Math.max(
          ...routeEntries.map((route) => route.closureBytes),
        ),
        previous,
        priorReleaseDeltaBytes,
      },
      gates,
      passed: Object.values(gates).every(Boolean),
      releaseQualified:
        Object.values(gates).every(Boolean) &&
        installerRatio !== null &&
        Boolean(options.releasePassportRoot),
    },
    assembly: {
      rows: ['cli-macos', 'cli-linux', 'cli-windows', 'electron'],
      policy: 'identical-bundle-root',
      guiAuthorityForkAllowed: false,
    },
  };
  return { ...core, bundleRoot: digest(bytes(core)) };
}

/** @param {unknown} manifest */
export function verifyPortableBundle(manifest) {
  const diagnostics = [];
  if (!manifest || manifest.schema !== 'kungfu.portable-atlas-bundle/v1')
    diagnostics.push({ code: 'schema', path: '/' });
  const { bundleRoot: declared, ...core } = manifest;
  if (digest(bytes(core)) !== declared)
    diagnostics.push({ code: 'bundle-root', path: '/bundleRoot' });
  if (
    manifest.classification?.unknown !== 0 ||
    manifest.classification?.silentOmissions !== 0
  )
    diagnostics.push({ code: 'classification', path: '/classification' });
  if (manifest.routes?.incompleteRoutes !== 0)
    diagnostics.push({ code: 'route-closure', path: '/routes' });
  if (!manifest.budgets?.passed)
    diagnostics.push({ code: 'budget', path: '/budgets' });
  return {
    schema: 'kungfu.portable-atlas-bundle-verification/v1',
    valid: diagnostics.length === 0,
    bundleRoot: declared || null,
    diagnostics,
  };
}

function options(args) {
  const result = {
    output: '',
    manifest: OUTPUT,
    installerBytes: 0,
    releasePassportRoot: '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[++index];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--output') result.output = value;
    else if (flag === '--manifest') result.manifest = value;
    else if (flag === '--installer-size') result.installerBytes = Number(value);
    else if (flag === '--release-passport-root')
      result.releasePassportRoot = value;
    else throw new Error(`unknown option: ${flag}`);
  }
  if (
    result.installerBytes &&
    (!Number.isSafeInteger(result.installerBytes) || result.installerBytes <= 0)
  )
    throw new Error('--installer-size must be a positive integer');
  if (
    result.releasePassportRoot &&
    !/^sha256:[0-9a-f]{64}$/.test(result.releasePassportRoot)
  )
    throw new Error(
      '--release-passport-root must be sha256:<64 lowercase hex>',
    );
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'compile') {
      const parsed = options(args);
      const manifest = compilePortableBundle(parsed);
      const output = bytes(manifest);
      if (parsed.output) {
        fs.writeFileSync(path.resolve(ROOT, parsed.output), output);
        const embedded = new Set(
          gzJson(
            `.xinfa/material-bundles/sha256/${manifest.roots.atlas.slice(7)}/compatibility/context-pack-v1/pack.json`,
          ).inventory.map((row) => row.path),
        );
        const classification = {
          schema: manifest.classification.schema,
          counts: manifest.classification.counts,
          entries: portableClassificationPaths(trackedFiles()).map(
            (relative) => ({
              path: relative,
              ...classify(relative, embedded),
            }),
          ),
          total: manifest.classification.total,
          unknown: 0,
          silentOmissions: 0,
        };
        const classificationBytes = bytes(classification);
        if (
          digest(classificationBytes) !==
          manifest.classification.classificationRoot
        )
          throw new Error(
            'generated classification bytes differ from manifest root',
          );
        fs.writeFileSync(
          path.join(ROOT, CLASSIFICATION_BUNDLE),
          zlib.gzipSync(classificationBytes, PORTABLE_GZIP_OPTIONS),
        );
      } else process.stdout.write(output);
    } else if (command === 'verify') {
      const parsed = options(args);
      const manifest = readJson(parsed.manifest);
      const receipt = verifyPortableBundle(manifest);
      process.stdout.write(bytes(receipt));
      if (!receipt.valid) process.exitCode = 1;
    } else {
      throw new Error(
        'usage: portable-atlas-bundle.mjs compile [--output FILE] [--installer-size N] [--release-passport-root ROOT] | verify [--manifest FILE]',
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
