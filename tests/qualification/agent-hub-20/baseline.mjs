#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adapterPath,
  exactRequests,
  parseOptions,
  privateHomeSnapshot,
  productIdentity,
  runAdapter,
  semanticRoot,
  sha256,
  validateKfdPackage,
} from './lib.mjs';

function main() {
  const selected = parseOptions(process.argv.slice(2), {
    outputName: 'the first baseline',
  });
  if (fs.existsSync(selected.output)) {
    throw new Error(
      `baseline is append-only and already exists: ${selected.output}`,
    );
  }
  const { lock, observed } = validateKfdPackage(selected.kfdRoot);
  const { handshake, vectors } = exactRequests(selected.kfdRoot);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-agent-hub-first-baseline-'),
  );
  const before = privateHomeSnapshot();
  const requests = [handshake, ...vectors.map(({ request }) => request)];
  const responses = runAdapter({
    kungfu: selected.kungfu,
    root,
    requests,
  });
  const after = privateHomeSnapshot();
  const byId = new Map(
    responses.map((response) => [response.requestId, response]),
  );
  const results = vectors.map(({ request, expect }) => {
    const response = byId.get(request.requestId);
    const actual = {
      status: response?.status ?? 'missing',
      code: response?.code ?? 'adapter-response-missing',
      verdict: response?.verdict ?? 'not-applicable',
    };
    return {
      id: request.requestId,
      expected: expect,
      actual,
      status:
        JSON.stringify(actual) === JSON.stringify(expect) ? 'pass' : 'fail',
      responseRoot: semanticRoot(response ?? {}),
    };
  });
  const passed = results.filter(({ status }) => status === 'pass').length;
  const transcript = requests.map((request) => ({
    request,
    response: byId.get(request.requestId) ?? null,
  }));
  const report = {
    schema: 'kungfu.kfd-agent-hub-first-baseline/v1',
    retained: true,
    replacementAllowed: false,
    kfd: { lock, observed },
    adapter: {
      path: 'tests/qualification/agent-hub-20/adapter.mjs',
      artifactDigest: sha256(fs.readFileSync(adapterPath)),
      sourceClassification: 'product-command-forwarder',
    },
    product: productIdentity(selected.kungfu),
    isolation: {
      qualificationRootClass: 'disposable-dual-hub-root',
      sourceHomeClass: 'hub-alpha/.kungfu',
      targetHomeClass: 'hub-beta/.kungfu',
      homesDistinct: true,
      realHomeBefore: before,
      realHomeAfter: after,
      realHomeUnchanged: semanticRoot(before) === semanticRoot(after),
    },
    execution: {
      offline: true,
      requestCount: requests.length,
      responseCount: responses.length,
      transcriptRoot: semanticRoot(transcript),
      resultRoot: semanticRoot(results),
    },
    coverage: { total: 20, passed, failed: 20 - passed },
    valid: passed === 20,
    results,
    risk: [
      'The installed product did not yet expose the product-owned Agent Hub handle surface.',
      'This retained failure baseline is not a KFD conformance report and cannot qualify or promote a release.',
      'The baseline proves only that the exact adapter attempted every fixed request against the installed product without touching the real Kungfu home.',
    ],
  };
  fs.writeFileSync(selected.output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  process.stdout.write(
    `Kungfu KFD Agent Hub first baseline: ${passed}/20 -> ${selected.output}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`agent-hub first baseline: ${error.message}\n`);
  process.exitCode = 2;
}
