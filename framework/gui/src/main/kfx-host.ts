// SPDX-License-Identifier: Apache-2.0

import {
  type KfxControlStatus,
  type KfxExperienceFlowDescriptor,
  projectKfxControlSuiteHost,
  projectKfxExperienceFlowHost,
} from '@kungfu-tech/api/capability';

// Electron remains a renderer/transport host. Core supplies every semantic,
// admission, capability, authorization, generation, and receipt identity.
export function projectGuiKfxExperienceFlow(
  descriptor: KfxExperienceFlowDescriptor,
) {
  return projectKfxExperienceFlowHost(descriptor, 'gui');
}

export function projectGuiKfxControl(status: KfxControlStatus) {
  return projectKfxControlSuiteHost(status, 'gui');
}
