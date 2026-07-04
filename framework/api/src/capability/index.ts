// Capability SDK (ADR-0011) — factory-style handles over an injected native
// binding, no import-time side effects. See types.ts for the injection
// contract and the two vocabulary domains.
export * from './types';
export * from './ledger';
export * from './domain';
export * from './rewind';
export * from './schema';
export * from './sandbox';
export * from './terminal';
export * from './work';

// The runtime-plane trust boundary (ADR-0013 / ADR-0014): the OS-sandbox
// launcher, the child-process relay transport, the Node child-side guest proxy,
// and the binding-less host that composes them into the uniform capability
// surface across trust tiers. subprocess.ts re-declares HostRequest/HostEvent
// structurally to stay decoupled; those names are already exported from
// ./sandbox, so only the transport's own names are re-exported here to avoid an
// ambiguous star-export.
export * from './sandbox-launcher';
export { serveSubprocessCapabilities } from './subprocess';
export type {
  RelayHost,
  SubprocessChannel,
  SubprocessHost,
} from './subprocess';
export * from './guest-node';
export * from './kungfu-guest';
