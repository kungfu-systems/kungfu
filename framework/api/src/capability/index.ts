// Capability SDK (ADR-0011) — factory-style handles over an injected native
// binding, no import-time side effects. See types.ts for the injection
// contract and the two vocabulary domains.
export * from './types.js';
export * from './ledger.js';
export * from './domain.js';
export * from './rewind.js';
export * from './remote.js';
export * from './schema.js';
export * from './sandbox.js';
export * from './terminal.js';
export * from './work.js';
export * from './workspace.js';
export * from './storage.js';
export * from './exit.js';
export * from './query.js';
export * from './profile.js';
export * from './agent-runtime.js';
export * from './agent-console.js';
export * from './agent-session.js';
export * from './runtime.js';

// The runtime-plane trust boundary (ADR-0013 / ADR-0014): the OS-sandbox
// launcher, the child-process relay transport, the Node child-side guest proxy,
// and the binding-less host that composes them into the uniform capability
// surface across trust tiers. subprocess.ts re-declares HostRequest/HostEvent
// structurally to stay decoupled; those names are already exported from
// ./sandbox, so only the transport's own names are re-exported here to avoid an
// ambiguous star-export.
export * from './sandbox-launcher.js';
export { serveSubprocessCapabilities } from './subprocess.js';
export type {
  RelayHost,
  SubprocessChannel,
  SubprocessHost,
} from './subprocess.js';
export * from './guest-node.js';
export * from './kungfu-guest.js';
export * from './guest-windows.js';
// The service-authorization → sandbox-profile resolver (ADR-0017): the user
// grant that tunes an untrusted service's OS-sandbox profile without piercing
// its trust tier, persisted in the same ConfigStore as shell state.
export * from './service-authz.js';
