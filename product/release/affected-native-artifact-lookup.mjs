// SPDX-License-Identifier: Apache-2.0
// @ts-check
// Owns remote release-evidence discovery; proof construction stays in Shifu.

export const WORKFLOW_PATH = '.github/workflows/affected-native-pr.yml';
export const DEFAULT_MAX_AGE_SECONDS = 6 * 60 * 60;
export const PRODUCER_EVENTS = new Set(['pull_request', 'merge_group']);

export function requireSha(value, label) {
  if (!/^[0-9a-f]{40}$/u.test(value || '')) {
    throw new Error(`${label} must be an exact Git SHA`);
  }
  return value;
}

export function selectReusableArtifact({
  artifacts,
  runsById,
  artifactName,
  repositoryId,
  headSha,
  now = Date.now(),
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
}) {
  requireSha(headSha, 'consumer head');
  const candidates = artifacts.filter((artifact) => {
    const run = runsById.get(Number(artifact.workflow_run?.id));
    const age =
      (new Date(now).getTime() - new Date(artifact.created_at).getTime()) /
      1000;
    return (
      artifact.name === artifactName &&
      artifact.expired === false &&
      artifact.workflow_run?.repository_id === repositoryId &&
      artifact.workflow_run?.head_repository_id === repositoryId &&
      Number.isFinite(age) &&
      age >= -300 &&
      age <= maxAgeSeconds &&
      PRODUCER_EVENTS.has(run?.event) &&
      (run.event === 'pull_request' || run.head_sha === headSha) &&
      run?.status === 'completed' &&
      run?.conclusion === 'success' &&
      run?.path === WORKFLOW_PATH
    );
  });
  if (candidates.length === 0) {
    return {
      reusable: false,
      reason: 'no exact trusted producer proof artifact',
      candidateCount: 0,
    };
  }
  const selected = [...candidates].sort((left, right) => {
    const createdAtOrder =
      new Date(right.created_at).getTime() -
      new Date(left.created_at).getTime();
    if (createdAtOrder !== 0) return createdAtOrder;
    const artifactIdOrder = Number(right.id) - Number(left.id);
    if (artifactIdOrder !== 0) return artifactIdOrder;
    return Number(right.workflow_run?.id) - Number(left.workflow_run?.id);
  })[0];
  const selectedRun = runsById.get(Number(selected.workflow_run.id));
  return {
    reusable: true,
    reason:
      candidates.length === 1
        ? 'exact trusted producer proof artifact found'
        : 'newest exact trusted producer proof artifact selected',
    candidateCount: candidates.length,
    runId: Number(selected.workflow_run.id),
    artifactId: Number(selected.id),
    producerEvent: selectedRun.event,
    producerHeadSha: selectedRun.head_sha,
  };
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }
  return response.json();
}

export async function lookupReusableArtifact({
  apiUrl,
  repository,
  artifactName,
  headSha,
  token,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
}) {
  const repositoryDocument = await githubJson(
    `${apiUrl}/repos/${repository}`,
    token,
  );
  const artifactDocument = await githubJson(
    `${apiUrl}/repos/${repository}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
    token,
  );
  const artifacts = artifactDocument.artifacts || [];
  const runIds = [
    ...new Set(artifacts.map((artifact) => Number(artifact.workflow_run?.id))),
  ].filter(Number.isFinite);
  const runs = await Promise.all(
    runIds.map(async (runId) => [
      runId,
      await githubJson(
        `${apiUrl}/repos/${repository}/actions/runs/${runId}`,
        token,
      ),
    ]),
  );
  return selectReusableArtifact({
    artifacts,
    runsById: new Map(runs),
    artifactName,
    repositoryId: Number(repositoryDocument.id),
    headSha,
    maxAgeSeconds,
  });
}
