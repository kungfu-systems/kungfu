// SPDX-License-Identifier: Apache-2.0

import type { ReleaseManifest } from './update-controller';

export type ReleaseManifestFetchResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type ReleaseManifestFetch = (
  url: string,
) => Promise<ReleaseManifestFetchResponse>;

type ResolverOptions = {
  fetch: ReleaseManifestFetch;
  releaseBaseUrl: string;
  platform: NodeJS.Platform;
  architecture: string;
  maxBytes?: number;
};

type PublishedManifest = ReleaseManifest & {
  platform: string;
  architecture: string;
  sourceCommit: string;
  qualificationEvidenceRef: string;
  artifacts: Array<{
    kind: string;
    url: string;
    signature: string;
  }>;
};

const UNQUALIFIED = 'unqualified-local-build';

export function publishedManifestAssetName(
  version: string,
  platform: string,
  architecture: string,
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new Error(`Unsafe desktop release version: ${version}`);
  }
  return `kungfu-upgrade-${version}-${platform}-${architecture}.json`;
}

export function assertPublishedReleaseManifest(
  value: unknown,
  version: string,
  platform: string,
  architecture: string,
): asserts value is PublishedManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Published release manifest is not an object');
  }
  const manifest = value as Partial<PublishedManifest>;
  if (manifest.schema !== 'kungfu.product-upgrade.manifest/v1') {
    throw new Error('Published release manifest schema is unsupported');
  }
  if (
    manifest.productVersion !== version ||
    manifest.platform !== platform ||
    manifest.architecture !== architecture
  ) {
    throw new Error('Published release manifest target does not match updater');
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '')) {
    throw new Error('Published release manifest source identity is invalid');
  }
  if (
    !manifest.qualificationEvidenceRef ||
    manifest.qualificationEvidenceRef.startsWith(UNQUALIFIED)
  ) {
    throw new Error('Published release manifest is not qualified');
  }
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const kinds = new Set(artifacts.map((artifact) => artifact.kind));
  if (!kinds.has('runtime') || !kinds.has('desktop')) {
    throw new Error('Published release manifest is missing product artifacts');
  }
  for (const artifact of artifacts) {
    if (!artifact.signature || artifact.signature === UNQUALIFIED) {
      throw new Error(`${artifact.kind} artifact has no signing evidence`);
    }
    if (artifact.kind === 'desktop' && !artifact.url.startsWith('https://')) {
      throw new Error('Desktop update artifact must use HTTPS');
    }
  }
}

export function createPublishedReleaseManifestResolver(
  options: ResolverOptions,
) {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  return async (info: { version: string }): Promise<ReleaseManifest> => {
    const asset = publishedManifestAssetName(
      info.version,
      options.platform,
      options.architecture,
    );
    const url = `${options.releaseBaseUrl.replace(/\/$/, '')}/v${info.version}/${asset}`;
    const response = await options.fetch(url);
    if (!response.ok) {
      throw new Error(
        `Published release manifest request failed (${response.status})`,
      );
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) {
      throw new Error('Published release manifest exceeds the size limit');
    }
    const payload = await response.text();
    if (Buffer.byteLength(payload, 'utf8') > maxBytes) {
      throw new Error('Published release manifest exceeds the size limit');
    }
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch (error) {
      throw new Error(
        `Published release manifest is invalid JSON: ${(error as Error).message}`,
      );
    }
    assertPublishedReleaseManifest(
      value,
      info.version,
      options.platform,
      options.architecture,
    );
    return value;
  };
}
