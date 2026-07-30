// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const POLICY_SCHEMA =
  'https://xinfa.dev/schema/semantic-project-v1.schema.json';
const DEFAULT_SEMANTIC_PROJECT = '.xinfa/project.json';
const LIFECYCLES = new Set([
  'generated',
  'managed-block',
  'authored',
  'historical-append-only',
  'non-claim',
]);
const ROUTE_CAPABILITIES = [
  'value',
  'use',
  'authority',
  'constraints',
  'known-limits',
  'evidence',
  'next-action',
];
const AUTHORING_ACTIONS = {
  generated: {
    action: 'regenerate-and-dirty-check',
    review: 'machine',
    automatic: true,
  },
  'managed-block': {
    action: 'refresh-declared-managed-region',
    review: 'mixed',
    automatic: true,
  },
  authored: {
    action: 'review-authored-change',
    review: 'human',
    automatic: false,
  },
  'historical-append-only': {
    action: 'append-or-supersede-with-review',
    review: 'human',
    automatic: false,
  },
  'non-claim': {
    action: 'confirm-non-claim-boundary',
    review: 'human',
    automatic: false,
  },
};

/** @param {any} value @returns {any} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** @param {any} value @returns {string} */
function stableJson(value) {
  return `${JSON.stringify(canonical(value))}\n`;
}

/** @param {any} value @returns {string} */
function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

// Public only for receipts assembled by the thin Shifu documentation CLI.
// Keeping one canonicalizer prevents adapter roots from drifting away from the
// inventory and authoring-impact roots owned by this module.
/** @param {any} value @returns {string} */
export function documentationSurfaceDigest(value) {
  return digest(value);
}

/** @param {Buffer} bytes @returns {string} */
function byteDigest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/** @param {any} value @param {string[]} required @param {string[]} optional @param {string} label */
function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not declared`);
  for (const key of required)
    if (!(key in value)) throw new Error(`${label}.${key} is required`);
}

/** @param {unknown} value @param {string} label @returns {string} */
function repositoryPath(value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    path.posix.normalize(value) !== value
  )
    throw new Error(`${label} must be an exact repository-relative POSIX path`);
  return value;
}

/** @param {string} root @returns {string[]} */
function trackedFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'buffer',
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `cannot enumerate tracked surfaces: ${result.error?.message || result.stderr.toString('utf8')}`,
    );
  return result.stdout.toString('utf8').split('\0').filter(Boolean).sort();
}

/** @param {string} relative @param {any} selectors @returns {boolean} */
function matches(relative, selectors) {
  return (
    (selectors.paths || []).includes(relative) ||
    (selectors.prefixes || []).some((/** @type {string} */ prefix) =>
      relative.startsWith(prefix),
    ) ||
    (selectors.suffixes || []).some((/** @type {string} */ suffix) =>
      relative.endsWith(suffix),
    )
  );
}

/** @param {string} relative @param {any[]} classifications @returns {any} */
function classificationFor(relative, classifications) {
  return classifications.find((item) => matches(relative, item.selectors));
}

/** @param {string} root @param {string} relative */
function readSurface(root, relative) {
  const absolute = path.join(root, relative);
  const metadata = fs.lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw new Error(`${relative} must be a regular non-symlink file`);
  const bytes = fs.readFileSync(absolute);
  return {
    contentRoot: byteDigest(bytes),
    size: bytes.length,
  };
}

/** @param {any} policy @returns {Map<string, any>} */
function validatePolicy(policy) {
  exactKeys(
    policy,
    [
      '$schema',
      'schema',
      'project',
      'discovery',
      'classifications',
      'explicitSurfaces',
      'bindings',
      'routes',
      'compatibilityGates',
      'authority',
    ],
    [],
    'policy',
  );
  if (
    policy.$schema !== POLICY_SCHEMA ||
    policy.schema !== 'xinfa.semantic-project/v1'
  )
    throw new Error('unsupported documentation surface policy');
  exactKeys(
    policy.discovery,
    ['trackedOnly', 'extensions'],
    [],
    'policy.discovery',
  );
  if (policy.discovery.trackedOnly !== true)
    throw new Error('surface discovery must be limited to tracked files');
  if (
    !Array.isArray(policy.discovery.extensions) ||
    !policy.discovery.extensions.length
  )
    throw new Error('surface discovery requires extensions');
  const ids = new Set();
  for (const [index, item] of policy.classifications.entries()) {
    exactKeys(
      item,
      [
        'id',
        'lifecycle',
        'documentProfile',
        'verificationProfile',
        'visibility',
        'owner',
        'waiver',
        'selectors',
      ],
      [],
      `policy.classifications[${index}]`,
    );
    if (ids.has(item.id))
      throw new Error(`duplicate classification: ${item.id}`);
    ids.add(item.id);
    if (!LIFECYCLES.has(item.lifecycle))
      throw new Error(`unsupported lifecycle: ${item.lifecycle}`);
    if (typeof item.owner !== 'string' || !item.owner)
      throw new Error(`classification ${item.id} requires an owner`);
    if (item.waiver !== null)
      throw new Error(`classification ${item.id} has an unsupported waiver`);
    exactKeys(
      item.selectors,
      [],
      ['paths', 'prefixes', 'suffixes'],
      `policy.classifications[${index}].selectors`,
    );
    if (!Object.values(item.selectors).some((values) => values?.length))
      throw new Error(`classification ${item.id} has no selectors`);
  }
  for (const [index, route] of policy.routes.entries()) {
    exactKeys(
      route,
      [
        'id',
        'audience',
        'parityGroup',
        'entrypoints',
        'capabilities',
        'resolution',
        'selection',
      ],
      [],
      `policy.routes[${index}]`,
    );
  }
  const compatibilityIds = new Set();
  for (const [index, gate] of policy.compatibilityGates.entries()) {
    exactKeys(
      gate,
      [
        'id',
        'legacyEntrypoint',
        'status',
        'owner',
        'preservedCapabilities',
        'canonicalEntrypoints',
        'sunsetCondition',
      ],
      [],
      `policy.compatibilityGates[${index}]`,
    );
    if (compatibilityIds.has(gate.id))
      throw new Error(`duplicate compatibility gate: ${gate.id}`);
    compatibilityIds.add(gate.id);
    if (gate.status !== 'composed')
      throw new Error(`compatibility gate ${gate.id} must be composed`);
    if (!gate.preservedCapabilities.length || !gate.canonicalEntrypoints.length)
      throw new Error(`compatibility gate ${gate.id} is incomplete`);
  }
  return new Map(
    policy.classifications.map((/** @type {any} */ item) => [item.id, item]),
  );
}

/** @param {{root: string, policyRef?: string, files?: string[] | null}} options */
export function buildHumanSurfaceInventory({
  root,
  policyRef = DEFAULT_SEMANTIC_PROJECT,
  files = null,
}) {
  const policyPath = path.resolve(root, policyRef);
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const classifications = validatePolicy(policy);
  const candidates = (files || trackedFiles(root)).filter((relative) =>
    policy.discovery.extensions.some((/** @type {string} */ extension) =>
      relative.endsWith(extension),
    ),
  );
  /** @type {any[]} */
  const entries = [];
  const unclassified = [];
  for (const relative of candidates) {
    const classification = classificationFor(relative, policy.classifications);
    if (!classification) {
      unclassified.push(relative);
      continue;
    }
    entries.push({
      id: `file:${relative}`,
      path: relative,
      kind: 'document-file',
      classification: classification.id,
      lifecycle: classification.lifecycle,
      documentProfile: classification.documentProfile,
      verificationProfile: classification.verificationProfile,
      visibility: classification.visibility,
      owner: classification.owner,
      waiver: classification.waiver,
      ...readSurface(root, relative),
    });
  }
  for (const [index, surface] of policy.explicitSurfaces.entries()) {
    exactKeys(
      surface,
      ['id', 'path', 'kind', 'classification'],
      [],
      `policy.explicitSurfaces[${index}]`,
    );
    const relative = repositoryPath(
      surface.path,
      `explicit surface ${surface.id}`,
    );
    const classification = classifications.get(surface.classification);
    if (!classification)
      throw new Error(
        `unknown explicit classification: ${surface.classification}`,
      );
    entries.push({
      id: `explicit:${surface.id}`,
      path: relative,
      kind: surface.kind,
      classification: classification.id,
      lifecycle: classification.lifecycle,
      documentProfile: classification.documentProfile,
      verificationProfile: classification.verificationProfile,
      visibility: classification.visibility,
      owner: classification.owner,
      waiver: classification.waiver,
      ...readSurface(root, relative),
    });
  }
  entries.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const entryIds = new Set();
  for (const entry of entries) {
    if (entryIds.has(entry.id))
      throw new Error(`duplicate surface: ${entry.id}`);
    entryIds.add(entry.id);
  }
  if (unclassified.length)
    throw new Error(`unclassified human surfaces: ${unclassified.join(', ')}`);
  for (const route of policy.routes) {
    for (const entrypoint of route.entrypoints) {
      const relative = repositoryPath(
        entrypoint,
        `route ${route.id} entrypoint`,
      );
      if (!entries.some((entry) => entry.path === relative))
        throw new Error(
          `route ${route.id} has an unknown entrypoint: ${relative}`,
        );
    }
    for (const selected of route.selection.paths || []) {
      const relative = repositoryPath(
        selected,
        `route ${route.id} selected path`,
      );
      if (!entries.some((entry) => entry.path === relative))
        throw new Error(
          `route ${route.id} selects an unknown surface: ${relative}`,
        );
    }
  }
  const policyRoot = digest(policy);
  const bindings = policy.bindings.map(
    (/** @type {any} */ binding, /** @type {number} */ index) => {
      exactKeys(
        binding,
        [
          'id',
          'documentPath',
          'targetId',
          'targetKind',
          'targetPath',
          'relation',
          'expectedRevision',
        ],
        [],
        `policy.bindings[${index}]`,
      );
      const documentPath = repositoryPath(
        binding.documentPath,
        `binding ${binding.id} documentPath`,
      );
      if (!entries.some((entry) => entry.path === documentPath))
        throw new Error(
          `binding ${binding.id} references an unknown document surface`,
        );
      const targetPath = repositoryPath(
        binding.targetPath,
        `binding ${binding.id} targetPath`,
      );
      const target = readSurface(root, targetPath);
      return {
        ...binding,
        documentPath,
        targetPath,
        observedRevision: target.contentRoot,
        size: target.size,
      };
    },
  );
  const bindingIds = new Set();
  for (const binding of bindings) {
    if (bindingIds.has(binding.id))
      throw new Error(`duplicate binding: ${binding.id}`);
    bindingIds.add(binding.id);
  }
  bindings.sort((/** @type {any} */ left, /** @type {any} */ right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const providerPaths = new Set([
    ...entries.map((entry) => entry.path),
    ...bindings.map((/** @type {any} */ binding) => binding.targetPath),
  ]);
  const inventoryRoot = digest({
    policyRoot,
    entries: entries.map(
      ({
        id,
        path: source,
        kind,
        classification,
        lifecycle,
        visibility,
        owner,
        waiver,
        contentRoot,
        size,
      }) => ({
        id,
        path: source,
        kind,
        classification,
        lifecycle,
        visibility,
        owner,
        waiver,
        contentRoot,
        size,
      }),
    ),
    bindings,
  });
  return {
    schema: 'shifu.documentation-surface-inventory/v1',
    project: policy.project,
    policy: { reference: policyRef, root: policyRoot },
    inventoryRoot,
    closure: {
      discovered: candidates.length,
      explicit: policy.explicitSurfaces.length,
      classified: entries.length,
      unclassified: 0,
      humanSurfacePaths: new Set(entries.map((entry) => entry.path)).size,
      exactProviderPaths: providerPaths.size,
    },
    lifecycles: Object.fromEntries(
      [...LIFECYCLES]
        .sort()
        .map((lifecycle) => [
          lifecycle,
          entries.filter((entry) => entry.lifecycle === lifecycle).length,
        ]),
    ),
    entries,
    bindings,
    routes: policy.routes,
    compatibilityGates: policy.compatibilityGates,
    parityGroups: [
      ...new Set(
        policy.routes.map((/** @type {any} */ route) => route.parityGroup),
      ),
    ]
      .sort()
      .map((group) => ({
        id: group,
        audiences: ['agent', 'human'],
        capabilities: [...ROUTE_CAPABILITIES],
        nodeSet: 'shared',
      })),
  };
}

/** @param {string} root @param {string[]} args @returns {Buffer} */
function gitBytes(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'buffer' });
  if (result.error || result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${result.error?.message || result.stderr.toString('utf8')}`,
    );
  return result.stdout;
}

/** @param {{root:string, since:string, policyRef?:string, inventory?:any}} options */
export function documentationAuthoringImpact({
  root,
  since,
  policyRef = DEFAULT_SEMANTIC_PROJECT,
  inventory = null,
}) {
  if (!since) throw new Error('documentation authoring impact requires since');
  const current = inventory || buildHumanSurfaceInventory({ root, policyRef });
  const policy = JSON.parse(
    fs.readFileSync(path.resolve(root, policyRef), 'utf8'),
  );
  validatePolicy(policy);
  const sourceRevision = gitBytes(root, ['rev-parse', `${since}^{commit}`])
    .toString('utf8')
    .trim();
  const headRevision = gitBytes(root, ['rev-parse', 'HEAD'])
    .toString('utf8')
    .trim();
  const changed = new Map();
  const tokens = gitBytes(root, [
    'diff',
    '--find-renames=50%',
    '--name-status',
    '-z',
    sourceRevision,
    '--',
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = tokens[index++];
      const source = tokens[index++];
      if (source)
        changed.set(source, {
          change: status[0],
          previousPath,
          similarity: Number(status.slice(1)),
        });
      continue;
    }
    const source = tokens[index++];
    if (source) changed.set(source, { change: status[0] });
  }
  for (const source of gitBytes(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean))
    changed.set(source, { change: 'A' });

  const explicit = new Map(
    policy.explicitSurfaces.map((/** @type {any} */ surface) => [
      surface.path,
      surface,
    ]),
  );
  const currentByPath = new Map(
    current.entries.map((/** @type {any} */ entry) => [entry.path, entry]),
  );
  const classifications = new Map(
    policy.classifications.map((/** @type {any} */ item) => [item.id, item]),
  );
  const obligations = [];
  const violations = [];
  for (const [source, changeEntry] of [...changed.entries()].sort(
    ([left], [right]) => left.localeCompare(right, 'en'),
  )) {
    const { change, previousPath = '', similarity = null } = changeEntry;
    const declared = currentByPath.get(source);
    const explicitSurface = explicit.get(source);
    const eligible =
      Boolean(explicitSurface) ||
      policy.discovery.extensions.some((/** @type {string} */ extension) =>
        source.endsWith(extension),
      );
    if (!eligible) continue;
    const classification = declared
      ? classifications.get(declared.classification)
      : explicitSurface
        ? classifications.get(explicitSurface.classification)
        : classificationFor(source, policy.classifications);
    if (!classification) {
      violations.push({ code: 'unclassified-surface', path: source });
      continue;
    }
    const lifecycle = /** @type {keyof typeof AUTHORING_ACTIONS} */ (
      classification.lifecycle
    );
    const mode = AUTHORING_ACTIONS[lifecycle];
    const obligation = {
      path: source,
      change,
      ...(previousPath ? { previousPath, similarity } : {}),
      classification: classification.id,
      lifecycle: classification.lifecycle,
      owner: classification.owner,
      verificationProfile: classification.verificationProfile,
      requiredAction: mode.action,
      review: mode.review,
      automatic: mode.automatic,
      claimImpact:
        classification.lifecycle === 'non-claim' ? 'none' : 'evaluate',
    };
    obligations.push(obligation);
    if (previousPath) {
      const previousExplicitSurface = explicit.get(previousPath);
      const previousClassification = previousExplicitSurface
        ? classifications.get(previousExplicitSurface.classification)
        : classificationFor(previousPath, policy.classifications);
      if (
        previousClassification?.lifecycle === 'historical-append-only' &&
        classification.lifecycle !== 'historical-append-only'
      )
        violations.push({
          code: 'historical-surface-reclassified',
          path: source,
          previousPath,
        });
    }
    if (change === 'D' && classification.lifecycle === 'historical-append-only')
      violations.push({
        code: 'historical-surface-deleted',
        path: source,
      });
  }
  const reviewRequired = obligations.some(
    (item) => item.review === 'human' || item.review === 'mixed',
  );
  const verdict = violations.length
    ? 'fail'
    : reviewRequired
      ? 'review-required'
      : 'pass';
  const receipt = {
    schema: 'shifu.documentation-authoring-impact/v1',
    verdict,
    qualifying: false,
    bounded: true,
    source: {
      since,
      revision: sourceRevision,
      head: headRevision,
      dirty: headRevision === sourceRevision ? obligations.length > 0 : null,
    },
    inventoryRoot: current.inventoryRoot,
    obligations,
    violations,
    compatibilityGates: current.compatibilityGates,
    summary: {
      affectedSurfaces: obligations.length,
      automatic: obligations.filter((item) => item.automatic).length,
      humanOrMixedReview: obligations.filter(
        (item) => item.review === 'human' || item.review === 'mixed',
      ).length,
      violations: violations.length,
    },
  };
  return { ...receipt, impactRoot: digest(receipt) };
}

export { POLICY_SCHEMA };
