// SPDX-License-Identifier: Apache-2.0

/** KFD status, schema, query, witness, and aggregate commands. */

import * as shared from './sdk-shared.js';

const {
  spawnSync,
  createHash,
  fs,
  createRequire,
  os,
  path,
  fileURLToPath,
  BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH,
  collectKfdStatus,
  kfd1,
  kfd2,
  kfd3,
  kfd4,
  kfdSchemas,
  BUILDCHAIN_JSON_FORMATTING_POLICY,
  createKfd1ReleaseGateEvidence,
  normalizeKfd1ContractWorldWitness,
  resolveKfd1Metadata,
  sha256KfdJson,
  validateKfd1ReleaseGateEvidence,
  kfxSharedModuleContract,
  TEMPLATE_ROOT,
  KFX_CONTRACT_FILE,
  KFX_CONTRACT_ENV,
  CONTRACT_REGISTRY_FILE,
  CONTRACT_REGISTRY_ENV,
  CONTRACT_REGISTRY_SCHEMA,
  CONTRACT_FIXTURE_SCHEMA,
  CANONICAL_POLICY_SCHEMA,
  CANONICAL_POLICY_FILE,
  require,
  SDK_CLI,
  SDK_ROOT,
  SDK_KFD3_CANONICAL_REGISTRY,
  SDK_KFD_UPSTREAM_AGGREGATE,
  SDK_KFD_SUPPORT_MATRIX,
  SDK_KFD1_WITNESS,
  SDK_KFD1_RELEASE_GATE,
  SDK_KFD1_VERIFY_RESULT,
  SDK_KFD2_RELEASE_CLAIMS,
  SDK_KFD2_CLAIMS_DIR,
  SDK_KFD2_CLAIM_ARGS,
  KFD_AGENT_RUNTIME_MANIFEST,
  isWin,
  TUI_BUNDLE_BANNER,
  stubDevtools,
  usage,
  fail,
  errorMessage,
  parseArgs,
  toAppId,
  scaffold,
  createApp,
  createExtension,
  createSkill,
  productCwd,
  readPackageJson,
  ancestorDirs,
  resolveKfxContractPath,
  loadKfxContract,
  validateWithSchema,
  validateKfxManifest,
  readKfxManifest,
  dependencyMap,
  isProductAssemblyManifest,
  scriptsOf,
  packageRunner,
  localBin,
  shellLine,
  runLocalBin,
  runPackageScript,
  runSdkCommand,
  runNodeFile,
  resolvePackageDir,
  findRepoRootWithExtensions,
  resolveReferenceGuiDir,
  resolveReferenceExtensionsRoot,
  copyProductPackage,
  packageInstallKey,
  assembleProductExtensions,
  declaredKfxDependencies,
  isBuildableKfxPackage,
  electronDist,
  kfxProductEnv,
  productKfxGui,
  productAssemblyGui,
  productAssemblyTui,
  productAssemblyCli,
  productGui,
  productTuiBundle,
  productTui,
  productCli,
  product,
  isObject,
  readJson,
  renderJson,
  sha256File,
} = shared;

function findUp(start, relativePath) {
  let directory = path.resolve(start);
  if (fs.existsSync(directory) && !fs.statSync(directory).isDirectory()) {
    directory = path.dirname(directory);
  }
  while (true) {
    const candidate = path.join(directory, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return '';
    directory = parent;
  }
}

/**
 * @returns {string}
 */
function resolveKfd3Registry() {
  const override = process.env.KUNGFU_KFD3_REGISTRY || '';
  const candidates = [
    override,
    path.join(process.cwd(), BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH),
    findUp(process.cwd(), BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH),
    findUp(SDK_CLI, BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH),
    SDK_KFD3_CANONICAL_REGISTRY,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  fail(
    'KFD-3 registry not found; run inside a Kungfu checkout or install a SDK package that includes kfd/kfd-3-surfaces.json',
  );
}

/**
 * @param {string} registryPath
 * @returns {{cwd: string, registryPath: string}}
 */
function kfd3RegistryQueryContext(registryPath) {
  const canonicalSuffix = `${path.sep}${BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH.replace(/\//g, path.sep)}`;
  if (registryPath.endsWith(canonicalSuffix)) {
    return {
      cwd: registryPath.slice(0, -canonicalSuffix.length),
      registryPath: BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH,
    };
  }
  return {
    cwd: path.dirname(registryPath),
    registryPath: path.basename(registryPath),
  };
}

/**
 * @returns {string}
 */
function resolveKfdUpstreamAggregate() {
  const override = process.env.KUNGFU_KFD_UPSTREAM_AGGREGATE || '';
  const candidates = [
    override,
    path.join(
      process.cwd(),
      'developer',
      'sdk',
      'kfd',
      'upstream-aggregate.json',
    ),
    findUp(
      process.cwd(),
      path.join('developer', 'sdk', 'kfd', 'upstream-aggregate.json'),
    ),
    SDK_KFD_UPSTREAM_AGGREGATE,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  fail(
    'KFD upstream aggregate not found; run ./shifu kfd:buildchain or install a SDK package that includes kfd/upstream-aggregate.json',
  );
}

/**
 * @returns {string}
 */
function resolveKfdSupportMatrix() {
  const override = process.env.KUNGFU_KFD_SUPPORT_MATRIX || '';
  const candidates = [
    override,
    path.join(process.cwd(), '.buildchain', 'kfd', 'support-matrix.json'),
    findUp(
      process.cwd(),
      path.join('.buildchain', 'kfd', 'support-matrix.json'),
    ),
    findUp(
      process.cwd(),
      path.join('developer', 'sdk', 'kfd', 'support-matrix.json'),
    ),
    SDK_KFD_SUPPORT_MATRIX,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  fail(
    'KFD support matrix not found; run ./shifu kfd:support-matrix or install a SDK package that includes kfd/support-matrix.json',
  );
}

/**
 * @returns {{ path: string, registry: Record<string, any> }}
 */
function readKfd3Registry() {
  const registryPath = resolveKfd3Registry();
  return {
    path: registryPath,
    registry: JSON.parse(fs.readFileSync(registryPath, 'utf8')),
  };
}

/**
 * @returns {{ path: string, aggregate: Record<string, any> }}
 */
function readKfdUpstreamAggregate() {
  const aggregatePath = resolveKfdUpstreamAggregate();
  return {
    path: aggregatePath,
    aggregate: JSON.parse(fs.readFileSync(aggregatePath, 'utf8')),
  };
}

/**
 * @returns {{ path: string, matrix: Record<string, any> }}
 */
function readKfdSupportMatrix() {
  const matrixPath = resolveKfdSupportMatrix();
  return {
    path: matrixPath,
    matrix: JSON.parse(fs.readFileSync(matrixPath, 'utf8')),
  };
}

/**
 * @param {string} packageName
 * @returns {string}
 */
function packageVersion(packageName) {
  try {
    return String(require(`${packageName}/package.json`).version || '');
  } catch {
    return '';
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeKfdStandard(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  const match = raw.match(/^(?:kfd[-\s]?)?([1-9][0-9]*)$/);
  if (!match) fail(`unsupported KFD standard: ${value || '<empty>'}`);
  return `kfd-${match[1]}`;
}

/**
 * @param {string} standard
 * @param {string} [schemaName]
 * @returns {Record<string, any>}
 */
function readKfdSchemaDocument(standard, schemaName = '') {
  return kfdSchemas.read({
    standard: normalizeKfdStandard(standard),
    schema: schemaName,
  });
}

/**
 * @returns {Record<string, any>}
 */
function kfdSchemaSummary() {
  const schemaList = kfdSchemas.list();
  /** @type {Record<string, Array<{ name: string, schemaId: string, schemaPath: string }>>} */
  const byStandard = {};
  for (const entry of schemaList.schemas || []) {
    byStandard[entry.standard] ||= [];
    byStandard[entry.standard].push({
      name: entry.name,
      schemaId: entry.schemaId,
      schemaPath: entry.schemaPath,
    });
  }
  return {
    package: schemaList.package,
    standards: byStandard,
  };
}

/**
 * @returns {string}
 */
function resolvePackagedKfd1Witness() {
  if (fs.existsSync(SDK_KFD1_WITNESS)) return SDK_KFD1_WITNESS;
  fail(
    'SDK packaged KFD-1 witness not found; run ./shifu kfd:buildchain in the Kungfu checkout before packaging',
  );
}

/**
 * @returns {string}
 */
function resolvePackagedKfd1ReleaseGate() {
  if (fs.existsSync(SDK_KFD1_RELEASE_GATE)) return SDK_KFD1_RELEASE_GATE;
  fail(
    'SDK packaged KFD-1 release gate not found; run ./shifu kfd:buildchain in the Kungfu checkout before packaging',
  );
}

/**
 * @returns {string}
 */
function resolvePackagedKfd1VerifyResult() {
  if (fs.existsSync(SDK_KFD1_VERIFY_RESULT)) return SDK_KFD1_VERIFY_RESULT;
  fail(
    'SDK packaged KFD-1 verify result not found; run ./shifu kfd:buildchain in the Kungfu checkout before packaging',
  );
}

/**
 * @returns {Record<string, any>}
 */
function readKfd1Witness() {
  try {
    return buildContractWorldWitness(locateRepoRoot(process.cwd()));
  } catch {
    return /** @type {Record<string, any>} */ (
      readJson(resolvePackagedKfd1Witness())
    );
  }
}

/**
 * @param {Record<string, any>} witness
 * @returns {Record<string, any>}
 */
function buildKfd1ReleaseGate(witness) {
  const repoRoot = (() => {
    try {
      return locateRepoRoot(process.cwd());
    } catch {
      return '';
    }
  })();
  if (!repoRoot) {
    return /** @type {Record<string, any>} */ (
      readJson(resolvePackagedKfd1ReleaseGate())
    );
  }
  const gate = createKfd1ReleaseGateEvidence({
    cwd: repoRoot,
    artifacts: Array.isArray(witness.surfaces)
      ? witness.surfaces.map((surface) => ({
          name: surface.artifactPath,
          sourcePath: path.resolve(repoRoot, surface.sourcePath),
        }))
      : [],
    witnesses: [witness],
    verifiedAt: '1970-01-01T00:00:00.000Z',
  })?.passportSection;
  if (!gate) fail('KFD-1 release gate could not be created from the witness');
  return gate;
}

/**
 * @param {Record<string, any>} releaseGate
 * @returns {Record<string, any>}
 */
function buildKfd1VerifyResult(releaseGate) {
  const issues = validateKfd1ReleaseGateEvidence(releaseGate);
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-1-verify-result',
    ok: issues.length === 0,
    issues,
  };
}

/**
 * @returns {Record<string, any>}
 */
function readKfd2ClaimsDocument() {
  if (!fs.existsSync(SDK_KFD2_RELEASE_CLAIMS)) {
    fail(
      'SDK packaged KFD-2 release claims not found; run ./shifu kfd:buildchain in the Kungfu checkout before packaging',
    );
  }
  const releaseClaims = /** @type {Record<string, any>} */ (
    readJson(SDK_KFD2_RELEASE_CLAIMS)
  );
  const claims = fs.existsSync(SDK_KFD2_CLAIMS_DIR)
    ? fs
        .readdirSync(SDK_KFD2_CLAIMS_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => {
          const file = path.join(SDK_KFD2_CLAIMS_DIR, name);
          return {
            path: path.relative(process.cwd(), file) || '.',
            sha256: sha256File(file),
            document: readJson(file),
          };
        })
    : [];
  return {
    schemaVersion: 1,
    contract: 'kungfu-sdk-kfd-2-release-claims',
    standard: 'kfd-2',
    metadata: kfd2.resolveMetadata(),
    source: {
      releaseClaims: {
        path: path.relative(process.cwd(), SDK_KFD2_RELEASE_CLAIMS) || '.',
        sha256: sha256File(SDK_KFD2_RELEASE_CLAIMS),
      },
      buildchainClaimArgs: fs.existsSync(SDK_KFD2_CLAIM_ARGS)
        ? {
            path: path.relative(process.cwd(), SDK_KFD2_CLAIM_ARGS) || '.',
            sha256: sha256File(SDK_KFD2_CLAIM_ARGS),
          }
        : null,
    },
    releaseClaims,
    buildchainProjection: {
      claimInput: '--kfd-2-claim-json',
      claimCount: claims.length,
      claims,
    },
    releaseGate: {
      passportInput: '--kfd-2-claim-json',
      finalTrust: 'query-buildchain-release-passport',
    },
  };
}

function resolveKfdAgentRuntimeManifest() {
  const candidates = [
    process.env.KUNGFU_KFD_AGENT_RUNTIME_MANIFEST || '',
    path.resolve(SDK_ROOT, '..', 'runtime', KFD_AGENT_RUNTIME_MANIFEST),
    path.resolve(
      SDK_ROOT,
      '..',
      '..',
      'framework',
      'core',
      'dist',
      'kungfu',
      KFD_AGENT_RUNTIME_MANIFEST,
    ),
    path.resolve(
      SDK_ROOT,
      '..',
      '..',
      'framework',
      'core',
      'src',
      'kfd-agent-runtime',
      KFD_AGENT_RUNTIME_MANIFEST,
    ),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    fail(
      'KFD Agent Runtime manifest not found; set KUNGFU_KFD_AGENT_RUNTIME_MANIFEST',
    );
  }
  return found;
}

function buildKfdAgentRuntimeStatus() {
  const manifestPath = resolveKfdAgentRuntimeManifest();
  const manifest = /** @type {Record<string, any>} */ (readJson(manifestPath));
  const adapterName = `${manifest.adapter.basename}${isWin ? '.exe' : ''}`;
  const adapterCandidates = [
    process.env.KUNGFU_KFD_AGENT_RUNTIME_ADAPTER || '',
    path.join(path.dirname(manifestPath), adapterName),
    path.resolve(
      SDK_ROOT,
      '..',
      '..',
      'framework',
      'core',
      'dist',
      'kungfu',
      adapterName,
    ),
  ].filter(Boolean);
  const adapterPath =
    adapterCandidates.find((candidate) => fs.existsSync(candidate)) || '';
  const reportPath = process.env.KUNGFU_KFD_AGENT_RUNTIME_REPORT || '';
  const report =
    reportPath && fs.existsSync(reportPath)
      ? /** @type {Record<string, any>} */ (readJson(reportPath))
      : null;
  return {
    schemaVersion: 1,
    contract: 'kungfu.sdk.kfd-agent-runtime-status/v1',
    status: adapterPath ? 'available' : 'manifest-only',
    manifest: {
      path: path.relative(process.cwd(), manifestPath) || '.',
      sha256: sha256File(manifestPath),
    },
    adapter: {
      available: Boolean(adapterPath),
      basename: adapterName,
      ...(adapterPath
        ? {
            path: path.relative(process.cwd(), adapterPath) || '.',
            sha256: sha256File(adapterPath),
          }
        : {}),
    },
    profile: manifest.profile,
    suite: manifest.suite,
    runtimeBoundary: manifest.runtimeBoundary,
    languageProjection: manifest.languageProjection,
    latestReport: report
      ? {
          status: 'provided',
          path: path.relative(process.cwd(), reportPath) || '.',
          sha256: sha256File(reportPath),
          valid: report.valid === true,
          qualifying: report.qualifying === true,
          selfCertified: report.selfCertified === true,
          adapterDigest: report.adapter?.artifactDigest || '',
          resultRoot: report.execution?.resultRoot || '',
        }
      : {
          status: 'not-provided',
          environment: manifest.conformance.latestReportEnvironment,
        },
    claim: manifest.conformance.claim,
    nonClaims: manifest.conformance.nonClaims,
  };
}

/**
 * @param {Record<string, any>} registry
 * @param {string} registryPath
 * @param {Record<string, any>} aggregate
 * @returns {Record<string, any>}
 */
function buildKfdStandardsStatus(registry, registryPath, aggregate) {
  const schemas = kfdSchemaSummary();
  const { path: matrixPath, matrix } = readKfdSupportMatrix();
  const matrixRows = /** @type {Array<Record<string, any>>} */ (matrix.rows);
  /** @type {Record<string, string[]>} */
  const commandMap = {
    'kfd-1': [
      'kungfu sdk contract witness --json',
      'kungfu sdk contract audit --json',
      'kungfu sdk kfd 1 witness --json',
      'kungfu sdk kfd 1 gate --json',
      'kungfu sdk kfd 1 verify --json',
    ],
    'kfd-2': [
      'kungfu sdk kfd 2 claims --json',
      'kungfu sdk kfd 2 trust-claims --json',
      'kungfu sdk kfd 2 trust-assessment --json',
    ],
    'kfd-3': [
      'kungfu sdk kfd query --json',
      'kungfu sdk kfd check --json',
      'kungfu sdk kfd witness --json',
    ],
    'kfd-4': [
      'kungfu sdk kfd 4 schema --json',
      'kungfu sdk kfd schema kfd-4 --json',
    ],
  };
  /** @type {Record<string, string>} */
  const modeMap = {
    'kfd-1': 'contract-world',
    'kfd-2': 'release-claims',
    'kfd-3': registry.buildchain?.kfd3?.mode || 'declared-registry',
  };
  const standards = Object.fromEntries(
    matrixRows.map((row) => [
      row.key,
      {
        ...row,
        status: row.supportStatus,
        mode: modeMap[row.key] || row.claimClass,
        commands: commandMap[row.key] || [
          `kungfu sdk kfd schema ${row.key} --json`,
        ],
        schemaCount: schemas.standards[row.key]?.length || 0,
        ...(row.key === 'kfd-3'
          ? {
              surfaceCount: Array.isArray(registry.surfaces)
                ? registry.surfaces.length
                : 0,
            }
          : {}),
      },
    ]),
  );
  const support = Object.fromEntries(
    matrixRows.map((row) => [
      row.key,
      row.key === 'kfd-1'
        ? ['status', 'schema', 'witness', 'gate', 'verify']
        : row.key === 'kfd-2'
          ? ['status', 'schema', 'claims', 'trust-claims', 'trust-assessment']
          : row.key === 'kfd-3'
            ? ['status', 'schema', 'query', 'check', 'witness', 'aggregate']
            : ['status', 'schema'],
    ]),
  );
  return {
    schemaVersion: 1,
    contract: 'kungfu-sdk-kfd-standards-status',
    product: registry.product || { id: 'kungfu', name: 'Kungfu' },
    packages: {
      kfd: packageVersion('@kungfu-tech/kfd'),
      buildchain: packageVersion('@kungfu-tech/buildchain'),
    },
    source: {
      registry: {
        path: path.relative(process.cwd(), registryPath) || '.',
        sha256: sha256File(registryPath),
      },
      upstreamAggregate: {
        path:
          path.relative(process.cwd(), resolveKfdUpstreamAggregate()) || '.',
        sha256: sha256File(resolveKfdUpstreamAggregate()),
      },
      supportMatrix: {
        path: path.relative(process.cwd(), matrixPath) || '.',
        sha256: sha256File(matrixPath),
      },
    },
    matrix: {
      contract: matrix.contract,
      authority: matrix.authority,
      upstream: matrix.upstream,
      rowCount: matrixRows.length,
      shippedSupportCount: matrixRows.filter(
        (row) => row.releaseQualification.shippedSupport,
      ).length,
    },
    standards,
    support: {
      ...support,
      'agent-runtime': ['status'],
    },
    agentRuntime: buildKfdAgentRuntimeStatus(),
    buildchainStatus: collectKfdStatus({ cwd: process.cwd() }),
  };
}

/**
 * @param {Record<string, any>} document
 * @param {string} source
 * @returns {Record<string, any>}
 */
function kfd2ValidationDocument(document, source) {
  const validation =
    document?.contract === 'kfd-2-trust-claims'
      ? kfd2.validateTrustClaims(document)
      : kfd2.validateTrustAssessment(document);
  return {
    schemaVersion: 1,
    contract:
      document?.contract === 'kfd-2-trust-claims'
        ? 'kungfu-sdk-kfd-2-trust-claims'
        : 'kungfu-sdk-kfd-2-trust-assessment',
    source,
    document,
    validation,
  };
}

/**
 * @param {Record<string, any>} registry
 * @param {string} registryPath
 * @param {string} [warning]
 * @returns {Record<string, any>}
 */
function registryCapabilityQuery(registry, registryPath, warning = '') {
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-3-capability-query',
    product: registry.product?.name || 'Kungfu',
    source: {
      type: 'kungfu-sdk-kfd3-registry',
      path: path.relative(process.cwd(), registryPath) || '.',
      note: 'Kungfu SDK projects product KFD-3 surfaces into Buildchain-compatible capability facts.',
    },
    status: 'declared',
    warning,
    capabilities: (registry.surfaces || []).map(
      (/** @type {Record<string, any>} */ surface) => ({
        id: surface.id,
        kind: surface.kind,
        name: surface.name,
        state: surface.state || surface.availability || 'declared',
        detected: true,
        enforced:
          surface.state === 'enforced' || surface.enforcement === 'enforced',
        sourcePath: surface.sourcePath,
        artifactPath: surface.artifactPath || surface.evidencePath,
        kfd1Basis: {
          registryPath: path.relative(process.cwd(), registryPath) || '.',
          sourcePath: surface.sourcePath,
          artifactPath: surface.artifactPath || surface.evidencePath,
          digest: `sha256:${sha256KfdJson(surface)}`,
        },
        kfd2Trust: {
          status: 'release-passport-required',
          trustImpact: 'query-release-passport-for-final-trust',
          residualRisk: [],
        },
        residualRisk: [],
      }),
    ),
    kfd: {
      kfd1: 'registry-facts',
      kfd2: 'release-passport-required',
      kfd3: 'declared',
      kfd4: 'verified-candidate-not-shipped',
    },
  };
}

/**
 * @param {CliOptions} options
 * @returns {Promise<Record<string, any>>}
 */
async function kfdQuery(options) {
  const { path: registryPath, registry } = readKfd3Registry();
  try {
    const queryContext = kfd3RegistryQueryContext(registryPath);
    const query = await queryKfd3Capabilities({
      cwd: queryContext.cwd,
      product: registry.product?.id || 'kungfu',
      registryPath: queryContext.registryPath,
    });
    if (query.status !== 'failed' && query.kfd?.kfd3 !== 'failed') {
      return query;
    }
    return registryCapabilityQuery(
      registry,
      registryPath,
      'Buildchain standard detector could not cover Kungfu custom declared surfaces; using Kungfu SDK registry projection.',
    );
  } catch (error) {
    return registryCapabilityQuery(registry, registryPath, errorMessage(error));
  }
}

/**
 * @param {CliOptions} options
 * @returns {Promise<Record<string, any>>}
 */
async function kfdAggregate(options) {
  const { path: registryPath, registry } = readKfd3Registry();
  const { path: aggregatePath, aggregate } = readKfdUpstreamAggregate();
  const query = await kfdQuery(options);
  return {
    schemaVersion: 1,
    contract: 'kungfu-sdk-kfd-aggregate',
    product: registry.product || { id: 'kungfu', name: 'Kungfu' },
    source: {
      registry: {
        path: path.relative(process.cwd(), registryPath) || '.',
        sha256: sha256File(registryPath),
      },
      upstreamAggregate: {
        path: path.relative(process.cwd(), aggregatePath) || '.',
        sha256: sha256File(aggregatePath),
      },
    },
    own: {
      query,
      surfaceCount: Array.isArray(registry.surfaces)
        ? registry.surfaces.length
        : 0,
    },
    upstream: aggregate,
    kfd: {
      kfd1: 'registry-and-upstream-facts',
      kfd2: 'release-passport-required',
      kfd3: 'declared-and-aggregated',
      kfd4: 'verified-candidate-not-shipped',
    },
  };
}

/**
 * @param {string | undefined} command
 * @param {string[]} args
 * @param {CliOptions} options
 * @returns {Promise<void>}
 */
async function kfd(command, args, options) {
  const { path: registryPath, registry } = readKfd3Registry();
  if (command === 'status') {
    const { aggregate } = readKfdUpstreamAggregate();
    const status = buildKfdStandardsStatus(registry, registryPath, aggregate);
    if (options.json)
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD: ${Object.values(status.standards)
          .map((row) => `${row.key}=${row.status}`)
          .join(', ')}\n`,
      );
    return;
  }
  if (command === 'schema') {
    const standard = args[0] || '';
    if (!standard) fail('kfd schema requires <kfd-1..kfd-13>');
    const schema = readKfdSchemaDocument(standard, options.schema || args[1]);
    if (options.json)
      process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    else process.stdout.write(`${JSON.stringify(schema.schema, null, 2)}\n`);
    return;
  }
  if (
    ['agent-runtime', 'runtime'].includes(String(command || '').toLowerCase())
  ) {
    const action = args[0] || 'status';
    if (action !== 'status') {
      fail('unknown kfd agent-runtime command (supported: status)');
    }
    const status = buildKfdAgentRuntimeStatus();
    if (options.json)
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD Agent Runtime: ${status.status}, profile=${status.profile.id}@${status.profile.version}\n`,
      );
    return;
  }
  if (['1', 'kfd-1'].includes(String(command || '').toLowerCase())) {
    const action = args[0] || 'status';
    if (action === 'status') {
      const { aggregate } = readKfdUpstreamAggregate();
      const status = buildKfdStandardsStatus(registry, registryPath, aggregate)
        .standards['kfd-1'];
      if (options.json)
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else process.stdout.write(`Kungfu KFD-1: ${status.status}\n`);
      return;
    }
    if (action === 'schema') {
      const schema = readKfdSchemaDocument('kfd-1', options.schema || args[1]);
      if (options.json)
        process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
      else process.stdout.write(`${JSON.stringify(schema.schema, null, 2)}\n`);
      return;
    }
    if (action === 'witness') {
      const witness = readKfd1Witness();
      if (options.json)
        process.stdout.write(`${JSON.stringify(witness, null, 2)}\n`);
      else
        process.stdout.write(
          `Kungfu KFD-1 witness: ${witness.surfaces?.length || 0} surface(s)\n`,
        );
      return;
    }
    if (action === 'gate') {
      const gate = buildKfd1ReleaseGate(readKfd1Witness());
      if (options.json)
        process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
      else process.stdout.write(`Kungfu KFD-1 gate: ${gate.status}\n`);
      return;
    }
    if (action === 'verify') {
      const result = buildKfd1VerifyResult(
        buildKfd1ReleaseGate(readKfd1Witness()),
      );
      if (options.json)
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else
        process.stdout.write(
          `Kungfu KFD-1 verify: ${result.ok ? 'ok' : 'failed'}\n`,
        );
      if (!result.ok) process.exitCode = 1;
      return;
    }
    fail(
      'unknown kfd 1 command (supported: status, schema, witness, gate, verify)',
    );
  }
  if (['2', 'kfd-2'].includes(String(command || '').toLowerCase())) {
    const action = args[0] || 'status';
    if (action === 'status') {
      const { aggregate } = readKfdUpstreamAggregate();
      const status = buildKfdStandardsStatus(registry, registryPath, aggregate)
        .standards['kfd-2'];
      if (options.json)
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else process.stdout.write(`Kungfu KFD-2: ${status.status}\n`);
      return;
    }
    if (action === 'schema') {
      const schema = readKfdSchemaDocument('kfd-2', options.schema || args[1]);
      if (options.json)
        process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
      else process.stdout.write(`${JSON.stringify(schema.schema, null, 2)}\n`);
      return;
    }
    if (action === 'claims') {
      const claims = readKfd2ClaimsDocument();
      if (options.json)
        process.stdout.write(`${JSON.stringify(claims, null, 2)}\n`);
      else
        process.stdout.write(
          `Kungfu KFD-2 claims: ${claims.buildchainProjection.claimCount} packaged claim(s)\n`,
        );
      return;
    }
    if (action === 'trust-claims') {
      const result = kfd2ValidationDocument(
        kfd2.readFoundationTrustClaims(),
        '@kungfu-tech/kfd foundation trust claims',
      );
      if (options.json)
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else
        process.stdout.write(
          `Kungfu KFD-2 trust-claims: ${result.validation.ok ? 'ok' : 'failed'}\n`,
        );
      if (!result.validation.ok) process.exitCode = 1;
      return;
    }
    if (action === 'trust-assessment') {
      const result = kfd2ValidationDocument(
        kfd2.readFoundationTrustAssessment(),
        '@kungfu-tech/kfd foundation trust assessment',
      );
      if (options.json)
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else
        process.stdout.write(
          `Kungfu KFD-2 trust-assessment: ${result.validation.ok ? 'ok' : 'failed'}\n`,
        );
      if (!result.validation.ok) process.exitCode = 1;
      return;
    }
    fail(
      'unknown kfd 2 command (supported: status, schema, claims, trust-claims, trust-assessment)',
    );
  }
  if (['4', 'kfd-4'].includes(String(command || '').toLowerCase())) {
    const action = args[0] || 'status';
    if (action === 'status') {
      const { aggregate } = readKfdUpstreamAggregate();
      const status = buildKfdStandardsStatus(registry, registryPath, aggregate)
        .standards['kfd-4'];
      if (options.json)
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else process.stdout.write(`Kungfu KFD-4: ${status.status}\n`);
      return;
    }
    if (action === 'schema') {
      const schema = readKfdSchemaDocument('kfd-4', options.schema || args[1]);
      if (options.json)
        process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
      else process.stdout.write(`${JSON.stringify(schema.schema, null, 2)}\n`);
      return;
    }
    fail('unknown kfd 4 command (supported: status, schema)');
  }
  if (command === 'query') {
    const query = await kfdQuery(options);
    if (options.json)
      process.stdout.write(`${JSON.stringify(query, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD-3 capabilities: ${query.capabilities?.length || 0} (${query.status || 'unknown'})\n`,
      );
    return;
  }
  if (command === 'check') {
    const query = await kfdQuery(options);
    const { path: aggregatePath, aggregate } = readKfdUpstreamAggregate();
    const output = {
      schema: 'kungfu.sdk.kfd-check/v1',
      ok: true,
      registry: {
        path: path.relative(process.cwd(), registryPath) || '.',
        sha256: sha256File(registryPath),
        surfaceCount: Array.isArray(registry.surfaces)
          ? registry.surfaces.length
          : 0,
        strict: {
          mode: registry.buildchain?.kfd3?.mode || '',
          sourceOfTruth: registry.policy?.sourceOfTruth || '',
          registryPath: registry.registryPath || '',
          contract: registry.contract || '',
        },
      },
      upstreamAggregate: {
        path: path.relative(process.cwd(), aggregatePath) || '.',
        sha256: sha256File(aggregatePath),
        upstreamCount: aggregate.summary?.upstreamCount || 0,
      },
      supportMatrix: {
        path: path.relative(process.cwd(), resolveKfdSupportMatrix()) || '.',
        sha256: sha256File(resolveKfdSupportMatrix()),
        rowCount: readKfdSupportMatrix().matrix.rows?.length || 0,
      },
      query: {
        status: query.status || 'unknown',
        capabilityCount: query.capabilities?.length || 0,
        kfd: query.kfd || {},
        warning: query.warning || '',
      },
      standards: buildKfdStandardsStatus(registry, registryPath, aggregate)
        .standards,
    };
    if (options.json)
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD-3 check: ok, capabilities=${output.query.capabilityCount}\n`,
      );
    return;
  }
  if (command === 'upstream') {
    const { aggregate } = readKfdUpstreamAggregate();
    if (options.json)
      process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu upstream KFD aggregate: ${aggregate.summary?.upstreamCount || 0} upstream(s)\n`,
      );
    return;
  }
  if (command === 'aggregate') {
    const aggregate = await kfdAggregate(options);
    if (options.json)
      process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD aggregate: own=${aggregate.own.surfaceCount}, upstream=${aggregate.upstream.summary?.upstreamCount || 0}\n`,
      );
    return;
  }
  if (command === 'witness') {
    const witness = {
      schemaVersion: 1,
      id: 'kungfu-sdk-kfd3-capability-witness',
      standard: 'kfd-3',
      witnessKind: 'installed-sdk-query',
      product: registry.product || { id: 'kungfu', name: 'Kungfu' },
      sourceRegistry: {
        path: path.relative(process.cwd(), registryPath) || '.',
        sha256: sha256File(registryPath),
      },
      exposedSurfaces: registry.surfaces || [],
      residualRisk: [
        'Installed CLI witnesses declare local capability facts; final release trust is determined by the Buildchain release passport KFD-2 context.',
      ],
    };
    if (options.json)
      process.stdout.write(`${JSON.stringify(witness, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD-3 witness: ${witness.exposedSurfaces.length} declared surface(s)\n`,
      );
    return;
  }
  fail(
    'unknown kfd command (supported: status, schema, 1, 2, 4, agent-runtime, query, check, witness, upstream, aggregate)',
  );
}

export { kfd };
