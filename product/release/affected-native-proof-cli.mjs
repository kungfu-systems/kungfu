#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--'))
      throw new Error(`unknown argument: ${argument}`);
    options[argument.slice(2)] = rest[++index];
  }
  return options;
}

function appendGithubOutput(file, values) {
  if (!file) return;
  fs.appendFileSync(
    file,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function handleSourceInput(options, proof) {
  const receipt = readJson(path.resolve(options['native-receipt']));
  const result = proof.createSourceQualificationInput({
    repository: options.repository,
    protectedBase: options['protected-base'],
    pullRequestNumber: options['pull-request'],
    sourceHeadSha: options['source-head'],
    descriptor: readJson(path.resolve(options.descriptor)),
    proof: readJson(path.resolve(options.proof)),
    plan: receipt.plan,
  });
  writeJson(path.resolve(options.output), result);
  print(result);
}

function handleQueueLeaseVerify(options, proof) {
  const result = proof.verifyQueueAdmissionLease({
    view: readJson(path.resolve(options.view)),
    pullRequestNumber: options['pull-request'],
    sourceHeadSha: options['source-head'],
    now: options.now,
  });
  writeJson(path.resolve(options.output), result);
  print(result);
}

function handleIntegrationInput(options, proof) {
  const result = proof.createIntegrationDeliveryInput({
    view: readJson(path.resolve(options.view)),
    deliveryAttempt: readJson(path.resolve(options['delivery-attempt'])),
    queueEntry: readJson(path.resolve(options['queue-entry'])),
    queueLeaseReceipt: readJson(path.resolve(options['queue-lease-receipt'])),
    pullRequestNumber: options['pull-request'],
    verifiedAt: options['verified-at'],
  });
  writeJson(path.resolve(options.output), result);
  print(result);
}

function handleToolchain(options, proof, env) {
  writeJson(
    path.resolve(options.output),
    proof.observeNativeToolchain(env, { compiler: options.compiler }),
  );
}

function handleDescribe(options, proof) {
  const plan = readJson(path.resolve(options.plan));
  const deliveryBinding = options['delivery-binding']
    ? readJson(path.resolve(options['delivery-binding']))
    : null;
  const semanticSource = proof.semanticSourceProjectionFromGit(plan);
  const descriptor = proof.createProofDescriptor(
    plan,
    options['source-tree'] || git('rev-parse', 'HEAD^{tree}'),
    Number(options['partition-count'] || 2),
    readJson(path.resolve(options.toolchain)),
    deliveryBinding,
    semanticSource.semanticSourceRoot,
  );
  writeJson(path.resolve(options.output), descriptor);
  appendGithubOutput(options['github-output'], {
    'proof-id': descriptor.proofId,
    'artifact-name': descriptor.artifactName,
    'native-required': descriptor.nativeRequired,
    'sdk-required': descriptor.sdkRequired,
  });
  print(descriptor);
}

function handleBindDelivery(options, proof) {
  const rules = readJson(path.resolve(options['rules-file']));
  const binding = proof.createDeliveryBinding({
    event: options.event,
    pullRequest: options['pull-request'],
    pullRequestHead: options['pull-request-head'],
    devHead: options['dev-head'],
    candidateHead: options['candidate-head'],
    candidateTree: options['candidate-tree'],
    pullRequestBody: fs.readFileSync(path.resolve(options['pr-body']), 'utf8'),
    combinedStatus: readJson(path.resolve(options['status-file'])),
    requiredContexts: proof.requiredContextsFromRules(rules),
    queueAdmissionContext: options['queue-admission-context'],
  });
  writeJson(path.resolve(options.output), binding);
  appendGithubOutput(options['github-output'], {
    'binding-root': binding.bindingRoot,
    'binding-state': binding.state,
  });
  print(binding);
}

async function handleLookup(options, proof, env) {
  const descriptor = readJson(path.resolve(options.descriptor));
  let result;
  try {
    result = await proof.lookupReusableArtifact({
      apiUrl: options['api-url'],
      repository: options.repository,
      artifactName: descriptor.artifactName,
      headSha: options['head-sha'],
      token: env.GITHUB_TOKEN || '',
      maxAgeSeconds: Number(
        options['max-age-seconds'] || proof.DEFAULT_MAX_AGE_SECONDS,
      ),
    });
  } catch (error) {
    result = { reusable: false, reason: error.message, candidateCount: 0 };
  }
  appendGithubOutput(options['github-output'], {
    'run-id': result.reusable ? result.runId : '',
    'producer-event': result.reusable ? result.producerEvent : '',
    'producer-head-sha': result.reusable ? result.producerHeadSha : '',
    reusable: result.reusable,
    reason: result.reason,
  });
  print(result);
}

function handleSeal(options, proof) {
  const descriptor = readJson(path.resolve(options.descriptor));
  const inputDir = path.resolve(options['input-dir']);
  const outputDir = path.resolve(options['output-dir']);
  const sealed = proof.sealProof(descriptor, inputDir, {
    repository: options.repository,
    runId: options['run-id'],
    event: options.event,
    workflowPath: proof.WORKFLOW_PATH,
    triggerHeadSha: options['trigger-head-sha'],
    checkoutSha: options['checkout-sha'] || git('rev-parse', 'HEAD'),
    createdAt: options['created-at'] || new Date().toISOString(),
  });
  fs.mkdirSync(outputDir, { recursive: true });
  for (const { value } of proof.receiptFiles(inputDir)) {
    writeJson(
      path.join(
        outputDir,
        `partition-${value.executionPartition.index}.receipt.json`,
      ),
      value,
    );
  }
  writeJson(path.join(outputDir, 'proof.json'), sealed);
  print(sealed);
}

function handleVerify(options, proof) {
  const verified = proof.verifyProofBundle(
    readJson(path.resolve(options.descriptor)),
    path.resolve(options.bundle),
    {
      repository: options.repository,
      producerRunId: options['producer-run-id'],
      producerEvent: options['producer-event'],
      producerHeadSha: options['producer-head-sha'],
      maxAgeSeconds: Number(
        options['max-age-seconds'] || proof.DEFAULT_MAX_AGE_SECONDS,
      ),
      now: options.now,
      deltaPlan: options['dev-delta-plan']
        ? readJson(path.resolve(options['dev-delta-plan']))
        : null,
    },
  );
  print({
    status: 'verified',
    proofId: verified.proofId,
    proofRoot: verified.proofRoot,
    baseDelta: verified.baseDelta,
  });
}

function handleSealCacheAuthority(options, proof) {
  const descriptorFile = path.resolve(options.descriptor);
  const proofBundleDir = path.resolve(options.bundle);
  const outputDir = path.resolve(options['output-dir']);
  const authority = proof.createCachePromotionAuthority(
    readJson(descriptorFile),
    proofBundleDir,
    {
      targetRepository: options.repository,
      targetRunId: options['target-run-id'],
      targetEvent: 'merge_group',
      targetHeadSha: options['target-head-sha'],
      targetSourceTree:
        options['target-source-tree'] || git('rev-parse', 'HEAD^{tree}'),
      producerRepository: options.repository,
      producerRunId: options['producer-run-id'],
      producerEvent: options['producer-event'],
      producerHeadSha: options['producer-head-sha'],
      maxAgeSeconds: Number(
        options['max-age-seconds'] || proof.DEFAULT_MAX_AGE_SECONDS,
      ),
      now: options.now,
      deltaPlan: options['dev-delta-plan']
        ? readJson(path.resolve(options['dev-delta-plan']))
        : null,
    },
  );
  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(descriptorFile, path.join(outputDir, 'descriptor.json'));
  copyDirectory(proofBundleDir, path.join(outputDir, 'proof'));
  writeJson(path.join(outputDir, 'authority.json'), authority);
  print(authority);
}

function handleVerifyCacheAuthority(options, proof) {
  const authority = proof.verifyCachePromotionAuthority(
    path.resolve(options.bundle),
    {
      targetRepository: options.repository,
      targetRunId: options['target-run-id'],
      targetHeadSha: options['target-head-sha'],
      targetSourceTree:
        options['target-source-tree'] || git('rev-parse', 'HEAD^{tree}'),
      maxAgeSeconds: Number(
        options['max-age-seconds'] || proof.DEFAULT_MAX_AGE_SECONDS,
      ),
      now: options.now,
    },
  );
  appendGithubOutput(options['github-output'], {
    'authority-digest': authority.authorityDigest,
    'producer-run-id': authority.producer.runId,
    'producer-event': authority.producer.event,
    'producer-trigger-head-sha': authority.producer.triggerHeadSha,
    'payload-source-sha': authority.payloadSourceSha,
    'delivery-binding-root': authority.deliveryBindingRoot || '',
  });
  print({
    status: 'verified',
    authorityDigest: authority.authorityDigest,
    payloadSourceSha: authority.payloadSourceSha,
    producer: authority.producer,
  });
}

function handleVerifyAttempt(options, proof) {
  const attempt = proof.validateDeliveryAttempt(
    readJson(path.join(path.resolve(options.bundle), 'delivery-attempt.json')),
  );
  const expected = {
    repository: proof.requireRepository(
      options.repository,
      'delivery repository',
    ),
    runId: proof.requireRunId(options['run-id'], 'delivery run id'),
    headSha: proof.requireSha(options['head-sha'], 'delivery merge-group head'),
    sourceTree: proof.requireSha(
      options['source-tree'] || git('rev-parse', 'HEAD^{tree}'),
      'delivery source tree',
    ),
  };
  if (
    attempt.workflow.repository !== expected.repository ||
    attempt.workflow.runId !== expected.runId ||
    attempt.source.mergeGroupHead !== expected.headSha ||
    attempt.source.checkout !== expected.headSha ||
    attempt.source.replayedTree !== expected.sourceTree
  ) {
    throw new Error('affected-native delivery attempt target drift');
  }
  appendGithubOutput(
    options['github-output'],
    proof.deliveryAttemptGithubOutputs(attempt),
  );
  print({
    status: 'verified',
    attemptRoot: attempt.attemptRoot,
    deliveryBindingRoot: attempt.deliveryBindingRoot,
    family: attempt.family,
    source: attempt.source,
    proofDecision: attempt.proof.decision,
  });
}

function handleSealAttempt(options, proof) {
  const descriptor = readJson(path.resolve(options.descriptor));
  const bundle = path.resolve(options.bundle);
  const untrustedProof = readJson(path.join(bundle, 'proof.json'));
  const verified = proof.verifyProofBundle(descriptor, bundle, {
    repository: untrustedProof.producer?.repository,
    producerRunId: untrustedProof.producer?.runId,
    producerEvent: untrustedProof.producer?.event,
    producerHeadSha: untrustedProof.producer?.triggerHeadSha,
    maxAgeSeconds: Number(
      options['max-age-seconds'] || proof.DEFAULT_MAX_AGE_SECONDS,
    ),
    now: options.now,
    deltaPlan: options['dev-delta-plan']
      ? readJson(path.resolve(options['dev-delta-plan']))
      : null,
  });
  const attempt = proof.createDeliveryAttempt(
    descriptor,
    verified,
    options.decision,
    {
      repository: options.repository,
      runId: options['run-id'],
      event: options.event,
      triggerHeadSha: options['trigger-head-sha'],
      checkoutSha: options['checkout-sha'] || git('rev-parse', 'HEAD'),
    },
  );
  const outputDir = path.resolve(options['output-dir']);
  fs.mkdirSync(outputDir, { recursive: true });
  writeJson(path.join(outputDir, 'delivery-attempt.json'), attempt);
  print(attempt);
}

const COMMANDS = {
  'bind-delivery': handleBindDelivery,
  describe: handleDescribe,
  'integration-input': handleIntegrationInput,
  'queue-lease-verify': handleQueueLeaseVerify,
  seal: handleSeal,
  'seal-attempt': handleSealAttempt,
  'seal-cache-authority': handleSealCacheAuthority,
  'source-input': handleSourceInput,
  toolchain: handleToolchain,
  verify: handleVerify,
  'verify-attempt': handleVerifyAttempt,
  'verify-cache-authority': handleVerifyCacheAuthority,
};

export async function runAffectedNativeProofCli(
  proof,
  argv = process.argv.slice(2),
  env = process.env,
) {
  const options = parseArgs(argv);
  if (options.command === 'lookup') {
    await handleLookup(options, proof, env);
    return;
  }
  const command = COMMANDS[options.command];
  if (!command) {
    throw new Error(
      'usage: affected-native-proof.mjs <source-input|queue-lease-verify|integration-input|toolchain|bind-delivery|describe|lookup|seal|verify|seal-attempt|verify-attempt|seal-cache-authority|verify-cache-authority>',
    );
  }
  command(options, proof, env);
}
