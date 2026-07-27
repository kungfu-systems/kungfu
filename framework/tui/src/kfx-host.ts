// SPDX-License-Identifier: Apache-2.0

import {
  type KfxExperienceFlowDescriptor,
  projectKfxExperienceFlowHost,
} from '@kungfu-tech/api/capability';

// Ink owns presentation only; it cannot reinterpret Core admission.
export function projectTuiKfxExperienceFlow(
  descriptor: KfxExperienceFlowDescriptor,
) {
  return projectKfxExperienceFlowHost(descriptor, 'tui');
}
