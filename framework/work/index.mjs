// SPDX-License-Identifier: Apache-2.0

export * as action from './action/index.mjs';
export * as assignmentRuntime from './assignment-runtime/index.mjs';
export * as evidence from './evidence/index.mjs';
export * as projectCut from './project-cut/index.mjs';

export const WORK_PACKAGE_BOUNDARY = Object.freeze({
  schema: 'kungfu.work-package-boundary/v1',
  semanticOwner: 'work',
  nativeWriterOwner: '@kungfu-tech/core',
  portableFormatOwner: '@kungfu-tech/spec',
});
