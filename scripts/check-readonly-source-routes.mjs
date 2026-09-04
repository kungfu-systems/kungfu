#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { READONLY_SOURCE_COMMANDS } from './shifu-readonly-entry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = 'developer/maintainability/readonly-source-routes.json';
const REQUIRED_AGENT_DISCOVERY = [
  'kungfu agent brief',
  'kungfu agent runtime list --json',
  'kungfu agent session list --json',
  'kungfu agent status --target <agent> --json',
  'kungfu agent work inspect --ref <ref> --json',
];
const REQUIRED_EXPLICIT_SOURCE_ROUTES = ['./shifu docs:check:readonly'];
const REQUIRED_SOURCE_ACCEPTANCE_DENIALS = [
  '_tmp_*',
  '.buildchain/diagnostics/*.tmp-*',
  '.pnpm-store/**',
  'generated-fixtures/**',
  'nested-task-output/**',
];
const SOURCE_ACCEPTANCE_WRITER_OWNER = 'source-acceptance-runtime';

function sourceCommand(command) {
  const normalized = command
    .replace(/^\.\/*shifu\s+/u, '')
    .replace(/^invariant:verify -- --list$/u, 'invariant:verify --list');
  if (/^kfd\s+(?:status|query|check)(?:\s|$)/u.test(normalized))
    return normalized.split(/\s+/u).slice(0, 2).join(' ');
  if (/^kfd:(?:query|support-matrix:check)(?:\s|$)/u.test(normalized))
    return normalized.split(/\s+/u)[0];
  return (
    normalized.split(/\s+/u)[0] +
    (normalized.includes('invariant:verify') ? ' --list' : '')
  );
}

export function validateReadonlyRouteInventory(
  inventory,
  exists = fs.existsSync,
) {
  const diagnostics = [];
  if (inventory.schema !== 'kungfu.readonly-source-route-inventory/v1')
    diagnostics.push({ code: 'inventory-schema' });
  const routes = Array.isArray(inventory.routes) ? inventory.routes : [];
  const ids = new Set();
  const commands = new Set();
  for (const route of routes) {
    if (!route.id || ids.has(route.id))
      diagnostics.push({ code: 'route-id', id: route.id || '' });
    ids.add(route.id);
    if (!route.command || commands.has(route.command))
      diagnostics.push({ code: 'route-command', id: route.id || '' });
    commands.add(route.command);
    if (!inventory.classifications?.includes(route.classification))
      diagnostics.push({ code: 'route-classification', id: route.id || '' });
    if (!Array.isArray(route.transitiveWriters))
      diagnostics.push({ code: 'route-writer-closure', id: route.id || '' });
    if (route.classification !== 'explicit-materialization') {
      if (route.network !== false || route.dependencyInstallation !== false)
        diagnostics.push({
          code: 'read-route-side-effect',
          id: route.id || '',
        });
      if (
        (route.transitiveWriters || []).some(
          (writer) => !String(writer).includes('disposable OS test'),
        )
      )
        diagnostics.push({ code: 'read-route-writer', id: route.id || '' });
    }
    if (!route.implementation || !exists(path.join(ROOT, route.implementation)))
      diagnostics.push({ code: 'route-implementation', id: route.id || '' });
    if (route.id === 'source-acceptance') {
      if (
        !route.runtimeImplementation ||
        !exists(path.join(ROOT, route.runtimeImplementation))
      )
        diagnostics.push({
          code: 'source-runtime-implementation',
          id: route.id,
        });
      if (route.writerOwner !== SOURCE_ACCEPTANCE_WRITER_OWNER)
        diagnostics.push({ code: 'source-writer-owner', id: route.id });
      if (!String(route.recovery || '').includes('OS runtime root'))
        diagnostics.push({ code: 'source-writer-recovery', id: route.id });
      const denied = new Set(route.deniedCheckoutWriters || []);
      for (const writer of REQUIRED_SOURCE_ACCEPTANCE_DENIALS) {
        if (!denied.has(writer))
          diagnostics.push({
            code: 'source-writer-denial',
            id: route.id,
            writer,
            owner: SOURCE_ACCEPTANCE_WRITER_OWNER,
            recovery: route.recovery || '',
          });
      }
    }
  }
  const declaredSource = new Set(
    routes
      .filter((route) => route.classification === 'read-only-source')
      .map((route) => sourceCommand(route.command)),
  );
  for (const command of READONLY_SOURCE_COMMANDS)
    if (!declaredSource.has(command))
      diagnostics.push({ code: 'source-route-unclassified', command });
  for (const command of REQUIRED_AGENT_DISCOVERY)
    if (!commands.has(command))
      diagnostics.push({ code: 'agent-route-unclassified', command });
  for (const command of REQUIRED_EXPLICIT_SOURCE_ROUTES)
    if (!commands.has(command))
      diagnostics.push({ code: 'explicit-source-route-unclassified', command });
  return diagnostics;
}

function main() {
  const inventory = JSON.parse(
    fs.readFileSync(path.join(ROOT, INVENTORY), 'utf8'),
  );
  const diagnostics = validateReadonlyRouteInventory(inventory);
  const report = {
    schema: 'kungfu.readonly-source-route-inventory-check/v1',
    inventory: INVENTORY,
    routeCount: inventory.routes.length,
    verdict: diagnostics.length ? 'fail' : 'pass',
    diagnostics,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (diagnostics.length) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
