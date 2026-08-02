// SPDX-License-Identifier: Apache-2.0
// @ts-check

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function issue(code, target, message) {
  return { code, target, message };
}

export function exact(value, expected, code, target, issues) {
  if (value !== expected) {
    issues.push(
      issue(
        code,
        target,
        `${target} is ${String(value)}, expected ${String(expected)}`,
      ),
    );
  }
}

export function requiredRoot(references, value, target, kind, issues) {
  if (!ROOT_PATTERN.test(value || '')) {
    issues.push(
      issue('invalid-root', target, `${target} must be a sha256 root`),
    );
    return;
  }
  const prior = references.get(value);
  if (prior && prior.kind !== kind) {
    issues.push(
      issue(
        'retained-role-conflict',
        target,
        `${value} cannot represent both ${prior.kind} and ${kind}`,
      ),
    );
    return;
  }
  references.set(value, { kind, target });
}

export function uniqueBy(values, key, code, issues) {
  const seen = new Set();
  for (const value of values || []) {
    const identity = value?.[key];
    if (!identity || seen.has(identity)) {
      issues.push(
        issue(
          code,
          identity || key,
          `${key} values must be present and unique`,
        ),
      );
    }
    seen.add(identity);
  }
}
