// A dogfood background service (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be): the first real config.service kfx
// body, shaped after an OpenClaw-style agent — a long-lived process that reaches
// OUT to an external chat/LLM endpoint and reaches the host only over the
// capability relay. The chat/LLM is just the carrier; what this exercises is the
// service facet on the OS-sandbox plane end to end: discovery → plan → the user's
// authorization → landing → relay.
//
// It is tier-agnostic on purpose: this same source runs co-resident (trusted, in
// the host process) or in an OS sandbox (untrusted, over the stdio relay). It
// never branches on how it was landed — it just uses the async capabilities it
// was given and reaches the network. Whether that network reach succeeds is the
// user's grant talking to the sandbox membrane, not this body's concern.
const ENDPOINT = process.env.KFX_NET_URL ?? 'https://example.com';

export async function run(caps) {
  // reach out to the external endpoint (the "chat service" an OpenClaw agent
  // notifies through). Confined by the sandbox membrane when untrusted.
  let reachedNetwork = false;
  let netError = null;
  try {
    const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(10_000) });
    await res.text();
    reachedNetwork = res.ok;
  } catch (err) {
    netError = String(err?.cause?.code ?? err?.name ?? err?.message ?? err);
  }

  // reach the host over the relay (read recorded runs, as an agent would to
  // decide what to notify about). Flows regardless of the network grant.
  const records = await caps.ledger.records({ limit: 3 });

  // report the outcome to the host (itself a relay call — its delivery proves
  // the relay carried the service's work back).
  await caps.report.result({
    facet: 'service',
    kind: 'dogfood-openclaw',
    endpoint: ENDPOINT,
    reachedNetwork,
    netError,
    relayRecordCount: records.length,
  });
}
