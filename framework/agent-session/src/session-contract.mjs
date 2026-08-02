import { createHash } from 'node:crypto';

export const WORK_REF_SCHEMA = 'kungfu.work-ref/v1';
export const AGENT_CONSOLE_ENVELOPE_SCHEMA = 'kungfu.agent-console-envelope/v1';
export const AGENT_RUNTIME_PROFILE_SCHEMA = 'kungfu.agent-runtime-profile/v1';

const ROOT = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const WORK_REF_FIELDS = new Set([
  'schema',
  'workspaceId',
  'profileId',
  'profileRoot',
  'entityType',
  'entityId',
  'entityRoot',
  'purpose',
  'systemTimeCut',
  'initiativeId',
]);
const LEGACY_WORK_REF_FIELDS = new Set(
  [...WORK_REF_FIELDS].filter((field) => field !== 'initiativeId'),
);
const ENVELOPE_FIELDS = new Set([
  'schema',
  'workspaceId',
  'consoleId',
  'attemptId',
  'runtimeProfileId',
  'provider',
  'activeProfiles',
  'workRef',
  'entrypoints',
  'knownLimits',
  'envelopeRoot',
]);

function fail(message) {
  throw Object.assign(new Error(message), { code: 'invalid_argument' });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}

function exactFields(value, allowed, required, label) {
  const keys = Object.keys(value);
  const extras = keys.filter((key) => !allowed.has(key));
  const missing = [...required].filter((key) => !keys.includes(key));
  if (extras.length || missing.length)
    fail(
      `${label} has an invalid shape` +
        `${missing.length ? `; missing ${missing.join(', ')}` : ''}` +
        `${extras.length ? `; unknown ${extras.join(', ')}` : ''}`,
    );
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0)
    fail(`${label} must be non-empty text`);
  return value;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((child) => canonicalJson(child)).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

export function semanticRoot(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function validateWorkRef(value, { compatibility = false } = {}) {
  const result = structuredClone(object(value, 'WorkRef'));
  const required =
    compatibility && !Object.hasOwn(result, 'initiativeId')
      ? LEGACY_WORK_REF_FIELDS
      : WORK_REF_FIELDS;
  exactFields(result, WORK_REF_FIELDS, required, 'WorkRef');
  if (result.schema !== WORK_REF_SCHEMA)
    fail(`WorkRef.schema must be ${WORK_REF_SCHEMA}`);
  for (const field of [
    'workspaceId',
    'profileId',
    'entityType',
    'entityId',
    'purpose',
    'systemTimeCut',
  ])
    text(result[field], `WorkRef.${field}`);
  for (const field of ['profileRoot', 'entityRoot']) {
    if (!ROOT.test(result[field]))
      fail(`WorkRef.${field} must be a sha256 root`);
  }
  if (result.entityType === 'assignment') {
    if (!compatibility || Object.hasOwn(result, 'initiativeId'))
      text(result.initiativeId, 'WorkRef.initiativeId');
  } else if (Object.hasOwn(result, 'initiativeId')) {
    fail('WorkRef.initiativeId is only valid for assignment identity');
  }
  return result;
}

function validateArgv(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'string')
  )
    fail(`${label} must be a non-empty argv array`);
}

export function validateAgentConsoleEnvelope(value) {
  const result = structuredClone(object(value, 'AgentConsoleEnvelope'));
  exactFields(result, ENVELOPE_FIELDS, ENVELOPE_FIELDS, 'AgentConsoleEnvelope');
  if (result.schema !== AGENT_CONSOLE_ENVELOPE_SCHEMA)
    fail(
      `AgentConsoleEnvelope.schema must be ${AGENT_CONSOLE_ENVELOPE_SCHEMA}`,
    );
  for (const field of [
    'workspaceId',
    'consoleId',
    'attemptId',
    'runtimeProfileId',
  ])
    text(result[field], `AgentConsoleEnvelope.${field}`);
  if (!IDENTIFIER.test(result.provider))
    fail('AgentConsoleEnvelope.provider must be a provider identifier');
  if (!Array.isArray(result.activeProfiles))
    fail('AgentConsoleEnvelope.activeProfiles must be an array');
  for (const profile of result.activeProfiles) {
    exactFields(
      object(profile, 'active Profile'),
      new Set(['id', 'root']),
      new Set(['id', 'root']),
      'active Profile',
    );
    text(profile.id, 'active Profile.id');
    if (!ROOT.test(profile.root))
      fail('active Profile.root must be a sha256 root');
  }
  if (result.workRef !== null) result.workRef = validateWorkRef(result.workRef);
  const entrypoints = object(
    result.entrypoints,
    'AgentConsoleEnvelope.entrypoints',
  );
  const entrypointFields = new Set([
    'context',
    'capabilities',
    'profiles',
    'bindWork',
  ]);
  exactFields(
    entrypoints,
    entrypointFields,
    entrypointFields,
    'AgentConsoleEnvelope.entrypoints',
  );
  for (const field of entrypointFields)
    validateArgv(
      entrypoints[field],
      `AgentConsoleEnvelope.entrypoints.${field}`,
    );
  if (
    !Array.isArray(result.knownLimits) ||
    !result.knownLimits.every((item) => typeof item === 'string')
  )
    fail('AgentConsoleEnvelope.knownLimits must be a text array');
  const { envelopeRoot, ...body } = result;
  if (envelopeRoot !== semanticRoot(body))
    fail('AgentConsoleEnvelope.envelopeRoot does not match its canonical body');
  return result;
}

export function validateRuntimeProfile(value) {
  const result = structuredClone(object(value, 'AgentRuntimeProfile'));
  const fields = new Set([
    'schema',
    'id',
    'label',
    'provider',
    'launch',
    'cwdPolicy',
    'backendDefault',
    'bootstrap',
    'source',
    'lastVerified',
  ]);
  exactFields(result, fields, fields, 'AgentRuntimeProfile');
  if (result.schema !== AGENT_RUNTIME_PROFILE_SCHEMA)
    fail(`AgentRuntimeProfile.schema must be ${AGENT_RUNTIME_PROFILE_SCHEMA}`);
  if (!IDENTIFIER.test(result.id) || !IDENTIFIER.test(result.provider))
    fail('AgentRuntimeProfile id and provider must be identifiers');
  text(result.label, 'AgentRuntimeProfile.label');
  const launchFields = new Set([
    'executable',
    'argv',
    'interactiveArgv',
    'versionArgv',
    'shellMode',
  ]);
  const launch = object(result.launch, 'AgentRuntimeProfile.launch');
  exactFields(launch, launchFields, launchFields, 'AgentRuntimeProfile.launch');
  text(launch.executable, 'AgentRuntimeProfile.launch.executable');
  for (const field of ['argv', 'interactiveArgv']) {
    if (
      !Array.isArray(launch[field]) ||
      !launch[field].every((item) => typeof item === 'string')
    )
      fail(`AgentRuntimeProfile.launch.${field} must be an argv array`);
  }
  validateArgv(launch.versionArgv, 'AgentRuntimeProfile.launch.versionArgv');
  if (typeof launch.shellMode !== 'boolean')
    fail('AgentRuntimeProfile.launch.shellMode must be boolean');
  if (!['workspace-root', 'home', 'inherit'].includes(result.cwdPolicy))
    fail('AgentRuntimeProfile.cwdPolicy is unsupported');
  if (!['tmux', 'direct'].includes(result.backendDefault))
    fail('AgentRuntimeProfile.backendDefault is unsupported');
  const bootstrap = object(result.bootstrap, 'AgentRuntimeProfile.bootstrap');
  exactFields(
    bootstrap,
    new Set(['adapter', 'envelope']),
    new Set(['adapter', 'envelope']),
    'AgentRuntimeProfile.bootstrap',
  );
  if (bootstrap.adapter !== result.provider)
    fail('AgentRuntimeProfile bootstrap adapter must match provider');
  if (!['required', 'disabled'].includes(bootstrap.envelope))
    fail('AgentRuntimeProfile bootstrap envelope is unsupported');
  if (!['discovered', 'user', 'qualification'].includes(result.source))
    fail('AgentRuntimeProfile.source is unsupported');
  if (result.lastVerified !== null && typeof result.lastVerified !== 'string')
    fail('AgentRuntimeProfile.lastVerified must be text or null');
  return result;
}
