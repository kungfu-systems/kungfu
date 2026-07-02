// Minimal kfx shape for the reference app's built-in default extensions.
//
// This is deliberately an internal module, not a published contract: the
// platform's loose kfx contract (mount points + capability handles +
// contribution declarations) is grown from real consumers, and these two
// defaults are the first ones. The shape mirrors the intended contract so
// that externalizing it later is a move, not a rewrite.
import type React from 'react';
import type { Kfe } from './runtime';

// Capability handles the host hands to a kfx view. A kfx never reaches for
// globals; everything it may touch comes through this object.
export type KfxCapabilities = {
  kfe: Kfe;
  runtimeDir: string;
};

export type KfxManifest = {
  id: string;
  title: string;
  // FA layering: a kfx that wants in-process zero-copy runtime data must
  // declare it runs in the node-integrated context. A future serialized-IPC
  // tier would use a different value and never share this renderer.
  runtime: 'node-integrated';
  View: React.ComponentType<{ caps: KfxCapabilities }>;
};
