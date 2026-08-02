// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_KUNGFU_ONBOARDING_STATE,
  type KungfuOnboardingState,
  parseKungfuOnboardingState,
} from '@kungfu-tech/api/capability';

export function readTuiOnboardingState(
  configHome: string,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
): KungfuOnboardingState {
  try {
    const value = JSON.parse(
      readFile(path.join(configHome, 'config.json')),
    ) as {
      ui?: { onboarding?: unknown };
    };
    return parseKungfuOnboardingState(value.ui?.onboarding);
  } catch {
    return { ...DEFAULT_KUNGFU_ONBOARDING_STATE };
  }
}
