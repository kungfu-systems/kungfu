// The trusted host's real capability surface for the guest-host harness, built
// from an injected in-memory binding (ADR-0011: the SDK never loads the native
// binding; the host injects it). This exercises the real ledger capability code
// path — openLedger().records() — without a live journal, so the harness proves
// the execution contract and the transport property, not the trading engine.
//
// `ledger.records()` returns LedgerRecord[] whose genTime is a bigint. That is
// the zero-copy probe: the trusted in-process tier returns it by reference with
// the bigint intact; the sandbox relay serializes it (bigintSafe → a decimal
// string). A facet computes typeof genTime from what it received, so the same
// source reports 'bigint' co-resident and 'string' sandboxed — the transport
// difference the uniform surface is designed to hide from the developer.
//
// `report` is the harness output sink: a facet delivers its result by calling
// report.result(obj) in BOTH tiers, so its source never branches on the tier.
import type { KfNativeBinding } from '../types';
import { type Ledger, openLedger } from '../ledger';

const FIXTURE_FRAMES = [
  { genTime: 1_700_000_000_000_000_001n, msgType: 101, source: 11, dest: 21 },
  { genTime: 1_700_000_000_000_000_002n, msgType: 102, source: 12, dest: 22 },
  { genTime: 1_700_000_000_000_000_003n, msgType: 103, source: 13, dest: 23 },
];

// A minimal KfNativeBinding: only Assemble is exercised (records()); the other
// constructors are present to satisfy the type but unused by this harness.
function fixtureBinding(): KfNativeBinding {
  class Assemble {
    private i = 0;
    private readonly frames = FIXTURE_FRAMES;
    constructor(_runtimeDirs: string[]) {}
    dataAvailable(): boolean {
      return this.i < this.frames.length;
    }
    next(): void {
      this.i += 1;
    }
    currentFrame() {
      const f = this.frames[this.i];
      return {
        genTime: () => f.genTime,
        triggerTime: () => f.genTime,
        msgType: () => f.msgType,
        source: () => f.source,
        dest: () => f.dest,
        dataLength: () => 0,
        dataBytes: () => new Uint8Array(0),
      };
    }
  }
  return { Assemble } as unknown as KfNativeBinding;
}

export type ReportSink = {
  result: (value: Record<string, unknown>) => void;
};

export type FixtureCaps = {
  caps: { ledger: Ledger; report: ReportSink };
  declared: readonly string[];
  readReport: () => Record<string, unknown> | null;
};

export function buildFixtureCaps(): FixtureCaps {
  let reported: Record<string, unknown> | null = null;
  const ledger = openLedger({
    binding: fixtureBinding(),
    locator: { runtimeDir: '/tmp/kfx-guest-harness-fixture' },
  });
  const report: ReportSink = {
    result(value) {
      reported = value;
    },
  };
  return {
    caps: { ledger, report },
    declared: ['ledger', 'report'],
    readReport: () => reported,
  };
}
