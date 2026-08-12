// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;

function root(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function parseArgs(argv) {
  const options = { execute: false, report: null, repo: null, region: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--execute') options.execute = true;
    else if (argument === '--confirm-credential-rotation') {
      options.confirmCredentialRotation = true;
    } else if (argument === '--repo') options.repo = argv[++index];
    else if (argument === '--region') options.region = argv[++index];
    else if (argument === '--report') options.report = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.repo && !NAME_PATTERN.test(options.repo)) {
    throw new Error('--repo must use OWNER/REPO');
  }
  return options;
}

function run(command, args, { input, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} failed (${result.status}): ${message}`);
  }
  return result;
}

function json(command, args, options) {
  const output = run(command, args, options).stdout.trim();
  return output ? JSON.parse(output) : null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function lambdaHandlerSource() {
  return `import base64
import hashlib
import hmac
import os
import re

DELIVERY = re.compile(r"^[0-9a-fA-F-]{16,64}$")

def response(status, code, delivery=""):
    proof = hashlib.sha256((code + ":" + delivery).encode()).hexdigest()
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "x-kungfu-canary-code": code,
            "x-kungfu-canary-root": "sha256:" + proof,
        },
        "body": "{\\\"accepted\\\":%s}" % ("true" if status == 202 else "false"),
    }

def handler(event, context):
    request = (event.get("requestContext") or {}).get("http") or {}
    if request.get("method") != "POST":
        return response(405, "method-rejected")
    headers = {str(k).lower(): str(v) for k, v in (event.get("headers") or {}).items()}
    raw = event.get("body") or ""
    body = base64.b64decode(raw) if event.get("isBase64Encoded") else raw.encode()
    if len(body) > 65536:
        return response(413, "payload-oversized")
    delivery = headers.get("x-github-delivery", "")
    if headers.get("x-github-event") != "ping" or not DELIVERY.fullmatch(delivery):
        return response(422, "event-rejected", delivery)
    expected = "sha256=" + hmac.new(
        os.environ["WEBHOOK_SECRET"].encode(), body, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, headers.get("x-hub-signature-256", "")):
        return response(401, "signature-rejected", delivery)
    return response(202, "ping-accepted", delivery)
`;
}

export function awsPartitionForRegion(region) {
  if (!REGION_PATTERN.test(region)) {
    throw new Error('AWS region is invalid');
  }
  if (region.startsWith('cn-')) return 'aws-cn';
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  return 'aws';
}

export function canaryPlan({ repo, region, nonce = 'planned' }) {
  const resolvedRegion = region ?? 'us-east-1';
  const labels = {
    function: `kungfu-kfx-webhook-${nonce}`,
    api: `kungfu-kfx-webhook-${nonce}`,
    role: `kungfu-kfx-webhook-${nonce}`,
  };
  const body = {
    schema: 'kungfu.kfx.github-webhook-real-canary-plan/v1',
    mode: 'one-shot-ping-only',
    repo: repo ?? 'OWNER/REPO',
    region: resolvedRegion,
    awsPartition: awsPartitionForRegion(resolvedRegion),
    transport: 'api-gateway-http-api-to-lambda',
    resources: labels,
    creates: ['iam-role', 'lambda-function', 'http-api', 'repository-webhook'],
    verifies: [
      'github-ping-delivery-status-202',
      'hmac-sha256-handler-only-success-path',
      'repository-webhook-absent',
      'http-api-absent',
      'lambda-function-absent',
      'iam-role-absent',
      'log-group-absent',
    ],
    teardownOrder: [
      'repository-webhook',
      'http-api',
      'lambda-function',
      'iam-role',
      'log-group',
    ],
    retains: ['redacted-rooted-receipt'],
    retainsNo: ['secret', 'signature', 'payload', 'public-endpoint'],
  };
  return { ...body, planRoot: root(JSON.stringify(body)) };
}

function writePrivateJson(target, value) {
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function waitForPing(repo, hookId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const deliveries = json('gh', [
      'api',
      `/repos/${repo}/hooks/${hookId}/deliveries`,
      '--paginate',
    ]);
    const ping = deliveries.find(
      (delivery) => delivery.event === 'ping' && delivery.status_code !== null,
    );
    if (ping) return ping;
    await sleep(2000);
  }
  throw new Error('GitHub did not settle the webhook ping within 60 seconds');
}

function absent(command, args, label, expectedError) {
  const result = run(command, args, { allowFailure: true });
  if (result.status === 0) {
    throw new Error(`${label} still exists after teardown`);
  }
  if (!`${result.stderr}\n${result.stdout}`.includes(expectedError)) {
    throw new Error(`${label} absence could not be verified: ${result.stderr}`);
  }
}

export async function executeCanary(options) {
  if (!options.repo || !options.region) {
    throw new Error('--execute requires --repo and --region');
  }
  if (!options.confirmCredentialRotation) {
    throw new Error(
      '--execute requires --confirm-credential-rotation after credential hygiene is complete',
    );
  }
  run('aws', ['--version']);
  run('gh', ['--version']);
  run('zip', ['-v']);
  const nonce = randomBytes(6).toString('hex');
  const plan = canaryPlan({ ...options, nonce });
  const secret = randomBytes(32).toString('hex');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-kfx-canary-'));
  const handlerPath = path.join(temp, 'index.py');
  const archivePath = path.join(temp, 'handler.zip');
  const trustPath = path.join(temp, 'trust.json');
  const environmentPath = path.join(temp, 'environment.json');
  const hookInput = path.join(temp, 'hook.json');
  let roleArn = null;
  let functionArn = null;
  let api = null;
  let hookId = null;
  let ping = null;
  let account = null;
  let canaryError = null;
  const cleanup = [];

  try {
    fs.writeFileSync(handlerPath, lambdaHandlerSource(), 'utf8');
    writePrivateJson(trustPath, {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: 'sts:AssumeRole',
        },
      ],
    });
    writePrivateJson(environmentPath, {
      Variables: { WEBHOOK_SECRET: secret },
    });
    run('zip', ['-q', '-j', archivePath, handlerPath]);
    account = run('aws', [
      'sts',
      'get-caller-identity',
      '--query',
      'Account',
      '--output',
      'text',
    ]).stdout.trim();
    roleArn = run('aws', [
      'iam',
      'create-role',
      '--role-name',
      plan.resources.role,
      '--assume-role-policy-document',
      `file://${trustPath}`,
      '--query',
      'Role.Arn',
      '--output',
      'text',
    ]).stdout.trim();
    cleanup.push('iam-role');

    let creation = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      creation = run(
        'aws',
        [
          'lambda',
          'create-function',
          '--region',
          options.region,
          '--function-name',
          plan.resources.function,
          '--runtime',
          'python3.12',
          '--handler',
          'index.handler',
          '--role',
          roleArn,
          '--zip-file',
          `fileb://${archivePath}`,
          '--environment',
          `file://${environmentPath}`,
          '--timeout',
          '5',
          '--memory-size',
          '128',
          '--query',
          'FunctionArn',
          '--output',
          'text',
        ],
        { allowFailure: true },
      );
      if (creation.status === 0) break;
      if (!creation.stderr.includes('cannot be assumed')) {
        throw new Error(
          `aws lambda create-function failed: ${creation.stderr}`,
        );
      }
      await sleep(5000);
    }
    if (creation?.status !== 0) {
      throw new Error('Lambda execution role did not become available');
    }
    functionArn = creation.stdout.trim();
    cleanup.push('lambda-function');
    api = json('aws', [
      'apigatewayv2',
      'create-api',
      '--region',
      options.region,
      '--name',
      plan.resources.api,
      '--protocol-type',
      'HTTP',
      '--target',
      functionArn,
      '--query',
      '{ApiId:ApiId,ApiEndpoint:ApiEndpoint}',
      '--output',
      'json',
    ]);
    cleanup.push('http-api');
    run('aws', [
      'lambda',
      'add-permission',
      '--region',
      options.region,
      '--function-name',
      plan.resources.function,
      '--statement-id',
      `apigateway-${nonce}`,
      '--action',
      'lambda:InvokeFunction',
      '--principal',
      'apigateway.amazonaws.com',
      '--source-arn',
      `arn:${plan.awsPartition}:execute-api:${options.region}:${account}:${api.ApiId}/*/*`,
      '--query',
      'Statement',
      '--output',
      'text',
    ]);
    writePrivateJson(hookInput, {
      name: 'web',
      active: true,
      events: ['push'],
      config: {
        url: api.ApiEndpoint,
        content_type: 'json',
        insecure_ssl: '0',
        secret,
      },
    });
    const hook = json(
      'gh',
      [
        'api',
        '--method',
        'POST',
        `/repos/${options.repo}/hooks`,
        '--input',
        '-',
      ],
      { input: fs.readFileSync(hookInput, 'utf8') },
    );
    hookId = hook.id;
    cleanup.push('repository-webhook');
    ping = await waitForPing(options.repo, hookId);
    if (ping.status_code !== 202 || ping.status !== 'OK') {
      throw new Error(
        `GitHub ping failed: status=${ping.status} code=${ping.status_code}`,
      );
    }
  } catch (error) {
    canaryError = error;
  } finally {
    if (hookId !== null) {
      run(
        'gh',
        ['api', '--method', 'DELETE', `/repos/${options.repo}/hooks/${hookId}`],
        {
          allowFailure: true,
        },
      );
    }
    if (api?.ApiId) {
      run(
        'aws',
        [
          'apigatewayv2',
          'delete-api',
          '--region',
          options.region,
          '--api-id',
          api.ApiId,
        ],
        { allowFailure: true },
      );
    }
    if (functionArn) {
      run(
        'aws',
        [
          'lambda',
          'delete-function',
          '--region',
          options.region,
          '--function-name',
          plan.resources.function,
        ],
        { allowFailure: true },
      );
    }
    if (roleArn) {
      run('aws', ['iam', 'delete-role', '--role-name', plan.resources.role], {
        allowFailure: true,
      });
    }
    const logGroup = `/aws/lambda/${plan.resources.function}`;
    const groups = json('aws', [
      'logs',
      'describe-log-groups',
      '--region',
      options.region,
      '--log-group-name-prefix',
      logGroup,
      '--query',
      `logGroups[?logGroupName=='${logGroup}'].logGroupName`,
      '--output',
      'json',
    ]);
    if (groups.length) {
      run(
        'aws',
        [
          'logs',
          'delete-log-group',
          '--region',
          options.region,
          '--log-group-name',
          logGroup,
        ],
        { allowFailure: true },
      );
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }

  if (hookId !== null) {
    const hooks = json('gh', ['api', `/repos/${options.repo}/hooks`]);
    if (hooks.some((hook) => hook.id === hookId)) {
      throw new Error('repository webhook still exists after teardown');
    }
  }
  if (api?.ApiId) {
    absent(
      'aws',
      [
        'apigatewayv2',
        'get-api',
        '--region',
        options.region,
        '--api-id',
        api.ApiId,
      ],
      'HTTP API',
      'NotFoundException',
    );
  }
  if (functionArn) {
    absent(
      'aws',
      [
        'lambda',
        'delete-function',
        '--region',
        options.region,
        '--function-name',
        plan.resources.function,
      ],
      'Lambda function',
      'ResourceNotFoundException',
    );
  }
  if (roleArn) {
    absent(
      'aws',
      ['iam', 'get-role', '--role-name', plan.resources.role],
      'IAM role',
      'NoSuchEntity',
    );
  }
  const remainingGroups = json('aws', [
    'logs',
    'describe-log-groups',
    '--region',
    options.region,
    '--log-group-name-prefix',
    `/aws/lambda/${plan.resources.function}`,
    '--query',
    'logGroups[].logGroupName',
    '--output',
    'json',
  ]);
  if (remainingGroups.length) throw new Error('Lambda log group remains');
  if (canaryError) throw canaryError;

  const body = {
    schema: 'kungfu.kfx.github-webhook-real-canary/v1',
    status: 'passed',
    planRoot: plan.planRoot,
    repo: options.repo,
    region: options.region,
    transport: plan.transport,
    delivery: {
      event: 'ping',
      statusCode: ping.status_code,
      deliveryRoot: root(String(ping.guid)),
    },
    endpointRetained: false,
    secretRetained: false,
    payloadRetained: false,
    teardown: {
      attempted: cleanup,
      repositoryWebhookAbsent: true,
      httpApiAbsent: true,
      lambdaFunctionAbsent: true,
      iamRoleAbsent: true,
      logGroupAbsent: true,
    },
  };
  return { ...body, evidenceRoot: root(JSON.stringify(body)) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.execute
    ? await executeCanary(options)
    : canaryPlan(options);
  if (!ROOT_PATTERN.test(result.evidenceRoot ?? result.planRoot)) {
    throw new Error('canary output is not exact-rooted');
  }
  if (options.report) {
    fs.mkdirSync(path.dirname(path.resolve(options.report)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.resolve(options.report),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain)
  main().catch((error) => {
    process.stderr.write(`[github-webhook-canary] ${error.message}\n`);
    process.exitCode = 1;
  });
