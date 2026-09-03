// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
const PUBLISHER = fileURLToPath(
  new URL('./publish-alpha-run.mjs', import.meta.url),
);

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
      name: 'Kungfu',
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
    'scripts/publish-alpha-run.mjs',
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
  assert.match(alphaPublication, /gh\(\[\s*'release',\s*'create'/u);
  assert.match(alphaPublication, /gh\(\['release', 'upload'/u);
  assert.match(alphaPublication, /'release',\s*'edit'/u);
  assert.match(alphaPublication, /'--draft=false'/u);
  assert.match(alphaPublication, /'--prerelease=false'/u);
  assert.match(alphaPublication, /'--latest'/u);
  assert.doesNotMatch(productWorkflow, /release:github:latest:verify/u);
  assert.doesNotMatch(productWorkflow, /release:github:metadata:apply-newest/u);
  assert.match(alphaPublication, /kungfu-cli-/u);
  assert.match(alphaPublication, /retired product artifact name/u);
  assert.match(
    alphaPublication,
    /Kungfu-\\d\+\\\.\\d\+\\\.\\d\+\.\*-macos-arm64/u,
  );
  assert.doesNotMatch(productWorkflow, /Kungfu-\*-macos-arm64\.(?:dmg|zip)/u);
  assert.match(alphaPublication, /Kungfu Setup /u);
  assert.match(alphaPublication, /Kungfu\.Setup\./u);
  assert.doesNotMatch(
    alphaPublication,
    /Kungfu Episodes Setup|Kungfu Episodes-|Kungfu-Episodes-/u,
  );
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

test('Alpha publisher rejects a retired CLI artifact before creating a release', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-alpha-publisher-'),
  );
  try {
    const bin = path.join(root, 'bin');
    const calls = path.join(root, 'gh-calls.jsonl');
    fs.mkdirSync(bin, { recursive: true });
    const fakeGh = path.join(bin, 'gh');
    fs.writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args[1].includes('/actions/runs/')) {
  if (args[1].endsWith('/artifacts?per_page=100')) console.log(JSON.stringify({ artifacts: [] }));
  else console.log(JSON.stringify({ conclusion: 'success' }));
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'download') {
  const destination = args[args.indexOf('--dir') + 1];
  fs.mkdirSync(destination, { recursive: true });
  if (args.includes('--pattern')) {
    fs.writeFileSync(path.join(destination, 'release-candidate-passport.json'), JSON.stringify({
      target: { version: '4.0.0-alpha.6' },
      platformMatrix: [{ artifactName: 'darwin-artifacts' }],
      pullRequest: { number: 3694 }
    }));
  } else {
    fs.writeFileSync(path.join(destination, 'Kungfu-4.0.0-alpha.6-macos-arm64.dmg'), 'desktop');
    fs.writeFileSync(path.join(destination, 'kungfu-episodes-cli-darwin-arm64.tar.gz'), 'retired-cli');
  }
  process.exit(0);
}
console.error('unexpected fake gh call: ' + JSON.stringify(args));
process.exit(97);
`,
    );
    fs.chmodSync(fakeGh, 0o755);
    const result = spawnSync(process.execPath, [PUBLISHER, '123'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_REPO: REPOSITORY,
        FAKE_GH_CALLS: calls,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        RUNNER_TEMP: root,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /retired product artifact name/u);
    const invoked = fs
      .readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      invoked.some((args) => args[0] === 'release'),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
