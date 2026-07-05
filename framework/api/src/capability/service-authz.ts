// Service authorization → sandbox profile (ADR-0017 open-question-1 resolution).
//
// A background service (config.service) that the trust verdict left UNTRUSTED
// lands in the OS sandbox under a default-deny profile (ADR-0013): no network,
// no writes. What relaxes that sandbox is not the kfx — a manifest can no more
// grant itself the network than a view manifest can elevate its own tier — but
// the USER, through a grant persisted in the same runtime-home ConfigStore that
// already holds shell state (disabledKfx / settings). No second settings system.
//
// The grant stacks in three layers, each later one overriding the earlier:
//   1. a restrictive global default (deny network + write) — never stored, it is
//      the base of the stack, so an ungranted service is fully confined;
//   2. an optional operator-wide relaxation (globalAllow) applied to every
//      untrusted service;
//   3. a per-kfx override keyed by the kfx `key`.
//
// Two boundaries the ADR welds are enforced HERE, structurally rather than by
// convention:
//   - A grant tunes the PROFILE, never the TIER. resolveServiceLanding short-
//     circuits a trusted service to co-resident BEFORE any grant is read, so no
//     stored grant can loosen a trusted service (it has no sandbox to loosen) or
//     promote an untrusted one (its tier is fixed by the verdict, not the grant).
//   - Allowing an untrusted third party onto the network is the user actively
//     removing default-deny; the resolved landing surfaces `networkConsent` so a
//     host applies it only behind informed consent and an audit can see the
//     network is open. (The consent prompt itself is the host's; see below.)
//
// The network knob is coarse and platform-asymmetric by design (macOS/Linux are
// all-or-nothing, Windows can split public/LAN) — that asymmetry lives in
// sandbox-launcher.ts, which this profile feeds; a grant expresses intent
// ("allow the network"), the launcher maps it to the platform capability.
import type { DomainState } from './domain.js';
import type { SandboxProfile } from './sandbox-launcher.js';

// What a grant may relax. An absent field inherits the layer below; the base of
// the stack denies everything, so the fully-default service is default-deny.
export type ServiceGrant = {
  network?: boolean;
  write?: boolean;
};

// The stored authorization. Layer 1 (the restrictive global default) is implicit
// and never persisted — it is the base every resolution starts from.
export type ServiceAuthz = {
  // layer 2 — an operator relaxation applied to every untrusted service
  globalAllow?: ServiceGrant;
  // layer 3 — per-kfx overrides, keyed by the kfx `key`
  perKfx?: Record<string, ServiceGrant>;
};

// The landing a host applies to a discovered service. A trusted service runs
// co-resident (zero-copy, no sandbox); an untrusted one is confined under the
// resolved profile. `networkConsent` is true when the profile opens the network,
// the flag a host gates behind informed consent.
export type ServiceLanding =
  | { tier: 'co-resident' }
  | { tier: 'sandbox'; profile: SandboxProfile; networkConsent: boolean };

// Stack the three layers into an effective grant for one kfx key. Layer 1 is the
// restrictive base; globalAllow and the per-kfx override each override it.
function resolveGrant(
  authz: ServiceAuthz,
  key: string,
): { network: boolean; write: boolean } {
  const g: ServiceGrant = {
    ...authz.globalAllow,
    ...authz.perKfx?.[key],
  };
  return { network: g.network === true, write: g.write === true };
}

// Resolve how a host should land a service, given the trust verdict and the
// stored grants. This is the single seam that keeps the tier un-pierceable: a
// trusted service returns co-resident WITHOUT consulting any grant, so a grant
// can only ever tune an already-untrusted service's sandbox profile.
export function resolveServiceLanding(
  authz: ServiceAuthz,
  key: string,
  trusted: boolean,
): ServiceLanding {
  if (trusted) return { tier: 'co-resident' };
  const grant = resolveGrant(authz, key);
  return {
    tier: 'sandbox',
    // start from the restrictive disposition and open only what the grant allows;
    // an ungranted service denies network and write (default-deny, ADR-0013).
    profile: {
      base: 'restrictive',
      denyNetwork: !grant.network,
      denyWrite: !grant.write,
    },
    networkConsent: grant.network,
  };
}

// ── persistence: the same ConfigStore shell state uses ───────────────────────

// One JSON blob in the runtime home's ConfigStore, beside shell state. The CLI,
// the GUI and agent APIs read and write the same authorization — no host holds a
// private grants file.
export const SERVICE_AUTHZ_LOCATION = {
  category: 'system',
  group: 'shell',
  name: 'service-authz',
  mode: 'live',
} as const;

const EMPTY_AUTHZ: ServiceAuthz = {};

function sanitizeGrant(value: unknown): ServiceGrant {
  if (!value || typeof value !== 'object') return {};
  const g = value as Record<string, unknown>;
  const out: ServiceGrant = {};
  if (typeof g.network === 'boolean') out.network = g.network;
  if (typeof g.write === 'boolean') out.write = g.write;
  return out;
}

// Read the stored authorization. An absent or unreadable blob yields the empty
// authorization, which resolves every untrusted service to default-deny — the
// safe direction, exactly like shell state defaulting on unreadable input.
export function loadServiceAuthz(domain: DomainState): ServiceAuthz {
  try {
    const entry = domain
      .configs()
      .find(
        (row) =>
          row.location.category === SERVICE_AUTHZ_LOCATION.category &&
          row.location.group === SERVICE_AUTHZ_LOCATION.group &&
          row.location.name === SERVICE_AUTHZ_LOCATION.name,
      );
    if (!entry) return EMPTY_AUTHZ;
    const parsed = JSON.parse(entry.value) as Partial<ServiceAuthz>;
    const perKfx: Record<string, ServiceGrant> = {};
    if (parsed.perKfx && typeof parsed.perKfx === 'object') {
      for (const [key, grant] of Object.entries(parsed.perKfx)) {
        perKfx[key] = sanitizeGrant(grant);
      }
    }
    return {
      globalAllow: parsed.globalAllow
        ? sanitizeGrant(parsed.globalAllow)
        : undefined,
      perKfx,
    };
  } catch {
    // unreadable authorization never blocks boot; default-deny always applies
    return EMPTY_AUTHZ;
  }
}

// Persist the authorization. A host writes this only after obtaining informed
// consent for any newly-opened network grant (resolveServiceLanding.networkConsent
// marks which landings that covers).
export function saveServiceAuthz(
  domain: DomainState,
  authz: ServiceAuthz,
): void {
  domain.setConfig(SERVICE_AUTHZ_LOCATION, JSON.stringify(authz));
}
