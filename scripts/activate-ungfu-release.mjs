#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS_URL = 'https://kungfu.tech/.well-known/kungfu-release-status.json';

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`);
  }
}

async function fetchJson(url, label, token = '') {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'user-agent': 'kungfu-release-activation/1',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}`);
  return response.json();
}

async function fetchText(url, label) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { 'user-agent': 'kungfu-release-activation/1' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`${label} returned HTTP ${response.status}`);
  return response.text();
}

function parseArgs(argv) {
  const options = { shadow: false, outputDir: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--shadow') options.shadow = true;
    else if (value === '--output-dir') options.outputDir = argv[++index];
    else if (value === '--buildchain-root')
      options.buildchainRoot = argv[++index];
    else throw new Error(`unknown option: ${value}`);
  }
  return options;
}

async function buildchainApi(options) {
  const root = path.resolve(
    options.buildchainRoot ||
      process.env.KUNGFU_BUILDCHAIN_ROOT ||
      path.join(ROOT, '.buildchain/runtime'),
  );
  return import(
    pathToFileURL(
      path.join(root, 'packages/core/release-activation-transaction.js'),
    ).href
  );
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizePublishedArtifacts(publishEvidence, acquisitionIndex) {
  const roots = new Map();
  for (const item of [
    ...(publishEvidence.artifacts || []).map((artifact) => ({
      name: artifact.name,
      sha256: artifact.digest,
    })),
    ...(acquisitionIndex.release?.artifactRoots || []),
  ]) {
    if (
      typeof item.name === 'string' &&
      /^sha256:[0-9a-f]{64}$/.test(item.sha256 || '')
    ) {
      roots.set(`${item.name}:${item.sha256}`, {
        name: item.name,
        sha256: item.sha256,
      });
    }
  }
  const result = [...roots.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (result.length === 0) {
    throw new Error('activation found no authoritative public artifact roots');
  }
  return result;
}

async function resolveQualification(tag, version, artifactRoots, token) {
  const release = await fetchJson(
    `https://api.github.com/repos/kungfu-systems/kungfu/releases/tags/${tag}`,
    'GitHub release',
    token,
  );
  const assets = (release.assets || [])
    .filter((asset) => asset.name?.endsWith('.qualification.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const admittedRoots = new Set(
    artifactRoots.map((artifact) => artifact.sha256.slice(7)),
  );
  for (const asset of assets) {
    const qualification = await fetchJson(
      asset.browser_download_url,
      `product qualification ${asset.name}`,
      token,
    );
    if (
      qualification.schema ===
        'kungfu.cli-installed-product-qualification/v1' &&
      qualification.qualified === true &&
      qualification.version === version &&
      admittedRoots.has(qualification.identity?.archiveSha256)
    ) {
      return { qualification, url: asset.browser_download_url };
    }
  }
  throw new Error(
    'no public installed-product qualification matches the exact version and artifact roots',
  );
}

function shadowDocuments(api) {
  const bindings = {
    sourceSha: 'a'.repeat(40),
    siteSourceSha: 'b'.repeat(40),
    tag: 'v4.0.0-alpha.shadow',
    channel: 'alpha',
    version: '4.0.0-alpha.shadow',
    environment: 'shadow',
    artifactSetRoot: `sha256:${'1'.repeat(64)}`,
  };
  const documents = {
    'artifact-publication': {
      schema: 'kungfu.activation-artifact-publication/v1',
      sourceSha: bindings.sourceSha,
      artifactSetRoot: bindings.artifactSetRoot,
      artifactRoots: [
        { name: 'shadow-cli.tar.gz', sha256: `sha256:${'2'.repeat(64)}` },
      ],
      synthetic: true,
    },
    'release-passport': {
      contract: 'kungfu-buildchain-release-passport',
      passportRoot: `sha256:${'3'.repeat(64)}`,
      release: { sourceSha: bindings.sourceSha, tag: bindings.tag },
      synthetic: true,
    },
    'site-publication': {
      schema: 'kungfu.release-status/v1',
      status: 'preparation',
      releasedUseClaim: false,
      synthetic: true,
    },
    'public-readback': {
      schema: 'kungfu.release-public-readback/v1',
      qualified: false,
      releasedUseClaim: false,
      synthetic: true,
    },
    'product-qualification': {
      schema: 'kungfu.cli-installed-product-qualification/v1',
      qualified: false,
      releasedUseClaim: false,
      synthetic: true,
    },
  };
  return { bindings, documents };
}

async function liveDocuments(api) {
  const sourceSha = required(
    process.env.BUILDCHAIN_RELEASE_SOURCE_SHA,
    'BUILDCHAIN_RELEASE_SOURCE_SHA',
  );
  const tag = required(
    process.env.BUILDCHAIN_RELEASE_TAG,
    'BUILDCHAIN_RELEASE_TAG',
  );
  const version = required(
    process.env.BUILDCHAIN_RELEASE_VERSION,
    'BUILDCHAIN_RELEASE_VERSION',
  );
  const channel = required(
    process.env.BUILDCHAIN_RELEASE_CHANNEL,
    'BUILDCHAIN_RELEASE_CHANNEL',
  );
  const passport = readJson(
    required(
      process.env.BUILDCHAIN_RELEASE_PASSPORT,
      'BUILDCHAIN_RELEASE_PASSPORT',
    ),
    'Release Passport',
  );
  const publishEvidence = readJson(
    required(
      process.env.BUILDCHAIN_PUBLISH_EVIDENCE,
      'BUILDCHAIN_PUBLISH_EVIDENCE',
    ),
    'publish evidence',
  );
  const status = await fetchJson(STATUS_URL, 'public release status');
  if (
    status.schema !== 'kungfu.release-status/v1' ||
    status.status !== 'current-release' ||
    status.releasedUseClaim !== true ||
    status.release?.sourceSha !== sourceSha ||
    status.release?.tag !== tag ||
    status.release?.version !== version ||
    status.release?.channel !== channel
  ) {
    throw new Error('public release status is stale or mismatched');
  }
  const acquisitionIndex = await fetchJson(
    status.acquisitionEvidence?.url,
    'public acquisition index',
  );
  const artifactRoots = normalizePublishedArtifacts(
    publishEvidence,
    acquisitionIndex,
  );
  const token =
    process.env.BUILDCHAIN_RELEASE_ACTIVATION_TOKEN ||
    process.env.GH_TOKEN ||
    '';
  const { qualification, url: qualificationUrl } = await resolveQualification(
    tag,
    version,
    artifactRoots,
    token,
  );
  const acquisition = acquisitionIndex.acquisition || {};
  const page = await fetchText(
    acquisition.publicUrl,
    'public acquisition page',
  );
  if (
    !page.includes('data-ungfu-release-acquisition') ||
    !page.includes('Kungfu UNGFU™') ||
    !page.includes(acquisition.acquisitionUrl) ||
    !page.includes(version) ||
    !page.includes(channel)
  ) {
    throw new Error('public acquisition page readback is incomplete');
  }
  await fetchText(acquisition.acquisitionUrl, 'public acquisition action');
  await fetchText(
    acquisition.renderedEvidence,
    'rendered acquisition evidence',
  );
  const bindings = {
    sourceSha,
    siteSourceSha: status.release.siteSourceSha,
    tag,
    channel,
    version,
    environment: 'production',
    artifactSetRoot: api.releaseActivationRoot(artifactRoots),
  };
  const observedAt = new Date().toISOString().slice(0, 10);
  const documents = {
    'artifact-publication': {
      schema: 'kungfu.activation-artifact-publication/v1',
      sourceSha,
      artifactSetRoot: bindings.artifactSetRoot,
      artifactRoots,
    },
    'release-passport': passport,
    'site-publication': status,
    'public-readback': {
      schema: 'kungfu.release-public-readback/v1',
      qualified: true,
      sourceSha,
      siteSourceSha: bindings.siteSourceSha,
      version,
      channel,
      observedAt,
      acquisitionRoot: status.acquisitionEvidence.root,
      acquisition: {
        publicUrl: acquisition.publicUrl,
        acquisitionUrl: acquisition.acquisitionUrl,
        renderedEvidence: acquisition.renderedEvidence,
      },
      product: {
        publicUrl: qualificationUrl,
        renderedEvidence: qualificationUrl,
      },
      brandArchive: [
        {
          kind: 'public-brand-history',
          url: 'https://kungfu.tech/about/',
        },
      ],
    },
    'product-qualification': {
      ...qualification,
      sourceSha,
    },
  };
  return { bindings, documents };
}

function assemble(api, { bindings, documents }, { shadow, outputDir }) {
  const mode = shadow ? 'shadow' : 'activation';
  let transaction = api.createReleaseActivationTransaction({
    transactionId: `${mode}:${bindings.sourceSha}:${bindings.siteSourceSha}`,
    mode,
    bindings,
    owners: {
      product: 'kungfu-systems/kungfu',
      transaction: 'kungfu-systems/buildchain',
      site: 'kungfu-systems/site-kungfu-tech',
    },
  });
  const documentRoots = Object.fromEntries(
    Object.entries(documents).map(([kind, document]) => [
      kind,
      api.releaseActivationRoot(document),
    ]),
  );
  const rootsByPhase = {
    'candidate-qualified': [documentRoots['release-passport']],
    'artifacts-published': [documentRoots['artifact-publication']],
    'passport-sealed': [documentRoots['release-passport']],
    'site-published': [documentRoots['site-publication']],
    'public-readback': [
      documentRoots['public-readback'],
      documentRoots['product-qualification'],
    ],
    'evidence-synthesized': [api.releaseActivationRoot(bindings)],
  };
  for (const phase of api.RELEASE_ACTIVATION_PHASES) {
    transaction = api.recordReleaseActivationPhase(transaction, phase, {
      receiptRoots: rootsByPhase[phase],
    });
  }
  const exactBindingRoot = api.releaseActivationRoot(bindings);
  const receipts = [
    'artifact-publication',
    'release-passport',
    'site-publication',
    'public-readback',
    'product-qualification',
  ].map((kind) => ({
    kind,
    root: documentRoots[kind],
    bindingRoot: exactBindingRoot,
    locator: `${kind}.json`,
  }));
  const receiptSet = api.createReleaseActivationReceiptSet({
    transaction,
    receipts,
  });
  for (const [kind, document] of Object.entries(documents)) {
    writeJson(path.join(outputDir, `${kind}.json`), document);
  }
  writeJson(path.join(outputDir, 'transaction.json'), transaction);
  writeJson(path.join(outputDir, 'receipt-set.json'), receiptSet);
  return { transaction, receiptSet };
}

async function main(argv) {
  const options = parseArgs(argv);
  const api = await buildchainApi(options);
  const configuredOutput =
    options.outputDir ||
    (process.env.BUILDCHAIN_RELEASE_ACTIVATION_RECEIPTS
      ? path.dirname(process.env.BUILDCHAIN_RELEASE_ACTIVATION_RECEIPTS)
      : '.buildchain/release-activation');
  const outputDir = path.resolve(configuredOutput);
  const input = options.shadow
    ? shadowDocuments(api)
    : await liveDocuments(api);
  const result = assemble(api, input, {
    shadow: options.shadow,
    outputDir,
  });
  const expectedReceiptSet = process.env.BUILDCHAIN_RELEASE_ACTIVATION_RECEIPTS;
  if (expectedReceiptSet) {
    const actual = path.join(outputDir, 'receipt-set.json');
    if (path.resolve(expectedReceiptSet) !== actual) {
      throw new Error(
        'BUILDCHAIN_RELEASE_ACTIVATION_RECEIPTS must name output-dir/receipt-set.json',
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      schema: 'kungfu.release-activation-result/v1',
      state: result.transaction.state,
      mode: result.transaction.mode,
      releasedUseClaim: result.receiptSet.releasedUseClaim,
      transactionRoot: result.transaction.transactionRoot,
      receiptSetRoot: result.receiptSet.receiptSetRoot,
      outputDir,
    })}\n`,
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`[kungfu-release-activation] ${error.message}`);
  process.exitCode = 1;
});
