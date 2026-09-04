// SPDX-License-Identifier: Apache-2.0

import { createHash, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = 'product/upgrade/kungfu-upgrade-qualification.contract.json';
const UPGRADE_CONTRACT = 'product/upgrade/kungfu-upgrade.contract.json';

export class UpgradeQualificationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

export function loadUpgradeQualificationContract(root = ROOT) {
  return readJson(root, CONTRACT);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_ROOT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SEMVER_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function qualificationContentRoot(value) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

export function updateCampaignRoot(campaign) {
  const payload = Object.fromEntries(
    Object.entries(campaign).filter(([key]) => key !== 'campaignRoot'),
  );
  return qualificationContentRoot(payload);
}

function compareSemver(left, right) {
  const parse = (value) => {
    const match = SEMVER_PATTERN.exec(String(value || ''));
    if (!match)
      fail('qualification-version-invalid', `invalid SemVer: ${value}`);
    return {
      core: match.slice(1, 4).map(Number),
      prerelease: match[4] ? match[4].split('.') : [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index])
      return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumber = /^\d+$/.test(a.prerelease[index]);
    const bNumber = /^\d+$/.test(b.prerelease[index]);
    if (aNumber && bNumber)
      return Number(a.prerelease[index]) < Number(b.prerelease[index]) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.prerelease[index] < b.prerelease[index] ? -1 : 1;
  }
  return 0;
}

function fail(code, message) {
  throw new UpgradeQualificationError(code, message);
}

function headings(markdown) {
  return new Set(
    markdown
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) =>
        line
          .replace(/^#{1,6} /, '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9 -]/g, '')
          .replace(/\s+/g, '-'),
      ),
  );
}

export function artifactSignatureStatement(manifest, artifact, evidenceRef) {
  return Buffer.from(
    JSON.stringify(
      canonical({
        schema: 'kungfu.product-upgrade.artifact-signature/v1',
        evidenceRef,
        sourceCommit: manifest.sourceCommit,
        productVersion: manifest.productVersion,
        platform: manifest.platform,
        architecture: manifest.architecture,
        kind: artifact.kind,
        url: artifact.url,
        size: artifact.size,
        digest: artifact.digest,
      }),
    ),
  );
}

function artifactRowsRoot(manifest) {
  return qualificationContentRoot(
    (manifest.artifacts || []).map((artifact) => ({
      kind: artifact.kind,
      url: artifact.url,
      size: artifact.size,
      digest: artifact.digest,
      signature: artifact.signature,
    })),
  );
}

function qualifyCampaign(condition, code, message) {
  if (!condition) fail(code, message);
}

function verifyCampaignEnvelope(campaign, contract, options) {
  qualifyCampaign(
    campaign,
    'qualification-campaign-missing',
    'one-command update campaign evidence is required',
  );
  qualifyCampaign(
    campaign.schema === contract.campaignSchema,
    'qualification-campaign-schema',
    'one-command update campaign schema is unsupported',
  );
  qualifyCampaign(
    campaign.campaignRoot === updateCampaignRoot(campaign),
    'qualification-campaign-root',
    'one-command update campaign root is not canonical',
  );
  const generatedAt = Date.parse(campaign.generatedAt || '');
  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const maximumAge = contract.maximumCampaignAgeHours * 60 * 60 * 1000;
  qualifyCampaign(
    Number.isFinite(generatedAt) &&
      generatedAt <= now + 5 * 60 * 1000 &&
      now - generatedAt <= maximumAge,
    'qualification-campaign-stale',
    'one-command update campaign is missing, future-dated, or stale',
  );
  qualifyCampaign(
    campaign.evidenceTier === contract.promotionTier &&
      campaign.cleanEnvironment === true &&
      campaign.publicClaim?.advertised === true &&
      campaign.publicClaim?.mechanicsOnly === false,
    'qualification-campaign-simulated',
    'advertised updates require a clean native-packaged campaign',
  );
}

function verifyCampaignIdentity(manifest, campaign, contract) {
  for (const field of ['sourceCommit', 'productVersion']) {
    qualifyCampaign(
      campaign.candidate?.[field] === manifest[field],
      'qualification-campaign-source-mismatch',
      `campaign candidate ${field} does not match the manifest`,
    );
  }
  qualifyCampaign(
    campaign.platform === manifest.platform &&
      campaign.architecture === manifest.architecture,
    'qualification-campaign-platform-mismatch',
    'campaign platform identity does not match the manifest',
  );
  qualifyCampaign(
    campaign.channel === manifest.releaseChannel &&
      ['alpha', 'stable'].includes(campaign.channel),
    'qualification-campaign-channel-mismatch',
    'campaign channel does not match the release manifest',
  );
  const sourcePolicy = contract.installSources?.[campaign.installSource];
  qualifyCampaign(
    sourcePolicy &&
      campaign.installOwner === sourcePolicy.owner &&
      campaign.action === sourcePolicy.action,
    'qualification-campaign-owner-mismatch',
    'campaign install source, owner, and action are inconsistent',
  );
}

function verifyCampaignCandidateRoots(manifest, campaign, options) {
  qualifyCampaign(
    campaign.candidate?.manifestRoot === qualificationContentRoot(manifest) &&
      campaign.candidate?.artifactRoot === artifactRowsRoot(manifest) &&
      SHA256_ROOT_PATTERN.test(campaign.candidate?.channelIndexRoot || '') &&
      SHA256_ROOT_PATTERN.test(campaign.candidate?.releasePassportRoot || ''),
    'qualification-campaign-candidate-root-mismatch',
    'campaign candidate roots do not bind the release manifest',
  );
  qualifyCampaign(
    !options.releasePassportRoot ||
      campaign.candidate.releasePassportRoot === options.releasePassportRoot,
    'qualification-campaign-passport-mismatch',
    'campaign release-passport root does not match Buildchain',
  );
}

function verifyPreviousPublicCandidate(campaign) {
  qualifyCampaign(
    campaign.previousPublic &&
      SHA1_PATTERN.test(campaign.previousPublic.sourceCommit || '') &&
      SHA256_ROOT_PATTERN.test(
        campaign.previousPublic.channelIndexRoot || '',
      ) &&
      SHA256_ROOT_PATTERN.test(
        campaign.previousPublic.releasePassportRoot || '',
      ) &&
      SHA256_ROOT_PATTERN.test(campaign.previousPublic.manifestRoot || '') &&
      SHA256_ROOT_PATTERN.test(campaign.previousPublic.artifactRoot || '') &&
      compareSemver(
        campaign.previousPublic.productVersion,
        campaign.candidate.productVersion,
      ) < 0,
    'qualification-campaign-previous-public-invalid',
    'campaign must start from one exact older public version',
  );
}

function verifyCampaignExecution(manifest, campaign, contract) {
  qualifyCampaign(
    JSON.stringify(campaign.invocation?.argv) ===
      JSON.stringify(contract.requiredCommand) &&
      Number.isInteger(campaign.invocation?.confirmationCount) &&
      campaign.invocation.confirmationCount >= 0 &&
      campaign.invocation.confirmationCount <= 1,
    'qualification-campaign-command-mismatch',
    'campaign must use the exact one-command update surface with at most one confirmation',
  );
  qualifyCampaign(
    campaign.result?.state === 'complete' &&
      campaign.result?.observedVersion === manifest.productVersion &&
      SHA256_ROOT_PATTERN.test(campaign.result?.receiptRoot || ''),
    'qualification-campaign-result-mismatch',
    'campaign result does not prove the exact candidate and receipt',
  );
  for (const check of contract.requiredSmokeChecks) {
    qualifyCampaign(
      campaign.result?.smokeChecks?.[check] === true,
      'qualification-campaign-smoke-missing',
      `campaign smoke did not pass: ${check}`,
    );
  }
  qualifyCampaign(
    campaign.activation?.activeWorkContinues === true &&
      campaign.activation?.existingWorkRuntime === 'previous-pinned' &&
      campaign.activation?.newWorkActivation ===
        'fenced-safe-point-or-next-command' &&
      campaign.activation?.supervisorActionRequired === false,
    'qualification-campaign-activation-mismatch',
    'campaign activation evidence does not preserve the declared work boundary',
  );
}

function verifyCampaignFaults(campaign, contract) {
  const faults = new Map((campaign.faults || []).map((row) => [row.id, row]));
  qualifyCampaign(
    faults.size === (campaign.faults || []).length,
    'qualification-campaign-fault-duplicate',
    'campaign fault identities must be unique',
  );
  for (const faultId of contract.requiredFaults) {
    const row = faults.get(faultId);
    qualifyCampaign(
      row &&
        contract.permittedFaultVerdicts.includes(row.verdict) &&
        row.previousAuthorityRetained === true &&
        SHA256_ROOT_PATTERN.test(row.receiptRoot || '') &&
        typeof row.recoveryAction === 'string' &&
        row.recoveryAction.length > 0,
      'qualification-campaign-fault-missing',
      `campaign fault evidence is missing or non-qualifying: ${faultId}`,
    );
  }
}

function verifyCampaignClaimsAndDocumentation(campaign, contract) {
  qualifyCampaign(
    campaign.nonClaims?.powerLossDurability === false &&
      campaign.nonClaims?.maliciousTamperRecovery === false &&
      campaign.nonClaims?.uninterruptedActiveWork === false,
    'qualification-campaign-nonclaim-mismatch',
    'campaign must keep power-loss, malicious-tamper, and uninterrupted-work claims false',
  );
  const documentationPaths = new Set(campaign.documentationPaths || []);
  for (const required of contract.documentation.requiredPaths) {
    qualifyCampaign(
      documentationPaths.has(required),
      'qualification-campaign-docs-missing',
      `campaign does not bind required documentation: ${required}`,
    );
  }
}

function verifyUpdateCampaign(manifest, campaign, contract, options = {}) {
  verifyCampaignEnvelope(campaign, contract, options);
  verifyCampaignIdentity(manifest, campaign, contract);
  verifyCampaignCandidateRoots(manifest, campaign, options);
  verifyPreviousPublicCandidate(campaign);
  verifyCampaignExecution(manifest, campaign, contract);
  verifyCampaignFaults(campaign, contract);
  verifyCampaignClaimsAndDocumentation(campaign, contract);
  return campaign;
}

export function verifyUpgradeQualificationEvidence(
  manifest,
  evidence,
  requiredSurface,
  contract,
  options = {},
) {
  if (!evidence)
    fail(
      'qualification-evidence-missing',
      'qualification evidence is required',
    );
  if (evidence.schema !== contract.evidenceSchema)
    fail(
      'qualification-evidence-schema',
      'qualification evidence schema is unsupported',
    );
  if (evidence.evidenceRef !== manifest.qualificationEvidenceRef)
    fail(
      'qualification-evidence-ref',
      'qualification evidence reference does not match the manifest',
    );
  for (const field of [
    'sourceCommit',
    'productVersion',
    'platform',
    'architecture',
  ]) {
    if (evidence[field] !== manifest[field])
      fail(
        'qualification-source-mismatch',
        `qualification ${field} does not match the manifest`,
      );
  }
  if (evidence.tier !== contract.promotionTier)
    fail(
      'qualification-tier-insufficient',
      'native packaged evidence is required for promotion',
    );
  const surfaces = new Set(evidence.surfaces || []);
  for (const surface of [
    ...contract.requiredArtifactSurfaces,
    requiredSurface,
  ]) {
    if (!surfaces.has(surface))
      fail(
        'qualification-surface-missing',
        `qualification evidence has no ${surface} surface`,
      );
  }
  if (
    !Number.isInteger(evidence.runtimeChurnIterations) ||
    evidence.runtimeChurnIterations < contract.minimumRuntimeChurnIterations
  )
    fail(
      'qualification-churn-insufficient',
      'runtime churn evidence is below the release minimum',
    );
  for (const check of contract.requiredChecks) {
    if (evidence.checks?.[check] !== true)
      fail(
        'qualification-check-failed',
        `qualification check did not pass: ${check}`,
      );
  }
  if (!Array.isArray(evidence.campaigns) || evidence.campaigns.length === 0)
    fail(
      'qualification-campaign-missing',
      'one-command update campaign evidence is required',
    );
  const campaignIdentities = new Set();
  const campaignSources = new Set();
  const channelIndexRoots = new Set();
  const releasePassportRoots = new Set();
  for (const campaign of evidence.campaigns) {
    verifyUpdateCampaign(manifest, campaign, contract, options);
    const identity = [
      campaign.channel,
      campaign.platform,
      campaign.architecture,
      campaign.installSource,
    ].join('/');
    if (campaignIdentities.has(identity))
      fail(
        'qualification-campaign-duplicate',
        `duplicate one-command update campaign: ${identity}`,
      );
    campaignIdentities.add(identity);
    campaignSources.add(campaign.installSource);
    channelIndexRoots.add(campaign.candidate.channelIndexRoot);
    releasePassportRoots.add(campaign.candidate.releasePassportRoot);
  }
  for (const installSource of contract.requiredPublicationCampaigns?.[
    manifest.platform
  ] || []) {
    if (!campaignSources.has(installSource))
      fail(
        'qualification-campaign-source-missing',
        `no qualifying ${installSource} campaign for ${manifest.platform}`,
      );
  }
  if (channelIndexRoots.size !== 1 || releasePassportRoots.size !== 1)
    fail(
      'qualification-campaign-root-divergence',
      'campaigns do not share one candidate channel and release-passport root',
    );
  const rows = new Map(
    (evidence.artifacts || []).map((row) => [row.kind, row]),
  );
  for (const artifact of manifest.artifacts || []) {
    const row = rows.get(artifact.kind);
    if (!row)
      fail(
        'qualification-signature-missing',
        `no retained signature evidence for ${artifact.kind}`,
      );
    if (
      row.digest !== artifact.digest ||
      row.size !== artifact.size ||
      row.signatureEvidenceRef !== artifact.signature
    )
      fail(
        'qualification-artifact-mismatch',
        `retained evidence does not bind ${artifact.kind}`,
      );
    if (row.algorithm !== 'ed25519' || !row.publicKeyPem || !row.signature)
      fail(
        'qualification-signature-missing',
        `incomplete Ed25519 evidence for ${artifact.kind}`,
      );
    let valid = false;
    try {
      valid = verify(
        null,
        artifactSignatureStatement(manifest, artifact, evidence.evidenceRef),
        row.publicKeyPem,
        Buffer.from(row.signature, 'base64'),
      );
    } catch {
      valid = false;
    }
    if (!valid)
      fail(
        'qualification-signature-invalid',
        `cryptographic signature verification failed for ${artifact.kind}`,
      );
  }
  return evidence;
}

export function checkUpgradeQualification(root = ROOT) {
  const contract = loadUpgradeQualificationContract(root);
  if (contract.schema !== 'kungfu.product-upgrade.qualification-contract/v1')
    throw new Error('upgrade qualification contract schema is unsupported');
  if (contract.minimumRuntimeChurnIterations < 100)
    throw new Error('upgrade qualification churn minimum must be at least 100');
  if (contract.promotionTier !== 'native-packaged')
    throw new Error('upgrade promotion must require native packaged evidence');
  for (const required of [
    'runtimeControlPlane',
    'distributionAdapters',
    'downgradeRefusal',
    'messageRegistry',
    'manualAnchors',
    'signatureVerification',
    'oneCommandUpdate',
    'faultRecoveryMatrix',
    'sourceOwnership',
    'publicClaims',
    'runAgentSmoke',
  ]) {
    if (!contract.requiredChecks.includes(required))
      throw new Error(`upgrade qualification must require ${required}`);
  }
  if (
    contract.publication?.evidenceFileName !==
    'kungfu-upgrade-qualification-evidence.json'
  )
    throw new Error(
      'upgrade publication evidence must use the retained canonical file name',
    );
  if (
    contract.publication?.campaignEvidenceFileName !==
    'kungfu-update-qualification-campaigns.json'
  )
    throw new Error(
      'update campaign evidence must use the retained canonical file name',
    );
  if (
    contract.maximumCampaignAgeHours !== 168 ||
    JSON.stringify(contract.requiredCommand) !==
      JSON.stringify(['kungfu', 'update'])
  )
    throw new Error('one-command campaign freshness or argv policy drifted');
  for (const required of ['archive', 'homebrew']) {
    if (!contract.installSources?.[required])
      throw new Error(`upgrade qualification has no ${required} owner`);
  }
  for (const fault of [
    'network-interruption',
    'cache-corruption',
    'signature-mismatch',
    'stale-plan',
    'unsafe-archive',
    'permission-denied',
    'package-manager-failure',
    'activation-boundary',
    'restart',
    'retry',
    'unsupported-source',
  ]) {
    if (!contract.requiredFaults.includes(fault))
      throw new Error(`upgrade qualification must cover ${fault}`);
  }
  for (const [surface, mechanics] of Object.entries(
    contract.mechanicsEvidence || {},
  )) {
    const testSource = fs.readFileSync(
      path.join(root, mechanics.testFile),
      'utf8',
    );
    for (const testName of mechanics.requiredTests || []) {
      if (!testSource.includes(`def ${testName}(`))
        throw new Error(
          `upgrade ${surface} mechanics evidence is missing ${testName}`,
        );
    }
  }
  for (const platform of ['darwin', 'linux', 'win32']) {
    const claim = contract.currentClaims?.[platform];
    if (
      !claim ||
      claim.advertised !== false ||
      claim.promotionEligible !== false ||
      !claim.blocker
    )
      throw new Error(`unqualified ${platform} claim must remain fail-closed`);
  }
  const upgrade = readJson(root, UPGRADE_CONTRACT);
  const guide = fs.readFileSync(
    path.join(root, contract.documentation.guide),
    'utf8',
  );
  const anchors = headings(guide);
  for (const anchor of contract.documentation.requiredGuideAnchors || []) {
    if (!anchors.has(anchor))
      throw new Error(`upgrade guide is missing required anchor: ${anchor}`);
  }
  for (const documentPath of contract.documentation.requiredPaths || []) {
    if (!fs.existsSync(path.join(root, documentPath)))
      throw new Error(`upgrade documentation is missing: ${documentPath}`);
  }
  for (const [reason, message] of Object.entries(
    upgrade.messageRegistry.reasonMessages,
  )) {
    const anchor = String(message.documentationAnchor || '').replace(/^#/, '');
    if (!anchor || !anchors.has(anchor))
      throw new Error(
        `upgrade message ${reason} points to a missing guide anchor`,
      );
  }
  const fixtures = readJson(root, contract.fixtureFile);
  if (fixtures.schema !== 'kungfu.product-upgrade.qualification-fixtures/v1')
    throw new Error('upgrade qualification fixture schema is unsupported');
  if (!fixtures.cases.some((item) => item.admitted === true))
    throw new Error('upgrade qualification fixtures need an admitted control');
  for (const item of fixtures.cases) {
    if (!item.admitted && !item.code)
      throw new Error(
        `negative upgrade qualification fixture has no code: ${item.id}`,
      );
  }
  return {
    contract: CONTRACT,
    fixtures: fixtures.cases.length,
    messages: Object.keys(upgrade.messageRegistry.reasonMessages).length,
    platforms: Object.keys(contract.currentClaims).length,
  };
}
