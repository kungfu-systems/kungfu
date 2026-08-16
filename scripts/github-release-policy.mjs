#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PRODUCT_TAG =
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/u;
const COMPONENT_TAG =
  /^(?<component>[a-z0-9][a-z0-9-]*)-v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/u;
const PUBLICATION_BUNDLE = 'buildchain.release.json';

function fail(message) {
  throw new Error(message);
}

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) fail(`${label} is required`);
  return normalized;
}

function repositoryParts(repository) {
  const normalized = required(repository, 'repository');
  const parts = normalized.split('/');
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))
  ) {
    fail('repository must be owner/repo');
  }
  return { owner: parts[0], repo: parts[1], repository: normalized };
}

export function classifyReleaseTag(tag) {
  const normalized = required(tag, 'release tag');
  if (PRODUCT_TAG.test(normalized)) {
    return {
      tag: normalized,
      surface: 'product',
      draft: false,
      prerelease: false,
      makeLatest: 'true',
    };
  }
  const component = normalized.match(COMPONENT_TAG)?.groups?.component;
  if (component) {
    return {
      tag: normalized,
      surface: 'component',
      component,
      draft: false,
      prerelease: false,
      makeLatest: 'false',
    };
  }
  fail(`unsupported Kungfu release tag: ${normalized}`);
}

function githubHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-github-api-version': '2022-11-28',
  };
}

async function githubJson(
  fetcher,
  url,
  { token = '', method = 'GET', body } = {},
) {
  const response = await fetcher(url, {
    method,
    headers: {
      ...githubHeaders(token),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    fail(
      `${method} ${url} returned HTTP ${response.status}${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  return { data: await response.json(), response };
}

function nextLink(response) {
  const value = response.headers?.get?.('link') || '';
  for (const part of value.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/u);
    if (match?.[2] === 'next') return match[1];
  }
  return '';
}

async function listReleases({ fetcher, apiUrl, repository, token }) {
  const releases = [];
  let url = `${apiUrl}/repos/${repository}/releases?per_page=100`;
  while (url) {
    const result = await githubJson(fetcher, url, { token });
    if (!Array.isArray(result.data))
      fail('GitHub releases response is not an array');
    releases.push(...result.data);
    url = nextLink(result.response);
  }
  return releases;
}

function releaseTimestamp(release) {
  const value = release.published_at || release.created_at || '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail(
      `release ${release.tag_name || '<unknown>'} has no valid publication time`,
    );
  }
  return timestamp;
}

export function newestPublicProductRelease(releases) {
  const products = releases.filter(
    (release) =>
      release &&
      release.draft === false &&
      PRODUCT_TAG.test(String(release.tag_name || '')),
  );
  if (products.length === 0)
    fail('repository has no public Kungfu product release');
  return products.sort((left, right) => {
    const timeDelta = releaseTimestamp(right) - releaseTimestamp(left);
    if (timeDelta !== 0) return timeDelta;
    return Number(right.id || 0) - Number(left.id || 0);
  })[0];
}

export function tagFromPublicationUrl(value) {
  const url = new URL(required(value, 'publication URL'));
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    fail('publication URL must be an HTTPS github.com URL');
  }
  const match = url.pathname.match(
    /^\/[^/]+\/[^/]+\/releases\/(?:tag|download)\/([^/]+)(?:\/|$)/u,
  );
  if (!match) fail('publication URL does not contain a GitHub release tag');
  const tag = decodeURIComponent(match[1]);
  if (classifyReleaseTag(tag).surface !== 'product') {
    fail('publication URL does not identify a Kungfu product release');
  }
  return tag;
}

function validatePublicationBundle(bundle, { repository, tag }) {
  if (!bundle || typeof bundle !== 'object') {
    fail(`${PUBLICATION_BUNDLE} is not a JSON object`);
  }
  const version = tag.slice(1);
  if (
    bundle.product?.repository !== repository ||
    bundle.product?.name !== 'Kungfu Episodes'
  ) {
    fail(`${PUBLICATION_BUNDLE} does not identify the Kungfu product`);
  }
  if (
    bundle.release?.tag !== tag ||
    bundle.release?.publicTag !== tag ||
    bundle.release?.exactRef !== `refs/tags/${tag}` ||
    bundle.release?.versionLabel !== version ||
    bundle.release?.package?.version !== version
  ) {
    fail(`${PUBLICATION_BUNDLE} does not match product release ${tag}`);
  }
  const expectedChannel = version.includes('-alpha.') ? 'alpha' : 'release';
  if (bundle.release?.channel !== expectedChannel) {
    fail(
      `${PUBLICATION_BUNDLE} channel ${bundle.release?.channel || '<missing>'} does not match ${expectedChannel}`,
    );
  }
  return bundle;
}

export async function applyProductReleaseMetadata({
  repository,
  tag,
  token = '',
  apiUrl = 'https://api.github.com',
  fetcher = fetch,
}) {
  const repo = repositoryParts(repository).repository;
  const policy = classifyReleaseTag(tag);
  if (policy.surface !== 'product') {
    fail(`refusing to apply product metadata to ${policy.surface} tag ${tag}`);
  }
  const releaseUrl = `${apiUrl}/repos/${repo}/releases/tags/${encodeURIComponent(policy.tag)}`;
  const [existing, releases] = await Promise.all([
    githubJson(fetcher, releaseUrl, { token }),
    listReleases({ fetcher, apiUrl, repository: repo, token }),
  ]);
  if (!Number.isInteger(existing.data?.id)) {
    fail(`GitHub release ${policy.tag} has no numeric id`);
  }
  const newestProduct = newestPublicProductRelease(releases);
  if (
    newestProduct.id !== existing.data.id ||
    newestProduct.tag_name !== policy.tag
  ) {
    fail(
      `refusing to move GitHub Latest backward from newest Kungfu product ${newestProduct.tag_name} to ${policy.tag}`,
    );
  }
  const patch = {
    draft: policy.draft,
    prerelease: policy.prerelease,
    make_latest: policy.makeLatest,
  };
  const updated = await githubJson(
    fetcher,
    `${apiUrl}/repos/${repo}/releases/${existing.data.id}`,
    { token, method: 'PATCH', body: patch },
  );
  if (
    updated.data?.tag_name !== policy.tag ||
    updated.data?.draft !== false ||
    updated.data?.prerelease !== false
  ) {
    fail(
      `GitHub did not retain the required product metadata for ${policy.tag}`,
    );
  }
  const latest = await githubJson(
    fetcher,
    `${apiUrl}/repos/${repo}/releases/latest`,
    {
      token,
    },
  );
  if (
    latest.data?.id !== updated.data.id ||
    latest.data?.tag_name !== policy.tag
  ) {
    fail(
      `GitHub Latest does not point to normalized product release ${policy.tag}`,
    );
  }
  return {
    schema: 'kungfu.github-release-metadata-application/v1',
    repository: repo,
    tag: policy.tag,
    releaseId: updated.data.id,
    metadata: patch,
    status: 'passed',
  };
}

export async function applyNewestProductReleaseMetadata({
  repository,
  token = '',
  apiUrl = 'https://api.github.com',
  fetcher = fetch,
}) {
  const repo = repositoryParts(repository).repository;
  const releases = await listReleases({
    fetcher,
    apiUrl,
    repository: repo,
    token,
  });
  const newestProduct = newestPublicProductRelease(releases);
  return applyProductReleaseMetadata({
    repository: repo,
    tag: newestProduct.tag_name,
    token,
    apiUrl,
    fetcher,
  });
}

export async function verifyLatestProductRelease({
  repository,
  expectedTag = '',
  expectedPublicationUrl = '',
  token = '',
  apiUrl = 'https://api.github.com',
  webUrl = 'https://github.com',
  fetcher = fetch,
}) {
  const repo = repositoryParts(repository).repository;
  const [latestResult, releases] = await Promise.all([
    githubJson(fetcher, `${apiUrl}/repos/${repo}/releases/latest`, { token }),
    listReleases({ fetcher, apiUrl, repository: repo, token }),
  ]);
  const latest = latestResult.data;
  const newestProduct = newestPublicProductRelease(releases);
  const boundTag = expectedPublicationUrl
    ? tagFromPublicationUrl(expectedPublicationUrl)
    : expectedTag || newestProduct.tag_name;
  if (classifyReleaseTag(boundTag).surface !== 'product') {
    fail(`expected release ${boundTag} is not a Kungfu product tag`);
  }
  if (
    latest?.tag_name !== boundTag ||
    newestProduct.tag_name !== boundTag ||
    latest.id !== newestProduct.id
  ) {
    fail(
      `GitHub Latest must point to newest Kungfu product ${boundTag}; observed ${latest?.tag_name || '<missing>'}`,
    );
  }
  if (latest.draft !== false || latest.prerelease !== false) {
    fail(
      `Kungfu product release ${boundTag} must be public and prerelease=false`,
    );
  }
  const assets = (latest.assets || []).filter(
    (asset) => asset?.name === PUBLICATION_BUNDLE,
  );
  if (assets.length !== 1 || !assets[0].browser_download_url) {
    fail(
      `Kungfu product release ${boundTag} must contain one ${PUBLICATION_BUNDLE}`,
    );
  }
  const latestUrl = `${webUrl}/${repo}/releases/latest/download/${PUBLICATION_BUNDLE}`;
  const pointer = await fetcher(latestUrl, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
  });
  if (![301, 302, 303, 307, 308].includes(pointer.status)) {
    fail(`${latestUrl} did not return a bounded release redirect`);
  }
  const pointerTarget = new URL(
    required(pointer.headers?.get?.('location'), 'Latest bundle redirect'),
    latestUrl,
  ).href;
  if (pointerTarget !== assets[0].browser_download_url) {
    fail(
      `Latest ${PUBLICATION_BUNDLE} resolved to ${pointerTarget}, expected ${assets[0].browser_download_url}`,
    );
  }
  const response = await fetcher(pointerTarget, {
    headers: { accept: 'application/json' },
    redirect: 'follow',
  });
  if (!response.ok) {
    fail(`${pointerTarget} returned HTTP ${response.status}`);
  }
  const bundle = validatePublicationBundle(await response.json(), {
    repository: repo,
    tag: boundTag,
  });
  return {
    schema: 'kungfu.github-release-latest-gate/v1',
    repository: repo,
    tag: boundTag,
    releaseId: latest.id,
    latestUrl,
    publicationBundleUrl: pointerTarget,
    publicationBundleContract: bundle.contract,
    productChannel: bundle.release.channel,
    status: 'passed',
  };
}

function parseArgs(argv) {
  const [command, ...values] = argv;
  const options = { command };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const readValue = () => required(values[++index], value);
    if (value === '--') continue;
    if (value === '--repository') options.repository = readValue();
    else if (value === '--tag') options.tag = readValue();
    else if (value === '--expected-tag') options.expectedTag = readValue();
    else if (value === '--expected-publication-url')
      options.expectedPublicationUrl = readValue();
    else if (value === '--api-url') options.apiUrl = readValue();
    else if (value === '--web-url') options.webUrl = readValue();
    else fail(`unknown argument: ${value}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const common = {
    repository: options.repository,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',
    apiUrl: options.apiUrl,
  };
  let result;
  if (options.command === 'apply-product') {
    result = await applyProductReleaseMetadata({ ...common, tag: options.tag });
  } else if (options.command === 'apply-newest-product') {
    result = await applyNewestProductReleaseMetadata(common);
  } else if (options.command === 'verify-latest') {
    result = await verifyLatestProductRelease({
      ...common,
      expectedTag: options.expectedTag,
      expectedPublicationUrl: options.expectedPublicationUrl,
      webUrl: options.webUrl,
    });
  } else {
    fail(
      'usage: github-release-policy.mjs apply-product --repository OWNER/REPO --tag TAG | apply-newest-product --repository OWNER/REPO | verify-latest --repository OWNER/REPO [--expected-tag TAG | --expected-publication-url URL]',
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `github-release-policy: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
