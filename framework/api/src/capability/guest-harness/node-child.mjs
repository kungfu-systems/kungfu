// The sandboxed Node child bootstrap: it runs INSIDE the OS sandbox, builds its
// declared capability object from the stdio relay (connectStdio — the Node guest
// proxy this delivery adds), imports the facet, and runs it. Its only egress is
// the relay on stdout/stdin; diagnostics go to stderr. Launch it under the TS
// resolver hook so the capability SDK source loads unchanged:
//   node --import ./ts-resolve.mjs node-child.mjs
import { pathToFileURL } from 'node:url';

import { connectStdio } from '../guest-node.ts';

const declared = JSON.parse(process.env.KFX_DECLARED ?? '[]');
const facetPath = process.env.KFX_FACET;

const { caps, close } = connectStdio(declared);
try {
  const facet = await import(pathToFileURL(facetPath).href);
  await facet.run(caps);
} catch (err) {
  process.stderr.write(`[node-child] ${err?.stack ?? err}\n`);
  process.exitCode = 1;
} finally {
  close();
}
