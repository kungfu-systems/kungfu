// The kfx view contract: the types a view extension implements and the shell
// consumes, plus the shared UI tokens. This package is bundled INTO each view
// extension (it is types and plain style objects — nothing stateful), while
// React and the public `@kungfu-tech/api` entrypoints stay external and are
// injected by the shell at load time, so every kfx shares the shell's React
// instance and capability/query surfaces. The exact list lives in
// `framework/kfx/shared-modules.json`.
//
// Static facts about a view (title, capabilities, settings, system flag)
// live in the package manifest (`kungfuConfig.config.view`), never in code:
// managers and installers read them without executing the extension. The
// code side exports exactly one thing — the View component.
import type {
  AgentRuntime,
  AgentSession,
  DomainState,
  Ledger,
  Profile,
  Rewind,
  RuntimeProductStatus,
  Storage,
  Terminal,
  Work,
  WorkspaceGuidance,
} from '@kungfu-tech/api/capability';
import Ajv2020 from 'ajv/dist/2020.js';
import type React from 'react';

// Re-export the terminal session types a view needs to build its own UI (pane
// snapshots, discovery, spawn options). The view contract package is the one
// place a view imports from, so it should surface these rather than making a
// view reach into @kungfu-tech/api directly.
export type {
  AgentConsoleEnvelope,
  AgentConsoleLaunch,
  AgentBackend,
  AgentProvider,
  AgentRuntime,
  AgentSession,
  AgentRuntimeCatalog,
  AgentRuntimeProfile,
  AgentRuntimeProfileInput,
  AgentRuntimeVerification,
  WorkRef,
  AdoptSpec,
  ConfigEntry,
  DiscoveredSession,
  DomainState,
  KfLocation,
  Terminal,
  TerminalBackend,
  TerminalExit,
  TerminalSession,
  TerminalSpawnOptions,
  TerminalStatus,
  QueryChangelogMessage,
  QueryChangelogPage,
  QueryChangelogState,
  QueryDefinition,
  RuntimeError,
  RuntimeHandle,
  RuntimeLease,
  RuntimeOperation,
  RuntimeOperationCatalog,
  RuntimeProductStatus,
  RuntimeReadiness,
  QueryFrontier,
  GenericQueryViewSpec,
  QueryResumeToken,
  QueryResultSchema,
  QueryViewDiagnosis,
  QueryViewInspection,
  QueryViewSpec,
  ManagedProfile,
  ProfileApplicationProjection,
  ProfileKfd3QualificationReceipt,
  ProfileKfd3Verification,
  ProfileAssessmentPlan,
  ProfileAssessmentReceipt,
  ProfileIntentPlan,
  ProfileLifecyclePlan,
  ProfileManagerProjection,
  ProfileMemberReceipt,
  ProfileQueryPlan,
  ProfileQueryReceipt,
  ProfileQueryViewSpec,
  SavedQueryCatalog,
  SavedQueryEntry,
  SavedQueryView,
  SavedQueryViewInspection,
} from '@kungfu-tech/api/capability';
export {
  buildAgentConsoleEnvelope,
  buildWorkRef,
  prepareAgentConsoleLaunch,
} from '@kungfu-tech/api/capability';
export {
  applyQueryChangelogPage,
  emptyQueryChangelogState,
  inspectSavedQueryView,
  parseSavedQueryView,
  queryRows,
} from '@kungfu-tech/api/query';

// ── capability surface ────────────────────────────────────────────────────

export type KfxCapabilities = {
  ledger: Ledger;
  domain: DomainState;
  rewind: Rewind;
  storage: Storage;
  terminal: Terminal;
  work: Work;
  profile?: Profile;
  agentRuntime?: AgentRuntime;
  agentSession?: AgentSession;
  workspace?: WorkspaceGuidance;
};

export type KfxCapabilityKey = keyof KfxCapabilities;

// ── manifest data (package.json `kungfuConfig`) ───────────────────────────

// A settings entry a view contributes to the shell's Settings view. Values
// are strings; the shell persists them in the runtime home's ConfigStore.
export type KfxSettingDecl = {
  key: string;
  label: string;
  fallback: string;
};

// Product composition is declared by the KFX package, then projected by each
// host. Roles describe where a replaceable product surface participates; they
// never grant capabilities, trust, or runtime authority. `boot-critical` is an
// availability/recovery hint only.
export type KfxProductRole =
  | 'profile-view'
  | 'agent-console'
  | 'system-management'
  | 'tool'
  | 'devtool'
  | 'boot-critical';

export type KfxProductDecl = {
  roles: KfxProductRole[];
  icon?: string;
  order?: number;
};

// `kungfuConfig.config.view` — the static half of a view extension.
// ADR-0011 trust tier. `node-integrated` (trusted) shares the shell's renderer,
// React and capability instances; `sandboxed-ipc` runs the view in an isolated
// renderer with no node, reaching only its declared capabilities over IPC.
export type KfxRuntimeTier = 'node-integrated' | 'sandboxed-ipc';

export type KfxViewDecl = {
  title: string;
  // capability handles this view receives; undeclared handles stay absent
  capabilities: KfxCapabilityKey[];
  // trust tier hint (default node-integrated). The source-authority verdict is
  // authoritative over this hint: an unauthorized package is never elevated
  // above sandboxed-ipc just because its manifest asks for node-integrated.
  runtime?: KfxRuntimeTier;
  // shell-owned views (settings, kfx manager, status); not disableable
  system?: boolean;
  // settings this view contributes to the shell Settings view
  settings?: KfxSettingDecl[];
  // bundle entry relative to the package root (default: dist/view/index.js)
  entry?: string;
};

// The frozen first-party set (ADR-0013): the build-time record of which
// extension identities are trusted. It maps a kfx `key` to an integrity pin —
// a sha256 of the loaded bundle, or `null` when the key is trusted without a
// content pin (development source builds, whose bundle changes on every
// rebuild). Trust is granted by membership in this set — a verifiable origin —
// never by which filesystem root a package happened to load from.
export type FirstPartyPin = { sha256: string | null };
export type FirstPartyManifest = {
  version: 1;
  keys: Record<string, FirstPartyPin>;
};

// The source-authority verdict (ADR-0013, decision C): is this package an
// authorized first-party extension? The frozen-set check below is the first
// verdict implementation; a signature check can be added as a second without
// changing `resolveRuntimeTier` or its caller — the verdict is the pluggable
// seam. A `null` manifest (none shipped) trusts nothing: safe by default, and
// deliberately NOT a fallback to path-based trust.
export function authorizeFirstParty(
  manifest: FirstPartyManifest | null,
  key: string,
  contentHash: string | null,
): boolean {
  const pin = manifest?.keys[key];
  if (!pin) return false; // key is not in the frozen first-party set
  if (pin.sha256 === null) return true; // trusted by key alone (dev / unpinned)
  return pin.sha256 === contentHash; // pinned: bundle content must match
}

// The single source of the trust decision: what tier a loaded view runs at. A
// system view, or a package the source-authority verdict authorized as
// first-party (`authorizeFirstParty` — never a filesystem path), is
// node-integrated; everything else is sandboxed. The manifest's `runtime` hint
// may only keep a view sandboxed, never elevate it.
export function resolveRuntimeTier(
  view: Pick<KfxViewDecl, 'runtime' | 'system'>,
  trusted: boolean,
): KfxRuntimeTier {
  if (view.system || trusted) return 'node-integrated';
  // untrusted third-party: sandboxed by default; the manifest cannot elevate
  return 'sandboxed-ipc';
}

// `kungfuConfig.config.adapter` — a runtime facet. Unlike a view (a GUI screen
// the shell loads), an adapter is capture-side instrumentation: the trace
// supervisor discovers it, and injects it into the traced child, where it
// patches a framework's seam so unmodified runs are captured. It ships source
// per child runtime (nothing to bundle), not a `dist/view` artifact.
export type KfxAdapterDecl = {
  // module import names whose import triggers the patch (informative)
  targets: string[];
  // child runtimes this adapter instruments
  runtimes: ('python' | 'node')[];
  // adapter entry per runtime, relative to the package root
  entry: { python?: string; node?: string };
  // capture-side capabilities the adapter needs; undeclared stay absent — the
  // same permission seam a view's `capabilities` is (reserved for enforcement)
  capabilities?: string[];
};

// A service ships a body per runtime; C++ joins Python and Node here — a
// sandboxed C++ service reaches the host through the capability relay's native
// guest end (ADR-0017).
export type KfxServiceRuntime = 'python' | 'node' | 'cpp';

// The C++ service entry is a PREBUILT per-platform binary, not a source path —
// the shape that resolved ADR-0017's open question. Python and Node ship source
// an already-resident interpreter loads at launch; C++ has no interpreter, and
// kfc deliberately does not absorb a C++ toolchain, so the host cannot compile
// at launch. A C++ service therefore ships a binary its author cross-compiled
// (linking the guest proxy, framework/core/src/capability/guest.hpp), and
// `entry.cpp` maps each supported platform to that binary's path, relative to
// the package root. The host picks the current platform's binary and launches it
// directly, with no bootstrap; a platform absent from the map is unsupported.
export type KfxServiceCppEntry = {
  darwin?: string;
  linux?: string;
  win?: string;
};

// `kungfuConfig.config.service` — a background-process kfx (ADR-0017). Unlike a
// view (a rendered screen the shell mounts) or an adapter (capture-side
// instrumentation injected into *another* process), a service is a kfx's *own*
// long-lived process in the multi-process runtime, reaching the host only over
// the capability relay. It follows the shape `adapter` established (`runtimes`,
// per-runtime `entry`, `capabilities`) with two changes: it drops `targets` (a
// service runs standalone, it does not inject another process) and it adds C++.
//
// There is deliberately NO permission/sandbox field here. Confinement tier
// (co-resident vs OS-sandbox) is the trust verdict's call, not the manifest's;
// and how strict a sandbox is (network, write) is GRANTED BY THE USER, never
// self-declared by the kfx (ADR-0017 open question 1 resolution). A manifest
// can no more relax its own sandbox than a view manifest can elevate its own
// tier.
export type KfxServiceDecl = {
  // runtimes this service ships a body for
  runtimes: KfxServiceRuntime[];
  // service entry per runtime, relative to the package root. Python and Node are
  // a source path (an interpreter loads it); C++ is a per-platform prebuilt
  // binary map (KfxServiceCppEntry) — no interpreter, so the host launches the
  // binary directly.
  entry: { python?: string; node?: string; cpp?: KfxServiceCppEntry };
  // kungfu relay capabilities the service needs; undeclared stay absent — the
  // same permission seam a view's `capabilities` is
  capabilities?: KfxCapabilityKey[];
};

// `kungfuConfig.suite` — a suite groups related kfx for distribution and
// operation: navigation grouping, enable/disable as a unit, lockstep
// versioning. Membership is expressed through npm dependencies; `members`
// lists the kungfuConfig keys for the shell.
export type KfxSuiteDecl = {
  title: string;
  members: string[];
  // Optional relative path to the suite's domain-semantic closure. The
  // document is validated against profileSuiteSchema; its installed root and
  // lifecycle facts remain Core-owned.
  profile?: string;
};

export type KfxProfileSuiteContentRef = {
  path: string;
  sha256: string;
};

export type KfxProfileSuite = {
  schema: 'kungfu.profile-suite/v1';
  id: string;
  title: string;
  version: string;
  members: { required: string[]; optional: string[] };
  kfd1: {
    contractWorld: KfxProfileSuiteContentRef;
    factSurfaces: KfxProfileSuiteContentRef[];
    reducers: KfxProfileSuiteContentRef[];
    compatibility: KfxProfileSuiteContentRef;
  };
  kfd2: {
    claims: KfxProfileSuiteContentRef[];
    purposes: string[];
    policies: KfxProfileSuiteContentRef[];
  };
  // Optional because existing Profile Suites remain valid KFD-1/KFD-2
  // closures. Only Profiles that bind this facet can request KFD-3
  // qualification from the runtime.
  kfd3?: { collaboration: KfxProfileSuiteContentRef };
  actions: { registry: KfxProfileSuiteContentRef };
  views: { registry: KfxProfileSuiteContentRef };
  migrations: { registry: KfxProfileSuiteContentRef };
  permissions: { registry: KfxProfileSuiteContentRef };
  qualification: { profile: KfxProfileSuiteContentRef };
  // Optional product-shell projection. Semantic closure and activation remain
  // independent; this only tells a GUI which installed view represents the
  // Profile when the user focuses it.
  experience?: { homeView: string };
};

// ── load plan: host-agnostic discovery + decision (ADR-0017) ──────────────

// The filesystem/crypto handles `planKfx` needs, injected so the plan stays
// host-agnostic: the GUI renderer passes its `window.require('node:…')` handles,
// a CLI host passes the `node:` modules directly. `planKfx` instantiates
// nothing — no View, no DOM, no Electron — it only discovers packages and
// decides trust/tier, so the same rule runs in any Node/TS host.
export type KfxPlanFs = {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: string) => string;
  readdirSync: (
    p: string,
    opts: { withFileTypes: true },
  ) => { name: string; isDirectory: () => boolean }[];
};
export type KfxPlanPath = {
  join: (...parts: string[]) => string;
  dirname: (p: string) => string;
  resolve: (...parts: string[]) => string;
  delimiter: string;
};
export type KfxPlanCrypto = {
  createHash: (algo: string) => {
    update: (data: string) => { digest: (enc: string) => string };
  };
};
export type KfxPlanDeps = {
  fs: KfxPlanFs;
  path: KfxPlanPath;
  crypto: KfxPlanCrypto;
};

// Authoring hosts need byte-level filesystem access in addition to the neutral
// GUI load-plan seam. Keeping this separate prevents renderer discovery from
// acquiring new ambient filesystem authority merely because the installed
// Agent SDK can resolve source package closures.
export type KfxProfileSourceDeps = {
  fs: {
    existsSync: (p: string) => boolean;
    readFileSync: (p: string) => Uint8Array;
    readdirSync: (
      p: string,
      opts: { withFileTypes: true },
    ) => {
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
      isSymbolicLink: () => boolean;
    }[];
  };
  path: {
    join: (...parts: string[]) => string;
    resolve: (...parts: string[]) => string;
    dirname: (p: string) => string;
    relative: (from: string, to: string) => string;
    sep: string;
  };
  crypto: {
    createHash: (algo: string) => {
      update: (data: string | Uint8Array) => {
        digest: (enc: 'hex') => string;
      };
    };
  };
};

export type KfxProfileSourceResolution = {
  schema: 'kungfu.profile-source-resolution/v1';
  source: string;
  suiteKey: string;
  profilePath: string;
  profile: KfxProfileSuite;
  memberRoots: Record<string, string>;
  memberPackages: Record<string, string>;
  verified: true;
};

// One discovered kfx after discovery + decision, before any host lands it: the
// neutral load plan. The GUI's `KfxEntry` is exactly this plus a mounted
// `View`; a CLI host lands its own way. It carries what the decision produced
// (`tier`) and where the body is (`dir`, `bundlePath`) — but instantiates
// nothing.
export type KfxPlanEntry = {
  id: string;
  // which facet form this entry is. A physical discriminant so a host that
  // sees a mixed list can narrow without re-reading the manifest; views live
  // in `KfxLoadPlan.entries`, services in `KfxLoadPlan.services`.
  facet: 'view';
  title: string;
  capabilities: KfxCapabilityKey[];
  system: boolean;
  settings: KfxSettingDecl[];
  product: KfxProductDecl;
  suite?: string;
  packageName?: string;
  version?: string;
  // the package directory this kfx was discovered in (absolute); a host uses it
  // to locate the body and to report a load failure against the right package.
  dir: string;
  source: 'built-in' | string; // extension root the entry was loaded from
  tier: KfxRuntimeTier;
  bundlePath: string;
};

// One discovered service kfx after discovery + decision, before any host lands
// it. Unlike a view plan entry there is no renderer `tier`: a service is not a
// screen, so the host picks a co-resident child (trusted) or an OS-level
// sandbox (untrusted) from the trust verdict alone, and the actual landing is a
// later host concern (ADR-0017). The plan carries only the verdict, the
// declared capabilities, and where each runtime's body is.
export type KfxServicePlanEntry = {
  id: string;
  facet: 'service';
  capabilities: KfxCapabilityKey[];
  product: KfxProductDecl;
  // the source-authority verdict (authorizeFirstParty). A service is not tiered
  // like a view: trusted runs co-resident, untrusted is OS-sandbox confined.
  trusted: boolean;
  suite?: string;
  packageName?: string;
  version?: string;
  // the package directory this kfx was discovered in (absolute); a host uses it
  // to locate the per-runtime body and to report a launch failure.
  dir: string;
  source: 'built-in' | string; // extension root the entry was loaded from
  runtimes: KfxServiceRuntime[];
  entry: { python?: string; node?: string; cpp?: KfxServiceCppEntry };
};

export type KfxPlanFailure = {
  dir: string;
  error: string;
};

// The neutral load plan. `entries` are views (each host lands its own way);
// `services` are background-process kfx a host launches co-resident or in an OS
// sandbox. They are physically separate lists — not one list narrowed by
// `facet` — so a host consumes only the facets it lands (the GUI reads
// `entries`, ignores `services`) without narrowing everywhere.
export type KfxLoadPlan = {
  entries: KfxPlanEntry[];
  services: KfxServicePlanEntry[];
  suites: Record<string, KfxSuiteDecl>;
  profiles: ProfileManifest[];
  failures: KfxPlanFailure[];
};

export type NativeKfxPlanProjection = {
  registryRoot: string;
  planRoot: string;
  packages: Array<{
    key: string;
    facets: string[];
    runtimeTier: 'first-party-pinned' | 'verified-third-party' | 'untrusted';
    admissionGrade:
      | 'unverified'
      | 'identity-verified'
      | 'kfd-attested'
      | 'product-system';
  }>;
};

export type KfxShadowParityFinding = {
  packageKey: string;
  classification:
    | 'intended-match'
    | 'legacy-defect'
    | 'adr-required-divergence';
  reason: string;
};

export type KfxShadowParityReport = {
  schema: 'kungfu.kfx.shadow-parity/v1';
  nativeRegistryRoot: string;
  nativePlanRoot: string;
  findings: KfxShadowParityFinding[];
  counts: Record<KfxShadowParityFinding['classification'], number>;
};

// Compare the retained TS projection with a Core-native plan without making
// legacy behavior the oracle. Missing legacy discovery is a legacy defect;
// the new admission axis is an ADR-required divergence, not a mismatch to hide.
export function compareKfxShadowPlans(
  legacy: KfxLoadPlan,
  native: NativeKfxPlanProjection,
): KfxShadowParityReport {
  const legacyViews = new Map(legacy.entries.map((entry) => [entry.id, entry]));
  const legacyServices = new Map(
    legacy.services.map((service) => [service.id, service]),
  );
  const findings: KfxShadowParityFinding[] = [];
  const nativeKeys = new Set(native.packages.map((pkg) => pkg.key));

  for (const pkg of [...native.packages].sort((a, b) =>
    a.key.localeCompare(b.key),
  )) {
    const view = legacyViews.get(pkg.key);
    const service = legacyServices.get(pkg.key);
    const projectsLegacyFacet = pkg.facets.some((facet) =>
      ['view', 'service'].includes(facet),
    );
    if (projectsLegacyFacet && !view && !service) {
      findings.push({
        packageKey: pkg.key,
        classification: 'legacy-defect',
        reason:
          'native closure contains a loadable facet the legacy scan missed',
      });
      continue;
    }
    if (pkg.admissionGrade !== 'unverified') {
      findings.push({
        packageKey: pkg.key,
        classification: 'adr-required-divergence',
        reason: 'legacy loader has no KFD admission-grade axis',
      });
      continue;
    }
    if (view) {
      const expectedTier =
        pkg.runtimeTier === 'first-party-pinned'
          ? 'node-integrated'
          : 'sandboxed-ipc';
      findings.push({
        packageKey: pkg.key,
        classification:
          view.tier === expectedTier
            ? 'intended-match'
            : 'adr-required-divergence',
        reason:
          view.tier === expectedTier
            ? 'view placement matches the native runtime tier'
            : 'legacy view placement conflicts with the native runtime tier',
      });
      continue;
    }
    if (service) {
      const expectedTrusted = pkg.runtimeTier === 'first-party-pinned';
      findings.push({
        packageKey: pkg.key,
        classification:
          service.trusted === expectedTrusted
            ? 'intended-match'
            : 'adr-required-divergence',
        reason:
          service.trusted === expectedTrusted
            ? 'service placement matches the native runtime tier'
            : 'legacy service trust conflicts with the native runtime tier',
      });
    }
  }
  for (const key of [...legacyViews.keys(), ...legacyServices.keys()].sort()) {
    if (!nativeKeys.has(key)) {
      findings.push({
        packageKey: key,
        classification: 'legacy-defect',
        reason:
          'legacy plan contains a package absent from the canonical native roots',
      });
    }
  }
  const counts = {
    'intended-match': 0,
    'legacy-defect': 0,
    'adr-required-divergence': 0,
  };
  for (const finding of findings) counts[finding.classification] += 1;
  return {
    schema: 'kungfu.kfx.shadow-parity/v1',
    nativeRegistryRoot: native.registryRoot,
    nativePlanRoot: native.planRoot,
    findings,
    counts,
  };
}

const KFX_CONTRACT_FILE = 'kungfu-kfx.contract.json';
const KFX_CONTRACT_ENV = 'KUNGFU_KFX_CONTRACT';

export type KfxContract = Record<string, unknown>;

function planSha256(crypto: KfxPlanCrypto, data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function ancestorDirs(start: string, deps: KfxPlanDeps): string[] {
  const dirs = [];
  let current = deps.path.resolve(start);
  for (let i = 0; i < 12; i += 1) {
    dirs.push(current);
    const parent = deps.path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function validateJsonSchema(
  value: unknown,
  schema: unknown,
  label: string,
): void {
  const AjvCtor = Ajv2020 as unknown as new (options: {
    allErrors: boolean;
    strict: boolean;
  }) => {
    compile: (schema: unknown) => {
      (value: unknown): boolean;
      errors?: Array<{ instancePath?: string; message?: string }>;
    };
  };
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (validate(value)) return;
  const first = validate.errors?.[0];
  const path = first?.instancePath || '<root>';
  throw new Error(
    `${label} validation failed at ${path}: ${first?.message || 'invalid document'}`,
  );
}

export function resolveKfxContractPath(
  env: Record<string, string | undefined>,
  deps: KfxPlanDeps,
  options: { contractPath?: string; cwd?: string } = {},
): string {
  const explicit = options.contractPath || env[KFX_CONTRACT_ENV];
  if (explicit) return deps.path.resolve(explicit);
  const candidates: string[] = [];
  if (env.KUNGFU_DIR) {
    candidates.push(
      deps.path.join(env.KUNGFU_DIR, 'config', KFX_CONTRACT_FILE),
    );
  }
  if (env.KF_FIRST_PARTY_MANIFEST) {
    candidates.push(
      deps.path.join(
        deps.path.dirname(env.KF_FIRST_PARTY_MANIFEST),
        'config',
        KFX_CONTRACT_FILE,
      ),
    );
  }
  for (const start of [options.cwd, env.PWD].filter(Boolean) as string[]) {
    for (const dir of ancestorDirs(start, deps)) {
      candidates.push(
        deps.path.join(dir, 'framework', 'kfx', KFX_CONTRACT_FILE),
        deps.path.join(dir, 'kfx', KFX_CONTRACT_FILE),
        deps.path.join(dir, 'config', KFX_CONTRACT_FILE),
        deps.path.join(
          dir,
          'node_modules',
          '@kungfu-tech',
          'kfx',
          KFX_CONTRACT_FILE,
        ),
      );
    }
  }
  const found = candidates.find((candidate) => deps.fs.existsSync(candidate));
  if (found) return found;
  throw new Error(`Kungfu kfx contract not found: ${KFX_CONTRACT_FILE}`);
}

export function loadKfxContract(
  env: Record<string, string | undefined>,
  deps: KfxPlanDeps,
  options: { contractPath?: string; cwd?: string } = {},
): KfxContract {
  const contractPath = resolveKfxContractPath(env, deps, options);
  const parsed = JSON.parse(
    deps.fs.readFileSync(contractPath, 'utf8'),
  ) as unknown;
  const contract = objectValue(parsed);
  if (!contract) {
    throw new Error(
      `Kungfu kfx contract must be a JSON object: ${contractPath}`,
    );
  }
  if (contract.schema !== 'kungfu.kfx.contract/v1') {
    throw new Error(
      `Kungfu kfx contract schema mismatch: ${String(contract.schema)}`,
    );
  }
  validateJsonSchema(contract, contract.contractSchema, 'Kungfu kfx contract');
  return contract;
}

export function kfxContractHash(
  env: Record<string, string | undefined>,
  deps: KfxPlanDeps,
  options: { contractPath?: string; cwd?: string } = {},
): string {
  const contractPath = resolveKfxContractPath(env, deps, options);
  return `sha256:${planSha256(
    deps.crypto,
    deps.fs.readFileSync(contractPath, 'utf8'),
  )}`;
}

export function kfxContractMetadata(
  env: Record<string, string | undefined>,
  deps: KfxPlanDeps,
  options: { contractPath?: string; cwd?: string } = {},
): Record<string, unknown> {
  const contractPath = resolveKfxContractPath(env, deps, options);
  const contract = loadKfxContract(env, deps, {
    ...options,
    contractPath,
  });
  return {
    schema: contract.schema,
    id: contract.id,
    version: contract.version,
    weldedSurface: contract.weldedSurface,
    path: contractPath,
    hash: kfxContractHash(env, deps, { ...options, contractPath }),
  };
}

export function kfxPackageManifestSchema(
  env: Record<string, string | undefined>,
  deps: KfxPlanDeps,
): Record<string, unknown> {
  return structuredClone(
    objectValue(loadKfxContract(env, deps).packageManifestSchema) ?? {},
  );
}

export function kfxProfileSuiteSchema(
  env: Record<string, string | undefined>,
  deps: KfxPlanDeps,
): Record<string, unknown> {
  return structuredClone(
    objectValue(loadKfxContract(env, deps).profileSuiteSchema) ?? {},
  );
}

export function validateKfxPackageManifest(
  manifest: unknown,
  contract: KfxContract,
): void {
  validateJsonSchema(
    manifest,
    objectValue(contract.packageManifestSchema) ?? {},
    'KFX package manifest',
  );
}

export function validateKfxProfileSuite(
  profile: unknown,
  contract: KfxContract,
  suiteMembers?: string[],
): void {
  validateJsonSchema(
    profile,
    objectValue(contract.profileSuiteSchema) ?? {},
    'KFX Profile Suite',
  );
  const members = objectValue(objectValue(profile)?.members);
  const required = Array.isArray(members?.required)
    ? (members.required as string[])
    : [];
  const optional = Array.isArray(members?.optional)
    ? (members.optional as string[])
    : [];
  const overlap = required.filter((member) => optional.includes(member));
  if (overlap.length) {
    throw new Error(
      `KFX Profile Suite validation failed: members cannot be both required and optional: ${overlap.join(', ')}`,
    );
  }
  if (suiteMembers) {
    const declared = [...new Set([...required, ...optional])].sort();
    const packaged = [...new Set(suiteMembers)].sort();
    if (JSON.stringify(declared) !== JSON.stringify(packaged)) {
      throw new Error(
        'KFX Profile Suite validation failed: profile members must match kungfuConfig.suite.members',
      );
    }
  }
  const homeView = stringValue(
    objectValue(objectValue(profile)?.experience)?.homeView,
  );
  if (
    homeView &&
    !required.includes(homeView) &&
    !optional.includes(homeView)
  ) {
    throw new Error(
      'KFX Profile Suite validation failed: experience.homeView must be a profile member',
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function profileSha256(
  deps: KfxProfileSourceDeps,
  data: string | Uint8Array,
): string {
  return deps.crypto.createHash('sha256').update(data).digest('hex');
}

function profilePackageRoot(
  packageDir: string,
  deps: KfxProfileSourceDeps,
): string {
  const root = deps.path.resolve(packageDir);
  const ignored = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store']);
  const files: { path: string; sha256: string; size: number }[] = [];
  const visit = (directory: string): void => {
    for (const entry of deps.fs.readdirSync(directory, {
      withFileTypes: true,
    })) {
      const full = deps.path.join(directory, entry.name);
      const relative = deps.path.relative(root, full);
      const parts = relative.split(deps.path.sep);
      if (parts.some((part) => ignored.has(part))) continue;
      if (entry.isSymbolicLink())
        throw new Error(
          `KFX member package closure cannot contain symlinks: ${relative}`,
        );
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const bytes = deps.fs.readFileSync(full);
        files.push({
          path: parts.join('/'),
          sha256: profileSha256(deps, bytes),
          size: bytes.byteLength,
        });
      }
    }
  };
  visit(root);
  const encoder = new TextEncoder();
  files.sort((left, right) => {
    const a = encoder.encode(left.path);
    const b = encoder.encode(right.path);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
  });
  if (!files.length) throw new Error(`KFX member package is empty: ${root}`);
  return `sha256:${profileSha256(
    deps,
    stableJson({ schema: 'kungfu.kfx-package-closure/v1', files }),
  )}`;
}

// Resolve a source Suite using the same package layout and content-root rule as
// the installed Python Agent SDK. This function owns no lifecycle state and
// accepts the embedded KFX contract explicitly, so it cannot become a second
// schema or trust authority.
export function resolveKfxProfileSuiteSource(
  source: string,
  contract: KfxContract,
  deps: KfxProfileSourceDeps,
): KfxProfileSourceResolution {
  const suiteDir = deps.path.resolve(source);
  const manifest = JSON.parse(
    new TextDecoder().decode(
      deps.fs.readFileSync(deps.path.join(suiteDir, 'package.json')),
    ),
  ) as Record<string, unknown>;
  validateKfxPackageManifest(manifest, contract);
  const config = objectValue(manifest.kungfuConfig);
  const suite = objectValue(config?.suite);
  const suiteKey = stringValue(config?.key);
  const profileRelative = stringValue(suite?.profile);
  const memberValues = Array.isArray(suite?.members)
    ? (suite.members as string[])
    : [];
  if (!suite || !suiteKey || !profileRelative)
    throw new Error('source is not a KFX Suite with suite.profile');
  const profilePath = deps.path.resolve(suiteDir, profileRelative);
  if (
    profilePath !== suiteDir &&
    !profilePath.startsWith(`${suiteDir}${deps.path.sep}`)
  )
    throw new Error('KFX Profile Suite profile path escapes the package root');
  const profile = JSON.parse(
    new TextDecoder().decode(deps.fs.readFileSync(profilePath)),
  ) as KfxProfileSuite;
  validateKfxProfileSuite(profile, contract, memberValues);

  const roots = [
    suiteDir,
    deps.path.join(suiteDir, 'members'),
    deps.path.dirname(suiteDir),
  ];
  const candidates: Record<string, string[]> = Object.fromEntries(
    [...new Set(memberValues)].sort().map((member) => [member, []]),
  );
  const visited = new Set<string>();
  for (const root of roots) {
    if (!deps.fs.existsSync(root)) continue;
    const directories = [
      root,
      ...deps.fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => deps.path.join(root, entry.name)),
    ];
    for (const directory of directories) {
      const resolved = deps.path.resolve(directory);
      const manifestPath = deps.path.join(resolved, 'package.json');
      if (visited.has(resolved) || !deps.fs.existsSync(manifestPath)) continue;
      visited.add(resolved);
      try {
        const candidate = JSON.parse(
          new TextDecoder().decode(deps.fs.readFileSync(manifestPath)),
        ) as Record<string, unknown>;
        validateKfxPackageManifest(candidate, contract);
        const key = stringValue(objectValue(candidate.kungfuConfig)?.key);
        if (key && candidates[key]) candidates[key].push(resolved);
      } catch {
        // Invalid adjacent packages are not candidates for a declared member.
      }
    }
  }
  const unresolved = Object.entries(candidates).filter(
    ([, paths]) => paths.length !== 1,
  );
  if (unresolved.length) {
    throw new Error(
      `KFX Profile Suite members must resolve exactly once: ${unresolved
        .map(([key, paths]) => `${key}=${paths.length}`)
        .join(', ')}`,
    );
  }
  const memberPackages = Object.fromEntries(
    Object.entries(candidates).map(([key, paths]) => [key, paths[0]]),
  );
  const memberRoots = Object.fromEntries(
    Object.entries(memberPackages).map(([key, directory]) => [
      key,
      profilePackageRoot(directory, deps),
    ]),
  );
  return {
    schema: 'kungfu.profile-source-resolution/v1',
    source: suiteDir,
    suiteKey,
    profilePath,
    profile,
    memberRoots,
    memberPackages,
    verified: true,
  };
}

function validateFirstPartyManifest(
  manifest: unknown,
  contract: KfxContract,
): void {
  validateJsonSchema(
    manifest,
    objectValue(contract.firstPartyManifestSchema) ?? {},
    'KFX first-party manifest',
  );
}

// The frozen first-party set (ADR-0013): trust is granted by membership here —
// a verifiable origin — never by which extension root a package loaded from. It
// ships as a build-generated JSON pointed to by KF_FIRST_PARTY_MANIFEST. A
// missing/unreadable manifest yields `null`, which trusts nothing but the
// shell's own `system` views (safe by default, never a path fallback).
export function loadFirstPartyManifest(
  env: Record<string, string | undefined>,
  deps: KfxPlanDeps,
): FirstPartyManifest | null {
  const p = env.KF_FIRST_PARTY_MANIFEST;
  if (!p || !deps.fs.existsSync(p)) return null;
  try {
    const contract = loadKfxContract(env, deps);
    const parsed = JSON.parse(
      deps.fs.readFileSync(p, 'utf8'),
    ) as FirstPartyManifest;
    validateFirstPartyManifest(parsed, contract);
    if (parsed?.version !== 1 || typeof parsed.keys !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// Extension roots, in priority order (first occurrence of a key wins):
//   1. KF_EXTENSION_PATH entries (path-separator list; dev override)
//   2. <home>/extensions next to the runtime dir (the install root that
//      `kungfu kfx install` populates)
export function extensionRoots(
  env: Record<string, string | undefined>,
  deps: KfxPlanDeps,
): string[] {
  const { path } = deps;
  const roots: string[] = [];
  for (const entry of (env.KF_EXTENSION_PATH ?? '').split(path.delimiter)) {
    if (entry) roots.push(entry);
  }
  if (env.KF_RUNTIME_DIR) {
    roots.push(path.join(path.dirname(env.KF_RUNTIME_DIR), 'extensions'));
  }
  return roots;
}

// Scan a root two levels deep so suite members nested under a suite directory
// (extensions/system/<member>) are found in the workspace layout.
function packageDirs(root: string, deps: KfxPlanDeps): string[] {
  const { fs, path } = deps;
  if (!fs.existsSync(root)) return [];
  const dirs: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const dir = path.join(root, entry.name);
    dirs.push(dir);
    // one more level: suite members live under the suite directory
    for (const nested of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!nested.isDirectory() || nested.name === 'node_modules') continue;
      const nestedDir = path.join(dir, nested.name);
      if (fs.existsSync(path.join(nestedDir, 'package.json'))) {
        dirs.push(nestedDir);
      }
    }
  }
  return dirs.filter((dir) => fs.existsSync(path.join(dir, 'package.json')));
}

// planKfx: discover packages across the extension roots and decide each one's
// trust tier, producing a neutral load plan. It is the host-agnostic half of
// the old `loadKfx` — discovery + decision — with `View` landing removed and
// filesystem access injected. Both hosts import this same rule, so the GUI and
// the CLI reach an identical verdict for the same kfx (ADR-0017). Landing (the
// renderer bundle eval, or the OS-sandbox launch) is each host's own concern.
export function planKfx(
  env: Record<string, string | undefined>,
  deps: KfxPlanDeps,
): KfxLoadPlan {
  const { fs, path } = deps;
  const entries: KfxPlanEntry[] = [];
  const services: KfxServicePlanEntry[] = [];
  const suites: Record<string, KfxSuiteDecl> = {};
  const profiles: ProfileManifest[] = [];
  const failures: KfxPlanFailure[] = [];
  const seen = new Set<string>();
  const seenProfiles = new Set<string>();
  let contract: KfxContract;

  // trust is granted by the frozen first-party set (ADR-0013), never by which
  // root a package loaded from — a KF_EXTENSION_PATH entry no longer confers it.
  try {
    contract = loadKfxContract(env, deps);
  } catch (e) {
    return {
      entries,
      services,
      suites,
      profiles,
      failures: [
        {
          dir: '<kfx-contract>',
          error: (e as Error).message,
        },
      ],
    };
  }
  const firstParty = loadFirstPartyManifest(env, deps);

  for (const root of extensionRoots(env, deps)) {
    for (const dir of packageDirs(root, deps)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
        ) as unknown;
        const manifestObject = objectValue(parsed);
        if (!manifestObject?.kungfuConfig) continue; // not a kfx package
        validateKfxPackageManifest(manifestObject, contract);
        const manifest = manifestObject as {
          name?: string;
          version?: string;
          kungfuConfig?: {
            key?: string;
            product?: KfxProductDecl;
            suite?: KfxSuiteDecl;
            config?: {
              view?: {
                title?: string;
                capabilities?: KfxCapabilityKey[];
                runtime?: KfxRuntimeTier;
                system?: boolean;
                settings?: KfxSettingDecl[];
                entry?: string;
              };
              service?: {
                runtimes?: KfxServiceRuntime[];
                entry?: {
                  python?: string;
                  node?: string;
                  cpp?: KfxServiceCppEntry;
                };
                capabilities?: KfxCapabilityKey[];
              };
            };
          };
        };
        const config = manifest.kungfuConfig;
        if (!config?.key) continue; // not one of ours
        if (config.suite && !suites[config.key]) {
          if (config.suite.profile) {
            const profilePath = path.resolve(dir, config.suite.profile);
            const suiteRoot = path.resolve(dir);
            if (
              profilePath !== suiteRoot &&
              !profilePath.startsWith(`${suiteRoot}/`) &&
              !profilePath.startsWith(`${suiteRoot}\\`)
            ) {
              throw new Error(
                'KFX Profile Suite profile path escapes the package root',
              );
            }
            const declaredProfile = JSON.parse(
              fs.readFileSync(profilePath, 'utf8'),
            ) as KfxProfileSuite;
            validateKfxProfileSuite(
              declaredProfile,
              contract,
              config.suite.members,
            );
            if (
              declaredProfile.experience?.homeView &&
              !seenProfiles.has(declaredProfile.id)
            ) {
              profiles.push({
                id: declaredProfile.id,
                title: declaredProfile.title,
                kfx: [
                  ...declaredProfile.members.required,
                  ...declaredProfile.members.optional,
                ],
                defaultView: declaredProfile.experience.homeView,
              });
              seenProfiles.add(declaredProfile.id);
            }
          }
          suites[config.key] = config.suite;
        }
        const view = config.config?.view;
        const service = config.config?.service;
        const product = config.product ?? { roles: [] };
        if (!view && !service) continue; // suite-only or non-facet package
        if (seen.has(config.key)) continue; // earlier root wins (one facet/key)
        seen.add(config.key);
        if (view) {
          const bundlePath = path.join(dir, view.entry ?? 'dist/view/index.js');
          // hash the bundle only when the key is pinned in the frozen set; an
          // unpinned or absent key is decided by identity alone (verdict below).
          const pin = firstParty?.keys[config.key];
          const contentHash =
            pin && pin.sha256 !== null && fs.existsSync(bundlePath)
              ? planSha256(deps.crypto, fs.readFileSync(bundlePath, 'utf8'))
              : null;
          const trusted = authorizeFirstParty(
            firstParty,
            config.key,
            contentHash,
          );
          const tier = resolveRuntimeTier(view, trusted);
          entries.push({
            id: config.key,
            facet: 'view',
            title: view.title ?? config.key,
            capabilities: view.capabilities ?? [],
            system: Boolean(view.system),
            settings: view.settings ?? [],
            product,
            packageName: manifest.name,
            version: manifest.version,
            dir,
            source: root,
            tier,
            bundlePath,
          });
        } else if (service) {
          // A service has no single bundle to content-pin — it ships a body per
          // runtime — so it is authorized unpinned: authorizeFirstParty with a
          // null hash trusts an unpinned first-party key, while a key that
          // *requires* a sha pin fails the null hash and stays untrusted. That
          // is the default-deny side (ADR-0013): an untrusted service lands in
          // the OS sandbox, per-runtime content pinning is a follow-up.
          const trusted = authorizeFirstParty(firstParty, config.key, null);
          services.push({
            id: config.key,
            facet: 'service',
            capabilities: service.capabilities ?? [],
            product,
            trusted,
            packageName: manifest.name,
            version: manifest.version,
            dir,
            source: root,
            runtimes: service.runtimes ?? [],
            entry: service.entry ?? {},
          });
        }
      } catch (e) {
        failures.push({ dir, error: (e as Error).message });
      }
    }
  }

  // join suite membership onto entries and services
  for (const [key, suite] of Object.entries(suites)) {
    for (const entry of entries) {
      if (suite.members.includes(entry.id)) entry.suite = key;
    }
    for (const service of services) {
      if (suite.members.includes(service.id)) service.suite = key;
    }
  }

  return { entries, services, suites, profiles, failures };
}

// ── runtime contract (what the shell hands a mounted view) ────────────────

export type ShellState = {
  profileId: string;
  disabledKfx: string[];
  disabledSuites: string[];
  sidebarCollapsed: boolean;
  settings: Record<string, string>;
};

export type ShellRuntimeInfo = {
  ok: boolean;
  message: string;
  runtimeDir: string;
  kungfuVersion: string;
  runtimeStatus: {
    ok: boolean;
    payload:
      | ({ product?: RuntimeProductStatus } & Record<string, unknown>)
      | null;
    error: string;
    updatedAt: number;
  } | null;
  buildInfo: Record<string, unknown> | null;
  skillManager: Record<string, unknown> | null;
  exports: string[];
  schemaTypes: { name: string; fields: string[] }[];
};

export type KungfuUiConfig = {
  fontFamily: string;
  fontSize: number;
  scale: number;
};

export type KungfuDurabilityProfile =
  | 'visible'
  | 'durable_group'
  | 'durable_sync';

export type KungfuDurabilityRule = {
  id: string;
  priority: number;
  match: {
    carrierTypes?: number[];
    sourceIds?: number[];
    destinationIds?: number[];
  };
  profile: KungfuDurabilityProfile;
};

export type KungfuDurabilityConfig = {
  activation: 'off' | 'qualified-candidate';
  qualificationProfile: string;
  defaultProfile: KungfuDurabilityProfile;
  segmentMaxBytes: number;
  requestTimeoutMs: number;
  reconcileOnTimeout: boolean;
  failurePolicy: 'fail-closed';
  group: {
    maxDelayMs: number;
    maxRecords: number;
    maxBytes: number;
  };
  rules: KungfuDurabilityRule[];
};

export type KungfuResolvedConfig = {
  schema: 'kungfu.config.resolved/v1';
  configHome: string;
  configPath: string;
  runtimeHome: string;
  workspaceDataHome: string;
  machineDataHome: string;
  config: {
    ui: KungfuUiConfig;
    storage: { durability: KungfuDurabilityConfig };
    [key: string]: unknown;
  };
  sources: {
    type: string;
    path?: string;
    exists?: boolean;
    [key: string]: unknown;
  }[];
  contract: Record<string, unknown>;
  digests: { storageDurability: string };
};

export type ShellCommand =
  | { kind: 'open-kfx'; kfxId: string; params?: Record<string, string> }
  | { kind: 'open-settings' }
  | { kind: 'dismiss-notification'; notificationId: string };

export type StatusBarSeverity = 'info' | 'ok' | 'warning' | 'error';
export type StatusBarSide = 'left' | 'right';

export type StatusBarItem = {
  id: string;
  text: string;
  owner?: string;
  side?: StatusBarSide;
  priority?: number;
  icon?: string;
  severity?: StatusBarSeverity;
  tooltip?: string;
  command?: ShellCommand;
};

export type ShellStatusBarApi = {
  set: (item: StatusBarItem) => void;
  clear: (id: string) => void;
};

export type ShellNotificationLevel = 'info' | 'success' | 'warning' | 'error';

export type ShellNotificationAction = {
  id: string;
  label: string;
  command?: ShellCommand;
};

export type ShellNotificationInput = {
  level?: ShellNotificationLevel;
  title: string;
  message?: string;
  timeoutMs?: number;
  actions?: ShellNotificationAction[];
};

export type ShellNotification = ShellNotificationInput & {
  id: string;
  level: ShellNotificationLevel;
  createdAt: number;
};

export type KungfuConfigValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

// One loaded view as the GUI shell sees it: a load-plan entry (manifest data +
// the trust/tier decision) with this renderer's landing added — the mounted
// `View`. A node-integrated view carries a View evaluated in the shared
// renderer; a sandboxed-ipc view carries only its `bundlePath`, loaded in an
// isolated renderer, and `View` is a placeholder the shell must not mount
// directly. Everything except `View` is the host-agnostic `KfxPlanEntry`.
export type KfxEntry = KfxPlanEntry & {
  View: KfxViewComponent;
};

// One per-session OS window as it crosses the shell boundary (ADR-0016 stage 2).
// Structurally the terminal extension's PersistedWindow, defined here so the
// shell contract does not import an extension. Window identity is separate from
// session identity: this references a session by runId, it does not carry
// terminal state.
export type SessionWindowRecord = {
  windowId: string;
  runId: string;
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lastSeenAt: number;
};

export type Shell = {
  // cross-kfx navigation with parameters; params reach the target view
  open: (kfxId: string, params?: Record<string, string>) => void;
  // the params this view was last opened with
  params: Record<string, string>;
  // shared refresh bus (one shell-owned timer); returns the unsubscribe
  onRefresh: (fn: () => void) => () => void;
  // read a settings value (view-declared or shell-owned), fallback applied
  setting: (key: string) => string;
  // persist shell state changes; the shell owns the ConfigStore write
  updateState: (patch: Partial<ShellState>) => void;
  state: ShellState;
  // shell-owned system chrome: persistent status items and transient toasts
  statusBar: ShellStatusBarApi;
  notify: (notification: ShellNotificationInput) => string;
  dismissNotification: (id: string) => void;
  // global Kungfu config, read/written through `kungfu config`
  config: KungfuResolvedConfig | null;
  configError?: string;
  reloadConfig: () => void;
  setConfigValue: (key: string, value: KungfuConfigValue) => void;
  unsetConfigValue: (key: string) => void;
  // runtime facts for system views
  info: ShellRuntimeInfo;
  // every loaded kfx (for the manager and settings views)
  registry: KfxEntry[];
  // suites by key (for grouping and unit enable/disable)
  suites: Record<string, KfxSuiteDecl>;
  // available profiles (shell-defined; a profile selects kfx + first screen)
  profiles: ProfileManifest[];
  // Per-session OS windows (ADR-0016 stage 2). Present only when the shell can
  // drive main-process windows — the node-integrated gui with KF_SESSION_WINDOWS
  // on — and absent in a sandbox, where popping a session into its own OS window
  // has no meaning. A view feature-detects and hides the affordance when absent,
  // so it stays electron-free: it asks the shell, which owns the ipc.
  //   popOutSession        pop a session into its own restorable OS window
  //   restoreSessionWindows re-open the persisted window set on boot (F7 clamp)
  //   onSessionWindowsSnapshot subscribe to the live window set for persistence
  popOutSession?: (runId: string) => void;
  restoreSessionWindows?: (windows: SessionWindowRecord[]) => void;
  onSessionWindowsSnapshot?: (
    fn: (windows: SessionWindowRecord[]) => void,
  ) => () => void;
};

export type KfxViewProps = { caps: KfxCapabilities; shell: Shell };
export type KfxViewComponent = React.ComponentType<KfxViewProps>;

// A view extension's bundle exports exactly this shape.
export type KfxViewModule = {
  View: KfxViewComponent;
};

// A profile bundles kfx ids, a default first view and vocabulary labels.
export type ProfileManifest = {
  id: string;
  title: string;
  kfx: string[];
  defaultView: string;
};

// ── UI tokens (dark, dense, monospace — no component library) ─────────────

export const panelStyle: React.CSSProperties = {
  background: '#252526',
  border: '1px solid #3c3c3c',
  borderRadius: 6,
  padding: 12,
  overflow: 'auto',
  minHeight: 0,
};

export const headingStyle: React.CSSProperties = {
  fontSize: 'calc(var(--kf-font-size, 14px) - 3px)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: '#858585',
  margin: '0 0 8px 0',
};

export const mono: React.CSSProperties = {
  fontFamily: 'var(--kf-mono-font-family, SF Mono, Menlo, monospace)',
  fontSize: 'calc(var(--kf-font-size, 14px) - 2px)',
};

export const inputStyle: React.CSSProperties = {
  ...mono,
  padding: 4,
  background: '#1e1e1e',
  border: '1px solid #3c3c3c',
  borderRadius: 4,
  color: '#cccccc',
};
