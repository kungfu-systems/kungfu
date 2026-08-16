// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  applyNewestProductReleaseMetadata,
  applyProductReleaseMetadata,
  classifyReleaseTag,
  tagFromPublicationUrl,
  verifyLatestProductRelease,
} from './github-release-policy.mjs';

const REPOSITORY = 'kungfu-systems/kungfu';
const PRODUCT_TAG = 'v4.0.0-alpha.3';
const PRODUCT_ID = 403;
const ASSET_URL = `https://github.com/${REPOSITORY}/releases/download/${PRODUCT_TAG}/buildchain.release.json`;

function response(data, { status = 200, url = '', headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

function productRelease({
  id = PRODUCT_ID,
  tag = PRODUCT_TAG,
  publishedAt = '2026-08-16T10:00:00Z',
  prerelease = false,
} = {}) {
  return {
    id,
    tag_name: tag,
    draft: false,
    prerelease,
    published_at: publishedAt,
    assets: [
      {
        name: 'buildchain.release.json',
        browser_download_url: ASSET_URL,
      },
    ],
  };
}

function publicationBundle(tag = PRODUCT_TAG) {
  return {
    contract: 'buildchain.release-manifest/v2',
    product: {
      name: 'Kungfu Episodes',
      repository: REPOSITORY,
    },
    release: {
      tag,
      publicTag: tag,
      exactRef: `refs/tags/${tag}`,
      versionLabel: tag.slice(1),
      channel: tag.includes('-alpha.') ? 'alpha' : 'release',
      package: { version: tag.slice(1) },
    },
  };
}

function verificationFetcher({
  latest = productRelease(),
  bundleUrl = ASSET_URL,
} = {}) {
  return async (url) => {
    if (url.endsWith('/releases/latest')) return response(latest);
    if (url.endsWith('/releases?per_page=100')) {
      return response([
        latest,
        productRelease({
          id: 401,
          tag: 'v4.0.0-alpha.2',
          publishedAt: '2026-08-15T10:00:00Z',
        }),
        {
          id: 402,
          tag_name: 'shifu-v4.0.0-alpha.3',
          draft: false,
          prerelease: false,
          published_at: '2026-08-16T11:00:00Z',
          assets: [],
        },
      ]);
    }
    if (url.endsWith('/releases/latest/download/buildchain.release.json')) {
      return response(null, {
        status: 302,
        headers: { location: bundleUrl },
      });
    }
    if (url === ASSET_URL) return response(publicationBundle(), { url });
    throw new Error(`unexpected request: ${url}`);
  };
}

test('product Alpha metadata is public, non-prerelease, and Latest', () => {
  assert.deepEqual(classifyReleaseTag(PRODUCT_TAG), {
    tag: PRODUCT_TAG,
    surface: 'product',
    draft: false,
    prerelease: false,
    makeLatest: 'true',
  });
});

test('Shifu and Xinfa component tags explicitly cannot become Latest', () => {
  for (const tag of ['shifu-v4.0.0-alpha.3', 'xinfa-v0.2.0']) {
    const policy = classifyReleaseTag(tag);
    assert.equal(policy.surface, 'component');
    assert.equal(policy.makeLatest, 'false');
  }
});

test('publication URLs bind either tag or download coordinates', () => {
  assert.equal(
    tagFromPublicationUrl(
      `https://github.com/${REPOSITORY}/releases/tag/${PRODUCT_TAG}`,
    ),
    PRODUCT_TAG,
  );
  assert.equal(tagFromPublicationUrl(ASSET_URL), PRODUCT_TAG);
});

test('product metadata application PATCHes all three GitHub fields and reads Latest back', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith(`/releases/tags/${PRODUCT_TAG}`)) {
      return response(productRelease({ prerelease: true }));
    }
    if (url.endsWith('/releases?per_page=100')) {
      return response([productRelease({ prerelease: true })]);
    }
    if (url.endsWith(`/releases/${PRODUCT_ID}`)) {
      return response(productRelease());
    }
    if (url.endsWith('/releases/latest')) return response(productRelease());
    throw new Error(`unexpected request: ${url}`);
  };
  const result = await applyProductReleaseMetadata({
    repository: REPOSITORY,
    tag: PRODUCT_TAG,
    token: 'test-token',
    fetcher,
  });
  assert.equal(result.status, 'passed');
  const patch = calls.find((call) => call.options.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.options.body), {
    draft: false,
    prerelease: false,
    make_latest: 'true',
  });
});

test('product metadata application refuses to move Latest to an older product', async () => {
  let patched = false;
  const fetcher = async (url, options = {}) => {
    if (options.method === 'PATCH') patched = true;
    if (url.endsWith('/releases/tags/v4.0.0-alpha.2')) {
      return response(
        productRelease({
          id: 401,
          tag: 'v4.0.0-alpha.2',
          publishedAt: '2026-08-15T10:00:00Z',
        }),
      );
    }
    if (url.endsWith('/releases?per_page=100')) {
      return response([
        productRelease(),
        productRelease({
          id: 401,
          tag: 'v4.0.0-alpha.2',
          publishedAt: '2026-08-15T10:00:00Z',
        }),
      ]);
    }
    throw new Error(`unexpected request: ${url}`);
  };
  await assert.rejects(
    applyProductReleaseMetadata({
      repository: REPOSITORY,
      tag: 'v4.0.0-alpha.2',
      fetcher,
    }),
    /refusing to move GitHub Latest backward/u,
  );
  assert.equal(patched, false);
});

test('stable publication tail discovers and explicitly applies the newest product', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/releases?per_page=100')) {
      return response([productRelease()]);
    }
    if (url.endsWith(`/releases/tags/${PRODUCT_TAG}`)) {
      return response(productRelease());
    }
    if (url.endsWith(`/releases/${PRODUCT_ID}`)) {
      return response(productRelease());
    }
    if (url.endsWith('/releases/latest')) return response(productRelease());
    throw new Error(`unexpected request: ${url}`);
  };
  const result = await applyNewestProductReleaseMetadata({
    repository: REPOSITORY,
    fetcher,
  });
  assert.equal(result.tag, PRODUCT_TAG);
  assert.equal(
    calls.filter((call) => call.options.method === 'PATCH').length,
    1,
  );
});

test('Latest gate binds the newest product and its Publication Bundle', async () => {
  const result = await verifyLatestProductRelease({
    repository: REPOSITORY,
    expectedPublicationUrl: ASSET_URL,
    fetcher: verificationFetcher(),
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.tag, PRODUCT_TAG);
  assert.equal(result.productChannel, 'alpha');
  assert.equal(result.publicationBundleUrl, ASSET_URL);
});

test('Latest gate rejects a component that has stolen the discovery pointer', async () => {
  const component = {
    id: 404,
    tag_name: 'xinfa-v0.2.0',
    draft: false,
    prerelease: false,
    published_at: '2026-08-16T11:00:00Z',
    assets: [],
  };
  await assert.rejects(
    verifyLatestProductRelease({
      repository: REPOSITORY,
      expectedTag: PRODUCT_TAG,
      fetcher: verificationFetcher({ latest: component }),
    }),
    /GitHub Latest must point to newest Kungfu product/u,
  );
});

test('Latest gate rejects a download pointer that does not resolve to the release asset', async () => {
  await assert.rejects(
    verifyLatestProductRelease({
      repository: REPOSITORY,
      expectedTag: PRODUCT_TAG,
      fetcher: verificationFetcher({
        bundleUrl: ASSET_URL.replace(PRODUCT_TAG, 'shifu-v4.0.0-alpha.3'),
      }),
    }),
    /Latest buildchain\.release\.json resolved/u,
  );
});

test('release workflows bind product and component metadata explicitly', () => {
  const productWorkflow = fs.readFileSync(
    '.github/workflows/release-new-version.yml',
    'utf8',
  );
  const alphaPublication = fs.readFileSync(
    'scripts/alpha-publication-commit.mjs',
    'utf8',
  );
  const componentWorkflow = fs.readFileSync(
    '.github/workflows/release-shifu.yml',
    'utf8',
  );
  const layerWorkflow = fs.readFileSync(
    '.github/workflows/publish-layer-artifacts.yml',
    'utf8',
  );
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(
    alphaPublication.match(/applyProductReleaseMetadata\(\{/gu)?.length,
    2,
  );
  assert.match(productWorkflow, /release:github:latest:verify/u);
  assert.match(productWorkflow, /release:github:metadata:apply-newest/u);
  assert.match(
    packageJson.scripts['release:github:latest:verify'],
    /github-release-policy\.mjs verify-latest/u,
  );
  assert.match(componentWorkflow, /--draft=false/u);
  assert.match(componentWorkflow, /--prerelease=false/u);
  assert.match(componentWorkflow, /--latest=false/u);
  assert.match(layerWorkflow, /--draft=false/u);
  assert.match(layerWorkflow, /--prerelease=false/u);
  assert.match(layerWorkflow, /--latest(?:\s|\\|$)/u);
  assert.match(layerWorkflow, /release:github:metadata:apply/u);
});
