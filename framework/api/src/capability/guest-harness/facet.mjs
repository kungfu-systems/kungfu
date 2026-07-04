// A JavaScript facet — a real extension written once against the uniform
// asynchronous capability surface (ADR-0014). This exact source runs unchanged
// in both trust tiers: co-resident (in-process, zero-copy) and sandboxed (an
// OS-sandboxed child reaching the host over the stdio relay). It never branches
// on which tier it is running in.
//
// What it observes IS the transport difference the contract hides from the
// author: it reads records from the ledger capability and reports the runtime
// type of a 64-bit genTime. Co-resident it is a bigint (returned by reference);
// sandboxed it is a decimal string (the relay serialized it). The facet does not
// know or care — it just calls the same async method and reports what it got.
export async function run(caps) {
  const records = await caps.ledger.records({ limit: 3 });
  const health = await caps.ledger.health();
  const first = records[0];
  await caps.report.result({
    facet: 'js',
    recordCount: records.length,
    firstGenTime: String(first.genTime),
    genTimeType: typeof first.genTime,
    joined: health.joined,
  });
}
