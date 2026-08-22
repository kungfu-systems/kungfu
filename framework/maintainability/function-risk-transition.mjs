// SPDX-License-Identifier: Apache-2.0
// @ts-check

function uniqueBy(items, key) {
  const grouped = new Map();
  for (const item of items) {
    const value = key(item);
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(item);
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, values]) => values.length === 1)
      .map(([value, values]) => [value, values[0]]),
  );
}

function analyzeTransition(
  current,
  baseline,
  currentFiles,
  baselineFiles,
  policy,
  options = {},
) {
  const exact = new Map(
    baseline.map((item) => [`${item.path}\0${item.symbol}`, item]),
  );
  const uniqueOwnerSymbols = uniqueBy(
    baseline.filter(({ owner }) => owner),
    (item) => `${item.owner}\0${item.symbol}`,
  );
  const uniqueSymbols = uniqueBy(baseline, (item) => item.symbol);
  const matchedBaseline = new Set();
  const transitions = [];
  const functions = current.map((item) => {
    const previous =
      exact.get(`${item.path}\0${item.symbol}`) ||
      (options.movementScope === 'same-owner'
        ? uniqueOwnerSymbols.get(`${item.owner}\0${item.symbol}`)
        : uniqueSymbols.get(item.symbol)) ||
      null;
    if (previous) matchedBaseline.add(previous.id);
    const movement = !previous
      ? 'new'
      : previous.language !== item.language
        ? 'cross-language'
        : previous.path !== item.path
          ? 'renamed-file'
          : 'same-path';
    const changed = !previous || previous.bodyRoot !== item.bodyRoot;
    const changeWeight = changed ? 3 : 0;
    const movementWeight = ['renamed-file', 'cross-language'].includes(movement)
      ? 2
      : 0;
    const changeRisk = Math.max(
      item.baseRisk + changeWeight + movementWeight,
      previous?.changeRisk || previous?.baseRisk || 0,
    );
    if (previous && (changed || movement !== 'same-path'))
      transitions.push({
        symbol: item.symbol,
        from: previous.id,
        to: item.id,
        movement,
        complexityDelta:
          item.cyclomatic +
          item.cognitive -
          (previous.cyclomatic + previous.cognitive),
      });
    return { ...item, changeRisk, movement, previousId: previous?.id || null };
  });
  const findings = [];
  const newByOwner = new Map();
  for (const item of functions.filter(({ movement }) => movement === 'new')) {
    if (!newByOwner.has(item.owner)) newByOwner.set(item.owner, []);
    newByOwner.get(item.owner).push(item);
  }
  const baselineById = new Map(baseline.map((item) => [item.id, item]));
  for (const item of functions) {
    if (!item.previousId) continue;
    const previous = baselineById.get(item.previousId);
    const drop =
      previous.cyclomatic +
      previous.cognitive -
      (item.cyclomatic + item.cognitive);
    const helperTotal = (newByOwner.get(item.owner) || []).reduce(
      (sum, helper) => sum + helper.cyclomatic + helper.cognitive,
      0,
    );
    if (
      drop >= policy.antiGaming.complexityDropForWrapperSignal &&
      helperTotal >= drop
    )
      findings.push({
        code: 'wrapper-only-extraction',
        severity: 'advisory',
        paths: [
          item.path,
          ...(newByOwner.get(item.owner) || []).map(
            ({ path: pathname }) => pathname,
          ),
        ].sort(),
        message:
          'complexity moved to new same-owner helpers without reducing aggregate responsibility',
      });
  }
  const currentByPath = new Map(currentFiles.map((item) => [item.path, item]));
  for (const previous of baselineFiles) {
    const now = currentByPath.get(previous.path);
    if (
      now &&
      policy.includedClasses.includes(previous.class) &&
      ['generated-projection', 'vendored-source'].includes(now.class)
    )
      findings.push({
        code: 'generated-or-vendor-relabeling',
        severity: 'advisory',
        paths: [previous.path],
        message:
          'first-party function source changed to an excluded generated or vendor class',
      });
  }
  for (const transition of transitions) {
    if (transition.movement === 'renamed-file')
      findings.push({
        code: 'file-rename-risk-preserved',
        severity: 'advisory',
        paths: [transition.from, transition.to],
        message: 'function risk remains anchored across a file rename',
      });
    if (transition.movement === 'cross-language')
      findings.push({
        code: 'cross-language-risk-preserved',
        severity: 'advisory',
        paths: [transition.from, transition.to],
        message: 'function risk remains anchored across a language move',
      });
  }
  return {
    functions,
    transitions: transitions.sort((left, right) =>
      left.to.localeCompare(right.to),
    ),
    findings: findings.sort((left, right) =>
      `${left.code}\0${left.paths.join('\0')}`.localeCompare(
        `${right.code}\0${right.paths.join('\0')}`,
      ),
    ),
    retiredFunctions: baseline
      .filter(({ id }) => !matchedBaseline.has(id))
      .map(({ id }) => id)
      .sort(),
  };
}

export { analyzeTransition };
