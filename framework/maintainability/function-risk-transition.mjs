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

function occurrenceGroups(items) {
  const result = new Map();
  for (const item of items) {
    const key = `${item.path}\0${item.owner}\0${item.symbol}`;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  for (const values of result.values())
    values.sort(
      (left, right) =>
        left.startLine - right.startLine || left.id.localeCompare(right.id),
    );
  return result;
}

function betterOccurrencePlan(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.exactMatches !== right.exactMatches)
    return left.exactMatches > right.exactMatches ? left : right;
  if (left.cost !== right.cost) return left.cost < right.cost ? left : right;
  return left.key.localeCompare(right.key) <= 0 ? left : right;
}

function occurrencePlan(currentItems, baselineItems, indexes, memo) {
  const [currentIndex, baselineIndex, remaining] = indexes;
  if (!remaining) return { exactMatches: 0, cost: 0, key: '', pairs: [] };
  if (
    currentItems.length - currentIndex < remaining ||
    baselineItems.length - baselineIndex < remaining
  )
    return null;
  const memoKey = `${currentIndex}\0${baselineIndex}\0${remaining}`;
  if (memo.has(memoKey)) return memo.get(memoKey);
  const item = currentItems[currentIndex];
  const previous = baselineItems[baselineIndex];
  const tail = occurrencePlan(
    currentItems,
    baselineItems,
    [currentIndex + 1, baselineIndex + 1, remaining - 1],
    memo,
  );
  let best = tail
    ? {
        exactMatches:
          Number(item.bodyRoot === previous.bodyRoot) + tail.exactMatches,
        cost: Math.abs(item.startLine - previous.startLine) + tail.cost,
        key: `${String(baselineIndex).padStart(8, '0')}:${String(
          currentIndex,
        ).padStart(8, '0')}\0${tail.key}`,
        pairs: [[item, previous], ...tail.pairs],
      }
    : null;
  if (currentItems.length - currentIndex > remaining)
    best = betterOccurrencePlan(
      best,
      occurrencePlan(
        currentItems,
        baselineItems,
        [currentIndex + 1, baselineIndex, remaining],
        memo,
      ),
    );
  if (baselineItems.length - baselineIndex > remaining)
    best = betterOccurrencePlan(
      best,
      occurrencePlan(
        currentItems,
        baselineItems,
        [currentIndex, baselineIndex + 1, remaining],
        memo,
      ),
    );
  memo.set(memoKey, best);
  return best;
}

function orderedOccurrenceMatches(currentItems, baselineItems, matches) {
  const plan = occurrencePlan(
    currentItems,
    baselineItems,
    [0, 0, Math.min(currentItems.length, baselineItems.length)],
    new Map(),
  );
  for (const [item, previous] of plan?.pairs || [])
    matches.set(item.id, previous);
}

function grouped(items, key) {
  const result = new Map();
  for (const item of items) {
    const value = key(item);
    if (!result.has(value)) result.set(value, []);
    result.get(value).push(item);
  }
  return result;
}

function uniqueGlobalMatches(current, baseline, matches, key) {
  const currentGroups = grouped(current, key);
  const baselineGroups = grouped(baseline, key);
  for (const [value, currentItems] of currentGroups) {
    const baselineItems = baselineGroups.get(value) || [];
    if (currentItems.length === 1 && baselineItems.length === 1)
      matches.set(currentItems[0].id, baselineItems[0]);
  }
}

function qualifiedOccurrenceMatches(current, baseline) {
  const matches = new Map();
  const unmatched = () => ({
    current: current.filter((item) => !matches.has(item.id)),
    baseline: baseline.filter(
      (item) => ![...matches.values()].some(({ id }) => id === item.id),
    ),
  });
  // Reserve only globally unique exact bodies before local occurrence alignment;
  // otherwise a nearby changed function can consume a baseline that moved files.
  uniqueGlobalMatches(
    current,
    baseline,
    matches,
    (item) => `${item.owner}\0${item.symbol}\0${item.bodyRoot}`,
  );
  let remaining = unmatched();
  const currentGroups = occurrenceGroups(remaining.current);
  const baselineGroups = occurrenceGroups(remaining.baseline);
  for (const [key, currentItems] of currentGroups) {
    orderedOccurrenceMatches(
      currentItems,
      baselineGroups.get(key) || [],
      matches,
    );
  }
  remaining = unmatched();
  uniqueGlobalMatches(
    remaining.current,
    remaining.baseline,
    matches,
    (item) => `${item.owner}\0${item.symbol}`,
  );
  remaining = unmatched();
  const currentCandidates = grouped(
    remaining.current,
    (item) => `${item.owner}\0${item.symbol}`,
  );
  const baselineCandidates = grouped(
    remaining.baseline,
    (item) => `${item.owner}\0${item.symbol}`,
  );
  const findings = [];
  for (const [key, currentItems] of currentCandidates) {
    const baselineItems = baselineCandidates.get(key) || [];
    if (!baselineItems.length) continue;
    findings.push({
      code: 'ambiguous-function-identity',
      severity: 'advisory',
      paths: [
        ...new Set([...currentItems, ...baselineItems].map(({ path }) => path)),
      ].sort(),
      message:
        'qualified occurrence identity is ambiguous across unmatched functions',
    });
  }
  return { matches, findings };
}

function referencedNewFunctions(sourceFiles, functions, baselineById) {
  const sourceByPath = new Map(
    sourceFiles.map((file) => [file.path, file.bytes.toString('utf8')]),
  );
  const newByOwner = new Map();
  for (const item of functions.filter(({ previousId }) => !previousId)) {
    if (!newByOwner.has(item.owner)) newByOwner.set(item.owner, []);
    newByOwner.get(item.owner).push(item);
  }
  const references = new Map();
  for (const item of functions) {
    const previous = item.previousId ? baselineById.get(item.previousId) : null;
    if (!previous || item.baseRisk >= previous.baseRisk) continue;
    const body = (sourceByPath.get(item.path) || '')
      .split('\n')
      .slice(item.startLine - 1, item.endLine)
      .join('\n');
    const helperIds = (newByOwner.get(item.owner) || [])
      .filter(({ symbol }) =>
        new RegExp(
          `\\b${symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`,
          'u',
        ).test(body),
      )
      .map(({ id }) => id);
    if (helperIds.length) references.set(item.previousId, new Set(helperIds));
  }
  return references;
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
  const qualifiedOccurrences =
    options.identityAlgorithm === 'qualified-occurrence-v2'
      ? qualifiedOccurrenceMatches(current, baseline)
      : null;
  const uniqueOwnerSymbols = uniqueBy(
    baseline.filter(({ owner }) => owner),
    (item) => `${item.owner}\0${item.symbol}`,
  );
  const uniqueOwnerBodies = uniqueBy(
    baseline.filter(({ owner }) => owner),
    (item) => `${item.owner}\0${item.symbol}\0${item.bodyRoot}`,
  );
  const uniqueSymbols = uniqueBy(baseline, (item) => item.symbol);
  const matchedBaseline = new Set();
  const transitions = [];
  const functions = current.map((item) => {
    const previous =
      (qualifiedOccurrences
        ? qualifiedOccurrences.matches.get(item.id)
        : exact.get(`${item.path}\0${item.symbol}`)) ||
      (!qualifiedOccurrences && options.movementScope === 'same-owner'
        ? options.movementIdentity === 'body-root'
          ? uniqueOwnerBodies.get(
              `${item.owner}\0${item.symbol}\0${item.bodyRoot}`,
            )
          : uniqueOwnerSymbols.get(`${item.owner}\0${item.symbol}`)
        : !qualifiedOccurrences
          ? uniqueSymbols.get(item.symbol)
          : null) ||
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
  const baselineById = new Map(baseline.map((item) => [item.id, item]));
  const functionsById = new Map(functions.map((item) => [item.id, item]));
  const references =
    options.referencedNewIdsByPreviousId ||
    referencedNewFunctions(options.sourceFiles || [], functions, baselineById);
  const findings = [...(qualifiedOccurrences?.findings || [])];
  for (const item of functions) {
    if (!item.previousId) continue;
    const previous = baselineById.get(item.previousId);
    const drop =
      previous.cyclomatic +
      previous.cognitive -
      (item.cyclomatic + item.cognitive);
    const helpers = [...(references.get(item.previousId) || [])]
      .map((id) => functionsById.get(id))
      .filter(Boolean);
    const helperTotal = helpers.reduce(
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
          ...helpers.map(({ path: pathname }) => pathname),
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

export { analyzeTransition, referencedNewFunctions };
