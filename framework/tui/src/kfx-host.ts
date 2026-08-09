// SPDX-License-Identifier: Apache-2.0

import {
  type KfxControlStatus,
  type KfxExperienceFlowDescriptor,
  projectKfxControlSuiteHost,
  projectKfxExperienceFlowHost,
} from '@kungfu-tech/api/capability';

// Ink owns presentation only; it cannot reinterpret Core admission.
export function projectTuiKfxExperienceFlow(
  descriptor: KfxExperienceFlowDescriptor,
) {
  return projectKfxExperienceFlowHost(descriptor, 'tui');
}

export function projectTuiKfxControl(status: KfxControlStatus) {
  return projectKfxControlSuiteHost(status, 'tui');
}
