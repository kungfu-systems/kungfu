// SPDX-License-Identifier: Apache-2.0
import { measureCandidateStageSync, measureCandidateStage } from '@kungfu-tech/workspaces/tooling/candidate-timeline-events';
import { contractArtifacts, copyContractArtifacts } from '@kungfu-tech/workspaces/tooling/contract-registry';
const result: { value: number } = measureCandidateStageSync('build', 'compile', () => ({ value: 42 }));
const asyncResult: number = await measureCandidateStage('build', 'compile', async () => 42);
const source: string = contractArtifacts()[0].source;
// @ts-expect-error Callback results retain their type.
const wrong: string = measureCandidateStageSync('build', 'compile', () => 42);
// @ts-expect-error Destination must be a filesystem path string.
copyContractArtifacts(42);
// @ts-expect-error Stage callback must be callable.
measureCandidateStageSync('build', 'compile', 42);
