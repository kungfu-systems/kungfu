// SPDX-License-Identifier: Apache-2.0

export function assertNoNativeWork(plan, message) {
  const { platformTier, profile, targets, tests } = plan;
  if (
    platformTier !== 'none' ||
    profile !== null ||
    targets.length ||
    tests.length
  )
    throw new Error(message);
}

export function createSelfTestHarness() {
  let passed = 0;
  const expect = (name, action, pattern = null) => {
    try {
      action();
      if (pattern) throw new Error(`${name}: expected failure`);
      console.log(`  ok: ${name}`);
      passed += 1;
    } catch (error) {
      if (!pattern || !pattern.test(error.message)) throw error;
      console.log(`  ok: ${name}`);
      passed += 1;
    }
  };
  return { expect, passed: () => passed };
}
