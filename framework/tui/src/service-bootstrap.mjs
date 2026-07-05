// The production node service bootstrap: it runs INSIDE the OS sandbox, connects
// the stdio capability relay, and runs the discovered service's node body. Its
// only egress is the relay on stdout/stdin; diagnostics MUST go to stderr — the
// child's stdout is the relay, and anything else written there corrupts it.
//
// This is the production sibling of the guest-harness node-child: that one loads
// an arbitrary facet under a dev TS-resolver hook to exercise the contract; this
// loads a real service's shipped node entry (KFX_SERVICE_ENTRY, an absolute path
// the host resolved from the plan entry) with no dev tooling. The body exports
// `run(caps)` and uses only its declared capabilities — the same async surface
// it would see co-resident, so its source never branches on the trust tier.
import { pathToFileURL } from 'node:url';

import { connectStdio } from '@kungfu-tech/api/capability';

const declared = JSON.parse(process.env.KFX_DECLARED ?? '[]');
const entryPath = process.env.KFX_SERVICE_ENTRY;

if (!entryPath) {
  process.stderr.write('[service-bootstrap] KFX_SERVICE_ENTRY is not set\n');
  process.exit(1);
}

const { caps, close } = connectStdio(declared);
try {
  const service = await import(pathToFileURL(entryPath).href);
  if (typeof service.run !== 'function') {
    throw new Error('service entry does not export a run(caps) function');
  }
  await service.run(caps);
} catch (err) {
  process.stderr.write(`[service-bootstrap] ${err?.stack ?? err}\n`);
  process.exitCode = 1;
} finally {
  close();
}
