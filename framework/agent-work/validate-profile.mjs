// SPDX-License-Identifier: Apache-2.0

import Ajv2020 from 'ajv/dist/2020.js';

const asSet = (values = []) => new Set(values);
const isSubset = (child = [], parent = []) => {
  const parentSet = asSet(parent);
  return child.every((value) => parentSet.has(value));
};

const indexBy = (values, key) =>
  new Map(values.map((value) => [value[key], value]));

const semanticFailures = ({ binding, profile, pursuit, atlas, warrant }) => {
  const failures = [];
  const at = Date.parse(profile.evaluatedAt);

  if (!pursuit) failures.push('binding-pursuit-root-missing');
  else {
    if (pursuit.state !== 'active') failures.push('binding-pursuit-inactive');
    if (!pursuit.advancementScope.includes(binding.candidateAction))
      failures.push('binding-action-not-advancing');
  }

  if (!atlas) failures.push('binding-atlas-root-missing');
  else {
    if (atlas.state !== 'current' || atlas.freshness !== 'current')
      failures.push('binding-atlas-not-current');
    if (!atlas.supportScope.includes(binding.candidateAction))
      failures.push('binding-action-unsupported');
    if (atlas.cutRoot !== binding.factCutRoot)
      failures.push('binding-atlas-cut-mismatch');
  }

  if (!warrant) failures.push('binding-warrant-root-missing');
  else {
    if (!['active', 'attenuated'].includes(warrant.state))
      failures.push('binding-warrant-not-active');
    if (
      !Number.isFinite(at) ||
      at < Date.parse(warrant.validFrom) ||
      at > Date.parse(warrant.validUntil)
    )
      failures.push('binding-warrant-expired');
    if (!warrant.targetRoots.includes(binding.factCutRoot))
      failures.push('binding-warrant-target-mismatch');
    if (!warrant.actionScope.includes(binding.candidateAction))
      failures.push('binding-action-out-of-scope');
    if (!warrant.resourceScope.includes(binding.resource))
      failures.push('binding-resource-out-of-scope');
  }

  return failures;
};

const validateRoleUniqueness = (profile, add) => {
  const allRoots = [
    ...profile.pursuits.map((value) => value.root),
    ...profile.atlases.map((value) => value.root),
    ...profile.warrants.map((value) => value.root),
  ];
  for (const root of new Set(allRoots)) {
    if (allRoots.filter((candidate) => candidate === root).length > 1)
      add(
        'duplicate-root',
        '/pursuits|atlases|warrants',
        `${root} identifies more than one role version`,
      );
  }
  for (const [role, values] of [
    ['pursuits', profile.pursuits],
    ['atlases', profile.atlases],
    ['warrants', profile.warrants],
  ]) {
    for (const id of new Set(values.map((value) => value.id))) {
      if (values.filter((candidate) => candidate.id === id).length > 1)
        add(
          'duplicate-role-id',
          `/${role}`,
          `${id} has more than one selected version at this Fact cut`,
        );
    }
  }
};

const validateWarrantAttenuation = (profile, warrants, add) => {
  for (const [index, warrant] of profile.warrants.entries()) {
    if (!warrant.parentRoot) continue;
    const parent = warrants.get(warrant.parentRoot);
    const path = `/warrants/${index}`;
    if (!parent) {
      add('warrant-parent-missing', `${path}/parentRoot`, warrant.parentRoot);
      continue;
    }
    if (!isSubset(warrant.actionScope, parent.actionScope))
      add('warrant-action-amplification', path, warrant.root);
    if (!isSubset(warrant.resourceScope, parent.resourceScope))
      add('warrant-resource-amplification', path, warrant.root);
    if (!isSubset(warrant.targetRoots, parent.targetRoots))
      add('warrant-target-amplification', path, warrant.root);
    if (
      Date.parse(warrant.validFrom) < Date.parse(parent.validFrom) ||
      Date.parse(warrant.validUntil) > Date.parse(parent.validUntil)
    )
      add('warrant-time-amplification', path, warrant.root);
    if (warrant.consequenceCeiling > parent.consequenceCeiling)
      add('warrant-consequence-amplification', path, warrant.root);
  }
};

const validateActionBindings = (
  profile,
  { pursuits, atlases, warrants },
  add,
) => {
  for (const [index, binding] of profile.actionBindings.entries()) {
    const path = `/actionBindings/${index}`;
    if (binding.factCutRoot !== profile.factCut.root)
      add(
        'binding-fact-cut-mismatch',
        `${path}/factCutRoot`,
        binding.factCutRoot,
      );
    const failures = semanticFailures({
      binding,
      profile,
      pursuit: pursuits.get(binding.pursuitRoot),
      atlas: atlases.get(binding.atlasRoot),
      warrant: warrants.get(binding.warrantRoot),
    });
    if (binding.decision === 'valid') {
      for (const code of failures) add(code, path, binding.id);
    } else if (failures.length === 0 || binding.reasons.length === 0) {
      add(
        'binding-denial-unexplained',
        path,
        `${binding.decision} requires a failed predicate and a reason`,
      );
    }
  }
};

const validateEpisodeRefs = (profile, bindings, add) => {
  for (const [index, episode] of profile.episodeRefs.entries()) {
    if (!bindings.has(episode.actionBindingId))
      add(
        'episode-binding-missing',
        `/episodeRefs/${index}/actionBindingId`,
        episode.actionBindingId,
      );
  }
};

const validateSessionProjection = (profile, bindings, add) => {
  if (!profile.sessionProjection) return;
  const projection = profile.sessionProjection;
  const binding = bindings.get(projection.actionBindingId);
  const episode = profile.episodeRefs.find(
    (candidate) =>
      candidate.episodeId === projection.runId &&
      candidate.actionBindingId === projection.actionBindingId,
  );
  if (
    !binding ||
    projection.goalRoot !== binding.pursuitRoot ||
    projection.contextRoot !== binding.atlasRoot ||
    projection.permissionsRoot !== binding.warrantRoot ||
    !episode ||
    projection.resultCutRoot !== episode.afterCutRoot
  ) {
    add(
      'session-projection-mismatch',
      '/sessionProjection',
      'session fields do not round-trip through one binding and Episode',
    );
  }
};

export const createAgentWorkProfileValidator = (contract) => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) => Number.isFinite(Date.parse(value)),
  });
  const validateShape = ajv.compile(contract.profileSchema);

  return (profile) => {
    if (!validateShape(profile)) {
      return {
        ok: false,
        issues: (validateShape.errors ?? []).map((error) => ({
          code: 'profile-schema-invalid',
          path: error.instancePath || '/',
          detail: error.message ?? 'schema validation failed',
        })),
      };
    }

    const issues = [];
    const add = (code, path, detail) => issues.push({ code, path, detail });
    const pursuits = indexBy(profile.pursuits, 'root');
    const atlases = indexBy(profile.atlases, 'root');
    const warrants = indexBy(profile.warrants, 'root');
    const bindings = indexBy(profile.actionBindings, 'id');
    validateRoleUniqueness(profile, add);
    validateWarrantAttenuation(profile, warrants, add);
    validateActionBindings(profile, { pursuits, atlases, warrants }, add);
    validateEpisodeRefs(profile, bindings, add);
    validateSessionProjection(profile, bindings, add);

    return { ok: issues.length === 0, issues };
  };
};

export const validateAgentWorkProfile = (contract, profile) =>
  createAgentWorkProfileValidator(contract)(profile);
