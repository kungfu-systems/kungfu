// Kept as a source-boundary forwarding module because repository authority
// scanners retain this historical path in changed-file closure. The former
// one-shot full-federation CLI transport is gone; the app uses the durable
// main-process observer host exclusively.
export * from './global-work-observer-host';
