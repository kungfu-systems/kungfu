// The TUI host's half of dual-entry kfx loading (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be): discover + decide
// with the SAME host-agnostic planKfx the gui uses, so both hosts reach an
// identical trust/tier verdict for the same kfx — the "one load rule, two hosts"
// the ADR pins. The only difference from the gui is where the fs/path/crypto
// handles come from: the gui renderer injects its window.require('node:…')
// handles, while the TUI is a plain Node process and passes the node: modules
// directly. planKfx instantiates nothing, so this is the whole of the TUI's
// loading — no DOM, no renderer.
//
// Landing is deliberately NOT here. The gui lands a view by evaluating its
// bundle into the renderer DOM; a kfx view is DOM-React (divs, CSS), which the
// Ink TUI cannot mount — rendering a view body in the terminal needs a
// DOM↔Ink view-portability layer that does not exist yet (a separate follow-up).
// So the TUI consumes the plan to SURFACE what was discovered (and, per stage
// 2d, to land services), not to render view bodies.
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { type KfxLoadPlan, type KfxPlanDeps, planKfx } from '@kungfu-tech/kfx';

const deps: KfxPlanDeps = {
  fs: nodeFs as unknown as KfxPlanDeps['fs'],
  path: nodePath,
  crypto: nodeCrypto as unknown as KfxPlanDeps['crypto'],
};

// Discover and decide the kfx plan for the TUI host. Same rule, same verdict as
// the gui's planKfx call; a missing extension root simply yields an empty plan,
// so this never throws on a host with no kfx installed.
export function loadTuiKfxPlan(
  env: Record<string, string | undefined> = process.env,
): KfxLoadPlan {
  return planKfx(env, deps);
}
