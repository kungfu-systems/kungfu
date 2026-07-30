// A background-SERVICE facet (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be): unlike the view/adapter facets, this is
// a kfx's own long-lived process that reaches OUT to the network and reaches the
// host only over the capability relay. This one source runs unchanged whether the
// OS sandbox allows the network or denies it — it never branches on the profile.
//
// It does two independent things in one pass, which is the whole point of the
// stage-2b vertical cut:
//   1. a real outbound network egress (fetch an external endpoint) — exercises
//      the OS-sandbox membrane's network rule;
//   2. a real capability call over the stdio relay (ledger.records) — exercises
//      the relay, which rides the child's stdio and is independent of the network.
// It then reports BOTH outcomes back over the relay (report.result), so the host
// can prove: egress works when the profile allows it, egress is refused when the
// profile denies it, and the relay flows either way.
const NET_URL = process.env.KFX_NET_URL ?? 'https://example.com';

export async function run(caps) {
  // (1) network egress through the sandbox membrane.
  let networkOk = false;
  let httpStatus = 0;
  let netError = null;
  try {
    const res = await fetch(NET_URL, { signal: AbortSignal.timeout(10_000) });
    httpStatus = res.status;
    // drain the body so the connection actually completes end to end.
    await res.text();
    networkOk = res.ok;
  } catch (err) {
    netError = String(err?.cause?.code ?? err?.name ?? err?.message ?? err);
  }

  // (2) a capability call over the relay — must succeed regardless of the
  // network knob, because the relay rides stdio, not the network.
  const records = await caps.ledger.records({ limit: 3 });

  // report over the relay (another relay call): its delivery is itself proof the
  // relay flowed.
  await caps.report.result({
    facet: 'service',
    url: NET_URL,
    networkOk,
    httpStatus,
    netError,
    relayRecordCount: records.length,
  });
}
