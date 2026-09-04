// SPDX-License-Identifier: Apache-2.0

/** Contract adoption, rendering, evidence, and policy commands. */
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

function locateRepoRoot(startDir) {
  for (const dir of ancestorDirs(startDir)) {
    const candidate = path.join(
      dir,
      'framework',
      'spec',
      'contract',
      CONTRACT_REGISTRY_FILE,
    );
    if (fs.existsSync(candidate)) return dir;
  }
  fail(`cannot locate ${CONTRACT_REGISTRY_FILE} from ${startDir}`);
}

/**
 * @param {string} repoRoot
 * @param {string} target
 * @returns {string}
 */
function rel(repoRoot, target) {
  return path.relative(repoRoot, target).split(path.sep).join('/');
}

/**
 * @param {string} repoRoot
 * @param {string} target
 * @returns {string}
 */
function repoRelativePath(repoRoot, target) {
  const relative = rel(repoRoot, path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`path must stay inside the repository: ${target}`);
  }
  return relative;
}

/**
 * @param {string} surface
 * @returns {string}
 */
function normalizeSurface(surface) {
  const normalized = surface.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(normalized)) {
    fail(`invalid contract surface: ${surface}`);
  }
  return normalized;
}

/**
 * @param {string} surface
 * @returns {string}
 */
function contractEnvName(surface) {
  return `KUNGFU_${surface.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_CONTRACT`;
}

/**
 * @param {Record<string, unknown>} registry
 * @param {string} surface
 * @returns {boolean}
 */
function hasContractEntry(registry, surface) {
  return /** @type {unknown[]} */ (registry.contracts).some(
    (entry) => isObject(entry) && entry.surface === surface,
  );
}

/**
 * @param {string} surface
 * @returns {Record<string, unknown>}
 */
function contractTemplate(surface) {
  const schema = `kungfu.${surface}.contract/v1`;
  const id = `kungfu-${surface}`;
  const weldedSurface = `${surface}-contract`;
  return {
    schema,
    id,
    version: 1,
    weldedSurface,
    description: `KFD-1 contract source for ${surface}.`,
    contractSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: true,
      required: [
        'schema',
        'id',
        'version',
        'weldedSurface',
        'description',
        'contractSchema',
      ],
      properties: {
        schema: { type: 'string', const: schema },
        id: { type: 'string', const: id },
        version: { type: 'integer', minimum: 1 },
        weldedSurface: { type: 'string', const: weldedSurface },
        description: { type: 'string' },
        contractSchema: { type: 'object' },
      },
    },
  };
}

/**
 * @param {string} surface
 * @param {string} source
 * @returns {Record<string, unknown>}
 */
function registryEntryTemplate(surface, source) {
  const file = path.basename(source);
  return {
    surface,
    id: `kungfu-${surface}`,
    schema: `kungfu.${surface}.contract/v1`,
    weldedSurface: `${surface}-contract`,
    env: contractEnvName(surface),
    file,
    source,
    artifact: `config/${file}`,
    probeFixture: contractFixturePath(surface),
  };
}

/**
 * @param {string} surface
 * @returns {string}
 */
function contractFixturePath(surface) {
  return `framework/spec/contract/fixtures/${surface}.contract-evidence.json`;
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveContractRegistryPath(repoRoot) {
  const explicit = process.env[CONTRACT_REGISTRY_ENV];
  if (explicit) return path.resolve(explicit);
  return path.join(repoRoot, 'framework/spec/contract', CONTRACT_REGISTRY_FILE);
}

/**
 * @param {string} registryPath
 * @returns {Record<string, unknown>}
 */
function loadContractRegistry(registryPath) {
  const registry = readJson(registryPath);
  if (!isObject(registry)) {
    fail(`contract registry must be a JSON object: ${registryPath}`);
  }
  if (registry.schema !== CONTRACT_REGISTRY_SCHEMA) {
    fail(`contract registry schema mismatch: ${String(registry.schema)}`);
  }
  if (!Array.isArray(registry.contracts)) {
    fail('contract registry must contain a contracts array');
  }
  return registry;
}

/**
 * @param {Record<string, unknown>} registry
 * @returns {Array<Record<string, unknown>>}
 */
function registryContracts(registry) {
  if (!Array.isArray(registry.contracts)) {
    fail('contract registry must contain a contracts array');
  }
  return /** @type {Array<Record<string, unknown>>} */ (registry.contracts);
}

/**
 * @param {string} exportPath
 * @returns {unknown}
 */
function readJsonPackageExport(exportPath) {
  return JSON.parse(fs.readFileSync(require.resolve(exportPath), 'utf8'));
}

/**
 * @param {string} packageName
 * @returns {{ name: string, version: string }}
 */
function packageIdentity(packageName) {
  const packageJson = readJsonPackageExport(`${packageName}/package.json`);
  if (!isObject(packageJson)) {
    fail(`package metadata must be a JSON object: ${packageName}`);
  }
  return {
    name: String(packageJson.name || packageName),
    version: String(packageJson.version || ''),
  };
}

/**
 * @param {Record<string, unknown>} schema
 * @returns {string}
 */
function schemaContractConst(schema) {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const contract = isObject(properties.contract) ? properties.contract : {};
  const value = contract.const;
  if (typeof value !== 'string' || value.length === 0) {
    fail('KFD schema export missing properties.contract.const');
  }
  return value;
}

/**
 * @param {ReturnType<typeof resolveKfd1Metadata>} metadata
 * @returns {{ contractWorld: string, witness: string }}
 */
function kfd1SchemaConstants(metadata) {
  const contractWorldSchema = readJsonPackageExport(
    `@kungfu-tech/kfd/${metadata.schemaPaths.contractWorld}`,
  );
  const witnessSchema = readJsonPackageExport(
    `@kungfu-tech/kfd/${metadata.schemaPaths.witness}`,
  );
  if (!isObject(contractWorldSchema) || !isObject(witnessSchema)) {
    fail('KFD schema exports must be JSON objects');
  }
  return {
    contractWorld: schemaContractConst(contractWorldSchema),
    witness: schemaContractConst(witnessSchema),
  };
}

/**
 * @param {string} repoRoot
 * @returns {{ source: string, artifact: string }}
 */
function canonicalPolicyPaths(repoRoot) {
  const registry = loadContractRegistry(resolveContractRegistryPath(repoRoot));
  const declared = isObject(registry.canonicalPolicy)
    ? /** @type {Record<string, unknown>} */ (registry.canonicalPolicy)
    : {};
  return {
    source:
      typeof declared.source === 'string'
        ? declared.source
        : path.join('framework', 'spec', 'contract', CANONICAL_POLICY_FILE),
    artifact:
      typeof declared.artifact === 'string'
        ? declared.artifact
        : path.join('config', CANONICAL_POLICY_FILE),
  };
}

/**
 * @param {Record<string, unknown>} registry
 * @param {string} surface
 * @returns {Record<string, unknown>}
 */
function findContractEntry(registry, surface) {
  const matches = /** @type {unknown[]} */ (registry.contracts).filter(
    (entry) => isObject(entry) && entry.surface === surface,
  );
  if (matches.length === 0) {
    fail(`contract surface is not registered: ${surface}`);
  }
  if (matches.length > 1) {
    fail(`contract surface is registered more than once: ${surface}`);
  }
  return /** @type {Record<string, unknown>} */ (matches[0]);
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} key
 * @returns {string}
 */
function requiredString(entry, key) {
  const value = entry[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`contract registry entry missing string field: ${key}`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} contract
 * @param {string} key
 * @returns {string | number}
 */
function requiredScalar(contract, key) {
  const value = contract[key];
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    value === ''
  ) {
    fail(`contract file missing scalar field: ${key}`);
  }
  return value;
}

/**
 * @param {string | undefined} surface
 * @param {CliOptions} options
 * @returns {{
 *   repoRoot: string,
 *   registryPath: string,
 *   entry: Record<string, unknown>,
 *   contractPath: string,
 *   contractText: string,
 *   contract: Record<string, unknown>,
 * }}
 */
function loadContractSurface(surface, options) {
  if (!surface) usage(1);
  const repoRoot = locateRepoRoot(process.cwd());
  const registryPath = resolveContractRegistryPath(repoRoot);
  const registry = loadContractRegistry(registryPath);
  const entry = findContractEntry(registry, surface);
  const registeredSource = requiredString(entry, 'source');
  const contractPath = path.resolve(repoRoot, registeredSource);
  if (!fs.existsSync(contractPath)) {
    fail(`registered contract source does not exist: ${registeredSource}`);
  }
  if (options.source) {
    const requested = path.resolve(options.source);
    if (requested !== contractPath) {
      fail(
        `--source does not match registry source for ${surface}: ${rel(repoRoot, requested)} != ${registeredSource}`,
      );
    }
  }
  const contractText = fs.readFileSync(contractPath, 'utf8');
  const parsed = JSON.parse(contractText);
  if (!isObject(parsed)) {
    fail(`contract source must be a JSON object: ${registeredSource}`);
  }
  const contract = parsed;
  const expected = {
    schema: requiredString(entry, 'schema'),
    id: requiredString(entry, 'id'),
    weldedSurface: requiredString(entry, 'weldedSurface'),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (contract[key] !== value) {
      fail(
        `${surface} contract ${key} mismatch: ${String(contract[key])} != ${value}`,
      );
    }
  }
  requiredScalar(contract, 'version');
  if (!isObject(contract.contractSchema)) {
    fail(`${surface} contract missing contractSchema object`);
  }
  return {
    repoRoot,
    registryPath,
    entry,
    contractPath,
    contractText,
    contract,
  };
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {Array<Record<string, unknown>>}
 */
function extraArtifacts(entry) {
  return Array.isArray(entry.extraArtifacts)
    ? /** @type {Array<Record<string, unknown>>} */ (
        entry.extraArtifacts.filter(isObject)
      )
    : [];
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {Array<{ id: string, label: string, source: string, artifact: string, sourceHash: string, byteForByte: boolean }>}
 */
function contractKfdProjectionRows(entry) {
  const repoRoot = locateRepoRoot(process.cwd());
  return extraArtifacts(entry)
    .filter((artifact) => typeof artifact.kfdId === 'string')
    .map((artifact) => {
      const id = requiredString(artifact, 'kfdId');
      const label = requiredString(artifact, 'label');
      const source = requiredString(artifact, 'source');
      const artifactPath = requiredString(artifact, 'artifact');
      const sourcePath = path.resolve(repoRoot, source);
      const packagedPath = path.resolve(repoRoot, artifactPath);
      if (!fs.existsSync(sourcePath)) {
        fail(`registered KFD projection source does not exist: ${source}`);
      }
      const sourceHash = sha256File(sourcePath);
      return {
        id,
        label,
        source,
        artifact: artifactPath,
        sourceHash,
        byteForByte:
          fs.existsSync(packagedPath) &&
          sourceHash === sha256File(packagedPath),
      };
    });
}

/**
 * @param {string | undefined} surface
 * @param {CliOptions} options
 * @returns {void}
 */
function contractAdopt(surface, options) {
  const state = loadContractSurface(surface, options);
  const data = {
    schema: 'kungfu.sdk.contract-adopt/v1',
    ok: true,
    surface,
    registry: rel(state.repoRoot, state.registryPath),
    source: rel(state.repoRoot, state.contractPath),
    artifact: requiredString(state.entry, 'artifact'),
    env: requiredString(state.entry, 'env'),
    contract: {
      id: state.contract.id,
      schema: state.contract.schema,
      version: state.contract.version,
      weldedSurface: state.contract.weldedSurface,
      hash: sha256File(state.contractPath),
    },
    render: {
      mode: 'source-json-replay',
      checkCommand: `kungfu sdk contract render ${surface} --check --json`,
    },
    extraArtifacts: extraArtifacts(state.entry).map((artifact) => ({
      label: artifact.label,
      source: artifact.source,
      artifact: artifact.artifact,
    })),
  };
  if (options.json) {
    process.stdout.write(renderJson(data));
    return;
  }
  process.stdout.write(
    [
      `[contract] adopted ${surface}`,
      `  source: ${data.source}`,
      `  artifact: ${data.artifact}`,
      `  hash: ${data.contract.hash}`,
      `  check: ${data.render.checkCommand}`,
      '',
    ].join('\n'),
  );
}

/**
 * @param {string | undefined} surface
 * @param {CliOptions} options
 * @returns {void}
 */
function contractRender(surface, options) {
  const state = loadContractSurface(surface, options);
  const rendered = renderJson(state.contract);
  if (options.check && options.write) {
    fail('contract render accepts either --check or --write, not both');
  }
  if (options.write) {
    const previousHash = sha256File(state.contractPath);
    fs.writeFileSync(state.contractPath, rendered);
    const data = {
      schema: 'kungfu.sdk.contract-render-write/v1',
      ok: true,
      surface,
      source: rel(state.repoRoot, state.contractPath),
      previousHash,
      hash: sha256File(state.contractPath),
      changed: state.contractText !== rendered,
      mode: 'canonical-json',
    };
    if (options.json) {
      process.stdout.write(renderJson(data));
    } else {
      process.stdout.write(
        `[contract] ${surface} wrote ${data.source} changed=${data.changed}\n`,
      );
    }
    return;
  }
  if (!options.check) {
    process.stdout.write(rendered);
    return;
  }
  const data = {
    schema: 'kungfu.sdk.contract-render-check/v1',
    ok: true,
    surface,
    source: rel(state.repoRoot, state.contractPath),
    hash: sha256File(state.contractPath),
    renderedHash: `sha256:${createHash('sha256').update(rendered).digest('hex')}`,
    mode: 'canonical-json',
    byteForByte: state.contractText === rendered,
  };
  if (options.json) {
    process.stdout.write(renderJson(data));
  } else if (data.ok) {
    process.stdout.write(`[contract] ${surface} render check ok\n`);
  } else {
    process.stderr.write(`[contract] ${surface} render check failed\n`);
  }
  if (!data.ok) process.exit(1);
}

/**
 * @param {ReturnType<typeof loadContractSurface>} state
 * @returns {Record<string, unknown>}
 */
function contractEvidenceRow(state) {
  const source = rel(state.repoRoot, state.contractPath);
  const rendered = renderJson(state.contract);
  const surface = requiredString(state.entry, 'surface');
  const fixture =
    typeof state.entry.probeFixture === 'string'
      ? state.entry.probeFixture
      : contractFixturePath(surface);
  const fixturePath = path.resolve(state.repoRoot, fixture);
  const fixtureExists = fs.existsSync(fixturePath);
  return {
    surface,
    source,
    artifact: requiredString(state.entry, 'artifact'),
    env: requiredString(state.entry, 'env'),
    fixture: {
      path: fixture,
      exists: fixtureExists,
      hash: fixtureExists ? sha256File(fixturePath) : null,
    },
    contract: {
      id: state.contract.id,
      schema: state.contract.schema,
      version: state.contract.version,
      weldedSurface: state.contract.weldedSurface,
      sourceHash: sha256File(state.contractPath),
      renderedHash: `sha256:${createHash('sha256').update(rendered).digest('hex')}`,
      byteForByte: state.contractText === rendered,
    },
    extraArtifacts: extraArtifacts(state.entry).map((artifact) => ({
      label: artifact.label,
      source: artifact.source,
      artifact: artifact.artifact,
    })),
  };
}

/**
 * @param {string | undefined} surface
 * @param {CliOptions} options
 * @returns {void}
 */
function contractEvidence(surface, options) {
  const repoRoot = locateRepoRoot(process.cwd());
  const registryPath = resolveContractRegistryPath(repoRoot);
  const registry = loadContractRegistry(registryPath);
  const metadata = resolveKfd1Metadata();
  const surfaces = surface
    ? [surface]
    : registryContracts(registry).map((entry) =>
        requiredString(entry, 'surface'),
      );
  const contracts = surfaces.map((name) =>
    contractEvidenceRow(loadContractSurface(name, options)),
  );
  const data = {
    schema: 'kungfu.sdk.contract-evidence/v1',
    ok: true,
    registry: rel(repoRoot, registryPath),
    releaseGate: {
      kfd: metadata.label,
      key: metadata.key,
      claim: metadata.title,
      role: 'local-evidence',
      sourceOfTruth: rel(repoRoot, registryPath),
      policy: 'advisory-only; this command does not enforce release policy',
      metadata: {
        package: metadata.package,
        schemaIds: metadata.schemaIds,
        schemaPaths: metadata.schemaPaths,
      },
    },
    summary: {
      count: contracts.length,
      surfaces: contracts.map((contract) => contract.surface),
      byteForByte: contracts.every(
        (contract) =>
          isObject(contract.contract) && contract.contract.byteForByte === true,
      ),
      fixtures: contracts.filter(
        (contract) =>
          isObject(contract.fixture) && contract.fixture.exists === true,
      ).length,
    },
    contracts,
  };
  if (options.json) {
    process.stdout.write(renderJson(data));
    return;
  }
  process.stdout.write(
    [
      `[contract] evidence surfaces=${data.summary.count} fixtures=${data.summary.fixtures}`,
      `  registry: ${data.registry}`,
      `  byte-for-byte: ${data.summary.byteForByte}`,
      '',
    ].join('\n'),
  );
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {{ id: string, surface: string, source: string, artifact: string, contractPath: string, contract: Record<string, unknown>, sourceHash: string, renderedHash: string, byteForByte: boolean }}
 */
function contractPolicySurface(entry) {
  const surface = requiredString(entry, 'surface');
  const state = loadContractSurface(surface, {
    workspace: false,
    name: '',
    source: '',
    dir: '',
    schema: '',
    check: false,
    write: false,
    json: true,
    dryRun: false,
  });
  const rendered = renderJson(state.contract);
  return {
    id: requiredString(entry, 'id'),
    surface,
    source: rel(state.repoRoot, state.contractPath),
    artifact: requiredString(entry, 'artifact'),
    contractPath: state.contractPath,
    contract: state.contract,
    sourceHash: sha256File(state.contractPath),
    renderedHash: `sha256:${createHash('sha256').update(rendered).digest('hex')}`,
    byteForByte: state.contractText === rendered,
  };
}

/**
 * @param {string} repoRoot
 * @param {Record<string, unknown>} registry
 * @returns {Record<string, unknown>}
 */
function buildContractWorld(repoRoot, registry) {
  const metadata = resolveKfd1Metadata();
  const constants = kfd1SchemaConstants(metadata);
  const registryPath = resolveContractRegistryPath(repoRoot);
  const surfaces = registryContracts(registry).flatMap((entry) => {
    const surface = contractPolicySurface(entry);
    return [
      {
        id: surface.id,
        class: 'integration-time',
        description: `${surface.surface} contract source ${surface.source} is copied byte-for-byte to ${surface.artifact}.`,
      },
      ...contractKfdProjectionRows(entry).map((projection) => ({
        id: projection.id,
        class: 'integration-time',
        description: `${projection.label} source ${projection.source} is copied byte-for-byte to ${projection.artifact}.`,
      })),
    ];
  });
  return {
    schemaVersion: 1,
    contract: constants.contractWorld,
    standard: metadata.key,
    factSource: rel(repoRoot, registryPath),
    surfaces,
  };
}

/**
 * @param {string} repoRoot
 * @returns {Record<string, unknown>}
 */
function buildCanonicalPolicy(repoRoot) {
  const registryPath = resolveContractRegistryPath(repoRoot);
  const registry = loadContractRegistry(registryPath);
  const metadata = resolveKfd1Metadata();
  const policyPaths = canonicalPolicyPaths(repoRoot);
  const contractWorld = buildContractWorld(repoRoot, registry);
  const surfaces = registryContracts(registry).map((entry) => {
    const surface = contractPolicySurface(entry);
    return {
      surface: surface.surface,
      id: surface.id,
      recipe: {
        path: surface.source,
        generator: 'kungfu sdk contract render',
        evidence: 'kungfu sdk contract evidence',
      },
      source: {
        path: surface.source,
        sha256: surface.sourceHash,
        renderedSha256: surface.renderedHash,
        byteForByte: surface.byteForByte,
      },
      artifact: {
        path: surface.artifact,
        expectedSha256: surface.sourceHash,
      },
    };
  });
  return {
    schema: CANONICAL_POLICY_SCHEMA,
    id: 'kungfu-agent-first-canonical-policy',
    description:
      'Agent-readable policy for deriving Kungfu KFD-1 contract-world evidence from one registry and upstream KFD/Buildchain metadata.',
    upstream: {
      kfd: {
        package: metadata.package,
        standard: {
          key: metadata.key,
          id: metadata.id,
          label: metadata.label,
          title: metadata.title,
          revision: metadata.revision,
          status: metadata.status,
        },
        schemaIds: metadata.schemaIds,
        schemaPaths: metadata.schemaPaths,
      },
      buildchain: {
        package: packageIdentity('@kungfu-tech/buildchain'),
        formatting: BUILDCHAIN_JSON_FORMATTING_POLICY,
        releaseGate: {
          witnessInput: '--kfd-1-witness-json',
          passportKey: metadata.key,
        },
      },
    },
    sourceOfTruth: {
      registry: rel(repoRoot, registryPath),
      registrySchema: registry.schema,
      policySource: policyPaths.source,
      policyArtifact: policyPaths.artifact,
    },
    generation: {
      renderer: 'kungfu sdk contract render <surface> --check --json',
      witness: 'kungfu sdk contract witness --json',
      audit: 'kungfu sdk contract audit --json',
      artifactRule:
        'Each registered source contract is copied byte-for-byte to its declared frozen config artifact.',
    },
    contractWorld: {
      schemaId: metadata.schemaIds.contractWorld,
      digest: `sha256:${sha256KfdJson(contractWorld)}`,
      value: contractWorld,
    },
    surfaces,
  };
}

/**
 * @param {string} repoRoot
 * @returns {Record<string, unknown>}
 */
function buildContractWorldWitness(repoRoot) {
  const registryPath = resolveContractRegistryPath(repoRoot);
  const registry = loadContractRegistry(registryPath);
  const metadata = resolveKfd1Metadata();
  const constants = kfd1SchemaConstants(metadata);
  const policyPaths = canonicalPolicyPaths(repoRoot);
  const policyPath = path.resolve(repoRoot, policyPaths.source);
  const contractWorld = buildContractWorld(repoRoot, registry);
  const policy = buildCanonicalPolicy(repoRoot);
  return normalizeKfd1ContractWorldWitness(
    {
      schemaVersion: 1,
      contract: constants.witness,
      id: 'kungfu-contracts',
      standard: metadata.key,
      source: {
        repo: 'kungfu-systems/kungfu',
        registry: rel(repoRoot, registryPath),
        policy: policyPaths.source,
      },
      contractWorld: {
        schemaId: metadata.schemaIds.contractWorld,
        digest: `sha256:${sha256KfdJson(contractWorld)}`,
      },
      canonicalPolicy: {
        path: policyPaths.source,
        sha256: fs.existsSync(policyPath)
          ? sha256File(policyPath)
          : `sha256:${createHash('sha256').update(renderJson(policy)).digest('hex')}`,
      },
      registry: {
        path: rel(repoRoot, registryPath),
        sha256: sha256File(registryPath),
      },
      surfaces: registryContracts(registry).flatMap((entry) => {
        const surface = contractPolicySurface(entry);
        return [
          {
            name: surface.id,
            sourcePath: surface.source,
            sourceSha256: surface.sourceHash,
            artifactPath: surface.artifact,
            expectedSha256: surface.sourceHash,
            byteForByte: surface.byteForByte,
          },
          ...contractKfdProjectionRows(entry).map((projection) => ({
            name: projection.id,
            sourcePath: projection.source,
            sourceSha256: projection.sourceHash,
            artifactPath: projection.artifact,
            expectedSha256: projection.sourceHash,
            byteForByte: projection.byteForByte,
          })),
        ];
      }),
    },
    { metadata },
  );
}

/**
 * @param {Record<string, unknown>} data
 * @param {CliOptions} options
 * @param {string[]} lines
 * @returns {void}
 */
function printContractCommand(data, options, lines) {
  if (options.json) {
    process.stdout.write(renderJson(data));
    return;
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * @param {CliOptions} options
 * @returns {void}
 */
function contractPolicy(options) {
  const repoRoot = locateRepoRoot(process.cwd());
  const policyPaths = canonicalPolicyPaths(repoRoot);
  const policyPath = path.resolve(repoRoot, policyPaths.source);
  const policyArtifactPath = path.resolve(repoRoot, policyPaths.artifact);
  const policy = buildCanonicalPolicy(repoRoot);
  const rendered = renderJson(policy);
  if (options.check && options.write) {
    fail('contract policy accepts either --check or --write, not both');
  }
  if (options.write) {
    const previousHash = fs.existsSync(policyPath)
      ? sha256File(policyPath)
      : '';
    const previousArtifactHash = fs.existsSync(policyArtifactPath)
      ? sha256File(policyArtifactPath)
      : '';
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.mkdirSync(path.dirname(policyArtifactPath), { recursive: true });
    fs.writeFileSync(policyPath, rendered);
    fs.writeFileSync(policyArtifactPath, rendered);
    printContractCommand(
      {
        schema: 'kungfu.sdk.contract-policy-write/v1',
        ok: true,
        source: policyPaths.source,
        artifact: policyPaths.artifact,
        previousHash,
        previousArtifactHash,
        hash: sha256File(policyPath),
        artifactHash: sha256File(policyArtifactPath),
        changed:
          !previousHash ||
          previousHash !== sha256File(policyPath) ||
          !previousArtifactHash ||
          previousArtifactHash !== sha256File(policyArtifactPath),
      },
      options,
      [
        `[contract] policy wrote ${policyPaths.source}`,
        `  hash: ${sha256File(policyPath)}`,
      ],
    );
    return;
  }
  if (options.check) {
    const existing = fs.existsSync(policyPath)
      ? fs.readFileSync(policyPath, 'utf8')
      : '';
    const existingArtifact = fs.existsSync(policyArtifactPath)
      ? fs.readFileSync(policyArtifactPath, 'utf8')
      : '';
    const data = {
      schema: 'kungfu.sdk.contract-policy-check/v1',
      ok: existing === rendered && existingArtifact === rendered,
      status:
        existing === rendered && existingArtifact === rendered
          ? 'current'
          : 'mismatched',
      source: policyPaths.source,
      artifact: policyPaths.artifact,
      hash: fs.existsSync(policyPath) ? sha256File(policyPath) : '',
      artifactHash: fs.existsSync(policyArtifactPath)
        ? sha256File(policyArtifactPath)
        : '',
      renderedHash: `sha256:${createHash('sha256').update(rendered).digest('hex')}`,
    };
    printContractCommand(data, options, [
      `[contract] policy ${data.status}`,
      `  source: ${data.source}`,
    ]);
    if (!data.ok) process.exit(1);
    return;
  }
  if (options.json) process.stdout.write(rendered);
  else
    process.stdout.write(
      `[contract] policy ${policyPaths.source} (${registryContracts({ contracts: policy.surfaces }).length} surfaces)\n`,
    );
}

/**
 * @param {CliOptions} options
 * @returns {void}
 */
function contractWitness(options) {
  const repoRoot = locateRepoRoot(process.cwd());
  const witness = buildContractWorldWitness(repoRoot);
  if (options.json) {
    process.stdout.write(renderJson(witness));
    return;
  }
  process.stdout.write(
    `[contract] witness ${witness.id} surfaces=${Array.isArray(witness.surfaces) ? witness.surfaces.length : 0}\n`,
  );
}

/**
 * @param {CliOptions} options
 * @returns {void}
 */
function contractAudit(options) {
  const repoRoot = locateRepoRoot(process.cwd());
  const policyPaths = canonicalPolicyPaths(repoRoot);
  const policyPath = path.resolve(repoRoot, policyPaths.source);
  const policy = buildCanonicalPolicy(repoRoot);
  const renderedPolicy = renderJson(policy);
  const existingPolicy = fs.existsSync(policyPath)
    ? fs.readFileSync(policyPath, 'utf8')
    : '';
  const witness = buildContractWorldWitness(repoRoot);
  const metadata = resolveKfd1Metadata();
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
    metadata,
  });
  const gateIssues = validateKfd1ReleaseGateEvidence(gate?.passportSection, {
    metadata,
  });
  const contractRows = /** @type {Array<Record<string, unknown>>} */ (
    policy.surfaces
  ).map((surface) => ({
    surface: surface.surface,
    status:
      isObject(surface.source) && surface.source.byteForByte === true
        ? 'current'
        : 'mismatched',
    source: isObject(surface.source) ? surface.source.path : '',
    artifact: isObject(surface.artifact) ? surface.artifact.path : '',
    sourceHash: isObject(surface.source) ? surface.source.sha256 : '',
    artifactExpectedHash: isObject(surface.artifact)
      ? surface.artifact.expectedSha256
      : '',
  }));
  const failures = [
    ...(existingPolicy === renderedPolicy
      ? []
      : [
          {
            code: 'canonical-policy.mismatched',
            message:
              'framework/spec/contract canonical policy file differs from SDK-rendered policy',
          },
        ]),
    ...contractRows
      .filter((row) => row.status !== 'current')
      .map((row) => ({
        code: 'contract.render.mismatched',
        message: `${row.surface} source is not byte-for-byte canonical`,
      })),
    .../** @type {Array<{ code: string, message: string }>} */ (gateIssues).map(
      (issue) => ({
        code: issue.code,
        message: issue.message,
      }),
    ),
  ];
  const data = {
    schema: 'kungfu.sdk.contract-audit/v1',
    ok: failures.length === 0,
    status: failures.length === 0 ? 'current' : 'mismatched',
    upstream: policy.upstream,
    policy: {
      source: policyPaths.source,
      artifact: policyPaths.artifact,
      status: existingPolicy === renderedPolicy ? 'current' : 'mismatched',
      hash: fs.existsSync(policyPath) ? sha256File(policyPath) : '',
      renderedHash: `sha256:${createHash('sha256').update(renderedPolicy).digest('hex')}`,
    },
    witness: {
      id: witness.id,
      standard: witness.standard,
      contractWorldDigest: isObject(witness.contractWorld)
        ? witness.contractWorld.digest
        : '',
      digest: `sha256:${sha256KfdJson(witness)}`,
    },
    releaseGate: gate?.passportSection || null,
    contracts: contractRows,
    failures,
  };
  printContractCommand(data, options, [
    `[contract] audit ${data.status}`,
    `  policy: ${data.policy.source}`,
    `  contracts: ${data.contracts.length}`,
  ]);
  if (!data.ok) process.exit(1);
}

/**
 * @param {string} surface
 * @param {string} source
 * @param {string} registry
 * @param {Record<string, unknown>} contract
 * @param {string} sourceHash
 * @returns {Record<string, unknown>}
 */
function contractFixture(surface, source, registry, contract, sourceHash) {
  return {
    schema: CONTRACT_FIXTURE_SCHEMA,
    surface,
    source,
    registry,
    expected: {
      id: contract.id,
      schema: contract.schema,
      version: contract.version,
      weldedSurface: contract.weldedSurface,
      sourceHash,
      renderedHash: `sha256:${createHash('sha256').update(renderJson(contract)).digest('hex')}`,
    },
    probe: {
      evidence: `kungfu sdk contract evidence ${surface} --json`,
      renderCheck: `kungfu sdk contract render ${surface} --check --json`,
      runtimeVerify: 'kungfu contract verify --json',
    },
    drift: {
      updateRule:
        'Intentional contract edits must update this fixture with the new source hash.',
      failureSignal:
        'A release gate can compare this fixture against contract evidence before claiming KFD-1 compatibility.',
    },
  };
}

/**
 * @param {string | undefined} surfaceArg
 * @param {CliOptions} options
 * @returns {void}
 */
function contractAdd(surfaceArg, options) {
  if (!surfaceArg) usage(1);
  const surface = normalizeSurface(surfaceArg);
  const repoRoot = locateRepoRoot(process.cwd());
  const registryPath = resolveContractRegistryPath(repoRoot);
  const registry = loadContractRegistry(registryPath);
  if (hasContractEntry(registry, surface)) {
    fail(`contract surface is already registered: ${surface}`);
  }
  const source = options.source
    ? repoRelativePath(repoRoot, options.source)
    : `framework/spec/contract/${surface}.contract.json`;
  const contractPath = path.resolve(repoRoot, source);
  if (fs.existsSync(contractPath)) {
    fail(`contract source already exists: ${source}`);
  }
  const contract = contractTemplate(surface);
  const entry = registryEntryTemplate(surface, source);
  registryContracts(registry).push(entry);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, renderJson(contract));
  const fixturePath = path.resolve(
    repoRoot,
    requiredString(entry, 'probeFixture'),
  );
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(
    fixturePath,
    renderJson(
      contractFixture(
        surface,
        source,
        rel(repoRoot, registryPath),
        contract,
        sha256File(contractPath),
      ),
    ),
  );
  fs.writeFileSync(registryPath, renderJson(registry));
  const data = {
    schema: 'kungfu.sdk.contract-add/v1',
    ok: true,
    surface,
    registry: rel(repoRoot, registryPath),
    source,
    artifact: entry.artifact,
    env: entry.env,
    contract: {
      id: contract.id,
      schema: contract.schema,
      version: contract.version,
      weldedSurface: contract.weldedSurface,
      hash: sha256File(contractPath),
    },
    fixture: {
      path: rel(repoRoot, fixturePath),
      schema: CONTRACT_FIXTURE_SCHEMA,
      hash: sha256File(fixturePath),
    },
    next: {
      verify: `kungfu sdk contract adopt ${surface} --source ${source} --json`,
      renderCheck: `kungfu sdk contract render ${surface} --check --json`,
      evidence: `kungfu sdk contract evidence ${surface} --json`,
      versioning: `register welded surface ${surface}-contract in docs/development/versioning.md`,
      knownLimits: `record maturity and limits for ${surface}-contract in docs/qualification/known-limits.md`,
    },
  };
  if (options.json) {
    process.stdout.write(renderJson(data));
    return;
  }
  process.stdout.write(
    [
      `[contract] added ${surface}`,
      `  source: ${data.source}`,
      `  registry: ${data.registry}`,
      `  check: ${data.next.renderCheck}`,
      '',
    ].join('\n'),
  );
}

// ── kfx view extension build ──────────────────────────────────────────────
// Modules that stay external and are injected by the shell at load time; a
// view extension must never ship its own copy of these.
const KFX_EXTERNALS = kfxSharedModuleContract.modules;

/**
 * The subset of a kungfu.kfx.json this driver reads.
 * @typedef {object} Manifest
 * @property {string} [name]
 * @property {{
 *   key?: string,
 *   config?: {
 *     view?: { entry?: string },
 *     adapter?: unknown,
 *   },
 * }} [kungfuConfig]
 * @property {{ python?: unknown }} [kungfuBuild]
 */

/**
 * Read and parse kungfu.kfx.json in the current working directory.
 * @returns {Manifest}
 */

function readManifest() {
  const manifestPath = path.resolve('kungfu.kfx.json');
  if (!fs.existsSync(manifestPath))
    fail('no kungfu.kfx.json in current directory');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validateKfxManifest(manifest);
  return manifest;
}

// ── kfx C++ extension build ────────────────────────────────────────────────
// A C++ kfx compiles src/cpp/*.cpp against the libkungfu API (headers + the
// built shared library) and its FlatBuffers data structures into a native
// pybind11 module. The extension's CMakeLists.txt includes a libkungfu-only
// helper (cmake/kungfu.cmake); this driver invokes CMake with the core's conan
// toolchain and pins the module to the core's Python so it loads in kfc.

/**
 * Walk up from startDir looking for the monorepo's framework/core.
 * @param {string} startDir
 * @returns {string | null} the core directory, or null if not found
 */
function locateCoreDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'framework', 'core');
    if (fs.existsSync(path.join(candidate, 'conanfile.py'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Run a child process synchronously, aborting the CLI if it fails.
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [opts]
 * @returns {void}
 */
function runOrFail(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.error) fail(`${cmd} not runnable: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `${cmd} ${args.join(' ')} failed (exit ${result.status ?? `signal ${result.signal}`})`,
    );
  }
}

/**
 * Resolve the Python executable from the Core uv project without assuming a
 * checkout-local .venv. Shifu's managed cache keeps the effective environment
 * outside the repository and exposes it through the uv command adapter.
 * @param {string} coreDir
 * @returns {string}
 */
function resolveCorePython(coreDir) {
  const environmentCandidates = [path.join(coreDir, '.venv')];
  if (process.env.UV_PROJECT_ENVIRONMENT) {
    environmentCandidates.unshift(process.env.UV_PROJECT_ENVIRONMENT);
  }
  const executableNames =
    process.platform === 'win32' ? ['python.exe'] : ['python3', 'python'];
  for (const environment of environmentCandidates) {
    for (const executable of executableNames) {
      const candidate = path.join(
        environment,
        process.platform === 'win32' ? 'Scripts' : 'bin',
        executable,
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const result = spawnSync(
    'uv',
    [
      'run',
      '--frozen',
      '--project',
      coreDir,
      'python',
      '-c',
      'import sys; print(sys.executable)',
    ],
    { encoding: 'utf8' },
  );
  const resolved = result.status === 0 ? result.stdout.trim() : '';
  if (resolved && path.isAbsolute(resolved) && fs.existsSync(resolved)) {
    return resolved;
  }
  const detail = result.error?.message || result.stderr?.trim() || 'not found';
  fail(
    `core Python could not be resolved through uv: ${detail}. Run \`./shifu rebuild:core\` first.`,
  );
}

/**
 * Resolve the real base interpreter for CMake's Python development lookup.
 * Windows uv environments can report headers through a versionless junction
 * that MSVC cannot traverse from a service-runner build. The base executable's
 * real path makes FindPythonLibs select the versioned include and import-lib
 * directories while preserving the same Python ABI as the Core environment.
 * @param {string} python
 * @returns {string}
 */
function resolveCmakePython(python) {
  if (!isWin) return python;
  const result = spawnSync(
    python,
    [
      '-c',
      'import os, sys; print(os.path.realpath(getattr(sys, "_base_executable", sys.executable)))',
    ],
    { encoding: 'utf8' },
  );
  const resolved = result.status === 0 ? result.stdout.trim() : '';
  return resolved && path.isAbsolute(resolved) && fs.existsSync(resolved)
    ? resolved
    : python;
}

/**
 * Configure and build a C++ kfx into a native pybind11 module.
 * @param {Manifest} manifest
 * @returns {void}
 */
function cppBuild(manifest) {
  const coreDir = locateCoreDir(process.cwd());
  if (!coreDir)
    fail(
      'cannot locate framework/core (a cpp kfx build needs the monorepo core)',
    );
  const toolchain = path.join(coreDir, 'build', 'conan_toolchain.cmake');
  if (!fs.existsSync(toolchain)) {
    fail(
      `core not built: ${toolchain} is missing. Run \`./shifu rebuild:core\` first.`,
    );
  }
  const buildDir = path.resolve('build');
  const distDir = path.resolve('dist', manifest.kungfuConfig?.key ?? 'cpp');
  fs.mkdirSync(distDir, { recursive: true });
  const configureArgs = [
    '-S',
    '.',
    '-B',
    buildDir,
    `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_LIBRARY_OUTPUT_DIRECTORY=${distDir}`,
    // Multi-config generators (notably Visual Studio) append the selected
    // configuration unless the per-config output directory is also pinned.
    // Keep the kfx artifact contract platform-invariant: the native module
    // must land directly under dist/<key>, never dist/<key>/Release.
    `-DCMAKE_LIBRARY_OUTPUT_DIRECTORY_RELEASE=${distDir}`,
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${distDir}`,
  ];
  // Pin the module to the core's Python (the uv-managed venv) so it is ABI-
  // compatible with the runtime and loads alongside pykungfu. Pass both the
  // classic (FindPythonInterp) and modern (FindPython) hint variables so the
  // pin holds regardless of which pybind11 lookup mode is active.
  const corePython = resolveCmakePython(resolveCorePython(coreDir));
  configureArgs.push(
    `-DPYTHON_EXECUTABLE=${corePython}`,
    `-DPython_EXECUTABLE=${corePython}`,
  );
  runOrFail('cmake', configureArgs);
  runOrFail('cmake', ['--build', buildDir, '--config', 'Release']);
  process.stdout.write(
    `built ${manifest.name ?? 'cpp extension'} -> ${path.relative(process.cwd(), distDir)}\n`,
  );
}

// ── kfx Python AOT extension build ─────────────────────────────────────────
// A Python extension (kungfuBuild.python) installs its declared dependencies
// through the bundled toolchain (`kungfu dev engage pdm install`) and is then
// ahead-of-time compiled into a native module (`kungfu dev engage nuitka
// --module`) — exercising the same python development lifecycle kfc ships.

/**
 * Install deps and AOT-compile a Python kfx into a native module.
 * @param {Manifest} manifest
 * @returns {void}
 */
function pythonAotBuild(manifest) {
  const coreDir = locateCoreDir(process.cwd());
  if (!coreDir)
    fail(
      'cannot locate framework/core (a python-AOT kfx build needs the monorepo core)',
    );
  const py = resolveCorePython(coreDir);
  const pkgRoot = path.resolve('src', 'python');
  const pkg = fs.existsSync(pkgRoot)
    ? fs
        .readdirSync(pkgRoot)
        .find((d) => fs.statSync(path.join(pkgRoot, d)).isDirectory())
    : null;
  if (!pkg)
    fail('no src/python/<Package>/ directory for a python-AOT extension');
  const distDir = path.resolve('dist', manifest.kungfuConfig?.key ?? 'python');
  fs.mkdirSync(distDir, { recursive: true });
  // The dev CLI resolves the `kungfu` package from src/python and its native
  // binding from build/Release; make both importable for `python -m kungfu`.
  const env = {
    ...process.env,
    PYTHONPATH: [
      path.join(coreDir, 'src', 'python'),
      path.join(coreDir, 'build', 'Release'),
      process.env.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(path.delimiter),
  };
  // The bundled core environment already contains the source-locked build
  // backend. Reuse it instead of asking the configured index to resolve the
  // legacy pdm-pep517 backend again for every extension build.
  runOrFail(
    py,
    ['-m', 'kungfu', 'dev', 'engage', 'pdm', 'install', '--no-isolation'],
    { env },
  );
  // AOT-compile just this module: declared deps stay runtime imports, so we do
  // not --follow-imports (we compile the extension, not its dependency tree).
  runOrFail(
    py,
    [
      '-m',
      'kungfu',
      'dev',
      'engage',
      'nuitka',
      '--module',
      `--output-dir=${distDir}`,
      path.join('src', 'python', pkg),
    ],
    { env },
  );
  process.stdout.write(
    `built ${manifest.name ?? 'python extension'} -> ${path.relative(process.cwd(), distDir)}\n`,
  );
}

/**
 * Dispatch `kungfu sdk kfx build` to the right builder for the current package.
 * @returns {Promise<void>}
 */
async function kfxBuild() {
  const manifest = readManifest();
  const config = manifest.kungfuConfig?.config ?? {};
  const view = config.view;
  if (!view) {
    // A C++ extension compiles native code against libkungfu into a pybind11
    // module. It is detected by a CMakeLists.txt at the package root.
    if (fs.existsSync(path.resolve('CMakeLists.txt'))) {
      cppBuild(manifest);
      return;
    }
    // A Python AOT extension declares its dependencies under kungfuBuild.python;
    // the sdk installs them (engage pdm) and compiles src/python (engage nuitka).
    if (manifest.kungfuBuild?.python) {
      pythonAotBuild(manifest);
      return;
    }
    // An adapter facet is a runtime extension: it ships source per child
    // runtime (python/node) and the capture supervisor injects it — there is
    // nothing to bundle. Succeed so `kungfu sdk kfx build` is usable on any kfx.
    if (config.adapter) {
      process.stdout.write(
        `${manifest.name ?? 'adapter extension'}: adapter facet ships source (no bundle step)\n`,
      );
      return;
    }
    fail(
      'kungfu.kfx.json has no view/adapter facet, no CMakeLists.txt (cpp), and no kungfuBuild.python (python-AOT)',
    );
  }
  const entry = ['src/view/index.tsx', 'src/view/index.ts'].find((candidate) =>
    fs.existsSync(path.resolve(candidate)),
  );
  if (!entry) fail('no src/view/index.tsx (or .ts) entry');
  const outfile = path.resolve(view.entry || 'dist/view/index.js');
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.resolve(entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    external: KFX_EXTERNALS,
    sourcemap: false,
    logLevel: 'warning',
  });
  process.stdout.write(
    `built ${manifest.name ?? 'view extension'} -> ${path.relative(process.cwd(), outfile)}\n`,
  );
}

/**
 * Remove the dist/ and build/ trees produced by `kungfu sdk kfx build`.
 * @returns {void}
 */
function kfxClean() {
  readManifest();
  fs.rmSync(path.resolve('dist'), { recursive: true, force: true });
  // A cpp extension also has a CMake build tree.
  fs.rmSync(path.resolve('build'), { recursive: true, force: true });
  process.stdout.write('cleaned dist\n');
}

/**
 * @param {string} start
 * @param {string} relativePath
 * @returns {string}
 */

export {
  contractAdd,
  contractAdopt,
  contractAudit,
  contractEvidence,
  contractPolicy,
  contractRender,
  contractWitness,
  kfxBuild,
  kfxClean,
};
