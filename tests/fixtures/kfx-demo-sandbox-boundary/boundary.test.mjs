// SPDX-License-Identifier: Apache-2.0
// Gate for the sandboxed-ipc capability boundary: a view reaches only the
// capabilities its manifest declared, an undeclared capability is rejected at
// the host, and subscriptions bridge back. Headless — the enforcement logic
// under framework/api/src/capability/sandbox.ts; the live in-Electron isolation
// (node stripped) is proven separately by the electron harness.
import { createCapabilityHost, createCapabilityGuest } from '../../../framework/api/src/capability/sandbox.ts';

let emitted = null;
const realCaps = {
  rewind: { runs: () => ['run-A', 'run-B'] },
  ledger: { subscribe: (cb) => { emitted = cb; return { stop: () => { emitted = null; } }; } },
};
function connect(declared) {
  let onEvent = null;
  const host = createCapabilityHost(realCaps, declared, (e) => onEvent && onEvent(e));
  const guest = createCapabilityGuest(declared, {
    invoke: (req) => host.handle(req),
    onEvent: (fn) => { onEvent = fn; return () => { onEvent = null; }; },
  });
  return { host, guest };
}
const fails = [];
const ck = (n, ok) => { console.log(`  ${ok ? 'ok' : 'FAIL'}  ${n}`); if (!ok) fails.push(n); };

const { guest } = connect(['rewind']);
ck('declared capability present', 'rewind' in guest);
ck('undeclared capability absent', !('ledger' in guest));
const runs = await guest.rewind.runs();
ck('declared call forwards + returns', JSON.stringify(runs) === JSON.stringify(['run-A', 'run-B']));
const { host } = connect(['rewind']);
let rejected = false;
try { await host.handle({ cap: 'ledger', method: 'subscribe', args: [] }); } catch { rejected = true; }
ck('forged undeclared-capability call rejected', rejected);
const { guest: g2 } = connect(['ledger']);
const got = [];
await g2.ledger.subscribe((n) => got.push(n));
emitted?.(7); emitted?.(9);
await new Promise((r) => setTimeout(r, 5));
ck('subscription bridges host->guest', JSON.stringify(got) === JSON.stringify([7, 9]));

if (fails.length) { console.log(`sandbox boundary check failed: ${fails}`); process.exit(1); }
console.log('sandbox boundary check passed');
