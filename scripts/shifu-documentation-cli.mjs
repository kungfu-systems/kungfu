// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  documentationValidationReceipt,
  validateDocumentationSubmissionBytes,
} from './shifu-documentation-runtime.mjs';

const DEFAULT_SUBMISSION = 'shifu.documentation.json';

function help() {
  return `shifu docs — inspect the project-independent Documentation Protocol
  docs contract                         print the canonical contract manifest
  docs schema submission               print the project submission JSON Schema
  docs schema receipt                  print the validation receipt JSON Schema
  docs validate [--submission FILE|-] [--json]
                                        validate without executing document commands
  docs show [--submission FILE] [--json]
                                        print deterministic canonical roots and projection
  docs xinfa compile --project FILE --output DIR [--root DIR]
                     [--visibility LEVEL] [--submission FILE]
                     [--xinfa FILE] [--json]
                                        validate the submission, delegate Atlas compilation
                                        to the public Xinfa CLI, and verify the result

Validation is diagnostic and non-qualifying. Probe providers may only reference
a Shifu Gate registry; this command never executes them.`;
}

/** @param {string[]} args */
function parseXinfaOptions(args) {
  const options = {
    project: '',
    output: '',
    root: '',
    visibility: 'public',
    submission: DEFAULT_SUBMISSION,
    xinfa: '',
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (
      [
        '--project',
        '--output',
        '--root',
        '--visibility',
        '--submission',
        '--xinfa',
      ].includes(arg)
    ) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--project') options.project = value;
      else if (arg === '--output') options.output = value;
      else if (arg === '--root') options.root = value;
      else if (arg === '--visibility') options.visibility = value;
      else if (arg === '--submission') options.submission = value;
      else options.xinfa = value;
    } else throw new Error(`unknown docs xinfa option: ${arg}`);
  }
  if (!options.project)
    throw new Error('docs xinfa compile requires --project');
  if (!options.output) throw new Error('docs xinfa compile requires --output');
  if (!['public', 'internal', 'private'].includes(options.visibility))
    throw new Error('--visibility must be public, internal, or private');
  return options;
}

/** @param {string} root @param {ReturnType<typeof parseXinfaOptions>} options */
function runXinfaCompile(root, options) {
  const binary = path.resolve(
    root,
    options.xinfa ||
      path.join(
        'xinfa',
        'target',
        'debug',
        process.platform === 'win32' ? 'xinfa.exe' : 'xinfa',
      ),
  );
  const compileArgs = [
    'atlas',
    'compile',
    '--project',
    options.project,
    '--output',
    options.output,
    '--root',
    options.root || root,
    '--visibility',
    options.visibility,
    '--json',
  ];
  const compile = spawnSync(binary, compileArgs, {
    cwd: root,
    encoding: 'utf8',
  });
  if (compile.error)
    throw new Error(`cannot execute Xinfa CLI: ${compile.error.message}`);
  let compileReceipt;
  try {
    compileReceipt = JSON.parse(compile.stdout || '{}');
  } catch {
    throw new Error('Xinfa compile did not emit a JSON receipt');
  }
  let verificationReceipt = null;
  let verifyStatus = null;
  if (compile.status === 0) {
    const verify = spawnSync(
      binary,
      ['atlas', 'verify', '--atlas', options.output, '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    if (verify.error)
      throw new Error(
        `cannot verify delegated Xinfa Atlas: ${verify.error.message}`,
      );
    verifyStatus = verify.status;
    try {
      verificationReceipt = JSON.parse(verify.stdout || '{}');
    } catch {
      throw new Error('Xinfa verify did not emit a JSON receipt');
    }
  }
  return {
    compileArgs,
    compileReceipt,
    compileStatus: compile.status,
    verificationReceipt,
    verifyStatus,
  };
}

/** @param {string[]} args */
function parseOptions(args) {
  let submission = DEFAULT_SUBMISSION;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') json = true;
    else if (arg === '--submission') {
      submission = args[++index];
      if (!submission) throw new Error('--submission requires FILE or -');
    } else throw new Error(`unknown docs option: ${arg}`);
  }
  return { submission, json };
}

/** @param {string} root @param {string} ref */
function readSubmission(root, ref) {
  if (ref === '-') return fs.readFileSync(0);
  return fs.readFileSync(path.resolve(root, ref));
}

/** @param {string} root @param {string} rel @param {NodeJS.WritableStream} stdout */
function exactFile(root, rel, stdout) {
  stdout.write(fs.readFileSync(path.join(root, rel), 'utf8'));
}

export async function runDocumentationCommand(
  /** @type {string[]} */
  args,
  /** @type {{root?:string,stdout?:NodeJS.WritableStream,stderr?:NodeJS.WritableStream}} */
  {
    root = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const sub = args[0] || 'help';
  if (sub === 'contract') {
    if (args.length !== 1)
      throw new Error('docs contract accepts no arguments');
    exactFile(root, 'docs/shifu/documentation-contract.json', stdout);
    return 0;
  }
  if (sub === 'schema') {
    if (args.length !== 2 || !['submission', 'receipt'].includes(args[1]))
      throw new Error('docs schema requires submission or receipt');
    exactFile(
      root,
      args[1] === 'submission'
        ? 'docs/shifu/schema/documentation-project-v1.schema.json'
        : 'docs/shifu/schema/documentation-validation-receipt-v1.schema.json',
      stdout,
    );
    return 0;
  }
  if (sub === 'validate' || sub === 'show') {
    const options = parseOptions(args.slice(1));
    if (sub === 'show' && options.submission === '-')
      throw new Error(
        'docs show requires a named submission so its source is auditable',
      );
    const result = validateDocumentationSubmissionBytes(
      readSubmission(root, options.submission),
      { root, checkFiles: options.submission !== '-' },
    );
    const receipt = documentationValidationReceipt(result, options.submission);
    if (sub === 'show') {
      if (!result.valid) {
        if (options.json) stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
        else
          for (const item of receipt.diagnostics)
            stderr.write(`${item.code}\t${item.path}\t${item.message}\n`);
        return 1;
      }
      const { submission, projection } = result;
      if (!submission || !projection)
        throw new Error('valid documentation result is missing its projection');
      if (options.json)
        stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
      else {
        stdout.write(`project: ${submission.project.id}\n`);
        stdout.write(`contract root: ${projection.roots.contract}\n`);
        stdout.write(`content root: ${projection.roots.content}\n`);
        stdout.write(`submission root: ${projection.roots.submission}\n`);
      }
      return 0;
    }
    if (options.json) stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    else if (result.valid) {
      const { submission } = result;
      if (!submission)
        throw new Error('valid documentation result is missing its submission');
      stdout.write(
        `valid documentation submission: ${options.submission} (${submission.providers.length} providers, ${submission.routes.length} routes)\n`,
      );
      stdout.write(
        'qualification: diagnostic-only (probe execution and review remain outstanding)\n',
      );
    } else
      for (const item of receipt.diagnostics)
        stderr.write(`${item.code}\t${item.path}\t${item.message}\n`);
    return result.valid ? 0 : 1;
  }
  if (sub === 'xinfa') {
    if (args[1] !== 'compile')
      throw new Error('docs xinfa requires the compile operation');
    const options = parseXinfaOptions(args.slice(2));
    if (options.submission === '-')
      throw new Error(
        'docs xinfa compile requires an auditable named submission',
      );
    const validation = validateDocumentationSubmissionBytes(
      readSubmission(root, options.submission),
      { root, checkFiles: true },
    );
    const validationReceipt = documentationValidationReceipt(
      validation,
      options.submission,
    );
    let delegated = null;
    if (validation.valid) delegated = runXinfaCompile(root, options);
    const passed =
      validation.valid &&
      delegated?.compileStatus === 0 &&
      delegated?.verifyStatus === 0 &&
      delegated?.verificationReceipt?.valid === true;
    const receipt = {
      schema: 'shifu.documentation-xinfa-adapter-receipt/v1',
      verdict: passed ? 'pass' : 'fail',
      qualifying: false,
      selfCertified: false,
      delegated: true,
      submission: {
        reference: options.submission,
        valid: validation.valid,
        roots: validation.projection?.roots || null,
        receipt: validationReceipt,
      },
      xinfa: delegated
        ? {
            operation: 'atlas compile',
            argv: delegated.compileArgs,
            compile: delegated.compileReceipt,
            verify: delegated.verificationReceipt,
          }
        : null,
    };
    if (options.json) stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    else if (passed && delegated)
      stdout.write(
        `delegated Xinfa Atlas: ${delegated.compileReceipt.atlas_root}\n`,
      );
    else
      stderr.write(
        'Shifu Xinfa adapter failed; use --json for the retained receipt\n',
      );
    return passed ? 0 : 1;
  }
  if (['help', '-h', '--help'].includes(sub)) {
    stderr.write(`${help()}\n`);
    return 0;
  }
  stderr.write(`${help()}\n`);
  return 2;
}
