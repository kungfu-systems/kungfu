// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { semanticRoot } from '../../project-cut/src/project-cut.mjs';
import {
  buildWorkDesignAdvice,
  buildWorkDesignDisposition,
  verifyWorkDesignAdvice,
  verifyWorkDesignDisposition,
} from '../../work-design-advisor/src/work-design-advisor.mjs';
import {
  selectWorkHistory,
  verifyWorkHistorySelectionManifest,
} from '../../work-history-selector/src/work-history-selector.mjs';

export const OPEN_CARD_PREFLIGHT_REQUEST_SCHEMA =
  'kungfu.work-design.open-card-preflight-request/v1';
export const OPEN_CARD_PREFLIGHT_SCHEMA =
  'kungfu.work-design.open-card-preflight/v1';

const ACTIONS = new Set([
  'accepted',
  'adapted',
  'overridden',
  'insufficient-history',
]);
const AVAILABILITY = new Set(['available', 'timeout', 'unavailable']);
const ROOT = /^sha256:[0-9a-f]{64}$/u;

const AUTHORITY = Object.freeze({
  mode: 'capture-preflight-only',
  fact: false,
  episode: false,
  assignment: false,
  workControl: false,
  capture: false,
  claim: false,
  dispatch: false,
  execute: false,
  approve: false,
  merge: false,
  close: false,
});

const CARD_STATE = Object.freeze({
  captureOnly: true,
  pointerOnly: true,
  status: 'paused',
  claimed: false,
  dispatched: false,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diagnostic(code, path, message) {
  return { code, path, message };
}

function expectedAdviceInput(request, history) {
  return {
    intent: {
      kind: 'assignment-request',
      root: request.humanWorkDefinitionRoot,
    },
    history,
    xinfaRoot: request.adviceRequest.xinfaRoot,
    asOf: request.adviceRequest.asOf,
    policy: request.adviceRequest.policy,
  };
}

function fallback(request, reason, diagnostics, partial = {}) {
  const humanWorkDefinitionRoot = ROOT.test(
    String(request?.humanWorkDefinitionRoot ?? ''),
  )
    ? request.humanWorkDefinitionRoot
    : null;
  const preimage = {
    schema: OPEN_CARD_PREFLIGHT_SCHEMA,
    ok: true,
    outcome: 'manual-capture',
    humanAuthorization: {
      authority: 'human',
      finalWorkDefinitionRoot: humanWorkDefinitionRoot,
      preserved: humanWorkDefinitionRoot !== null,
    },
    history: partial.history ?? null,
    advice: partial.advice ?? null,
    disposition: partial.disposition ?? null,
    adoption: {
      adopted: false,
      adviceRoot: partial.advice?.advice?.adviceRoot ?? null,
    },
    fallback: {
      explicit: true,
      reason,
      silentAdoption: false,
      diagnostics,
    },
    cardState: { ...CARD_STATE },
    authority: { ...AUTHORITY },
  };
  return { ...preimage, preflightRoot: semanticRoot(preimage) };
}

function validateEnvelope(request) {
  const diagnostics = [];
  if (!isObject(request))
    return [diagnostic('invalid-type', '$', 'request must be an object')];
  if (request.schema !== OPEN_CARD_PREFLIGHT_REQUEST_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported request schema'),
    );
  if (!isObject(request.humanWorkDefinition))
    diagnostics.push(
      diagnostic(
        'invalid-type',
        '$.humanWorkDefinition',
        'human work definition must be an object',
      ),
    );
  if (!ROOT.test(String(request.humanWorkDefinitionRoot ?? '')))
    diagnostics.push(
      diagnostic(
        'invalid-root',
        '$.humanWorkDefinitionRoot',
        'human work definition root is required',
      ),
    );
  else if (
    isObject(request.humanWorkDefinition) &&
    semanticRoot(request.humanWorkDefinition) !==
      request.humanWorkDefinitionRoot
  )
    diagnostics.push(
      diagnostic(
        'root-mismatch',
        '$.humanWorkDefinitionRoot',
        'human work definition root differs from its canonical preimage',
      ),
    );
  if (!isObject(request.selectionRequest))
    diagnostics.push(
      diagnostic(
        'invalid-type',
        '$.selectionRequest',
        'selection request must be an object',
      ),
    );
  else if (
    request.selectionRequest.objectiveRoot !== request.humanWorkDefinitionRoot
  )
    diagnostics.push(
      diagnostic(
        'intent-root-mismatch',
        '$.selectionRequest.objectiveRoot',
        'selector objective must bind the final human work definition root',
      ),
    );
  if (!isObject(request.adviceRequest))
    diagnostics.push(
      diagnostic(
        'invalid-type',
        '$.adviceRequest',
        'advice request input must be an object',
      ),
    );
  if (!isObject(request.disposition))
    diagnostics.push(
      diagnostic(
        'invalid-type',
        '$.disposition',
        'human disposition must be an object',
      ),
    );
  else {
    if (!ACTIONS.has(request.disposition.action))
      diagnostics.push(
        diagnostic(
          'invalid-value',
          '$.disposition.action',
          'unsupported human disposition',
        ),
      );
    if (request.disposition.decisionAuthority !== 'human')
      diagnostics.push(
        diagnostic(
          'human-authority-required',
          '$.disposition.decisionAuthority',
          'the final disposition must be human-authorized',
        ),
      );
    if (!ROOT.test(String(request.disposition.rationaleRoot ?? '')))
      diagnostics.push(
        diagnostic(
          'invalid-root',
          '$.disposition.rationaleRoot',
          'human disposition rationale root is required',
        ),
      );
  }
  const availability = request.availability ?? {};
  for (const name of ['selector', 'advisor']) {
    if (!AVAILABILITY.has(availability[name] ?? 'available'))
      diagnostics.push(
        diagnostic(
          'invalid-value',
          `$.availability.${name}`,
          'availability must be available, timeout, or unavailable',
        ),
      );
  }
  return diagnostics;
}

export function runOpenCardPreflight(request) {
  const envelopeDiagnostics = validateEnvelope(request);
  if (envelopeDiagnostics.length > 0)
    return fallback(request, 'protocol-invalid', envelopeDiagnostics);

  const selectorAvailability = request.availability?.selector ?? 'available';
  if (selectorAvailability !== 'available')
    return fallback(request, `selector-${selectorAvailability}`, []);

  const selected = selectWorkHistory(request.selectionRequest);
  if (!selected.ok)
    return fallback(request, 'selector-failed', selected.diagnostics);
  const selectionVerification = verifyWorkHistorySelectionManifest(
    selected.manifest,
  );
  const history = {
    manifest: selected.manifest,
    verification: selectionVerification,
    verificationRoot: semanticRoot(selectionVerification),
  };
  if (!selectionVerification.ok)
    return fallback(
      request,
      'selection-root-mismatch',
      selectionVerification.diagnostics,
      { history },
    );
  if (
    selected.manifest.status !== 'complete' &&
    selected.manifest.coverage.gaps.includes('stale-index-snapshot')
  )
    return fallback(request, 'stale-manifest', [], { history });

  const advisorAvailability = request.availability?.advisor ?? 'available';
  if (advisorAvailability !== 'available')
    return fallback(request, `advisor-${advisorAvailability}`, [], {
      history,
    });

  const historyBinding = {
    selectionRoot: selected.manifest.selectionRoot,
    verificationRoot: history.verificationRoot,
    status: selected.manifest.status,
    selectedCount: selected.manifest.coverage.includedCount,
    confidence: selected.manifest.coverage.confidence,
    gapIds: selected.manifest.coverage.gaps,
  };
  const expectedInput = expectedAdviceInput(request, historyBinding);
  const adviceRequest = {
    schema: 'kungfu.work-design.advice-request/v1',
    ...expectedInput,
    proposal: request.adviceRequest.proposal,
  };
  const advised = buildWorkDesignAdvice(adviceRequest);
  if (!advised.ok)
    return fallback(request, 'advisor-failed', advised.diagnostics, {
      history,
    });
  const adviceVerification = verifyWorkDesignAdvice(
    advised.advice,
    expectedInput,
  );
  const advice = {
    advice: advised.advice,
    verification: adviceVerification,
  };
  if (!adviceVerification.ok)
    return fallback(
      request,
      'advice-root-mismatch',
      adviceVerification.diagnostics,
      { history, advice },
    );
  if (
    ROOT.test(String(request.disposition.expectedAdviceRoot ?? '')) &&
    request.disposition.expectedAdviceRoot !== advised.advice.adviceRoot
  )
    return fallback(
      request,
      'advice-root-mismatch',
      [
        diagnostic(
          'exact-advice-root-mismatch',
          '$.disposition.expectedAdviceRoot',
          'human disposition names a different advice root',
        ),
      ],
      { history, advice },
    );

  const expectedAction =
    advised.advice.status === 'insufficient-history'
      ? 'insufficient-history'
      : request.disposition.action;
  if (expectedAction !== request.disposition.action)
    return fallback(
      request,
      'disposition-status-mismatch',
      [
        diagnostic(
          'disposition-status-mismatch',
          '$.disposition.action',
          'insufficient history requires an insufficient-history disposition',
        ),
      ],
      { history, advice },
    );

  const resultingAdviceRoot =
    request.disposition.action === 'accepted'
      ? advised.advice.adviceRoot
      : request.disposition.action === 'insufficient-history'
        ? null
        : semanticRoot({
            action: request.disposition.action,
            adviceRoot: advised.advice.adviceRoot,
            finalWorkDefinitionRoot: request.humanWorkDefinitionRoot,
          });
  const dispositionResult = buildWorkDesignDisposition({
    adviceRoot: advised.advice.adviceRoot,
    intentRoot: request.humanWorkDefinitionRoot,
    action: request.disposition.action,
    rationaleRoot: request.disposition.rationaleRoot,
    resultingAdviceRoot,
  });
  if (!dispositionResult.ok)
    return fallback(
      request,
      'disposition-invalid',
      dispositionResult.diagnostics,
      { history, advice },
    );
  const dispositionVerification = verifyWorkDesignDisposition(
    dispositionResult.disposition,
  );
  if (!dispositionVerification.ok)
    return fallback(
      request,
      'disposition-root-mismatch',
      dispositionVerification.diagnostics,
      { history, advice, disposition: dispositionResult.disposition },
    );

  const isManual =
    request.disposition.action === 'overridden' ||
    request.disposition.action === 'insufficient-history';
  const preimage = {
    schema: OPEN_CARD_PREFLIGHT_SCHEMA,
    ok: true,
    outcome: isManual ? 'manual-capture' : 'advisory-disposition',
    humanAuthorization: {
      authority: 'human',
      finalWorkDefinitionRoot: request.humanWorkDefinitionRoot,
      preserved: true,
    },
    history,
    advice,
    disposition: dispositionResult.disposition,
    adoption: {
      adopted: ['accepted', 'adapted'].includes(request.disposition.action),
      adviceRoot: advised.advice.adviceRoot,
    },
    fallback: isManual
      ? {
          explicit: true,
          reason: request.disposition.action,
          silentAdoption: false,
          diagnostics: [],
        }
      : null,
    cardState: { ...CARD_STATE },
    authority: { ...AUTHORITY },
  };
  return { ...preimage, preflightRoot: semanticRoot(preimage) };
}

export function verifyOpenCardPreflight(result) {
  if (!isObject(result) || result.schema !== OPEN_CARD_PREFLIGHT_SCHEMA)
    return { ok: false, reason: 'unsupported-preflight-schema' };
  const { preflightRoot, ...preimage } = result;
  if (semanticRoot(preimage) !== preflightRoot)
    return { ok: false, reason: 'preflight-root-mismatch' };
  if (
    JSON.stringify(result.authority) !== JSON.stringify(AUTHORITY) ||
    JSON.stringify(result.cardState) !== JSON.stringify(CARD_STATE)
  )
    return { ok: false, reason: 'authority-boundary-mismatch' };
  if (
    result.humanAuthorization?.authority !== 'human' ||
    result.humanAuthorization?.preserved !== true ||
    !ROOT.test(String(result.humanAuthorization?.finalWorkDefinitionRoot ?? ''))
  )
    return { ok: false, reason: 'human-authorization-missing' };
  if (
    result.adoption?.adopted === true &&
    (!ROOT.test(String(result.adoption.adviceRoot ?? '')) ||
      result.advice?.advice?.adviceRoot !== result.adoption.adviceRoot)
  )
    return { ok: false, reason: 'adopted-advice-root-mismatch' };
  return { ok: true, reason: null };
}

export function openCardAuthorityBoundary() {
  return { authority: { ...AUTHORITY }, cardState: { ...CARD_STATE } };
}
