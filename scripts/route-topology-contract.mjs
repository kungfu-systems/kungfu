#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Route topology contract (KF-ADR-019f86da-4f90-786d-9fd5-468c3f3d231b).
//
// docs/route-topology.registry.json is the declared account of which component
// consumes which carrier. It is maintained by hand: it is a claim, and this
// script is what makes the claim falsifiable by checking it against the source
// in both directions — every declared route must exist, and every route in the
// source must be declared.
//
// The registry exists because the question it answers cannot be answered from
// one process. The three consumers of ACTION_ENVELOPE live in two processes and
// two languages, and one of them selects the carrier inside a guard predicate
// that never names it. No search, and no runtime table, can attribute that set.
//
//   node scripts/route-topology-contract.mjs                     # verify
//   node scripts/route-topology-contract.mjs --consumer ACTION_ENVELOPE --json
//
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'docs/route-topology.registry.json';
const SUBSCRIPTION_ROOTS = [
  'framework/core/src/libkungfu',
  'framework/core/src/bindings/node/binding',
];

function extensionEnum(name) {
  return String(name).replaceAll('-', '_');
}

/** Anchors: how each route kind appears in source. Kept literal so a rename fails loudly. */
const ANCHORS = {
  declared: (route) =>
    route.carrier === 'ANY_FRAME'
      ? [`declare_frames(route_phase::${route.phase}, "${route.name}"`]
      : route.carrier
        ? [
            `declare<${route.carrier}>(route_phase::${route.phase}, "${route.name}"`,
          ]
        : [`declare_events(route_phase::${route.phase}, "${route.name}"`],
  dynamic: (route) =>
    route.carrier
      ? [
          `declare_dynamic<${route.carrier}>(route_extension::${extensionEnum(route.extension)}, "${route.name}"`,
        ]
      : [
          `declare_dynamic_events(route_extension::${extensionEnum(route.extension)}, "${route.name}"`,
        ],
  observe: (route) => [`self.observe(${route.carrier}, self.${route.name})`],
};

/** Source patterns, for the reverse direction: what exists that the registry must cover. */
const SOURCE_PATTERNS = [
  /declare<(\w+)>\(route_phase::(\w+),\s*"([^"]+)"/g,
  /declare_events\(route_phase::(\w+),\s*"([^"]+)"/g,
  /declare_frames\(route_phase::(\w+),\s*"([^"]+)"/g,
  /declare_dynamic<(\w+)>\(route_extension::\w+,\s*"([^"]+)"/g,
  /declare_dynamic_events\(route_extension::\w+,\s*"([^"]+)"/g,
  /self\.observe\(\w+,\s*self\.(\w+)\)/g,
];

function readRegistry() {
  const file = path.join(ROOT, REGISTRY);
  if (!fs.existsSync(file)) {
    throw new Error(`${REGISTRY} is missing`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Collapse the source text so a declaration wrapped by the formatter still matches its anchor. */
function flatten(text) {
  return text.replace(/\s+/g, ' ');
}

function stripCppComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function sourceFiles(root) {
  const found = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:h|hpp|cpp|cc)$/.test(entry.name)) found.push(file);
    }
  };
  visit(root);
  return found;
}

function verify(registry) {
  const problems = [];
  const seenNames = new Set();
  const extensionIds = new Set(
    (registry.extensionPoints ?? []).map((extension) => extension.id),
  );
  const requiredExtensions = new Set([
    'observe',
    'timer',
    'lazy-write',
    'start-hook',
  ]);

  for (const required of requiredExtensions) {
    if (!extensionIds.has(required)) {
      problems.push(`extension point '${required}' is not registered`);
    }
  }
  for (const extension of registry.extensionPoints ?? []) {
    if (!requiredExtensions.has(extension.id)) {
      problems.push(`unknown extension point '${extension.id}'`);
    }
    const file = path.join(ROOT, extension.anchor);
    if (!fs.existsSync(file)) {
      problems.push(
        `extension point '${extension.id}' anchor ${extension.anchor} does not exist`,
      );
      continue;
    }
    if (
      !flatten(fs.readFileSync(file, 'utf8')).includes(
        flatten(extension.needle),
      )
    ) {
      problems.push(
        `extension point '${extension.id}' is not admitted by ${extension.anchor}`,
      );
    }
  }

  const expectedSurfaces = new Map(
    (registry.subscriptionSurfaces ?? []).map((surface) => [
      surface.anchor,
      surface.eventsPipeCount,
    ]),
  );
  const observedSurfaces = new Map();
  for (const root of SUBSCRIPTION_ROOTS) {
    for (const file of sourceFiles(path.join(ROOT, root))) {
      const source = stripCppComments(fs.readFileSync(file, 'utf8'));
      const count = [...source.matchAll(/events_\s*\|/g)].length;
      if (count > 0) {
        observedSurfaces.set(
          path.relative(ROOT, file).replaceAll(path.sep, '/'),
          count,
        );
      }
    }
  }
  for (const [anchor, expected] of expectedSurfaces) {
    const observed = observedSurfaces.get(anchor) ?? 0;
    if (observed !== expected) {
      problems.push(
        `${anchor}: expected ${expected} events_ subscription surfaces, found ${observed}`,
      );
    }
  }
  for (const [anchor, count] of observedSurfaces) {
    if (!expectedSurfaces.has(anchor)) {
      problems.push(
        `${anchor}: ${count} events_ subscription surface(s) are outside the closed registry`,
      );
    }
  }

  for (const component of registry.components) {
    const file = path.join(ROOT, component.anchor);
    if (!fs.existsSync(file)) {
      problems.push(
        `${component.id}: anchor ${component.anchor} does not exist`,
      );
      continue;
    }
    const flat = flatten(fs.readFileSync(file, 'utf8'));

    // Forward: every declared route must be present in its anchor.
    for (const route of component.routes) {
      seenNames.add(route.name);
      if (route.kind === 'dynamic' && !extensionIds.has(route.extension)) {
        problems.push(
          `${component.id}/${route.name}: dynamic route has no registered extension point`,
        );
      }
      const build = ANCHORS[route.kind];
      if (!build) {
        problems.push(
          `${component.id}/${route.name}: unknown kind '${route.kind}'`,
        );
        continue;
      }
      const anchors = build(route).map(flatten);
      if (!anchors.some((anchor) => flat.includes(anchor))) {
        problems.push(
          `${component.id}/${route.name}: registry claims a route the anchor does not contain\n` +
            `    expected in ${component.anchor}: ${anchors[0]}`,
        );
      }
    }

    // Reverse: every route in the anchor must be declared, or the registry is
    // an incomplete answer while looking like a complete one.
    for (const pattern of SOURCE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of flat.matchAll(pattern)) {
        const name = match[match.length - 1];
        if (!seenNames.has(name)) {
          problems.push(
            `${component.anchor}: route '${name}' exists in source but is not in the registry`,
          );
        }
      }
    }
  }
  return problems;
}

function resolveCarrier(registry, name) {
  return registry.carrierAliases?.[name] ?? name;
}

function consumersOf(registry, carrierName) {
  const wanted = resolveCarrier(registry, carrierName);
  const found = [];
  for (const component of registry.components) {
    for (const route of component.routes) {
      const selects =
        route.carrier && resolveCarrier(registry, route.carrier) === wanted;
      const declares = (route.consumes ?? []).some(
        (c) => resolveCarrier(registry, c) === wanted,
      );
      if (selects || declares) {
        found.push({
          component: component.id,
          process: component.process,
          language: component.language,
          route: route.name,
          via: selects ? 'carrier' : 'consumes',
          anchor: component.anchor,
        });
      }
    }
  }
  return found;
}

function main() {
  const argv = process.argv.slice(2);
  const registry = readRegistry();
  const consumerIndex = argv.indexOf('--consumer');

  if (argv.includes('--self-test')) {
    const withoutExtension = structuredClone(registry);
    withoutExtension.extensionPoints = withoutExtension.extensionPoints.filter(
      (extension) => extension.id !== 'start-hook',
    );
    const missingExtension = verify(withoutExtension);
    if (
      !missingExtension.some((problem) =>
        problem.includes("extension point 'start-hook' is not registered"),
      )
    ) {
      throw new Error(
        'negative fixture did not reject a missing extension point',
      );
    }

    const wrongSurfaceCount = structuredClone(registry);
    wrongSurfaceCount.subscriptionSurfaces[0].eventsPipeCount += 1;
    const surfaceDrift = verify(wrongSurfaceCount);
    if (
      !surfaceDrift.some((problem) =>
        problem.includes('events_ subscription surfaces'),
      )
    ) {
      throw new Error(
        'negative fixture did not reject subscription-surface drift',
      );
    }

    const unadmittedDynamic = structuredClone(registry);
    const dynamicRoute = unadmittedDynamic.components
      .flatMap((component) => component.routes)
      .find((route) => route.kind === 'dynamic');
    dynamicRoute.extension = 'raw';
    const dynamicDrift = verify(unadmittedDynamic);
    if (
      !dynamicDrift.some((problem) =>
        problem.includes('dynamic route has no registered extension point'),
      )
    ) {
      throw new Error(
        'negative fixture did not reject an unadmitted dynamic route',
      );
    }
    console.log('[route-topology] self-test=pass negative-fixtures=3');
    return;
  }

  if (consumerIndex !== -1) {
    const carrier = argv[consumerIndex + 1];
    if (!carrier) {
      console.error('[route-topology] --consumer needs a carrier name');
      process.exit(2);
    }
    const consumers = consumersOf(registry, carrier);
    if (argv.includes('--json')) {
      console.log(
        JSON.stringify(
          { carrier: resolveCarrier(registry, carrier), consumers },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `[route-topology] consumers of ${resolveCarrier(registry, carrier)}: ${consumers.length}`,
      );
      for (const c of consumers) {
        console.log(
          `  ${c.component} (${c.language}, process=${c.process})  ${c.route}  via ${c.via}`,
        );
      }
    }
    return;
  }

  const problems = verify(registry);
  const routes = registry.components.reduce((n, c) => n + c.routes.length, 0);
  const subscriptionSurfaces = (registry.subscriptionSurfaces ?? []).reduce(
    (n, surface) => n + surface.eventsPipeCount,
    0,
  );
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`[route-topology] ${problem}`);
    }
    console.error(`[route-topology] result=fail problems=${problems.length}`);
    process.exit(1);
  }
  console.log(
    `[route-topology] components=${registry.components.length} routes=${routes} extensions=${registry.extensionPoints.length} subscription-surfaces=${subscriptionSurfaces} declared routes match their anchors, and no source route is undeclared`,
  );
  console.log('[route-topology] result=pass');
}

main();
