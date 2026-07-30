#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildGitEpisodeSegment,
  episodeProviderPaths,
  sealGitEpisode,
} from '../../episode-provider/src/git-workspace-episode-provider.mjs';
import { observeComposition, verifyComposition } from '../src/composition.mjs';
import { observeHistory, reconcileHistory } from '../src/history.mjs';
import {
  checkNativeLoopQualificationContract,
  sealNativeLoopQualification,
  verifyNativeLoopQualification,
} from '../src/native-loop-qualification.mjs';
import { parseLosslessUint64Json, parseRootJson } from '../src/project-cut.mjs';
import {
  checkSettlementPublicationContract,
  inspectSettlementPublication,
  materializeSettlementPublication,
  planSettlementPublication,
  reconcileSettlementPublication,
  verifySettlementPublication,
} from '../src/publication.mjs';
import {
  abandonSettlement,
  inspectSettlement,
  observeSettlementCommit,
  prepareSettlement,
  reconcileCommit,
  verifySettlement,
} from '../src/settlement.mjs';

function usage() {
  return `Usage:
  project-cut prepare --request FILE [--root DIR] [--xinfa-bin FILE] [--execute] [--stage] --json
  project-cut verify --state FILE [--root DIR] [--execute] --json
  project-cut commit-observe --state FILE --commit REF [--root DIR] [--execute] --json
  project-cut inspect --state FILE [--root DIR] --json
  project-cut reconcile --commit REF [--root DIR] --json
  project-cut abandon --state FILE [--root DIR] [--execute] --json
  project-cut episode-seal --bundle FILE --qualification FILE --writer-id ID [--generation N] [--root DIR] [--execute] [--stage] --json
  project-cut history-observe --request FILE [--root DIR] --json
  project-cut history-reconcile --observations FILE [--root DIR] --json
  project-cut composition-observe --base REF --commit REF [--root DIR] --json
  project-cut composition-verify --receipt FILE [--root DIR] --json
  project-cut publication-contract-check [--root DIR] --json
  project-cut publication-prepare --request FILE [--commit REF] [--root DIR] [--execute] [--stage] --json
  project-cut publication-inspect --plan FILE [--root DIR] --json
  project-cut publication-reconcile --plan FILE --observation FILE [--root DIR] --json
  project-cut publication-verify --batch-root ROOT [--commit REF] [--root DIR] --json
  project-cut native-loop-contract-check [--root DIR] --json
  project-cut native-loop-seal --input FILE [--root DIR] --json
  project-cut native-loop-verify --manifest FILE [--root DIR] --json`;
}

function parseArguments(argv) {
  const action = argv.shift();
  if (!action || action === '--help' || action === '-h')
    return { action: 'help' };
  const values = {};
  const flags = new Set();
  while (argv.length > 0) {
    const name = argv.shift();
    if (['--execute', '--stage', '--json'].includes(name)) {
      flags.add(name);
      continue;
    }
    if (!name?.startsWith('--') || argv.length === 0)
      throw Object.assign(new Error(`invalid argument: ${name}`), {
        code: 'invalid-argument',
      });
    values[name] = argv.shift();
  }
  if (!flags.has('--json'))
    throw Object.assign(
      new Error('--json is required for the agent-first surface'),
      {
        code: 'json-required',
      },
    );
  return { action, values, flags };
}

function required(values, name) {
  if (!values[name])
    throw Object.assign(new Error(`${name} is required`), {
      code: 'missing-argument',
    });
  return values[name];
}

function responseError(action, error) {
  return {
    schema: responseSchema(action),
    ok: false,
    action,
    error: {
      code: error.code ?? 'project-cut-failed',
      message: String(error.message),
      details: error.details ?? {},
    },
  };
}

function responseSchema(action) {
  if (action === 'episode-seal') return 'project.cut.episode-seal-response/v1';
  if (action.startsWith('composition-'))
    return 'project.cut.composition-response/v1';
  if (action.startsWith('publication-'))
    return 'kungfu.settlement-publication.response/v1';
  if (action.startsWith('native-loop-'))
    return 'kungfu.native-loop-qualification.response/v1';
  return action.startsWith('history-')
    ? 'project.cut.history-response/v1'
    : 'project.cut.settlement-response/v1';
}

function relativeOutput(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function prepareEpisodeSeal(rootValue, values, flags) {
  const root = path.resolve(rootValue);
  const execute = flags.has('--execute');
  const stage = flags.has('--stage');
  if (stage && !execute)
    throw Object.assign(new Error('--stage requires --execute'), {
      code: 'stage-requires-execute',
    });
  const generationText = values['--generation'] ?? '1';
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw Object.assign(new Error('--generation must be a positive integer'), {
      code: 'generation-invalid',
    });
  const bundle = parseLosslessUint64Json(
    readFileSync(required(values, '--bundle'), 'utf8'),
  );
  const qualificationInput = parseLosslessUint64Json(
    readFileSync(required(values, '--qualification'), 'utf8'),
  );
  const qualification = qualificationInput.qualification ?? qualificationInput;
  const segment = buildGitEpisodeSegment(bundle, qualification);
  const paths = episodeProviderPaths(root, segment.semanticRoot);
  const outputs = [
    '.kungfu/.gitignore',
    relativeOutput(root, path.join(paths.segment, 'claims.jsonl')),
    relativeOutput(root, path.join(paths.segment, 'manifest.json')),
    relativeOutput(root, path.join(paths.segment, 'qualification.json')),
  ].sort();
  if (!execute) {
    return {
      ok: true,
      action: 'episode-seal',
      dryRun: true,
      staged: false,
      semanticRoot: segment.semanticRoot,
      providerRoot: segment.providerRoot,
      qualificationRoot: segment.manifest.qualificationRoot,
      outputs,
      receipt: null,
    };
  }
  const receipt = sealGitEpisode(root, segment, {
    writerId: required(values, '--writer-id'),
    generation,
  });
  if (stage) execFileSync('git', ['-C', root, 'add', '--', ...outputs]);
  return {
    ok: true,
    action: 'episode-seal',
    dryRun: false,
    staged: stage,
    semanticRoot: segment.semanticRoot,
    providerRoot: segment.providerRoot,
    qualificationRoot: segment.manifest.qualificationRoot,
    outputs,
    receipt,
  };
}

let action = 'unknown';
try {
  const parsed = parseArguments(process.argv.slice(2));
  action = parsed.action;
  if (action === 'help') {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const root = parsed.values['--root'] ?? '.';
  const execute = parsed.flags.has('--execute');
  let result;
  if (action === 'prepare') {
    const request = parseRootJson(
      readFileSync(required(parsed.values, '--request'), 'utf8'),
    );
    result = prepareSettlement(root, request, {
      execute,
      stage: parsed.flags.has('--stage'),
      xinfaBin: parsed.values['--xinfa-bin'],
    });
  } else if (action === 'verify') {
    result = verifySettlement(root, required(parsed.values, '--state'), {
      execute,
    });
  } else if (action === 'commit-observe') {
    result = observeSettlementCommit(
      root,
      required(parsed.values, '--state'),
      required(parsed.values, '--commit'),
      { execute },
    );
  } else if (action === 'inspect') {
    result = inspectSettlement(root, required(parsed.values, '--state'));
  } else if (action === 'reconcile') {
    result = reconcileCommit(root, required(parsed.values, '--commit'));
  } else if (action === 'abandon') {
    result = abandonSettlement(root, required(parsed.values, '--state'), {
      execute,
    });
  } else if (action === 'episode-seal') {
    result = prepareEpisodeSeal(root, parsed.values, parsed.flags);
  } else if (action === 'history-observe') {
    const request = parseRootJson(
      readFileSync(required(parsed.values, '--request'), 'utf8'),
    );
    result = observeHistory(root, request);
  } else if (action === 'history-reconcile') {
    const input = parseRootJson(
      readFileSync(required(parsed.values, '--observations'), 'utf8'),
    );
    const observations = Array.isArray(input) ? input : input.observations;
    if (!Array.isArray(observations))
      throw Object.assign(new Error('observations must be an array'), {
        code: 'invalid-observations',
      });
    result = reconcileHistory(root, observations, {
      archivedRoots: Array.isArray(input) ? [] : input.archivedRoots,
    });
  } else if (action === 'composition-observe') {
    const receipt = observeComposition(
      root,
      required(parsed.values, '--base'),
      required(parsed.values, '--commit'),
    );
    result = {
      ok: receipt.status === 'qualified',
      action,
      receipt,
      diagnostics: receipt.diagnostics,
    };
  } else if (action === 'composition-verify') {
    const receipt = parseRootJson(
      readFileSync(required(parsed.values, '--receipt'), 'utf8'),
    );
    result = { action, ...verifyComposition(root, receipt) };
  } else if (action === 'publication-contract-check') {
    result = {
      action,
      ...checkSettlementPublicationContract(path.resolve(root)),
    };
  } else if (action === 'publication-prepare') {
    const request = parseRootJson(
      readFileSync(required(parsed.values, '--request'), 'utf8'),
    );
    const plan = planSettlementPublication(root, request, {
      commit: parsed.values['--commit'] ?? 'HEAD',
    });
    const materialization = materializeSettlementPublication(root, plan, {
      execute,
      stage: parsed.flags.has('--stage'),
    });
    result = { ok: true, action, plan, materialization };
  } else if (action === 'publication-inspect') {
    const plan = parseRootJson(
      readFileSync(required(parsed.values, '--plan'), 'utf8'),
    );
    result = {
      action,
      ...inspectSettlementPublication(root, plan),
    };
  } else if (action === 'publication-reconcile') {
    const plan = parseRootJson(
      readFileSync(required(parsed.values, '--plan'), 'utf8'),
    );
    const observation = parseRootJson(
      readFileSync(required(parsed.values, '--observation'), 'utf8'),
    );
    result = {
      action,
      ...reconcileSettlementPublication(root, plan, observation),
    };
  } else if (action === 'publication-verify') {
    result = {
      action,
      ...verifySettlementPublication(
        root,
        required(parsed.values, '--batch-root'),
        { commit: parsed.values['--commit'] ?? 'HEAD' },
      ),
    };
  } else if (action === 'native-loop-contract-check') {
    result = {
      action,
      ...checkNativeLoopQualificationContract(),
    };
  } else if (action === 'native-loop-seal') {
    const input = parseRootJson(
      readFileSync(required(parsed.values, '--input'), 'utf8'),
    );
    const sealed = sealNativeLoopQualification(root, input);
    result = {
      ok: sealed.verification.ok,
      action,
      ...sealed,
    };
  } else if (action === 'native-loop-verify') {
    const manifest = parseRootJson(
      readFileSync(required(parsed.values, '--manifest'), 'utf8'),
    );
    result = {
      action,
      ...verifyNativeLoopQualification(root, manifest),
    };
  } else {
    throw Object.assign(new Error(`unknown action: ${action}`), {
      code: 'unknown-action',
    });
  }
  process.stdout.write(
    `${JSON.stringify({ schema: responseSchema(action), ...result })}\n`,
  );
  if (result.ok === false) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify(responseError(action, error))}\n`);
  process.exitCode = 1;
}
